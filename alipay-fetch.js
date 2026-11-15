/* ============================================================
 * 支付宝「生活号 / 视频号」内容解析(纯 HTTPS,不建窗口)
 *
 * 为什么单独一个模块:
 *   这类分享链接(常见形态是 ur.lepudding.com、t.alipay.com 之类的短链)
 *   302 之后落到 render.alipay.com/p/yuyan/<id>/video-share.html,
 *   是支付宝的内容分享页。它跟抖音/B站完全不是一回事:
 *   没有 _ROUTER_DATA、没有 window 可拦,只有一条 SOFA 网关的 JSON 接口。
 *
 * 整条链路(实测 2026-11):
 *   1) 短链 302 -> Location 里带 contentId(注意是被 URL 编码了 2~3 层的)
 *   2) POST webgw-internet.alipay.com/.../ContentWebGWController.list
 *      body 只有 {"contentId":"..."},header 带 x-webgw-appId / x-webgw-version
 *   3) 返回 resultObj.data[0].video.vid =
 *      http://gw.alipayobjects.com/v/open_content/afts/video/<djangoId>/720P_h265?t=<token>
 *      —— 清晰度就在路径里,换成 origin/1080P_h264/720P_h265 都能取到
 *
 * 两个实测结论(别改回去):
 *   · 去掉 ?t=<token> 直接 403,所以必须走接口拿 token;
 *     但 token 是稳定的(同一作品反复调接口返回同一个 t=),不用定时刷新。
 *   · 直链不校验 UA / Referer / Cookie,拿到底址就能下。
 *
 * 本模块不依赖 electron,可直接用 node 跑:
 *   node -e "require('./alipay-fetch').fetchWork('<链接>').then(console.log)"
 * ============================================================ */

const WEBGW_URL =
  'https://webgw-internet.alipay.com/contentservice/com.alipay.sofa.function.SOFAFunction/apply/' +
  'myjf.yuyan.contentservice.default.ContentWebGWController.list';

const APP_ID = '180020010001266490';
const VIDEO_BASE = 'https://gw.alipayobjects.com/v/open_content/afts/video/';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/* 清晰度候选。顺序即优先级:
   1080P_h264 排第一是有意的 —— Windows 默认不带 HEVC 解码器,
   默认给 H.265 会在部分机器上"下得下来、放不出来"。 */
const CLARITIES = [
  { key: '1080P_h264', label: '1080P · H.264', rank: 100 },
  { key: 'origin', label: '原始画质', rank: 95 },
  { key: '1080P_h265', label: '1080P · H.265', rank: 90 },
  { key: '720P_h264', label: '720P · H.264', rank: 70 },
  { key: '720P_h265', label: '720P · H.265', rank: 60 },
  { key: '480P_h265', label: '480P · H.265', rank: 40 },
];

/* ---------- 1. 取 contentId ---------- */

/* 短链的 Location 里,contentId 常常被 encode 了两三层
   (形如 contentId%253D2026...),所以要反复解到解不动为止。 */
function decodeDeep(s, rounds) {
  let t = String(s || '');
  const n = rounds || 4;
  for (let i = 0; i < n; i += 1) {
    let d = t;
    try { d = decodeURIComponent(t); } catch (e) { break; }
    if (d === t) break;
    t = d;
  }
  return t;
}

function findContentId(text) {
  const raw = String(text || '');
  const forms = [raw, decodeDeep(raw)];
  for (const f of forms) {
    let m = f.match(/contentId(?:=|%3D|%253D)([0-9A-Za-z]{12,})/i);
    if (m) return m[1];
  }
  // 用户可能只粘了一串 contentId(8 位日期 + OB + 数字,或纯数字长串)
  const m = raw.trim().match(/^([0-9]{8}[A-Za-z]{2}[0-9A-Za-z]{8,})$/);
  return m ? m[1] : null;
}

function looksAlipay(text) {
  const t = String(text || '');
  return /alipay\.com/i.test(t) || /alipays:/i.test(t) || /contentId=/i.test(t);
}

/* ---------- 2. 跟随短链 ---------- */

/* 用 redirect:'manual' 逐跳跟,而不是 redirect:'follow':
   要把每一跳的 Location 都摸一遍 —— 有的短链最后一跳是 alipays:// 唤起
   App 的 scheme,node 的 fetch 跟不了,但 contentId 在前几跳的 Location
   里就已经出现了。 */
async function followShortLink(url, opts) {
  const o = opts || {};
  const ua = o.ua || MOBILE_UA;
  const max = o.maxHops || 6;
  let cur = String(url || '');
  const chain = [];
  for (let i = 0; i < max; i += 1) {
    chain.push(cur);
    const id = findContentId(cur);
    if (id) return { ok: true, contentId: id, finalUrl: cur, chain };
    let res = null;
    try {
      res = await fetch(cur, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': ua, 'Accept-Language': 'zh-CN,zh;q=0.9' },
        signal: AbortSignal.timeout(o.timeout || 15000),
      });
    } catch (e) {
      return { ok: false, code: 'net', message: '短链请求失败:' + ((e && e.message) || e), chain };
    }
    const loc = res.headers.get('location') || '';
    if (!loc) {
      /* 没有 Location 说明已经到终点,或者是个需要 JS 渲染的落地页。
         把响应体也扫一遍,免得 contentId 只出现在 HTML 里。 */
      let body = '';
      try { body = await res.text(); } catch (e) { body = ''; }
      const fromBody = findContentId(body);
      if (fromBody) return { ok: true, contentId: fromBody, finalUrl: cur, chain, httpStatus: res.status };
      return { ok: false, code: 'no-redirect', message: '短链没有跳转到支付宝内容页', finalUrl: cur, chain, httpStatus: res.status };
    }
    cur = new URL(loc, cur).toString();
  }
  const last = findContentId(cur);
  if (last) return { ok: true, contentId: last, finalUrl: cur, chain };
  return { ok: false, code: 'too-many-hops', message: '短链跳转层数过多', finalUrl: cur, chain };
}

/* ---------- 3. 调详情接口 ---------- */

async function fetchDetail(contentId, opts) {
  const o = opts || {};
  const id = String(contentId || '').trim();
  if (!id) return { ok: false, code: 'no-id', message: '缺少 contentId' };
  let res = null;
  try {
    res = await fetch(WEBGW_URL, {
      method: 'POST',
      headers: {
        'x-webgw-appId': APP_ID,
        'x-webgw-version': '2.0',
        'Content-Type': 'application/json',
        Origin: 'https://render.alipay.com',
        Referer: 'https://render.alipay.com/',
        'User-Agent': o.ua || MOBILE_UA,
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      body: JSON.stringify({ contentId: id }),
      signal: AbortSignal.timeout(o.timeout || 15000),
    });
  } catch (e) {
    return { ok: false, code: 'net', message: '接口请求失败:' + ((e && e.message) || e) };
  }
  let j = null;
  try { j = await res.json(); } catch (e) { j = null; }
  if (!j) return { ok: false, code: 'bad-json', message: '接口返回非 JSON(HTTP ' + res.status + ')' };
  if (!j.success) {
    return { ok: false, code: 'api', message: String(j.errorMessage || '接口报错'), errorCode: j.errorCode || '' };
  }
  const d = (j.resultObj && j.resultObj.data && j.resultObj.data[0]) || null;
  if (!d) return { ok: false, code: 'empty', message: '作品不存在或已删除' };
  return { ok: true, data: d, httpStatus: res.status };
}

/* ---------- 4. 从 video.vid 拆出 djangoId / 清晰度 / token ---------- */

/* 形如 https://gw.alipayobjects.com/v/open_content/afts/video/<djangoId>/720P_h265?t=xxx
   djangoId 里带 "*",直接拼进路径即可(实测不编码也能取)。 */
function parseVid(vidUrl) {
  const s = String(vidUrl || '');
  const m = s.match(/\/video\/([^/]+)\/([^/?#]+)(?:\?([^#]*))?/);
  if (!m) return null;
  return { djangoId: m[1], clarity: m[2], token: m[3] || '', raw: s };
}

function buildUrl(djangoId, clarity, token) {
  const base = VIDEO_BASE + djangoId + '/' + clarity;
  return token ? base + '?' + token : base;
}

/* 并发 HEAD 一遍所有清晰度,只留下真能取到的。
   为什么不直接用接口给的 720P:接口固定回 720P_h265,
   但同一条视频往往有 1080P/origin,换后缀就能拿到。 */
async function probeQualities(parsed, opts) {
  const o = opts || {};
  if (!parsed || !parsed.djangoId) return [];
  const list = await Promise.all(
    CLARITIES.map(async (c) => {
      const url = buildUrl(parsed.djangoId, c.key, parsed.token);
      try {
        const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(o.timeout || 12000) });
        const len = Number(r.headers.get('content-length') || 0);
        if (r.status !== 200 || !len) return null;
        const ct = String(r.headers.get('content-type') || '');
        if (ct && !/video|octet-stream/i.test(ct)) return null;
        return { key: c.key, label: c.label, rank: c.rank, url, size: len, isHevc: /h265|hev/i.test(c.key) };
      } catch (e) {
        return null;
      }
    })
  );
  const sorted = list.filter(Boolean).sort((a, b) => b.rank - a.rank);
  /* 按体积去重:origin 与 1080P_h264 常常是同一个源(体积一模一样),
     留着会出现两个 "30.5 MB" 让用户困惑;保留 rank 高的那个。 */
  const seen = new Set();
  return sorted.filter((q) => {
    if (seen.has(q.size)) return false;
    seen.add(q.size);
    return true;
  });
}

function humanSize(bytes) {
  const n = Number(bytes || 0);
  if (!n) return '';
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}

/* ---------- 5. 对外主入口 ---------- */

/* 输入「短链 / 分享文案 / contentId」,输出可直接下载的作品信息:
   { ok, contentId, kind, title, author, cover, duration, width, height,
     qualities:[{key,label,url,size,sizeMB,isHevc}], videoUrls:[默认最优先...] } */
async function fetchWork(text, opts) {
  const o = opts || {};
  const tries = [];

  let contentId = findContentId(text);
  let chain = [];
  let finalUrl = '';
  if (!contentId) {
    const url = (String(text || '').match(/https?:\/\/[^\s"'<>]+/) || [])[0];
    if (!url) return { ok: false, code: 'no-url', message: '没找到链接或 contentId' };
    const r = await followShortLink(url, o);
    chain = r.chain || [];
    finalUrl = r.finalUrl || '';
    tries.push('短链:' + (r.ok ? 'ok' : r.code || 'fail') + ' 跳数=' + chain.length);
    if (!r.ok) {
      return { ok: false, code: r.code, message: r.message || '短链解析失败', chain, finalUrl, tries };
    }
    contentId = r.contentId;
  }

  const det = await fetchDetail(contentId, o);
  tries.push('详情:' + (det.ok ? 'ok' : det.code + '/' + det.message));
  if (!det.ok) return { ok: false, code: det.code, message: det.message, contentId, chain, finalUrl, tries };

  const d = det.data;
  const video = d.video || {};
  const parsed = parseVid(video.vid);
  if (!parsed) {
    /* 不是视频(图集/图文/直播回放等)。字段结构还没摸清,
       这里如实报出来,不猜。 */
    return {
      ok: false,
      code: 'not-video',
      message: d.type === 'video' ? '接口没给视频地址' : '暂不支持这种内容类型(' + (d.type || '未知') + ')',
      contentId,
      contentType: d.type || '',
      title: String(d.title || d.content || ''),
      chain,
      finalUrl,
      tries,
    };
  }

  const qualities = await probeQualities(parsed, o);
  tries.push('清晰度:' + qualities.map((q) => q.key).join(',') || '无');

  /* 一个都探不到(通常是 token 变化/风控)时,至少把接口给的原始地址交出去 */
  const list = qualities.length
    ? qualities
    : [{ key: parsed.clarity, label: parsed.clarity, url: parsed.raw, size: 0, isHevc: /h265/i.test(parsed.clarity) }];

  for (const q of list) {
    q.sizeMB = q.size ? Number((q.size / 1024 / 1024).toFixed(1)) : 0;
    q.sizeText = humanSize(q.size);
  }

  const cover = (d.coverPic && d.coverPic.url) || (video.firstFramePic && video.firstFramePic.url) || '';
  const author = (d.author && (d.author.nickName || d.author.name)) || '';

  return {
    ok: true,
    contentId,
    kind: 'video',
    platform: 'alipay',
    title: String(d.title || d.content || ('支付宝视频 ' + contentId)).trim().slice(0, 120),
    author,
    cover,
    duration: Number(video.duration || 0),
    width: Number(video.widthRatio || 0),
    height: Number(video.heightRatio || 0),
    qualities: list.map((q) => ({ key: q.key, label: q.label, url: q.url, size: q.size, sizeMB: q.sizeMB, sizeText: q.sizeText, isHevc: q.isHevc })),
    // 下载端按顺序回退:第一个失败就试下一个
    videoUrls: list.map((q) => q.url),
    defaultQuality: list[0] ? list[0].key : '',
    chain,
    finalUrl,
    tries,
  };
}

module.exports = {
  MOBILE_UA,
  WEBGW_URL,
  CLARITIES,
  decodeDeep,
  findContentId,
  looksAlipay,
  followShortLink,
  fetchDetail,
  parseVid,
  buildUrl,
  probeQualities,
  humanSize,
  fetchWork,
};
