/* ============================================================
 * Telegram Desktop 本地缓存读取（离线，不联网）
 * ------------------------------------------------------------
 * 不是网络爬取，而是直接解本机 Telegram Desktop 落盘的缓存：
 *   <tdata>/user_data/cache/**        小文件缓存（图片、圆视频、语音）
 *   <tdata>/user_data/media_cache/**  大文件缓存（视频分片，8MB/片）
 *
 * 为什么需要它：t.me 网页预览一旦被频道关掉，匿名谁也拿不到内容；
 * 但只要本机客户端里看过，磁盘上就有明文可解的副本 —— 这条路不受
 * 「有没有开预览」影响，也不经过任何服务器。
 *
 * 加密链（已对照 telegramdesktop/tdesktop + desktop-app/lib_storage 源码验证）：
 *   1. key_datas = "TDF$" + 版本 + [salt(32)][openKeyEncrypted][infoEncrypted]
 *      本地密钥用「空口令派生密钥」包着 —— 口令为空时 PBKDF2 只迭代 1 次，
 *      所以没有开启应用锁的机器可以直接解出来。
 *   2. 缓存文件 = "TDEF" + salt(64) + AES-256-CTR(头 48 字节 + 正文)
 *      AES 的 key/iv 由本地密钥与 salt 各半做 SHA256 得到（见 storage_encryption.cpp）。
 *
 * 能拿到什么：
 *   · 图片（jpg/png/webp/gif）、圆视频（webm）、语音（ogg/mp4）—— 完整
 *   · 视频 —— 只有 8MB 分片；moov 在文件尾的视频会因为缺尾段而放不出来
 * 拿不到什么：
 *   · 分片的顺序（缓存键是哈希，无法从文件名反推偏移），所以拼不成整段长视频
 *   · 任何标题/频道信息（缓存里只有裸媒体）
 * ============================================================ */
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/* ---------- 加密原语 ---------- */
const sha1 = (b) => crypto.createHash('sha1').update(b).digest();
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const sha512 = (b) => crypto.createHash('sha512').update(b).digest();
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

/* AES-256-IGE 解密，等价于 OpenSSL AES_ige_encrypt(..., AES_DECRYPT) */
function igeDecrypt(src, key, iv) {
  if (src.length % 16) throw new Error('IGE 长度须为 16 的倍数');
  const dec = crypto.createDecipheriv('aes-256-ecb', key, null);
  dec.setAutoPadding(false);
  const out = Buffer.alloc(src.length);
  let iv1 = Buffer.from(iv.subarray(0, 16));
  let iv2 = Buffer.from(iv.subarray(16, 32));
  for (let off = 0; off < src.length; off += 16) {
    const c = src.subarray(off, off + 16);
    const t = Buffer.alloc(16);
    for (let i = 0; i < 16; i += 1) t[i] = c[i] ^ iv2[i];
    const y = dec.update(t);
    for (let i = 0; i < 16; i += 1) out[off + i] = y[i] ^ iv1[i];
    iv1 = Buffer.from(c);
    iv2 = Buffer.from(out.subarray(off, off + 16));
  }
  return out;
}

/* prepareAES_oldmtp：256 字节 key + 16 字节 msgKey → aesKey / aesIV */
function prepareAESOldMtp(key, msgKey) {
  const x = 8; // 解密方向
  const a = sha1(Buffer.concat([msgKey, key.subarray(x, x + 32)]));
  const b = sha1(Buffer.concat([key.subarray(32 + x, 48 + x), msgKey, key.subarray(48 + x, 64 + x)]));
  const c = sha1(Buffer.concat([key.subarray(64 + x, 96 + x), msgKey]));
  const d = sha1(Buffer.concat([msgKey, key.subarray(96 + x, 128 + x)]));
  return {
    key: Buffer.concat([a.subarray(0, 8), b.subarray(8, 20), c.subarray(4, 16)]),
    iv: Buffer.concat([a.subarray(8, 20), b.subarray(0, 8), c.subarray(16, 20), d.subarray(0, 8)]),
  };
}

/* 解一个 PrepareEncrypted 块：[sha1_16][IGE 密文] */
function decryptLocal(encrypted, authKey) {
  if (!encrypted || encrypted.length <= 16) return null;
  const tag = encrypted.subarray(0, 16);
  const { key, iv } = prepareAESOldMtp(authKey, tag);
  const plain = igeDecrypt(encrypted.subarray(16), key, iv);
  if (!sha1(plain).subarray(0, 16).equals(tag)) return null;
  const size = plain.readUInt32LE(0);
  if (size < 4 || size > plain.length) return null;
  return plain.subarray(4, size);
}

/* 读 "TDF$" 文件里的 QByteArray 序列 */
function readBlobs(file) {
  const b = fs.readFileSync(file);
  if (b.subarray(0, 4).toString('latin1') !== 'TDF$') throw new Error('不是 TDF$ 文件');
  let off = 8;
  const blobs = [];
  while (off + 4 <= b.length - 16) {
    const len = b.readUInt32BE(off);
    off += 4;
    if (len > b.length - off) break;
    blobs.push(b.subarray(off, off + len));
    off += len;
  }
  return blobs;
}

/* 读一个 TDF$ 容器（tdata 下所有存储文件都是这个壳）：
     "TDF$"(4) + version(int32 LE) + [QDataStream 大端长度拼起来的若干 QByteArray] + MD5(16)
   长度 0xFFFFFFFF 表示 null（Qt 对空 QByteArray 的写法），要保留占位，
   因为 map 文件的前两段就是 null。 */
function readTdfFile(file) {
  const b = fs.readFileSync(file);
  if (b.length < 12 || b.subarray(0, 4).toString('latin1') !== 'TDF$') throw new Error('不是 TDF$ 文件');
  const version = b.readInt32LE(4);
  const body = b.subarray(8, Math.max(8, b.length - 16));
  const blobs = [];
  let off = 0;
  while (off + 4 <= body.length) {
    const len = body.readUInt32BE(off);
    off += 4;
    if (len === 0xffffffff) { blobs.push(null); continue; }
    if (len > body.length - off) break;
    blobs.push(body.subarray(off, off + len));
    off += len;
  }
  // 尾部 16 字节 = MD5(数据 + 数据长度 + 版本 + 魔数)，用来判断文件有没有写坏
  let sigOk = false;
  if (b.length >= 16) {
    const sz = Buffer.alloc(4);
    sz.writeInt32LE(body.length, 0);
    const ver = Buffer.alloc(4);
    ver.writeInt32LE(version, 0);
    const h = crypto.createHash('md5').update(body).update(sz).update(ver).update(Buffer.from('TDF$')).digest();
    sigOk = h.equals(b.subarray(b.length - 16));
  }
  return { version, blobs, data: body, sigOk, size: b.length };
}

/* ---------- 定位 tdata ---------- */
function locateTdata() {
  const home = os.homedir();
  const cands = [];
  const push = (p) => { if (p && !cands.includes(p)) cands.push(p); };
  [process.env.APPDATA, process.env.LOCALAPPDATA].forEach((base) => {
    if (!base) return;
    ['Telegram Desktop', 'TelegramDesktop', 'Telegram'].forEach((name) => {
      push(path.join(base, name, 'tdata'));
    });
  });
  push(path.join(home, 'Desktop', 'Telegram Desktop', 'tdata'));
  push(path.join(home, 'Downloads', 'Telegram Desktop', 'tdata'));
  push(path.join(home, 'AppData', 'Roaming', 'Telegram Desktop', 'tdata'));
  return cands.filter((p) => {
    try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
  });
}

/* ---------- 取本地密钥 ---------- */
function localKey(tdataDir) {
  const keyFile = path.join(tdataDir, 'key_datas');
  if (!fs.existsSync(keyFile)) return { ok: false, code: 'no-key-file', message: '找不到 key_datas（这个目录不像 Telegram Desktop 的 tdata）' };
  let blobs;
  try { blobs = readBlobs(keyFile); } catch (e) { return { ok: false, code: 'bad-key-file', message: e.message }; }
  const salt = blobs[0];
  const enc = blobs[1];
  if (!salt || salt.length !== 32) return { ok: false, code: 'bad-salt', message: 'key_datas 里的 salt 异常' };
  if (!enc || !enc.length) {
    return {
      ok: false,
      code: 'locked',
      message: '这个 Telegram 开了应用锁（口令），本地密钥被口令包着，没有口令解不开。可先在设置里关闭应用锁再试。',
    };
  }
  // 空口令：SHA512(salt + "" + salt) 作为口令，PBKDF2-HMAC-SHA512 单次迭代
  const hash = sha512(Buffer.concat([salt, salt]));
  const wrapKey = crypto.pbkdf2Sync(hash, salt, 1, 256, 'sha512');
  const key = decryptLocal(enc, wrapKey);
  if (!key) return { ok: false, code: 'bad-wrap', message: '本地密钥解不开（key_datas 结构与预期不符）' };
  return { ok: true, key: Buffer.from(key.subarray(0, 256)) };
}

/* ---------- 解一个缓存文件 ---------- */
/* 密文正文解密（纯计算，读文件的部分由调用方决定同步还是异步） */
function decryptCacheBody(buf, encKey) {
  if (!buf || buf.length < 132 || buf.subarray(0, 4).toString('latin1') !== 'TDEF') return { ok: false, code: 'not-cdef' };
  const salt = buf.subarray(4, 68);
  const body = buf.subarray(68);
  const half = encKey.length / 2;
  const key = sha256(Buffer.concat([encKey.subarray(0, half), salt.subarray(0, 32)]));
  const iv = sha256(Buffer.concat([encKey.subarray(half), salt.subarray(32, 64)])).subarray(0, 16);
  const dec = crypto.createDecipheriv('aes-256-ctr', key, iv);
  dec.setAutoPadding(false);
  let plain;
  try { plain = Buffer.concat([dec.update(body), dec.final()]); } catch (e) { return { ok: false, code: 'decrypt' }; }
  return { ok: true, data: plain.subarray(48) };
}

function openCacheFile(file, encKey) {
  let b;
  try { b = fs.readFileSync(file); } catch (e) { return { ok: false, code: 'locked', message: e.code }; }
  return decryptCacheBody(b, encKey);
}

/* 异步版：扫描要解几百个文件，同步读会把主进程事件循环整个卡住
   （界面上的进度条因此一直不刷新，看起来像死了） */
async function openCacheFileAsync(file, encKey) {
  let b;
  try { b = await fsp.readFile(file); } catch (e) { return { ok: false, code: 'locked', message: e.code }; }
  return decryptCacheBody(b, encKey);
}

/* ---------- 类型识别 ---------- */
const MAGICS = [
  { sig: Buffer.from([0xff, 0xd8, 0xff]), delta: 0, ext: 'jpg', kind: 'image' },
  { sig: Buffer.from([0x89, 0x50, 0x4e, 0x47]), delta: 0, ext: 'png', kind: 'image' },
  { sig: Buffer.from('GIF8'), delta: 0, ext: 'gif', kind: 'image' },
  { sig: Buffer.from('RIFF'), delta: 0, ext: 'webp', kind: 'image', riff: true },
  { sig: Buffer.from('ftyp'), delta: -4, ext: 'mp4', kind: 'video' },
  { sig: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), delta: 0, ext: 'webm', kind: 'video' },
  { sig: Buffer.from('OggS'), delta: 0, ext: 'ogg', kind: 'audio' },
  { sig: Buffer.from('ID3'), delta: 0, ext: 'mp3', kind: 'audio' },
];

function detect(data) {
  const head = data.subarray(0, 64);
  for (const m of MAGICS) {
    const at = head.indexOf(m.sig);
    if (at < 0) continue;
    const start = at + m.delta;
    if (start < 0) continue;
    let ext = m.ext;
    if (m.riff) {
      // RIFF 里既可能是 webp 图片，也可能是 wav 语音
      const fourcc = data.subarray(start + 8, start + 12).toString('latin1');
      if (fourcc === 'WEBP') ext = 'webp';
      else if (fourcc === 'WAVE') { ext = 'wav'; return { start, ext, kind: 'audio' }; }
      else continue;
    }
    return { start, ext, kind: m.kind };
  }
  return null;
}

/* MP4 盒结构分析。
   · hasIndex: 找到 moov（普通 MP4）或 moof（fMP4 分片）—— 有索引就能按现有字节播放
   · truncated: 某个盒声明长度超出文件 —— 说明只下到了前半段（缓存是 8MB 分片的）
   长视频常常 moov 在文件尾，缺尾段就彻底放不出来；moov 在前的能放前面一段。 */
function mp4Analysis(buf) {
  let o = 0;
  let hasIndex = false;
  let truncated = false;
  for (let n = 0; n < 256 && o + 8 <= buf.length; n += 1) {
    let size = buf.readUInt32BE(o);
    const type = buf.subarray(o + 4, o + 8).toString('latin1').replace(/[^\x20-\x7e]/g, '?');
    if (size === 1 && o + 16 <= buf.length) size = Number(buf.readBigUInt64BE(o + 8));
    if (size === 0) break;                  // 延伸到文件末尾
    if (size < 8) { truncated = true; break; }
    if (o + size > buf.length) { truncated = true; break; }
    if (type === 'moov' || type === 'moof') hasIndex = true;
    o += size;
  }
  return { hasIndex, truncated };
}

/* ---------- 文件枚举 ---------- */
async function listCacheFiles(tdata) {
  const dirs = [
    { dir: path.join(tdata, 'user_data', 'cache'), source: 'cache' },
    { dir: path.join(tdata, 'user_data', 'media_cache'), source: 'media_cache' },
  ];
  const out = [];
  let bytes = 0;
  for (const d of dirs) {
    let exists = false;
    try { exists = fs.statSync(d.dir).isDirectory(); } catch (e) { exists = false; }
    if (!exists) continue;
    const stack = [d.dir];
    while (stack.length) {
      const cur = stack.pop();
      let ents;
      try { ents = await fsp.readdir(cur, { withFileTypes: true }); } catch (e) { continue; }
      for (const e of ents) {
        const p = path.join(cur, e.name);
        if (e.isDirectory()) { stack.push(p); continue; }
        if (!e.isFile()) continue;
        let st;
        try { st = await fsp.stat(p); } catch (err) { continue; }
        bytes += st.size;
        out.push({ file: p, source: d.source, size: st.size, mtime: st.mtimeMs || 0 });
      }
    }
  }
  return { files: out, bytes };
}

/* 同一文件只要 size/mtime 没变，上次解出来的结论就还能用。
   多次扫描同一个缓存（换筛选条件、来回点按钮）不必重解 1GB。 */
const RECORD_CACHE = new Map();

function memoGet(stamp) {
  return RECORD_CACHE.get(stamp);
}

function memoSet(stamp, rec) {
  if (RECORD_CACHE.size > 20000) RECORD_CACHE.clear();
  RECORD_CACHE.set(stamp, rec);
}

/* ---------- 概览：只做「能不能解」的判断，不解密正文 ---------- */
function probe(opts) {
  const o = opts || {};
  const list = o.tdata ? [o.tdata] : locateTdata();
  if (!list.length) {
    return {
      ok: false,
      code: 'no-tdata',
      message: '没找到 Telegram Desktop 的数据目录（tdata）。绿色版/自定义安装的话，把 tdata 的完整路径填进去。',
    };
  }
  const tdata = list[0];
  const k = localKey(tdata);
  let fileCount = 0;
  let bytes = 0;
  const count = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { count(p); continue; }
      try { bytes += fs.statSync(p).size; fileCount += 1; } catch (err) { /* ignore */ }
    }
  };
  count(path.join(tdata, 'user_data', 'cache'));
  count(path.join(tdata, 'user_data', 'media_cache'));
  return {
    ok: !!k.ok,
    tdata,
    candidates: list,
    keyOk: !!k.ok,
    locked: !k.ok && k.code === 'locked',
    code: k.ok ? '' : k.code,
    message: k.ok ? '' : k.message,
    fileCount,
    bytes,
  };
}

/* ---------- 扫描 ---------- */
/* 返回的 items 只含展示/导出所需字段；真正落盘的文件路径放在 item.file。
   id 用 payload 的 md5：天然去重，也能当导出文件名。 */
async function scan(opts) {
  const o = opts || {};
  const tdataList = o.tdata ? [o.tdata] : locateTdata();
  if (!tdataList.length) {
    return { ok: false, code: 'no-tdata', message: '没找到 Telegram Desktop 的数据目录（tdata）' };
  }
  const tdata = tdataList[0];
  if (!fs.existsSync(tdata)) return { ok: false, code: 'bad-tdata', message: '这个路径不存在：' + tdata };
  const keyRes = localKey(tdata);
  if (!keyRes.ok) return Object.assign({ ok: false, tdata }, keyRes);
  const encKey = keyRes.key;

  const t0 = Date.now();
  const listed = await listCacheFiles(tdata);
  const files = listed.files;
  const items = [];
  const seen = new Set();
  let locked = 0;
  let unknown = 0;
  let dupes = 0;
  let done = 0;

  for (const f of files) {
    const stamp = f.file + '|' + f.size + '|' + Math.round(f.mtime);
    let rec = memoGet(stamp);
    if (rec === undefined) {
      const r = await openCacheFileAsync(f.file, encKey);
      if (!r.ok) {
        rec = { miss: r.code === 'locked' ? 'locked' : 'unknown' };
      } else {
        const info = detect(r.data);
        if (!info) {
          rec = { miss: 'unknown' };
        } else {
          const payload = r.data.subarray(info.start);
          rec = { md5: md5(payload), ext: info.ext, kind: info.kind, size: payload.length, playable: true, complete: true };
          if (info.ext === 'mp4') {
            const a = mp4Analysis(payload);
            rec.playable = a.hasIndex;
            rec.complete = a.hasIndex && !a.truncated;
          }
        }
      }
      memoSet(stamp, rec);
      // 每 16 个文件让出一次事件循环，进度条才动得起来
      if ((done & 15) === 0) await new Promise((r2) => setImmediate(r2));
    }
    done += 1;
    if (rec.miss) {
      if (rec.miss === 'locked') locked += 1;
      else unknown += 1;
    } else if (seen.has(rec.md5)) {
      dupes += 1; // 同一张图/同一段视频的重复副本只留一份
    } else {
      seen.add(rec.md5);
      items.push({
        id: rec.md5,
        file: f.file,
        source: f.source,
        ext: rec.ext,
        kind: rec.kind,
        size: rec.size,
        playable: rec.playable,
        complete: rec.complete,
        mtime: Math.round(f.mtime),
      });
    }
    if (o.onProgress && (done % 8 === 0 || done === files.length)) {
      o.onProgress({ done: done, total: files.length });
    }
  }

  // 最近下载的排前面：用户通常是「刚才看过的那个」最想找回
  items.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

  const stat = { image: 0, video: 0, audio: 0 };
  let bytes = 0;
  for (const it of items) {
    stat[it.kind] = (stat[it.kind] || 0) + 1;
    bytes += it.size;
  }

  return {
    ok: true,
    tdata: tdata,
    items: items,
    stat: stat,
    bytes: bytes,
    locked: locked,
    unknown: unknown,
    dupes: dupes,
    fileCount: files.length,
    cacheBytes: listed.bytes,
    ms: Date.now() - t0,
  };
}

/* ---------- 导出 ---------- */
const SUBDIR = { image: '图片', video: '视频', audio: '语音' };

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function humanSize(n) {
  const v = Number(n) || 0;
  if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
  return v + ' B';
}

/* 落盘一份能在浏览器里直接看的索引页。
   导出几百个 tg_xxx.jpg 之后，没有索引页这个功能等于没用 ——
   文件名里没有标题、没有频道，只有哈希。 */
function buildIndex(files, dest) {
  const groups = { image: [], video: [], audio: [] };
  for (const f of files) (groups[f.kind] || groups.image).push(f);
  const tile = (f) => {
    const rel = escHtml(f.rel);
    if (f.kind === 'image') {
      return `<figure class="it"><a href="${rel}" target="_blank"><img src="${rel}" loading="lazy" alt=""></a><figcaption>${f.ext.toUpperCase()} · ${humanSize(f.size)}</figcaption></figure>`;
    }
    if (f.kind === 'video') {
      if (!f.playable) {
        return `<figure class="it"><div class="ph">缺索引</div><figcaption><a href="${rel}" target="_blank">${f.ext.toUpperCase()}</a> · ${humanSize(f.size)}<br><span class="warn">仅缓存分片，可能无法播放</span></figcaption></figure>`;
      }
      return `<figure class="it"><video src="${rel}" controls preload="metadata"></video><figcaption>${f.ext.toUpperCase()} · ${humanSize(f.size)}${f.complete ? '' : ' · <span class="warn">不完整</span>'}</figcaption></figure>`;
    }
    return `<figure class="it"><div class="ph">语音</div><figcaption><a href="${rel}" target="_blank">${f.ext.toUpperCase()}</a> · ${humanSize(f.size)}<br><audio src="${rel}" controls preload="none"></audio></figcaption></figure>`;
  };
  const section = (title, arr) => (arr.length
    ? `<h2>${title} <span class="n">${arr.length}</span></h2><div class="grid">${arr.map(tile).join('')}</div>`
    : '');
  const total = files.length;
  const bytes = files.reduce((s, f) => s + (f.size || 0), 0);
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>Telegram 本地缓存导出 · ${total} 项</title>
<style>
  body{margin:0;padding:24px 28px 60px;background:#f4f6fa;color:#2b2f36;
       font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;font-size:14px}
  h1{font-size:18px;margin:0 0 6px}
  h2{font-size:14px;margin:26px 0 10px;color:#4a5060}
  .n{font-weight:400;color:#8a919f;font-size:12px}
  .meta{color:#8a919f;font-size:12px;margin-bottom:6px;line-height:1.7}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:12px}
  .it{margin:0;background:#fff;border-radius:10px;overflow:hidden;
      box-shadow:0 1px 2px rgba(23,33,60,.05),0 4px 14px rgba(23,33,60,.05)}
  .it img,.it video{display:block;width:100%;height:132px;object-fit:cover;background:#eef1f7}
  .it video{object-fit:contain;background:#0f1320}
  .it .ph{height:132px;display:flex;align-items:center;justify-content:center;
          background:#eef1f7;color:#a8b0c2;font-size:12px}
  figcaption{padding:6px 9px 8px;font-size:11px;color:#6b7280;line-height:1.6}
  figcaption a{color:#3a76d8;text-decoration:none}
  audio{width:100%;margin-top:6px}
  .warn{color:#e8891a}
</style></head>
<body>
<h1>Telegram 本地缓存导出</h1>
<div class="meta">${total} 项 · ${humanSize(bytes)} · 导出目录 ${escHtml(dest)}<br>
  文件名里的 <code>tg_</code> 后面是内容哈希（缓存里没有标题和频道信息）。
  视频标注「不完整」表示只恢复到这个分片，能播的部分通常只有开头几秒。</div>
${section('图片', groups.image)}
${section('视频', groups.video)}
${section('语音', groups.audio)}
</body></html>`;
}

/* items 可以是从 scan() 拿到的子集（界面里勾选的那几条）；
   不传就整盘扫一遍全导。 */
async function recover(opts) {
  const o = opts || {};
  let items = Array.isArray(o.items) ? o.items : null;
  let tdata = o.tdata || (o.items && o.items.length ? '' : '');
  if (!items) {
    const r = await scan(o);
    if (!r.ok) return r;
    items = r.items;
    tdata = r.tdata;
  }
  if (!tdata) {
    const list = locateTdata();
    tdata = list[0] || '';
  }
  if (!tdata) return { ok: false, code: 'no-tdata', message: '没找到 tdata' };
  const keyRes = localKey(tdata);
  if (!keyRes.ok) return keyRes;
  const encKey = keyRes.key;

  const dest = o.dest || path.join(os.homedir(), 'Desktop', 'Telegram本地缓存');
  fs.mkdirSync(dest, { recursive: true });

  const byKind = o.byKind !== false;
  const counters = {};
  const out = [];
  let written = 0;
  let skipped = 0;
  let bytes = 0;
  let done = 0;

  for (const it of items) {
    done += 1;
    const ext = String(it.ext || 'bin').toLowerCase();
    const kind = it.kind || 'image';
    const name = 'tg_' + String(it.id || '').slice(0, 10) + '.' + ext;
    const dir = byKind ? path.join(dest, SUBDIR[kind] || '其他') : dest;
    if (byKind) fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, name);

    // 同名且大小一致 = 上次已经导出过，跳过（重复导出不该重解）
    let exists = 0;
    try { exists = fs.statSync(target).size; } catch (e) { exists = 0; }
    if (o.skipExisting !== false && exists > 0 && exists === it.size) {
      skipped += 1;
      counters[ext] = (counters[ext] || 0) + 1;
      out.push({
        name: name,
        rel: (byKind ? SUBDIR[kind] + '/' : '') + name,
        kind: kind,
        ext: ext,
        size: it.size,
        playable: it.playable !== false,
        complete: it.complete !== false,
        source: it.source || '',
        reused: true,
      });
      if (o.onProgress) o.onProgress({ done: done, total: items.length, written: written, skipped: skipped });
      continue;
    }

    const r = await openCacheFileAsync(it.file, encKey);
    if (!r.ok) {
      if (o.onProgress) o.onProgress({ done: done, total: items.length, written: written, skipped: skipped });
      continue;
    }
    const info = detect(r.data);
    if (!info) {
      if (o.onProgress) o.onProgress({ done: done, total: items.length, written: written, skipped: skipped });
      continue;
    }
    try {
      fs.writeFileSync(target, r.data.subarray(info.start));
    } catch (e) {
      if (o.onProgress) o.onProgress({ done: done, total: items.length, written: written, skipped: skipped });
      continue;
    }
    written += 1;
    bytes += it.size;
    counters[ext] = (counters[ext] || 0) + 1;
    out.push({
      name: name,
      rel: (byKind ? SUBDIR[kind] + '/' : '') + name,
      kind: kind,
      ext: ext,
      size: it.size,
      playable: it.playable !== false,
      complete: it.complete !== false,
      source: it.source || '',
    });
    if (o.onProgress) o.onProgress({ done: done, total: items.length, written: written, skipped: skipped });
    if ((done & 15) === 0) await new Promise((r2) => setImmediate(r2));
  }

  // 清单 + 索引页：manifest 给程序读，index.html 给人看
  try {
    fs.writeFileSync(
      path.join(dest, 'manifest.json'),
      JSON.stringify({ time: new Date().toISOString(), tdata: tdata, dest: dest, count: out.length, files: out }, null, 2),
      'utf8'
    );
  } catch (e) { /* 写不进去就算了，媒体文件已经落地 */ }
  if (o.writeIndex !== false) {
    try { fs.writeFileSync(path.join(dest, 'index.html'), buildIndex(out, dest), 'utf8'); } catch (e) { /* ignore */ }
  }

  return {
    ok: true,
    dest: dest,
    count: out.length,
    written: written,
    skipped: skipped,
    bytes: bytes,
    counters: counters,
    files: out,
    tdata: tdata,
  };
}

module.exports = {
  locateTdata,
  localKey,
  openCacheFile,
  openCacheFileAsync,
  detect,
  mp4Analysis,
  readTdfFile,
  probe,
  scan,
  recover,
  buildIndex,
  humanSize,
  // 供测试
  igeDecrypt,
  prepareAESOldMtp,
  decryptLocal,
  readBlobs,
};
