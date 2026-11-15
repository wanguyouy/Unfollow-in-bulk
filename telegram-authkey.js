/* ============================================================
 * MTProto auth_key 生成（明文 DH 握手，照官方 auth_key.md 逐字段实现）
 * ------------------------------------------------------------
 * 用途有二：
 *   1. 隔离实验 —— 服务器刚发的 key 必然有效，能证明加密栈对不对；
 *   2. 会话来源之一 —— 就算不复用 tdata，也可以用新 key 走 MTProto。
 *
 * 流程：req_pq_multi → resPQ → 分解 pq → RSA_PAD(req_DH_params)
 *      → server_DH_params_ok → DH → set_client_DH_params → dh_gen_ok
 * 全部明文帧：auth_key_id=0 + msg_id(8) + msg_len(4) + body
 * ============================================================ */
const crypto = require('crypto');
const zlib = require('zlib');
const { connectTunnel } = require('./telegram-fetch');
const M = require('./telegram-mtproto');

/* int128/int256 在 TL 里是裸定长字节,不是 string */
function rawN(reader, n) {
  const out = Buffer.from(reader.b.subarray(reader.o, reader.o + n));
  reader.o += n;
  return out;
}

/* 官方内置 RSA 公钥（tdesktop mtproto_dc_options.cpp 里的生产密钥） */
const RSA_PEM = [
  '-----BEGIN RSA PUBLIC KEY-----',
  'MIIBCgKCAQEA6LszBcC1LGzyr992NzE0ieY+BSaOW622Aa9Bd4ZHLl+TuFQ4lo4g',
  '5nKaMBwK/BIb9xUfg0Q29/2mgIR6Zr9krM7HjuIcCzFvDtr+L0GQjae9H0pRB2OO',
  '62cECs5HKhT5DZ98K33vmWiLowc621dQuwKWSQKjWf50XYFw42h21P2KXUGyp2y/',
  '+aEyZ+uVgLLQbRA1dEjSDZ2iGRy12Mk5gpYc397aYp438fsJoHIgJ2lgMv5h7WY9',
  't6N/byY9Nw9p21Og3AoXSL2q/2IJ1WRUhebgAdGVMlV1fkuOQoEzR7EdpqtQD9Cs',
  '5+bfo3Nhmcyvk5ftB0WkJ9z6bNZ7yxrP8wIDAQAB',
  '-----END RSA PUBLIC KEY-----',
].join('\n');

let _pubKey = null;
function pubKey() {
  if (_pubKey) return _pubKey;
  const ko = crypto.createPublicKey({ key: RSA_PEM, format: 'pem' });
  const jwk = ko.export({ format: 'jwk' });
  const n = Buffer.from(jwk.n, 'base64url');
  const e = Buffer.from(jwk.e, 'base64url');
  /* fingerprint = SHA1( TL(n) + TL(e) ) 的 64 低位；线上字节 = sha1[12:20] 原样 */
  const sha = crypto.createHash('sha1').update(M.tlBytes(n)).update(M.tlBytes(e)).digest();
  const fpBuf = Buffer.from(sha.subarray(12, 20));
  _pubKey = { n, e, fp: fpBuf.readBigInt64LE(0), fpBuf };
  return _pubKey;
}

/* ---------- 大数工具 ---------- */
function modpow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/* Pollard rho：pq 是两个 ~32bit 质数之积，rho 几毫秒就出结果 */
function factorize(pq) {
  const n = BigInt('0x' + Buffer.from(pq).toString('hex'));
  if (n % 2n === 0n) return [2n, n / 2n];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let x = BigInt(2 + Math.floor(Math.random() * 1e6));
    let y = x;
    let c = BigInt(1 + Math.floor(Math.random() * 1e6));
    let d = 1n;
    while (d === 1n) {
      x = (x * x + c) % n;
      y = (y * y + c) % n;
      y = (y * y + c) % n;
      const diff = x > y ? x - y : y - x;
      d = gcd(diff % n || n, n);
    }
    if (d !== n && d !== 1n) {
      const other = n / d;
      return d < other ? [d, other] : [other, d];
    }
    // 否则换个随机起点重试
  }
  throw new Error('pq 分解失败');
}
function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }

/* ---------- 明文帧连接 ---------- */
class PlainConn {
  constructor(debug) { this.dbg = debug; this.buf = Buffer.alloc(0); }

  log(m) { if (this.dbg) this.dbg('[hs] ' + m); }

  async connect(ip, proxy, timeout) {
    const t = timeout || 20000;
    if (proxy) {
      this.sock = await connectTunnel(proxy, ip, 443, t);
    } else {
      const net = require('net');
      this.sock = await new Promise((resolve, reject) => {
        const s = net.connect({ host: ip, port: 443 });
        s.setTimeout(t, () => s.destroy(new Error('连接超时')));
        s.once('connect', () => { s.setTimeout(0); resolve(s); });
        s.once('error', reject);
      });
    }
    this.sock.setNoDelay(true);
    this.sock.write(Buffer.from([0xee, 0xee, 0xee, 0xee]));
    this.sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); });
    return true;
  }

  /* 明文帧：auth_key_id(8 全 0) + msg_id(8) + msg_len(4) + body */
  send(body) {
    const head = Buffer.concat([
      Buffer.alloc(8),
      M.tlLong((BigInt(Math.floor(Date.now() / 1000)) << 32n)),
      M.tlInt(body.length),
      body,
    ]);
    const fr = Buffer.alloc(4 + head.length);
    fr.writeUInt32LE(head.length, 0);
    head.copy(fr, 4);
    this.sock.write(fr);
    this.log('→ 明文 ' + body.length + 'B 首4字节 ' + body.subarray(0, 4).toString('hex'));
  }

  /* 读一帧（含 4 字节传输错误码转异常、gzip_packed 解压） */
  async read(timeout) {
    const t0 = Date.now();
    const limit = timeout || 20000;
    for (;;) {
      /* 传输层错误码是裸 4 字节（无长度前缀） */
      if (this.buf.length >= 8 && this.buf.readUInt32LE(0) === 4 && this.buf.readUInt32LE(4) > 0xfff00000) {
        const code = this.buf.readInt32LE(4);
        this.buf = this.buf.subarray(8);
        throw new Error('服务器错误 ' + code);
      }
      if (this.buf.length >= 4) {
        const len = this.buf.readUInt32LE(0);
        if (len >= 12 && len <= 16 * 1024 * 1024 && this.buf.length >= 4 + len) {
          const frame = this.buf.subarray(4, 4 + len);
          this.buf = this.buf.subarray(4 + len);
          if (!frame.subarray(0, 8).every((b) => b === 0)) throw new Error('响应 auth_key_id 非 0');
          let body = frame.subarray(20, 20 + frame.readUInt32LE(16));
          if (body.readUInt32LE(0) === 0x3072cfa1) {
            const rr = new M.Reader(body);
            rr.uint();
            body = zlib.gunzipSync(rr.bytes());
            this.log('解压 → ' + body.length + 'B');
          }
          return body;
        }
      }
      if (Date.now() - t0 > limit) throw new Error('明文响应超时');
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  close() { try { if (this.sock) this.sock.destroy(); } catch (e) { /* ignore */ } }
}

/* ---------- 生成 ---------- */
async function generateAuthKey(opts) {
  const dcId = Number(opts.dcId) || 2;
  const dbg = opts.debug || null;
  const ip = (opts.endpoints || M.DC_ENDPOINTS)[dcId];
  const conn = new PlainConn(dbg);
  await conn.connect(ip, opts.proxy === undefined ? null : opts.proxy, opts.timeout || 25000);

  const nonce = crypto.randomBytes(16);
  conn.send(Buffer.concat([M.tlUInt(0xbe7e8ef1), nonce])); // req_pq_multi
  let body = await conn.read(20000);
  let r = new M.Reader(body);
  if (r.uint() !== 0x05162463) throw new Error('期望 resPQ, 得到 0x' + body.readUInt32LE(0).toString(16));
  const resNonce = rawN(r, 16);
  if (!resNonce.equals(nonce)) throw new Error('nonce 不匹配');
  const serverNonce = rawN(r, 16);
  const pq = r.bytes();
  const vecTag = r.uint();          // Vector<long> 的 tag 0x1cb5c415
  if (vecTag !== 0x1cb5c415) throw new Error('指纹向量 tag 异常 0x' + vecTag.toString(16));
  const fpCount = r.uint();
  const fps = [];
  for (let i = 0; i < fpCount; i += 1) fps.push(r.long());
  const pk = pubKey();
  if (!fps.includes(pk.fp)) throw new Error('服务器指纹不认识: ' + fps.join(',') + ' vs ' + pk.fp);
  dbg && dbg('[hs] pq=' + pq.length + 'B 指纹匹配');

  /* 分解 pq */
  const [pBig, qBig] = factorize(pq);
  const pqBig = BigInt('0x' + Buffer.from(pq).toString('hex'));
  if (pBig * qBig !== pqBig) throw new Error('pq 校验失败');
  const p = pBig.toString(16); const q = qBig.toString(16);
  const pBytes = Buffer.from((p.length % 2 ? '0' + p : p), 'hex');
  const qBytes = Buffer.from((q.length % 2 ? '0' + q : q), 'hex');

  /* p_q_inner_data_dc#a9f55f95 */
  const newNonce = crypto.randomBytes(32);
  const inner = Buffer.concat([
    M.tlUInt(0xa9f55f95),
    M.tlBytes(pq), M.tlBytes(pBytes), M.tlBytes(qBytes),
    nonce, serverNonce, newNonce,
    M.tlInt(dcId),
  ]);
  if (inner.length > 144) throw new Error('inner 数据超长 ' + inner.length);

  /* RSA_PAD(data, pubkey) */
  const nBig = BigInt('0x' + pk.n.toString('hex'));
  const eBig = BigInt('0x' + pk.e.toString('hex'));
  let keyAesEncrypted = null;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const padding = crypto.randomBytes(192 - inner.length);
    const dataWithPadding = Buffer.concat([inner, padding]);
    const dataPadReversed = Buffer.from(dataWithPadding).reverse();
    const tempKey = crypto.randomBytes(32);
    const dataWithHash = Buffer.concat([dataPadReversed, crypto.createHash('sha256').update(tempKey).update(dataWithPadding).digest()]);
    const zeroIv = Buffer.alloc(32);
    const aesEncrypted = M.igeEncrypt(dataWithHash, tempKey, zeroIv);
    const tempKeyXor = Buffer.from(tempKey.map((b, i) => b ^ crypto.createHash('sha256').update(aesEncrypted).digest()[i]));
    const cand = Buffer.concat([tempKeyXor, aesEncrypted]);
    if (BigInt('0x' + cand.toString('hex')) < nBig) { keyAesEncrypted = cand; break; }
  }
  if (!keyAesEncrypted) throw new Error('RSA_PAD 32 次都 >= modulus');

  const encryptedData = (() => {
    const v = BigInt('0x' + keyAesEncrypted.toString('hex'));
    const c = modpow(v, eBig, nBig);
    let hex = c.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    return Buffer.from(hex, 'hex'); // 可能不足 256 字节，外面再 pad
  })();
  const enc256 = Buffer.concat([Buffer.alloc(256 - encryptedData.length), encryptedData]);

  conn.send(Buffer.concat([
    M.tlUInt(0xd712e4be),       // req_DH_params
    nonce, serverNonce,
    M.tlBytes(pBytes), M.tlBytes(qBytes),
    M.tlLong(pk.fp),
    M.tlBytes(enc256),
  ]));
  body = await conn.read(20000);
  r = new M.Reader(body);
  if (r.uint() !== 0xd0e8075c) throw new Error('期望 server_DH_params_ok, 得到 0x' + body.readUInt32LE(0).toString(16));
  if (!rawN(r, 16).equals(nonce)) throw new Error('nonce 不匹配(2)');
  if (!rawN(r, 16).equals(serverNonce)) throw new Error('server_nonce 不匹配');
  const encryptedAnswer = r.bytes();

  /* tmp_aes_key / tmp_aes_iv（new_nonce 派生） */
  const tmpAesKey = Buffer.concat([
    crypto.createHash('sha1').update(newNonce).update(serverNonce).digest(),
    crypto.createHash('sha1').update(serverNonce).update(newNonce).digest().subarray(0, 12),
  ]);
  const tmpAesIv = Buffer.concat([
    crypto.createHash('sha1').update(serverNonce).update(newNonce).digest().subarray(12, 20),
    crypto.createHash('sha1').update(newNonce).update(newNonce).digest(),
    newNonce.subarray(0, 4),
  ]);
  let answer = M.igeDecrypt(encryptedAnswer, tmpAesKey, tmpAesIv);
  /* answer_with_hash = SHA1(answer)+answer+padding；靠 SHA1 前缀推出 answer 长度 */
  const given = answer.subarray(0, 20);
  /* 真正的 answer 长度要靠 server_DH_inner_data 结构自身 + SHA1 验证推出 */
  let realLen = -1;
  for (let l = 16; 20 + l <= answer.length; l += 4) {
    if (crypto.createHash('sha1').update(answer.subarray(20, 20 + l)).digest().equals(given)) { realLen = l; break; }
  }
  if (realLen < 0) throw new Error('answer SHA1 校验失败');
  const dhBody = answer.subarray(20, 20 + realLen);
  r = new M.Reader(dhBody);
  if (r.uint() !== 0xb5890dba) throw new Error('期望 server_DH_inner_data');
  rawN(r, 16); rawN(r, 16); // nonce, server_nonce
  const g = r.int();
  const dhPrime = r.bytes();
  const gA = r.bytes();
  const serverTime = r.int();
  dbg && dbg('[hs] DH 参数齐 g=' + g + ' prime=' + dhPrime.length + 'B server_time=' + serverTime);

  const pBig2 = BigInt('0x' + dhPrime.toString('hex'));
  const gBig = BigInt(g);
  const gABig = BigInt('0x' + gA.toString('hex'));
  if (gABig <= 1n || gABig >= pBig2 - 1n) throw new Error('g_a 越界');

  /* b 与 g_b */
  let bBig;
  let gBBig;
  do {
    bBig = BigInt('0x' + crypto.randomBytes(256).toString('hex'));
    gBBig = modpow(gBig, bBig, pBig2);
  } while (gBBig <= 1n || gBBig >= pBig2 - 1n);
  const authBig = modpow(gABig, bBig, pBig2);
  const authKey = Buffer.from(authBig.toString(16).padStart(512, '0'), 'hex');
  const gBBytes = Buffer.from(gBBig.toString(16).padStart(512, '0'), 'hex');

  /* client_DH_inner_data#6643b654 */
  const cdInner = Buffer.concat([
    M.tlUInt(0x6643b654),
    nonce, serverNonce,
    M.tlLong(0n),
    M.tlBytes(gBBytes),
  ]);
  const cdHash = crypto.createHash('sha1').update(cdInner).digest();
  const cdPad = crypto.randomBytes((16 - ((cdHash.length + cdInner.length) % 16)) % 16);
  const cdEnc = M.igeEncrypt(Buffer.concat([cdHash, cdInner, cdPad]), tmpAesKey, tmpAesIv);

  conn.send(Buffer.concat([
    M.tlUInt(0xf5045f1f),      // set_client_DH_params
    nonce, serverNonce,
    M.tlBytes(cdEnc),
  ]));
  body = await conn.read(20000);
  r = new M.Reader(body);
  const genType = r.uint();
  if (!rawN(r, 16).equals(nonce)) throw new Error('nonce 不匹配(3)');
  if (!rawN(r, 16).equals(serverNonce)) throw new Error('server_nonce 不匹配(3)');
  const nnHash = rawN(r, 16);
  const sha1auth = crypto.createHash('sha1').update(authKey).digest();
  const auxHash = sha1auth.subarray(0, 8);
  if (genType === 0x3bcbf734) { // dh_gen_ok
    const expect = crypto.createHash('sha1').update(newNonce).update(Buffer.from([1])).update(auxHash).digest().subarray(-16);
    if (!nnHash.equals(expect)) throw new Error('new_nonce_hash 校验失败');
  } else if (genType === 0x46dc1fb9) {
    throw new Error('服务器要求重试(dh_gen_retry)');
  } else if (genType === 0xa69dae02) {
    throw new Error('dh_gen_fail');
  } else {
    throw new Error('未知 DH 响应 0x' + genType.toString(16));
  }

  /* server_salt = new_nonce[0:8] XOR server_nonce[0:8] */
  const salt = Buffer.from(newNonce.subarray(0, 8).map((b, i) => b ^ serverNonce[i]));
  conn.close();
  return {
    ok: true,
    authKey,
    serverSalt: salt.readBigInt64LE(0),
    dcId,
    serverTime,
    timeDelta: serverTime - Math.floor(Date.now() / 1000),
  };
}

module.exports = { generateAuthKey, factorize, modpow, pubKey, PlainConn };
