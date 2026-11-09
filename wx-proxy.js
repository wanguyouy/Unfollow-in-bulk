'use strict';
/* ============================================================
 * 微信视频号捕获代理(实验版 · 不解密)
 * 原理:
 *   本地 HTTP 代理(127.0.0.1:8899)接收系统代理转来的 CONNECT;
 *   仅对视频 CDN 域名(*.video.weixin.qq.com / stodownload* /
 *   finder.video.qq.com)做 TLS 中间人(本地自签 CA),
 *   其余域名(含微信登录、mmtls 私有协议)全部原样隧道直通;
 *   命中的视频响应原文落盘保存(不做任何解密),
 *   用于验证"未加密视频能否直接保存播放"。
 * 注意:
 *   1) 所有用到的模块必须显式 require(上次教训:漏 require('tls')
 *      导致运行时崩溃);
 *   2) 所有回调内部自行兜错,绝不向外抛异常拖垮主进程。
 * ============================================================ */
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
let forge = null;
try { forge = require('node-forge'); } catch (e) { forge = null; }

/* Service Worker 会从 CacheStorage 直接吐出旧 JS,连加了 ?t= 的 cache-bust URL
   都可能被它拦下。注入页面时顺手注销本域 SW,保证 SPA bundle 真的走网络。 */
const WXV_SW_JS = `(function(){try{if(navigator.serviceWorker&&navigator.serviceWorker.getRegistrations){navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){try{r.unregister();}catch(e){}});}).catch(function(){});}}catch(e){}})();`;

/* ------------------------------------------------------------------
 * 解密 worker 的 seed 上报(拿 decodeKey 的第三条通路,也是目前最可靠的一条)
 *
 * 视频号页面是本地 LiteApp 包,HTML / SPA bundle / feed CGI 都不一定经过代理,
 * 但播放器播放任何加密视频都必须加载 res.wx.qq.com 的 worker_release.js。
 * 主线程通过 postMessage 发 CUT 消息:
 *   { cmd:'CUT', url:<当前视频直链>, seed:<decodeKey>, contentLen:<真实长度> }
 * worker 里随后执行 new Module.WxIsaac64(seed).generate(131072)。
 * 所以只要包装 self.onmessage(p === self),就能同时拿到 key 与它所属的视频 URL,
 * 完全不需要 feed 数据,也不存在跨视频复用 key 的问题。
 * ------------------------------------------------------------------ */
const WXV_WORKER_HOOK = `
;!function(){
  function report(d){
    try{
      if(!d || typeof d !== 'object') return;
      var seed = d.seed, url = d.url;
      if(seed === undefined || seed === null || seed === '' || !url) return;
      var body = JSON.stringify({ seed: seed, url: String(url), contentLen: Number(d.contentLen) || 0 });
      // text/plain 是 CORS simple request:worker 若不是 res.wx.qq.com 同源也不会
      // 先发 OPTIONS 预检(代理只认 POST/GET,预检漏到真实网络就永远拿不到 key)。
      // keepalive 保证 worker 被快速销毁时请求仍发出去。
      var post = fetch('https://res.wx.qq.com/wxv-notify', {
        method: 'POST', mode: 'cors', credentials: 'omit', keepalive: true,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: body
      });
      post.catch(function(){
        return fetch('https://res.wx.qq.com/wxv-notify?d=' + encodeURIComponent(body),
          { method: 'GET', mode: 'cors', credentials: 'omit', keepalive: true });
      }).catch(function(){});
    }catch(e){}
  }
  try{
    var __wxv_orig = self.onmessage;
    if(typeof __wxv_orig === 'function'){
      self.onmessage = function(ev){
        try{ report(ev && ev.data); }catch(e){}
        return __wxv_orig.call(this, ev);
      };
    }
  }catch(e){}
}();
`;

/* 注入到视频号页面的脚本:定义 WXU 事件桥,把 feed(含视频直链+decodeKey)回传给代理 */
const WXV_FEED_JS = `(function () {
  if (window.__wxv_installed) return;
  window.__wxv_installed = true;
  function feedToItem(feed) {
    try {
      if (!feed || !feed.objectDesc) return null;
      var mediaList = feed.objectDesc.media || [];
      var media = mediaList[0];
      if (!media || !media.url) return null;
      return {
        id: String(feed.id || feed.objectNonceId || ('f' + (media.decodeKey || '') + '#' + String(feed.objectDesc.description || '').slice(0, 20))),
        title: String(feed.objectDesc.description || '').slice(0, 100),
        nickname: (feed.contact && feed.contact.nickname) || '',
        url: (media.url || '') + (media.urlToken || ''),
        key: media.decodeKey,
        size: media.fileSize || 0,
        duration: media.videoPlayLen || 0,
        ts: Date.now(),
      };
    } catch (e) { return null; }
  }
  function send(items) {
    try {
      fetch('/wxv-notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feeds: items }) }).catch(function () {});
    } catch (e) {}
  }
  function handle(type, data) {
    try {
      if (!data) return;
      if (type === 'channels:OnFeedProfileLoaded' || type === 'channels:GotoNextFeed' || type === 'channels:GotoPrevFeed' || type === 'channels:HomeFeedChanged') {
        var it = feedToItem(data);
        if (it) send([it]);
      } else if (type === 'channels:PCFlowLoaded' || type === 'channels:RecommendFeedsLoaded' || type === 'channels:PreloadFeeds') {
        var list = Array.isArray(data) ? data : (data && data.feeds) || (data && data.object) || null;
        if (!Array.isArray(list)) return;
        var items = [];
        for (var i = 0; i < list.length && i < 30; i++) {
          var it2 = feedToItem(list[i]);
          if (it2) items.push(it2);
        }
        if (items.length) send(items);
      }
    } catch (e) {}
  }
  window.WXU = window.WXU || {};
  window.WXU.emit = function (type, data) {
    setTimeout(function () { handle(type, data); }, 0);
  };
  console.log('[wxv] feed hook installed');
})();`;

/* res.wx.qq.com SPA JS 改写正则(移植自 ltaoo/wx_channels_download) */
const WXV_REWRITE = true; // 已离线验证:51/51 bundle 语法通过
const WX_JS_RES = {
  dep: /"js\/([^"]{1,})\.js"/g,
  from: /from ?"([^"]{1,})\.js"/g,
  lazyImport: /import\("([^"]{1,})\.js"\)/g,
  import: /import ?"([^"]{1,})\.js"/g,
  feedProfile: /async finderGetCommentDetail\((\w+)\)\{([\s\S]*?)\}async/,
  pcFlow: /async finderPcFlow\((\w+)\)\{([\s\S]*?)\}async/,
  recommend: /async finderGetRecommend\((\w+)\)\{([\s\S]*?)\}async/,
  preload: / ([a-zA-Z_$][a-zA-Z0-9_$]*\.invoke\([a-zA-Z_$][a-zA-Z0-9_$]*\));\(/,
  flowTab: /flowTab:([a-zA-Z_$][a-zA-Z0-9_$]*)/,
  goNext: /goToNextFlowFeed:([a-zA-Z_$][a-zA-Z0-9_$]*)/,
  goPrev: /goToPrevFlowFeed:([a-zA-Z_$][a-zA-Z0-9_$]*)/,
};

/* 需要拦截(能看到内容)的视频 CDN 域名 */
function isInterceptHost(host) {
  const h = String(host || '').toLowerCase().split(':')[0];
  if (!h) return false;
  return (
    /(^|\.)video\.weixin\.qq\.com$/.test(h) ||
    /(^|\.)finder\.video\.qq\.com$/.test(h) ||
    /(^|\.)[\w-]+\.video\.qq\.com$/.test(h) ||
    /(^|\.)video\.qq\.com$/.test(h) ||
    /(^|\.)mpvideo\.qpic\.cn$/.test(h) ||
    isApiHost(h) ||
    isObserveHost(h) ||
    /stodownload/.test(h)
  );
}

/* 页面/API 域名:需要缓存穿透 + HTML/JS 改写。
   pf=lite 说明当前微信视频号跑的是 LiteApp,页面资源走 liteapp.weixin.qq.com;
   之前只拦截 channels/res 两个域名,该域名的 CONNECT 被直接放行,
   所以本轮日志里 HTML注入/JS改写/Feed 全是 0。 */
function isApiHost(host) {
  const h = String(host || '').toLowerCase().split(':')[0];
  return (
    h === 'channels.weixin.qq.com' ||
    h === 'res.wx.qq.com' ||
    h === 'liteapp.weixin.qq.com'
  );
}

/* 只观察(落盘 + 搜索 decodeKey)、不做改写的域名。
   放宽到这里是为了「看见」feed CGI 到底从哪个域名走:
   日志里 channels 只出现 report-perf,说明真实 feed 请求可能在别的域。
   不改写是为了避免破坏公众号/小程序页面。 */
function isObserveHost(host) {
  const h = String(host || '').toLowerCase().split(':')[0];
  return (
    h === 'mp.weixin.qq.com' ||
    h === 'wxapp.tc.qq.com' ||
    h === 'finder.weixin.qq.com' ||
    h === 'weixin.qq.com'
  );
}

/* 允许注入 feed 桥的页面域名(必须严格,避免改写公众号/小程序页面) */
function isPageHost(host) {
  const h = String(host || '').toLowerCase().split(':')[0];
  return h === 'channels.weixin.qq.com' || h === 'liteapp.weixin.qq.com';
}

/* 响应/URL 看起来像视频流才落盘,其余正常转发 */
function looksMedia(url, contentType) {
  const u = String(url || '');
  const c = String(contentType || '');
  if (/^image\//i.test(c)) return false; // 封面图等,不落盘
  if (/stodownload/i.test(u)) return true;
  if (/video\/|mp4|mpegurl|octet-stream/i.test(c)) return true;
  if (/\.(mp4|m3u8|ts)(\?|$)/i.test(u)) return true;
  return false;
}

/* 从 feed CGI 的 JSON 响应里直接挖出 (decodeKey, url, fileSize, 标题)。
   页面注入链路依赖 HTML 被改写,但 WebView 预热 / 长连接时 HTML 根本不重新请求;
   feed API 每次切换视频都会发,是更可靠的入口。常见结构:
   {data:{object:[{objectDesc:{description,media:[{url,urlToken,decodeKey,fileSize}]}}]}}
   也可能是被转义成字符串再嵌一层的 data,所以做递归 + 内嵌 JSON 解析。 */
function extractFeedsFromApi(text) {
  const out = [];
  const seen = Object.create(null);
  function push(media, desc) {
    if (!media || typeof media !== 'object') return;
    let key = media.decodeKey;
    if (key === undefined || key === null) key = media.decode_key;
    if (key === undefined || key === null || key === '') return;
    let url = String(media.url || media.playUrl || '');
    if (!url) return;
    if (media.urlToken) url += String(media.urlToken);
    url = url.replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
    if (!/^https?:\/\//i.test(url)) return;
    const size = Number(media.fileSize || media.file_size || media.videoSize || 0) || 0;
    const id = 'api-' + key + '-' + size;
    if (seen[id]) return;
    seen[id] = 1;
    out.push({
      id: id,
      title: String(desc || '').slice(0, 100),
      nickname: '',
      url: url,
      key: key,
      size: size,
      duration: Number(media.videoPlayLen || 0) || 0,
      ts: Date.now(),
      source: 'api',
    });
  }
  function walk(node, desc, depth) {
    if (node == null || depth > 32) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && i < 200; i++) walk(node[i], desc, depth + 1);
      return;
    }
    if (typeof node === 'string') {
      const t = node.trim();
      if (t.length > 40 && t.indexOf('decodeKey') >= 0 && (t.charAt(0) === '{' || t.charAt(0) === '[')) {
        try { walk(JSON.parse(t), desc, depth + 1); } catch (e) { /* ignore */ }
      }
      return;
    }
    if (typeof node !== 'object') return;
    const d = node.description || node.desc ||
              (node.objectDesc && node.objectDesc.description);
    const nextDesc = (typeof d === 'string' && d.trim()) ? d : desc;
    if (node.decodeKey !== undefined || node.decode_key !== undefined) push(node, nextDesc);
    const ml = Array.isArray(node.media) ? node.media
             : (node.objectDesc && Array.isArray(node.objectDesc.media) ? node.objectDesc.media : null);
    if (ml) for (let j = 0; j < ml.length; j++) push(ml[j], nextDesc);
    const keys = Object.keys(node);
    for (let k = 0; k < keys.length; k++) {
      if (keys[k] === 'media') continue;
      walk(node[keys[k]], nextDesc, depth + 1);
    }
  }
  let root = null;
  try { root = JSON.parse(String(text)); } catch (e) { root = null; }
  if (root) walk(root, '', 0);
  if (out.length) return out;
  // 兜底:外层不是标准 JSON 时,按 decodeKey 附近窗口取值。
  // 窗口里必须同时有 URL 和 fileSize 才采信,避免拿错 key 解出乱码。
  const re = /"decodeKey"\s*:\s*"?(\d+)"?/g;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    const seg = String(text).slice(Math.max(0, m.index - 4000), m.index + 4000);
    const um = /"url"\s*:\s*"([^"]{20,})"/.exec(seg);
    const sm = /"fileSize"\s*:\s*"?(\d+)"?/.exec(seg);
    const dm = /"description"\s*:\s*"([^"\\]{1,120})"/.exec(seg);
    if (!um || !sm) continue;
    let u = um[1].replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
    if (u.indexOf('//') === 0) u = 'https:' + u;
    push({ decodeKey: m[1], url: u, fileSize: sm[1] }, dm ? dm[1] : '');
    if (out.length && out[out.length - 1].source === 'api') out[out.length - 1].source = 'api-regex';
  }
  return out;
}

/* 首次生成并持久化本地根证书(LocalCapture Root CA 2) */
function ensureCA(dataDir, log) {
  if (!forge) throw new Error('node-forge 未安装,无法生成捕获证书');
  const dir = path.join(dataDir, 'wx-ca');
  fs.mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, 'ca.key');
  const crtPath = path.join(dir, 'ca.crt');
  if (fs.existsSync(keyPath) && fs.existsSync(crtPath)) {
    return {
      keyPem: fs.readFileSync(keyPath, 'utf8'),
      certPem: fs.readFileSync(crtPath, 'utf8'),
      certPath: crtPath,
    };
  }
  if (log) log('[证书] 首次运行,生成新的本地根证书…');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + crypto.randomBytes(8).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
  const attrs = [
    { name: 'commonName', value: 'LocalCapture Root CA 2' },
    { name: 'organizationName', value: 'LocalCapture' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);
  fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
  fs.writeFileSync(crtPath, certPem);
  return { keyPem, certPem, certPath: crtPath };
}

/* 每个域名一张叶子证书(共享一把叶子私钥,缓存 SecureContext) */
function createLeafFactory(ca) {
  const cache = new Map();
  const leafKeys = forge.pki.rsa.generateKeyPair(2048);
  const leafKeyPem = forge.pki.privateKeyToPem(leafKeys.privateKey);
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
  return function leafFor(servername) {
    const host = String(servername || '').toLowerCase();
    if (cache.has(host)) return cache.get(host);
    const cert = forge.pki.createCertificate();
    cert.publicKey = leafKeys.publicKey;
    cert.serialNumber = '02' + crypto.randomBytes(8).toString('hex');
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 2 * 365 * 24 * 3600 * 1000);
    cert.setSubject([{ name: 'commonName', value: host }]);
    cert.setIssuer(caCert.subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: host }] },
    ]);
    cert.sign(caKey, forge.md.sha256.create());
    const ctx = tls.createSecureContext({ key: leafKeyPem, cert: forge.pki.certificateToPem(cert) });
    cache.set(host, ctx);
    return ctx;
  };
}

function createProxy(opts) {
  const options = opts || {};
  // 允许 port:0 由系统分配空闲端口(测试用),生产固定 8899。
  const port = options.port === 0 ? 0 : (options.port || 8899);
  const dataDir = options.dataDir || process.cwd();
  const version = String(options.version || Date.now());
  const log = options.onLog || function () {};
  const emitter = new EventEmitter();
  const state = { server: null, httpsServer: null, running: false, ca: null, captures: [] };

  function captureDir() {
    const d = path.join(dataDir, 'wx-captures');
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
    return d;
  }

  function apiDir() {
    const d = path.join(dataDir, 'wx-api');
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
    return d;
  }

  let api_seq = 0;
  /* 拦截到的 API/页面响应:落盘并搜索 decodeKey */
  /* 页面域名的所有响应一律 no-store。
     只剥离缓存依据,不动 content-length / content-type / content-range,
     否则 body 长度会与头不一致。bufferRewrite 内部已做同样处理,这里覆盖
     「未被改写的 JS / CSS / API」——它们下次也必须重新联网,而不是命中磁盘缓存。 */
  function noStoreHeaders(src) {
    const h = Object.assign({}, src || {});
    ['cache-control', 'etag', 'last-modified', 'expires', 'age', 'pragma',
     'x-cache', 'x-cache-lookup', 'via', 's-maxage'].forEach(function (k) { delete h[k]; });
    h['cache-control'] = 'no-store, no-cache, must-revalidate, max-age=0';
    h['pragma'] = 'no-cache';
    h['expires'] = '0';
    return h;
  }

  function teeApiResponse(hostname, clientReq, upRes) {
    try {
      const seq = ++api_seq;
      const ext = /json/i.test(String(upRes.headers['content-type'] || '')) ? 'json' : 'txt';
      const fname = 'api-' + seq + '-' + hostname + (clientReq.url || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + '.' + ext;
      const savedPath = path.join(apiDir(), fname);
      const tee = fs.createWriteStream(savedPath);
      let got = 0;
      upRes.on('data', function (c) {
        got += c.length;
        if (got <= 8 * 1024 * 1024) tee.write(c);
      });
      upRes.on('end', function () {
        tee.end();
        const url = 'https://' + hostname + (clientReq.url || '');
        log('[API响应] ' + hostname + clientReq.url + ' ' + got + 'B -> ' + fname);
        // tee.end() 是异步的,必须等 close(fd 释放)再读,否则会读到半截内容
        const analyze = function () {
        fs.readFile(savedPath, 'utf8', function (err, text) {
          if (err || !text) return;
          // 关键:不依赖页面注入,feed CGI 里带 decodeKey 的响应直接转成 feed 上报
          let items = [];
          try { items = extractFeedsFromApi(text); } catch (e) { log('[Feed提取异常] ' + ((e && e.message) || e)); }
          if (items.length) {
            for (let i = 0; i < items.length; i++) {
              try { emitter.emit('feed', items[i]); } catch (e) { /* ignore */ }
            }
            log('[Feed/API] ' + hostname + ' 提取 ' + items.length + ' 条 (key=' +
                items.slice(0, 4).map(function (x) { return x.key; }).join(',') + ')');
            return;
          }
          const idx = text.indexOf('decodeKey');
          if (idx >= 0) {
            const ctxs = [];
            let from = 0;
            for (let k = 0; k < 3; k++) {
              const p = text.indexOf('decodeKey', from);
              if (p < 0) break;
              ctxs.push(text.slice(Math.max(0, p - 120), p + 200));
              from = p + 10;
            }
            // 走到这里说明响应里确实有 decodeKey 但没解析出完整媒体项,留线索给下一轮排查
            log('[decodeKey命中/未解析] ' + url + ' :: ' + ctxs.join(' || '));
          }
        });
        };
        if (tee.closed) analyze();
        else tee.once('close', analyze);
      });
      tee.on('error', function () { /* ignore */ });
      // 这里原本还有 upRes.pipe(tee):与上面的手动 tee.write 叠加会把同一份
      // body 写两遍(日志 53B 的响应落盘成 106B),JSON.parse 直接失败。已移除。
    } catch (e) { log('[API tee 异常] ' + ((e && e.message) || e)); }
  }

  /* 缓冲整个响应体后改写再返回(HTML/JS 用)
     关键:改写过的 HTML/JS 绝不能让浏览器缓存。原实现原样透传上游的
     cache-control/etag/last-modified,导致第二次打开视频号直接命中缓存,
     页面不再经过改写 → [HTML注入] 恒为 0 → 拿不到 decodeKey。 */
  function bufferRewrite(upRes, clientRes, transform, tag) {
    // 304/204 没有 body:不能把一个空响应改写成一页只有 <script> 的 HTML(会白屏)
    const status = upRes.statusCode || 200;
    if (status === 304 || status === 204) {
      const h304 = Object.assign({}, upRes.headers);
      delete h304['content-length'];
      delete h304['transfer-encoding'];
      try { clientRes.writeHead(status, h304); clientRes.end(); }
      catch (e) { try { clientRes.destroy(); } catch (e2) { /* ignore */ } }
      return;
    }
    const chunks = [];
    let total = 0;
    let overflow = false;
    upRes.on('data', function (c) {
      total += c.length;
      if (total > 16 * 1024 * 1024) overflow = true;
      if (!overflow) chunks.push(c);
    });
    upRes.on('end', function () {
      try {
        const raw = Buffer.concat(chunks);
        const headers = Object.assign({}, upRes.headers);
        delete headers['content-encoding'];
        delete headers['transfer-encoding'];
        delete headers['content-security-policy'];
        delete headers['content-security-policy-report-only'];
        // 剥离一切缓存依据,让每次打开视频号都重新拉 HTML/JS 并重新注入桥脚本
        ['cache-control', 'etag', 'last-modified', 'expires', 'age', 'pragma',
         'x-cache', 'x-cache-lookup', 'via', 's-maxage'].forEach(function (k) { delete headers[k]; });
        headers['cache-control'] = 'no-store, no-cache, must-revalidate, max-age=0';
        headers['pragma'] = 'no-cache';
        headers['expires'] = '0';
        let body = raw;
        // 被改写的 HTML/JS 不经过 teeApiResponse,以前完全没被扫过。
        // 首屏 feed 常 SSR 内嵌在 HTML 的 __INITIAL_STATE__ 里,这里补一次提取。
        if (!overflow) {
          try {
            const items = extractFeedsFromApi(raw.toString('utf8'));
            if (items.length) {
              for (let i = 0; i < items.length; i++) {
                try { emitter.emit('feed', items[i]); } catch (e2) { /* ignore */ }
              }
              log('[Feed/' + tag.toUpperCase() + '] 页面内嵌 feed ' + items.length + ' 条');
            }
          } catch (e) { /* ignore */ }
          if (tag === 'html') {
            try {
              const p = path.join(apiDir(), 'doc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.html');
              fs.writeFile(p, raw, function () {});
            } catch (e) { /* ignore */ }
          }
        }
        if (!overflow && transform) {
          try { body = transform(raw); } catch (e) { log('[重写失败/' + tag + '] ' + ((e && e.message) || e)); body = raw; }
        }
        headers['content-length'] = String(body.length);
        clientRes.writeHead(status, headers);
        clientRes.end(body);
      } catch (e) {
        log('[重写异常/' + tag + '] ' + ((e && e.message) || e));
        try { clientRes.destroy(); } catch (e2) { /* ignore */ }
      }
    });
    upRes.on('error', function () { try { clientRes.destroy(); } catch (e2) { /* ignore */ } });
  }

  /* 视频号页面 HTML:注入 feed 桥脚本 + 剥离 CSP + 缓存穿透 */
  function rewriteChannelsHtml(bodyBuf) {
    let html = bodyBuf.toString('utf8');
    const v = '?t=' + version;
    html = html.replace(/src="([^"]{1,})\.js"/g, 'src="$1.js' + v + '"');
    html = html.replace(/href="([^"]{1,})\.js"/g, 'href="$1.js' + v + '"');
    const inject = '<script>' + WXV_SW_JS + '</script><script>' + WXV_FEED_JS + '</script>';
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, function (m) { return m + inject; });
    } else {
      html = inject + html;
    }
    log('[HTML注入] 视频号页面已注入 feed 桥(' + html.length + 'B)');
    return Buffer.from(html, 'utf8');
  }

  /* 解密 worker:不要跑 SPA 正则(它是 Emscripten worker,改写只会引入风险),
     只在外层 IIFE 结束前插一段 onmessage 包装,把 CUT 消息的 seed 上报回来。 */
  function rewriteDecryptWorker(bodyBuf) {
    const js = bodyBuf.toString('utf8');
    // 直接把 hook 作为独立脚本追加到文件末尾,而不是往原 IIFE 内部塞代码:
    //  1) 不依赖 '})();' 这种脆弱的压缩格式,微信改版后不会突然注入失败;
    //  2) 不会落进 IIFE 里某条 return 之后变成死代码;
    //  3) worker 脚本是同步执行完才处理 message,此时 p.onmessage 已赋值,
    //     包装仍然赶在第一条 CUT 消息之前。
    const out = js.replace(/\s*$/, '') + '\n;\n' + WXV_WORKER_HOOK + '\n';
    log('[Worker注入] 已挂 seed 上报(' + out.length + 'B, 文件末尾追加)');
    return Buffer.from(out, 'utf8');
  }

  /* 视频号 SPA JS:缓存穿透 + 暴露 feed 数据 */
  function rewriteWxJs(bodyBuf, pathname) {
    let js = bodyBuf.toString('utf8');
    const v = '?t=' + version;
    let wraps = 0;
    js = js.replace(WX_JS_RES.dep, '"js/$1.js' + v + '"');
    js = js.replace(WX_JS_RES.from, 'from"$1.js' + v + '"');
    js = js.replace(WX_JS_RES.lazyImport, 'import("$1.js' + v + '")');
    js = js.replace(WX_JS_RES.import, 'import"$1.js' + v + '"');
    js = js.replace(WX_JS_RES.feedProfile, function (m, a, b) {
      wraps += 1;
      return 'async finderGetCommentDetail(' + a + ') { var result = await (async () => { ' + b + ' })(); var __f = (result && result.data) ? result.data.object : null; try { typeof WXU !== "undefined" && WXU.emit("channels:OnFeedProfileLoaded", __f); } catch (e) {} return result; }async';
    });
    js = js.replace(WX_JS_RES.pcFlow, function (m, a, b) {
      wraps += 1;
      return 'async finderPcFlow(' + a + ') { var result = await (async () => { ' + b + ' })(); var __fs = (result && result.data) ? result.data.object : null; try { typeof WXU !== "undefined" && WXU.emit("channels:PCFlowLoaded", __fs); } catch (e) {} return result; }async';
    });
    js = js.replace(WX_JS_RES.recommend, function (m, a, b) {
      wraps += 1;
      return 'async finderGetRecommend(' + a + ') { var result = await (async () => { ' + b + ' })(); var __fs = (result && result.data) ? result.data.object : null; try { typeof WXU !== "undefined" && WXU.emit("channels:RecommendFeedsLoaded", __fs); } catch (e) {} return result; }async';
    });
    js = js.replace(WX_JS_RES.preload, function (m, expr) {
      wraps += 1;
      return ' (async()=>{ const _r = await ' + expr + '; try { typeof WXU !== "undefined" && WXU.emit("channels:PreloadFeeds", _r && _r.data ? _r.data.object : null); } catch (e) {} return _r; })();(';
    });
    // 注:goToNextFlowFeed/goToPrevFlowFeed 的改写在新版 SPA 中会命中解构赋值
    // (const {goToNextFlowFeed:o} = ...)导致语法错误白屏,已移除;
    // 首页 feed 由 PreloadFeeds/PCFlowLoaded/RecommendFeedsLoaded 覆盖。
    log('[JS改写] ' + String(pathname || '').slice(0, 90) + ' 方法包装=' + wraps);
    return Buffer.from(js, 'utf8');
  }

  /* worker 上报的 feed 用稳定 id 去重:同一视频重播时覆盖而不是堆积 */
  function workerFeedKey(rawUrl) {
    try {
      const u = new URL(String(rawUrl));
      const k = u.searchParams.get('encfilekey');
      if (k) return k.slice(0, 80);
      return crypto.createHash('md5').update(u.origin + u.pathname).digest('hex');
    } catch (e) {
      return crypto.createHash('md5').update(String(rawUrl)).digest('hex');
    }
  }

  /* 页面 feed 桥 + 解密 worker 回传 */
  function handleNotify(bodyBuf) {
    try {
      const payload = JSON.parse(bodyBuf.toString('utf8'));
      if (!payload || typeof payload !== 'object') return;
      // 解密 worker 的 CUT 消息:seed 就是 decodeKey,url 是它正在解密的那个视频。
      // 必须同时具备 url + seed 才采信,保证 key 只属于这个视频,不跨视频复用。
      if (payload.seed !== undefined && payload.seed !== null && payload.seed !== '') {
        const rawUrl = String(payload.url || '');
        if (!/^https?:\/\//i.test(rawUrl)) return;
        const item = {
          id: 'wk:' + workerFeedKey(rawUrl),
          url: rawUrl,
          key: String(payload.seed),
          size: Number(payload.contentLen) || 0,
          title: '',
          nickname: '',
          duration: 0,
          ts: Date.now(),
          source: 'decrypt-worker',
        };
        log('[WorkerKey] seed=' + item.key + ' contentLen=' + item.size + ' url=' + rawUrl.slice(0, 160));
        try { emitter.emit('feed', item); } catch (e) { /* ignore */ }
        return;
      }
      const feeds = payload.feeds || [];
      for (const it of feeds) {
        if (!it || !it.url || it.key === undefined || it.key === null) continue;
        try { emitter.emit('feed', it); } catch (e) { /* ignore */ }
      }
    } catch (e) { log('[notify 解析失败] ' + ((e && e.message) || e)); }
  }

  function recordCapture(info) {
    state.captures.unshift(info);
    if (state.captures.length > 50) state.captures.length = 50;
    try { emitter.emit('capture', info); } catch (e) { /* ignore */ }
  }

  /* HTTP chunked 解码:把上游分帧的 body 还原成连续字节流 */
  function makeChunkedDecoder(onData) {
    let buf = Buffer.alloc(0);
    let state = 'size';
    let need = 0;
    let ended = false;
    return function (chunk) {
      if (ended || !chunk.length) return;
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        if (state === 'size') {
          const i = buf.indexOf('\r\n');
          if (i < 0) return;
          const line = buf.slice(0, i).toString('latin1');
          buf = buf.slice(i + 2);
          const semi = line.indexOf(';');
          const n = parseInt((semi < 0 ? line : line.slice(0, semi)).trim(), 16);
          if (!Number.isFinite(n) || n < 0) { ended = true; return; }
          if (n === 0) { ended = true; return; } // 忽略 trailer,视频响应没有
          need = n;
          state = 'data';
        } else {
          if (buf.length < need + 2) return;
          onData(buf.slice(0, need));
          buf = buf.slice(need + 2); // 跳过帧尾 \r\n
          state = 'size';
        }
      }
    };
  }

  /* ------------------------------------------------------------
   * 视频 CDN 专用转发:绕开 Node 的 HTTP client parser,用裸 TLS 搬运。
   *
   * 实测结论(2026-11-09):
   *   - 直连 finder.video.qq.com,同一条真实 URL + 真实请求头,严格 parser
   *     完整读完 1,468,945B 无任何错误;带 Range 的 206 也完整读完;
   *   - 裸 TLS 看到的上游响应头完全标准(HTTP/1.1 200 OK / CONTENT-LENGTH
   *     / Content-Type: video/mp4 / Content-Range ...);
   *   - 但经本代理转发时稳定抛 HPE_INVALID_CONSTANT "Expected HTTP/",
   *     且 rawPacket 恰好就是那段合法响应头 => 故障在代理内的 client parser,
   *     不在上游。继续调 header / agent / 宽松 parser 都只是碰运气。
   *
   * 这里自己解析状态行与响应头,按 Content-Length 精确搬运 body,同时 tee
   * 落盘;下游仍用标准 ServerResponse,并原样保留 content-length /
   * content-range,保证播放器拿到的响应与直连一致。
   * ------------------------------------------------------------ */
  function forwardRawMedia(clientReq, clientRes, hostname, url, outHeaders) {
    const lines = [];
    lines.push(String(clientReq.method || 'GET') + ' ' + String(clientReq.url || '/') + ' HTTP/1.1');
    lines.push('Host: ' + hostname);
    const skip = { host: 1, connection: 1, 'proxy-connection': 1, 'proxy-authorization': 1,
      'content-length': 1, 'transfer-encoding': 1, 'accept-encoding': 1, 'keep-alive': 1 };
    for (const k of Object.keys(outHeaders)) {
      if (skip[k.toLowerCase()]) continue;
      const v = outHeaders[k];
      if (Array.isArray(v)) { for (const vv of v) lines.push(k + ': ' + vv); }
      else if (v !== undefined && v !== null) lines.push(k + ': ' + v);
    }
    lines.push('Accept-Encoding: identity');
    lines.push('Connection: close'); // 单连接单响应,避免任何连接复用歧义
    lines.push('', '');

    let phase = 'head';
    let headBuf = Buffer.alloc(0);
    let bodyLeft = Infinity;
    let decodeChunked = null;
    let got = 0;
    let tee = null;
    let savedPath = '';
    let info = null;
    let done = false;
    let sock = null;

    const closeTee = function () {
      if (!tee) return;
      const t = tee;
      tee = null;
      try { t.end(); } catch (e) { /* ignore */ }
      t.on('finish', function () {
        if (got === 0) {
          const drop = function () { try { fs.unlink(savedPath, function () {}); } catch (e) { /* ignore */ } };
          if (t.closed) drop(); else t.once('close', drop);
          return;
        }
        info.size = got;
        log('[捕获响应] ' + hostname + ' ' + got + 'B range=' + (info.range || '-') +
            ' ct=' + info.contentType + ' -> ' + info.id + ' (raw转发)');
        recordCapture(info);
      });
      t.on('error', function (e) { log('[落盘失败] ' + ((e && e.message) || e)); });
    };

    const finish = function (destroy) {
      if (done) return;
      done = true;
      if (destroy) { try { sock.destroy(); } catch (e) { /* ignore */ } }
      try { clientRes.end(); } catch (e) { /* ignore */ }
      closeTee();
    };

    const fail = function (why) {
      if (done) return;
      log('[原始转发异常] ' + hostname + ' ' + why + ' | got=' + got);
      try { if (!clientRes.headersSent) clientRes.writeHead(502); } catch (e) { /* ignore */ }
      finish(true);
    };

    const feed = function (b) {
      if (done || !b.length) return;
      let chunk = b;
      if (bodyLeft !== Infinity && chunk.length > bodyLeft) chunk = chunk.slice(0, bodyLeft);
      if (!chunk.length) return;
      got += chunk.length;
      try {
        if (!clientRes.write(chunk)) {
          sock.pause();
          clientRes.once('drain', function () { try { sock.resume(); } catch (e) { /* ignore */ } });
        }
      } catch (e) { /* ignore */ }
      if (tee) tee.write(chunk);
      if (bodyLeft !== Infinity) {
        bodyLeft -= chunk.length;
        if (bodyLeft <= 0) finish(true);
      }
    };

    try {
      sock = tls.connect({ host: hostname, port: 443, servername: hostname, rejectUnauthorized: false }, function () {
        try { sock.write(lines.join('\r\n')); } catch (e) { fail('写请求失败: ' + e.message); }
      });
    } catch (e) {
      log('[原始转发启动失败] ' + hostname + ' ' + ((e && e.message) || e));
      return false;
    }
    sock.setTimeout(60000, function () { fail('上游 60s 无数据'); });

    sock.on('data', function (c) {
      try {
        if (phase === 'head') {
          headBuf = Buffer.concat([headBuf, c]);
          const i = headBuf.indexOf('\r\n\r\n');
          if (i < 0) {
            if (headBuf.length > 65536) fail('响应头超过 64KB');
            return;
          }
          const hLines = headBuf.slice(0, i).toString('latin1').split('\r\n');
          const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(hLines[0] || '');
          if (!m) {
            fail('非法状态行: ' + JSON.stringify(String(hLines[0] || '').slice(0, 80)));
            return;
          }
          const status = parseInt(m[1], 10);
          const hdrs = {};
          for (let j = 1; j < hLines.length; j++) {
            const p = hLines[j].indexOf(':');
            if (p <= 0) continue;
            const k = hLines[j].slice(0, p).trim().toLowerCase();
            if (k) hdrs[k] = hLines[j].slice(p + 1).trim();
          }
          const ct = String(hdrs['content-type'] || '');
          const chunked = /chunked/i.test(String(hdrs['transfer-encoding'] || ''));
          const cl = parseInt(hdrs['content-length'] || '', 10);
          if (!chunked && Number.isFinite(cl) && cl >= 0) bodyLeft = cl;
          else if (chunked) decodeChunked = makeChunkedDecoder(feed);

          // 有精确长度时原样交给 ServerResponse(播放器依赖 content-length/content-range);
          // 仅 chunked / 无长度时让它自行用 chunked 回客户端。
          const outH = Object.assign({}, hdrs);
          delete outH.connection;
          delete outH['keep-alive'];
          if (chunked || !Number.isFinite(cl)) {
            delete outH['content-length'];
            delete outH['transfer-encoding'];
          }
          clientRes.writeHead(status, outH);

          if (looksMedia(clientReq.url, ct)) {
            const fname = 'cap-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.bin';
            savedPath = path.join(captureDir(), fname);
            info = {
              id: fname, url: url, host: hostname, contentType: ct,
              range: String(clientReq.headers.range || ''), size: 0,
              contentRange: String(hdrs['content-range'] || ''),
              savedPath: savedPath, ts: Date.now(),
              reqHeaders: Object.assign({}, clientReq.headers),
            };
            tee = fs.createWriteStream(savedPath);
            tee.on('error', function (e) { log('[落盘失败] ' + ((e && e.message) || e)); });
          }
          log('[原始转发] ' + hostname + ' ' + status + ' cl=' + (Number.isFinite(cl) ? cl : '-') +
              ' chunked=' + chunked + ' ct=' + ct + ' range=' + (clientReq.headers.range || '-'));
          phase = 'body';
          const rest = headBuf.slice(i + 4);
          headBuf = Buffer.alloc(0);
          if (status === 204 || status === 304 || String(clientReq.method).toUpperCase() === 'HEAD') {
            finish(true);
            return;
          }
          if (rest.length) { if (decodeChunked) decodeChunked(rest); else feed(rest); }
          if (bodyLeft === 0) finish(true);
          return;
        }
        if (decodeChunked) decodeChunked(c); else feed(c);
      } catch (e) {
        fail('处理响应异常: ' + ((e && e.message) || e));
      }
    });

    sock.on('end', function () { if (phase === 'body') finish(false); });
    sock.on('close', function () { if (phase === 'body') finish(false); });
    sock.on('error', function (e) {
      if (done) return;
      log('[原始转发错误] ' + hostname + ' ' + ((e && e.code) || '') + ' ' +
          ((e && e.message) || e) + ' | got=' + got);
      fail('socket error');
    });
    clientRes.on('close', function () {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (e) { /* ignore */ }
      closeTee();
    });
    return true;
  }

  /* 拦截到的 HTTPS 请求:转发上游,同时把视频响应原文落盘(tee) */
  function handleRequest(clientReq, clientRes) {
    try {
      const hostHeader = String(clientReq.headers.host || '');
      const hostname = hostHeader.split(':')[0];
      // feed 桥 / 解密 worker 回传:同源 /wxv-notify,不转发上游。
      // worker 走 res.wx.qq.com(与它的脚本同源),页面注入走 channels.weixin.qq.com;
      // POST 为主,GET ?d= 是 CSP 把 POST 挡掉时的兜底。
      const notifyPath = String(clientReq.url || '').split('?')[0];
      const isNotifyHost = hostname === 'channels.weixin.qq.com' || hostname === 'res.wx.qq.com';
      const isNotifyMethod = clientReq.method === 'POST' || clientReq.method === 'GET' || clientReq.method === 'OPTIONS';
      if (isNotifyHost && isNotifyMethod && notifyPath === '/wxv-notify') {
        // 有 WebView 仍会对跨域上报发预检;本地直接应答,别让预检漏到真实网络。
        if (clientReq.method === 'OPTIONS') {
          try {
            clientRes.writeHead(204, {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type',
              'Access-Control-Max-Age': '600',
              'Cache-Control': 'no-store',
            });
            clientRes.end();
          } catch (e) { /* ignore */ }
          return;
        }
        const ack = function () {
          try {
            clientRes.writeHead(200, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              'Access-Control-Allow-Origin': '*',
            });
            clientRes.end('{"ok":1}');
          } catch (e) { /* ignore */ }
        };
        if (clientReq.method === 'GET') {
          try {
            const u = new URL('https://' + hostname + clientReq.url);
            const d = u.searchParams.get('d');
            if (d) handleNotify(Buffer.from(d, 'utf8'));
          } catch (e) { /* ignore */ }
          ack();
        } else {
          const chunks = [];
          clientReq.on('data', function (c) { chunks.push(c); });
          clientReq.on('end', function () {
            try { handleNotify(Buffer.concat(chunks)); } catch (e) { /* ignore */ }
            ack();
          });
          clientReq.on('error', function () { try { clientRes.destroy(); } catch (e2) { /* ignore */ } });
        }
        return;
      }
      const url = 'https://' + hostHeader + clientReq.url;
      if (isApiHost(hostname) || isObserveHost(hostname)) {
        log('[请求] ' + hostname + ' ' + clientReq.method + ' ' + String(clientReq.url || '').slice(0, 110));
      }
      const headers = Object.assign({}, clientReq.headers);
      delete headers['proxy-connection'];
      delete headers['proxy-authorization'];
      headers['accept-encoding'] = 'identity';
      // 视频号页面 / SPA JS 必须每次都拿到完整 200 响应。
      // 浏览器带 if-none-match 时上游会回 304(空 body),改写无从下手,
      // 页面就会一直用旧缓存 → [HTML注入] 0 次 → 永远拿不到 decodeKey。
      if (isApiHost(hostname)) {
        delete headers['if-none-match'];
        delete headers['if-modified-since'];
        delete headers['if-match'];
        delete headers['if-unmodified-since'];
        delete headers['range']; // 避免 206 让 bufferRewrite 只拿到半个 JS
        headers['cache-control'] = 'no-cache';
        headers['pragma'] = 'no-cache';
      }
      // 视频分片走裸 TLS 转发:彻底绕开 Node HTTP client parser(HPE_INVALID_CONSTANT)
      const rawEligible = /^(GET|HEAD)$/i.test(String(clientReq.method || '')) &&
        !clientReq.headers['content-length'] && !clientReq.headers['transfer-encoding'] &&
        looksMedia(clientReq.url, '');
      if (rawEligible) {
        let taken = false;
        try { taken = forwardRawMedia(clientReq, clientRes, hostname, url, headers) === true; }
        catch (e) { log('[原始转发启动失败] ' + ((e && e.message) || e) + ' -> 回退标准转发'); }
        if (taken) return;
      }
      // 上游转发做成可重入:解析失败时换一组更保守的头重试一次
      let retried = false;
      const onUpResponse = function (upRes) {
        try {
          const ct = String(upRes.headers['content-type'] || '');
          const reqPath = String(clientReq.url || '').slice(0, 110);
          const outHeaders = isApiHost(hostname) ? noStoreHeaders(upRes.headers) : upRes.headers;
          // 诊断:把页面域名的每个响应都记下来。上一轮 HTML注入=0 时,
          // 全靠这条判断「是 HTML 根本没请求,还是 content-type 不匹配」。
          if (isApiHost(hostname) || isObserveHost(hostname)) {
            log('[响应类型] ' + hostname + ' ' + reqPath + ' status=' + upRes.statusCode + ' ct=' + (ct || '(空)'));
          }
          // 单独记一条「页面 JS/CSS 真的经过代理了」。
          // 本轮若为 0 条,就说明 WebView 吃的是磁盘缓存,不是漏拦了某个域名。
          if (isApiHost(hostname) && /javascript|text\/css|\.(js|css)(\?|$)/i.test(ct + ' ' + reqPath)) {
            log('[页面资源] ' + hostname + ' ' + reqPath + ' status=' + upRes.statusCode + ' ct=' + (ct || '(空)'));
          }
          if (WXV_REWRITE && isPageHost(hostname) && /text\/html/i.test(ct)) {
            log('[HTML文档] ' + hostname + ' ' + reqPath + ' -> 注入 feed 桥');
            bufferRewrite(upRes, clientRes, rewriteChannelsHtml, 'html');
            return;
          }
          if (WXV_REWRITE && hostname === 'res.wx.qq.com' && /javascript/i.test(ct) && !/wasm_video_decode/i.test(clientReq.url || '')) {
            if (/worker_release\.js/i.test(clientReq.url || '')) {
              bufferRewrite(upRes, clientRes, rewriteDecryptWorker, 'worker');
            } else {
              bufferRewrite(upRes, clientRes, function (b) { return rewriteWxJs(b, clientReq.url); }, 'js');
            }
            return;
          }
          if (isApiHost(hostname) || isObserveHost(hostname)) {
            teeApiResponse(hostname, clientReq, upRes);
          }
          if (!looksMedia(clientReq.url, ct)) {
            clientRes.writeHead(upRes.statusCode || 502, outHeaders);
            upRes.pipe(clientRes);
            return;
          }
          const fname = 'cap-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.bin';
          const savedPath = path.join(captureDir(), fname);
          const tee = fs.createWriteStream(savedPath);
          let got = 0;
          upRes.on('data', function (c) { got += c.length; });
          // 上游异常中断时兜底收尾,避免 tee 句柄悬挂、空文件残留
          const endTee = function () { try { if (!tee.writableEnded) tee.end(); } catch (e) { /* ignore */ } };
          upRes.on('aborted', endTee);
          upRes.on('error', endTee);
          clientRes.writeHead(upRes.statusCode || 502, upRes.headers);
          upRes.pipe(clientRes);
          upRes.pipe(tee);
          tee.on('finish', function () {
            // 上游报错/客户端取消时响应体为 0 字节:删掉空文件,也不写进捕获列表
            if (got === 0) {
              // 等 WriteStream 关闭 fd 再删:Windows 上 finish 时句柄未释放,unlink 会失败
              const drop = function () { try { fs.unlink(savedPath, function () {}); } catch (e) { /* ignore */ } };
              if (tee.closed) drop();
              else tee.once('close', drop);
              return;
            }
            const info = {
              id: fname,
              url: url,
              host: hostname,
              contentType: ct,
              range: String(clientReq.headers.range || ''),
              contentRange: String(upRes.headers['content-range'] || ''),
              size: got,
              savedPath: savedPath,
              ts: Date.now(),
              reqHeaders: Object.assign({}, clientReq.headers),
            };
            log('[捕获响应] ' + hostname + ' ' + got + 'B range=' + (info.range || '-') + ' ct=' + ct + ' -> ' + fname);
            recordCapture(info);
          });
          tee.on('error', function (e) { log('[落盘失败] ' + ((e && e.message) || e)); });
        } catch (e) {
          log('[响应处理异常] ' + ((e && e.message) || e));
          try { clientRes.writeHead(502); clientRes.end(); } catch (e2) { /* ignore */ }
        }
      };

      const forwardOnce = function (outHeaders, isRetry) {
        // 非视频请求(页面/API/JS)仍走标准转发:不复用连接 + 宽松 parser 兜底。
        // 视频分片已在 handleRequest 改走 forwardRawMedia,不会进到这里。
        const upReq = https.request(
          { host: hostname, port: 443, path: clientReq.url, method: clientReq.method,
            headers: outHeaders, rejectUnauthorized: false, agent: false,
            insecureHTTPParser: true },
          onUpResponse
        );
        // 不给上游 socket 挂 'data' 监听:那会让 TLSSocket 进入 flowing 模式,
        // 与 HTTP client parser 的 consume() 争用同一份数据。诊断只用 e.rawPacket。
        upReq.on('error', function (e) {
          const code = String((e && e.code) || '');
          const msg = String((e && e.message) || e);
          const raw = (e && e.rawPacket && e.rawPacket.length) ? Buffer.from(e.rawPacket) : Buffer.alloc(0);
          let dump = '';
          if (raw.length) {
            dump = ' | rawLen=' + raw.length +
                   ' | rawHead=' + raw.slice(0, 64).toString('hex') +
                   ' | rawTail=' + raw.slice(-64).toString('hex') +
                   ' | txt=' + JSON.stringify(raw.slice(0, 80).toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
          }
          log('[上游错误] ' + hostname + clientReq.url + ' ' + msg + ' | code=' + (code || '-') +
              (isRetry ? ' | retry' : '') + dump);
          try { upReq.destroy(); } catch (e2) { /* ignore */ }
          // 解析/连接类错误:改用「带 Range + 不复用连接」重试一次。
          // 实测带 Range 的请求在上游稳定返回标准 206,可把这次失败救回来。
          const canRetry = /^(GET|HEAD)$/i.test(String(clientReq.method || ''));
          if (canRetry && !isRetry && !retried && !clientRes.headersSent &&
              /HPE_|Parse Error|ECONNRESET|socket hang up/i.test(msg + ' ' + code)) {
            retried = true;
            const h = Object.assign({}, outHeaders);
            if (!h.range && !h.Range) h.range = 'bytes=0-';
            delete h.Range;
            delete h.connection;
            delete h.Connection;
            delete h['Accept-Encoding'];
            h['accept-encoding'] = 'identity';
            log('[上游重试] ' + hostname + ' 以 Range=' + (h.range || '-') + ' 重新发起');
            try { forwardOnce(h, true); return; } catch (e2) { log('[上游重试失败] ' + ((e2 && e2.message) || e2)); }
          }
          try {
            if (clientRes.headersSent || clientRes.writableEnded) clientRes.destroy();
            else { clientRes.writeHead(502); clientRes.end('upstream error'); }
          } catch (e2) { /* ignore */ }
        });
        // 视频请求无 body,重试时直接结束即可
        if (isRetry) upReq.end();
        else clientReq.pipe(upReq);
      };
      forwardOnce(headers, false);
    } catch (e) {
      log('[请求处理异常] ' + ((e && e.message) || e));
      try { clientRes.writeHead(500); clientRes.end(); } catch (e2) { /* ignore */ }
    }
  }

  /* 非目标域名:原样 TCP 隧道直通,不碰内容(微信登录/mmtls 全部走这里) */
  function tunnel(req, clientSocket, head) {
    const parts = String(req.url || '').split(':');
    const host = parts[0];
    const portN = parseInt(parts[1] || '443', 10) || 443;
    let up = null;
    const kill = function () {
      try { if (up) up.destroy(); } catch (e) { /* ignore */ }
      try { clientSocket.destroy(); } catch (e) { /* ignore */ }
    };
    try {
      up = net.connect({ host: host, port: portN }, function () {
        try {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length) up.write(head);
          up.pipe(clientSocket);
          clientSocket.pipe(up);
        } catch (e) { log('[隧道错误] ' + ((e && e.message) || e)); kill(); }
      });
      up.on('error', function (e) {
        if (/qq\.com|weixin|wechat|tencent/i.test(host)) log('[隧道] ' + host + ':' + portN + ' ' + ((e && e.message) || e));
        kill();
      });
      clientSocket.on('error', kill);
      clientSocket.on('close', function () { try { if (up) up.destroy(); } catch (e) { /* ignore */ } });
    } catch (e) {
      log('[隧道建立失败] ' + host + ' ' + ((e && e.message) || e));
      kill();
    }
  }

  function start() {
    return new Promise(function (resolve, reject) {
      if (state.running) { resolve({ port: port, caPath: state.ca.certPath }); return; }
      try {
        state.ca = ensureCA(dataDir, log);
        const leafFor = createLeafFactory(state.ca);
        state.httpsServer = https.createServer({
          SNICallback: function (servername, cb) {
            try { cb(null, leafFor(servername)); } catch (e) { cb(e); }
          },
        }, handleRequest);
        state.httpsServer.on('tlsClientError', function (e) {
          log('[TLS握手失败] ' + ((e && e.message) || e));
        });
        state.httpsServer.on('clientError', function (e, sock) {
          try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e2) { /* ignore */ }
        });
        // WebSocket 升级请求:重建上游 TLS 隧道,保证页面 wss 可用
        state.httpsServer.on('upgrade', function (req, clientSocket, head) {
          try {
            const hostHeader = String(req.headers.host || '');
            const hostname = hostHeader.split(':')[0];
            const headers = Object.assign({}, req.headers);
            delete headers['proxy-connection'];
            const upReq = https.request({
              host: hostname, port: 443, path: req.url, method: req.method,
              headers: headers, rejectUnauthorized: false, agent: false,
            });
            upReq.end();
            upReq.on('upgrade', function (upRes, upSocket, upHead) {
              try {
                const lines = ['HTTP/1.1 101 Switching Protocols'];
                for (const k of Object.keys(upRes.headers)) {
                  const v = upRes.headers[k];
                  if (Array.isArray(v)) { for (const vv of v) lines.push(k + ': ' + vv); }
                  else lines.push(k + ': ' + v);
                }
                clientSocket.write(lines.join('\r\n') + '\r\n\r\n');
                if (upHead && upHead.length) clientSocket.unshift(upHead);
                upSocket.pipe(clientSocket);
                clientSocket.pipe(upSocket);
              } catch (e) { try { clientSocket.destroy(); } catch (e2) { /* ignore */ } }
            });
            upReq.on('response', function (upRes) {
              // 上游拒绝升级:原样转发响应
              try {
                const lines = ['HTTP/1.1 ' + upRes.statusCode + ' ' + (upRes.statusMessage || '')];
                for (const k of Object.keys(upRes.headers)) {
                  const v = upRes.headers[k];
                  if (Array.isArray(v)) { for (const vv of v) lines.push(k + ': ' + vv); }
                  else lines.push(k + ': ' + v);
                }
                clientSocket.write(lines.join('\r\n') + '\r\n\r\n');
                upRes.pipe(clientSocket);
              } catch (e) { try { clientSocket.destroy(); } catch (e2) { /* ignore */ } }
            });
            upReq.on('error', function () { try { clientSocket.destroy(); } catch (e2) { /* ignore */ } });
            clientSocket.on('error', function () { try { upReq.destroy(); } catch (e2) { /* ignore */ } });
            if (head && head.length) clientSocket.unshift(head);
          } catch (e) {
            try { clientSocket.destroy(); } catch (e2) { /* ignore */ }
          }
        });
        state.server = http.createServer(function (req, res) {
          // 普通(非 CONNECT)HTTP 请求不在本实验目标内
          try { res.writeHead(404); res.end(); } catch (e) { /* ignore */ }
        });
        state.server.on('connect', function (req, clientSocket, head) {
          const target = String(req.url || '').split(':')[0];
          const intercepted = isInterceptHost(target);
          // 只把腾讯相关域名的 CONNECT 写日志,避免记录整个系统的上网记录。
          // 带 [拦截]/[直通] 标记,下一轮日志能直接看出漏掉了哪个域名。
          if (/qq\.com|weixin|wechat|tencent/i.test(target)) {
            log('[CONNECT] ' + req.url + (intercepted ? ' [拦截]' : ' [直通]'));
          }
          try {
            if (intercepted) {
              clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
              if (head && head.length) { try { clientSocket.unshift(head); } catch (e) { /* ignore */ } }
              state.httpsServer.emit('connection', clientSocket);
            } else {
              tunnel(req, clientSocket, head);
            }
          } catch (e) {
            log('[CONNECT处理异常] ' + target + ' ' + ((e && e.message) || e));
            try { clientSocket.destroy(); } catch (e2) { /* ignore */ }
          }
        });
        state.server.on('clientError', function (e, sock) {
          try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e2) { /* ignore */ }
        });
        state.server.on('error', function (e) {
          log('[代理端口错误] ' + ((e && e.message) || e));
          state.running = false;
          reject(e);
        });
        state.server.listen(port, '127.0.0.1', function () {
          state.running = true;
          let actualPort = port;
          try { actualPort = state.server.address().port; } catch (e) { /* ignore */ }
          // build 标记用于确认跑的是磁盘上的最新代码(模块懒加载后不会自动热更新)
          log('[代理] 已启动 127.0.0.1:' + actualPort + ' [build=wxv-20261109g | 解密worker提key=on | 视频裸TLS转发=on | 全页面响应no-store=on | SW注销=on | 页面资源诊断=on | WebView缓存可恢复清理=on | LiteApp/API域名扩展=on | API/HTML直接提key=on | 宽松parser=on | 空捕获过滤=on | 上游重试=on](仅拦截视频 CDN,其余直通;原始流落盘,不解密)');
          resolve({ port: actualPort, caPath: state.ca.certPath });
        });
      } catch (e) {
        log('[启动失败] ' + ((e && e.message) || e));
        reject(e);
      }
    });
  }

  function stop() {
    return new Promise(function (resolve) {
      let done = false;
      const fin = function () { if (!done) { done = true; state.running = false; resolve(); } };
      if (!state.server) { fin(); return; }
      try { state.server.close(fin); } catch (e) { fin(); }
      try { state.httpsServer.close(); } catch (e) { /* ignore */ }
      setTimeout(fin, 800);
    });
  }

  return {
    start: start,
    stop: stop,
    isRunning: function () { return state.running; },
    getCaptures: function () { return state.captures.slice(); },
    /* 删除记录时必须同步清掉代理内存里的分片,否则下一次 getCaptures() 又把它合并回来 */
    dropCaptures: function (ids) {
      const set = new Set(ids || []);
      if (!set.size) return state.captures.length;
      state.captures = state.captures.filter(function (c) { return !c || !set.has(c.id); });
      return state.captures.length;
    },
    clearCaptures: function () { state.captures = []; return 0; },
    on: function (ev, cb) { emitter.on(ev, cb); },
    get caPath() { return state.ca ? state.ca.certPath : ''; },
  };
}

module.exports = {
  createProxy: createProxy,
  ensureCA: ensureCA,
  isInterceptHost: isInterceptHost,
  isApiHost: isApiHost,
  isObserveHost: isObserveHost,
  extractFeedsFromApi: extractFeedsFromApi, // 导出便于离线验证
};
