/* 主界面:视频下载(B 站 / 抖音 自动识别) */
let dlRunning = false;
let dlPlatform = null; // 'bilibili' | 'douyin'
let biliVideo = null;
let biliPlay = null;
let dyVideo = null;

function detectPlatform(text) {
  const t = String(text || '');
  if (/b23\.tv/i.test(t) || /bilibili\.com/i.test(t) || /BV[0-9A-Za-z]{10}/.test(t) || /(^|[^0-9A-Za-z])av(\d{3,})/i.test(t)) return 'bilibili';
  if (/v\.douyin\.com/i.test(t) || /douyin\.com/i.test(t) || /iesdouyin/i.test(t) || /\d{16,}/.test(t)) return 'douyin';
  return null;
}

function dlStatus(text) {
  $('dlStatus').textContent = text;
}

function setDlBar(pct) {
  $('dlBar').style.width = pct + '%';
  $('dlPct').textContent = pct + '%';
}

function updatePlatformBadge() {
  const p = detectPlatform($('shareInput').value);
  const b = $('platformBadge');
  if (!p) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  b.className = 'plat-badge ' + (p === 'bilibili' ? 'badge-bili' : 'badge-dy');
  b.textContent = p === 'bilibili' ? '识别到:哔哩哔哩' : '识别到:抖音';
}

function codecName(c) {
  const p = String(c || '').split('.')[0].toLowerCase();
  return { avc1: 'H.264', hev1: 'H.265', hvc1: 'H.265', av01: 'AV1' }[p] || p || '';
}

/* 登录状态(影响 B 站可下载的最高画质) */
function setAccount(info) {
  const loggedIn = !!(info && info.loggedIn);
  if (loggedIn) {
    $('account').classList.remove('hidden');
    $('loginChipBtn').classList.add('hidden');
    $('uname').textContent = info.uname;
    if (info.face) $('avatar').src = info.face;
  } else {
    $('account').classList.add('hidden');
    $('loginChipBtn').classList.remove('hidden');
  }
}

/* ---------- 解析 ---------- */
async function parseShare() {
  if (dlRunning) return;
  const text = $('shareInput').value;
  if (!text.trim()) { dlStatus('请先粘贴分享链接'); return; }
  const p = detectPlatform(text);
  if (!p) { dlStatus('未识别到 B 站或抖音链接,请检查内容'); return; }
  dlPlatform = p;
  $('videoPanel').classList.add('hidden');
  $('biliOptions').classList.add('hidden');
  biliVideo = null; biliPlay = null; dyVideo = null;
  $('downloadBtn').disabled = true;
  try {
    if (p === 'bilibili') await parseBili(text);
    else await parseDouyin(text);
  } catch (e) {
    dlStatus('出错:' + ((e && e.message) || e));
  }
}

async function parseBili(text) {
  dlStatus('解析中…');
  const r = await window.bili.resolveVideo(text);
  if (!r || !r.ok) { dlStatus('解析失败:' + ((r && r.message) || '无响应')); return; }
  biliVideo = r;
  $('vTitle').textContent = r.title;
  $('vMeta').textContent = 'UP:' + r.owner + ' · 时长 ' + fmtDur(r.duration) + ' · ' + r.bvid;
  const ps = r.pages || [];
  if (ps.length > 1) {
    $('pageWrap').classList.remove('hidden');
    $('pageSel').innerHTML = ps.map((p2, i) => '<option value="' + i + '">P' + p2.page + ' ' + esc(p2.part) + '</option>').join('');
  } else {
    $('pageWrap').classList.add('hidden');
    $('pageSel').innerHTML = '';
  }
  $('biliOptions').classList.remove('hidden');
  $('videoPanel').classList.remove('hidden');
  await loadBiliPlayurl();
}

function currentBiliPart() {
  const pages = (biliVideo && biliVideo.pages) || [];
  if (!pages.length) return null;
  const idx = Number($('pageSel').value) || 0;
  return pages[idx] || pages[0];
}

async function loadBiliPlayurl() {
  if (!biliVideo) return;
  const part = currentBiliPart();
  if (!part) return;
  $('qualitySel').innerHTML = '<option>加载清晰度中…</option>';
  $('downloadBtn').disabled = true;
  biliPlay = null;
  const pu = await window.bili.getPlayurl(biliVideo.bvid, part.cid);
  if (!pu || !pu.ok) {
    $('qualitySel').innerHTML = '';
    dlStatus('获取清晰度失败:' + ((pu && pu.message) || '无响应'));
    return;
  }
  const vids = [...pu.videos].sort((a, b) => b.id - a.id);
  biliPlay = Object.assign({}, pu, { videos: vids });
  $('qualitySel').innerHTML = vids
    .map((v, i) => {
      const cn = codecName(v.codecs);
      return '<option value="' + i + '">' + esc(v.name) + (cn ? ' · ' + esc(cn) : '') + ' · 约 ' + v.sizeMB + ' MB</option>';
    })
    .join('');
  dlStatus('');
  $('downloadBtn').disabled = false;
}

async function parseDouyin(text) {
  dlStatus('解析链接…');
  const rr = await window.bili.resolveDyVideo(text);
  if (!rr || !rr.ok) { dlStatus('解析失败:' + ((rr && rr.message) || '无响应')); return; }
  dlStatus('已识别视频 ' + rr.id + ',正在打开视频页捕获直链…(最长 180 秒;如弹登录请扫码,如未自动播放请点击播放)');
  const cap = await window.bili.fetchDyVideo(rr.id);
  if (!cap || !cap.ok) { dlStatus('获取直链失败:' + ((cap && cap.message) || '超时')); return; }
  dyVideo = { videoUrls: cap.videoUrls, audioUrls: cap.audioUrls, title: cap.title };
  $('vTitle').textContent = cap.title;
  $('vMeta').textContent = '抖音 · ID ' + rr.id;
  $('videoPanel').classList.remove('hidden');
  dlStatus('');
  $('downloadBtn').disabled = false;
}

/* ---------- 下载 ---------- */
async function startDownload() {
  if (dlRunning) return;
  if (dlPlatform === 'bilibili') return startBiliDownload();
  if (dlPlatform === 'douyin') return startDouyinDownload();
}

async function startBiliDownload() {
  const vids = biliPlay.videos;
  const v = vids[Number($('qualitySel').value) || 0] || vids[0];
  const audios = biliPlay.audios || [];
  if (!v || !v.urls || !v.urls.length) { dlStatus('该清晰度没有可用的下载地址'); return; }
  let best = null;
  for (const a of audios) if (!best || a.bandwidth > best.bandwidth) best = a;
  if (!best || !best.urls || !best.urls.length) { dlStatus('未找到可用的音频流,无法合并'); return; }
  const part = currentBiliPart();
  let base = sanitizeName(biliVideo.title);
  if (biliVideo.pages.length > 1 && part) base += ' P' + part.page + ' ' + sanitizeName(part.part);
  let savePath = await window.bili.pickSave(base + '.mp4');
  if (!savePath) return;
  if (!/\.mp4$/i.test(savePath)) savePath += '.mp4';
  const videoTmp = savePath + '.v.part';
  const audioTmp = savePath + '.a.part';
  dlRunning = true;
  $('downloadBtn').disabled = true;
  $('parseBtn').disabled = true;
  setDlBar(0);
  dlStatus('下载视频流…');
  try {
    const r = await window.bili.downloadStreams({ key: 'cur', videoUrls: v.urls, audioUrls: best.urls, videoTmp, audioTmp });
    if (!r.ok) throw new Error(r.message);
    setDlBar(100);
    dlStatus('下载完成,正在用 ffmpeg 合并…');
    const m = await window.bili.mux({ videoTmp, audioTmp, outPath: savePath });
    if (!m.ok) throw new Error(m.message);
    dlStatus('✅ 已保存:' + savePath);
  } catch (e) {
    dlStatus('❌ 下载失败:' + ((e && e.message) || e));
  } finally {
    await window.bili.cleanup([videoTmp, audioTmp]);
    dlRunning = false;
    $('downloadBtn').disabled = false;
    $('parseBtn').disabled = false;
  }
}

async function startDouyinDownload() {
  const v = dyVideo;
  let savePath = await window.bili.pickSave(sanitizeName(v.title) + '.mp4');
  if (!savePath) return;
  if (!/\.mp4$/i.test(savePath)) savePath += '.mp4';
  dlRunning = true;
  $('downloadBtn').disabled = true;
  $('parseBtn').disabled = true;
  setDlBar(0);
  dlStatus('下载中…');
  try {
    const r = await window.bili.downloadDyVideo({ key: 'dyv', videoUrls: v.videoUrls, audioUrls: v.audioUrls, dest: savePath, title: v.title });
    if (!r.ok) throw new Error(r.message);
    setDlBar(100);
    dlStatus('✅ 已保存:' + (r.dest || savePath));
  } catch (e) {
    dlStatus('❌ 下载失败:' + ((e && e.message) || e));
  } finally {
    dlRunning = false;
    $('downloadBtn').disabled = false;
    $('parseBtn').disabled = false;
  }
}

/* ---------- 绑定 ---------- */
$('openUnfollowBtn').addEventListener('click', () => window.bili.openUnfollow());
$('loginChipBtn').addEventListener('click', () => window.bili.startLogin());
$('shareInput').addEventListener('input', updatePlatformBadge);
$('parseBtn').addEventListener('click', parseShare);
$('pageSel').addEventListener('change', loadBiliPlayurl);
$('downloadBtn').addEventListener('click', startDownload);
window.bili.onDlProgress(({ key, received, total }) => {
  const pct = total ? Math.min(100, Math.round((received / total) * 100)) : 0;
  if (['cur:v', 'cur:a', 'dyv', 'dya', 'wxv'].includes(key)) setDlBar(pct);
});
window.bili.onLoginSuccess((info) => setAccount(info));

/* ---------- 初始化 ---------- */
(async () => {
  const info = await window.bili.checkLogin();
  setAccount(info);
  try {
    const ff = await window.bili.ffmpegCheck();
    if (!ff.ok) dlStatus('⚠️ 未找到 ffmpeg,B 站视频合并将失败');
  } catch (e) {
    /* ignore */
  }
})();

/* ---------- 微信视频号(捕获 feed + 下载解密) ---------- */
let wxFeeds = [];
let wxFeedBusy = {};
let wxFeedMsg = {};
let wxStreams = [];
let wxStreamBusy = {};
let wxStreamMsg = {};
let wxCaptureCount = 0;
let wxInjectCount = 0;
let wxFeedCount = 0;
let wxPageSeen = 0;
let wxWorkerInject = 0;
/* 缩略图缓存:streamId -> dataUrl(CSP 只允许 data:/https:,所以走 base64) */
const wxThumbs = {};
const wxThumbPending = {};
/* 静默补封面/时长只尝试一次:失败后不要每次状态刷新都重跑 ffmpeg */
const wxThumbTried = {};

/* 捕获运行时后端每 600ms 推一次状态,而列表是整表重写的。
   用户正在滚动/拖动时重写会打断滚动,并把 scrollTop 清零(看起来就是"一直弹回顶部")。
   所以在列表里操作期间先挂起重绘,停手后再补一次。 */
let wxRenderHoldUntil = 0;
let wxRenderPending = false;
function wxHoldRender(ms) {
  const until = Date.now() + ms;
  if (until > wxRenderHoldUntil) wxRenderHoldUntil = until;
}

/* 秒 -> "17.3s" / "1:23" / "1:02:03" */
function fmtDur(sec) {
  const n = Number(sec) || 0;
  if (!(n > 0)) return '';
  if (n < 60) return (Math.round(n * 10) / 10) + 's';
  const t = Math.round(n);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + ss;
  return m + ':' + ss;
}

function wxStatusText(t) { $('wxStatus').textContent = t; }

function wxLogLine(line) {
  const box = $('wxLog');
  const div = document.createElement('div');
  div.textContent = String(line);
  box.appendChild(div);
  while (box.childElementCount > 80) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function fmtSize(n) {
  n = Number(n) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function renderWxFeeds() {
  const wrap = $('wxList');
  // 用户正在列表里滚动/拖动:这次先不重绘,等停手后补一次(否则会被拽回顶部)
  if (Date.now() < wxRenderHoldUntil) {
    if (!wxRenderPending) {
      wxRenderPending = true;
      setTimeout(() => {
        wxRenderPending = false;
        renderWxFeeds();
      }, Math.max(80, wxRenderHoldUntil - Date.now() + 80));
    }
    return;
  }
  // 记住当前滚动位置,重绘后恢复 —— 内容在增长,不能让它跳回顶部。
  // 光记 scrollTop 还不够:捕获时列表会重排(新流插到最前),那样即使 scrollTop
  // 不变,用户看到的内容也会整体挪一行。所以再记一个「视口顶部那条记录」当锚点,
  // 重绘后按它重新对齐。
  const prevScroll = wrap.querySelector('.wx-scroll');
  const keepTop = prevScroll ? prevScroll.scrollTop : 0;
  let anchorKey = null;
  let anchorDelta = 0;
  if (prevScroll && keepTop > 0) {
    const items = prevScroll.querySelectorAll('[data-wx-key]');
    for (let i = 0; i < items.length; i += 1) {
      const el = items[i];
      if (el.offsetTop + el.offsetHeight > keepTop) {
        anchorKey = el.getAttribute('data-wx-key');
        anchorDelta = keepTop - el.offsetTop;
        break;
      }
    }
  }
  // worker / 本地 IndexedDB 上报的条目只提供 key，没有标题/时长，不该混进可下载列表；
  // 它们的作用是把 decodeKey 关联到下面已抓到的视频流上。
  const downloadableFeeds = wxFeeds.filter((f) => f.source !== 'decrypt-worker' && f.source !== 'wx-cache-db');
  const workerKeys = wxFeeds.filter((f) => f.source === 'decrypt-worker').length;
  const dbKeys = wxFeeds.filter((f) => f.source === 'wx-cache-db').length;
  const keyCount = workerKeys + dbKeys;
  let head = '';
  if (!downloadableFeeds.length) {
    head = '<div class="muted">' +
      (wxStreams.length
        ? (keyCount
            ? '已拿到 ' + keyCount + ' 个视频的 decodeKey（解密 worker ' + workerKeys + ' + 本地缓存 ' + dbKeys + '），下方视频流可直接「补全导出」并自动解密（前 128KB 可还原）。'
            : '下面的视频流已抓到，可先合并 / 补全导出原始流；但本轮没拿到 decodeKey（导出文件前 128KB 仍是加密的，不能直接播放）。')
        : '尚未捕获到视频。') +
      ' 拿 key 的正确顺序：<b>彻底退出微信（托盘 + 任务管理器结束 WeChat.exe / WeChatAppEx.exe）→ 点「清 WebView 缓存(可恢复)」→ 启动捕获 → 再打开微信进视频号 → 播放/切换视频</b>。日志出现「[WorkerKey]」或「[CacheDbKey]」即已拿到 decodeKey。每个视频的 key 都是独立的，不会拿别的视频的 key 复用。' +
      '<br><b>标题说明</b>：视频号的 feed 数据走 mmtls 私有协议 + LiteApp 本地包，不经过 HTTPS 代理、也不落盘，所以无法自动取到中文标题；点每条右侧的「改名」可以自己命名，名字按视频标识保存，重启后仍在。' +
      '</div>';
  }
  const stats = '<div class="muted">已捕获 ' + wxCaptureCount + ' 个分片 · 重建出 ' + wxStreams.length + ' 个视频流</div>';
  let diagHint = '';
  if (!wxPageSeen) {
    diagHint = '（<b>页面/JS 请求 0 次 = 微信 WebView 命中磁盘缓存，页面根本没联网</b>；这不是漏拦域名，请先点「缓存诊断」→「清 WebView 缓存(可恢复)」，再彻底重开微信。日志中的 [直通] 只有报错上报和更新下载域名，与 feed 无关）';
  } else if (!wxWorkerInject) {
    diagHint = '（<b>页面资源已联网，但解密 worker 脚本没有经过代理改写</b>：worker_release.js 还吃着旧缓存，hook 没机会执行。请再点一次「清 WebView 缓存(可恢复)」，彻底退出微信后重开，直到日志出现 [Worker注入]）';
  } else if (!keyCount) {
    diagHint = '（解密 worker 已注入，但还没上报 seed；播放/切换一个视频触发 CUT 消息，或点「从本地缓存补 key」）';
  }
  const diag = '<div class="muted">本轮页面/JS 请求 ' + wxPageSeen + ' 次 · 页面注入 ' + wxInjectCount +
    ' 次 · worker 注入 ' + wxWorkerInject + ' 次 · 收到 Feed ' + wxFeedCount +
    ' 条 · 已拿到 key ' + keyCount + ' 个（worker ' + workerKeys + ' / 本地缓存 ' + dbKeys + '）' + diagHint + '</div>';
  const feedHtml = downloadableFeeds.map((f) => {
    const busy = !!wxFeedBusy[f.id];
    const st = wxFeedMsg[f.id] || '';
    return '<div class="cap-item" data-wx-key="feed:' + esc(f.id) + '">' +
      '<div class="cap-main">' +
        '<span class="cap-url" style="max-width:300px;font-weight:600;color:#33415e" title="' + esc(f.title || '') + '">' + esc(f.title || '(无标题)') + '</span>' +
        '<span class="cap-time">' + esc(f.nickname || '') + '</span>' +
        '<span class="cap-size">' + fmtSize(f.size) + (f.duration ? ' · ' + fmtDur(f.duration) : '') + '</span>' +
      '</div>' +
      '<div class="cap-ops">' +
        (st ? '<span class="cap-time">' + esc(st) + '</span>' : '') +
        '<button class="btn small primary" data-wxv-dl="' + esc(f.id) + '"' + (busy ? ' disabled' : '') + '>下载</button>' +
      '</div>' +
    '</div>';
  }).join('');
  const streamTitle = wxStreams.length
    ? '<div class="muted" style="margin-top:8px">已捕获的视频流（共 ' + wxStreams.length + ' 条，列表可滚动）</div>'
    : '';
  const streamHtml = wxStreams.map((s) => {
    const busy = !!wxStreamBusy[s.id];
    const st = wxStreamMsg[s.id] || '';
    // 旧记录没有 Content-Range,总长是推断出来的,不能宣称「完整」
    const state = s.complete
      ? (s.sizeKnown ? '完整' : '已抓到末尾(长度未核实)')
      : ('缺 ' + fmtSize(s.missing));
    const tag = (s.key ? '可解密' : '缺 decodeKey') + ' · ' + state + (s.canComplete ? ' · 可补全' : '');
    const thumb = wxThumbs[s.id];
    const thumbHtml = thumb
      ? '<img class="wx-thumb" src="' + thumb + '" alt="封面">'
      : '<span class="wx-thumb wx-thumb-empty">' + (s.key ? '封面' : '需 key') + '</span>';
    // 时长放在最前面:标题拿不到时,时长是最快分辨视频的特征之一
    const dur = s.durationText || fmtDur(s.duration);
    return '<div class="cap-item" data-wx-key="stream:' + esc(s.id) + '">' +
      '<div class="cap-main">' +
        thumbHtml +
        '<span class="cap-url" style="max-width:300px;font-weight:600;color:#33415e" title="' + esc(s.url || '') + '">' + esc(s.title || '(无标题)') + '</span>' +
        '<span class="cap-time">' + esc((dur ? dur + ' · ' : '') + s.parts + ' 片 · ' + tag) + '</span>' +
        '<span class="cap-size">' + fmtSize(s.covered) + ' / ' + fmtSize(s.size) + '</span>' +
      '</div>' +
      '<div class="cap-ops">' +
        (st ? '<span class="cap-time">' + esc(st) + '</span>' : '') +
        '<button class="btn small ghost" data-wxv-thb="' + esc(s.id) + '"' + (busy || !s.key ? ' disabled' : '') + '>' + (thumb ? '换封面' : '封面') + '</button>' +
        '<button class="btn small ghost" data-wxv-ren="' + esc(s.id) + '">改名</button>' +
        '<button class="btn small primary" data-wxv-sdl="' + esc(s.id) + '"' + (busy ? ' disabled' : '') + '>' + (s.canComplete ? '补全导出' : '合并导出') + '</button>' +
        '<button class="btn small ghost" data-wxv-del="' + esc(s.id) + '" title="删除这条记录及其分片文件">删除</button>' +
      '</div>' +
    '</div>';
  }).join('');
  // 记录多的时候列表会很长,收进固定 5 行高的滚动窗口里,头部统计始终可见
  const listInner = feedHtml + streamTitle + streamHtml;
  wrap.innerHTML = head + stats + diag +
    (listInner ? '<div class="wx-scroll">' + listInner + '</div>' : '');
  // 恢复滚动位置:优先按锚点记录对齐(能抵消列表重排),锚点没了就退回原 scrollTop
  if (keepTop > 0) {
    const next = wrap.querySelector('.wx-scroll');
    if (next) {
      let restored = false;
      if (anchorKey) {
        try {
          const el = next.querySelector('[data-wx-key="' + anchorKey + '"]');
          if (el) {
            next.scrollTop = Math.max(0, el.offsetTop + anchorDelta);
            restored = true;
          }
        } catch (e) { /* 选择器异常就退回 scrollTop */ }
      }
      if (!restored) next.scrollTop = keepTop;
    }
  }
  // 只对「磁盘上已有封面」的流自动补:后端命中缓存就直接回 data URL,
  // 老数据(有 .jpg 没 .json)会顺手把时长补上。没有封面的流仍由用户手动点,
  // 否则一次渲染就会同时跑几十个 ffmpeg。
  wxStreams.forEach((s) => {
    if (!s.hasThumb) return;
    if (wxThumbs[s.id] || wxThumbPending[s.id]) return;
    wxStreamThumb(s.id, true);
  });
}

async function refreshWxStatus() {
  try {
    const s = await window.bili.wxvStatus();
    wxFeeds = (s && s.feeds) || [];
    wxStreams = (s && s.streams) || [];
    wxCaptureCount = Number(s && s.captureCount) || 0;
    wxInjectCount = Number(s && s.injectCount) || 0;
    wxFeedCount = Number(s && s.feedCount) || 0;
    wxPageSeen = Number(s && s.pageSeen) || 0;
    wxWorkerInject = Number(s && s.workerInject) || 0;
    $('wxStartBtn').classList.toggle('hidden', !!(s && s.running));
    $('wxStopBtn').classList.toggle('hidden', !(s && s.running));
    renderWxFeeds();
  } catch (e) { /* ignore */ }
}

async function wxFeedDownload(id) {
  const f = wxFeeds.find((x) => x.id === id);
  if (!f || wxFeedBusy[id]) return;
  let savePath = await window.bili.pickSave('视频号_' + sanitizeName((f.title || 'video').slice(0, 40)) + '.mp4');
  if (!savePath) return;
  if (!/\.mp4$/i.test(savePath)) savePath += '.mp4';
  wxFeedBusy[id] = true;
  wxFeedMsg[id] = '下载中 0%';
  renderWxFeeds();
  try {
    const r = await window.bili.downloadWxvFeed(f, savePath);
    if (r && r.ok) {
      wxFeedMsg[id] = '✅ 已保存';
      wxStatusText('✅ 已保存(已解密):' + savePath);
    } else {
      wxFeedMsg[id] = '❌ 失败';
      wxStatusText('❌ 下载失败:' + ((r && r.message) || '未知错误'));
    }
  } catch (e) {
    wxFeedMsg[id] = '❌ 失败';
    wxStatusText('❌ 下载失败:' + ((e && e.message) || e));
  } finally {
    delete wxFeedBusy[id];
    renderWxFeeds();
  }
}

async function wxStreamDownload(id) {
  const s = wxStreams.find((x) => x.id === id);
  if (!s || wxStreamBusy[id]) return;
  let savePath = await window.bili.pickSave('视频号_' + sanitizeName((s.title || 'stream').slice(0, 40)) + '.mp4');
  if (!savePath) return;
  if (!/\.mp4$/i.test(savePath)) savePath += '.mp4';
  wxStreamBusy[id] = true;
  wxStreamMsg[id] = s.canComplete ? '补全中…' : '合并中…';
  renderWxFeeds();
  try {
    const r = await window.bili.downloadWxvStream(s, savePath);
    if (r && r.ok && r.needKey) {
      wxStreamMsg[id] = r.fetchedFull ? '已补全保存(需 key)' : '已保存(需 decodeKey)';
      wxStatusText((r.fetchedFull
        ? '✅ 已重新下载完整视频 ' + fmtSize(r.bytes) + ':'
        : '已合并保存(仅已捕获部分):') + savePath +
        '。这仍是加密流，前 128KB 需 decodeKey 才能播放。');
    } else if (r && r.ok) {
      wxStreamMsg[id] = r.isMp4 ? '✅ 已解密' : '⚠ 头非 MP4';
      wxStatusText((r.isMp4 ? '✅ 已保存(已解密):' : '⚠ 已保存但文件头不是 MP4:') + savePath);
    } else {
      wxStreamMsg[id] = '❌ 失败';
      wxStatusText('❌ 合并失败:' + ((r && r.message) || '未知错误'));
    }
  } catch (e) {
    wxStreamMsg[id] = '❌ 失败';
    wxStatusText('❌ 合并失败:' + ((e && e.message) || e));
  } finally {
    delete wxStreamBusy[id];
    renderWxFeeds();
  }
}

/* 删除单条记录:分片文件一起删,decodeKey 与自定义标题保留 */
async function wxStreamDelete(id) {
  const s = wxStreams.find((x) => x.id === id);
  if (!s) { wxStatusText('视频流已变化,请刷新后重试'); return; }
  if (!window.confirm('删除这条捕获记录？\n\n' + (s.title || '(无标题)') + '\n' +
    s.parts + ' 个分片 · ' + fmtSize(s.covered) + '\n\n' +
    '分片文件会被删除；decodeKey 与自定义标题会保留。')) return;
  try {
    const r = await window.bili.deleteWxvStream(id);
    if (r && r.ok) {
      delete wxThumbs[id];
      delete wxThumbTried[id];
      wxStatusText('✅ 已删除 ' + r.files + ' 个分片（' + fmtSize(r.bytes) + '）');
      await refreshWxStatus();
    } else {
      wxStatusText('❌ 删除失败:' + ((r && r.error) || '未知错误'));
    }
  } catch (e) {
    wxStatusText('❌ 删除失败:' + ((e && e.message) || e));
  }
}

/* 一键清除全部捕获记录 */
async function wxClearAllCaptures() {
  if (!wxStreams.length && !wxCaptureCount) { wxStatusText('当前没有捕获记录。'); return; }
  const total = wxStreams.reduce((a, s) => a + (Number(s.covered) || 0), 0);
  if (!window.confirm('清除全部捕获记录？\n\n共 ' + wxStreams.length + ' 条视频流 / ' + wxCaptureCount +
    ' 个分片（约 ' + fmtSize(total) + '）\n\n' +
    '会删除所有分片文件和已生成的封面；decodeKey 与自定义标题会保留。\n\n此操作不可撤销。')) return;
  try {
    const r = await window.bili.clearWxvCaptures();
    if (r && r.ok) {
      Object.keys(wxThumbs).forEach((k) => { delete wxThumbs[k]; });
      Object.keys(wxThumbTried).forEach((k) => { delete wxThumbTried[k]; });
      wxStatusText('✅ 已清除 ' + r.files + ' 个分片 / ' + r.thumbs + ' 张封面（' + fmtSize(r.bytes) + '）');
      await refreshWxStatus();
    } else {
      wxStatusText('❌ 清除失败:' + ((r && r.error) || '未知错误'));
    }
  } catch (e) {
    wxStatusText('❌ 清除失败:' + ((e && e.message) || e));
  }
}

/* 标题只能手动命名:feed 数据走 mmtls / LiteApp 本地包,不经过代理也不落盘 */
async function wxStreamRename(id) {
  const s = wxStreams.find((x) => x.id === id);
  if (!s) { wxStatusText('视频流已变化,请刷新后重试'); return; }
  const cur = s.customTitle ? s.title : '';
  const t = window.prompt('给这个视频起个名字（留空恢复默认名）\n' + fmtSize(s.size) + ' · ' + s.parts + ' 片', cur || '');
  if (t === null) return;
  try {
    const r = await window.bili.renameWxvStream({ id: id, title: t });
    if (r && r.ok) {
      wxStatusText(t.trim() ? '✅ 已命名:' + t.trim() : '已恢复默认名');
      await refreshWxStatus();
    } else {
      wxStatusText('❌ 改名失败:' + ((r && r.error) || '未知错误'));
    }
  } catch (e) {
    wxStatusText('❌ 改名失败:' + ((e && e.message) || e));
  }
}

/* 用首帧当封面:标题拿不到,靠画面认视频。只需要前 2MB,不用下载整个视频 */
async function wxStreamThumb(id, silent) {
  const s = wxStreams.find((x) => x.id === id);
  if (!s) { if (!silent) wxStatusText('视频流已变化,请刷新后重试'); return; }
  if (!s.key) {
    if (!silent) wxStatusText('缺 decodeKey,无法解密取帧。先播放该视频,或点「从本地缓存补 key」。');
    return;
  }
  if (wxThumbPending[id]) return;
  if (silent && wxThumbTried[id]) return; // 静默补失败的不要再跟着状态刷新反复重跑
  if (!silent) delete wxThumbTried[id];
  wxThumbPending[id] = true;
  if (!silent) wxStatusText('正在抽首帧并读取时长…');
  try {
    const r = await window.bili.thumbWxvStream(s);
    if (r && r.ok && r.dataUrl) {
      wxThumbs[id] = r.dataUrl;
      if (r.duration) {
        s.duration = r.duration;
        s.durationText = fmtDur(r.duration);
        if (r.width) s.width = r.width;
        if (r.height) s.height = r.height;
      }
      if (!silent) {
        wxStatusText(r.cached ? '封面(已缓存)' : ('✅ 封面已生成' + (r.duration ? '，时长 ' + fmtDur(r.duration) : '')));
      }
      renderWxFeeds();
    } else if (!silent) {
      wxStatusText('❌ 封面失败:' + ((r && r.error) || '未知错误'));
    }
  } catch (e) {
    if (!silent) wxStatusText('❌ 封面失败:' + ((e && e.message) || e));
  } finally {
    delete wxThumbPending[id];
    // 只有「这次没拿到封面」才标记已尝试;成功的靠 wxThumbs 有值自然不再触发
    if (silent && !wxThumbs[id]) wxThumbTried[id] = true;
  }
}

/* 第 4 条取 key 通路:从微信 WebView 的 IndexedDB 只读扫描 encfilekey->seed */
async function wxScanDbKeys() {
  const btn = $('wxDbKeyBtn');
  if (btn) btn.disabled = true;
  try {
    wxStatusText('正在扫描微信本地缓存里的 encfilekey → seed …');
    const r = await window.bili.scanWxvCacheDb();
    if (r && r.ok) {
      wxStatusText('✅ 扫描完成:新增 ' + r.added + ' 条 key（扫描 ' + r.files + ' 个 IndexedDB 文件）。只读操作，未删除任何文件。');
      await refreshWxStatus();
    } else {
      wxStatusText('❌ 扫描失败:' + ((r && r.error) || '未知错误'));
    }
  } catch (e) {
    wxStatusText('❌ 扫描失败:' + ((e && e.message) || e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

$('wxStartBtn').addEventListener('click', async () => {
  $('wxStartBtn').disabled = true;
  try {
    wxStatusText('启动捕获代理…');
    const r = await window.bili.wxvStart();
    if (!r || !r.ok) throw new Error((r && r.message) || '启动失败');
    const cert = await window.bili.wxvInstallCert();
    wxStatusText('✅ 捕获已启动(127.0.0.1:' + r.port + ')' + (cert && cert.ok ? ',证书已就绪' : ',证书未安装(可点「安装证书」重试)') + '。请完全退出微信并重新打开,然后打开视频号视频。');
  } catch (e) {
    wxStatusText('❌ 启动失败:' + ((e && e.message) || e));
  } finally {
    $('wxStartBtn').disabled = false;
    refreshWxStatus();
  }
});

$('wxStopBtn').addEventListener('click', async () => {
  try {
    const r = await window.bili.wxvStop();
    wxStatusText(r && r.ok ? '已停止捕获,系统代理已还原。微信需重新打开才能恢复正常直连。' : '停止失败:' + ((r && r.message) || ''));
  } catch (e) {
    wxStatusText('停止失败:' + ((e && e.message) || e));
  }
  refreshWxStatus();
});

$('wxCertBtn').addEventListener('click', async () => {
  const r = await window.bili.wxvInstallCert();
  wxStatusText(r && r.ok ? '✅ 证书已就绪(当前用户 · 受信任的根证书颁发机构)' : '❌ 安装失败:' + ((r && r.message) || '请先启动捕获'));
});

/* ---- 微信 WebView 缓存:只读诊断 / 可恢复清理 / 还原 ---- */
$('wxCacheInfoBtn').addEventListener('click', async () => {
  try {
    const i = await window.bili.wxvCacheInfo();
    if (!i || !i.ok) { wxStatusText('缓存诊断失败'); return; }
    wxStatusText('【缓存诊断】目录 ' + i.root + (i.exists ? '(存在)' : '(未找到)') +
      ' ｜ 可清理子目录 ' + i.targets.length + ' 个：' + (i.targets.slice(0, 6).join('、') || '无') + (i.targets.length > 6 ? ' …' : '') +
      ' ｜ 微信进程：' + (i.running.length ? '仍在运行(' + i.running.join('、') + ')，请先彻底退出' : '已全部退出 ✔') +
      ' ｜ 备份：' + (i.backups.length ? i.backups[0] : '无') +
      ' ｜ 本轮页面/JS 请求 ' + i.pageSeen + ' 次' + (i.pageSeen ? '' : '(0 次 = 页面命中磁盘缓存，需要清理)'));
  } catch (e) {
    wxStatusText('❌ 缓存诊断失败:' + ((e && e.message) || e));
  }
});

$('wxCacheClearBtn').addEventListener('click', async () => {
  let info;
  try { info = await window.bili.wxvCacheInfo(); }
  catch (e) { wxStatusText('❌ 读取缓存状态失败:' + ((e && e.message) || e)); return; }
  if (!info || !info.ok) { wxStatusText('❌ 读取缓存状态失败'); return; }
  if (info.running.length) {
    wxStatusText('❌ 微信仍在运行(' + info.running.join('、') + ')。请先彻底退出微信：右键托盘退出，必要时在任务管理器结束 WeChatAppEx.exe，然后再点清理。');
    return;
  }
  if (!info.targets.length) { wxStatusText('没有需要清理的缓存目录（可能已清理过，可点「恢复缓存」还原）。'); return; }
  const ok = window.confirm(
    '⚠️ 即将改动微信 WebView 缓存目录（可恢复，不会删除任何文件）\n\n' +
    '会把下列 ' + info.targets.length + ' 个目录重命名进一个带时间戳的备份目录，使视频号页面的 HTML / JS 必须重新联网，代理才能注入并拿到 decodeKey：\n\n' +
    '缓存根目录：' + info.root + '\n' +
    '受影响目录：\n' + info.targets.map((x) => '  · ' + x).join('\n') +
    '\n\n前提：微信已彻底退出（含托盘与 WeChatAppEx.exe）。\n恢复方式：点「恢复缓存」，从备份目录精确还原。\n\n确认继续吗？'
  );
  if (!ok) return;
  try {
    const r = await window.bili.wxvCacheClear();
    wxStatusText(r && r.ok
      ? '✅ ' + r.message + ' 备份目录：' + r.backup
      : '⚠ ' + ((r && r.message) || '清理未完成'));
    wxLogLine('[缓存] ' + ((r && r.message) || '清理未完成'));
  } catch (e) {
    wxStatusText('❌ 清理失败:' + ((e && e.message) || e));
  }
  refreshWxStatus();
});

$('wxCacheRestoreBtn').addEventListener('click', async () => {
  const info = await window.bili.wxvCacheInfo();
  if (!info || !info.backups || !info.backups.length) { wxStatusText('没有可恢复的备份。'); return; }
  if (!window.confirm('从最近一次备份 ' + info.backups[0] + ' 还原缓存目录？\n需要微信已彻底退出；微信重启后已重建的同名目录会跳过，不会被覆盖。')) return;
  try {
    const r = await window.bili.wxvCacheRestore();
    wxStatusText(r && r.ok ? '✅ 已还原 ' + (r.restored || []).length + ' 个目录' : '⚠ 还原未完成:' + ((r && r.message) || ''));
  } catch (e) {
    wxStatusText('❌ 还原失败:' + ((e && e.message) || e));
  }
  refreshWxStatus();
});

$('wxDbKeyBtn').addEventListener('click', wxScanDbKeys);
$('wxClearAllBtn').addEventListener('click', wxClearAllCaptures);

/* 列表交互期间挂起重绘,避免捕获运行时被反复拽回顶部。
   只监听滚动相关事件:点击按钮不应被拖延,而拖滚动条本身就会产生 scroll。
   scroll 事件不冒泡,必须用捕获阶段才能收到子容器 .wx-scroll 的滚动。 */
(function () {
  const wrap = $('wxList');
  wrap.addEventListener('wheel', () => wxHoldRender(700), { passive: true });
  wrap.addEventListener('touchstart', () => wxHoldRender(700), { passive: true });
  wrap.addEventListener('touchmove', () => wxHoldRender(700), { passive: true });
  wrap.addEventListener('scroll', () => wxRenderHoldUntil = Math.max(wxRenderHoldUntil, Date.now() + 700), true);
})();

$('wxList').addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.getAttribute) return;
  const dl = t.getAttribute('data-wxv-dl');
  if (dl) { wxFeedDownload(dl); return; }
  const ren = t.getAttribute('data-wxv-ren');
  if (ren) { wxStreamRename(ren); return; }
  const thb = t.getAttribute('data-wxv-thb');
  if (thb) { wxStreamThumb(thb); return; }
  const del = t.getAttribute('data-wxv-del');
  if (del) { wxStreamDelete(del); return; }
  const sdl = t.getAttribute('data-wxv-sdl');
  if (sdl) wxStreamDownload(sdl);
});

window.bili.onWxvFeed((item) => {
  if (!item || !item.id) return;
  const idx = wxFeeds.findIndex((x) => x.id === item.id);
  if (idx >= 0) wxFeeds[idx] = item;
  else wxFeeds.unshift(item);
  if (wxFeeds.length > 100) wxFeeds.pop();
  renderWxFeeds();
});
window.bili.onWxvLog((line) => wxLogLine(line));
window.bili.onWxvStatus(() => refreshWxStatus());
window.bili.onDlProgress(({ key, received, total }) => {
  if (key !== 'wxv') return;
  const id = Object.keys(wxFeedBusy).find((k) => wxFeedBusy[k]);
  if (!id) return;
  const pct = total ? Math.min(99, Math.round((received / total) * 100)) : 0;
  const msg = '下载中 ' + pct + '%';
  if (wxFeedMsg[id] !== msg) { wxFeedMsg[id] = msg; renderWxFeeds(); }
});
refreshWxStatus();

/* ============================================================
 * 微信表情包导出
 * ============================================================ */
const emojiState = { ready: false, wxid: '', outDir: '', running: false };

function emojiLog(line) {
  const el = $('emojiLog');
  const time = new Date().toTimeString().slice(0, 8);
  el.textContent += `[${time}] ${line}\n`;
  const lines = el.textContent.split('\n');
  if (lines.length > 400) el.textContent = lines.slice(-260).join('\n');
  el.scrollTop = el.scrollHeight;
}

function emojiStatusText(html) {
  $('emojiStatus').innerHTML = html;
}

function emojiSetBar(stage, done, total) {
  const wrap = $('emojiProgressWrap');
  if (!stage) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  if (stage === 'download') {
    const pct = total ? Math.min(99, Math.round((done / total) * 100)) : 0;
    $('emojiStage').textContent = '下载工具';
    $('emojiBar').style.width = pct + '%';
    $('emojiPct').textContent = pct + '%';
  } else if (stage === 'list') {
    $('emojiStage').textContent = '解析表情';
    $('emojiBar').style.width = '4%';
    $('emojiPct').textContent = total ? total + ' 个' : '';
  } else if (stage === 'export') {
    const pct = total ? Math.min(99, Math.round((done / total) * 100)) : 0;
    $('emojiStage').textContent = '导出中';
    $('emojiBar').style.width = Math.max(4, pct) + '%';
    $('emojiPct').textContent = total ? `${done}/${total}` : done + ' 个';
  } else if (stage === 'done') {
    $('emojiBar').style.width = '100%';
    $('emojiPct').textContent = '';
  }
}

function emojiSetRunning(run) {
  emojiState.running = run;
  $('emojiExportBtn').disabled = run || !emojiState.ready;
  $('emojiCheckBtn').disabled = run;
  $('emojiStopBtn').classList.toggle('hidden', !run);
}

async function emojiCheck() {
  emojiStatusText('正在检测…');
  try {
    const st = await window.bili.emojiStatus();
    if (!st.tool || !st.tool.found) {
      emojiState.ready = false;
      emojiStatusText('未安装导出工具,正在自动下载 wxemoticon(约 3.7MB,GitHub 直连可能较慢)…');
      emojiLog('未找到 wxemoticon,开始自动下载安装…');
      const r = await window.bili.emojiInstall('auto');
      if (!r || !r.ok) {
        emojiStatusText('自动安装失败:' + esc((r && r.message) || '') + '<br>可手动下载 zip 后点「从本地 zip 安装」。');
        emojiLog('自动安装失败:' + ((r && r.message) || ''));
        return;
      }
      emojiState.ready = true;
    } else {
      emojiState.ready = true;
      emojiLog('找到 wxemoticon ' + st.tool.version + ' @ ' + st.tool.path);
    }
    const acc = await window.bili.emojiAccounts();
    const sel = $('emojiAccount');
    sel.innerHTML = '';
    if (acc && acc.ok && acc.accounts && acc.accounts.length) {
      for (const id of acc.accounts) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        sel.appendChild(opt);
      }
      sel.classList.toggle('hidden', acc.accounts.length < 2);
      emojiState.wxid = acc.accounts.length === 1 ? acc.accounts[0] : sel.value;
    } else {
      sel.classList.add('hidden');
      emojiState.wxid = '';
      emojiLog('未检测到微信账号数据(xwechat_files),请确认微信在本机登录过');
    }
    const ver = await window.bili.emojiStatus();
    emojiStatusText(
      `<span style="color:#1db954">就绪:</span>wxemoticon ${esc(ver.tool.version)} · 账号 ${acc && acc.accounts ? acc.accounts.length : 0} 个` +
      `<br>默认导出到系统「下载」文件夹;也可点「选择导出目录」指定。`
    );
    $('emojiExportBtn').disabled = emojiState.running;
  } catch (e) {
    emojiState.ready = false;
    emojiStatusText('检测失败:' + esc((e && e.message) || e));
    emojiLog('检测失败:' + ((e && e.message) || e));
  }
}

$('emojiCheckBtn').addEventListener('click', emojiCheck);

$('emojiZipBtn').addEventListener('click', async () => {
  emojiLog('选择手动下载的 wxemoticon-x86_64-windows.zip…');
  const r = await window.bili.emojiInstall('zip');
  if (r && r.ok) {
    emojiState.ready = true;
    emojiStatusText(`<span style="color:#1db954">就绪:</span>wxemoticon ${esc(r.version)}(本地安装)`);
  } else {
    emojiLog('本地安装失败:' + ((r && r.message) || ''));
  }
});

$('emojiAccount').addEventListener('change', () => {
  emojiState.wxid = $('emojiAccount').value;
});

$('emojiPickDirBtn').addEventListener('click', async () => {
  const dir = await window.bili.emojiPickDir();
  if (dir) {
    emojiState.outDir = dir;
    $('emojiOutDir').textContent = '导出到:' + dir;
  }
});

$('emojiExportBtn').addEventListener('click', async () => {
  if (emojiState.running || !emojiState.ready) return;
  emojiSetRunning(true);
  emojiSetBar('list', 0, 0);
  emojiLog('开始导出…(首次需要从微信读取数据库密钥,约几秒到几十秒)');
  try {
    const r = await window.bili.emojiExport({
      wxid: emojiState.wxid || undefined,
      outDir: emojiState.outDir || undefined,
      flat: $('emojiFlat').checked,
    });
    if (r && r.ok) {
      emojiSetBar('done');
      emojiStatusText('✅ ' + esc(r.message || '完成'));
      if (r.outDir) {
        emojiState.lastDir = r.outDir;
        $('emojiOutDir').textContent = '导出到:' + r.outDir;
        $('emojiOpenBtn').classList.remove('hidden');
      }
    } else if (r && r.stopped) {
      emojiSetBar(null);
      emojiStatusText('已停止。再次导出会自动跳过已下载的表情。');
    } else {
      emojiSetBar(null);
      emojiStatusText('❌ ' + esc((r && r.message) || '导出失败'));
    }
  } catch (e) {
    emojiSetBar(null);
    emojiStatusText('❌ 异常:' + esc((e && e.message) || e));
    emojiLog('异常:' + ((e && e.message) || e));
  } finally {
    emojiSetRunning(false);
  }
});

$('emojiStopBtn').addEventListener('click', () => {
  emojiLog('正在停止…');
  window.bili.emojiStop();
});

$('emojiOpenBtn').addEventListener('click', () => {
  const dir = emojiState.lastDir || emojiState.outDir;
  if (dir) window.bili.emojiOpen(dir);
});

window.bili.onEmojiLog((line) => emojiLog(line));
window.bili.onEmojiProgress((p) => {
  if (p && p.stage) emojiSetBar(p.stage, p.done || p.received, p.total);
});
window.bili.onEmojiDone((r) => {
  if (r && r.ok) {
    emojiSetBar('done');
    emojiStatusText('✅ ' + esc(r.message || '完成'));
    if (r.outDir) {
      emojiState.lastDir = r.outDir;
      $('emojiOpenBtn').classList.remove('hidden');
    }
  }
  emojiSetRunning(false);
});

