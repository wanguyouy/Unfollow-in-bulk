/* ============================================================
 * 极简 MTProto 2.0 客户端（复用 tdata 里已登录的 auth key）
 * ------------------------------------------------------------
 * 为什么自己写：Electron 里没有可用的 MTProto 库，而我们的场景很窄 ——
 * 已有 auth key，不需要 DH 握手、不需要注册、不需要处理 updates 流，
 * 只要能「发一个 TL 请求、读回一个 TL 响应」就够了。
 *
 * 协议要点（都对过官方文档）：
 *   · 传输层用 intermediate：4 字节 LE 长度 + 负载（比 abridged 的变长头好写）
 *   · 消息 = auth_key_id(8) + msg_id(8) + msg_len(4) + msg_key(16) + AES-IGE(密文)
 *   · 密文 = salt(8) + session_id(8) + TL 请求 + 随机填充(12..1024, 凑 16 倍数)
 *   · MTProto 2.0 的 msg_key / aes_key / aes_iv 由 auth_key 的 88..128 段派生
 *     （x=0 表示客户端发出，x=8 表示服务器发来）
 *   · 响应靠 rpc_result.req_msg_id 对上请求；gzip_packed 要解压
 * ============================================================ */
const net = require('net');
const crypto = require('crypto');
const zlib = require('zlib');
const { connectTunnel } = require('./telegram-fetch');

const LAYER = 233;
const API_ID = 2040; // Telegram Desktop 的官方 api_id，复用登录态必须用它
const APP_VERSION = '1.0.0';

/* 各 DC 的接入点（公开的固定 IP，够用来做首连） */
const DC_ENDPOINTS = {
  1: '149.154.175.53',
  2: '149.154.167.51',
  3: '149.154.175.100',
  4: '149.154.167.91',
  5: '91.108.56.130',
};

/* ---------- TL 写入 ---------- */
const tlInt = (v) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v | 0, 0);
  return b;
};
const tlUInt = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
};
const tlLong = (v) => {
  const b = Buffer.alloc(8);
  let x = BigInt(v);
  if (x < -(2n ** 63n) || x >= 2n ** 63n) x = BigInt.asIntN(64, x);
  b.writeBigInt64LE(x, 0);
  return b;
};
const tlBytes = (buf) => {
  const len = buf.length;
  let head;
  if (len <= 253) head = Buffer.from([len]);
  else {
    head = Buffer.alloc(4);
    head[0] = 254;
    head.writeUIntLE(len, 1, 3);
  }
  const pad = (4 - ((head.length + len) % 4)) % 4;
  return Buffer.concat([head, buf, Buffer.alloc(pad)]);
};
const tlString = (s) => tlBytes(Buffer.from(String(s || ''), 'utf8'));
const tlVector = (items, write) => Buffer.concat([tlInt(0x1cb5c415), tlInt(items.length)].concat(items.map(write)));

/* ---------- TL 读取 ---------- */
class Reader {
  constructor(buf) {
    this.b = buf;
    this.o = 0;
  }
  get left() { return this.b.length - this.o; }
  int() { const v = this.b.readInt32LE(this.o); this.o += 4; return v; }
  uint() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  long() { const v = this.b.readBigInt64LE(this.o); this.o += 8; return v; }
  double() { const v = this.b.readDoubleLE(this.o); this.o += 8; return v; }
  bytes() {
    const first = this.b.readUInt8(this.o);
    let len;
    let head;
    if (first === 254) { len = this.b.readUIntLE(this.o + 1, 3); head = 4; } else { len = first; head = 1; }
    const start = this.o + head;
    const out = this.b.subarray(start, start + len);
    this.o = start + len + ((4 - ((head + len) % 4)) % 4);
    return Buffer.from(out);
  }
  string() { return this.bytes().toString('utf8'); }
  bool() { return this.uint() === 0x997275b5; }
  /* 跳过一个未知对象：只对「定长/可自描述」的原始值可靠，用于容错 */
  skipBytes() { this.bytes(); }
}

/* ---------- AES-256-IGE ---------- */
function igeEncrypt(src, key, iv) {
  const enc = crypto.createCipheriv('aes-256-ecb', key, null);
  enc.setAutoPadding(false);
  const out = Buffer.alloc(src.length);
  let prevC = Buffer.from(iv.subarray(0, 16));
  let prevM = Buffer.from(iv.subarray(16, 32));
  for (let off = 0; off < src.length; off += 16) {
    const m = src.subarray(off, off + 16);
    const t = Buffer.alloc(16);
    for (let i = 0; i < 16; i += 1) t[i] = m[i] ^ prevC[i];
    const y = enc.update(t);
    const c = Buffer.alloc(16);
    for (let i = 0; i < 16; i += 1) c[i] = y[i] ^ prevM[i];
    c.copy(out, off);
    prevC = c;
    prevM = Buffer.from(m);
  }
  return out;
}

function igeDecrypt(src, key, iv) {
  const dec = crypto.createDecipheriv('aes-256-ecb', key, null);
  dec.setAutoPadding(false);
  const out = Buffer.alloc(src.length);
  let prevC = Buffer.from(iv.subarray(0, 16));
  let prevM = Buffer.from(iv.subarray(16, 32));
  for (let off = 0; off < src.length; off += 16) {
    const c = src.subarray(off, off + 16);
    const t = Buffer.alloc(16);
    for (let i = 0; i < 16; i += 1) t[i] = c[i] ^ prevM[i];
    const y = dec.update(t);
    for (let i = 0; i < 16; i += 1) out[off + i] = y[i] ^ prevC[i];
    prevC = Buffer.from(c);
    prevM = Buffer.from(out.subarray(off, off + 16));
  }
  return out;
}

/* MTProto 2.0 的 key/iv 派生 */
function deriveKeys(authKey, msgKey, x) {
  const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
  const a = sha256(Buffer.concat([msgKey, authKey.subarray(x, x + 36)]));
  const b = sha256(Buffer.concat([authKey.subarray(40 + x, 40 + x + 36), msgKey]));
  return {
    key: Buffer.concat([a.subarray(0, 8), b.subarray(8, 24), a.subarray(24, 32)]),
    iv: Buffer.concat([b.subarray(0, 8), a.subarray(8, 24), b.subarray(24, 32)]),
  };
}

function computeMsgKey(authKey, plain, x) {
  const sha = crypto.createHash('sha256').update(authKey.subarray(88 + x, 88 + x + 32)).update(plain).digest();
  return sha.subarray(8, 24);
}

/* ---------- 会话 ---------- */
class MtpSession {
  /* opts: { authKey(Buffer256), sessionId(Buffer8), dcId, proxy } */
  constructor(opts) {
    this.key = opts.authKey;
    this.authKeyId = Buffer.from(crypto.createHash('sha1').update(this.key).digest().subarray(12, 20));
    this.sessionId = opts.sessionId || crypto.randomBytes(8);
    this.dcId = Number(opts.dcId) || 2;
    this.proxy = opts.proxy === undefined ? null : opts.proxy;
    this.salt = opts.salt !== undefined ? BigInt(opts.salt) : 0n;
    this.seqNo = 0;
    this.msgCounter = 0n;
    this.lastMsgId = 0n;
    this.pending = new Map(); // reqMsgId(hex) -> {resolve, reject, timer}
    this.props = new Map();   // msgId(hex) -> {resolve, reject, timer, bytes}
    this.pendingAcks = [];    // 待确认的服务器消息 msg_id
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.inited = false;
    this.debug = opts.debug || null;
    this.raw = !!opts.raw;
  }

  log(msg) { if (this.debug) this.debug('[mtp] ' + msg); }

  async connect(timeout) {
    const ip = DC_ENDPOINTS[this.dcId] || DC_ENDPOINTS[2];
    const t = timeout || 20000;
    let sock;
    if (this.proxy) {
      sock = await connectTunnel(this.proxy, ip, 443, t);
    } else {
      sock = await new Promise((resolve, reject) => {
        const s = net.connect({ host: ip, port: 443 });
        s.setTimeout(t, () => s.destroy(new Error('连接超时 ' + ip)));
        s.once('connect', () => { s.setTimeout(0); resolve(s); });
        s.once('error', reject);
      });
    }
    sock.setNoDelay(true);
    sock.on('data', (d) => this.onData(d));
    sock.on('error', (e) => this.onFatal(e));
    sock.on('close', () => this.onFatal(new Error('连接已断开')));
    this.socket = sock;
    // intermediate 传输层握手：发 0xEEEEEEEE
    sock.write(Buffer.from([0xee, 0xee, 0xee, 0xee]));
    this.log('已连上 DC' + this.dcId + ' ' + ip + ':443' + (this.proxy ? ' via ' + this.proxy.host + ':' + this.proxy.port : ' 直连'));
    return true;
  }

  nextMsgId() {
    // 4 字节对齐、单调递增；用当前秒 << 32 保证与服务器时钟大致同步
    let id = (BigInt(Math.floor(Date.now() / 1000)) << 32n) | BigInt((this.msgCounter += 1n) * 4n & 0xffffffffn);
    if (id <= this.lastMsgId) id = this.lastMsgId + 4n;
    this.lastMsgId = id;
    return id;
  }

  pack(msgId, body, seqNo) {
    /* 线上结构(对照官方 description.md):
       外部头 = auth_key_id(8) + msg_key(16)，无 msg_id/msg_len —— 它们在加密区内层
       加密区 = server_salt(8)+session_id(8)+msg_id(8)+seq_no(4)+msg_len(4)+body+padding(12..1024) */
    if (body.length % 4) throw new Error('TL body 未按 4 字节对齐: ' + body.length);
    const plain = Buffer.concat([
      tlLong(this.salt), this.sessionId,
      tlLong(msgId), tlInt(seqNo), tlInt(body.length),
      body,
    ]);
    let pad = (16 - (plain.length % 16)) % 16;
    if (pad < 12) pad += 16;
    const padded = Buffer.concat([plain, crypto.randomBytes(pad)]);
    const msgKey = computeMsgKey(this.key, padded, 0);
    const { key, iv } = deriveKeys(this.key, msgKey, 0);
    const enc = igeEncrypt(padded, key, iv);
    return Buffer.concat([this.authKeyId, msgKey, enc]);
  }

  /* 发一个裸 TL 请求；返回响应 TL 字节（Reader 自行解析）
     seq_no 规则(对照 tdlib AuthData::next_seq_no)：
       每发一条消息计数器+1；content-related(RPC 查询) = n*2+1(奇)，服务消息 = n*2(偶)。
     带待确认消息时：[请求(奇) + msgs_ack(偶)] 打进 container，container 本身也是服务消息(偶)。 */
  send(body) {
    const acks = this.pendingAcks;
    this.pendingAcks = [];
    let reqMsgId = this.nextMsgId();
    let payload = body;
    let phyMsgId = reqMsgId;
    let phySeq;
    if (acks.length) {
      const ackMsgId = this.nextMsgId();
      const containerMsgId = this.nextMsgId();
      const reqSeq = this.seqNo * 2 + 1;        // 请求：content-related → 奇
      const ackSeq = (this.seqNo + 1) * 2;      // ack：服务消息 → 偶
      phySeq = (this.seqNo + 2) * 2;            // container：服务消息 → 偶
      this.seqNo += 3;
      const ackMsg = Buffer.concat([
        tlUInt(0x62d6b459),        // msgs_ack#62d6b459 msg_ids:Vector<long>
        tlInt(0x1cb5c415), tlInt(acks.length), ...acks.map(tlLong),
      ]);
      const subMsg = (id, seq, b) => Buffer.concat([tlLong(id), tlInt(seq), tlInt(b.length), b]);
      payload = Buffer.concat([
        tlUInt(0x73f1f8dc), tlInt(2),
        subMsg(reqMsgId, reqSeq, body),
        subMsg(ackMsgId, ackSeq, ackMsg),
      ]);
      phyMsgId = containerMsgId;
    } else {
      phySeq = this.seqNo * 2 + 1;              // 请求：奇
      this.seqNo += 1;
    }
    const packet = this.pack(phyMsgId, payload, phySeq);
    const framed = Buffer.alloc(4 + packet.length);
    framed.writeUInt32LE(packet.length, 0);
    packet.copy(framed, 4);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.props.delete(reqMsgId.toString(16));
        reject(new Error('请求超时（20s）'));
      }, 20000);
      this.props.set(reqMsgId.toString(16), { resolve, reject, timer, body });
      this.log('→ req=' + reqMsgId + ' phy=' + phyMsgId + ' seq=' + phySeq + (acks.length ? ' (带 ' + acks.length + ' 条 ack)' : '') + ' len=' + body.length);
      try { this.socket.write(framed); } catch (e) { reject(e); }
    });
  }

  onData(chunk) {
    if (this.raw) this.log('← 收到 ' + chunk.length + 'B ' + chunk.subarray(0, 64).toString('hex'));
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 4) return;
      /* 传输层错误码是裸 4 字节(无长度前缀),恒为负值如 -404；0 是服务器对握手魔数的应答,忽略 */
      const word = this.buffer.readUInt32LE(0);
      if (word >= 0x80000000) {
        this.onFatal(new Error('服务器传输错误 ' + (word | 0)));
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (word === 0) { this.buffer = this.buffer.subarray(4); continue; }
      const len = this.buffer.readUInt32LE(0);
      if (len < 12 || len > 32 * 1024 * 1024) {
        this.log('跳过异常包 len=' + len);
        this.buffer = this.buffer.subarray(4);
        continue;
      }
      if (this.buffer.length < 4 + len) return;
      const packet = this.buffer.subarray(4, 4 + len);
      this.buffer = this.buffer.subarray(4 + len);
      try { this.onPacket(packet); } catch (e) { this.log('解包失败 ' + ((e && e.message) || e)); }
    }
  }

  onPacket(packet) {
    if (packet.length < 48) return;
    /* 外部头 = auth_key_id(8) + msg_key(16)，其余是密文 */
    const authKeyId = packet.subarray(0, 8);
    const msgKey = packet.subarray(8, 24);
    const enc = packet.subarray(24);
    if (!authKeyId.equals(this.authKeyId)) {
      this.log('auth_key_id 不匹配（可能是别的会话的包）');
      return;
    }
    if (enc.length % 16) { this.log('密文长度异常 ' + enc.length); return; }
    const { key, iv } = deriveKeys(this.key, msgKey, 8);
    let plain;
    try { plain = igeDecrypt(enc, key, iv); } catch (e) { this.log('解密失败'); return; }
    const check = computeMsgKey(this.key, plain, 8);
    if (!check.equals(msgKey)) { this.log('msg_key 校验失败'); return; }
    // salt(8) + session_id(8) + msg_id(8) + seq_no(4) + msg_len(4) + body + padding
    const salt = plain.readBigUInt64LE(0);
    if (salt !== 0n) this.salt = salt;
    const sessionId = plain.subarray(8, 16);
    if (!sessionId.equals(this.sessionId)) { this.log('session_id 不匹配'); return; }
    if (plain.length < 32) { this.log('明文过短 ' + plain.length); return; }
    const bodyLen = plain.readUInt32LE(28);
    if (24 + bodyLen > plain.length + 8) { this.log('msg_len 越界 ' + bodyLen + '/' + plain.length); return; }
    let body = plain.subarray(32, 32 + bodyLen);
    if (body.length >= 4 && body.readUInt32LE(0) === 0x3072cfa1) {
      // gzip_packed#3072cfa1 packed_data:bytes
      const r = new Reader(body);
      r.uint();
      try { body = zlib.gunzipSync(r.bytes()); } catch (e) { this.log('gzip 解压失败'); return; }
      this.log('解压后 ' + body.length + 'B');
    }
    const innerMsgId = plain.readBigInt64LE(16);
    this.dispatch(body, innerMsgId);
  }

  dispatch(body, msgId) {
    if (body.length < 4) return;
    /* 所有服务器消息都记录待确认（bad_msg/pong 不需要 ack，多发无害） */
    if (msgId !== undefined && msgId !== 0n && !this.pendingAcks.includes(msgId)) {
      this.pendingAcks.push(msgId);
    }
    const type = body.readUInt32LE(0);
    const r = new Reader(body);
    r.uint();
    if (type === 0x73f1f8dc) {
      // msgs_container#73f1f8dc messages:vector<Message>（无 req_msg_id 字段）
      const count = r.int();
      for (let i = 0; i < count; i += 1) {
        r.long();  // msg_id
        r.int();   // seq_no
        const l = r.int();
        const msg = Buffer.from(r.b.subarray(r.o, r.o + l));
        r.o = r.o + l + ((4 - (l % 4)) % 4);
        this.dispatch(msg);
      }
      return;
    }
    if (type === 0x9ec20908) {
      // new_session_created#9ec20908 first_msg_id:long unique_id:long server_salt:long
      r.long(); // first_msg_id
      r.long(); // unique_id
      const newSalt = r.long();
      this.log('新 session,salt 更新 → ' + newSalt);
      this.salt = newSalt;
      /* 标准流程:旧 salt 的请求会被拒(bad_msg),用新 salt 重发所有 pending */
      const stale = Array.from(this.props.entries());
      for (const [key, entry] of stale) {
        if (!entry.body) continue;
        clearTimeout(entry.timer);
        this.props.delete(key);
        this.send(entry.body).then(entry.resolve, entry.reject);
      }
      return;
    }
    if (type === 0xf35c6d01) {
      // rpc_result#f35c6d01 req_msg_id:long result:Object
      const reqId = r.long();
      const key = reqId.toString(16);
      const entry = this.props.get(key);
      if (!entry) { this.log('收到无人认领的 rpc_result req=' + key); return; }
      clearTimeout(entry.timer);
      this.props.delete(key);
      const rest = body.subarray(r.o);
      this.props.set('last', { result: rest });
      entry.resolve(rest);
      return;
    }
    if (type === 0x2144ca19) {
      // rpc_error#2144ca19 error_code:int error_message:string（偶尔不套 rpc_result）
      const code = r.int();
      const msg = r.string();
      this.log('rpc_error ' + code + ' ' + msg);
      return;
    }
    if (type === 0xedab447b) {
      // bad_server_salt#edab447b bad_msg_id:long bad_msg_seq:int error_code:int new_server_salt:long
      r.long();
      r.int();
      r.int();
      const newSalt = r.long();
      this.log('服务器要求换 salt → ' + newSalt);
      this.salt = newSalt;
      const stale = Array.from(this.props.entries());
      for (const [key, entry] of stale) {
        if (!entry.body) continue;
        clearTimeout(entry.timer);
        this.props.delete(key);
        this.send(entry.body).then(entry.resolve, entry.reject);
      }
      return;
    }
    if (type === 0xa7eff811) {
      const badMsgId = r.long();
      r.int();
      const errCode = r.int();
      this.log('bad_msg_notification msg_id=' + badMsgId + ' code=' + errCode);
      return;
    }
    this.log('收到其他消息 type=0x' + type.toString(16) + ' len=' + body.length);
  }

  onFatal(err) {
    this.log('连接层错误:' + ((err && err.message) || err));
    for (const [, e] of this.props) {
      clearTimeout(e.timer);
      if (e.reject) e.reject(err);
    }
    this.props.clear();
  }

  close() {
    try { if (this.socket) this.socket.destroy(); } catch (e) { /* ignore */ }
    this.socket = null;
  }
}

/* ---------- TL 对象 ---------- */
const TL = {
  updatesGetState: () => tlUInt(0xedd4882a),
  invokeWithLayer: (query, layer) => Buffer.concat([tlUInt(0xda9b0d0d), tlInt(layer || LAYER), query]),
  initConnection: (query) => Buffer.concat([
    tlUInt(0xc1cd5ea9),
    tlInt(0),               // flags：不带 proxy / params
    tlInt(API_ID),
    tlString('Desktop'),
    tlString('Windows 10'),
    tlString(APP_VERSION),
    tlString('en'),
    tlString(''),           // lang_pack
    tlString('en'),
    query,
  ]),
};

module.exports = {
  MtpSession,
  Reader,
  TL,
  LAYER,
  API_ID,
  DC_ENDPOINTS,
  tlInt, tlUInt, tlLong, tlBytes, tlString, tlVector,
  igeEncrypt, igeDecrypt, deriveKeys, computeMsgKey,
};
