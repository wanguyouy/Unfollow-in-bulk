/* 主界面:视频下载(B 站 / 抖音 / 支付宝 / Telegram / 公众号 自动识别) */
let dlRunning = false;
let dlPlatform = null; // 'bilibili' | 'douyin' | 'alipay' | 'telegram' | 'wechat'
let biliVideo = null;
let biliPlay = null;
let dyVideo = null;
let apVideo = null;
let tgVideo = null;
let wxArticle = null;

function detectPlatform(text) {
  const t = String(text || '');
  /* 公众号文章:图片消息的无水印原图藏在页面内联数据里,单独一条链路 */
  if (/mp\.weixin\.qq\.com\/s[/?]/i.test(t) || /weixin\.qq\.com\/s\//i.test(t)) return 'wechat';
  /* Telegram 排最前:t.me 的帖号很短(几位到十来位),
     放着不管也会被下面的抖音 \d{16,} 之类误判的可能性不大,但先判更稳。 */
  if (/(?:^|[/.\s])(?:t|telegram)\.me\//i.test(t) || /tg:\/\/resolve/i.test(t)) return 'telegram';
  // 支付宝必须排在抖音之前:contentId 里的数字段(18 位)会命中下面的 \d{16,}
  // 裸 contentId(8 位日期 + 2 位大写字母 + 数字,如 20261113OB02…)单独认一下,
  // 否则会被当成抖音的作品 ID
  if (/alipay\.com/i.test(t) || /alipays:/i.test(t) || /contentId=/i.test(t)) return 'alipay';
  if (/^\s*\d{8}[A-Za-z]{2}\d{8,}\s*$/.test(t)) return 'alipay';
  if (/b23\.tv/i.test(t) || /bilibili\.com/i.test(t) || /BV[0-9A-Za-z]{10}/.test(t) || /(^|[^0-9A-Za-z])av(\d{3,})/i.test(t)) return 'bilibili';
  if (/v\.douyin\.com/i.test(t) || /douyin\.com/i.test(t) || /iesdouyin/i.test(t) || /\d{16,}/.test(t)) return 'douyin';
  return null;
}

function dlStatus(text) {
  $('dlStatus').textContent = text;
  /* 解析阶段 #dlStatus 还藏在 hidden 的 #videoPanel 里,写在它上面等于没提示
     (短链要跟 302、抖音要开窗口,都可能等好几秒)。
     面板没露出来时,同步写到面板外的 #parseStatus。 */
  const ps = $('parseStatus');
  if (ps) ps.textContent = $('videoPanel').classList.contains('hidden') ? text : '';
}

function setDlBar(pct) {
  $('dlBar').style.width = pct + '%';
  $('dlPct').textContent = pct + '%';
}

function updatePlatformBadge() {
  // 看不出平台(多半是第三方短链)—— 等点了「解析」再跟 302 去嗅探
  updatePlatformBadgeFor(detectPlatform($('shareInput').value));
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
  let text = $('shareInput').value;
  if (!text.trim()) { dlStatus('请先粘贴分享链接'); return; }
  let p = detectPlatform(text);
  $('videoPanel').classList.add('hidden');
  $('biliOptions').classList.add('hidden');
  biliVideo = null; biliPlay = null; dyVideo = null; apVideo = null; tgVideo = null; wxArticle = null;
  $('downloadBtn').disabled = true;
  try {
    if (!p) {
      /* 域名看不出来(ur.lepudding.com 这类第三方短链):
         先跟 302 看落到哪个平台,再分发。 */
      dlStatus('识别短链…');
      const s = await window.bili.sniffShare(text);
      if (!s || !s.ok) { dlStatus('未识别:' + ((s && s.message) || '短链没指向支持的平台')); return; }
      p = s.platform;
      if (p === 'alipay' && s.contentId) text = s.contentId;
      if (p === 'telegram' && s.text) text = s.text;
      updatePlatformBadgeFor(p);
    }
    dlPlatform = p;
    if (p === 'bilibili') await parseBili(text);
    else if (p === 'alipay') await parseAlipay(text);
    else if (p === 'telegram') await parseTelegram(text);
    else if (p === 'wechat') await parseWechat(text);
    else await parseDouyin(text);
  } catch (e) {
    dlStatus('出错:' + ((e && e.message) || e));
  }
}

function updatePlatformBadgeFor(p) {
  const b = $('platformBadge');
  if (!p) { b.classList.add('hidden'); return; }
  const meta = {
    bilibili: ['badge-bili', '识别到:哔哩哔哩'],
    alipay: ['badge-ap', '识别到:支付宝'],
    telegram: ['badge-tg', '识别到:Telegram'],
    wechat: ['badge-wx', '识别到:微信公众号'],
    douyin: ['badge-dy', '识别到:抖音'],
  }[p] || ['badge-dy', '识别到:抖音'];
  b.classList.remove('hidden');
  b.className = 'plat-badge ' + meta[0];
  b.textContent = meta[1];
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
  renderImgStrip([]);
  $('downloadBtn').textContent = '选择保存位置并下载';
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
  dlStatus('正在解析作品…（图文一般 5~10 秒）');
  const cap = await window.bili.fetchDyVideo(rr.id, rr.kind || '');
  if (!cap || !cap.ok) { dlStatus('获取内容失败:' + ((cap && cap.message) || '超时')); return; }
  $('videoPanel').classList.remove('hidden');
  $('biliOptions').classList.add('hidden');
  if (cap.kind === 'images') {
    dyVideo = { kind: 'images', images: cap.images, title: cap.title };
    $('vTitle').textContent = cap.title;
    $('vMeta').textContent = '抖音图集 · ' + cap.images.length + ' 张';
    renderImgStrip(cap.images);
    $('downloadBtn').textContent = '选择文件夹并保存图集';
  } else {
    dyVideo = { kind: 'video', videoUrls: cap.videoUrls, audioUrls: cap.audioUrls, title: cap.title };
    $('vTitle').textContent = cap.title;
    $('vMeta').textContent = '抖音 · ID ' + rr.id;
    renderImgStrip([]);
    $('downloadBtn').textContent = '选择保存位置并下载';
  }
  dlStatus('');
  $('downloadBtn').disabled = false;
}

/* 支付宝(生活号 / 视频号):一条 JSON 接口就出结果,不用开窗口,通常 1~2 秒 */
async function parseAlipay(text) {
  dlStatus('解析中…');
  const r = await window.bili.fetchAlipay(text);
  if (!r || !r.ok) { dlStatus('解析失败:' + ((r && r.message) || '无响应')); return; }
  const qs = r.qualities || [];
  apVideo = { title: r.title, qualities: qs, videoUrls: r.videoUrls || [] };

  $('videoPanel').classList.remove('hidden');
  $('vTitle').textContent = r.title || '支付宝视频';
  const meta = ['支付宝'];
  if (r.author) meta.push(r.author);
  if (r.duration) meta.push(fmtDur(r.duration));
  if (r.width && r.height) meta.push(r.width + '×' + r.height);
  $('vMeta').textContent = meta.join(' · ');
  renderImgStrip([]);

  // 清晰度下拉复用 B 站那一格;分 P 那格对支付宝无意义,藏掉
  $('pageWrap').classList.add('hidden');
  if (qs.length) {
    $('biliOptions').classList.remove('hidden');
    $('qualitySel').innerHTML = qs
      .map((q, i) => '<option value="' + i + '">' + esc(q.label) + (q.sizeText ? ' · 约 ' + esc(q.sizeText) : '') + '</option>')
      .join('');
  } else {
    $('biliOptions').classList.add('hidden');
    $('qualitySel').innerHTML = '';
  }
  $('downloadBtn').textContent = '选择保存位置并下载';
  dlStatus('');
  $('downloadBtn').disabled = false;
}

/* 公众号图文 / 图片消息:图片消息的无水印原图在 original_info 里,
   页面上的水印只是客户端叠的图层 —— 原图和压缩图本身都是干净的。 */
async function parseWechat(text) {
  dlStatus('解析中…');
  const r = await window.bili.fetchWechatArticle(text);
  if (!r || !r.ok) { dlStatus('解析失败:' + ((r && r.message) || '无响应')); return; }
  wxArticle = r;
  const modes = r.modes || [];
  const first = modes[0] || { images: [] };
  $('videoPanel').classList.remove('hidden');
  $('vTitle').textContent = r.title || '公众号图集';
  const meta = ['公众号', r.kind === 'images' ? '图片消息' : '图文', r.count + ' 张'];
  if (r.hasCover) meta.push('含封面');
  if (first.totalText) meta.push('约 ' + first.totalText);
  $('vMeta').textContent = meta.join(' · ');
  renderImgStrip((first.images || []).map((it) => [it.thumb || it.url]));
  // 分 P 那格对公众号没意义;「清晰度」这一格改成 原图 / 压缩图 两档
  $('pageWrap').classList.add('hidden');
  if (modes.length) {
    $('biliOptions').classList.remove('hidden');
    $('qualitySel').innerHTML = modes
      .map((m, i) => '<option value="' + i + '">' + esc(m.label) + (m.totalText ? ' · 约 ' + esc(m.totalText) : '') + '</option>')
      .join('');
  } else {
    $('biliOptions').classList.add('hidden');
    $('qualitySel').innerHTML = '';
  }
  $('downloadBtn').textContent = '选择文件夹并保存图集';
  dlStatus('');
  $('downloadBtn').disabled = false;
}

/* Telegram 公开频道帖:一条 widget 页就出结果。
   注意它和别的平台最大的不同 —— 能不能解析取决于频道有没有开网页预览,
   关了的频道匿名一律拿不到(渲染层只能如实转述). */
async function parseTelegram(text) {
  dlStatus('解析中…(需要代理能连上 Telegram)');
  const r = await window.bili.fetchTelegram(text);
  if (!r || !r.ok) {
    /* 公开解析失败 → 自动回退 MTProto（用本机已登录的 Telegram Desktop 授权） */
    dlStatus('公开网页拿不到（' + ((r && r.message) || '无响应') + '），改用本机登录态走 MTProto…');
    return parseTelegramMt(text);
  }
  tgVideo = r;
  $('videoPanel').classList.remove('hidden');
  $('vTitle').textContent = r.title || 'Telegram';
  const meta = ['Telegram'];
  if (r.author) meta.push(r.author);
  if (r.duration) meta.push(fmtDur(r.duration));
  if (r.width && r.height) meta.push(r.width + '×' + r.height);
  $('vMeta').textContent = meta.join(' · ');
  // 视频帖显示封面,图片帖显示那张图(顺便当"点对了"的确认)
  renderImgStrip(r.kind === 'photo' ? (r.images || []).map((i) => i.urls) : r.cover ? [[r.cover]] : []);

  // 分 P 那格对 Telegram 没意义,藏掉;清晰度只有「原始文件」一档
  $('pageWrap').classList.add('hidden');
  const qs = r.qualities || [];
  if (r.kind === 'video' && qs.length) {
    $('biliOptions').classList.remove('hidden');
    $('qualitySel').innerHTML = qs
      .map((q, i) => '<option value="' + i + '">' + esc(q.label) + (q.sizeText ? ' · 约 ' + esc(q.sizeText) : '') + '</option>')
      .join('');
  } else {
    $('biliOptions').classList.add('hidden');
    $('qualitySel').innerHTML = '';
  }
  $('downloadBtn').textContent = r.kind === 'photo' ? '保存图片' : '选择保存位置并下载';
  dlStatus('');
  $('downloadBtn').disabled = false;
}

/* 图集预览:最多 4 张缩略图 + 剩余张数,只为确认「点对了作品」 */
function renderImgStrip(images) {
  const box = $('imgStrip');
  const list = Array.isArray(images) ? images : [];
  if (!list.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const picks = list.slice(0, 4);
  // CSP 只放行 https 图片;顺带 no-referrer,避免图床按防盗链拒绝
  const pickSrc = (urls) => (urls || []).find((u) => /^https:/i.test(u)) || (urls || [])[0] || '';
  box.innerHTML = picks
    .map((urls) => '<img class="img-thumb" loading="lazy" referrerpolicy="no-referrer" src="' + esc(pickSrc(urls)) + '" alt="">')
    .join('') +
    (list.length > picks.length ? '<span class="img-more">+' + (list.length - picks.length) + '</span>' : '');
  box.classList.remove('hidden');
}

/* ---------- 下载 ---------- */
async function startDownload() {
  if (dlRunning) return;
  if (dlPlatform === 'bilibili') return startBiliDownload();
  if (dlPlatform === 'alipay') return startAlipayDownload();
  if (dlPlatform === 'telegram') return startTelegramDownload();
  if (dlPlatform === 'wechat') return startWechatDownload();
  if (dlPlatform === 'douyin') {
    if (dyVideo && dyVideo.kind === 'images') return startDyImageDownload();
    return startDouyinDownload();
  }
}

/* 支付宝:单文件 mp4(视频+音轨在一起),不需要 ffmpeg 合并 */
async function startAlipayDownload() {
  const v = apVideo;
  if (!v) return;
  const qs = v.qualities || [];
  const pick = qs[Number($('qualitySel').value) || 0];
  // 选中的排第一,其余按原顺序兜底
  const urls = pick ? [pick.url].concat((v.videoUrls || []).filter((u) => u !== pick.url)) : v.videoUrls || [];
  if (!urls.length) { dlStatus('没有可用的视频地址'); return; }
  let savePath = await window.bili.pickSave(sanitizeName(v.title) + '.mp4');
  if (!savePath) return;
  if (!/\.mp4$/i.test(savePath)) savePath += '.mp4';
  dlRunning = true;
  $('downloadBtn').disabled = true;
  $('parseBtn').disabled = true;
  setDlBar(0);
  dlStatus('下载中…(' + (pick ? pick.label : '默认清晰度') + ')');
  try {
    const r = await window.bili.downloadAlipay({ videoUrls: urls, dest: savePath, title: v.title });
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

/* 公众号图集:选父目录 → 主进程在其中建同名子目录;封面存 封面.jpg,其余 01.jpg… */
async function startWechatDownload() {
  const v = wxArticle;
  if (!v) return;
  const modes = v.modes || [];
  const mode = modes[Number($('qualitySel').value) || 0] || modes[0];
  const imgs = (mode && mode.images) || [];
  if (!imgs.length) { dlStatus('没有可下载的图片'); return; }
  const dir = await window.bili.pickDir('选择保存图集的文件夹（会在其中新建子文件夹）');
  if (!dir) return;
  dlRunning = true;
  $('downloadBtn').disabled = true;
  $('parseBtn').disabled = true;
  setDlBar(0);
  dlStatus('下载图集…(' + (mode.label || '图片') + ')');
  try {
    const images = imgs.map((it) => [it.url].concat(it.fallback ? [it.fallback] : []));
    const names = imgs.map((it) => (it.label === '封面' ? '封面' : ''));
    const r = await window.bili.downloadWechatImages({ images: images, names: names, destDir: dir, title: v.title });
    if (!r.ok) throw new Error(r.message || '下载失败');
    setDlBar(100);
    dlStatus('✅ 已保存 ' + r.saved + ' 张到:' + r.dir + (r.failed ? '（' + r.failed + ' 张失败）' : ''));
  } catch (e) {
    dlStatus('❌ 下载失败:' + ((e && e.message) || e));
  } finally {
    dlRunning = false;
    $('downloadBtn').disabled = false;
    $('parseBtn').disabled = false;
  }
}

/* Telegram MTProto:用本机 tdata 的登录态直连服务器解析(私密频道/预览关闭都能拿) */
async function parseTelegramMt(text) {
  dlStatus('MTProto 解析中…(用本机 Telegram Desktop 登录态)');
  try {
    const r = await window.bili.fetchTelegramMt({ link: text });
    if (!r || !r.ok) {
      dlStatus('MTProto 解析失败:' + ((r && r.message) || '无响应') +
        '<br><span class="muted">确认本机 Telegram Desktop 已登录，且该账号能看到这条帖子。</span>');
      return { ok: false };
    }
    const items = r.items || [];
    if (!items.length) {
      dlStatus('帖子解析到了（' + esc((r.channel && r.channel.title) || r.channel.username) + '），但里面没有可下载的媒体。');
      return { ok: false };
    }
    const label = (r.channel && r.channel.title) || (r.channel && r.channel.username) || 'Telegram';
    tgVideo = { mt: true, title: label, items: items };
    $('videoPanel').classList.remove('hidden');
    $('vTitle').textContent = items.length > 1 ? label + '（' + items.length + ' 个媒体）' : label;
    const first = items[0];
    const meta = ['Telegram · MTProto'];
    if (first.kind === 'document' && first.isVideo) meta.push('视频');
    else if (first.kind === 'photo') meta.push('图片');
    else if (first.isVoice) meta.push('语音');
    else if (first.isSticker) meta.push('贴纸');
    if (first.size) meta.push(fmtSize(first.size));
    $('vMeta').textContent = meta.join(' · ');
    renderImgStrip([]);
    $('pageWrap').classList.add('hidden');
    /* 每个媒体一档"清晰度" */
    $('biliOptions').classList.remove('hidden');
    $('qualitySel').innerHTML = items
      .map((it, i) => {
        const name = it.filename || it.text || (it.kind === 'photo' ? 'photo' : 'media');
        const tag = it.kind === 'photo' ? '图片'
          : it.isVideo ? '视频' : it.isVoice ? '语音' : it.isSticker ? '贴纸' : '文件';
        return '<option value="' + i + '">' + esc(tag + ' · ' + name) + (it.size ? ' · ' + esc(fmtSize(it.size)) : '') + '</option>';
      })
      .join('');
    $('downloadBtn').textContent = '选择保存位置并下载';
    dlStatus('');
    $('downloadBtn').disabled = false;
    return { ok: true };
  } catch (e) {
    dlStatus('MTProto 解析异常:' + esc((e && e.message) || e));
    return { ok: false };
  }
}

/* Telegram:单文件 mp4(带音轨),不需要 ffmpeg 合并;图片帖则存单张 jpg。
   下载在主进程里自己走代理隧道(主进程的 fetch 不读系统代理)。 */
async function startTelegramDownload() {
  const v = tgVideo;
  if (!v) return;
  if (v.mt) return startTelegramMtDownload();
  if (v.kind === 'photo') return startTgPhotoSave();

  const qs = v.qualities || [];
  const pick = qs[Number($('qualitySel').value) || 0];
  const urls = pick ? [pick.url].concat((v.videoUrls || []).filter((u) => u !== pick.url)) : v.videoUrls || [];
  if (!urls.length) { dlStatus('没有可用的视频地址'); return; }
  let savePath = await window.bili.pickSave(sanitizeName(v.title) + '.mp4');
  if (!savePath) return;
  if (!/\.mp4$/i.test(savePath)) savePath += '.mp4';
  dlRunning = true;
  $('downloadBtn').disabled = true;
  $('parseBtn').disabled = true;
  setDlBar(0);
  dlStatus('下载中…(走代理,可能需要一会儿)');
  try {
    const r = await window.bili.downloadTelegram({ videoUrls: urls, dest: savePath, title: v.title });
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

/* MTProto 下载:媒体元数据交主进程,由 MTProto 分块拉回后落盘 */
async function startTelegramMtDownload() {
  const v = tgVideo;
  const pick = (v.items || [])[Number($('qualitySel').value) || 0];
  if (!pick) { dlStatus('没有可下载的媒体'); return; }
  const rawName = pick.filename || pick.text || ((v.title || 'Telegram') + '_' + pick.msgId);
  const dot = (/\.(\w{2,5})$/.exec(rawName) || [])[1];
  const ext = pick.kind === 'photo' ? 'jpg'
    : (dot ? dot.toLowerCase()
      : (/mp4/.test(pick.mime || '') ? 'mp4' : /webm/.test(pick.mime || '') ? 'webm' : 'bin'));
  const baseName = (dot ? rawName.replace(/\.\w{2,5}$/, '') : rawName) || ('telegram_' + pick.msgId);
  let savePath = await window.bili.pickSave(sanitizeName(baseName) + '.' + ext);
  if (!savePath) return;
  dlRunning = true;
  $('downloadBtn').disabled = true;
  $('parseBtn').disabled = true;
  setDlBar(0);
  dlStatus('MTProto 下载中…(走本机登录态,跨 DC 会自动迁移授权)');
  try {
    const r = await window.bili.downloadTelegramMt({ media: pick, dest: savePath, title: v.title });
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

async function startTgPhotoSave() {
  const v = tgVideo;
  const first = ((v.images || [])[0] || {});
  const url = (first.urls || [])[0] || '';
  if (!url) { dlStatus('没有可用的图片地址'); return; }
  let savePath = await window.bili.pickSave(sanitizeName(v.title) + '.jpg');
  if (!savePath) return;
  if (!/\.(jpg|jpeg|png|webp)$/i.test(savePath)) savePath += '.jpg';
  dlRunning = true;
  $('downloadBtn').disabled = true;
  $('parseBtn').disabled = true;
  dlStatus('保存图片中…');
  try {
    const r = await window.bili.saveTelegramPhoto({ url: url, dest: savePath, title: v.title });
    if (!r.ok) throw new Error(r.message);
    dlStatus('✅ 已保存:' + (r.dest || savePath));
  } catch (e) {
    dlStatus('❌ 保存失败:' + ((e && e.message) || e));
  } finally {
    dlRunning = false;
    $('downloadBtn').disabled = false;
    $('parseBtn').disabled = false;
  }
}

async function startBiliDownload() {  const vids = biliPlay.videos;
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

/* 图集:选父目录 → 主进程在其中建同名子目录,逐张存 01.jpg / 02.jpg… */
async function startDyImageDownload() {
  const v = dyVideo;
  if (!v || !v.images || !v.images.length) { dlStatus('没有可下载的图片'); return; }
  const dir = await window.bili.pickDir('选择保存图集的文件夹（会在其中新建子文件夹）');
  if (!dir) return;
  dlRunning = true;
  $('downloadBtn').disabled = true;
  $('parseBtn').disabled = true;
  setDlBar(0);
  dlStatus('下载图集…');
  try {
    const r = await window.bili.downloadDyImages({ images: v.images, destDir: dir, title: v.title });
    if (!r.ok) throw new Error(r.message || '下载失败');
    setDlBar(100);
    dlStatus('✅ 已保存 ' + r.saved + ' 张到:' + r.dir + (r.failed ? '（' + r.failed + ' 张失败）' : ''));
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
  if (['cur:v', 'cur:a', 'dyv', 'dya', 'dyimg', 'wxv', 'apv', 'tgv', 'wximg'].includes(key)) setDlBar(pct);
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
            ? '已拿到 ' + keyCount + ' 个 decodeKey，可直接导出。'
            : '视频流已抓到，还缺 decodeKey。')
        : '尚未捕获到视频。') +
      '</div>';
  }
  const stats = '<div class="muted">已捕获 ' + wxCaptureCount + ' 个分片 · 重建出 ' + wxStreams.length + ' 个视频流</div>';
  let diagHint = '';
  if (!wxPageSeen) {
    diagHint = '（页面 0 请求 = 命中磁盘缓存，先清缓存再彻底重开微信）';
  } else if (!wxWorkerInject) {
    diagHint = '（worker 走了旧缓存，再清一次缓存并重开微信）';
  } else if (!keyCount) {
    diagHint = '（worker 已注入，播放一个视频即可拿到 key）';
  }
  const diag = '<div class="muted">页面请求 ' + wxPageSeen + ' · worker 注入 ' + wxWorkerInject +
    ' · Feed ' + wxFeedCount + ' · key ' + keyCount + diagHint + '</div>';
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
    // covered 是「从 0 起连续」,captured 是「实际抓到」。跳播时前者可能是 0 而后者很大,
    // 只显示 covered 会让用户以为什么都没抓到,所以两种口径分开说。
    const got = Number(s.captured !== undefined ? s.captured : s.covered) || 0;
    const state = s.complete
      ? (s.sizeKnown ? '完整' : '已抓到末尾(长度未核实)')
      : (s.covered > 0
        ? ('缺 ' + fmtSize(s.missing))
        : ('未接通头部 · 已抓 ' + fmtSize(got)));
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
        '<span class="cap-size" title="已抓 / 总长' + (s.scattered > 0 ? '（其中从 0 起连续 ' + fmtSize(s.covered) + '）' : '') + '">' +
          fmtSize(got) + ' / ' + fmtSize(s.size) + '</span>' +
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
        '（前 128KB 仍加密）。');
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
    s.parts + ' 个分片 · ' + fmtSize(s.captured !== undefined ? s.captured : s.covered) + '\n\n' +
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
  const total = wxStreams.reduce((a, s) => a + (Number(s.captured !== undefined ? s.captured : s.covered) || 0), 0);
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
    if (!silent) wxStatusText('缺 decodeKey，先播放该视频。');
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
    wxStatusText(r && r.ok ? '已停止捕获，系统代理已还原；微信需重新打开才恢复直连。' : '停止失败:' + ((r && r.message) || ''));
  } catch (e) {
    wxStatusText('停止失败:' + ((e && e.message) || e));
  }
  refreshWxStatus();
});

$('wxCertBtn').addEventListener('click', async () => {
  const r = await window.bili.wxvInstallCert();
  wxStatusText(r && r.ok ? '✅ 证书已就绪(当前用户 · 受信任的根证书颁发机构)' : '❌ 安装失败:' + ((r && r.message) || '请先启动捕获'));
});

/* 卸载证书:装进根证书库等于把「给任意 HTTPS 站点签发有效证书」的能力交给本机,
   不用了就该能撤掉;早期 build 留下的同名旧证书也在这里一起清。 */
$('wxCertOffBtn').addEventListener('click', async () => {
  if (!confirm('从「当前用户 · 受信任的根证书颁发机构」移除本应用的本地根证书?\n\n移除后再次使用视频号捕获需要重新点「安装证书」;已有的捕获文件不受影响。')) return;
  const r = await window.bili.wxvUninstallCert();
  if (r && r.ok) {
    wxStatusText('✅ ' + ((r.removed && r.removed.length) ? ('已移除根证书:' + r.removed.join('、')) : (r.message || '没有找到本应用的证书')));
  } else {
    wxStatusText('❌ 卸载失败:' + ((r && r.message) || '未知错误'));
  }
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
      ' ｜ 本轮页面/JS 请求 ' + i.pageSeen + ' 次' + (i.pageSeen ? '' : '(0 次 = 页面命中磁盘缓存，需要清理)') +
      ' ｜ 日志：' + (i.logPath || '(未落盘)'));
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
  if (!info.targets.length) { wxStatusText('没有要清理的缓存（可点「恢复缓存」还原）。'); return; }
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
        emojiStatusText('自动安装失败:' + esc((r && r.message) || '') + '（可手动下载 zip 后点「从本地 zip 安装」）');
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

