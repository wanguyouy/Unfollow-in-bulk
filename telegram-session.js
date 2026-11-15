/* ============================================================
 * Telegram Desktop 会话复用：从 tdata 里取出「已登录的授权密钥」
 * ------------------------------------------------------------
 * 做什么：把本机 Telegram Desktop 的登录态（用户 ID + 主 DC + 各 DC 的
 * 256 字节 auth key）读出来，之后可以直接用 MTProto 连服务器 ——
 * 相当于「复用这个客户端已经登录的身份」，不用重新输码登录。
 *
 * 数据在哪：tdata/<16 位 hex>s（根目录下 16 个 hex 字符 + s 的那个）
 *   TDF$ + 版本 + [u32 blockId=0x4B(dbiMtpAuthorization)][u32 len][序列化体] + MD5
 * 序列化体（QDataStream 大端、Qt_5_1）：
 *   quint64 kWideIdsTag(=~0) | quint64 userId | qint32 mainDcId
 *   qint32 keysCount | 每项 { qint32 dcId, 256 字节 key }
 *   qint32 keysToDestroyCount | 每项同上
 * 旧格式没有 kWideIdsTag，头 8 字节是 qint32 userId + qint32 mainDcId。
 *
 * 只读，不写回 tdata；MTProto 用独立的 session_id，不会踢掉正在用的客户端。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tgLocal = require('./telegram-local');

const WIDE_IDS_TAG = 0xffffffffffffffffn;
const BLOCK_ID_MTP_AUTH = 0x4b; // dbiMtpAuthorization
const KEY_SIZE = 256;

/* auth_key_id = SHA1(key) 的后 8 字节，按小端 int64 读 */
function keyIdOf(key) {
  const sha = crypto.createHash('sha1').update(key).digest();
  return Buffer.from(sha.subarray(12, 20)).reverse(); // 转成小端字节序存着方便直写
}

/* 解析序列化体 */
function parseAuthBody(buf) {
  if (!buf || buf.length < 12) return { ok: false, code: 'bad-auth', message: '授权数据太短' };
  let off = 0;
  let userId = 0n;
  let mainDcId = 0;
  const head = buf.length >= 20 ? buf.readBigUInt64BE(0) : -1n;
  if (head === WIDE_IDS_TAG) {
    userId = buf.readBigUInt64BE(8);
    mainDcId = buf.readInt32BE(16);
    off = 20;
  } else {
    // 老格式：userId 只有 32 位
    userId = BigInt(buf.readInt32BE(0));
    mainDcId = buf.readInt32BE(4);
    off = 8;
  }
  const readKeys = () => {
    if (off + 4 > buf.length) return { count: 0, keys: [] };
    const count = buf.readInt32BE(off);
    off += 4;
    const keys = [];
    for (let i = 0; i < count; i += 1) {
      if (off + 4 + KEY_SIZE > buf.length) break;
      const dcId = buf.readInt32BE(off);
      off += 4;
      const key = Buffer.from(buf.subarray(off, off + KEY_SIZE));
      off += KEY_SIZE;
      keys.push({ dcId: dcId, key: key, keyId: keyIdOf(key).toString('hex') });
    }
    return { count: count, keys: keys };
  };
  const main = readKeys();
  const destroy = readKeys();
  if (!main.keys.length) return { ok: false, code: 'no-keys', message: '授权数据里没有可用的密钥' };
  return {
    ok: true,
    userId: userId.toString(),
    mainDcId: mainDcId,
    keys: main.keys,
    keysToDestroy: destroy.count,
    truncated: off !== buf.length,
  };
}

/* 在 tdata 根目录里找 dbiMtpAuthorization 文件（多账号会有好几个） */
function findAuthFiles(tdata, localKey) {
  let names = [];
  try { names = fs.readdirSync(tdata); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    if (!/^[0-9A-F]{16}s$/.test(name)) continue;
    const file = path.join(tdata, name);
    let tdf;
    try { tdf = tgLocal.readTdfFile(file); } catch (e) { continue; }
    for (const blob of tdf.blobs) {
      if (!blob || blob.length < 12) continue;
      const plain = tgLocal.decryptLocal(blob, localKey);
      if (!plain || plain.length < 8) continue;
      if (plain.readUInt32BE(0) !== BLOCK_ID_MTP_AUTH) continue;
      const len = plain.readUInt32BE(4);
      if (len > plain.length - 8) continue;
      out.push({
        file: file,
        name: name,
        version: tdf.version,
        sigOk: tdf.sigOk,
        body: plain.subarray(8, 8 + len),
      });
    }
  }
  return out;
}

/* opts: { tdata }（不给就用 locateTdata 的第一个） */
function readSession(opts) {
  const o = opts || {};
  const list = o.tdata ? [o.tdata] : tgLocal.locateTdata();
  if (!list.length) return { ok: false, code: 'no-tdata', message: '没找到 Telegram Desktop 的 tdata 目录' };
  const tdata = list[0];
  const keyRes = tgLocal.localKey(tdata);
  if (!keyRes.ok) return Object.assign({ ok: false, tdata: tdata }, keyRes);

  const found = findAuthFiles(tdata, keyRes.key);
  if (!found.length) {
    return {
      ok: false,
      code: 'no-auth',
      tdata: tdata,
      message: '这个 tdata 里没有找到登录授权（可能还没登录过账号）',
    };
  }
  // 多账号时取「用户 ID 最大 / 密钥最多」的那个，通常就是主账号
  const parsed = found
    .map((f) => Object.assign({ file: f.file, name: f.name, version: f.version, sigOk: f.sigOk }, parseAuthBody(f.body)))
    .filter((p) => p.ok);
  if (!parsed.length) {
    return { ok: false, code: 'bad-auth', tdata: tdata, message: '找到了授权文件，但内容解析失败' };
  }
  parsed.sort((a, b) => {
    if (a.keys.length !== b.keys.length) return b.keys.length - a.keys.length;
    return BigInt(b.userId) > BigInt(a.userId) ? 1 : -1;
  });
  const pick = parsed[0];
  return {
    ok: true,
    tdata: tdata,
    file: path.basename(pick.file),
    version: pick.version,
    sigOk: pick.sigOk,
    userId: pick.userId,
    mainDcId: pick.mainDcId,
    keys: pick.keys,
    accounts: parsed.map((p) => ({ file: path.basename(p.file), userId: p.userId, mainDcId: p.mainDcId, keys: p.keys.length })),
  };
}

module.exports = { readSession, parseAuthBody, keyIdOf, BLOCK_ID_MTP_AUTH };
