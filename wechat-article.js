/* ============================================================
 * 微信公众号「图片消息 / 图文」无水印图集解析(纯 HTTPS,不建窗口)
 *
 * 链接形如 https://mp.weixin.qq.com/s/xxxxxxxx
 *
 * 两类页面:
 *   · 图片消息(小绿书):内联 JS 里有 picture_page_info_list:[...],每张:
 *       cdn_url            压缩图(干净)
 *       watermark_info     水印图层(客户端叠上去的,不在图里)
 *       original_info      无水印原图(wxapp.tc.qq.com,单张常 40MB+)
 *     → 优先 original_info.cdn_url,没有才退回 cdn_url
 *   · 普通图文:正文 js_content 里的 <img data-src="https://mmbiz.qpic.cn/...">
 *
 * 不要 eval 远端 JS:那个数组是 JS 字面量(裸键名 / 单引号 / '2560' * 1),
 * 这里用括号扫描切元素 + 字段正则取值,不执行页面里的任何代码。
 * ============================================================ */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MAX_IMAGES = 200;

function looksWechat(text) {
  const t = String(text || '');
  return /mp\.weixin\.qq\.com\/s[/?]/i.test(t) || /weixin\.qq\.com\/s\//i.test(t);
}

function extractUrl(text) {
  /* 分享文案里链接后面常跟中文标点(。，）等),不能带进 URL */
  const urls = String(text || '').match(/https?:\/\/[^\s"'<>，。；！？、）】》」』]+/g) || [];
  const clean = (u) => String(u || '').replace(/[.,;:!?'")\]}]+$/, '');
  return (
    clean(urls.find((u) => /mp\.weixin\.qq\.com\/s/i.test(u))) ||
    clean(urls.find((u) => /weixin\.qq\.com\/s\//i.test(u))) ||
    ''
  );
}

/* ---------- 文本解码 ---------- */

function decodeAmp(s) {
  return String(s == null ? '' : s).replace(/&amp;/g, '&');
}

function decodeText(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

/* ---------- 不执行代码的括号扫描 ---------- */

/* 从 openIdx 处的开括号找到配对的闭括号下标;跳过字符串字面量 */
function findBalanced(src, openIdx, openCh, closeCh) {
  let depth = 0;
  let quote = '';
  for (let i = openIdx; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === openCh) depth += 1;
    else if (c === closeCh) {
      depth -= 1;
      if (!depth) return i;
    }
  }
  return -1;
}

/* 把数组体按顶层逗号切成元素文本(元素是对象字面量) */
function splitTopLevel(body) {
  const out = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{' || c === '[' || c === '(') depth += 1;
    else if (c === '}' || c === ']' || c === ')') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/* 解 JS 字符串转义:页面里的原图地址常写成 \x26amp;filekey=…
   (\x26 是 &,再叠一层 HTML 实体 &amp;),两步都要解干净。 */
function decodeJsString(raw) {
  return String(raw == null ? '' : raw).replace(
    /\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\\'"/bfnrtv0])/g,
    function (m, e) {
      if (e[0] === 'x' || e[0] === 'u') return String.fromCharCode(parseInt(e.slice(1), 16));
      return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', "'": "'", '"': '"', '/': '/' }[e] || e;
    }
  );
}

/* 取 `key: 'xxx'` / `key: "xxx"` 的字符串值(同一个 key 取第一个) */
function jsString(src, key) {
  const re = new RegExp('\\b' + key + "\\s*:\\s*(?:'((?:\\\\.|[^'\\\\])*)'|\"((?:\\\\.|[^\"\\\\])*)\")");
  const m = src.match(re);
  if (!m) return '';
  return decodeJsString(m[1] !== undefined ? m[1] : m[2]);
}

/* ---------- 图片消息: picture_page_info_list ---------- */

function parsePictureList(html) {
  const k = html.indexOf('picture_page_info_list');
  if (k < 0) return null;
  const open = html.indexOf('[', k);
  if (open < 0) return null;
  const close = findBalanced(html, open, '[', ']');
  if (close < 0) return null;

  const items = splitTopLevel(html.slice(open + 1, close));
  const out = [];
  for (const src of items) {
    if (src[0] !== '{') continue;
    const cdn = decodeAmp(jsString(src, 'cdn_url'));
    if (!/^https?:\/\//i.test(cdn)) continue;

    /* original_info 是嵌套对象:取其中的 cdn_url 与 file_size */
    let orig = '';
    let size = 0;
    const oi = src.indexOf('original_info');
    if (oi >= 0) {
      const ob = src.indexOf('{', oi);
      const oe = ob >= 0 ? findBalanced(src, ob, '{', '}') : -1;
      if (oe > ob) {
        const sub = src.slice(ob, oe + 1);
        const u = decodeAmp(jsString(sub, 'cdn_url'));
        if (/^https?:\/\//i.test(u)) orig = u;
        const fm = sub.match(/\bfile_size\s*:\s*'?(\d+)'?/);
        if (!size && fm) size = Number(fm[1]) || 0;
      }
    }

    const w = (src.match(/\bwidth\s*:\s*'?(\d+)'?/) || [])[1];
    const h = (src.match(/\bheight\s*:\s*'?(\d+)'?/) || [])[1];
    out.push({
      url: orig || cdn,
      fallback: orig ? cdn : '', // 原图失败时退回压缩图
      thumb: cdn.replace(/^http:\/\//i, 'https://'),
      width: Number(w) || 0,
      height: Number(h) || 0,
      size: size || 0,
      isOriginal: !!orig,
    });
    if (out.length >= MAX_IMAGES) break;
  }
  return out.length ? out : null;
}

/* ---------- 普通图文: js_content 里的 <img> ---------- */

function parseArticleImages(html) {
  let region = String(html || '');
  const ci = region.indexOf('id="js_content"');
  if (ci >= 0) region = region.slice(ci);
  const cuts = ['id="js_pc_qr_code"', 'rich_media_area_extra', 'js_article_bottom_bar']
    .map((s) => region.indexOf(s))
    .filter((i) => i > 0);
  if (cuts.length) region = region.slice(0, Math.min.apply(null, cuts));

  const urls = [];
  const seen = new Set();
  const add = (raw) => {
    const u = decodeAmp(String(raw || '').trim());
    if (!/^https?:\/\/[^/]*mmbiz\.qpic\.cn\//i.test(u)) return;
    const key = u.split('?')[0];
    if (seen.has(key)) return;
    seen.add(key);
    urls.push(u);
  };
  const re = /<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(region)) && urls.length < MAX_IMAGES) {
    const tag = m[0];
    const attr = (name) => (tag.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i')) || [])[1] || '';
    add(attr('data-src') || attr('data-backsrc') || attr('src'));
  }
  return urls;
}

/* ---------- 标题 / 错误页 ---------- */

function parseTitle(html) {
  const patterns = [
    /msg_title\s*=\s*window\.title\s*=\s*'([^']*)'/,
    /msg_title\s*=\s*'([^']*)'/,
    /<meta\s+property="og:title"\s+content="([^"]*)"/,
    /<h1[^>]*id="activity-name"[^>]*>([\s\S]*?)<\/h1>/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const t = decodeText(m[1].replace(/<[^>]+>/g, '')).trim();
      if (t) return t;
    }
  }
  return '';
}

function detectError(html) {
  const t = String(html || '').replace(/\s+/g, ' ');
  /* 文章 ID 抄错(常见把字母 l 看成数字 1 / 大写 I)或链接失效时,微信只回一张「参数错误」空页 */
  if (/weui-msg__title warn">参数错误</.test(t)) {
    return { code: 'param', message: '链接参数错误:文章 ID 可能抄错了(比如字母 l 被写成 I 或 1),请在微信里重新复制分享链接' };
  }
  if (/环境异常|完成验证后即可继续访问/.test(t)) {
    return { code: 'verify', message: '微信要求先完成验证:在浏览器里打开一次该链接通过验证后再试' };
  }
  if (/该内容已被发布者删除/.test(t)) return { code: 'deleted', message: '文章已被发布者删除' };
  if (/此内容因违规无法查看|该内容被多人投诉/.test(t)) return { code: 'blocked', message: '内容因违规/投诉无法查看' };
  if (/该内容暂时无法查看|链接已过期/.test(t)) return { code: 'unavailable', message: '内容暂时不可用(可能已过期或仅限特定范围)' };
  return null;
}

/* ---------- 封面 ---------- */

/* 文章封面:优先页面变量 msg_cdn_url,其次 og:image / twitter:image(图片消息常只有这个)。
   封面只有压缩版,下载时排第一张并命名为「封面.jpg」。 */
function parseCover(html) {
  const src = String(html || '');
  let raw = '';
  const v = src.match(/\bmsg_cdn_url\s*=\s*["']([^"']+)["']/);
  if (v) raw = v[1];
  if (!raw) {
    const og = src.match(/<meta\s+property="og:image"\s+content="([^"]*)"/i)
      || src.match(/<meta\s+name="twitter:image"\s+content="([^"]*)"/i);
    if (og) raw = og[1];
  }
  const url = decodeAmp(decodeJsString(raw));
  if (!/^https?:\/\//i.test(url)) return null;
  return { url, thumb: url.replace(/^http:\/\//i, 'https://') };
}

async function buildCover(html, opts) {
  const c = parseCover(html);
  if (!c) return null;
  const sizes = await headSizes([c.url], opts);
  const size = sizes[0] || 0;
  return {
    url: c.url,
    fallback: '',
    thumb: c.thumb,
    width: 0,
    height: 0,
    size,
    sizeText: humanSize(size),
    label: '封面',
  };
}

/* ---------- 体积 ---------- */

function humanSize(bytes) {
  const n = Number(bytes || 0);
  if (!n) return '';
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}

/* 压缩图在页面里不带体积,并发 HEAD 补齐(失败就留空,不影响下载) */
async function headSizes(urls, opts) {
  const o = opts || {};
  return Promise.all(
    urls.map(async (u) => {
      try {
        const r = await fetch(u, {
          method: 'HEAD',
          headers: { 'User-Agent': o.ua || UA, Referer: 'https://mp.weixin.qq.com/' },
          signal: AbortSignal.timeout(o.timeout || 8000),
        });
        if (!r.ok) return 0;
        return Number(r.headers.get('content-length') || 0) || 0;
      } catch (e) {
        return 0;
      }
    })
  );
}

function withSizeText(img, size) {
  const n = Number(size || img.size || 0);
  return {
    url: img.url,
    fallback: img.fallback || '',
    thumb: img.thumb || img.url,
    width: img.width || 0,
    height: img.height || 0,
    size: n,
    sizeText: humanSize(n),
  };
}

/* ---------- 主入口 ----------
   输入:文章链接(或含链接的分享文案)
   输出:{ ok, kind:'images'|'article', title, url, count,
          modes:[{key,label,images:[{url,fallback,thumb,width,height,size,sizeText}],totalBytes,totalText}],
          tries } */
async function fetchArticle(text, opts) {
  const o = opts || {};
  const url = extractUrl(text);
  if (!url) {
    return { ok: false, code: 'no-url', message: '没找到公众号文章链接(mp.weixin.qq.com/s/...)' };
  }
  const tries = [];
  /* 微信偶尔会回一版"空壳"(既没有内联数据,也没有报错文案),重试一次通常就好 */
  let html = '';
  let title = '';
  let kind = 'images';
  let items = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let res = null;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': o.ua || UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Cache-Control': 'no-cache',
        },
        signal: AbortSignal.timeout(o.timeout || 25000),
      });
    } catch (e) {
      if (attempt === 2) return { ok: false, code: 'net', message: '文章请求失败:' + ((e && e.message) || e), url, tries };
      continue;
    }
    if (!res.ok) {
      if (attempt === 2) return { ok: false, code: 'http', message: '文章请求失败:HTTP ' + res.status, url, tries };
      continue;
    }
    try { html = await res.text(); } catch (e) { html = ''; }
    tries.push('页面#' + attempt + ':' + Math.round(html.length / 1024) + 'KB');
    title = parseTitle(html) || title;

    const pics = parsePictureList(html);
    if (pics) {
      kind = 'images';
      items = pics;
      tries.push('图片消息:' + items.length + ' 张(原图 ' + items.filter((i) => i.isOriginal).length + ' 张)');
      break;
    }
    kind = 'article';
    const urls = parseArticleImages(html);
    if (urls.length) {
      tries.push('正文图片:' + urls.length + ' 张');
      items = urls.map((u) => ({ url: u, fallback: '', thumb: u, width: 0, height: 0, size: 0, isOriginal: false }));
      break;
    }
    if (attempt === 1) await new Promise((r) => setTimeout(r, 800));
  }

  if (!items || !items.length) {
    const er = detectError(html);
    return {
      ok: false,
      code: er ? er.code : 'no-images',
      message: er ? er.message : '文章里没有可提取的图片(可能是纯文字或视频消息)',
      title,
      url,
      tries,
    };
  }

  /* 封面只有压缩版;和某张图路径相同时不重复加 */
  let cover = null;
  if (kind === 'images') {
    cover = await buildCover(html, o);
    const pathOf = (u) => String(u || '').split('?')[0];
    if (cover && items.some((i) => [i.url, i.fallback, i.thumb].some((u) => u && pathOf(u) === pathOf(cover.url)))) {
      cover = null;
    }
  }

  const modes = [];
  if (kind === 'article') {
    const imgs = items.map((i) => withSizeText(i, 0));
    const sizes = await headSizes(imgs.map((i) => i.url), o);
    imgs.forEach((img, i) => { img.size = sizes[i]; img.sizeText = humanSize(sizes[i]); });
    const total = sizes.reduce((a, b) => a + b, 0);
    modes.push({ key: 'article', label: '正文图片', images: imgs, totalBytes: total, totalText: humanSize(total) });
  } else {
    const origBase = items.map((i) => withSizeText(i, i.size));
    const origTotal = origBase.reduce((a, b) => a + b.size, 0) + (cover ? cover.size : 0);
    modes.push({
      key: 'original',
      label: '无水印原图',
      images: cover ? [cover].concat(origBase) : origBase,
      totalBytes: origTotal,
      totalText: humanSize(origTotal),
    });

    /* 压缩图 = 每张的 cdn_url(水印只是客户端图层,图本身是干净的) */
    const compBase = items.map((i) => withSizeText({ url: i.fallback || i.thumb || i.url, fallback: '', thumb: i.thumb || i.fallback || i.url, width: i.width, height: i.height }, 0));
    const same = compBase.every((c, i) => c.url === origBase[i].url);
    if (!same) {
      const sizes = await headSizes(compBase.map((i) => i.url), o);
      compBase.forEach((img, i) => { img.size = sizes[i]; img.sizeText = humanSize(sizes[i]); });
      const cTotal = sizes.reduce((a, b) => a + b, 0) + (cover ? cover.size : 0);
      modes.push({
        key: 'compressed',
        label: '压缩图',
        images: cover ? [cover].concat(compBase) : compBase,
        totalBytes: cTotal,
        totalText: humanSize(cTotal),
      });
    }
  }

  return {
    ok: true,
    platform: 'wechat',
    kind,
    title: title || (kind === 'images' ? '公众号图片消息' : '公众号图文'),
    url,
    count: items.length,
    hasCover: !!cover,
    modes,
    tries,
  };
}

module.exports = {
  UA,
  looksWechat,
  extractUrl,
  decodeText,
  parseTitle,
  parsePictureList,
  parseArticleImages,
  parseCover,
  detectError,
  humanSize,
  fetchArticle,
};
