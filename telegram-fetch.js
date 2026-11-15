/* ============================================================
 * Telegram 公开频道帖解析(纯 HTTPS,不建窗口、不需要账号)
 *
 * 为什么单独一个模块,而且必须自带 HTTP 客户端:
 *   1) t.me / telesco.pe 在国内直连是被掐的(DNS 能解出 IP,TCP 握手超时),
 *      而 Electron 主进程里的全局 fetch 是 Node 的 undici,【不读系统代理】,
 *      所以既不能用 fetch 解析,也不能用它下载 —— 这里自己实现带
 *      HTTP CONNECT 隧道的 GET(见 httpRequest / downloadTo)。
 *   2) 顺带支持断点、进度回调,不用改 downloadStream(那条是给 B站/抖音用的)。
 *
 * 整条链路(实测 2026-11):
 *   1) 帖链接 https://t.me/<channel>/<id>
 *   2) 单帖 widget 页 https://t.me/<channel>/<id>?embed=1&mode=tme
 *      —— 预览开启的频道会直接吐出 <video src="https://cdnN.telesco.pe/file/xxx.mp4?token=...">
 *      这个 mp4 免 cookie / 免 Referer / 免 UA,单文件带音轨(不需要 ffmpeg 合并)
 *   3) 兜底:https://t.me/s/<channel> 里按 data-post 扫同一帖(分页 ?before=<id>)
 *
 * 关键判断:「能不能解析」只取决于频道有没有开 Web 预览。
 *   预览关了的话,三种入口(t.me/<ch>/<id>、?embed=1、/s/<ch>)全都只回
 *   "View in Telegram / Preview channel" 那张引导页,一个媒体节点都没有。
 *   这不是代码问题,匿名 Web 就是拿不到 —— 只能 MTProto + 账号。
 *   所以这里如实报 tg_preview_off,不装死、不瞎猜。
 *
 * 本模块不依赖 electron,可直接用 node 跑:
 *   node -e "require('./telegram-fetch').fetchPost('<链接>').then(r=>console.log(r))"
 * ============================================================ */

const net = require('net');
const tls = require('tls');
const http = require('http');
const fs = require('fs');
const { execFileSync } = require('child_process');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/* ============================================================
 * 一、代理发现
 * ============================================================ */

/* 把各种写法归一成 {host, port, auth}:
 *   "127.0.0.1:7877" / "http://127.0.0.1:7877" / "http=127.0.0.1:7890;https=127.0.0.1:7891" */
function normProxy(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (s.indexOf('=') >= 0) {
    // 注册表里常见 "http=host:port;https=host:port" 的复合写法
    const parts = s.split(';').map((x) => x.trim()).filter(Boolean);
    let pick = '';
    for (const p of parts) {
      const m = p.match(/^https?=(.+)$/i);
      if (m) { pick = m[1]; if (/^https=/i.test(p)) break; }
    }
    s = pick || (parts[0] || '').replace(/^[a-z0-9]+=/i, '');
  }
  s = s.replace(/^[a-z0-9]+:\/\//i, '').replace(/\/+$/, '');
  const m = s.match(/^(?:([^@]+)@)?([^:@]+):(\d{2,5})$/);
  if (!m) return null;
  return { host: m[2], port: Number(m[3]), auth: m[1] || '' };
}

function envProxy() {
  const keys = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'];
  for (const k of keys) {
    if (process.env[k]) {
      const p = normProxy(process.env[k]);
      if (p) return p;
    }
  }
  return null;
}

function regRead(name) {
  try {
    const out = execFileSync('reg', ['query', REG_PATH, '/v', name], {
      encoding: 'latin1',
      windowsHide: true,
      timeout: 4000,
    });
    const m = out.match(new RegExp(name + '\\s+REG_\\w+\\s+(.+)', 'i'));
    return m ? m[1].trim() : '';
  } catch (e) {
    return '';
  }
}

let proxyCache;

/* 系统代理(Windows)。缓存 30 秒 —— 每次解析都 spawn reg 太浪费,
   但也不能永久缓存:用户可能开完软件才打开 Clash,缓存太久会一直走空。 */
function systemProxy() {
  const now = Date.now();
  if (proxyCache && now - proxyCache.at < 30000) return proxyCache.value;
  let value = null;
  if (process.platform === 'win32') {
    const on = regRead('ProxyEnable');
    if (/0x1\b/i.test(on) || on === '1') {
      value = normProxy(regRead('ProxyServer'));
    }
  }
  proxyCache = { value: value, at: now };
  return value;
}

function resolveProxy(opts) {
  if (opts && opts.proxy !== undefined) return opts.proxy ? normProxy(opts.proxy) : null;
  return envProxy() || systemProxy();
}

/* ============================================================
 * 二、极简 HTTP/1.1 客户端(支持 CONNECT 代理 + chunked)
 * ============================================================ */

function connectTunnel(proxy, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host + ':' + port };
    if (proxy.auth) {
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(proxy.auth, 'utf8').toString('base64');
    }
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: host + ':' + port,
      headers: headers,
      timeout: timeout || 15000,
      agent: false,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error('代理 CONNECT 失败 HTTP ' + res.statusCode));
        return;
      }
      resolve(socket);
    });
    req.on('timeout', () => req.destroy(new Error('代理连接超时')));
    req.on('error', reject);
    req.end();
  });
}

async function openConn(urlObj, proxy, timeout) {
  const isHttps = urlObj.protocol === 'https:';
  const host = urlObj.hostname;
  const port = Number(urlObj.port) || (isHttps ? 443 : 80);
  let socket;
  if (proxy) {
    socket = await connectTunnel(proxy, host, port, timeout);
  } else {
    socket = await new Promise((resolve, reject) => {
      const s = net.connect({ host: host, port: port });
      s.setTimeout(timeout || 15000, () => s.destroy(new Error('连接超时(' + host + ')')));
      s.once('connect', () => {
        s.setTimeout(0);
        resolve(s);
      });
      s.once('error', reject);
    });
  }
  if (!isHttps) return socket;
  return await new Promise((resolve, reject) => {
    const s = tls.connect({ socket: socket, servername: host }, () => resolve(s));
    s.once('error', reject);
  });
}

/* 把 socket 包成一个可 await 的读取器。
   为什么手写而不是用 http 模块:走 CONNECT 隧道后 socket 已经连好,
   再交给 https.request 会在 createConnection/agent 上纠缠不清,
   一个几十行的状态机反而干净、可控、可测。 */
function makeReader(socket) {
  let chunks = [];
  let len = 0;
  let ended = false;
  let err = null;
  let waiter = null;

  const wake = () => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  };

  socket.on('data', (d) => {
    chunks.push(d);
    len += d.length;
    wake();
  });
  socket.on('end', () => { ended = true; wake(); });
  socket.on('close', () => { ended = true; wake(); });
  socket.on('error', (e) => { err = e; ended = true; wake(); });

  function pull(n) {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const head = chunks[0];
      const need = n - filled;
      if (head.length <= need) {
        head.copy(out, filled);
        filled += head.length;
        chunks.shift();
        len -= head.length;
      } else {
        head.copy(out, filled, 0, need);
        chunks[0] = head.slice(need);
        len -= need;
        filled += need;
      }
    }
    return out;
  }

  /* 等下一批数据。注意:不要在这里写「等某个条件满足」——
     服务端常常在同一个事件循环里先 data 再 end,条件还没机会重判
     连接就关了。所以这里只负责「等到有变化」,条件和断连判断都交给调用方。 */
  const waitData = () => new Promise((r) => { waiter = r; });

  /* 在逻辑流里找 needle 的绝对位置(跨块也能命中) */
  function indexOf(needle) {
    const nb = Buffer.isBuffer(needle) ? needle : Buffer.from(needle, 'latin1');
    let span = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      // 块内直接找
      const at = chunks[i].indexOf(nb);
      if (at >= 0) return span + at;
      // 跨块:只有 needle 可能横跨边界时才需要拼(单字节 / 短 needle 常见)
      if (chunks[i].length < nb.length - 1 && i + 1 < chunks.length) {
        const joined = Buffer.concat(chunks.slice(i, i + 2));
        const at2 = joined.indexOf(nb);
        if (at2 >= 0) return span + at2;
      }
      span += chunks[i].length;
    }
    return -1;
  }

  function parseHead(buf) {
    const lines = buf.toString('latin1').split('\r\n');
    const m = lines[0].match(/^HTTP\/\d\.\d\s+(\d{3})/);
    const headers = {};
    for (let i = 1; i < lines.length; i += 1) {
      const c = lines[i].indexOf(':');
      if (c > 0) {
        const k = lines[i].slice(0, c).trim().toLowerCase();
        const v = lines[i].slice(c + 1).trim();
        headers[k] = headers[k] ? headers[k] + ', ' + v : v;
      }
    }
    return { status: m ? Number(m[1]) : 0, headers: headers };
  }

  async function readHead() {
    for (;;) {
      const at = indexOf('\r\n\r\n');
      if (at >= 0) {
        const headBuf = pull(at);
        pull(4);
        return parseHead(headBuf);
      }
      if (err) throw err;
      if (ended) throw new Error(len ? '响应头不完整' : '连接被关闭(未收到响应头)');
      await waitData();
    }
  }

  /* 按 Content-Length 读,边读边喂给 onChunk(用于下载落盘) */
  async function readFixed(total, onChunk) {
    let got = 0;
    while (got < total) {
      if (len === 0) {
        if (err) throw err;
        if (ended) throw new Error('连接提前中断(' + got + '/' + total + ')');
        await waitData();
        continue;
      }
      const n = Math.min(262144, total - got, len);
      const buf = pull(n);
      got += n;
      if (onChunk) await onChunk(buf, got, total);
    }
    return got;
  }

  /* chunked 解码(边解边喂) */
  async function readChunked(onChunk) {
    let got = 0;
    for (;;) {
      let line = '';
      for (;;) {
        const at = indexOf('\r\n');
        if (at >= 0) {
          line = pull(at).toString('latin1');
          pull(2);
          break;
        }
        if (err) throw err;
        if (ended) throw new Error('分块传输异常结束(已收 ' + got + ')');
        await waitData();
      }
      const size = parseInt(line.split(';')[0].trim(), 16);
      if (!size) return got; // 0 块表示结束,后面是 trailer,不关心
      let left = size;
      while (left > 0) {
        if (len === 0) {
          if (err) throw err;
          if (ended) throw new Error('分块数据中断(已收 ' + got + ')');
          await waitData();
          continue;
        }
        const n = Math.min(left, len);
        const buf = pull(n);
        left -= n;
        got += n;
        if (onChunk) await onChunk(buf, got, 0);
      }
      // 块尾 CRLF
      while (len < 2 && !ended && !err) await waitData();
      if (len >= 2) pull(2);
    }
  }

  async function readAll(limit) {
    const cap = limit || 8 * 1024 * 1024;
    while (!ended && !err && len < cap) {
      await waitData();
    }
    if (err) throw err;
    const all = Buffer.concat(chunks, len);
    chunks = [];
    len = 0;
    return all;
  }

  return { readHead, readFixed, readChunked, readAll, get pending() { return len; }, get closed() { return ended; } };
}

/* 发一个 GET。返回 {status, headers, text} (o.stream 时不读 body,交出 reader) */
async function httpRequest(urlStr, opts) {
  const o = opts || {};
  const urlObj = new URL(urlStr);
  const proxy = resolveProxy(o);
  const timeout = o.timeout || 15000;
  const socket = await openConn(urlObj, proxy, timeout);
  socket.setTimeout(timeout, () => {
    try { socket.destroy(new Error('请求超时(' + timeout + 'ms 无响应)')); } catch (e) { /* ignore */ }
  });

  const headers = Object.assign(
    {
      Host: urlObj.host,
      'User-Agent': o.ua || UA,
      Accept: 'text/html,application/xhtml+xml,application/json,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Connection: 'close',
    },
    o.headers || {}
  );
  const method = String(o.method || 'GET').toUpperCase();
  const lines = [method + ' ' + (urlObj.pathname + urlObj.search) + ' HTTP/1.1'];
  Object.keys(headers).forEach((k) => lines.push(k + ': ' + headers[k]));
  socket.write(lines.join('\r\n') + '\r\n\r\n');

  const reader = makeReader(socket);
  const head = await reader.readHead();
  const close = () => { try { socket.destroy(); } catch (e) { /* ignore */ } };

  // 跳转:最多跟 3 跳(t.me 偶尔会 302 到 /s/ 形态)
  if ([301, 302, 303, 307, 308].indexOf(head.status) >= 0 && head.headers.location && (o.maxRedirects || 0) < 3) {
    close();
    return httpRequest(new URL(head.headers.location, urlStr).toString(), Object.assign({}, o, { maxRedirects: (o.maxRedirects || 0) + 1 }));
  }

  /* HEAD 只看头,body 不存在(content-length 描述的是实体,不是本次响应长度) */
  if (method === 'HEAD') {
    close();
    return {
      status: head.status,
      headers: head.headers,
      text: '',
      bytes: 0,
      via: proxy ? 'proxy:' + proxy.host + ':' + proxy.port : 'direct',
    };
  }

  if (o.stream) {
    return { status: head.status, headers: head.headers, reader: reader, close: close, via: proxy ? 'proxy:' + proxy.host + ':' + proxy.port : 'direct' };
  }

  let body;
  if (/chunked/i.test(head.headers['transfer-encoding'] || '')) {
    const parts = [];
    await reader.readChunked(async (buf) => { parts.push(buf); });
    body = Buffer.concat(parts);
  } else {
    const total = Number(head.headers['content-length'] || 0);
    if (total) {
      const parts = [];
      await reader.readFixed(total, async (buf) => { parts.push(buf); });
      body = Buffer.concat(parts);
    } else {
      body = await reader.readAll();
    }
  }
  close();
  return {
    status: head.status,
    headers: head.headers,
    text: body.toString('utf8'),
    bytes: body.length,
    via: proxy ? 'proxy:' + proxy.host + ':' + proxy.port : 'direct',
  };
}

/* 先试代理,再试直连(或反之)。返回体里带 via,方便日志定位 */
async function httpGet(urlStr, opts) {
  const o = opts || {};
  const proxy = resolveProxy(o);
  const order = o.preferDirect ? [null, proxy] : [proxy, null];
  const tried = [];
  let lastErr = null;
  for (const p of order) {
    if (p === undefined) continue;
    if (p === null && o.noDirect && proxy) continue;
    if (tried.some((x) => (x === null && p === null) || (x && p && x.host === p.host && x.port === p.port))) continue;
    tried.push(p);
    try {
      return await httpRequest(urlStr, Object.assign({}, o, { proxy: p ? p.host + ':' + p.port + (p.auth ? '@' : '') : null, headers: o.headers }));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('请求失败');
}

/* ============================================================
 * 三、解析链接
 * ============================================================ */

/* 支持的写法:
 *   https://t.me/<channel>/<id>            正常帖链接
 *   https://t.me/s/<channel>/<id>          预览流里的链接
 *   https://telegram.me/<channel>/<id>
 *   tg://resolve?domain=<channel>&post=<id>
 *   https://t.me/<channel>?single           频道(无帖号)
 * 用户粘的分享文案里夹带链接也认。 */
function parseLink(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const scheme = raw.match(/tg:\/\/resolve\?([^\s]+)/i);
  if (scheme) {
    const q = new URLSearchParams(scheme[1]);
    const ch = (q.get('domain') || '').replace(/^@/, '');
    if (ch) return { channel: ch, postId: Number(q.get('post') || 0) || 0, url: 'https://t.me/' + ch + (q.get('post') ? '/' + q.get('post') : '') };
  }

  const m = raw.match(/(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(?:s\/)?([A-Za-z0-9_]{3,64})(?:\/(\d+))?/i);
  if (m) {
    const ch = m[1];
    const id = Number(m[2] || 0) || 0;
    return { channel: ch, postId: id, url: 'https://t.me/' + ch + (id ? '/' + id : '') };
  }

  // 只给了 @channel(没有帖号)—— 无法定位具体内容
  const at = raw.match(/^@([A-Za-z0-9_]{3,64})$/);
  if (at) return { channel: at[1], postId: 0, url: 'https://t.me/' + at[1] };
  return null;
}

function looksTelegram(text) {
  const t = String(text || '');
  return /(?:^|[^a-z0-9])(?:t|telegram)\.me\//i.test(t) || /tg:\/\/resolve/i.test(t);
}

/* ============================================================
 * 四、解析 HTML
 * ============================================================ */

function unescapeHtml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  return unescapeHtml(String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\r/g, '').trim();
}

function parseDuration(text) {
  // 面板里是 "0:12" / "1:02:33"
  const m = String(text || '').trim().match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return 0;
  if (m[3]) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number(m[1]) * 60 + Number(m[2]);
}

/* 从一个 widget 页(单帖 embed 或 /s/ 列表里的一段)里抽媒体信息 */
function parsePostBlock(html) {
  const s = String(html || '');
  const out = { kind: '', videoUrl: '', photoUrl: '', cover: '', duration: 0, width: 0, height: 0, text: '', author: '', date: '', docName: '', docSize: '' };

  const v = s.match(/<video[^>]+src="([^"]+)"/i);
  if (v) {
    out.kind = 'video';
    out.videoUrl = unescapeHtml(v[1]);
    const d = s.match(/message_video_duration[^>]*>\s*([\d:]+)\s*</i);
    if (d) out.duration = parseDuration(d[1]);
    const aspect = s.match(/tgme_widget_message_video_wrap"\s*style="width:\s*(\d+)px;\s*padding-top:\s*([\d.]+)%"/i);
    if (aspect) {
      out.width = Number(aspect[1]);
      out.height = Math.round(Number(aspect[1]) * Number(aspect[2]) / 100);
    }
    const thumb = s.match(/tgme_widget_message_video_thumb"\s*style="background-image:url\('([^']+)'\)"/i);
    if (thumb) out.cover = unescapeHtml(thumb[1]);
  } else if (/tgme_widget_message_photo_wrap/i.test(s)) {
    out.kind = 'photo';
    const ph = s.match(/tgme_widget_message_photo_wrap[^"]*"[^>]*style="[^"]*url\('([^']+)'\)"/i) || s.match(/background-image:url\('([^']+)'\)/i);
    if (ph) {
      out.photoUrl = unescapeHtml(ph[1]);
      out.cover = out.photoUrl;
    }
  } else if (/tgme_widget_message_document/i.test(s)) {
    out.kind = 'document';
    const nm = s.match(/tgme_widget_message_document_title[^>]*>([\s\S]{0,200}?)<\//i);
    if (nm) out.docName = stripTags(nm[1]);
    const sz = s.match(/tgme_widget_message_document_extra[^>]*>([\s\S]{0,80}?)<\//i);
    if (sz) out.docSize = stripTags(sz[1]);
  } else if (/tgme_widget_message_roundvideo/i.test(s)) {
    out.kind = 'roundvideo';
    const rv = s.match(/<video[^>]+src="([^"]+)"/i);
    if (rv) out.videoUrl = unescapeHtml(rv[1]);
  }

  const txt = s.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (txt) out.text = stripTags(txt[1]);

  const author = s.match(/tgme_widget_message_owner_name[^>]*>([\s\S]{0,200}?)<\/a>/i) || s.match(/tgme_widget_message_from_author[^>]*>([\s\S]{0,200}?)<\/a>/i);
  if (author) out.author = stripTags(author[1]);

  const dt = s.match(/<time[^>]+datetime="([^"]+)"/i);
  if (dt) out.date = dt[1];

  return out;
}

/* 单帖 widget 页:一个帖一个块,直接解析整页 */
function parseEmbedHtml(html) {
  const s = String(html || '');
  const info = parsePostBlock(s);
  const post = (s.match(/data-post="([^"]+)"/) || [])[1] || '';
  info.post = post;
  return info;
}

/* /s/ 列表页:切成一段一段再找目标帖 */
function splitPosts(html) {
  const s = String(html || '');
  const out = [];
  const re = /<div class="tgme_widget_message[^"]*"[^>]*data-post="([^"]+)"[^>]*>/g;
  const marks = [];
  let m;
  while ((m = re.exec(s))) marks.push({ key: m[1], start: m.index });
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].start : s.length;
    out.push({ key: marks[i].key, html: s.slice(marks[i].start, end) });
  }
  return out;
}

/* 频道页的「预览关闭」判定:有 tgme_page 结构、却没有任何消息块 */
function isPreviewOff(html) {
  const s = String(html || '');
  const hasPage = /tgme_page_title|tgme_page_extra/.test(s);
  const hasMsg = /data-post=/.test(s);
  return hasPage && !hasMsg;
}

function channelTitle(html) {
  const m = String(html || '').match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i);
  return m ? unescapeHtml(m[1]) : '';
}

/* ============================================================
 * 五、主入口
 * ============================================================ */

/* 取体积。优先 HEAD(零流量);有的 CDN 对 HEAD 回 405,
   就退回 Range: bytes=0-0,从 content-range 的 "0-0/总长" 里拿。 */
async function headSize(url, opts) {
  try {
    const r = await httpGet(url, Object.assign({}, opts, { method: 'HEAD' }));
    const n = Number(r.headers['content-length'] || 0);
    if (r.status === 200 && n) return n;
  } catch (e) { /* 落到 Range 兜底 */ }
  try {
    const r = await httpGet(url, Object.assign({}, opts, { headers: { Range: 'bytes=0-0' } }));
    const cr = String(r.headers['content-range'] || '');
    const m = cr.match(/\/(\d+)\s*$/);
    if (m) return Number(m[1]);
    return Number(r.headers['content-length'] || 0);
  } catch (e) {
    return 0;
  }
}

function humanSize(bytes) {
  const n = Number(bytes || 0);
  if (!n) return '';
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}

function safeTitle(s, fallback) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return fallback || 'Telegram';
  return t.length > 80 ? t.slice(0, 80) + '…' : t;
}

/* 输入「帖链接 / 分享文案」,输出可直接下载的作品信息。
   返回结构与 alipay-fetch.fetchWork 对齐,渲染层可以复用同一套卡片。 */
async function fetchPost(text, opts) {
  const o = opts || {};
  const tries = [];
  let netFail = 0;
  const link = parseLink(text);

  if (!link) {
    if (looksTelegram(text)) {
      return { ok: false, code: 'no-post', message: '链接里没带帖号(形如 t.me/频道名/123)' , tries };
    }
    return { ok: false, code: 'no-link', message: '没找到 Telegram 链接', tries };
  }
  if (!link.postId) {
    return {
      ok: false,
      code: 'no-post',
      message: '这条链接只指向频道,没有指定具体哪一条(需要形如 t.me/' + link.channel + '/123)',
      channel: link.channel,
      tries,
    };
  }

  const embedUrl = 'https://t.me/' + link.channel + '/' + link.postId + '?embed=1&mode=tme';
  let info = null;

  /* 1) 单帖 widget(最快、最准,一条请求搞定) */
  try {
    const r = await httpGet(embedUrl, o);
    tries.push('widget:' + r.status + '@' + r.via);
    if (r.status === 200) {
      info = parseEmbedHtml(r.text);
      if (!info.kind) {
        // widget 里没媒体:可能纯文字、也可能频道关了预览 —— 交给下面判定
        info = info || {};
      }
    } else {
      tries.push('widget 状态异常:' + r.status);
    }
  } catch (e) {
    netFail += 1;
    tries.push('widget 失败:' + ((e && e.message) || e));
  }

  /* 2) 兜底 + 判定预览开关:/s/ 列表页 */
  let previewOff = false;
  let title = '';
  if (!info || !info.kind) {
    try {
      const r = await httpGet('https://t.me/s/' + link.channel, o);
      tries.push('s页:' + r.status + '@' + r.via);
      title = channelTitle(r.text);
      if (isPreviewOff(r.text)) {
        previewOff = true;
      } else {
        const blocks = splitPosts(r.text);
        const hit = blocks.find((b) => b.key === link.channel + '/' + link.postId);
        if (hit) {
          info = parsePostBlock(hit.html);
          tries.push('s页命中:' + (info.kind || '无媒体'));
        } else if (blocks.length) {
          tries.push('s页未包含该帖(共 ' + blocks.length + ' 条,id ' + (blocks[0].key.split('/')[1]) + '~' + (blocks[blocks.length - 1].key.split('/')[1]) + ')');
        }
      }
    } catch (e) {
      netFail += 1;
      tries.push('s页失败:' + ((e && e.message) || e));
    }
  }

  /* 两条请求都连不上:这不是"解析不了",是网过不去 —— 说清楚,别让人去改代码 */
  if (netFail >= 2 && (!info || !info.kind)) {
    return {
      ok: false,
      code: 'tg_net',
      message: '连不上 Telegram(检查系统代理是否开着;t.me 在国内必须走代理)',
      channel: link.channel,
      postId: link.postId,
      tries,
    };
  }

  if (previewOff) {
    return {
      ok: false,
      code: 'tg_preview_off',
      message: '该频道关闭了网页预览,匿名拿不到内容(需要客户端内保存)',
      channel: link.channel,
      postId: link.postId,
      previewOff: true,
      tries,
    };
  }

  if (!info) return { ok: false, code: 'empty', message: '没取到这条帖的内容', channel: link.channel, postId: link.postId, tries };

  if (info.kind === 'document') {
    return {
      ok: false,
      code: 'tg_document',
      message: '这条是文件附件(' + (info.docName || '未知') + (info.docSize ? ' · ' + info.docSize : '') + '),Telegram 的文件需要账号才能取',
      channel: link.channel,
      postId: link.postId,
      tries,
    };
  }

  if (info.kind === 'photo') {
    if (!info.photoUrl) return { ok: false, code: 'tg_photo_empty', message: '图片地址没解析出来', tries };
    const size = await headSize(info.photoUrl, o);
    return {
      ok: true,
      platform: 'telegram',
      kind: 'photo',
      channel: link.channel,
      postId: link.postId,
      title: safeTitle(info.text || title, link.channel + '/' + link.postId),
      author: info.author || title || link.channel,
      cover: info.photoUrl,
      images: [{ urls: [info.photoUrl], size: size }],
      videoUrls: [],
      qualities: [],
      defaultQuality: '',
      date: info.date,
      finalUrl: 'https://t.me/' + link.channel + '/' + link.postId,
      tries,
    };
  }

  if (info.kind !== 'video' || !info.videoUrl) {
    return {
      ok: false,
      code: 'tg_no_media',
      message: info.text ? '这条是纯文字帖,没有可下载的媒体' : '这条帖里没找到可下载的视频',
      channel: link.channel,
      postId: link.postId,
      text: String(info.text || '').slice(0, 300),
      tries,
    };
  }

  const size = await headSize(info.videoUrl, o);
  tries.push('体积:' + humanSize(size));

  const quality = {
    key: 'source',
    label: '原始文件',
    url: info.videoUrl,
    size: size,
    sizeMB: size ? Number((size / 1024 / 1024).toFixed(1)) : 0,
    sizeText: humanSize(size),
    isHevc: false,
  };

  return {
    ok: true,
    platform: 'telegram',
    kind: 'video',
    channel: link.channel,
    postId: link.postId,
    title: safeTitle(info.text || title, link.channel + '/' + link.postId),
    author: info.author || title || link.channel,
    cover: info.cover,
    duration: info.duration,
    width: info.width,
    height: info.height,
    date: info.date,
    qualities: [quality],
    videoUrls: [info.videoUrl],
    defaultQuality: 'source',
    finalUrl: 'https://t.me/' + link.channel + '/' + link.postId,
    tries,
  };
}

/* ============================================================
 * 六、下载(必须自己走代理,不能复用 downloadStream)
 * ============================================================ */

/* 下载到 dest。onProgress({received,total}) 每 ~512KB 回调一次。
   返回 { ok, bytes } 或 { ok:false, message }
   · 停滞检测:25 秒没新字节就主动断链 —— CDN 节点抽风时会「连上但极慢」,
     不掐断的话用户会看着进度条冻住几分钟。
   · 慢节点换一次:第一次若 30 秒总量还不到 100KB/s,判定这台的边缘节点不行,
     断掉换节点重试;第二次【不限速】,慢网络照样能下完。
     实测同一 URL 不同节点能差 60 倍(3.9s vs 229s),不是玄学。 */
async function downloadTo(url, dest, opts) {
  const o = opts || {};
  const attempts = Math.max(1, Number(o.retries || 2));
  let lastErr = '';
  for (let i = 0; i < attempts; i += 1) {
    const r = await downloadOnce(url, dest, Object.assign({}, o, { slowGuard: i === 0 }));
    if (r.ok) {
      if (i > 0) r.retried = i;
      return r;
    }
    lastErr = r.message || '下载失败';
    if (r.fatal) return { ok: false, message: lastErr };
    try { fs.unlinkSync(dest); } catch (e) { /* ignore */ }
  }
  return { ok: false, message: lastErr };
}

async function downloadOnce(url, dest, opts) {
  const o = opts || {};
  const timeout = o.timeout || 60000;
  const startedAt = Date.now();
  let res = null;
  try {
    res = await httpGet(url, Object.assign({}, o, {
      stream: true,
      timeout: timeout,
      headers: Object.assign({ Referer: 'https://t.me/', Accept: '*/*' }, o.headers || {}),
    }));
  } catch (e) {
    return { ok: false, message: '连接失败:' + ((e && e.message) || e) };
  }

  const ctype = String(res.headers['content-type'] || '');
  if (res.status !== 200 && res.status !== 206) {
    try { res.close(); } catch (e) { /* ignore */ }
    return { ok: false, message: 'HTTP ' + res.status + (ctype ? ' (' + ctype + ')' : ''), fatal: true };
  }
  if (/text\/html|application\/json|text\/xml/i.test(ctype)) {
    try { res.close(); } catch (e) { /* ignore */ }
    return { ok: false, message: '返回的不是视频文件(链接可能已过期):' + ctype, fatal: true };
  }

  const total = Number(res.headers['content-length'] || 0);
  let received = 0;
  let lastSent = 0;
  let lastBytesAt = Date.now();
  let stalled = false;
  const fd = fs.createWriteStream(dest);
  let fdErr = null;
  fd.on('error', (e) => { fdErr = e; });

  /* 只在真的背压时挂一次 drain,挂上就摘,避免几千次写入攒出监听泄漏 */
  const write = (buf) => new Promise((resolve, reject) => {
    if (fdErr) { reject(fdErr); return; }
    if (fd.write(buf)) { resolve(); return; }
    const onDrain = () => { fd.removeListener('error', onErr); resolve(); };
    const onErr = (e) => { fd.removeListener('drain', onDrain); reject(e); };
    fd.once('drain', onDrain);
    fd.once('error', onErr);
  });

  const stallTimer = setInterval(() => {
    if (Date.now() - lastBytesAt > 25000) {
      stalled = 'stall';
      try { res.close(); } catch (e) { /* ignore */ }
      return;
    }
    /* 慢节点判定:只在第一次尝试时做,且必须「既慢又没下完」才算 */
    if (o.slowGuard) {
      const elapsed = Date.now() - startedAt;
      const rate = received / Math.max(1, elapsed / 1000);
      if (elapsed > 30000 && rate < 100 * 1024 && (!total || received < total * 0.9)) {
        stalled = 'slow';
        try { res.close(); } catch (e) { /* ignore */ }
      }
    }
  }, 5000);

  try {
    const tick = async (buf, got) => {
      await write(buf);
      received = got;
      lastBytesAt = Date.now();
      if (received - lastSent > 512 * 1024) {
        lastSent = received;
        if (o.onProgress) o.onProgress({ received: received, total: total });
      }
    };
    if (/chunked/i.test(res.headers['transfer-encoding'] || '')) {
      await res.reader.readChunked(tick);
    } else if (total) {
      await res.reader.readFixed(total, tick);
    } else {
      // 既没 length 也不是 chunked:读到断开为止
      const all = await res.reader.readAll(2 * 1024 * 1024 * 1024);
      await write(all);
      received = all.length;
    }
    await new Promise((resolve) => fd.end(resolve));
    if (o.onProgress) o.onProgress({ received: received, total: total || received });
    return { ok: true, bytes: received };
  } catch (e) {
    try { fd.destroy(); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(dest); } catch (_) { /* ignore */ }
    const msg = stalled === 'slow'
      ? '当前节点太慢(' + Math.round(received / 1024) + 'KB/' + Math.round((Date.now() - startedAt) / 1000) + 's)'
      : stalled === 'stall'
        ? '下载停滞(25 秒无数据,CDN 节点没给数据)'
        : ((e && e.message) || String(e));
    return { ok: false, message: msg };
  } finally {
    clearInterval(stallTimer);
    try { res.close(); } catch (e) { /* ignore */ }
  }
}

/* 自检:列出当前解析出的代理与一次连通性测试 */
async function diagnose(opts) {
  const proxy = resolveProxy(opts || {});
  const out = { proxy: proxy ? proxy.host + ':' + proxy.port : '(无,将直连)', tests: [] };
  for (const u of ['https://t.me/', 'https://telesco.pe/']) {
    try {
      const r = await httpGet(u, Object.assign({}, opts, { timeout: 12000 }));
      out.tests.push({ url: u, status: r.status, via: r.via, bytes: r.bytes });
    } catch (e) {
      out.tests.push({ url: u, error: (e && e.message) || String(e) });
    }
  }
  return out;
}

module.exports = {
  UA,
  normProxy,
  resolveProxy,
  systemProxy,
  envProxy,
  parseLink,
  looksTelegram,
  parsePostBlock,
  parseEmbedHtml,
  splitPosts,
  isPreviewOff,
  humanSize,
  httpGet,
  httpRequest,
  connectTunnel,
  fetchPost,
  downloadTo,
  diagnose,
};
