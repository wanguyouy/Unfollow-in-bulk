/* ============================================================
 * 渲染层自检:假 DOM + vm 里跑真的 common.js / app.js / tgl-local.js
 * ------------------------------------------------------------
 * 本机 electron.exe 起不来(GUI 会话被限制,--version 都直接退出),
 * 所以用最小 DOM 实现顶替浏览器,把真脚本原样跑一遍。
 * 只实现被测代码真正用到的那部分 API:
 *   getElementById / createElement / 选择器(后代 + 逗号 + #id/.cls/tag)
 *   classList / dataset / closest / replaceWith / 事件冒泡 / innerHTML 解析
 * 跑法:node test/renderer-test.js
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const R = path.join(__dirname, '..', 'renderer');

/* ---------------- 最小 DOM ---------------- */
const VOID_TAGS = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'source', 'col']);

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseAttrs(text) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(text))) {
    const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    out[m[1].toLowerCase()] = decodeEntities(v);
  }
  return out;
}

class El {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.ownerDocument = doc || null;
    this.attributes = {};
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this._events = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.checked = false;
    this.disabled = false;
    this.value = '';
    this.alt = '';
    this.src = '';
  }

  get id() { return this.attributes.id || ''; }
  set id(v) { this.attributes.id = String(v); }
  get className() { return this.attributes.class || ''; }
  set className(v) { this.attributes.class = String(v); }

  get classList() {
    const self = this;
    const list = () => String(self.attributes.class || '').split(/\s+/).filter(Boolean);
    const save = (arr) => { self.attributes.class = arr.join(' '); };
    return {
      add: (...cs) => { const a = list(); for (const c of cs) if (!a.includes(c)) a.push(c); save(a); },
      remove: (...cs) => save(list().filter((c) => !cs.includes(c))),
      contains: (c) => list().includes(c),
      toggle: (c, force) => {
        const has = list().includes(c);
        const want = force === undefined ? !has : !!force;
        if (want && !has) save(list().concat([c]));
        if (!want && has) save(list().filter((x) => x !== c));
        return want;
      },
    };
  }

  get dataset() {
    const self = this;
    return new Proxy({}, {
      get(_t, k) {
        const key = 'data-' + String(k).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
        return self.attributes[key];
      },
      set(_t, k, v) {
        const key = 'data-' + String(k).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
        self.attributes[key] = String(v);
        return true;
      },
    });
  }

  get childElementCount() { return this.children.filter((c) => c instanceof El).length; }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() { return null; }

  get textContent() {
    return this.children.map((c) => (c instanceof El ? c.textContent : String(c.text))).join('');
  }
  set textContent(v) {
    this.children = [];
    this.appendText(String(v));
  }

  get innerHTML() {
    return this.children.map((c) => (c instanceof El ? c.outerHTML : String(c.text))).join('');
  }
  set innerHTML(html) {
    this.children = [];
    const frag = parseHTML(String(html), this.ownerDocument);
    for (const c of frag.children) {
      c.parentNode = this;
      this.children.push(c);
    }
  }

  /* 文本节点用 {text} 表示并留在 children 里,顺序才不会和元素乱掉 */
  appendText(str) {
    if (!str) return;
    const last = this.children[this.children.length - 1];
    if (last && !(last instanceof El)) last.text += str;
    else this.children.push({ text: str });
  }

  get outerHTML() {
    const cls = this.attributes.class ? ' class="' + this.attributes.class + '"' : '';
    const id = this.attributes.id ? ' id="' + this.attributes.id + '"' : '';
    const tag = this.tagName.toLowerCase();
    if (VOID_TAGS.has(tag)) return '<' + tag + id + cls + '>';
    return '<' + tag + id + cls + '>' + this.innerHTML + '</' + tag + '>';
  }

  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  replaceWith(node) {
    const p = this.parentNode;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i < 0) return;
    node.parentNode = p;
    p.children[i] = node;
    this.parentNode = null;
  }

  matches(sel) {
    // 只支持单个复合选择器:tag#id.cls1.cls2
    const m = /^([a-zA-Z][\w-]*)?((?:[#.][\w-]+)*)$/.exec(String(sel).trim());
    if (!m) return false;
    if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
    const rest = m[2] || '';
    const parts = rest.match(/[#.][\w-]+/g) || [];
    for (const p of parts) {
      if (p[0] === '#' && this.id !== p.slice(1)) return false;
      if (p[0] === '.' && !this.classList.contains(p.slice(1))) return false;
    }
    return true;
  }

  querySelectorAll(sel) {
    const groups = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
    const result = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (!(c instanceof El)) continue;
        for (const g of groups) {
          const chain = g.split(/\s+/).filter(Boolean);
          if (matchesChain(c, chain)) { if (!result.includes(c)) result.push(c); break; }
        }
        walk(c);
      }
    };
    walk(this);
    return result;
  }

  querySelector(sel) {
    const all = this.querySelectorAll(sel);
    return all.length ? all[0] : null;
  }

  closest(sel) {
    let n = this;
    while (n) {
      if (n instanceof El && n.matches(sel)) return n;
      n = n.parentNode;
    }
    return null;
  }

  addEventListener(type, fn) {
    (this._events[type] = this._events[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const a = this._events[type] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    let n = this;
    while (n) {
      const list = n._events && n._events[ev.type];
      if (list) for (const fn of list.slice()) fn(ev);
      n = n.parentNode;
    }
    return true;
  }
  click() {
    this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} });
  }
}

function matchesChain(el, chain) {
  if (!chain.length) return false;
  if (!el.matches(chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  let n = el.parentNode;
  while (i >= 0) {
    if (!n || !(n instanceof El)) return false;
    if (n.matches(chain[i])) i -= 1;
    n = n.parentNode;
  }
  return true;
}

function parseHTML(html, doc) {
  const root = new El('#fragment', doc);
  const stack = [root];
  let i = 0;
  const addText = (t) => {
    if (!t) return;
    const top = stack[stack.length - 1];
    top.appendText(decodeEntities(t));
  };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { addText(html.slice(i)); break; }
    if (lt > i) addText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const e = html.indexOf('-->', lt);
      i = e < 0 ? html.length : e + 3;
      continue;
    }
    const gt = findTagEnd(html, lt);
    if (gt < 0) { addText(html.slice(lt)); break; }
    const raw = html.slice(lt + 1, gt);
    if (raw[0] === '/') {
      const name = raw.slice(1).trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].tagName.toLowerCase() === name) { stack.length = k; break; }
      }
      i = gt + 1;
      continue;
    }
    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1) : raw;
    const sp = body.search(/\s/);
    const name = (sp < 0 ? body : body.slice(0, sp)).trim();
    const attrs = parseAttrs(sp < 0 ? '' : body.slice(sp));
    const el = new El(name, doc);
    el.attributes = attrs;
    const top = stack[stack.length - 1];
    el.parentNode = top;
    top.children.push(el);
    if (!selfClose && !VOID_TAGS.has(name.toLowerCase())) stack.push(el);
    i = gt + 1;
  }
  return root;
}

function findTagEnd(html, start) {
  let q = null;
  for (let i = start + 1; i < html.length; i += 1) {
    const c = html[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}

/* 从真 index.html 里把带 id 的元素建出来(只要 id + class,
   结构对被测代码不重要:列表内容是 renderTglList 现生成的) */
function createDocument(htmlFile) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const doc = {
    _els: new Map(),
    createElement(tag) { return new El(tag, doc); },
    createTextNode(t) { return { text: String(t) }; },
    getElementById(id) { return doc._els.get(id) || null; },
    querySelector(sel) { return doc.body.querySelector(sel); },
    querySelectorAll(sel) { return doc.body.querySelectorAll(sel); },
    addEventListener() {},
  };
  doc.body = new El('body', doc);
  doc.documentElement = new El('html', doc);
  const tagRe = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const attrs = parseAttrs(m[2]);
    if (!attrs.id) continue;
    const el = new El(m[1], doc);
    el.attributes = attrs;
    el.checked = 'checked' in attrs;
    el.parentNode = doc.body;
    doc.body.children.push(el);
    doc._els.set(attrs.id, el);
  }
  return doc;
}

/* ---------------- 假 window.bili ---------------- */
const now = Date.now();
const ITEMS = [
  { id: 'a1', source: 'cache', kind: 'image', ext: 'jpg', size: 210 * 1024, playable: true, complete: true, mtime: now - 3600e3 },
  { id: 'a2', source: 'cache', kind: 'image', ext: 'webp', size: 30 * 1024, playable: true, complete: true, mtime: now - 7200e3 },
  { id: 'a3', source: 'media_cache', kind: 'video', ext: 'mp4', size: 8 * 1024 * 1024, playable: false, complete: false, mtime: now - 600e3 },
  { id: 'a4', source: 'cache', kind: 'video', ext: 'webm', size: 16 * 1024, playable: true, complete: true, mtime: now - 120e3 },
  { id: 'a5', source: 'cache', kind: 'image', ext: 'jpg', size: 5 * 1024, playable: true, complete: true, mtime: now - 900e3 },
  { id: 'a6', source: 'media_cache', kind: 'video', ext: 'mp4', size: 1536 * 1024, playable: true, complete: true, mtime: now - 3600e3 },
];
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const ok = (v) => Promise.resolve(v);
const noop = () => {};

/* 公众号图集的假解析结果:两档(原图 / 压缩图),封面排在第一张,与主进程返回结构一致 */
const WX_ARTICLE = {
  ok: true, platform: 'wechat', kind: 'images',
  title: '初秋偶尔拍一下三次元题材', count: 2, hasCover: true,
  modes: [
    {
      key: 'original', label: '无水印原图', totalText: '83.0 MB', totalBytes: 85026905,
      images: [
        { url: 'https://mmbiz.qpic.cn/cover/0?wx_fmt=jpeg', fallback: '', thumb: 'https://mmbiz.qpic.cn/cover/0?wx_fmt=jpeg', width: 0, height: 0, size: 120000, sizeText: '117 KB', label: '封面' },
        { url: 'https://wxapp.tc.qq.com/orig1?x=1', fallback: 'https://mmbiz.qpic.cn/comp1/0?wx_fmt=jpeg', thumb: 'https://mmbiz.qpic.cn/comp1/0?wx_fmt=jpeg', width: 2560, height: 3840, size: 43436654, sizeText: '41.4 MB' },
        { url: 'https://wxapp.tc.qq.com/orig2?x=2', fallback: 'https://mmbiz.qpic.cn/comp2/0?wx_fmt=jpeg', thumb: 'https://mmbiz.qpic.cn/comp2/0?wx_fmt=jpeg', width: 2560, height: 3840, size: 41590251, sizeText: '39.7 MB' },
      ],
    },
    {
      key: 'compressed', label: '压缩图', totalText: '2.5 MB', totalBytes: 2549831,
      images: [
        { url: 'https://mmbiz.qpic.cn/cover/0?wx_fmt=jpeg', fallback: '', thumb: 'https://mmbiz.qpic.cn/cover/0?wx_fmt=jpeg', width: 0, height: 0, size: 120000, sizeText: '117 KB', label: '封面' },
        { url: 'https://mmbiz.qpic.cn/comp1/0?wx_fmt=jpeg', fallback: '', thumb: 'https://mmbiz.qpic.cn/comp1/0?wx_fmt=jpeg', width: 2560, height: 3840, size: 1385631, sizeText: '1.3 MB' },
        { url: 'https://mmbiz.qpic.cn/comp2/0?wx_fmt=jpeg', fallback: '', thumb: 'https://mmbiz.qpic.cn/comp2/0?wx_fmt=jpeg', width: 2560, height: 3840, size: 1164200, sizeText: '1.1 MB' },
      ],
    },
  ],
};

function makeBili(log) {
  return {
    tglProbe: () => ok({ ok: true, tdata: 'C:\\Users\\test\\AppData\\Roaming\\Telegram Desktop\\tdata', fileCount: 926, bytes: 1093794296, keyOk: true }),
    tglScan: () => ok({
      ok: true, tdata: 'C:\\tdata', items: ITEMS,
      stat: { image: 3, video: 3, audio: 0 }, bytes: 9900000,
      locked: 0, unknown: 474, dupes: 0, fileCount: 926, ms: 2900,
    }),
    tglThumb: (id) => { log.thumb += 1; return ok(id === 'a3' ? { ok: false } : { ok: true, dataUrl: PIXEL }); },
    tglPickDir: () => ok({ ok: true, dir: 'D:\\导出' }),
    tglExport: (args) => { log.export += 1; log.lastExport = args; return ok({ ok: true, dest: 'D:\\导出\\Telegram本地缓存', count: args.ids.length, written: args.ids.length, skipped: 0, bytes: 1234567 }); },
    tglOpen: () => ok({ ok: true }),
    onTglProgress: (cb) => { log.progress = cb; },
    checkLogin: () => ok({ loggedIn: false }),
    ffmpegCheck: () => ok({ ok: true, path: 'ffmpeg' }),
    wxvStatus: () => ok({}),
    emojiStatus: () => ok({ tool: { found: true, version: 'x' } }),
    emojiAccounts: () => ok({ ok: true, accounts: [] }),
    pickSave: () => ok(''),
    pickDir: () => ok('D:\\图集'),
    fetchWechatArticle: () => ok(WX_ARTICLE),
    downloadWechatImages: (args) => { log.wxDownload += 1; log.lastWx = args; return ok({ ok: true, dir: 'D:\\图集\\初秋偶尔拍一下三次元题材', saved: args.images.length, failed: 0 }); },
    onDlProgress: noop, onLoginSuccess: noop,
    onWxvCaptured: noop, onWxvLog: noop, onWxvStatus: noop, onWxvFeed: noop,
    onEmojiLog: noop, onEmojiProgress: noop, onEmojiDone: noop,
  };
}

/* ---------------- 断言 ---------------- */
const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail).replace(/\s+/g, ' ').slice(0, 160) });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined ? '  →  ' + String(detail).replace(/\s+/g, ' ').slice(0, 120) : ''));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  const doc = createDocument(path.join(R, 'index.html'));
  const log = { thumb: 0, export: 0, lastExport: null, progress: null, wxDownload: 0, lastWx: null };
  const sandbox = {
    document: doc,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Map, Set, Array, Object, JSON, Date, Math, String, Number, Boolean, RegExp, Error,
    Intl,
    IntersectionObserver: undefined, // 走降级路径:全部立即请求缩略图
    Event: function (t) { return { type: t, preventDefault() {} }; },
  };
  sandbox.window = sandbox;
  sandbox.window.bili = makeBili(log);
  const ctx = vm.createContext(sandbox);

  const run = (f) => vm.runInContext(fs.readFileSync(path.join(R, f), 'utf8'), ctx, { filename: f });
  const evalIn = (code) => vm.runInContext(code, ctx);

  let loadError = '';
  try {
    run('common.js');
    run('app.js');
    run('tgl-local.js');
  } catch (e) { loadError = (e && e.stack) || String(e); }
  check('三个脚本能无异常加载', !loadError, loadError.slice(0, 300));

  await wait(60); // 等自动 probe 的 promise 落地

  const st = (id) => evalIn("document.getElementById('" + id + "').textContent");
  const has = (id, cls) => evalIn("document.getElementById('" + id + "').classList.contains('" + cls + "')");

  /* 1. 进界面自动探测 */
  check('自动探测 tdata 并显示', /已找到数据目录/.test(st('tglStatus')), st('tglStatus').slice(0, 70));

  /* 2. 扫描 */
  evalIn("document.getElementById('tglScanBtn').click()");
  await wait(80);
  const n1 = evalIn("document.querySelectorAll('#tglList .tgl-item').length");
  check('扫描后 6 条全渲染(小文件默认不过滤)', n1 === 6, n1 + ' 条');
  check('统计里带总数 6', /共 6 条/.test(st('tglCount')), st('tglCount'));
  check('筛选行/导出行显示出来', !has('tglFilters', 'hidden') && !has('tglExportRow', 'hidden'), '');
  check('缺索引的视频有 warn 标记', evalIn("document.querySelectorAll('#tglList .tgl-tag.warn').length") === 1, '');
  check('扫描文案含未识别数量', /未识别 474/.test(st('tglStatus')), st('tglStatus').slice(0, 90));

  /* 3. 缩略图(降级路径:全部立即请求) */
  await wait(120);
  const imgs = evalIn("document.querySelectorAll('#tglList img.tgl-media').length");
  const phs = evalIn("document.querySelectorAll('#tglList .tgl-ph').length");
  check('缩略图写回列表', imgs === 5 && phs === 1, 'img ' + imgs + ' / 占位 ' + phs);
  check('抽不出帧的那条降级成类型占位', evalIn("(function(){var e=document.querySelectorAll('#tglList .tgl-item');for(var i=0;i<e.length;i++){if(e[i].dataset.id==='a3'){var p=e[i].querySelector('.tgl-ph');return p?p.textContent:'img'}}return 'missing'})()") === '视频', '');

  /* 4. 点选(事件要冒泡到 #tglList 的委托监听) */
  evalIn("document.querySelector('#tglList .tgl-item').click()");
  await wait(40);
  check('点一下即选中 1 条', /已选 1 条/.test(st('tglCount')), st('tglCount'));
  check('选中态落在 class 上', evalIn("document.querySelectorAll('#tglList .tgl-item.on').length") === 1, '');

  /* 5. 全选 / 清空 */
  evalIn("document.getElementById('tglSelAllBtn').click()");
  await wait(40);
  check('全选 = 当前可见的 6 条', /已选 6 条/.test(st('tglCount')), st('tglCount'));
  evalIn("document.getElementById('tglSelNoneBtn').click()");
  await wait(40);
  check('清空后回到 0 条', !/已选/.test(st('tglCount')), st('tglCount'));

  /* 6. 筛选 */
  evalIn("var v=document.getElementById('tglKVideo'); v.checked=false; v.dispatchEvent({type:'change'})");
  await wait(60);
  check('关掉视频后剩 3 条图片', evalIn("document.querySelectorAll('#tglList .tgl-item').length") === 3, '');
  evalIn("var v=document.getElementById('tglKVideo'); v.checked=true; v.dispatchEvent({type:'change'}); var p=document.getElementById('tglOnlyPlayable'); p.checked=true; p.dispatchEvent({type:'change'})");
  await wait(60);
  check('「只看能播的视频」滤掉缺索引那条', evalIn("document.querySelectorAll('#tglList .tgl-item').length") === 5, '');

  evalIn("var p=document.getElementById('tglOnlyPlayable'); p.checked=false; p.dispatchEvent({type:'change'}); var k=document.getElementById('tglSkipSmall'); k.checked=true; k.dispatchEvent({type:'change'})");
  await wait(60);
  check('「隐藏 ≤20KB」滤掉 5KB 图与 16KB 圆视频', evalIn("document.querySelectorAll('#tglList .tgl-item').length") === 4, '');
  evalIn("var k=document.getElementById('tglSkipSmall'); k.checked=false; k.dispatchEvent({type:'change'})");
  await wait(60);

  /* 7. 导出 */
  evalIn("document.getElementById('tglSelAllBtn').click()");
  await wait(40);
  evalIn("document.getElementById('tglExportBtn').click()");
  await wait(120);
  check('导出成功文案', /已导出/.test(st('tglStatus')), st('tglStatus').slice(0, 80));
  check('导出入参带全部 6 个 id', !!(log.lastExport && log.lastExport.ids && log.lastExport.ids.length === 6), JSON.stringify(log.lastExport));
  check('导出后露出「打开导出目录」', !has('tglOpenBtn', 'hidden'), '');

  /* 8. 进度事件 */
  log.progress({ phase: 'export', done: 2, total: 4 });
  await wait(20);
  check('进度事件推动进度条到 50%', evalIn("document.getElementById('tglBar').style.width") === '50%', evalIn("document.getElementById('tglBar').style.width"));

  /* 9. 自定义路径 + 扫描失败的分支 */
  evalIn("document.getElementById('tglPath').value='D:\\\\no\\\\tdata'");
  sandbox.window.bili.tglProbe = () => ok({ ok: false, message: '这个路径不存在' });
  evalIn("(async function(){ await tglProbe(); })()");
  await wait(40);
  check('路径不对时给出提示', /这个路径不存在/.test(st('tglStatus')), st('tglStatus').slice(0, 60));

  /* 10. 公众号图集:识别 → 解析 → 两档下载 */
  evalIn("var s=document.getElementById('shareInput'); s.value='https://mp.weixin.qq.com/s/OwScMoYsAra3zFF8-sqcfA'; s.dispatchEvent({type:'input'})");
  await wait(20);
  check('公众号链接识别到徽章', st('platformBadge') === '识别到:微信公众号' && evalIn("document.getElementById('platformBadge').classList.contains('badge-wx')"), st('platformBadge'));
  evalIn("document.getElementById('parseBtn').click()");
  await wait(80);
  check('解析后显示标题', st('vTitle') === '初秋偶尔拍一下三次元题材', st('vTitle'));
  check('元信息含张数与体积', /图片消息/.test(st('vMeta')) && /2 张/.test(st('vMeta')) && /83\.0 MB/.test(st('vMeta')), st('vMeta'));
  check('元信息标明含封面', /含封面/.test(st('vMeta')), st('vMeta'));
  const wxOpts = evalIn("document.querySelectorAll('#qualitySel option').length");
  check('清晰度下拉 = 原图/压缩图 两档', wxOpts === 2, wxOpts + ' 档');
  check('按钮文案为保存图集', /保存图集/.test(st('downloadBtn')), st('downloadBtn'));
  check('缩略图占位 3 张(封面+2)', evalIn("document.querySelectorAll('#imgStrip img').length") === 3, '');
  evalIn("document.getElementById('downloadBtn').click()");
  await wait(80);
  check('默认下载原图(封面排第一,其余带压缩兜底)', !!(log.lastWx && log.lastWx.images.length === 3 && log.lastWx.images[0].length === 1 && log.lastWx.images[1].length === 2), JSON.stringify(log.lastWx && log.lastWx.images));
  check('封面带固定名 封面', !!(log.lastWx && Array.isArray(log.lastWx.names) && log.lastWx.names[0] === '封面' && log.lastWx.names[1] === ''), JSON.stringify(log.lastWx && log.lastWx.names));
  check('下载入参带目录与标题', !!(log.lastWx && log.lastWx.destDir === 'D:\\图集' && log.lastWx.title === '初秋偶尔拍一下三次元题材'), '');
  check('下载成功文案', /已保存 3 张/.test(st('dlStatus')), st('dlStatus').slice(0, 80));
  evalIn("document.getElementById('qualitySel').value='1'");
  evalIn("document.getElementById('downloadBtn').click()");
  await wait(80);
  check('切到压缩图后不带原图兜底', !!(log.lastWx && log.lastWx.images[0].length === 1 && /^https:\/\/mmbiz/.test(log.lastWx.images[0][0])), JSON.stringify(log.lastWx && log.lastWx.images[0]));

  const failed = checks.filter((c) => !c.pass).length;
  const out = path.join(__dirname, 'result.json');
  fs.writeFileSync(out, JSON.stringify({ time: new Date().toISOString(), total: checks.length, failed, checks }, null, 2), 'utf8');
  console.log('\n' + (failed ? failed + ' 项失败' : '全部通过') + '(' + checks.length + ' 项) → ' + out);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('自检本身崩了:', (e && e.stack) || e);
  process.exit(2);
});
