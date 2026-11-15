/* ============================================================
 * 抖音图集(图文 / note)支持
 *
 * 视频作品的数据在 aweme.video.play_addr,图集作品则没有可用视频,
 * 图片在 aweme.images[] / aweme.image_post_info.images[] 里,每张可能带
 * 多份镜像地址(download_url_list 无水印 / display_image 展示图 / url_list / 缩略图)。
 *
 * 本模块只做纯逻辑,不依赖 electron:
 *   fromAweme(aweme) -> [[url, url...], ...]   每张图的候选地址(按质量排序)
 *   extOf(ctype,url) / safeName(s) / fetchOne / downloadAll
 * 这样可以直接用假数据 + 本地 HTTP 服务器跑测试,不需要连抖音。
 * ============================================================ */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const IMG_MAX = 200; // 图文最多见过 30 多张,留足余量但防止异常数据刷爆

/* 候选地址排序:优先【不带水印】,再看格式。
   实测 aweme/post 里的图文,download_url_list 指向的正是
   tplv-dy-water-v2(带抖音水印),而 url_list 里的 tplv-dy-aweme-images
   才是干净图 —— 所以不能只按列表顺序取,必须按水印标记排。 */
function cmpCandidate(a, b) {
  const water = (u) => (/dy-water|water-?v\d|watermark/i.test(u) ? 1 : 0);
  const jpg = (u) => (/\.jpe?g(\?|$)/i.test(u) ? 1 : 0);
  return (water(a) - water(b)) || (jpg(b) - jpg(a));
}

/* 把一个图片节点上的可用地址收集起来,并让 jpeg 排在前面
   (webp/avif 在 Windows 看图工具里兼容性差,优先给通用格式) */
function pickUrls(node) {
  if (!node) return [];
  const lists = [];
  if (Array.isArray(node)) lists.push(node);
  else {
    if (Array.isArray(node.download_url_list)) lists.push(node.download_url_list);
    if (Array.isArray(node.url_list)) lists.push(node.url_list);
    if (Array.isArray(node.urlList)) lists.push(node.urlList);
  }
  const out = [];
  for (const list of lists) {
    for (const u of list) {
      if (typeof u === 'string' && /^https?:\/\//i.test(u) && !out.includes(u)) out.push(u);
    }
  }
  return out.sort(cmpCandidate);
}

/* 从单个图片条目里按「无水印优先」取候选地址 */
function urlsOfItem(it) {
  if (!it) return [];
  const groups = [
    it.download_url_list, // 无水印下载地址
    it.display_image && it.display_image.url_list, // 展示图
    it.url_list,
    it.owner_watermark_image && it.owner_watermark_image.url_list, // 带水印(兜底)
    it.thumbnail && it.thumbnail.url_list,
  ];
  const out = [];
  for (const g of groups) {
    if (!Array.isArray(g)) continue;
    for (const u of g) {
      if (typeof u === 'string' && /^https?:\/\//i.test(u) && !out.includes(u)) out.push(u);
    }
  }
  return out.sort(cmpCandidate); // sort 稳定,去水印的排最前
}

/* 从 aweme 详情里取出所有图片;视频作品返回空数组
   优先 aweme.images —— 它才带 download_url_list(无水印原图),
   image_post_info.images 里多为带水印的 display_image,只作兜底。 */
function fromAweme(aweme) {
  if (!aweme) return [];
  const post = aweme.image_post_info && aweme.image_post_info.images;
  const list = Array.isArray(aweme.images) && aweme.images.length
    ? aweme.images
    : (Array.isArray(post) ? post : []);
  const out = [];
  const seen = new Set();
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const urls = urlsOfItem(it);
    if (!urls.length) continue;
    // 用 uri(稳定标识)去重,没有 uri 就退化为首个地址的路径部分
    const key = String(it.uri || urls[0].split('?')[0]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(urls);
    if (out.length >= IMG_MAX) break;
  }
  return out;
}

/* 扩展名:先看响应类型,再看 URL 后缀。抖音常用 .~tplv-xxx.jpeg?x-expires=... */
function extOf(ctype, url) {
  const c = String(ctype || '').toLowerCase();
  if (/png/.test(c)) return '.png';
  if (/gif/.test(c)) return '.gif';
  if (/webp/.test(c)) return '.webp';
  if (/avif/.test(c)) return '.avif';
  if (/bmp/.test(c)) return '.bmp';
  if (/jpe?g/.test(c)) return '.jpg';
  const m = String(url || '').match(/\.(jpe?g|png|gif|webp|avif|bmp)(?:\?|$)/i);
  if (!m) return '.jpg';
  const e = m[1].toLowerCase();
  return e === 'jpeg' ? '.jpg' : '.' + e;
}

/* Windows 文件名安全化(抖音标题常带 emoji、#话题、/、换行) */
function safeName(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/[\u0000-\u001f\u007f]/g, ' ');
  t = t.replace(/[\\/:*?"<>|]/g, '_');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/^[.\s]+|[.\s]+$/g, '');
  if (!t) t = '抖音图集';
  if (t.length > 60) t = t.slice(0, 60).trim();
  return t;
}

/* 依次尝试候选地址,返回 { ok, buf, ext } */
async function fetchOne(urls, opts) {
  const o = opts || {};
  const ua = o.ua || 'Mozilla/5.0';
  let lastErr = null;
  for (const u of urls || []) {
    try {
      const res = await fetch(u, {
        headers: {
          'User-Agent': ua,
          Referer: 'https://www.douyin.com/',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(o.timeout || 30000),
      });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const ctype = String(res.headers.get('content-type') || '');
      if (ctype && !/^image\//i.test(ctype) && !/octet-?stream/i.test(ctype)) {
        throw new Error('返回的不是图片(' + ctype + ')');
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 512) throw new Error('图片过小(' + buf.length + 'B)');
      return { ok: true, buf: buf, ext: extOf(ctype, u) };
    } catch (e) {
      lastErr = e;
    }
  }
  return { ok: false, message: (lastErr && lastErr.message) || '没有可用地址' };
}

/* 顺序下载到 outDir,命名为 01.jpg / 02.jpg...
   onProgress({ index, total, ok }) 每张回调一次 */
async function downloadAll(args) {
  const a = args || {};
  const images = Array.isArray(a.images) ? a.images.slice(0, IMG_MAX) : [];
  const outDir = String(a.outDir || '');
  if (!images.length) return { ok: false, saved: 0, failed: 0, files: [], message: '没有可下载的图片' };
  if (!outDir) return { ok: false, saved: 0, failed: 0, files: [], message: '未指定保存目录' };

  await fsp.mkdir(outDir, { recursive: true });
  const files = [];
  const fails = [];
  const width = Math.max(2, String(images.length).length);
  for (let i = 0; i < images.length; i += 1) {
    const r = await fetchOne(images[i], { ua: a.ua, timeout: a.timeout });
    if (r.ok) {
      // 按成功顺序连续编号(失败的不占号),避免出现 01、03 这种空号
      const pad = String(files.length + 1).padStart(width, '0');
      const f = path.join(outDir, pad + r.ext);
      await fsp.writeFile(f, r.buf);
      files.push(f);
    } else {
      fails.push('第 ' + (i + 1) + ' 张: ' + r.message);
    }
    if (typeof a.onProgress === 'function') {
      try { a.onProgress({ index: i + 1, total: images.length, ok: r.ok, file: r.ok ? files[files.length - 1] : '' }); } catch (e) { /* ignore */ }
    }
  }
  return {
    ok: files.length > 0,
    saved: files.length,
    failed: fails.length,
    files: files,
    message: fails.length ? '失败 ' + fails.length + ' 张（' + fails.slice(0, 3).join('; ') + '）' : '',
  };
}

module.exports = { IMG_MAX, pickUrls, urlsOfItem, fromAweme, extOf, safeName, fetchOne, downloadAll };
