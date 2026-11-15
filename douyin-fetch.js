/* ============================================================
 * 抖音分享页解析(纯 HTTPS,不建窗口)
 *
 * 为什么需要这个模块:
 *   原来抓图集靠「开一个内嵌窗口 → 拦页面自己发的 aweme/detail 请求」。
 *   这条路的副作用是页面里任何 window.open / 跳转都会被系统接走,
 *   于是出现 "获取打开此 bitbrowser 链接的应用" 这种系统弹窗,
 *   而且必须等页面渲染、等视频/图集元素出现,慢且依赖登录。
 *
 *   iesdouyin.com/share/{note,video}/<id>/ 是移动端分享落地页,HTML 里
 *   内联了 window._ROUTER_DATA,含完整 item_list(图集带 images[],
 *   视频带 play_addr)。一个 GET 就能拿全,不需要 window、不需要签名。
 *
 * 本模块不依赖 electron,可直接用假 HTML 跑测试:
 *   extractRouterData(html) -> object|null
 *   findAwemes(data)        -> aweme 对象数组(递归找 aweme_id)
 *   parseShareHtml(html,id) -> { ok, kind, title, images, videoUrls, ... }
 *   fetchShare(id, kind)    -> 同上 + finalUrl/httpStatus
 * ============================================================ */

const images = require('./douyin-images');

const SHARE_HOST = 'https://www.iesdouyin.com';
const SHARE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/* ---------- 1. 从 HTML 里抠出 window._ROUTER_DATA ---------- */

/* 不能用正则取 JSON(嵌套很深),用花括号配平;字符串内的 {} 和转义要跳过,
   否则正文里出现的 "}" (抖音标题里很常见) 会提前截断。 */
function extractRouterData(html) {
  const s = String(html || '');
  const m = /_ROUTER_DATA\s*=\s*/.exec(s);
  if (!m) return null;
  let start = s.indexOf('{', m.index + m[0].length - 1);
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let p = start; p < s.length; p += 1) {
    const c = s[p];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, p + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

/* ---------- 2. 递归找 aweme 对象 ----------
   分享页的 loaderData 键名会随页面类型变化(note_(id)/page、video_(id)/page…),
   所以不硬编码路径,直接找「长得像作品」的对象。 */

function isAwemeLike(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  if (!/^\d{8,}$/.test(String(o.aweme_id || o.awemeId || ''))) return false;
  return Boolean(o.images || o.video || o.desc || o.image_post_info);
}

function findAwemes(root, limit) {
  const max = limit || 8;
  const out = [];
  const seen = new Set();
  const stack = [root];
  let guard = 0;
  while (stack.length && out.length < max && guard < 200000) {
    guard += 1;
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);
    if (isAwemeLike(node)) { out.push(node); continue; }
    if (Array.isArray(node)) {
      for (const v of node) if (v && typeof v === 'object') stack.push(v);
    } else {
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }
  return out;
}

/* 精确找一个 aweme_id 对应的作品,找到即返回。
   为什么需要单独一个函数:aweme/post(作者作品列表)动辄几十条、630KB 起,
   先 findAwemes(limit) 再挑会因遍历顺序(lifo)在前 N 个里找不到目标;
   而页面自己就是靠这份列表按 id 取作品的,所以必须全量扫。 */
function findAwemeById(root, id) {
  const want = String(id || '');
  if (!want) return null;
  const seen = new Set();
  const stack = [root];
  let guard = 0;
  while (stack.length && guard < 400000) {
    guard += 1;
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);
    if (isAwemeLike(node) && String(node.aweme_id) === want) return node;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        if (node[i] && typeof node[i] === 'object') stack.push(node[i]);
      }
    } else {
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }
  return null;
}

/* ---------- 3. 从 aweme 取视频地址(去水印) ---------- */

function fixPlayUrl(u) {
  let s = String(u || '');
  if (!/^https?:\/\//i.test(s)) return '';
  // playwm = 带水印;换成 play 即无水印(抖音沿用多年的老规律)
  s = s.replace('/playwm/', '/play/').replace('playwm?', 'play?');
  return s;
}

function videoUrlsOf(aweme) {
  const out = [];
  const push = (u) => {
    const s = fixPlayUrl(u);
    if (s && !out.includes(s)) out.push(s);
  };
  const v = (aweme && aweme.video) || {};
  if (Array.isArray(v.bit_rate) && v.bit_rate.length) {
    const sorted = v.bit_rate.slice().sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
    for (const br of sorted) {
      const list = (br.play_addr && br.play_addr.url_list) || [];
      for (const u of list) push(u);
    }
  }
  for (const key of ['play_addr', 'play_addr_h264', 'download_addr']) {
    const list = (v[key] && v[key].url_list) || [];
    for (const u of list) push(u);
  }
  if (!out.length && aweme && aweme.video && typeof aweme.video.play_addr === 'string') {
    push(aweme.video.play_addr);
  }
  return out;
}

/* 兜底:分享页偶尔给出不带音频的地址,audio 单独放在 music.play_url */
function audioUrlsOf(aweme) {
  const out = [];
  const pu = aweme && aweme.music && aweme.music.play_url;
  const list = (pu && pu.url_list) || [];
  for (const u of list) if (/^https?:\/\//i.test(u) && !out.includes(u)) out.push(u);
  return out;
}

/* ---------- 4. 解析 + 抓取 ---------- */

function sortByScore(list) {
  const score = (a) => {
    const imgs = images.fromAweme(a).length;
    const vids = videoUrlsOf(a).length;
    return imgs * 10 + vids * 5 + (a.desc ? 1 : 0);
  };
  return list.slice().sort((a, b) => score(b) - score(a));
}

function parseShareHtml(html, wantId, wantKind) {
  const data = extractRouterData(html);
  const info = {
    hasRouterData: Boolean(data),
    htmlLen: String(html || '').length,
    htmlTitle: (String(html || '').match(/<title>([\s\S]{0,120}?)<\/title>/i) || [])[1] || '',
  };
  if (!data) return Object.assign({ ok: false, code: 'no-router-data', awemes: 0 }, info);

  const all = sortByScore(findAwemes(data));
  info.awemes = all.length;
  if (!all.length) return Object.assign({ ok: false, code: 'no-aweme' }, info);

  // 优先精确匹配 id,避免分享页里带了相关推荐的作品把数据串了
  const hit = (wantId && all.find((a) => String(a.aweme_id) === String(wantId))) || all[0];
  const imgs = images.fromAweme(hit);
  const vids = videoUrlsOf(hit);
  const auds = audioUrlsOf(hit);

  let kind = '';
  if (imgs.length) kind = 'images';
  else if (vids.length) kind = 'video';
  else kind = 'unknown';

  if (wantKind === 'note' && !imgs.length && vids.length) kind = 'video';
  if (wantKind === 'video' && !vids.length && imgs.length) kind = 'images';

  // 图文作品的 video 字段常是空壳/占位,别把它当视频地址交出去
  const useVids = kind === 'images' ? [] : vids;
  const useAuds = kind === 'images' ? [] : auds;

  return Object.assign({
    ok: kind !== 'unknown',
    code: kind === 'unknown' ? 'no-media' : '',
    id: String(hit.aweme_id || wantId || ''),
    kind: kind,
    title: String(hit.desc || info.htmlTitle || '').trim().slice(0, 120),
    images: kind === 'images' ? imgs : [],
    videoUrls: useVids,
    audioUrls: useAuds,
  }, info);
}

async function fetchShare(id, kind, opts) {
  const o = opts || {};
  const ua = o.ua || SHARE_UA;
  const kinds = kind === 'note' ? ['note'] : kind === 'video' ? ['video'] : ['note', 'video'];
  const tries = [];
  for (const k of kinds) {
    const url = SHARE_HOST + '/share/' + k + '/' + id + '/';
    let res = null;
    try {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': ua,
          Referer: 'https://www.douyin.com/',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: AbortSignal.timeout(o.timeout || 15000),
      });
    } catch (e) {
      tries.push(k + ': 网络错误 ' + ((e && e.message) || e));
      continue;
    }
    let html = '';
    try { html = await res.text(); } catch (e) { html = ''; }
    const r = parseShareHtml(html, id, k);
    tries.push(k + ': HTTP ' + res.status + ' -> ' + (r.ok ? r.kind + '/' + (r.images || []).length + '图' : r.code));
    if (r.ok) {
      /* 分享页常见 302 到 douyin.com 的 JS 应用壳,那种页面没有 _ROUTER_DATA,
         这里记录最终地址,方便用户回传日志时一眼看出被跳到了哪。 */
      return Object.assign(r, { via: 'share', finalUrl: String(res.url || url), httpStatus: res.status, tries: tries });
    }
  }
  return { ok: false, code: 'share-failed', tries: tries, awemes: 0 };
}

module.exports = {
  SHARE_UA,
  extractRouterData,
  findAwemes,
  findAwemeById,
  videoUrlsOf,
  audioUrlsOf,
  parseShareHtml,
  fetchShare,
};
