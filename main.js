/* ============================================================
 * B 站一键取关助手 - Electron 主进程
 * 职责:窗口管理、B 站登录(持久会话)、代理渲染进程调用 B 站接口
 *       + 视频下载:解析分享链接 → 下载视频/音频流 → ffmpeg 合并
 * 接口(与网页端一致):
 *   账号  GET  https://api.bilibili.com/x/web-interface/nav
 *   列表  GET  https://api.bilibili.com/x/relation/followings
 *   取关  POST https://api.bilibili.com/x/relation/modify  (act=2)
 *   视频  GET  https://api.bilibili.com/x/web-interface/view
 *         GET  https://api.bilibili.com/x/player/playurl (fnval=4048 DASH)
 * ============================================================ */
const { app, BrowserWindow, ipcMain, session, dialog, shell } = require('electron');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PARTITION = 'persist:bilibili';
const LOGIN_URL = 'https://passport.bilibili.com/login';
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const FOLLOWINGS_URL = 'https://api.bilibili.com/x/relation/followings';
const MODIFY_URL = 'https://api.bilibili.com/x/relation/modify';

let mainWin = null;
let unfollowWin = null;
let loginWin = null;
let loginPollTimer = null;

const biliSession = () => session.fromPartition(PARTITION);

function sendToMain(channel, payload) {
  // 广播到所有窗口(视频下载在主窗口,登录状态两个窗口都需要)
  for (const w of [mainWin, unfollowWin]) {
    if (w && !w.isDestroyed()) {
      try { w.webContents.send(channel, payload); } catch (e) { /* ignore */ }
    }
  }
}

/* ---------- Cookie 与通用请求 ---------- */
async function cookieString() {
  const list = await biliSession().cookies.get({ url: 'https://api.bilibili.com' });
  return list.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function biliJSON(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    return { code: -1, message: `HTTP ${res.status} 非JSON响应` };
  }
}

function biliHeaders(extra) {
  return Object.assign(
    {
      'User-Agent': UA,
      Referer: 'https://space.bilibili.com/',
      Origin: 'https://space.bilibili.com',
    },
    extra || {}
  );
}

/* ---------- ffmpeg ---------- */
let _ffmpegPath;
function getFfmpegPath() {
  if (_ffmpegPath !== undefined) return _ffmpegPath;
  try {
    _ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    if (fs.existsSync(_ffmpegPath)) return _ffmpegPath;
  } catch (e) {
    /* 未随包安装,继续找系统 ffmpeg */
  }
  try {
    const out = execSync('where ffmpeg', { encoding: 'utf8' });
    const first = String(out)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    _ffmpegPath = first || null;
  } catch (e) {
    _ffmpegPath = null;
  }
  return _ffmpegPath;
}

function muxVideo(videoPath, audioPath, outPath) {
  const ff = getFfmpegPath();
  if (!ff) return Promise.resolve({ ok: false, message: '未找到 ffmpeg(依赖未装好且系统 PATH 中也没有)' });
  return new Promise((resolve) => {
    const p = spawn(
      ff,
      ['-y', '-loglevel', 'error', '-i', videoPath, '-i', audioPath, '-c', 'copy', '-movflags', '+faststart', outPath],
      { windowsHide: true }
    );
    let err = '';
    p.stderr.on('data', (d) => {
      err += String(d);
      if (err.length > 8000) err = err.slice(-4000);
    });
    p.on('error', (e) => resolve({ ok: false, message: 'ffmpeg 启动失败:' + e.message }));
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) resolve({ ok: true });
      else resolve({ ok: false, message: err || 'ffmpeg 退出码 ' + code });
    });
  });
}

/* 从视频里抽首帧当缩略图。实测视频号 MP4 是 faststart(moov 在头),
   只给前 512KB 也能解出画面,所以封面不需要下载完整视频。
   顺带把时长/分辨率一起读出来 —— ffmpeg 的 stderr 里本来就有 Duration,
   用 -loglevel info 就能拿到,不用为读时长再跑一次。 */
function extractFrame(inPath, outPath) {
  const ff = getFfmpegPath();
  if (!ff) return Promise.resolve({ ok: false, message: '未找到 ffmpeg(依赖未装好且系统 PATH 中也没有)' });
  return new Promise((resolve) => {
    const p = spawn(
      ff,
      ['-y', '-hide_banner', '-loglevel', 'info', '-probesize', '32M', '-analyzeduration', '10M',
        '-ss', '0', '-i', inPath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', outPath],
      { windowsHide: true }
    );
    let err = '';
    p.stderr.on('data', (d) => {
      // Duration 在 stderr 最前面,不能像以前那样只留尾部,否则读不到时长
      if (err.length < 40000) err += String(d);
    });
    p.on('error', (e) => resolve({ ok: false, message: 'ffmpeg 启动失败:' + e.message }));
    p.on('close', (code) => {
      const ok = code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
      if (!ok) return resolve({ ok: false, message: err.slice(-1500) || 'ffmpeg 退出码 ' + code });
      const info = parseMediaInfo(err);
      resolve({ ok: true, duration: info.duration, width: info.width, height: info.height });
    });
  });
}

/* 只读媒体信息,不抽帧(导出完整视频后用,省得为读时长再生成一张封面) */
function probeMedia(inPath) {
  const ff = getFfmpegPath();
  if (!ff) return Promise.resolve({ ok: false });
  return new Promise((resolve) => {
    const p = spawn(ff, ['-hide_banner', '-loglevel', 'info', '-i', inPath], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { if (err.length < 40000) err += String(d); });
    p.on('error', () => resolve({ ok: false }));
    p.on('close', () => {
      const info = parseMediaInfo(err);
      resolve({ ok: info.duration > 0, duration: info.duration, width: info.width, height: info.height });
    });
  });
}

/* 从 ffmpeg -i 的 stderr 里抠出时长和分辨率 */
function parseMediaInfo(text) {
  const out = { duration: 0, width: 0, height: 0 };
  const s = String(text || '');
  const md = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(s);
  if (md) {
    const sec = Number(md[1]) * 3600 + Number(md[2]) * 60 + parseFloat(md[3]);
    if (isFinite(sec) && sec > 0) out.duration = Math.round(sec * 100) / 100;
  }
  const mv = /Video:\s*[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(s);
  if (mv) {
    out.width = Number(mv[1]);
    out.height = Number(mv[2]);
  }
  return out;
}

/* ---------- 取关相关接口 ---------- */
async function biliNav() {
  const cookie = await cookieString();
  return biliJSON(NAV_URL, { headers: biliHeaders({ Cookie: cookie }), signal: AbortSignal.timeout(15000) });
}

async function biliFollowings(mid, pn, ps) {
  const cookie = await cookieString();
  const url = `${FOLLOWINGS_URL}?vmid=${mid}&pn=${pn}&ps=${ps}`;
  return biliJSON(url, { headers: biliHeaders({ Cookie: cookie }), signal: AbortSignal.timeout(15000) });
}

async function biliUnfollow(mid) {
  const cookie = await cookieString();
  const m = cookie.match(/bili_jct=([^;]+)/);
  if (!m) return { code: -111, message: '未获取到登录凭证 bili_jct,请重新登录' };
  const body = new URLSearchParams({ fid: String(mid), act: '2', re_src: '11', csrf: m[1] });
  return biliJSON(MODIFY_URL, {
    method: 'POST',
    headers: biliHeaders({
      Cookie: cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
    }),
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });
}

async function checkLogin() {
  try {
    const cookie = await cookieString();
    if (!cookie.includes('SESSDATA=')) return { loggedIn: false };
    const r = await biliNav();
    if (r && r.code === 0 && r.data && r.data.isLogin) {
      return {
        loggedIn: true,
        mid: r.data.mid,
        uname: r.data.uname,
        face: r.data.face || '',
      };
    }
    return { loggedIn: false, reason: r ? `code=${r.code}` : '无响应' };
  } catch (e) {
    return { loggedIn: false, reason: (e && e.message) || String(e) };
  }
}

/* ---------- 视频下载:解析 ---------- */
function extractBvidOrAid(text) {
  const t = String(text || '');
  let m = t.match(/BV[0-9A-Za-z]{10}/i);
  if (m) return { bvid: m[0].replace(/^bv/i, 'BV') };
  m = t.match(/av(\d{3,})/i);
  if (m) return { aid: m[1] };
  m = t.trim().match(/^(\d{4,})$/);
  if (m) return { aid: m[1] };
  return null;
}

async function resolveShareLink(text) {
  const t = String(text || '').trim();
  let ref = extractBvidOrAid(t);
  if (!ref && /b23\.tv|bili2233/i.test(t)) {
    const m = t.match(/https?:\/\/(b23\.tv|bili2233\.cn)\/[0-9A-Za-z]+/i);
    if (m) {
      try {
        const res = await fetch(m[0], {
          method: 'GET',
          redirect: 'follow',
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(15000),
        });
        ref = extractBvidOrAid(res.url || '');
      } catch (e) {
        return { ok: false, message: '短链解析失败:' + ((e && e.message) || e) };
      }
    }
  }
  if (!ref) return { ok: false, message: '未识别到 BV 号 / av 号 / 链接' };

  const q = ref.bvid ? `bvid=${encodeURIComponent(ref.bvid)}` : `aid=${ref.aid}`;
  const r = await biliJSON(`https://api.bilibili.com/x/web-interface/view?${q}`, {
    headers: biliHeaders({ Cookie: await cookieString() }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r || r.code !== 0 || !r.data) {
    return { ok: false, message: r ? `获取视频信息失败:code=${r.code} ${r.message}` : '无响应' };
  }
  const d = r.data;
  return {
    ok: true,
    bvid: d.bvid,
    aid: d.aid,
    title: d.title,
    owner: d.owner && d.owner.name,
    duration: d.duration,
    pages: (d.pages || []).map((p) => ({ cid: p.cid, page: p.page, part: p.part, duration: p.duration })),
  };
}

/* ---------- 视频下载:清晰度(playurl, DASH) ---------- */
async function biliPlayurl(bvid, cid) {
  const cookie = await cookieString();
  const url = `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=0&fnval=4048&fourk=1`;
  const r = await biliJSON(url, { headers: biliHeaders({ Cookie: cookie }), signal: AbortSignal.timeout(15000) });
  if (!r || r.code !== 0 || !r.data) {
    return { ok: false, message: r ? `code=${r.code} ${r.message}` : '无响应' };
  }
  const d = r.data;
  const dash = d.dash || {};
  const nameOf = (id) => {
    const f = (d.support_formats || []).find((s) => s.quality === id);
    return f ? f.new_description || f.display_desc || f.format : `${id}`;
  };
  const len = (d.timelength || 0) / 1000;
  const videos = (dash.video || []).map((v) => ({
    id: v.id,
    name: nameOf(v.id),
    codecs: v.codecs || '',
    width: v.width,
    height: v.height,
    sizeMB: Math.round(((v.bandwidth || 0) * len) / 8 / 1024 / 1024),
    urls: [v.base_url, ...(v.backup_url || [])].filter(Boolean),
  }));
  const audios = (dash.audio || []).map((a) => ({
    id: a.id,
    bandwidth: a.bandwidth || 0,
    urls: [a.base_url, ...(a.backup_url || [])].filter(Boolean),
  }));
  if (!videos.length) return { ok: false, message: '未获取到清晰度数据(该视频可能不支持或需登录)' };
  return { ok: true, videos, audios, timelength: d.timelength };
}

/* ---------- 视频下载:流下载(带备用地址与进度) ---------- */
async function downloadStream(urls, dest, key, extraHeaders, xorArray) {
  let lastErr = null;
  for (const url of urls) {
    const ctrl = new AbortController();
    let stallTimer = null;
    try {
      const res = await fetch(url, {
        headers: Object.assign({ 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }, extraHeaders || {}),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const ctype = String(res.headers.get('content-type') || '');
      if (/text\/html|application\/json|application\/xml|text\/xml/i.test(ctype)) {
        throw new Error('返回的不是视频文件(链接可能已过期): ' + ctype);
      }
      const total = Number(res.headers.get('content-length')) || 0;
      let received = 0;
      let lastSent = 0;
      var xorApplied = 0;
      const resetStall = function () {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(function () {
          ctrl.abort(new Error('下载停滞(25 秒无数据,CDN 可能拒绝该直链)'));
        }, 25000);
      };
      resetStall();
      await pipeline(
        Readable.fromWeb(res.body),
        async function* (source) {
          for await (const chunk of source) {
            if (xorArray && xorApplied < xorArray.length) {
              const n = Math.min(xorArray.length - xorApplied, chunk.length);
              for (let i = 0; i < n; i += 1) chunk[i] ^= xorArray[xorApplied + i];
              xorApplied += n;
            }
            received += chunk.length;
            resetStall();
            if (received - lastSent > 512 * 1024) {
              lastSent = received;
              sendToMain('dl:progress', { key, received, total });
            }
            yield chunk;
          }
        },
        fs.createWriteStream(dest)
      );
      if (stallTimer) clearTimeout(stallTimer);
      sendToMain('dl:progress', { key, received, total: total || received });
      return { ok: true, bytes: received };
    } catch (e) {
      if (stallTimer) clearTimeout(stallTimer);
      lastErr = e;
      try {
        await fsp.rm(dest, { force: true });
      } catch (_) {
        /* ignore */
      }
    }
  }
  return { ok: false, message: (lastErr && lastErr.message) || String(lastErr) };
}

/* ---------- 登录窗口 ---------- */
function stopLoginPoll() {
  if (loginPollTimer) {
    clearInterval(loginPollTimer);
    loginPollTimer = null;
  }
}

function startLoginPoll() {
  stopLoginPoll();
  let attempts = 0;
  loginPollTimer = setInterval(async () => {
    attempts += 1;
    if (attempts > 240) {
      stopLoginPoll();
      return;
    }
    try {
      const list = await biliSession().cookies.get({ domain: 'bilibili.com' });
      const hasSess = list.some((c) => c.name === 'SESSDATA');
      const hasJct = list.some((c) => c.name === 'bili_jct');
      if (hasSess && hasJct) {
        const info = await checkLogin();
        if (info.loggedIn) {
          stopLoginPoll();
          if (loginWin && !loginWin.isDestroyed()) loginWin.close();
          sendToMain('login:success', info);
        }
      }
    } catch (e) {
      /* 轮询错误忽略,下一轮继续 */
    }
  }, 1500);
}

function openLoginWindow() {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.focus();
    return;
  }
  loginWin = new BrowserWindow({
    width: 450,
    height: 680,
    title: '登录 B 站',
    autoHideMenuBar: true,
    parent: mainWin && !mainWin.isDestroyed() ? mainWin : undefined,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  loginWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  loginWin.loadURL(LOGIN_URL);
  loginWin.on('closed', () => {
    loginWin = null;
    stopLoginPoll();
  });
  startLoginPoll();
}

/* ---------- IPC ---------- */
ipcMain.handle('login:check', () => checkLogin());
ipcMain.handle('login:start', () => openLoginWindow());
ipcMain.handle('login:logout', async () => {
  stopLoginPoll();
  if (loginWin && !loginWin.isDestroyed()) loginWin.close();
  await biliSession().clearStorageData();
  return { ok: true };
});
ipcMain.handle('bili:nav', () => biliNav());
ipcMain.handle('bili:followings', (_e, mid, pn, ps) => biliFollowings(mid, pn, ps));
ipcMain.handle('bili:unfollow', (_e, mid) => biliUnfollow(mid));

ipcMain.handle('video:resolve', (_e, text) => resolveShareLink(text));
ipcMain.handle('video:playurl', (_e, bvid, cid) => biliPlayurl(bvid, cid));
ipcMain.handle('video:pick-save', async (_e, defaultName) => {
  const r = await dialog.showSaveDialog(mainWin, {
    defaultPath: defaultName,
    filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
  });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('video:download', async (_e, { key, videoUrls, audioUrls, videoTmp, audioTmp }) => {
  const v = await downloadStream(videoUrls, videoTmp, key + ':v');
  if (!v.ok) return { ok: false, message: '视频流下载失败:' + v.message };
  const a = await downloadStream(audioUrls, audioTmp, key + ':a');
  if (!a.ok) return { ok: false, message: '音频流下载失败:' + a.message };
  return { ok: true };
});
ipcMain.handle('video:mux', (_e, { videoTmp, audioTmp, outPath }) => muxVideo(videoTmp, audioTmp, outPath));
ipcMain.handle('video:cleanup', async (_e, files) => {
  for (const f of files || []) {
    try {
      await fsp.rm(f, { force: true });
    } catch (_) {
      /* ignore */
    }
  }
  return { ok: true };
});
ipcMain.handle('video:ffmpeg-check', () => ({ ok: !!getFfmpegPath(), path: getFfmpegPath() || '' }));

/* ============================================================
 * 抖音视频下载(实验性 · 页面捕获直链)
 * 原理:解析分享链接得到视频 ID → 在内嵌窗口中打开 www.douyin.com
 *      视频页 → 页面播放器用自身合法签名请求视频 → 主进程通过
 *      webRequest 捕获 douyinvod 直链 → 直接下载 MP4。
 *      无需实现签名算法;公开视频无需登录(需要登录时可在窗口内扫码)。
 * ============================================================ */
const DY_MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DY_CAP_PARTITION = 'douyin-video-capture';

let dyCapWin = null;
let dyCapUrls = [];
let dyCapTitle = '';

const dySleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dyVideoLog(m) {
  try {
    fs.appendFileSync(path.join(app.getAppPath(), 'dyvideo-run.log'), '[' + new Date().toISOString() + '] ' + m + '\n', 'utf8');
  } catch (e) {
    /* ignore */
  }
}

function extractDouyinId(text) {
  const t = String(text || '');
  let m = t.match(/\/video\/(\d{15,})/);
  if (m) return m[1];
  m = t.match(/\/note\/(\d{15,})/);
  if (m) return m[1];
  m = t.match(/modal_id=(\d{15,})/);
  if (m) return m[1];
  m = t.match(/(\d{16,})/);
  if (m) return m[1];
  return null;
}

function classifyDouyinUrl(u) {
  if (/media-audio/.test(u)) return 'audio';
  if (/media-video/.test(u)) return 'video';
  return 'full';
}

function brOf(u) {
  const m = String(u).match(/[?&]br=(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

async function resolveDouyinId(text) {
  const t = String(text || '').trim();
  var id = extractDouyinId(t);
  if (id) return { ok: true, id: id };
  const m = t.match(/https?:\/\/v\.douyin\.com\/[0-9A-Za-z\-_]+/i);
  if (!m) return { ok: false, message: '未识别到抖音链接或视频 ID' };
  const res = await fetch(m[0], {
    method: 'GET',
    redirect: 'follow',
    headers: { 'User-Agent': DY_MOBILE_UA },
    signal: AbortSignal.timeout(20000),
  }).catch(function () { return null; });
  if (!res) return { ok: false, message: '短链解析失败(网络错误)' };
  id = extractDouyinId(res.url || '');
  if (!id) {
    const html = await res.text().catch(function () { return ''; });
    id = extractDouyinId(html);
  }
  if (!id) return { ok: false, message: '短链未指向视频(' + String(res.url || '').slice(0, 80) + ')' };
  return { ok: true, id: id };
}

function dyCapSend(msg) {
  sendToMain('dyvideo:status', { msg: msg });
}

ipcMain.handle('dyvideo:resolve', async (_e, text) => resolveDouyinId(text));

ipcMain.handle('unfollow:open', () => {
  if (unfollowWin && !unfollowWin.isDestroyed()) {
    unfollowWin.focus();
    return { ok: true };
  }
  unfollowWin = new BrowserWindow({
    width: 680,
    height: 840,
    minWidth: 560,
    minHeight: 600,
    title: '批量取关',
    autoHideMenuBar: true,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  unfollowWin.loadFile(path.join(__dirname, 'renderer', 'unfollow.html'));
  unfollowWin.on('closed', () => { unfollowWin = null; });
  return { ok: true };
});

ipcMain.handle('dyvideo:fetch', async (_e, id) => {
  id = String(id || '').trim();
  if (!/^\d{15,}$/.test(id)) return { ok: false, message: '视频 ID 无效' };
  dyVideoLog('捕获直链:打开视频页 ' + id);
  dyCapUrls = [];
  dyCapTitle = '';

  if (dyCapWin && !dyCapWin.isDestroyed()) {
    try { dyCapWin.destroy(); } catch (e) { /* ignore */ }
  }
  dyCapWin = null;

  const ses = session.fromPartition(DY_CAP_PARTITION);
  try { await ses.setUserAgent(UA); } catch (e) { /* ignore */ }
  const filter = {
    urls: ['*://*.douyinvod.com/*', '*://*.douyin.com/aweme/v1/play/*', '*://*.aweme.snssdk.com/aweme/v1/play/*'],
  };
  const handler = function (details) {
    const u = String(details.url || '');
    if (dyCapUrls.length >= 4) return;
    var dup = false;
    for (var i = 0; i < dyCapUrls.length; i++) {
      if (dyCapUrls[i].url.split('?')[0] === u.split('?')[0]) { dup = true; break; }
    }
    if (dup) return;
    var hit = '';
    if (/douyinvod\.com/.test(u) && (/\.mp4|mime_type=video_mp4/i.test(u))) hit = u;
    else if (/aweme\/v1\/play/.test(u)) hit = u;
    if (hit) {
      var kind = classifyDouyinUrl(hit);
      dyCapUrls.push({ url: hit, kind: kind, br: brOf(hit) });
      dyVideoLog('捕获直链(' + dyCapUrls.length + ',' + kind + '):' + hit.slice(0, 500));
    }
  };
  ses.webRequest.onBeforeRequest(filter, handler);

  dyCapWin = new BrowserWindow({
    width: 560,
    height: 780,
    title: '抖音视频页(获取直链中,完成后自动关闭)',
    autoHideMenuBar: true,
    webPreferences: {
      partition: DY_CAP_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  dyCapWin.webContents.on('will-prevent-unload', function (event) { event.preventDefault(); });
  dyCapWin.webContents.on('will-navigate', function (e, url) {
    // 阻止 bitbrowser:// 等外部协议触发系统弹窗
    if (!/^https?:\/\/([^/]*\.)?(douyin|iesdouyin|douyinvod|zjcdn)\.com/.test(String(url || ''))) e.preventDefault();
  });
  dyCapWin.on('closed', function () { dyCapWin = null; });

  // 通过调试接口捕获页面自身请求的视频详情(含直链),不受登录墙影响
  var dbg = dyCapWin.webContents.debugger;
  dbg.on('message', function (_ev, method, params) {
    if (method !== 'Network.responseReceived' || dyCapUrls.length >= 3) return;
    try {
      const u = String((params.response && params.response.url) || '');
      if (!/aweme\/detail/i.test(u)) return;
      dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId }).then(function (body) {
        if (dyCapUrls.length >= 3) return;
        const j = JSON.parse(body.body);
        const aweme = j.aweme_detail || (j.data && j.data.aweme_detail) || (j.item_list && j.item_list[0]);
        const v = aweme && aweme.video;
        if (!v) return;
        var url = '';
        if (Array.isArray(v.bit_rate) && v.bit_rate.length) {
          var best = v.bit_rate.reduce(function (a, b) { return ((b.bit_rate || 0) > (a.bit_rate || 0) ? b : a); });
          var pa = best.play_addr || {};
          var list = pa.url_list || [];
          url = list.find(function (x) { return /^https:/.test(x); }) || '';
        }
        if (!url && v.play_addr && Array.isArray(v.play_addr.url_list)) {
          url = v.play_addr.url_list.find(function (x) { return /^https:/.test(x); }) || '';
        }
        if (url) {
          const kind = classifyDouyinUrl(url);
          if (dyCapUrls.some(function (x) { return x.url.split('?')[0] === url.split('?')[0]; })) return;
          dyCapUrls.push({ url: url, kind: kind, br: brOf(url) });
          dyVideoLog('从详情接口捕获直链(' + dyCapUrls.length + ',' + kind + '):' + url.slice(0, 300));
          if (!dyCapTitle) dyCapTitle = String(aweme.desc || '').slice(0, 120);
        }
      }).catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  });
  try {
    dbg.attach('1.3'); // 同步方法,不返回 Promise(此前误用 .then 导致白屏)
    dbg.sendCommand('Network.enable').catch(function (e) {
      dyVideoLog('Network.enable 失败:' + ((e && e.message) || e));
    });
  } catch (e) {
    dyVideoLog('调试接口附加失败:' + ((e && e.message) || e));
  }

  dyCapWin.loadURL('https://www.douyin.com/video/' + id).catch(function () {});

  const start = Date.now();
  var autoplayTried = 0;
  while (!dyCapUrls.length && Date.now() - start < 180000) {
    await dySleep(1500);
    if (!dyCapWin || dyCapWin.isDestroyed()) break;
    autoplayTried += 1;
    if (autoplayTried >= 2) {
      await dyCapWin.webContents
        .executeJavaScript('(function(){var v=document.querySelector("video");if(v&&v.paused){v.muted=true;var p=v.play();if(p&&p.catch)p.catch(function(){});return "played";}return "";})()')
        .catch(function () { return ''; });
    }
    if (!dyCapTitle) {
      dyCapTitle = await dyCapWin.webContents
        .executeJavaScript('document.title')
        .then(function (t) { return String(t || '').replace(/\s*[-|]\s*抖音\s*$/, '').trim().slice(0, 120); })
        .catch(function () { return ''; });
    }
    dyCapSend(dyCapUrls.length ? '直链已获取,关闭窗口…' : '等待视频加载并捕获直链…(' + Math.round((Date.now() - start) / 1000) + '/180 秒;如弹登录请扫码,如未自动播放请点击播放)');
  }

  var fullUrls = [];
  var videoOnly = [];
  var audioOnly = [];
  for (var ci = 0; ci < dyCapUrls.length; ci++) {
    var it = dyCapUrls[ci];
    if (it.kind === 'audio') audioOnly.push(it);
    else if (it.kind === 'video') videoOnly.push(it);
    else fullUrls.push(it);
  }
  videoOnly.sort(function (a, b) { return b.br - a.br; });
  audioOnly.sort(function (a, b) { return b.br - a.br; });
  var videoUrls = fullUrls.length ? fullUrls.map(function (x) { return x.url; }) : videoOnly.map(function (x) { return x.url; });
  var audioUrls = fullUrls.length ? [] : audioOnly.map(function (x) { return x.url; });
  const result = videoUrls.length
    ? { ok: true, videoUrls: videoUrls, audioUrls: audioUrls, title: dyCapTitle || '抖音视频 ' + id }
    : { ok: false, message: '获取直链超时(180 秒)。请在窗口内登录后重试,或该视频不可公开播放' };
  dyVideoLog(result.ok ? '捕获完成:完整直链 ' + fullUrls.length + ' 条,纯视频 ' + videoOnly.length + ' 条,纯音频 ' + audioOnly.length + ' 条,标题=' + result.title : '捕获失败:' + result.message);
  if (dyCapWin && !dyCapWin.isDestroyed()) {
    try { dyCapWin.destroy(); } catch (e) { /* ignore */ }
  }
  dyCapWin = null;
  try { ses.webRequest.onBeforeRequest(filter, null); } catch (e) { /* ignore */ }
  return result;
});

ipcMain.handle('dyvideo:download', async (_e, { key, videoUrls, audioUrls, dest, title }) => {
  var tmpV = null;
  var tmpA = null;
  try {
    if (!dest) {
      const dir = app.getPath('downloads');
      const base = sanitizeName('抖音_' + (title || 'video'));
      dest = path.join(dir, base + '.mp4');
      var fn = 1;
      while (fs.existsSync(dest)) {
        dest = path.join(dir, base + ' (' + fn + ').mp4');
        fn += 1;
      }
    }
    tmpV = dest + '.v.part';
    tmpA = dest + '.a.part';
    dyVideoLog('开始下载,视频直链:' + String((videoUrls && videoUrls[0]) || '') + ' | 音频直链:' + String((audioUrls && audioUrls[0]) || '无') + ' | 目标:' + dest);
  const headers = {
    'User-Agent': UA,
    Referer: 'https://www.douyin.com/',
    Range: 'bytes=0-',
  };
    const rv = await downloadStream(videoUrls, tmpV, key, headers);
    if (!rv.ok) throw new Error('视频流下载失败:' + rv.message);
    if (audioUrls && audioUrls.length) {
      const ra = await downloadStream(audioUrls, tmpA, key + 'a', headers);
      if (!ra.ok) throw new Error('音频流下载失败:' + ra.message);
      dyVideoLog('双流下载完成,开始合并…');
      const m = await muxVideo(tmpV, tmpA, dest);
      if (!m.ok) throw new Error('合并失败:' + m.message);
    } else {
      try {
        await fsp.rename(tmpV, dest);
      } catch (e) {
        await fsp.copyFile(tmpV, dest);
        await fsp.rm(tmpV, { force: true });
      }
    }
    dyVideoLog('下载完成 ' + dest);
    return { ok: true, dest: dest };
  } catch (e) {
    if (tmpV) { try { await fsp.rm(tmpV, { force: true }); } catch (_) { /* ignore */ } }
    if (tmpA) { try { await fsp.rm(tmpA, { force: true }); } catch (_) { /* ignore */ } }
    const msg = (e && e.message) || String(e);
    dyVideoLog('下载失败:' + msg);
    return { ok: false, message: msg };
  }
});

/* ============================================================
 * 微信视频号下载(实验 · 不解密直存)
 * 原理:本地 MITM 代理(127.0.0.1:8899)+ 系统代理切换;
 *   仅拦截视频 CDN 域名(*.video.weixin.qq.com / stodownload* /
 *   finder.video.qq.com),其余微信流量(登录、mmtls 私有协议)
 *   全部原样隧道直通;命中的视频响应原文落盘(不做任何解密),
 *   可用「完整下载」重新拉取完整文件,验证能否直接播放。
 *   首次启动会生成本地根证书(LocalCapture Root CA 2),需安装到
 *   当前用户「受信任的根证书颁发机构」(无需管理员)。
 * ============================================================ */
const WXV_INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const WXV_PORT = 8899;
let wxProxy = null;
let wxSavedProxy = null;
const wxFeedStore = new Map(); // feed.id -> item

/* feed 持久化:旧实现只在内存,重启 app 后列表全空 → 界面永远显示"尚未捕获到视频"。
   页面注入只在视频号 HTML 首次加载时发生(微信缓存命中不会再注入),所以抓到过的
   feed(url + decodeKey)必须落盘保留,否则每次重启都要靠运气重新触发注入。 */
let wxFeedsLoaded = false;
function wxvFeedPath() {
  return path.join(app.getPath('userData'), 'wx-captures', 'feeds.json');
}
function wxvEnsureFeeds() {
  if (wxFeedsLoaded) return;
  wxFeedsLoaded = true;
  try {
    const arr = JSON.parse(fs.readFileSync(wxvFeedPath(), 'utf8'));
    if (Array.isArray(arr)) for (const it of arr) if (it && it.id) wxFeedStore.set(it.id, it);
  } catch (e) { /* ignore */ }
}
function wxvSaveFeeds() {
  try {
    const dir = path.dirname(wxvFeedPath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(wxvFeedPath(), JSON.stringify(Array.from(wxFeedStore.values()), null, 1), 'utf8');
  } catch (e) { /* ignore */ }
}

/* 本地缓存里的 seed 可能是过期的(实测 20 条里 2 条解不出 MP4)。
   解出来不是 MP4 时把它丢掉,让播放时 worker 上报的、确定正确的 key 接管。 */
function wxvDropStaleDbKey(key) {
  let dropped = 0;
  for (const kv of Array.from(wxFeedStore.entries())) {
    if (kv[1] && kv[1].source === 'wx-cache-db' && String(kv[1].key) === String(key)) {
      wxFeedStore.delete(kv[0]);
      dropped += 1;
    }
  }
  if (dropped) {
    wxvSaveFeeds();
    wxvPushStatusSoon();
    wxvLog('[key无效] 丢弃 ' + dropped + ' 条过期缓存 key=' + key + '(解出来不是 MP4),请播放该视频重新获取');
  }
  return dropped;
}

/* 自定义标题:视频号的 feed 数据走 mmtls 私有协议 + LiteApp 本地包,
   既不经过 HTTPS 代理,也不落盘(WebView 缓存里只有 JS/CSS,没有 feed JSON;
   本地也没有 feed 数据库)。所以标题物理上只能由用户自己起名。
   按「视频稳定标识」保存,精确匹配,绝不跨视频套用。 */
let wxTitlesLoaded = false;
const wxTitleStore = new Map(); // streamKey(enc:xxx) -> title
function wxvTitlesPath() {
  return path.join(app.getPath('userData'), 'wx-captures', 'titles.json');
}
function wxvEnsureTitles() {
  if (wxTitlesLoaded) return;
  wxTitlesLoaded = true;
  try {
    const o = JSON.parse(fs.readFileSync(wxvTitlesPath(), 'utf8'));
    for (const k of Object.keys(o || {})) if (k && o[k]) wxTitleStore.set(k, String(o[k]));
  } catch (e) { /* ignore */ }
}
function wxvSaveTitles() {
  try {
    const dir = path.dirname(wxvTitlesPath());
    fs.mkdirSync(dir, { recursive: true });
    const o = {};
    for (const kv of wxTitleStore) o[kv[0]] = kv[1];
    fs.writeFileSync(wxvTitlesPath(), JSON.stringify(o, null, 1), 'utf8');
  } catch (e) { /* ignore */ }
}

/* 第 4 条取 key 通路(纯磁盘只读,不需要页面注入,也不需要 worker 被改写):
   微信 WebView 的 IndexedDB 里有个 video_cache_info 存储,键就是
   「finder:videoCache:...encfilekey=XXX...」,值是
   {feedId, videoKey, preDownloadedContentLen, videoContentLen, seed}。
   seed 即 decodeKey,与 encfilekey 在同一条记录里绑定 —— 天然满足「不可复用」。 */
function wxvIndexedDbFiles() {
  const out = [];
  let base = '';
  try { base = wxvWeChatCacheRoot(); } catch (e) { return out; }
  if (!base || !fs.existsSync(base)) return out;
  let profiles = [];
  try { profiles = fs.readdirSync(base); } catch (e) { return out; }
  for (const name of profiles) {
    if (/^_wxv_bak_/i.test(name)) continue; // 我们自己的备份不算活数据
    const idb = path.join(base, name, 'IndexedDB');
    let ents = [];
    try { ents = fs.readdirSync(idb, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      if (!e.isDirectory() || !/weixin_xworker_0\.indexeddb\.leveldb/i.test(e.name)) continue;
      const d = path.join(idb, e.name);
      let fs2 = [];
      try { fs2 = fs.readdirSync(d); } catch (e2) { continue; }
      for (const f of fs2) {
        if (!/\.(log|ldb|sst)$/i.test(f)) continue;
        out.push(path.join(d, f));
      }
    }
  }
  return out;
}

function wxvScanVideoCacheDb() {
  wxvEnsureFeeds();
  const files = wxvIndexedDbFiles();
  let added = 0;
  const seen = new Set();
  for (const p of files) {
    let text = '';
    try {
      const st = fs.statSync(p);
      if (!st.size || st.size > 64 * 1024 * 1024) continue;
      text = fs.readFileSync(p).toString('utf8');
    } catch (e) { continue; }
    let i = -1;
    while ((i = text.indexOf('finder:videoCache:', i + 1)) >= 0) {
      // 只在本条记录范围内找 seed,避免串到下一条记录
      const next = text.indexOf('finder:videoCache:', i + 1);
      const end = Math.min(next > 0 ? next : i + 800, i + 800);
      const win = text.slice(i, end);
      const me = /encfilekey=([A-Za-z0-9_\-]+)/.exec(win);
      const ms = /"seed":"(\d+)"/.exec(win);
      if (!me || !ms) continue;
      const enc = me[1];
      if (seen.has(enc)) continue;
      seen.add(enc);
      const ml = /"videoContentLen":(\d+)/.exec(win);
      const id = 'db:' + enc.slice(0, 80);
      wxFeedStore.set(id, {
        id: id,
        url: '',
        encfilekey: enc,
        key: ms[1],
        size: ml ? Number(ml[1]) : 0,
        title: '',
        nickname: '',
        duration: 0,
        ts: Date.now(),
        source: 'wx-cache-db',
      });
      added += 1;
    }
  }
  if (added) {
    wxvSaveFeeds();
    wxvLog('[CacheDbKey] 从本地 IndexedDB 补到 ' + added + ' 条 encfilekey->seed');
    wxvPushStatusSoon();
  }
  return added;
}

/* ---------- 视频流缩略图 ----------
   标题拿不到(见 wxTitleStore 注释),就用首帧当"封面"来认视频。
   只需要前 2MB:实测这些 MP4 是 faststart,moov 在头部,截断到 512KB 仍能解出画面。 */
const WXV_THUMB_BYTES = 2 * 1024 * 1024;

function wxvThumbDir() {
  const d = path.join(app.getPath('userData'), 'wx-captures', 'thumbs');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
  return d;
}
function wxvThumbFile(streamKey) {
  // 不同视频的 encfilekey 有很长的共同前缀(Cvvj5Ix3eewQsFvYyicia1J...),
  // 直接截断当文件名会撞名、导致封面张冠李戴 —— 用哈希保证一一对应。
  const h = crypto.createHash('sha1').update(String(streamKey || '')).digest('hex').slice(0, 20);
  return path.join(wxvThumbDir(), h + '.jpg');
}

/* 时长/分辨率缓存:跟封面同目录、同一个哈希名,后缀 .json。
   生成封面时顺带写,列表渲染时同步读(文件很小),不用每次重跑 ffmpeg。 */
const wxMetaCache = new Map();

function wxvMetaFile(streamKey) {
  const h = crypto.createHash('sha1').update(String(streamKey || '')).digest('hex').slice(0, 20);
  return path.join(wxvThumbDir(), h + '.json');
}

function wxvReadMeta(streamKey) {
  const k = String(streamKey || '');
  if (!k) return null;
  if (wxMetaCache.has(k)) return wxMetaCache.get(k);
  let m = null;
  try {
    m = JSON.parse(fs.readFileSync(wxvMetaFile(k), 'utf8'));
    if (!m || typeof m !== 'object') m = null;
  } catch (e) {
    m = null;
  }
  wxMetaCache.set(k, m);
  return m;
}

function wxvWriteMeta(streamKey, obj) {
  const k = String(streamKey || '');
  if (!k) return;
  const data = obj && typeof obj === 'object' ? obj : {};
  try {
    fs.mkdirSync(wxvThumbDir(), { recursive: true });
    fs.writeFileSync(wxvMetaFile(k), JSON.stringify(data), 'utf8');
  } catch (e) { /* ignore */ }
  wxMetaCache.set(k, data);
}

/* 时长显示:不到 1 分钟给 "17.3s",否则 "1:23" / "1:02:03" */
function wxvFormatDuration(sec) {
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

/* 从已抓分片里取「从 0 开始连续」的前 N 字节;有缺口就停,绝不错位拼接 */
async function wxvHeadFromParts(parts, maxBytes) {
  const chunks = [];
  let cursor = 0;
  const sorted = (parts || []).slice().sort((a, b) => (a.start - b.start) || (b.end - a.end));
  for (const p of sorted) {
    if (cursor >= maxBytes) break;
    if (!p || !p.path || !fs.existsSync(p.path)) continue;
    if (p.start > cursor) break;
    if (p.end < cursor) continue;
    let data;
    try { data = await fsp.readFile(p.path); } catch (e) { break; }
    const off = cursor - p.start;
    const len = Math.min(p.end - cursor + 1, maxBytes - cursor, Math.max(0, data.length - off));
    if (len <= 0) break;
    chunks.push(data.slice(off, off + len));
    cursor += len;
  }
  return Buffer.concat(chunks);
}

/* 分片不够时直连 CDN 拉前 N 字节(带原始签名头),只拿封面够用的量 */
function wxvHeadFromNet(rawUrl, reqHeaders, maxBytes) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(String(rawUrl)); } catch (e) { return reject(new Error('URL 无效')); }
    const headers = Object.assign({}, reqHeaders || {});
    headers.range = 'bytes=0-' + (maxBytes - 1);
    headers['accept-encoding'] = 'identity';
    let done = false;
    const fin = (err, buf) => {
      if (done) return;
      done = true;
      if (err) reject(err); else resolve(buf);
    };
    let req;
    try {
      req = https.request({
        host: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: headers,
        agent: false,
      }, (res) => {
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          return fin(new Error('HTTP ' + res.statusCode));
        }
        const chunks = [];
        let got = 0;
        res.on('data', (c) => {
          if (got >= maxBytes) return;
          const take = c.slice(0, maxBytes - got);
          chunks.push(take);
          got += take.length;
          if (got >= maxBytes) {
            try { req.destroy(); } catch (e) { /* ignore */ }
            fin(null, Buffer.concat(chunks));
          }
        });
        res.on('end', () => fin(null, Buffer.concat(chunks)));
        res.on('error', (e) => fin(e));
      });
    } catch (e) {
      return fin(e);
    }
    req.on('error', (e) => fin(e));
    req.setTimeout(20000, () => { try { req.destroy(new Error('取封面超时')); } catch (e) { /* ignore */ } });
    req.end();
  });
}

/* 生成(或读取缓存)某个视频流的封面,返回 data URL —— CSP 只允许 img-src https:/data: */
async function wxvStreamThumb(item) {
  if (!item || !item.url) return { ok: false, error: '缺少视频流信息' };
  if (item.key === undefined || item.key === null || item.key === '') {
    return { ok: false, error: '缺 decodeKey,无法解密取帧' };
  }
  const sk = wxvStreamKey(item.url);
  const outPath = wxvThumbFile(sk);
  const thumbOk = (function () {
    try { return fs.existsSync(outPath) && fs.statSync(outPath).size > 0; } catch (e) { return false; }
  })();
  const meta = wxvReadMeta(sk);
  // 封面和时长都齐了才算真命中。老数据只有 .jpg 没有 .json,要重跑一次把时长补上
  if (thumbOk && meta) {
    return {
      ok: true,
      cached: true,
      duration: Number(meta.duration) || 0,
      width: Number(meta.width) || 0,
      height: Number(meta.height) || 0,
      dataUrl: 'data:image/jpeg;base64,' + fs.readFileSync(outPath).toString('base64'),
    };
  }
  // 已经有封面、只是缺时长:后面任何一步失败都要把原封面交回去,
  // 不能因为「补时长失败」让用户手里好好的封面消失
  const fallbackThumb = function () {
    if (!thumbOk) return null;
    try {
      return {
        ok: true, cached: true, duration: 0, width: 0, height: 0,
        dataUrl: 'data:image/jpeg;base64,' + fs.readFileSync(outPath).toString('base64'),
      };
    } catch (e) { return null; }
  };

  let head = Buffer.alloc(0);
  try { head = await wxvHeadFromParts(item.capParts || [], WXV_THUMB_BYTES); } catch (e) { /* ignore */ }
  // 至少要有 128KB 加密头 + 一点画面数据,否则从网络补
  if (head.length < 131072 + 1024 && item.reqHeaders && /^https:\/\//i.test(String(item.url || ''))) {
    try {
      const net = await wxvHeadFromNet(item.url, item.reqHeaders, WXV_THUMB_BYTES);
      if (net.length > head.length) head = net;
    } catch (e) {
      wxvLog('[封面] 直连取头失败:' + ((e && e.message) || e));
    }
  }
  if (head.length < 2048) {
    return fallbackThumb() || { ok: false, error: '本地数据太少(先播放一下,或先点「补全导出」)' };
  }

  let dec = head;
  try {
    const { decryptBuffer } = require('./wxv-decrypt');
    dec = await decryptBuffer(head, item.key, app.getPath('userData'), (m) => wxvLog(m));
  } catch (e) {
    return fallbackThumb() || { ok: false, error: '解密失败:' + ((e && e.message) || e) };
  }
  if (!(dec.length > 12 && dec.toString('latin1', 4, 8) === 'ftyp')) {
    wxvDropStaleDbKey(item.key);
    return fallbackThumb() || { ok: false, error: '解密后不是 MP4（key 与视频不匹配，可能来自过期缓存）' };
  }

  const tmpIn = path.join(app.getPath('temp'), 'wxv-thumb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.mp4');
  let info = { duration: 0, width: 0, height: 0 };
  try {
    await fsp.writeFile(tmpIn, dec);
    const r = await extractFrame(tmpIn, outPath);
    if (!r.ok) return fallbackThumb() || { ok: false, error: '抽帧失败:' + r.message };
    info = { duration: Number(r.duration) || 0, width: Number(r.width) || 0, height: Number(r.height) || 0 };
  } finally {
    try { await fsp.unlink(tmpIn); } catch (e) { /* ignore */ }
  }
  wxvWriteMeta(sk, { duration: info.duration, width: info.width, height: info.height, ts: Date.now() });
  const size = fs.statSync(outPath).size;
  wxvLog('[封面] 已生成 ' + path.basename(outPath) + ' (' + size + 'B)' +
    (info.duration ? ', 时长 ' + wxvFormatDuration(info.duration) : ''));
  return {
    ok: true,
    cached: false,
    duration: info.duration,
    width: info.width,
    height: info.height,
    dataUrl: 'data:image/jpeg;base64,' + fs.readFileSync(outPath).toString('base64'),
  };
}

/* 页面注入诊断:中文标题和 decodeKey 依赖页面被重新加载。
   日志里 0 次 [HTML注入] 通常意味着视频号页面一直没重新加载(SPA 常驻),
   把这个数字显示到界面上,用户才知道该去重启微信而不是干等。 */
let wxInjectCount = 0;
let wxFeedCount = 0;
// 本轮代理真正见到过几次「页面 HTML / SPA JS」。0 次 = 微信 WebView 命中磁盘缓存,
// 浏览器根本没发请求,这时候再怎么扩大拦截域名都没用。
let wxPageSeen = 0;
// 解密 worker 脚本被真正改写过几次。0 次 = worker JS 还是命中缓存没重新联网,
// 此时 hook 没机会执行,再怎么播放也拿不到 seed。
let wxWorkerInjectCount = 0;
let wxCacheCleared = 0;

/* 分片是一个个到达的,状态推送做节流,避免每片都重绘界面 */
let wxStatusTimer = null;
function wxvPushStatusSoon() {
  if (wxStatusTimer) return;
  wxStatusTimer = setTimeout(function () {
    wxStatusTimer = null;
    try { sendToMain('wxv:status', wxvStatus()); } catch (e) { /* ignore */ }
  }, 600);
}

function sanitizeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
}

function wxvLog(m) {
  try {
    fs.appendFileSync(path.join(app.getAppPath(), 'wxv-run.log'), '[' + new Date().toISOString() + '] ' + m + '\n', 'utf8');
  } catch (e) { /* ignore */ }
}

function regReadIS(name) {
  try {
    const out = execSync(`reg query "${WXV_INTERNET_SETTINGS}" /v ${name}`, { encoding: 'utf8' });
    const m = out.match(/REG_(SZ|DWORD)\s+(\S+)/);
    return m ? m[2] : '';
  } catch (e) { return ''; }
}
function regWriteIS(name, type, data) {
  try { execSync(`reg add "${WXV_INTERNET_SETTINGS}" /v ${name} /t ${type} /d "${data}" /f`, { stdio: 'ignore' }); } catch (e) { /* ignore */ }
}
function wxvGetSysProxy() {
  return {
    enable: /0x1/i.test(regReadIS('ProxyEnable')),
    server: regReadIS('ProxyServer'),
    override: regReadIS('ProxyOverride'),
    autoConfigUrl: regReadIS('AutoConfigURL'),
  };
}
function wxvApplySysProxy(on, server, override) {
  regWriteIS('ProxyEnable', 'REG_DWORD', on ? '1' : '0');
  if (on && server) regWriteIS('ProxyServer', 'REG_SZ', server);
  if (on && override) regWriteIS('ProxyOverride', 'REG_SZ', override);
}
function wxvRestoreSysProxy(s) {
  if (!s) return;
  regWriteIS('ProxyEnable', 'REG_DWORD', s.enable ? '1' : '0');
  if (s.server) regWriteIS('ProxyServer', 'REG_SZ', s.server);
  if (s.override) regWriteIS('ProxyOverride', 'REG_SZ', s.override);
  if (s.autoConfigUrl) regWriteIS('AutoConfigURL', 'REG_SZ', s.autoConfigUrl);
}
/* ------------------------------------------------------------------
 * 微信 WebView 缓存:拿不到 decodeKey 的真正卡点
 *
 * 视频号 SPA 的 HTML / JS 一旦命中 WebView 磁盘缓存,浏览器不会发任何网络请求,
 * 代理既看不到 HTML 也无法注入 feed 桥,更看不到 feed CGI。此时日志只剩
 * emoji PNG、/mp/jsmonitor、/web/report-perf,「HTML注入 / JS改写 / Feed」恒为 0。
 * wechatVideoDownload 2.8 的说明书要求「先退出微信 → 点删除缓存」就是这个原因。
 *
 * 这里做成「可恢复」:只把 Cache / Code Cache / Service Worker 三个目录重命名进
 * _wxv_bak_<时间戳> 备份目录,绝不删除任何文件;微信进程还在运行时一律拒绝,
 * 避免目录被占用导致半途失败。备份目录内写 manifest.json 供精确还原。
 * ------------------------------------------------------------------ */
const WXV_CACHE_DIRS = ['Cache', 'Code Cache', 'Service Worker'];

function wxvWeChatCacheRoot() {
  const base = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  const candidates = [
    path.join(base, 'Tencent', 'xwechat', 'radium', 'web', 'profiles'),  // 微信 4.x
    path.join(base, 'Tencent', 'WeChat', 'radium', 'web', 'profiles'),   // 旧版
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return candidates[0];
}

function wxvWeChatProcesses() {
  try {
    const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const names = new Set();
    for (const line of String(out).split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)"/);
      if (m && /^we(?:chat|ixin)/i.test(m[1])) names.add(m[1]);
    }
    return Array.from(names);
  } catch (e) { return []; }
}

function wxvCacheTargets(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const profile of fs.readdirSync(root)) {
    if (profile.indexOf('_wxv_bak_') === 0) continue;
    const pd = path.join(root, profile);
    let isDir = false;
    try { isDir = fs.statSync(pd).isDirectory(); } catch (e) { continue; }
    if (!isDir) continue;
    for (const d of WXV_CACHE_DIRS) {
      const p = path.join(pd, d);
      try { if (fs.statSync(p).isDirectory()) out.push({ profile: profile, name: d, path: p }); }
      catch (e) { /* ignore */ }
    }
  }
  return out;
}

function wxvCacheBackups(root) {
  try {
    return fs.readdirSync(root).filter((x) => x.indexOf('_wxv_bak_') === 0).sort().reverse();
  } catch (e) { return []; }
}

/* 纯文件操作,便于独立验证:清理 = 重命名进备份目录 + 写 manifest */
function wxvDoClear(root) {
  if (!fs.existsSync(root)) return { ok: false, message: '未找到微信 WebView 缓存目录：' + root };
  const targets = wxvCacheTargets(root);
  if (!targets.length) return { ok: false, message: '没有找到可清理的 Cache / Code Cache / Service Worker 目录（可能已经清理过，可先「恢复缓存」）。' };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(root, '_wxv_bak_' + stamp);
  try { fs.mkdirSync(backup, { recursive: true }); }
  catch (e) { return { ok: false, message: '创建备份目录失败：' + ((e && e.message) || e) }; }
  const manifest = [];
  const moved = [];
  const errors = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const dest = path.join(backup, String(i) + '__' + t.profile + '__' + t.name.replace(/\s+/g, '_'));
    try {
      fs.renameSync(t.path, dest);
      manifest.push({ from: t.path, to: dest });
      moved.push(t.profile + '/' + t.name);
    } catch (e) {
      errors.push(t.profile + '/' + t.name + '：' + ((e && e.message) || e));
    }
  }
  try { fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 1), 'utf8'); }
  catch (e) { wxvLog('[缓存] manifest 写入失败：' + ((e && e.message) || e)); }
  wxCacheCleared = moved.length;
  wxvLog('[缓存] 移出 ' + moved.length + ' 个 WebView 缓存目录 -> ' + backup +
    (errors.length ? ' | 失败 ' + errors.length + '：' + errors.join('；') : ''));
  return {
    ok: errors.length === 0,
    moved: moved,
    errors: errors,
    backup: backup,
    message: errors.length === 0
      ? '已把 ' + moved.length + ' 个缓存目录移入备份（未删除任何文件）。现在点「启动捕获」，再打开微信进视频号。'
      : '部分目录被占用：' + errors.join('；') + '。已成功的仍可正常使用。',
  };
}

/* 从最近一次备份精确还原:微信重启后若已重建同名目录则跳过,不覆盖新缓存 */
function wxvDoRestore(root) {
  const backups = wxvCacheBackups(root);
  if (!backups.length) return { ok: false, message: '没有可恢复的备份。' };
  const backup = path.join(root, backups[0]);
  let manifest = [];
  try { manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8')); }
  catch (e) { return { ok: false, message: '备份清单读取失败：' + ((e && e.message) || e) }; }
  const restored = [];
  const errors = [];
  for (const rec of manifest) {
    if (!rec || !rec.from || !rec.to || !fs.existsSync(rec.to)) continue;
    if (fs.existsSync(rec.from)) { restored.push(path.basename(rec.from) + '(已重建,跳过)'); continue; }
    try {
      fs.mkdirSync(path.dirname(rec.from), { recursive: true });
      fs.renameSync(rec.to, rec.from);
      restored.push(path.basename(rec.from));
    } catch (e) { errors.push(rec.from + '：' + ((e && e.message) || e)); }
  }
  wxCacheCleared = 0;
  wxvLog('[缓存] 从 ' + backup + ' 还原 ' + restored.length + ' 项' + (errors.length ? ' | 失败 ' + errors.length : ''));
  return { ok: errors.length === 0, restored, errors, backup };
}

function wxvStatus() {
  wxvEnsureFeeds();
  const caps = wxvCaptures();
  const feeds = Array.from(wxFeedStore.values()).reverse();
  // 注意:不要把 caps 原样塞进返回值。它每条都带完整 reqHeaders,而状态是
  // 600ms 节流推送的;渲染进程只需要下面的聚合字段,传全量索引纯属浪费。
  return {
    running: !!(wxProxy && wxProxy.isRunning && wxProxy.isRunning()),
    port: WXV_PORT,
    feeds: feeds,
    streams: wxvStreams(caps, feeds),
    captureCount: caps.length,
    injectCount: wxInjectCount,
    feedCount: wxFeedCount,
    pageSeen: wxPageSeen,
    workerInject: wxWorkerInjectCount,
    cacheCleared: wxCacheCleared,
  };
}

/* 同一视频的每个 Range 请求 URL 都带不同的 svrnonce/taskid/sign,按完整 URL
   分组会把一个视频拆成上百个「1 片流」。encfilekey 才是稳定的视频标识。 */
function wxvStreamKey(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    const k = u.searchParams.get('encfilekey');
    if (k) return 'enc:' + k;
    const p = u.searchParams;
    ['svrnonce', 'taskid', 'sign', 'exportkey', 'pass_ticket', 'wx_header', 'web', 'svrbypass', '_pUid_']
      .forEach((x) => p.delete(x));
    return 'url:' + u.origin + u.pathname + '?' + p.toString();
  } catch (e) { return 'url:' + String(rawUrl); }
}

/* 用 CDN 的 Content-Range 真实总长校正 worker 上报的 contentLen。
   worker 的 seed 与 url 来自同一次播放的 CUT 消息,已是当前视频;
   但 contentLen 偶尔是预加载窗口长度,直接拿它做「feed.size === total」
   二次校验会误丢 key。这里改用代理亲眼看到的权威长度,校验本身仍保留。 */
function wxvKnownTotalForUrl(rawUrl) {
  const k = wxvStreamKey(rawUrl);
  for (const c of wxvCaptures()) {
    if (wxvStreamKey(c.url) !== k) continue;
    const m = /\/(\d+)\s*$/.exec(String(c.contentRange || ''));
    if (m) return Number(m[1]);
  }
  return 0;
}

/* 没有页面注入 feed 时,给流起一个能分辨的名字。
   旧实现用 cap-*.bin 的时间戳当标题,界面上就是一串数字。 */
function wxvHumanSize(n) {
  n = Number(n) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(1) + 'MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + 'KB';
  return n + 'B';
}
function wxvClock(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = function (x) { return String(x).padStart(2, '0'); };
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* 从已落盘的分片重建「视频流」条目。
   界面原先只认页面注入的 feed(feeds),而 feed 依赖 HTML 注入;缓存命中时
   0 次 HTML注入 / 0 次 Feed,却有数百个分片成功落盘 → 界面一直显示空。
   分组键用 encfilekey(稳定视频标识) + Content-Range 里的真实文件长度:
   同一视频多次播放抓到的重复分片可以互补合并,不同清晰度/不同视频自然分开。 */
function wxvStreams(caps, feeds) {
  // 旧记录没有 Content-Range。若同一视频的新记录给出了真实文件长度,
  // 把旧分片并到那一组,否则同一个视频会在列表里出现两条。
  const knownTotal = new Map();
  for (const c of caps || []) {
    if (!c || !c.url) continue;
    const cr = /\/(\d+)\s*$/.exec(String(c.contentRange || ''));
    if (!cr) continue;
    const vk = wxvStreamKey(c.url);
    const t = Number(cr[1]);
    if (t > (knownTotal.get(vk) || 0)) knownTotal.set(vk, t);
  }
  const groups = new Map();
  for (const c of caps || []) {
    if (!c || !c.url || !c.savedPath || Number(c.size) <= 0) continue;
    if (!fs.existsSync(c.savedPath)) continue;
    const size = Number(c.size) || 0;
    const m = /bytes=(\d+)-(\d+)/.exec(String(c.range || ''));
    const cr = /\/(\d+)\s*$/.exec(String(c.contentRange || ''));
    const vk = wxvStreamKey(c.url);
    const realTotal = cr ? Number(cr[1]) : (knownTotal.get(vk) || 0);
    const gk = vk + '|' + realTotal;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push({
      start: m ? Number(m[1]) : 0,
      end: m ? Number(m[2]) : size - 1,
      total: realTotal,
      path: c.savedPath, id: c.id, url: c.url, ts: Number(c.ts) || 0,
      reqHeaders: c.reqHeaders || null, // 补全整段视频时要复用原始签名头
    });
  }
  // decodeKey 是每个视频独立的,绝不能跨视频套用。
  // 旧实现还有一张 feedBySize 表(按「文件大小相等」就取历史 feed 的 key),
  // 不同视频碰巧同长度时会解出乱码 —— 已移除,只认 URL 里的稳定视频标识。
  wxvEnsureTitles();
  const feedByKey = new Map();
  // 来源优先级:worker(播放时实际用的 seed,已验证) > 页面/API feed > 本地缓存记录。
  // 本地 IndexedDB 里的 seed 可能是过期的(实测 12 条里 2 条解不出 MP4),
  // 绝不能让它覆盖掉播放时刚拿到的、确定正确的 worker key。
  const feedRank = function (f) {
    if (f.source === 'decrypt-worker') return 3;
    if (f.source === 'wx-cache-db') return 1;
    return 2;
  };
  for (const f of feeds || []) {
    if (!f) continue;
    const keys = [];
    if (f.url) keys.push(wxvStreamKey(f.url));
    // IndexedDB 的 video_cache_info 只给 encfilekey、没有完整 url
    if (f.encfilekey) keys.push('enc:' + String(f.encfilekey));
    if (!keys.length) continue;
    // 解密 worker 回传的 url 偶尔把 encfilekey 放在编码过的嵌套参数里,
    // 补一条等价索引(仍是从「这条 feed 自己的 url」派生,不引入任何模糊匹配)。
    // 值后面可能跟着被编码的 &token=...(%26token%3D),解码后按 & 截断即可。
    // 不设长度下限:真实 encfilekey 很长,但测试/短链场景也应能正常关联。
    const m = /encfilekey(?:%3[dD]|=)([A-Za-z0-9_%.\-]{4,})/i.exec(String(f.url));
    if (m) {
      let k = m[1];
      try { k = decodeURIComponent(k); } catch (e) { /* ignore */ }
      k = String(k).split('&')[0];
      if (k.length >= 4) keys.push('enc:' + k);
    }
    for (const fk of keys) {
      const prev = feedByKey.get(fk);
      if (!prev) { feedByKey.set(fk, f); continue; }
      const r = feedRank(f);
      const pr = feedRank(prev);
      if (r > pr) { feedByKey.set(fk, f); continue; }
      if (r === pr && Number(f.ts || 0) >= Number(prev.ts || 0)) feedByKey.set(fk, f);
    }
  }
  const out = [];
  for (const [gk, list] of groups) {
    // 同一段 Range 可能被多轮播放重复抓到,去重时优先保留带真实长度的那份
    const uniq = new Map();
    for (const s of list) {
      const k = s.start + '-' + s.end;
      const prev = uniq.get(k);
      if (!prev || (s.total && !prev.total)) uniq.set(k, s);
    }
    const segs = Array.from(uniq.values()).sort((a, b) => (a.start - b.start) || (b.end - a.end));
    if (!segs.length) continue;
    let total = 0;
    let sizeKnown = false;
    for (const s of segs) if (s.total) { total = Math.max(total, s.total); sizeKnown = true; }
    if (!total) for (const s of segs) total = Math.max(total, s.end + 1);
    let cursor = 0;
    for (const s of segs) {
      if (s.start > cursor) break; // 有缺口就停,后续字节不能错位拼接
      cursor = Math.max(cursor, s.end + 1);
    }
    const vidKey = gk.slice(0, gk.lastIndexOf('|'));
    const cand = feedByKey.get(vidKey) || null;
    // 第二道校验:同一视频的 feed.fileSize 必然等于 CDN 给出的真实长度。
    // 对不上就说明是别的视频/旧轮次残留,标题和 key 都不采用。
    const sizeMismatch = cand && Number(cand.size) > 0 && sizeKnown && Number(cand.size) !== total;
    const feed = sizeMismatch ? null : cand;
    const ts = Math.max.apply(null, segs.map((s) => s.ts));
    const coveredAll = cursor >= total;
    const withHdr = segs.find(function (s) { return s.reqHeaders && Object.keys(s.reqHeaders).length; });
    // 用户命名的优先级最高:feed 标题拿不到(见 wxTitleStore 注释),但用户自己知道是哪个视频
    const custom = wxTitleStore.get(vidKey) || '';
    // 时长/分辨率来自生成封面时顺带写的 .json(见 wxvWriteMeta)
    const mediaMeta = wxvReadMeta(vidKey);
    const duration = mediaMeta ? (Number(mediaMeta.duration) || 0) : 0;
    out.push({
      id: 'stream-' + segs[0].id,
      url: segs[0].url,
      // 有自定义名/真实 feed 标题就用它,否则给「大小 + 片数 + 时间」的可分辨名字
      title: custom || ((feed && feed.title) ? feed.title
        : ('视频 ' + wxvHumanSize(total) + ' · ' + segs.length + ' 片 · ' + wxvClock(ts))),
      customTitle: !!custom,
      hasFeedTitle: !!(custom || (feed && feed.title)),
      hasThumb: (function () {
        try { const p = wxvThumbFile(vidKey); return fs.existsSync(p) && fs.statSync(p).size > 0; } catch (e) { return false; }
      })(),
      duration: duration, // 秒,0 = 还没探测到
      durationText: wxvFormatDuration(duration),
      width: mediaMeta ? (Number(mediaMeta.width) || 0) : 0,
      height: mediaMeta ? (Number(mediaMeta.height) || 0) : 0,
      key: (feed && feed.key !== undefined && feed.key !== null && feed.key !== '') ? feed.key : null,
      size: total,
      sizeKnown: sizeKnown, // 旧记录没有 Content-Range,总长只是推断值
      covered: cursor,
      parts: segs.length,
      missing: Math.max(0, total - cursor),
      complete: coveredAll,
      ts: ts,
      reqHeaders: withHdr ? withHdr.reqHeaders : null,
      canComplete: !!(withHdr && sizeKnown && !coveredAll), // 界面可提示「导出时自动补全」
      capParts: segs.map((s) => ({ start: s.start, end: s.end, path: s.path, id: s.id })),
    });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, 30);
}

/* 捕获索引:磁盘历史 + 本次会话合并去重。
   旧实现每次都用「当前会话内存列表」整体覆盖 index.json,重启捕获后
   之前几轮的索引就丢了(.bin 还在但找不到),这里改为按 id 合并。 */
const WXV_CAPTURE_LIMIT = 500;
let wxCaptureCache = null;

function wxvCaptureIndexPath() {
  return path.join(app.getPath('userData'), 'wx-captures', 'index.json');
}
function wxvReadCaptures() {
  try {
    const arr = JSON.parse(fs.readFileSync(wxvCaptureIndexPath(), 'utf8'));
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => x && x.id && Number(x.size) > 0);
  } catch (e) { return []; }
}
function wxvCaptures() {
  if (!wxCaptureCache) wxCaptureCache = wxvReadCaptures();
  if (wxProxy) {
    const known = new Set(wxCaptureCache.map((x) => x && x.id));
    for (const it of wxProxy.getCaptures()) {
      if (it && it.id && !known.has(it.id)) { wxCaptureCache.unshift(it); known.add(it.id); }
    }
    wxCaptureCache.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
    if (wxCaptureCache.length > WXV_CAPTURE_LIMIT) wxCaptureCache.length = WXV_CAPTURE_LIMIT;
  }
  return wxCaptureCache;
}
function wxvSaveCaptures() {
  try {
    const dir = path.dirname(wxvCaptureIndexPath());
    fs.mkdirSync(dir, { recursive: true });
    const merged = new Map();
    for (const it of wxvReadCaptures()) if (it && it.id) merged.set(it.id, it);
    if (wxCaptureCache) for (const it of wxCaptureCache) if (it && it.id) merged.set(it.id, it);
    if (wxProxy) for (const it of wxProxy.getCaptures()) if (it && it.id) merged.set(it.id, it);
    wxCaptureCache = Array.from(merged.values())
      .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
      .slice(0, WXV_CAPTURE_LIMIT);
    fs.writeFileSync(wxvCaptureIndexPath(), JSON.stringify(wxCaptureCache, null, 1), 'utf8');
  } catch (e) { /* ignore */ }
}

/* 直接用给定列表覆盖索引(删除/清空时用)。
   不能走 wxvSaveCaptures():它会把磁盘旧索引再合并回来,删掉的记录会复活。 */
function wxvRewriteIndex(list) {
  const arr = (list || []).filter((c) => c && c.id).slice(0, WXV_CAPTURE_LIMIT);
  try {
    fs.mkdirSync(path.dirname(wxvCaptureIndexPath()), { recursive: true });
    fs.writeFileSync(wxvCaptureIndexPath(), JSON.stringify(arr, null, 1), 'utf8');
  } catch (e) { /* ignore */ }
  wxCaptureCache = arr;
  return arr.length;
}

function wxvCapturesDir() {
  return path.join(app.getPath('userData'), 'wx-captures');
}

/* 删除若干分片记录:索引 + 落盘文件 + 代理内存,三处一起删。
   decodeKey 与自定义标题按视频标识保存,不属于"捕获记录",故保留。 */
async function wxvDeleteCapturesByIds(ids) {
  const set = new Set((ids || []).filter(Boolean));
  if (!set.size) return { ok: true, removed: 0, files: 0, bytes: 0 };
  const all = wxvCaptures();
  const gone = all.filter((c) => c && set.has(c.id));
  let files = 0;
  let bytes = 0;
  for (const c of gone) {
    if (!c.savedPath) continue;
    try { bytes += fs.statSync(c.savedPath).size; } catch (e) { /* ignore */ }
    try { await fsp.rm(c.savedPath, { force: true }); files += 1; } catch (e) { /* ignore */ }
  }
  try { if (wxProxy && wxProxy.dropCaptures) wxProxy.dropCaptures(Array.from(set)); } catch (e) { /* ignore */ }
  wxvRewriteIndex(all.filter((c) => !(c && set.has(c.id))));
  wxvPushStatusSoon();
  return { ok: true, removed: gone.length, files: files, bytes: bytes };
}

ipcMain.handle('wxv:start', async () => {
  try {
    // 开始捕获时先扫一遍本地 IndexedDB:已经缓存过的视频能立刻拿到 seed,
    // 不必等播放触发 worker 的 CUT 消息。只读,失败不影响后续。
    try { wxvScanVideoCacheDb(); } catch (e) { /* ignore */ }
    if (!wxProxy) {
      const { createProxy } = require('./wx-proxy');
      wxProxy = createProxy({
        port: WXV_PORT,
        version: String(Date.now()),
        dataDir: app.getPath('userData'),
        onLog: (line) => {
          wxvLog(line);
          sendToMain('wxv:log', line);
          if (String(line).indexOf('[HTML注入]') >= 0) {
            wxInjectCount += 1;
            wxvPushStatusSoon();
          }
          if (/\[HTML文档\]|\[页面资源\]|\[JS改写\]/.test(String(line))) {
            wxPageSeen += 1;
            wxvPushStatusSoon();
          }
          if (String(line).indexOf('[Worker注入]') >= 0) {
            wxWorkerInjectCount += 1;
            wxvPushStatusSoon();
          }
        },
      });
      wxProxy.on('capture', (info) => {
        wxvLog('[捕获] ' + info.host + ' ' + info.size + 'B range=' + (info.range || '-') + ' ct=' + (info.contentType || '-') + ' url=' + String(info.url || '').slice(0, 400));
        wxvSaveCaptures();
        sendToMain('wxv:captured', info);
        wxvPushStatusSoon();
      });
      wxProxy.on('feed', (item) => {
        try {
          // 解密 worker 上报的 key:用 CDN 真实长度校正 size,保留二次校验
          if (item && item.source === 'decrypt-worker') {
            const real = wxvKnownTotalForUrl(item.url);
            if (real) item = Object.assign({}, item, { size: real });
            wxvLog('[WorkerKey] 主进程收到 seed=' + item.key + ' 校正size=' + (item.size || 0) +
              ' streamKey=' + String(wxvStreamKey(item.url)).slice(0, 70));
          }
          wxFeedCount += 1;
          wxvEnsureFeeds();
          const existed = wxFeedStore.has(item.id);
          wxFeedStore.set(item.id, Object.assign({}, item, { ts: Date.now() }));
          wxvSaveFeeds();
          if (wxFeedStore.size > 100) {
            const first = wxFeedStore.keys().next().value;
            wxFeedStore.delete(first);
          }
          wxvLog('[Feed] ' + (existed ? '(更新)' : '(新增)') + ' ' + (item.title || item.id) + ' key=' + item.key + ' size=' + item.size);
          sendToMain('wxv:feed', item);
          // feed 带了 decodeKey,要重建 streams 才能把 key 关联到已抓到的视频流上
          wxvPushStatusSoon();
        } catch (e) { /* ignore */ }
      });
    }
    const r = await wxProxy.start();
    if (!wxSavedProxy) {
      wxSavedProxy = wxvGetSysProxy();
      wxvLog('系统代理原配置: enable=' + wxSavedProxy.enable + ' server=' + wxSavedProxy.server + ' override=' + wxSavedProxy.override + ' pac=' + wxSavedProxy.autoConfigUrl);
    }
    wxvApplySysProxy(true, '127.0.0.1:' + r.port, '<local>;localhost;127.0.0.1');
    if (wxSavedProxy.autoConfigUrl) {
      try { execSync(`reg delete "${WXV_INTERNET_SETTINGS}" /v AutoConfigURL /f`, { stdio: 'ignore' }); } catch (e) { /* ignore */ }
    }
    wxvLog('捕获已启动,系统代理已指向 127.0.0.1:' + r.port);
    sendToMain('wxv:status', wxvStatus());
    return { ok: true, port: r.port, caPath: r.caPath };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    wxvLog('启动失败:' + msg);
    return { ok: false, message: msg };
  }
});

ipcMain.handle('wxv:stop', async () => {
  try {
    wxvRestoreSysProxy(wxSavedProxy);
    wxSavedProxy = null;
    if (wxProxy) await wxProxy.stop();
    wxvSaveCaptures();
    // 释放懒加载的代理实例并清模块缓存:下次「启动捕获」会重新 require wx-proxy.js。
    // 否则只点停止/启动时,内存里的旧实例会一直用旧代码,改了文件也看不出效果。
    wxProxy = null;
    wxCaptureCache = null;
    try { delete require.cache[require.resolve('./wx-proxy')]; } catch (e) { /* ignore */ }
    wxvLog('捕获已停止,系统代理已还原(代理模块已卸载,下次启动将加载最新代码)');
    sendToMain('wxv:status', wxvStatus());
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e) };
  }
});

ipcMain.handle('wxv:status', () => wxvStatus());

/* 手动命名:标题无法自动获取,只能用户自己起名。
   键用视频稳定标识(encfilekey),所以同一视频换一轮捕获、换个分片顺序仍然对得上。 */
ipcMain.handle('wxv:rename-stream', (e, payload) => {
  try {
    const p = payload || {};
    const id = String(p.id || '');
    const title = String(p.title || '').trim().slice(0, 120);
    if (!id) return { ok: false, error: '缺少视频流 id' };
    wxvEnsureFeeds();
    const streams = wxvStreams(wxvCaptures(), Array.from(wxFeedStore.values()));
    const s = streams.find((x) => x.id === id);
    if (!s) return { ok: false, error: '视频流已变化，请刷新后重试' };
    const k = wxvStreamKey(s.url);
    if (!k) return { ok: false, error: '无法确定视频标识' };
    wxvEnsureTitles();
    if (title) wxTitleStore.set(k, title); else wxTitleStore.delete(k);
    wxvSaveTitles();
    wxvPushStatusSoon();
    wxvLog('[改名] ' + (title ? title : '(恢复默认)') + ' -> ' + String(k).slice(0, 70));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

/* 从本地 IndexedDB 补 key(第 4 条通路,纯只读扫描,不删除任何文件) */
ipcMain.handle('wxv:scan-cache-db', () => {
  try {
    const added = wxvScanVideoCacheDb();
    return { ok: true, added: added, files: wxvIndexedDbFiles().length };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

/* 抽首帧当封面(标题拿不到,用画面认视频) */
ipcMain.handle('wxv:stream-thumb', async (_e, item) => {
  try {
    return await wxvStreamThumb(item);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

/* 删除单条视频流:分片文件 + 索引 + 封面一起删 */
ipcMain.handle('wxv:delete-stream', async (_e, streamId) => {
  try {
    wxvEnsureFeeds();
    const streams = wxvStreams(wxvCaptures(), Array.from(wxFeedStore.values()));
    const s = streams.find((x) => x.id === streamId);
    if (!s) return { ok: false, error: '视频流已变化，请刷新后重试' };
    const ids = (s.capParts || []).map((p) => p.id);
    const r = await wxvDeleteCapturesByIds(ids);
    // 封面和时长缓存一起删,否则下次抓到同一视频会沿用旧时长
    const sk = wxvStreamKey(s.url);
    try { await fsp.rm(wxvThumbFile(sk), { force: true }); } catch (e) { /* ignore */ }
    try { await fsp.rm(wxvMetaFile(sk), { force: true }); } catch (e) { /* ignore */ }
    wxMetaCache.delete(String(sk || ''));
    wxvLog('[删除] 视频流 ' + (s.title || s.id) + ' 共 ' + r.files + ' 片 / ' + wxvHumanSize(r.bytes));
    return r;
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

/* 一键清除所有捕获记录(分片文件 + 索引 + 封面;decodeKey/自定义标题保留) */
ipcMain.handle('wxv:clear-captures', async () => {
  try {
    const all = wxvCaptures();
    let files = 0;
    let bytes = 0;
    for (const c of all) {
      if (!c || !c.savedPath) continue;
      try { bytes += fs.statSync(c.savedPath).size; } catch (e) { /* ignore */ }
      try { await fsp.rm(c.savedPath, { force: true }); files += 1; } catch (e) { /* ignore */ }
    }
    // 兜底:目录里存在但索引里没有的孤儿分片
    try {
      for (const f of fs.readdirSync(wxvCapturesDir())) {
        if (!/^cap-.*\.bin$/i.test(f)) continue;
        const p = path.join(wxvCapturesDir(), f);
        try { bytes += fs.statSync(p).size; } catch (e) { /* ignore */ }
        try { await fsp.rm(p, { force: true }); files += 1; } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    // 封面也一起清掉
    let thumbs = 0;
    try {
      const td = path.join(wxvCapturesDir(), 'thumbs');
      for (const f of fs.readdirSync(td)) {
        try { await fsp.rm(path.join(td, f), { force: true }); thumbs += 1; } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    try { if (wxProxy && wxProxy.clearCaptures) wxProxy.clearCaptures(); } catch (e) { /* ignore */ }
    wxMetaCache.clear(); // 时长缓存跟着封面一起没了,不清会显示幽灵时长
    wxvRewriteIndex([]);
    wxvPushStatusSoon();
    wxvLog('[清除] 删除 ' + files + ' 个分片 / ' + thumbs + ' 张封面 / ' + wxvHumanSize(bytes) + '（decodeKey 与自定义标题保留）');
    return { ok: true, removed: all.length, files: files, thumbs: thumbs, bytes: bytes };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

/* 只读诊断:缓存目录、微信进程、备份、本轮页面请求数 */
ipcMain.handle('wxv:cache-info', () => {
  const root = wxvWeChatCacheRoot();
  let targets = [];
  try { targets = wxvCacheTargets(root); } catch (e) { /* ignore */ }
  return {
    ok: true,
    root: root,
    exists: fs.existsSync(root),
    running: wxvWeChatProcesses(),
    targets: targets.map((x) => x.profile + '/' + x.name),
    backups: wxvCacheBackups(root),
    pageSeen: wxPageSeen,
    workerInject: wxWorkerInjectCount,
    cleared: wxCacheCleared,
  };
});

/* 清理 = 可逆重命名,不删除任何文件;微信未完全退出时拒绝 */
ipcMain.handle('wxv:cache-clear', () => {
  const running = wxvWeChatProcesses();
  if (running.length) {
    return { ok: false, message: '微信仍在运行（' + running.join('、') + '）。请先彻底退出微信：右键托盘图标退出，必要时在任务管理器结束 WeChatAppEx.exe，然后再点清理。' };
  }
  try { return wxvDoClear(wxvWeChatCacheRoot()); }
  catch (e) { return { ok: false, message: ((e && e.message) || String(e)) }; }
});

ipcMain.handle('wxv:cache-restore', () => {
  const running = wxvWeChatProcesses();
  if (running.length) return { ok: false, message: '请先彻底退出微信再恢复缓存。' };
  try { return wxvDoRestore(wxvWeChatCacheRoot()); }
  catch (e) { return { ok: false, message: ((e && e.message) || String(e)) }; }
});

ipcMain.handle('wxv:install-cert', () => {
  const caPath = wxProxy && wxProxy.caPath ? wxProxy.caPath : '';
  if (!caPath || !fs.existsSync(caPath)) return { ok: false, message: '证书尚未生成(请先启动捕获)' };
  try {
    execSync(`certutil -user -addstore Root "${caPath}"`, { stdio: 'pipe' });
    wxvLog('CA 证书已安装到当前用户根证书库:' + caPath);
    return { ok: true };
  } catch (e) {
    const msg = String((e && e.stderr) || (e && e.message) || '');
    if (/0x800700b7|already exists|已存在/i.test(msg)) return { ok: true, message: '证书此前已安装' };
    wxvLog('安装证书失败:' + msg.slice(0, 300));
    return { ok: false, message: msg.slice(0, 300) || String(e) };
  }
});

ipcMain.handle('wxv:download', async (_e, url, savePath, reqHeaders) => {
  try {
    if (!/^https:\/\//i.test(String(url || ''))) return { ok: false, message: '仅支持 https 直链' };
    if (!savePath) return { ok: false, message: '未指定保存路径' };
    const headers = Object.assign(
      { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity' },
      reqHeaders || {}
    );
    delete headers['accept-encoding'];
    delete headers['Accept-Encoding'];
    delete headers['range'];
    delete headers['host'];
    delete headers['content-length'];
    delete headers['proxy-connection'];
    const r = await downloadStream([String(url)], savePath, 'wxv', headers);
    if (!r.ok) {
      wxvLog('完整下载失败:' + r.message);
      return r;
    }
    // 文件头检测:标准 MP4 应在第 4-7 字节出现 "ftyp";不是则基本可判定为加密流
    let head = { isMp4: false, hex: '' };
    try {
      const fd = fs.openSync(savePath, 'r');
      const b = Buffer.alloc(16);
      fs.readSync(fd, b, 0, 16, 0);
      fs.closeSync(fd);
      head = { isMp4: b.toString('latin1', 4, 8) === 'ftyp', hex: b.toString('hex') };
    } catch (e) { /* ignore */ }
    wxvLog('完整下载完成 ' + savePath + '(' + r.bytes + 'B) 文件头=' + head.hex + ' -> ' + (head.isMp4 ? '标准 MP4,未加密 ✓' : '非标准 MP4 头,疑似加密流 ✗'));
    return { ok: true, bytes: r.bytes, head: head };
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e) };
  }
});

ipcMain.handle('wxv:open', async (_e, p) => {
  try {
    if (!p || !fs.existsSync(p)) return { ok: false, message: '文件不存在' };
    const err = await shell.openPath(p);
    return err ? { ok: false, message: err } : { ok: true };
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e) };
  }
});

ipcMain.handle('wxv:feed-download', async (_e, item, savePath) => {
  try {
    if (!item || !/^https:\/\//i.test(String(item.url || ''))) return { ok: false, message: '视频地址无效' };
    if (item.key === undefined || item.key === null || item.key === '') return { ok: false, message: '缺少 decodeKey(请重新打开该视频页面后重试)' };
    if (!savePath) return { ok: false, message: '未指定保存路径' };
    const tmp = savePath + '.enc.part';
    const r = await downloadStream([String(item.url)], tmp, 'wxv', {});
    if (!r.ok) {
      try { await fsp.rm(tmp, { force: true }); } catch (e2) { /* ignore */ }
      wxvLog('[下载] 失败:' + r.message);
      return { ok: false, message: r.message };
    }
    wxvLog('[下载] 完成 ' + r.bytes + 'B,开始解密 key=' + item.key);
    const { decryptBuffer } = require('./wxv-decrypt');
    const raw = await fsp.readFile(tmp);
    const dec = await decryptBuffer(raw, item.key, app.getPath('userData'), (m) => wxvLog(m));
    await fsp.writeFile(savePath, dec);
    await fsp.rm(tmp, { force: true });
    const isMp4 = dec.length > 12 && dec.toString('latin1', 4, 8) === 'ftyp';
    wxvLog('[解密] 完成 ' + savePath + ' 头部=' + (isMp4 ? 'ftyp ✓' : dec.slice(0, 12).toString('hex')));
    sendToMain('dl:progress', { key: 'wxv', received: dec.length, total: dec.length });
    return { ok: true, head: { isMp4: isMp4, hex: dec.slice(0, 16).toString('hex') } };
  } catch (e) {
    wxvLog('[解密下载] 异常:' + ((e && e.message) || e));
    return { ok: false, message: (e && e.message) || String(e) };
  }
});

/* 播放器按需只请求看过的 Range,所以列表里常有「28.6MB 只抓到 2.8MB」。
   我们已经有完整 URL 和当时的请求头,可以再发一次不带 Range 的 GET 把整段
   视频拉下来(日志里已证实该 CDN 无 Range 时返回 200 + 完整 body)。
   这是主进程直连,不经过本地代理,不会再触发一次捕获。 */
function wxvFetchFull(rawUrl, reqHeaders, savePath) {
  return new Promise(function (resolve, reject) {
    let u;
    try { u = new URL(String(rawUrl)); } catch (e) { reject(new Error('URL 无效')); return; }
    const h = Object.assign({}, reqHeaders || {});
    ['range', 'Range', 'if-none-match', 'if-modified-since', 'content-length',
     'transfer-encoding', 'proxy-connection', 'proxy-authorization'].forEach(function (k) { delete h[k]; });
    h.host = u.host;
    h['accept-encoding'] = 'identity';
    h.connection = 'close';
    if (!h['user-agent']) h['user-agent'] = UA;
    let settled = false;
    const done = function (err, info) {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(info);
    };
    const req = https.request({
      host: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method: 'GET', headers: h, rejectUnauthorized: false, agent: false,
      insecureHTTPParser: true, timeout: 60000,
    }, function (res) {
      const status = res.statusCode || 0;
      if (status !== 200 && status !== 206) {
        res.resume();
        done(new Error('上游返回 ' + status));
        return;
      }
      const out = fs.createWriteStream(savePath);
      res.on('data', function () { /* pipe 负责写入,这里只保持流消费 */ });
      res.on('error', function (e) { out.destroy(); done(e); });
      out.on('error', function (e) { res.destroy(); done(e); });
      // Windows 上 finish 只代表数据写完,fd 还没释放;若此时 resolve,
      // 调用方紧接着 rename 会 EBUSY/EPERM。必须等 close。
      out.on('close', function () { done(null, { bytes: out.bytesWritten, status: status }); });
      res.pipe(out);
    });
    req.on('timeout', function () { req.destroy(new Error('补全请求超时')); });
    req.on('error', function (e) { done(e); });
    req.end();
  });
}

/* 把已落盘的 Range 分片按偏移合并成一个文件。
   分片不全时先用原始 URL 重新拉完整视频;有 decodeKey 时解密前 131072 字节
   还原可播放 MP4;没有 key 时保存原始加密流并明确提示。 */
ipcMain.handle('wxv:stream-download', async (_e, item, savePath) => {
  try {
    if (!item || !Array.isArray(item.capParts) || !item.capParts.length) return { ok: false, message: '没有可合并的分片' };
    if (!savePath) return { ok: false, message: '未指定保存路径' };
    const parts = item.capParts.slice().sort((a, b) => (a.start - b.start) || (b.end - a.end));
    let written = 0;
    let fullFetched = false;
    // 分片不全:用原始 URL + 原请求头重新拉一次完整视频,比拼残缺分片可靠得多
    if (item.sizeKnown && !item.complete && item.reqHeaders &&
        /^https:\/\//i.test(String(item.url || ''))) {
      const tmpFull = savePath + '.full';
      try {
        const r = await wxvFetchFull(item.url, item.reqHeaders, tmpFull);
        if (r.bytes >= Math.floor(Number(item.size) * 0.98)) {
          await fsp.rm(savePath, { force: true });
          await fsp.rename(tmpFull, savePath);
          written = r.bytes;
          fullFetched = true;
          wxvLog('[补全] 重新下载完整视频 ' + r.bytes + 'B(原仅 ' + item.covered + 'B) -> ' + savePath);
        } else {
          wxvLog('[补全] 只拿到 ' + r.bytes + 'B / 期望 ' + item.size + 'B,回退分片合并');
          await fsp.rm(tmpFull, { force: true });
        }
      } catch (e) {
        wxvLog('[补全] 失败(签名可能已过期):' + ((e && e.message) || e) + ' -> 回退分片合并');
        try { await fsp.rm(tmpFull, { force: true }); } catch (e2) { /* ignore */ }
      }
    }
    if (!fullFetched) {
      const out = fs.createWriteStream(savePath);
      let cursor = 0;
      for (const p of parts) {
        if (!p.path || !fs.existsSync(p.path)) continue;
        if (p.start > cursor) break; // 有缺口就停:绝不能把高偏移字节写到低偏移位置
        if (p.end < cursor) continue;
        const off = cursor - p.start;
        const len = p.end - cursor + 1;
        if (len <= 0 || off < 0) continue;
        const buf = await fsp.readFile(p.path);
        const data = buf.slice(off, off + len);
        if (!data.length) continue;
        await new Promise((res, rej) => out.write(data, (err) => (err ? rej(err) : res())));
        written += data.length;
        cursor += data.length;
      }
      await new Promise((res, rej) => out.end((err) => (err ? rej(err) : res())));
      wxvLog('[合并] ' + written + 'B / ' + parts.length + '片 -> ' + savePath);
    }
    if (item.key !== undefined && item.key !== null && item.key !== '') {
      const { decryptBuffer } = require('./wxv-decrypt');
      const raw = await fsp.readFile(savePath);
      const dec = await decryptBuffer(raw, item.key, app.getPath('userData'), (m) => wxvLog(m));
      await fsp.writeFile(savePath, dec);
      const isMp4 = dec.length > 12 && dec.toString('latin1', 4, 8) === 'ftyp';
      wxvLog('[合并解密] key=' + item.key + ' 头部=' + (isMp4 ? 'ftyp ✓' : dec.slice(0, 12).toString('hex')));
      if (!isMp4) {
        // key 错了还留一个坏文件在用户目录里没有意义,删掉并说明原因
        try { await fsp.rm(savePath, { force: true }); } catch (e2) { /* ignore */ }
        const dropped = wxvDropStaleDbKey(item.key);
        return {
          ok: false,
          message: '解密后不是 MP4：这条 key 与视频不匹配' +
            (dropped ? '（来自过期缓存，已丢弃，请播放该视频重新获取 key）' : ''),
        };
      }
      // 导出成功后顺带记下时长:用户没点过「封面」时,列表里也能看到时长
      if (isMp4 && item.url) {
        try {
          const msk = wxvStreamKey(item.url);
          if (msk && !wxvReadMeta(msk)) {
            const pi = await probeMedia(savePath);
            if (pi.ok) {
              wxvWriteMeta(msk, { duration: pi.duration, width: pi.width, height: pi.height, ts: Date.now() });
              wxvLog('[时长] ' + wxvFormatDuration(pi.duration) + ' (' + pi.width + 'x' + pi.height + ')');
              wxvPushStatusSoon();
            }
          }
        } catch (e) { /* 读时长失败不影响导出结果 */ }
      }
      return { ok: true, bytes: written, decrypted: true, isMp4: isMp4, fetchedFull: fullFetched };
    }
    return { ok: true, bytes: written, needKey: true, fetchedFull: fullFetched };
  } catch (e) {
    wxvLog('[合并] 异常:' + ((e && e.message) || e));
    return { ok: false, message: (e && e.message) || String(e) };
  }
});

/* ============================================================
 * 微信表情包导出:包装开源工具 wxemoticon(见 emoji-export.js)
 * 从运行中的微信提取密钥 → 解密表情索引 → 从微信 CDN 下载原图
 * ============================================================ */
const emojiExport = require('./emoji-export');
let emojiBusy = false;
let emojiChild = null;

ipcMain.handle('emoji:status', () => emojiExport.status());
ipcMain.handle('emoji:accounts', () => emojiExport.listAccounts());
ipcMain.handle('emoji:pick-dir', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: '选择导出目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('emoji:open', (_e, p) => shell.openPath(String(p || '')));
ipcMain.handle('emoji:install', async (_e, mode) => {
  if (emojiBusy) return { ok: false, message: '有任务进行中' };
  emojiBusy = true;
  try {
    if (mode === 'zip') {
      const zip = await dialog.showOpenDialog(mainWin, {
        title: '选择 ' + emojiExport.ZIP_NAME,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
        properties: ['openFile'],
      });
      if (zip.canceled) return { ok: false, message: '已取消' };
      return await emojiExport.installFromZip(zip.filePaths[0], { log: (m) => sendToMain('emoji:log', { msg: m }) });
    }
    return await emojiExport.installTool({
      log: (m) => sendToMain('emoji:log', { msg: m }),
      progress: (p) => sendToMain('emoji:progress', p),
    });
  } finally {
    emojiBusy = false;
  }
});
ipcMain.handle('emoji:export', async (_e, opts) => {
  if (emojiBusy) return { ok: false, message: '有任务进行中' };
  emojiBusy = true;
  sendToMain('emoji:progress', { stage: 'start' });
  try {
    const r = await emojiExport.exportStickers(opts || {}, {
      log: (m) => sendToMain('emoji:log', { msg: m }),
      progress: (p) => sendToMain('emoji:progress', p),
      register: (child) => { emojiChild = child; },
    });
    sendToMain('emoji:done', r);
    return r;
  } catch (e) {
    const r = { ok: false, message: (e && e.message) || String(e) };
    sendToMain('emoji:done', r);
    return r;
  } finally {
    emojiChild = null;
    emojiBusy = false;
  }
});
ipcMain.handle('emoji:stop', () => {
  if (emojiChild) {
    try { emojiChild.kill(); } catch (e) { /* ignore */ }
    emojiChild = null;
  }
  emojiBusy = false;
  sendToMain('emoji:log', { msg: '已停止' });
  sendToMain('emoji:done', { ok: false, stopped: true, message: '已手动停止' });
  return { ok: true };
});

app.on('before-quit', () => {
  // 退出前还原系统代理,避免残留 127.0.0.1:8899 导致断网
  try {
    wxvSaveCaptures();
    if (wxSavedProxy) wxvRestoreSysProxy(wxSavedProxy);
    else if (wxProxy && wxProxy.isRunning()) wxvApplySysProxy(false, '', '');
  } catch (e) { /* ignore */ }
  try { if (wxProxy && wxProxy.isRunning()) wxProxy.stop(); } catch (e) { /* ignore */ }
});
/* ---------- 主窗口 ---------- */
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 780,
    height: 720,
    minWidth: 640,
    minHeight: 560,
    title: 'B 站助手 · 视频下载',
    autoHideMenuBar: true,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.disableHardwareAcceleration(); // 某些 Windows 显卡驱动会导致 GPU 进程崩溃(0xC0000409),禁用后走软件渲染

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });
  app.whenReady().then(createMainWindow);
}

app.on('window-all-closed', () => app.quit());
