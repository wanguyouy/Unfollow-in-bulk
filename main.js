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
const { app, BrowserWindow, ipcMain, session, dialog, shell, nativeImage } = require('electron');
const { spawn, spawnSync, execSync } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

// —— 绿色版便携支持 ——
// 打包版(isPackaged)把 userData 重定向到 exe 同目录的 data/，实现“解压即用、数据随身”；
// 开发模式(electron .)保持默认 AppData，避免污染项目目录。数据目录切换对所有
// app.getPath('userData') 调用(分片索引/封面/命名/feed)自动生效，无需改动其它逻辑。
(function setupPortableUserData() {
  try {
    if (!app.isPackaged) return;
    const exeDir = path.dirname(process.execPath);
    const dataDir = path.join(exeDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK); // Program Files 等受保护目录会抛错 → 回退默认
    app.setPath('userData', dataDir);
  } catch (e) {
    /* 回退到默认 AppData */
  }
})();

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
/* 打包后 @ffmpeg-installer 的 ffmpeg.exe 在 app.asar 里:
   fs.existsSync 对它返回 true(Electron 的 asar 补丁),但 spawn 一个 asar 内部
   路径必然是 ENOENT —— 这正是其他机器上「封面失败:ffmpeg 启动失败 … app.asar
   …ffmpeg.exe ENOENT」的原因。所以:
     ① 打包配置里把 @ffmpeg-installer 整个 asarUnpack 出去;
     ② 这里跳过任何 app.asar 内部路径,并把候选改写成 app.asar.unpacked;
     ③ 逐个候选真的跑一次 -version,只有退出码 0 才算可用(顺带排掉缺 DLL 的);
     ④ 全都不可用时给出能照做的提示,而不是把 ENOENT 直接抛给用户。 */
let _ffmpegPath;
let _ffmpegTried = [];

function ffmpegCandidates() {
  const out = [];
  const push = (p) => { if (p && out.indexOf(p) < 0) out.push(p); };
  try {
    const installed = require('@ffmpeg-installer/ffmpeg').path;
    if (installed) {
      // 若在 asar 内,真实文件在 app.asar.unpacked 的同名相对路径下
      const rel = String(installed).replace(/^.*?app\.asar[\\/]/, '');
      if (process.resourcesPath) push(path.join(process.resourcesPath, 'app.asar.unpacked', rel));
      push(String(installed).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'));
      push(installed);
    }
  } catch (e) { /* 依赖没装,继续找系统 ffmpeg */ }
  // 便携版/绿色版:允许用户把 ffmpeg.exe 丢到程序目录或 data/ffmpeg/ 下
  try {
    const base = app.isPackaged ? path.dirname(process.execPath) : __dirname;
    for (const dir of [base, path.join(base, 'data'), path.join(base, 'ffmpeg'), path.join(base, 'ffmpeg', 'bin')]) {
      push(path.join(dir, 'ffmpeg.exe'));
      push(path.join(dir, 'ffmpeg'));
    }
  } catch (e) { /* ignore */ }
  // 系统 PATH
  try {
    const out2 = execSync('where ffmpeg', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    String(out2).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).forEach(push);
  } catch (e) { /* 没有就算了 */ }
  return out;
}

function ffmpegUsable(p) {
  if (!p) return false;
  // asar 内部路径一律不可执行:必须走 app.asar.unpacked
  if (/[\\/]app\.asar[\\/]/i.test(p)) return false;
  try { return fs.existsSync(p); } catch (e) { return false; }
}

function ffmpegReset() { _ffmpegPath = undefined; }

function getFfmpegPath() {
  if (_ffmpegPath !== undefined) return _ffmpegPath;
  _ffmpegTried = [];
  for (const c of ffmpegCandidates()) {
    if (!ffmpegUsable(c)) { _ffmpegTried.push('缺失 ' + c); continue; }
    try {
      const r = spawnSync(c, ['-version'], { windowsHide: true, timeout: 8000 });
      if (r && r.status === 0) { _ffmpegPath = c; return c; }
      _ffmpegTried.push('不可执行 ' + c);
    } catch (e) {
      _ffmpegTried.push('启动失败 ' + c + ': ' + ((e && e.message) || e));
    }
  }
  _ffmpegPath = null;
  return null;
}

function ffmpegMissingMessage() {
  return '未找到可用的 ffmpeg。抽查过的位置:\n' + (_ffmpegTried.slice(0, 6).join('\n') || '(无候选)') +
    '\n处理办法:把 ffmpeg.exe 放到程序目录(或 data\\ffmpeg\\),或执行 winget install Gyan.FFmpeg 装到系统 PATH 后重开本程序。';
}

function muxVideo(videoPath, audioPath, outPath) {
  const ff = getFfmpegPath();
  if (!ff) return Promise.resolve({ ok: false, message: ffmpegMissingMessage() });
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
    p.on('error', (e) => { ffmpegReset(); resolve({ ok: false, message: 'ffmpeg 启动失败(' + String(ff || '') + '):' + e.message }); });
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
  if (!ff) return Promise.resolve({ ok: false, message: ffmpegMissingMessage() });
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
    p.on('error', (e) => { ffmpegReset(); resolve({ ok: false, message: 'ffmpeg 启动失败(' + String(ff || '') + '):' + e.message }); });
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
const dyImages = require('./douyin-images');
const dyShare = require('./douyin-fetch');
const alipay = require('./alipay-fetch');
const wechatArticle = require('./wechat-article');
const telegram = require('./telegram-fetch');
const tgLocal = require('./telegram-local');
const tgSession = require('./telegram-session');
const tgMtp = require('./telegram-mtproto');

let dyCapWin = null;
let dyCapUrls = [];
let dyCapImages = [];
let dyCapTitle = '';

const dySleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 打包后 app.getAppPath() 指向 asar 内部,不可写 —— 原来的写法会让日志
   静默丢光(出问题时一点线索都没有)。改为先试项目目录,再退到 userData。 */
let _dyLogTarget = null;
function dyLogFile() {
  if (_dyLogTarget !== null) return _dyLogTarget;
  const cands = [
    path.join(app.getAppPath(), 'dyvideo-run.log'),
    path.join(app.getPath('userData'), 'dyvideo-run.log'),
  ];
  for (const f of cands) {
    try {
      if (/[\\/]app\.asar/i.test(f)) continue;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, '');
      _dyLogTarget = f;
      return f;
    } catch (e) { /* 换下一个 */ }
  }
  _dyLogTarget = '';
  return '';
}

function dyVideoLog(m) {
  try {
    const f = dyLogFile();
    if (!f) return;
    fs.appendFileSync(f, '[' + new Date().toISOString() + '] ' + m + '\n', 'utf8');
  } catch (e) {
    /* ignore */
  }
}

function extractDouyinId(text) {
  const r = extractDouyinRef(text);
  return r ? r.id : null;
}

/* kind: 'video' | 'note' | ''(未知,交给抓取阶段两种都试) */
function extractDouyinRef(text) {
  const t = String(text || '');
  let m = t.match(/\/(video|note|slides)\/(\d{15,})/i);
  if (m) return { id: m[2], kind: m[1].toLowerCase() === 'video' ? 'video' : 'note' };
  m = t.match(/modal_id=(\d{15,})/);
  if (m) {
    /* 搜索页/推荐页用 ?modal_id= 打开作品(例如
       /jingxuan/search/图文?...&modal_id=7383337854040051007&type=general)。
       这种链接里常带「图文」二字,见到就一定按图集处理,否则会去开视频页。 */
    const noteHint = /图文|%E5%9B%BE%E6%96%87|type=note/i.test(t);
    return { id: m[1], kind: noteHint ? 'note' : '' };
  }
  m = t.match(/(\d{16,})/);
  if (m) return { id: m[1], kind: '' };
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
  var ref = extractDouyinRef(t);
  if (ref) return { ok: true, id: ref.id, kind: ref.kind };
  const m = t.match(/https?:\/\/v\.douyin\.com\/[0-9A-Za-z\-_]+/i);
  if (!m) return { ok: false, message: '未识别到抖音链接或视频 ID' };
  const res = await fetch(m[0], {
    method: 'GET',
    redirect: 'follow',
    headers: { 'User-Agent': DY_MOBILE_UA },
    signal: AbortSignal.timeout(20000),
  }).catch(function () { return null; });
  if (!res) return { ok: false, message: '短链解析失败(网络错误)' };
  const finalUrl = String(res.url || '');
  ref = extractDouyinRef(finalUrl);
  if (!ref) {
    // 短链跳到的页面里可能只有 ID(例如 /share/slides/xxx、?modal_id=)
    const html = await res.text().catch(function () { return ''; });
    ref = extractDouyinRef(html);
  }
  if (!ref) return { ok: false, message: '短链未指向作品(' + finalUrl.slice(0, 80) + ')' };
  var kind = ref.kind;
  // 跳转地址本身最可信:带 /note/ 或 /slides/ 就是图文
  if (/\/(note|slides)\//i.test(finalUrl)) kind = 'note';
  else if (/\/video\//i.test(finalUrl)) kind = 'video';
  return { ok: true, id: ref.id, kind: kind };
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

/* 抓取实现独立成函数,--dy-probe 可以直接调它做真机自检 */
async function dyFetchWork(id, kind) {
  id = String(id || '').trim();
  if (!/^\d{15,}$/.test(id)) return { ok: false, message: 'ID 无效' };
  kind = kind === 'note' ? 'note' : (kind === 'video' ? 'video' : '');
  // 明确是视频才开视频页;其余(含未知)先开图文页 —— 图集只有图文页才有数据
  var pageKind = kind === 'video' ? 'video' : 'note';
  const dyPageUrl = (k) => 'https://www.douyin.com/' + (k === 'video' ? 'video' : 'note') + '/' + id;
  /* 分享页与窗口【并行】跑,谁先成功用谁:
       · 分享页是一个纯 HTTPS 的 GET,不建窗口 → 万一哪天抖音恢复 SSR 就是最快路径
       · 现在的分享页是前端渲染的空壳(_ROUTER_DATA 里只有 ua/webId,没有作品),
         所以绝大多数情况仍是窗口内捕获,这里只当"顺手一试",不加任何等待
     之前是可跳过的串行 await,会平白多等 1~2 秒,故改为并行。 */
  let share = null;
  const shareP = dyShare.fetchShare(id, kind)
    .then(function (r) {
      share = r;
      dyVideoLog('[分享页] ' + JSON.stringify({
        ok: r.ok,
        code: r.code || '',
        kind: r.kind || '',
        images: (r.images || []).length,
        videos: (r.videoUrls || []).length,
        awemes: r.awemes,
        finalUrl: r.finalUrl || '',
        httpStatus: r.httpStatus || '',
        htmlTitle: r.htmlTitle || '',
        tries: r.tries || [],
      }));
      return r;
    })
    .catch(function (e) {
      dyVideoLog('[分享页] 异常:' + ((e && e.message) || e));
      return null;
    });
  dyVideoLog('捕获:打开页面 ' + dyPageUrl(kind) + ' (kind=' + (kind || '未知') + ')');
  dyCapUrls = [];
  dyCapImages = [];
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
  // window.open 一律拒绝:新窗口没有下面那套闸,会被系统当外部协议接管
  dyCapWin.webContents.setWindowOpenHandler(function () {
    dyVideoLog('[拦截] 页面尝试 window.open,已拒绝');
    return { action: 'deny' };
  });
  const dyAllowUrl = function (url) {
    return /^https?:\/\/([^/]*\.)?(douyin|iesdouyin|douyinvod|douyinpic|zjcdn|snssdk)\.(com|net)\//i.test(String(url || ''));
  };
  dyCapWin.webContents.on('will-navigate', function (e, url) {
    // 阻止 bitbrowser:// 等外部协议触发系统弹窗
    if (!dyAllowUrl(url)) {
      e.preventDefault();
      dyVideoLog('[拦截] 主框架跳转被拒:' + String(url || '').slice(0, 200));
    }
  });
  // 302 / 307 不触发 will-navigate,只有 will-redirect 拦得住
  dyCapWin.webContents.on('will-redirect', function (e, url) {
    if (!dyAllowUrl(url)) {
      e.preventDefault();
      dyVideoLog('[拦截] 重定向被拒:' + String(url || '').slice(0, 200));
    }
  });
  dyCapWin.on('closed', function () { dyCapWin = null; });

  /* 通过调试接口拿页面自身发出的接口响应:视频取 play_addr,图集取 images。

     这里有两个必须踩对的点(都是真机实测出来的,别再改回去):

     1) 不能用 Network.getResponseBody —— 对页面自己发的这些请求,它稳定报
        "No resource with given identifier found"(响应体已被释放)。
        改用 Fetch 域在 Response 阶段暂停再 Fetch.getResponseBody,能拿到完整
        JSON(实测 aweme/post 单次 630KB)。
     2) 图文页【不会】请求 aweme/detail,数据其实在 aweme/post(作者作品列表)
        或 aweme/related 里。所以三个端点都要拦,并且必须按 aweme_id 精确挑目标,
        否则会把「相关推荐」里别人的作品当成你要的那条。 */
  var dbg = dyCapWin.webContents.debugger;
  var dyAwemeBodies = 0;
  var dyFetchPaused = 0;

  /* 从响应里挑出「就是这一条」的作品;挑不到宁可返回 null。
     作者作品列表(aweme/post)动辄几十条,必须按 id 全量扫,
     不能用「取前 N 个再找」—— 顺序是栈式遍历,目标常在后面。 */
  function dyPickAweme(j, fromUrl) {
    var hit = dyShare.findAwemeById(j, id);
    if (hit) return hit;
    var found = dyShare.findAwemes(j, 8);
    if (!found.length) return null;
    // 详情接口里只会有一个作品,允许直接采用
    if (/aweme\/detail/.test(fromUrl) && found.length === 1) return found[0];
    return null;
  }

  function dyHandleAwemeJson(txt, fromUrl) {
    var j = null;
    try { j = JSON.parse(txt); } catch (e) { return; } // 非 JSON 直接忽略
    var aweme = dyPickAweme(j, fromUrl);
    if (!aweme) return;

    dyAwemeBodies += 1;
    if (!dyCapTitle && aweme.desc) dyCapTitle = String(aweme.desc).slice(0, 120);

    // ---- 图集:一批图片地址在同一个响应里,一次拿全 ----
    var imgs = dyImages.fromAweme(aweme);
    if (imgs.length && imgs.length >= dyCapImages.length) {
      dyCapImages = imgs;
      dyVideoLog('从接口捕获图集 ' + imgs.length + ' 张(来源 ' + fromUrl.slice(0, 80) + ')');
    }

    // ---- 视频:取最高码率的 play_addr ----
    // 图文作品的 video 字段是空壳(有时塞的是配乐地址),别当视频交出去
    if (imgs.length) return;
    var v = aweme.video;
    if (!v || dyCapUrls.length >= 3) return;
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
    if (!url) return;
    var vk = classifyDouyinUrl(url);
    if (dyCapUrls.some(function (x) { return x.url.split('?')[0] === url.split('?')[0]; })) return;
    dyCapUrls.push({ url: url, kind: vk, br: brOf(url) });
    dyVideoLog('从接口捕获直链(' + dyCapUrls.length + ',' + vk + '):' + url.slice(0, 300));
  }

  /* 最后一道兜底:直接从渲染好的页面里挑大图。
     接口彻底没结果时用,多半是展示图(可能带水印),聊胜于无。 */
  async function dyDomImages() {
    try {
      return await dyCapWin.webContents.executeJavaScript(String.raw`(function () {
        var out = [], seen = {};
        var imgs = document.querySelectorAll('img');
        for (var i = 0; i < imgs.length; i += 1) {
          var s = imgs[i].currentSrc || imgs[i].src || '';
          if (!/douyinpic\.com/.test(s)) continue;
          if (/avatar/i.test(s)) continue;
          if ((imgs[i].naturalWidth || 0) < 480) continue;
          var k = s.split('?')[0];
          if (seen[k]) continue;
          seen[k] = 1;
          out.push(s);
        }
        return out;
      })()`);
    } catch (e) {
      dyVideoLog('DOM 兜底执行失败:' + ((e && e.message) || e));
      return [];
    }
  }

  dbg.on('message', function (_ev, method, params) {
    if (method !== 'Fetch.requestPaused') return;
    var rid = params.requestId;
    var url = String((params.request && params.request.url) || '');
    dyFetchPaused += 1;
    (async function () {
      try {
        var body = await dbg.sendCommand('Fetch.getResponseBody', { requestId: rid });
        var txt = body && body.body ? String(body.body) : '';
        if (body && body.base64Encoded && txt) {
          try { txt = Buffer.from(txt, 'base64').toString('utf8'); } catch (e) { txt = ''; }
        }
        if (txt) dyVideoLog('[拦截] ' + txt.length + 'B ' + url.slice(0, 90));
        if (txt) dyHandleAwemeJson(txt, url);
      } catch (e) {
        dyVideoLog('[拦截] 取响应体失败 ' + url.slice(0, 80) + ' | ' + ((e && e.message) || e));
      }
      // 无论成败都必须让请求继续,否则页面卡死在等响应
      try {
        await dbg.sendCommand('Fetch.continueRequest', { requestId: rid });
      } catch (e1) {
        try { await dbg.sendCommand('Fetch.continueResponse', { requestId: rid }); } catch (e2) { /* ignore */ }
      }
    })();
  });

  try {
    dbg.attach('1.3'); // 同步方法,不返回 Promise(此前误用 .then 导致白屏)
    // 必须在 loadURL 之前就开好,否则页面最早的几个请求会漏掉
    await dbg.sendCommand('Fetch.enable', {
      patterns: [
        { urlPattern: '*aweme/v1/web/aweme/detail*', requestStage: 'Response' },
        { urlPattern: '*aweme/v1/web/aweme/post*', requestStage: 'Response' },
        { urlPattern: '*aweme/v1/web/aweme/related*', requestStage: 'Response' },
      ],
    });
    dyVideoLog('Fetch.enable 成功');
  } catch (e) {
    dyVideoLog('调试接口附加/开启拦截失败:' + ((e && e.message) || e));
  }

  var domTried = false;


  dyVideoLog('打开页面 ' + dyPageUrl(pageKind));
  dyCapWin.loadURL(dyPageUrl(pageKind)).catch(function () {});

  const start = Date.now();
  var autoplayTried = 0;
  var altTried = false; // 视频页/图集页猜错时,换另一种页面再试一次
  while (!dyCapUrls.length && !dyCapImages.length && !(share && share.ok) && Date.now() - start < 180000) {
    // 与分享页赛跑:它先回来就不用干等这 1.5 秒
    await Promise.race([dySleep(1500), shareP]);
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
    const waited = Date.now() - start;
    // 接口彻底没结果时,再从渲染好的页面里捞大图(图集专用兜底)
    if (!domTried && !dyCapImages.length && waited > 12000) {
      domTried = true;
      const doms = await dyDomImages();
      if (doms.length) {
        dyCapImages = doms.map(function (u) { return [u]; });
        dyVideoLog('DOM 兜底抓到 ' + doms.length + ' 张图(可能是展示图/带水印)');
      } else {
        dyVideoLog('DOM 兜底没找到大图');
      }
    }
    // DOM 兜底已经捞到图了,就别再去开另一种页面
    if (!altTried && !dyCapImages.length && !dyCapUrls.length && waited > 12000) {
      altTried = true;
      pageKind = pageKind === 'note' ? 'video' : 'note';
      dyVideoLog('12 秒未捕获到内容,改试 ' + dyPageUrl(pageKind));
      dyCapWin.loadURL(dyPageUrl(pageKind)).catch(function () {});
    }
    dyCapSend(dyCapUrls.length || dyCapImages.length
      ? '已获取,关闭窗口…'
      : '等待视频/图集加载…(' + Math.round(waited / 1000) + '/180 秒;如弹登录请扫码,未自动播放请点一下)');
  }

  /* 窗口没抓到,但分享页拿到了 —— 直接把结果折算成同一套变量,
     交给下面的公共收尾逻辑(它负责关窗口、摘掉 webRequest 监听) */
  if (share && share.ok && !dyCapImages.length && !dyCapUrls.length) {
    dyVideoLog('分享页先返回,采用分享页结果');
    dyCapImages = share.images || [];
    dyCapUrls = (share.videoUrls || []).map(function (u) {
      return { url: u, kind: classifyDouyinUrl(u), br: brOf(u) };
    });
    if (!dyCapTitle) dyCapTitle = share.title || '';
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
  var result;
  if (dyCapImages.length) {
    result = { ok: true, kind: 'images', images: dyCapImages, title: dyCapTitle || ('抖音图集 ' + id) };
    dyVideoLog('捕获完成:图集 ' + dyCapImages.length + ' 张,标题=' + result.title);
  } else if (videoUrls.length) {
    result = { ok: true, kind: 'video', videoUrls: videoUrls, audioUrls: audioUrls, title: dyCapTitle || ('抖音视频 ' + id) };
    dyVideoLog('捕获完成:完整直链 ' + fullUrls.length + ' 条,纯视频 ' + videoOnly.length + ' 条,纯音频 ' + audioOnly.length + ' 条,标题=' + result.title);
  } else {
    result = { ok: false, message: '获取内容超时(180 秒)。请在窗口内登录后重试,或该作品不可公开访问' };
    dyVideoLog('捕获失败:' + result.message);
  }
  if (dyCapWin && !dyCapWin.isDestroyed()) {
    try { dyCapWin.destroy(); } catch (e) { /* ignore */ }
  }
  dyCapWin = null;
  try { ses.webRequest.onBeforeRequest(filter, null); } catch (e) { /* ignore */ }
  return result;
}

ipcMain.handle('dyvideo:fetch', function (_e, id, kind) {
  return dyFetchWork(id, kind);
});

ipcMain.handle('dyvideo:download', async (_e, { key, videoUrls, audioUrls, dest, title }) => {
  var tmpV = null;
  var tmpA = null;
  try {
    if (!dest) {
      const dir = app.getPath('downloads');
      const base = dyImages.safeName('抖音_' + (title || 'video'));
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
  // aweme/v1/play 这类播放接口只认移动端 UA,桌面 UA 会 403
  const isPlayApi = /aweme\/v1\/play/.test(String((videoUrls && videoUrls[0]) || ''));
  const headers = {
    'User-Agent': isPlayApi ? DY_MOBILE_UA : UA,
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

/* ---------- 抖音图集下载 ---------- */
ipcMain.handle('dyvideo:pick-dir', async (_e, title) => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: String(title || '选择保存位置'),
    buttonLabel: '保存到此',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dyvideo:download-images', async (_e, args) => {
  const a = args || {};
  const images = Array.isArray(a.images) ? a.images : [];
  if (!images.length) return { ok: false, message: '没有可下载的图片' };
  try {
    // 用户选的是「父目录」,在其中新建以标题命名的子目录,重名自动加序号
    const parent = String(a.destDir || '').trim() || app.getPath('pictures');
    const name = dyImages.safeName(a.title || '抖音图集');
    let outDir = path.join(parent, name);
    let n = 2;
    while (fs.existsSync(outDir)) {
      outDir = path.join(parent, name + ' (' + n + ')');
      n += 1;
      if (n > 500) break;
    }
    dyVideoLog('图集下载开始:共 ' + images.length + ' 张 -> ' + outDir);
    const r = await dyImages.downloadAll({
      images: images,
      outDir: outDir,
      ua: UA,
      onProgress: function (p) {
        sendToMain('dl:progress', { key: 'dyimg', received: p.index, total: p.total });
        dyVideoLog('图集进度 ' + p.index + '/' + p.total + (p.ok ? '' : ' (该张失败)'));
      },
    });
    dyVideoLog('图集下载结束:成功 ' + r.saved + ' 张,失败 ' + r.failed + ' 张');
    return {
      ok: r.ok,
      dir: outDir,
      saved: r.saved,
      failed: r.failed,
      message: r.ok ? r.message : (r.message || '全部下载失败'),
    };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    dyVideoLog('图集下载异常:' + msg);
    return { ok: false, message: msg };
  }
});

/* ============================================================
 * 支付宝(生活号 / 视频号)内容:解析与下载
 *
 * 链路在 alipay-fetch.js 里(纯 HTTPS,不建窗口、不碰系统代理):
 *   短链 302 → contentId → SOFA 网关接口 → gw.alipayobjects CDN 直链
 * main.js 只做 IPC 与落盘。
 * ============================================================ */

ipcMain.handle('alipay:fetch', async (_e, text) => {
  const r = await alipay.fetchWork(text).catch((e) => ({ ok: false, code: 'exception', message: (e && e.message) || String(e) }));
  dyVideoLog('[支付宝] ' + JSON.stringify({
    ok: r.ok, code: r.code || '', contentId: r.contentId || '',
    title: r.title || '', qualities: (r.qualities || []).length,
    videoUrls: (r.videoUrls || []).length, tries: r.tries || [],
  }));
  if (r.ok) r.platform = 'alipay';
  return r;
});

/* 抽成独立函数:界面的 IPC 与 --ap-probe 自检走的是同一条路,
   免得"探针能下、界面下不了"这种假象。 */
async function alipayDownload(args) {
  const a = args || {};
  const urls = (Array.isArray(a.videoUrls) ? a.videoUrls : []).filter(function (u) { return /^https?:\/\//i.test(String(u || '')); });
  if (!urls.length) return { ok: false, message: '没有可用的视频地址' };
  let dest = String(a.dest || '').trim();
  let tmp = '';
  try {
    if (!dest) {
      const dir = app.getPath('downloads');
      const base = dyImages.safeName('支付宝_' + (a.title || 'video'));
      dest = path.join(dir, base + '.mp4');
      var n = 1;
      while (fs.existsSync(dest)) {
        dest = path.join(dir, base + ' (' + n + ').mp4');
        n += 1;
      }
    }
    tmp = dest + '.part';
    dyVideoLog('[支付宝] 开始下载 ' + urls[0].slice(0, 160) + ' -> ' + dest);
    // 支付宝 CDN 不校验 Referer/UA,这里带上是防止哪天收紧;Range 断点续传可用
    const rv = await downloadStream(urls, tmp, 'apv', {
      'User-Agent': UA,
      Referer: 'https://render.alipay.com/',
      Range: 'bytes=0-',
    });
    if (!rv.ok) throw new Error('视频流下载失败:' + rv.message);
    try {
      await fsp.rename(tmp, dest);
    } catch (e) {
      await fsp.copyFile(tmp, dest);
      await fsp.rm(tmp, { force: true });
    }
    tmp = '';
    dyVideoLog('[支付宝] 下载完成 ' + dest);
    return { ok: true, dest: dest };
  } catch (e) {
    if (tmp) { try { await fsp.rm(tmp, { force: true }); } catch (_) { /* ignore */ } }
    const msg = (e && e.message) || String(e);
    dyVideoLog('[支付宝] 下载失败:' + msg);
    return { ok: false, message: msg };
  }
}

ipcMain.handle('alipay:download', (_e, args) => alipayDownload(args));

/* ============================================================
 * 微信公众号图文 / 图片消息:无水印图集
 *
 * 链路在 wechat-article.js(纯 HTTPS,不建窗口):
 *   mp.weixin.qq.com/s/... → 页面内联数据 → original_info 原图直链
 * 图片消息的水印是客户端叠的图层,cdn_url / original_info 都是干净图。
 * main.js 只做 IPC 与落盘(复用抖音图集的下载器)。
 * ============================================================ */

ipcMain.handle('wechat:fetch', async (_e, text) => {
  const r = await wechatArticle.fetchArticle(text).catch((e) => ({
    ok: false,
    code: 'exception',
    message: (e && e.message) || String(e),
  }));
  dyVideoLog('[公众号] ' + JSON.stringify({
    ok: r.ok,
    code: r.code || '',
    kind: r.kind || '',
    title: r.title || '',
    count: r.count || 0,
    modes: (r.modes || []).map((m) => m.key + ':' + m.images.length),
    tries: r.tries || [],
  }));
  return r;
});

async function wechatDownloadImages(args) {
  const a = args || {};
  const images = (Array.isArray(a.images) ? a.images : [])
    .map((x) => (Array.isArray(x) ? x : [x]))
    .map((x) => x.filter((u) => /^https?:\/\//i.test(String(u || ''))))
    .filter((x) => x.length);
  if (!images.length) return { ok: false, message: '没有可下载的图片' };
  try {
    const parent = String(a.destDir || '').trim() || app.getPath('pictures');
    const name = dyImages.safeName(a.title || '公众号图集');
    let outDir = path.join(parent, name);
    let n = 2;
    while (fs.existsSync(outDir)) {
      outDir = path.join(parent, name + ' (' + n + ')');
      n += 1;
      if (n > 500) break;
    }
    dyVideoLog('[公众号] 图集下载开始:共 ' + images.length + ' 张 -> ' + outDir);
    const r = await dyImages.downloadAll({
      images: images,
      names: Array.isArray(a.names) ? a.names : [],
      outDir: outDir,
      ua: UA,
      referer: 'https://mp.weixin.qq.com/',
      timeout: 120000, // 原图单张可达 40MB+,30 秒不够
      onProgress: function (p) {
        sendToMain('dl:progress', { key: 'wximg', received: p.index, total: p.total });
      },
    });
    dyVideoLog('[公众号] 图集下载结束:成功 ' + r.saved + ' 张,失败 ' + r.failed + ' 张');
    return { ok: r.ok, dir: outDir, saved: r.saved, failed: r.failed, message: r.message || '' };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    dyVideoLog('[公众号] 图集下载异常:' + msg);
    return { ok: false, message: msg };
  }
}

ipcMain.handle('wechat:download-images', (_e, args) => wechatDownloadImages(args));

/* ============================================================
 * Telegram 公开频道帖:解析与下载
 *
 * 链路在 telegram-fetch.js(自带 CONNECT 代理 + HTTP/1.1 客户端):
 *   t.me/<频道>/<帖号> → ?embed=1 widget 页 → cdnN.telesco.pe/xxx.mp4
 * 为什么不能复用 downloadStream:主进程的全局 fetch 是 undici,不读系统代理,
 * 而 t.me / telesco.pe 在国内必须过代理,所以下载也走模块里的 downloadTo。
 * ============================================================ */

ipcMain.handle('telegram:fetch', async (_e, text) => {
  const r = await telegram.fetchPost(text).catch((e) => ({ ok: false, code: 'exception', message: (e && e.message) || String(e) }));
  dyVideoLog('[Telegram] ' + JSON.stringify({
    ok: r.ok, code: r.code || '', kind: r.kind || '', post: (r.channel || '') + '/' + (r.postId || ''),
    title: r.title || '', size: (r.qualities && r.qualities[0] && r.qualities[0].size) || 0,
    tries: r.tries || [],
  }));
  return r;
});

/* 抽成独立函数:界面 IPC 与 --tg-probe 自检共用同一条路径 */
async function telegramDownload(args) {
  const a = args || {};
  const urls = (Array.isArray(a.videoUrls) ? a.videoUrls : []).filter(function (u) { return /^https?:\/\//i.test(String(u || '')); });
  if (!urls.length) return { ok: false, message: '没有可用的视频地址' };
  let dest = String(a.dest || '').trim();
  let tmp = '';
  try {
    if (!dest) {
      const dir = app.getPath('downloads');
      const base = dyImages.safeName('Telegram_' + (a.title || 'video'));
      dest = path.join(dir, base + '.mp4');
      var n = 1;
      while (fs.existsSync(dest)) {
        dest = path.join(dir, base + ' (' + n + ').mp4');
        n += 1;
      }
    }
    tmp = dest + '.part';
    dyVideoLog('[Telegram] 开始下载 ' + urls[0].slice(0, 120) + ' -> ' + dest);
    const rv = await telegram.downloadTo(urls[0], tmp, {
      timeout: 60000,
      onProgress: function (p) {
        sendToMain('dl:progress', { key: 'tgv', received: p.received, total: p.total });
      },
    });
    if (!rv.ok) throw new Error(rv.message || '下载失败');
    try {
      await fsp.rename(tmp, dest);
    } catch (e) {
      await fsp.copyFile(tmp, dest);
      await fsp.rm(tmp, { force: true });
    }
    tmp = '';
    dyVideoLog('[Telegram] 下载完成 ' + dest + ' (' + Math.round(rv.bytes / 1024) + ' KB)');
    return { ok: true, dest: dest, bytes: rv.bytes };
  } catch (e) {
    if (tmp) { try { await fsp.rm(tmp, { force: true }); } catch (_) { /* ignore */ } }
    const msg = (e && e.message) || String(e);
    dyVideoLog('[Telegram] 下载失败:' + msg);
    return { ok: false, message: msg };
  }
}

ipcMain.handle('telegram:download', (_e, args) => telegramDownload(args));

/* 单图帖:走同一条代理通道存成 jpg(抖音那套 downloadAll 用 fetch,这里过不去代理) */
ipcMain.handle('telegram:save-photo', async (_e, args) => {
  const a = args || {};
  const url = String(a.url || '');
  if (!/^https?:\/\//i.test(url)) return { ok: false, message: '没有可用的图片地址' };
  let dest = String(a.dest || '').trim();
  try {
    if (!dest) {
      const dir = app.getPath('pictures');
      const base = dyImages.safeName('Telegram_' + (a.title || 'photo'));
      dest = path.join(dir, base + '.jpg');
      var i = 1;
      while (fs.existsSync(dest)) {
        dest = path.join(dir, base + ' (' + i + ').jpg');
        i += 1;
      }
    }
    const rv = await telegram.downloadTo(url, dest, { timeout: 60000 });
    if (!rv.ok) throw new Error(rv.message || '下载失败');
    dyVideoLog('[Telegram] 图片已保存 ' + dest);
    return { ok: true, dest: dest, bytes: rv.bytes };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    dyVideoLog('[Telegram] 图片保存失败:' + msg);
    return { ok: false, message: msg };
  }
});

/* ============================================================
 * Telegram MTProto（用本机 tdata 已登录的授权直接连 Telegram 服务器）
 * 公开网页解析走不通时（预览关闭/私密频道），这条路可以拿到完整媒体。
 * 渲染层只传链接与媒体元数据，不接触授权文件本身。
 * ============================================================ */
const tgMt = require('./telegram-dl');

ipcMain.handle('telegram:mtfetch', async (_e, args) => {
  const a = args || {};
  try {
    const r = await tgMt.fetchPost({ link: String(a.link || '') });
    return { ok: true, channel: r.channel, items: r.items };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    dyVideoLog('[TG-MT] 解析失败:' + msg);
    return { ok: false, message: msg };
  }
});

ipcMain.handle('telegram:mtdownload', async (_e, args) => {
  const a = args || {};
  const media = a.media;
  if (!media) return { ok: false, message: '缺媒体信息' };
  let dest = String(a.dest || '').trim();
  let tmp = '';
  try {
    if (!dest) {
      const dir = app.getPath('downloads');
      const base = dyImages.safeName((a.title || 'Telegram') + '_' + (media.filename || ('media_' + media.msgId)));
      const ext = media.kind === 'photo' ? '.jpg'
        : (/\.(\w{2,5})$/.exec(String(media.filename || '')) || [])[1]
          || (/video\/mp4|image\/jpeg|webm/.test(String(media.mime)) ? '' : '');
      const guess = media.kind === 'photo' ? '.jpg'
        : (/mp4/.test(String(media.mime)) ? '.mp4' : /webm/.test(String(media.mime)) ? '.webm'
          : (/^(\.\w{2,5})$/.test(ext || '') ? ext : '.bin'));
      dest = path.join(dir, base + guess);
      var n = 1;
      while (fs.existsSync(dest)) {
        dest = path.join(dir, base + ' (' + n + ')' + guess);
        n += 1;
      }
    }
    tmp = dest + '.part';
    dyVideoLog('[TG-MT] 开始下载 dc' + media.dcId + ' ' + (media.filename || media.msgId) + ' -> ' + dest);
    const r = await tgMt.downloadMedia({
      media: media,
      proxy: undefined,
      dest: tmp,
      onProgress: (p) => sendToMain('dl:progress', { key: 'tgv', received: p.received, total: p.total || media.size }),
    });
    await fsp.rename(tmp, dest);
    tmp = '';
    dyVideoLog('[TG-MT] 下载完成 ' + dest + ' (' + Math.round(r.bytes / 1024) + ' KB)');
    return { ok: true, dest: dest, bytes: r.bytes };
  } catch (e) {
    if (tmp) { try { await fsp.rm(tmp, { force: true }); } catch (_) { /* ignore */ } }
    const msg = (e && e.message) || String(e);
    dyVideoLog('[TG-MT] 下载失败:' + msg);
    return { ok: false, message: msg };
  }
});

/* ============================================================
 * Telegram 本地缓存恢复（离线）
 *
 * 和上面「网络解析」是两条完全独立的路：那条受限于频道有没有开网页预览，
 * 这条直接解本机 Telegram Desktop 落盘的加密缓存 —— 只要在本机看过就有。
 *
 * 渲染层只拿到 id（= 内容 md5），缩略图/导出都按 id 回主进程取，
 * 主进程用自己那次扫描的结果去对文件路径。这样界面就没有"任意读本机文件"
 * 的口子。
 * ============================================================ */
let tglState = null;                 // 最近一次扫描 { at, tdata, key, byId:Map, items }
const tglThumbs = new Map();         // id -> dataUrl | null（null = 这类解不出缩略图）

function tglLog(msg) {
  try { dyVideoLog('[TG本地] ' + msg); } catch (e) { /* ignore */ }
}

ipcMain.handle('tglocal:probe', async (_e, opts) => {
  const tdata = String((opts && opts.tdata) || '').trim();
  try {
    const r = tgLocal.probe(tdata ? { tdata: tdata } : {});
    tglLog('概览 tdata=' + r.tdata + ' key=' + r.keyOk + ' 文件=' + r.fileCount + ' 体积=' + (r.bytes / 1048576).toFixed(1) + 'MB');
    return r;
  } catch (e) {
    return { ok: false, code: 'exception', message: (e && e.message) || String(e) };
  }
});

ipcMain.handle('tglocal:scan', async (_e, opts) => {
  const tdata = String((opts && opts.tdata) || '').trim();
  let lastPush = 0;
  const r = await tgLocal.scan({
    tdata: tdata || undefined,
    onProgress: function (p) {
      const now = Date.now();
      if (now - lastPush < 120 && p.done < p.total) return; // 别把 IPC 灌满
      lastPush = now;
      sendToMain('tglocal:progress', { phase: 'scan', done: p.done, total: p.total });
    },
  }).catch((e) => ({ ok: false, code: 'exception', message: (e && e.message) || String(e) }));

  if (!r.ok) {
    tglLog('扫描失败 ' + r.code + ' ' + r.message);
    return r;
  }
  const keyRes = tgLocal.localKey(r.tdata);
  const byId = new Map();
  for (const it of r.items) byId.set(it.id, it);
  tglState = { at: Date.now(), tdata: r.tdata, key: keyRes.ok ? keyRes.key : null, byId: byId };
  tglThumbs.clear();
  tglLog('扫描完成 ' + r.items.length + ' 条 / 文件 ' + r.fileCount + ' / 未识别 ' + r.unknown + ' / 重复 ' + r.dupes +
    ' / 耗时 ' + r.ms + 'ms');

  // file 路径不出主进程：界面用 id 说话
  return Object.assign({}, r, { items: r.items.map(function (i) { return { id: i.id, source: i.source, ext: i.ext, kind: i.kind, size: i.size, playable: i.playable, complete: i.complete, mtime: i.mtime }; }) });
});

/* 缩略图：图片走 nativeImage 缩放，视频抽首帧（ffmpeg），其余给 null 让界面画类型标 */
async function tglThumb(id) {
  const it = tglState && tglState.byId.get(String(id || ''));
  if (!it || !tglState.key) return { ok: false, message: '没有这个条目，请重新扫描' };
  if (tglThumbs.has(it.id)) return { ok: true, dataUrl: tglThumbs.get(it.id) };
  const r = await tgLocal.openCacheFileAsync(it.file, tglState.key);
  if (!r.ok) return { ok: false, message: '解不开这个缓存文件' };
  const info = tgLocal.detect(r.data);
  if (!info) return { ok: false, message: '内容识别失败' };
  const payload = r.data.subarray(info.start);
  let dataUrl = null;

  if (it.kind === 'image') {
    try {
      const img = nativeImage.createFromBuffer(payload);
      if (!img.isEmpty()) {
        const sz = img.getSize();
        const small = sz.width > 240 ? img.resize({ width: 240, quality: 'good' }) : img;
        dataUrl = 'data:image/jpeg;base64,' + small.toJPEG(72).toString('base64');
      }
    } catch (e) { dataUrl = null; }
  } else if (it.kind === 'video' && it.playable) {
    // 抽帧要真文件：先落临时盘，用完删掉
    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const tmpIn = path.join(app.getPath('temp'), 'tgl-thumb-' + stamp + '.' + info.ext);
    const tmpOut = path.join(app.getPath('temp'), 'tgl-thumb-' + stamp + '.jpg');
    try {
      await fsp.writeFile(tmpIn, payload);
      const fr = await extractFrame(tmpIn, tmpOut);
      if (fr.ok) dataUrl = 'data:image/jpeg;base64,' + fs.readFileSync(tmpOut).toString('base64');
    } catch (e) { dataUrl = null; } finally {
      try { await fsp.rm(tmpIn, { force: true }); } catch (e) { /* ignore */ }
      try { await fsp.rm(tmpOut, { force: true }); } catch (e) { /* ignore */ }
    }
  }

  tglThumbs.set(it.id, dataUrl);
  return { ok: !!dataUrl, dataUrl: dataUrl };
}

ipcMain.handle('tglocal:thumb', (_e, id) => tglThumb(id).catch((e) => ({ ok: false, message: (e && e.message) || String(e) })));

ipcMain.handle('tglocal:pick-dir', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: '选择导出目录',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '导出到这里',
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, dir: r.filePaths[0] };
});

ipcMain.handle('tglocal:export', async (_e, args) => {
  const a = args || {};
  if (!tglState) return { ok: false, message: '先扫描一次，再导出' };
  const ids = Array.isArray(a.ids) ? a.ids.map(String) : [];
  const items = [];
  const missing = [];
  for (const id of ids) {
    const it = tglState.byId.get(id);
    if (it) items.push(it); else missing.push(id);
  }
  if (!items.length) return { ok: false, message: '没有选中任何条目' };

  let dest = String(a.dest || '').trim();
  if (!dest) {
    dest = path.join(app.getPath('desktop'), 'Telegram本地缓存');
  }
  let lastPush = 0;
  const r = await tgLocal.recover({
    items: items,
    tdata: tglState.tdata,
    dest: dest,
    byKind: a.byKind !== false,
    writeIndex: a.writeIndex !== false,
    skipExisting: a.skipExisting !== false,
    onProgress: function (p) {
      const now = Date.now();
      if (now - lastPush < 100 && p.done < p.total) return;
      lastPush = now;
      sendToMain('tglocal:progress', { phase: 'export', done: p.done, total: p.total, written: p.written });
    },
  }).catch((e) => ({ ok: false, message: (e && e.message) || String(e) }));
  if (r.ok) {
    tglLog('导出 ' + r.count + ' 项（新写 ' + r.written + ' / 已存在 ' + r.skipped + '）→ ' + r.dest);
    r.missing = missing.length;
  } else {
    tglLog('导出失败 ' + (r.message || ''));
  }
  return r;
});

ipcMain.handle('tglocal:open', async (_e, dir) => {
  const d = String(dir || '').trim();
  if (!d) return { ok: false };
  const e = await shell.openPath(d);
  return { ok: !e, message: e || '' };
});

/* 通用短链嗅探:先跟 302 看最终落到哪个平台,再分发。
   为什么需要它:ur.lepudding.com 这类第三方短链,域名本身看不出平台,
   renderer 的 detectPlatform 靠正则猜必然猜不中。 */
async function sniffShare(text) {
  const t = String(text || '').trim();
  const idOnly = alipay.findContentId(t);
  const url = (t.match(/https?:\/\/[^\s"'<>]+/) || [])[0];
  if (!url) {
    if (idOnly) return { ok: true, platform: 'alipay', contentId: idOnly };
    return { ok: false, message: '没找到链接' };
  }
  const f = await alipay.followShortLink(url, {});
  const all = ((f.chain || []).concat([f.finalUrl || ''])).join(' ');
  const hop = (f.chain || []).length;
  dyVideoLog('[嗅探] 跳数=' + hop + ' final=' + String(f.finalUrl || url).slice(0, 160));

  if (f.ok || /alipay\.com|alipays:/i.test(all)) {
    return { ok: true, platform: 'alipay', contentId: f.contentId || idOnly || '', finalUrl: f.finalUrl, hops: hop };
  }
  /* Telegram 短链(t.me 的 t.me/+xxx 之类)也会 302,认一下最终落点 */
  if (/(?:^|[/.\s])(?:t|telegram)\.me\//i.test(all) || /^tg:\/\/resolve/i.test(all)) {
    const lk = telegram.parseLink(f.finalUrl || url) || telegram.parseLink(all);
    return { ok: true, platform: 'telegram', text: f.finalUrl || url, channel: lk ? lk.channel : '', postId: lk ? lk.postId : 0, hops: hop };
  }
  if (/douyin\.com|iesdouyin/i.test(all)) {
    const r = await resolveDouyinId(f.finalUrl || url);
    return Object.assign({ platform: 'douyin', hops: hop }, r);
  }
  if (/bilibili\.com|b23\.tv|bili2233/i.test(all)) {
    return { ok: true, platform: 'bilibili', text: f.finalUrl || url, hops: hop };
  }
  return {
    ok: false,
    message: '短链没指向支持的平台:' + String(f.finalUrl || url).slice(0, 90),
    finalUrl: f.finalUrl || url,
    hops: hop,
  };
}

ipcMain.handle('share:sniff', (_e, text) => sniffShare(text));

/* ============================================================
 * 微信视频号捕获:整条链路在 wxv-collect.js(代理/MITM/分片/解密/封面/缓存)
 * main.js 只做装配与生命周期:启动时自愈残留代理,退出时还原代理并落盘索引。
 * ============================================================ */
const wxv = require('./wxv-collect')({
  app: app,
  ipcMain: ipcMain,
  shell: shell,
  UA: UA,
  sendToMain: sendToMain,
  downloadStream: downloadStream,
  probeMedia: probeMedia,
  extractFrame: extractFrame,
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

/* ---------- 排障自检 ----------
   双击快捷方式没法看控制台,所以「别的机器上跑不起来」时让用户带参数启动:
       B站一键取关助手.exe --wxv-diagnose
   结果同时写进 wx-captures/diagnose.txt 并弹窗显示,直接截图发过来就能定位。 */
function runDiagnose() {
  let text = '';
  try {
    const d = Object.assign({
      time: new Date().toISOString(),
      app: app.getVersion() + (app.isPackaged ? '(打包版)' : '(开发模式)'),
      ffmpeg: getFfmpegPath() || '(未找到)',
      ffmpegTried: _ffmpegTried,
    }, wxv.diagnose());
    text = JSON.stringify(d, null, 2);
    try {
      const p = require('path').join(app.getPath('userData'), 'wx-captures', 'diagnose.txt');
      require('fs').mkdirSync(require('path').dirname(p), { recursive: true });
      require('fs').writeFileSync(p, text, 'utf8');
    } catch (e) { /* 写文件失败也要弹窗 */ }
    wxv.log('[自检] ' + text.replace(/\s+/g, ' ').slice(0, 1500));
    console.log(text);
  } catch (e) {
    text = '自检失败:' + ((e && e.message) || e);
  }
  dialog.showMessageBox({
    type: 'info',
    title: '环境自检',
    message: '自检结果(也会写入 wx-captures\\diagnose.txt)',
    detail: text.replace(/\\/g, '\\').slice(0, 3000),
    buttons: ['好'],
    noLink: true,
  }).finally(() => app.exit(0));
}

app.on('before-quit', () => {
  // 退出前落盘索引 + 还原系统代理,避免残留 127.0.0.1:8899 导致断网
  try { wxv.shutdown(); } catch (e) { /* ignore */ }
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
  app.whenReady().then(() => {
    // 上次崩溃/强杀会留下指向 127.0.0.1:8899 的系统代理,先自愈再开窗
    try { wxv.recoverStaleProxy(); } catch (e) { /* ignore */ }
    if (process.argv.indexOf('--wxv-diagnose') >= 0) { runDiagnose(); return; }
    const dpi = process.argv.indexOf('--dy-probe');
    if (dpi >= 0) { runDyProbe(process.argv[dpi + 1] || ''); return; }
    const apProbeIdx = process.argv.indexOf('--ap-probe');
    if (apProbeIdx >= 0) { runApProbe(process.argv[apProbeIdx + 1] || ''); return; }
    const wxArtProbeIdx = process.argv.indexOf('--wxarticle-probe');
    if (wxArtProbeIdx >= 0) { runWxArticleProbe(process.argv[wxArtProbeIdx + 1] || ''); return; }
    const tgProbeIdx = process.argv.indexOf('--tg-probe');
    if (tgProbeIdx >= 0) { runTgProbe(process.argv[tgProbeIdx + 1] || ''); return; }
    const tglProbeIdx = process.argv.indexOf('--tglocal-probe');
    if (tglProbeIdx >= 0) { runTglocalProbe(process.argv[tglProbeIdx + 1] || ''); return; }
    createMainWindow();
  });
}

/* ---------- 自定义协议总闸 ----------
   系统弹窗「获取打开此 bitbrowser 链接的应用」的成因:Chromium 把非 http(s)
   导航交给 ShellExecute,系统找不到注册该协议的程序就弹框。窗口级的
   will-navigate 只覆盖「主框架 + 页面内发起的跳转」,拦不住这三种情况:
     · window.open('bitbrowser://…')      → 新窗口,另一个 webContents
     · 302/307 跳转                        → 不触发 will-navigate
     · iframe 内部跳转                     → 不触发顶层 will-navigate
   所以在 web-contents-created 上统一上闸,一处覆盖所有窗口和子框架。 */
app.on('web-contents-created', function (_e, wc) {
  const blockNonHttp = function (ev, url) {
    const u = String(url || (ev && ev.url) || '');
    if (!/^https?:\/\//i.test(u)) {
      try { ev.preventDefault(); } catch (e) { /* ignore */ }
      try { dyVideoLog('[拦截] 非 http(s) 跳转:' + u.slice(0, 200)); } catch (e) { /* ignore */ }
    }
  };
  wc.on('will-navigate', blockNonHttp);
  wc.on('will-redirect', blockNonHttp);
  // Electron 25+ 才有;老版本没有就直接跳过
  try { wc.on('will-frame-navigate', blockNonHttp); } catch (e) { /* ignore */ }
});

/* 抖音解析探头:双击启动没法看控制台,让用户带参数跑一次,把结果发回来。
     B站一键取关助手.exe --dy-probe "https://v.douyin.com/xxxx/"
   结果写到 data/dy-probe.json 并弹窗显示。 */
/* 抖音解析探头:双击启动没法看控制台,让用户带参数跑一次,把结果发回来。
     B站一键取关助手.exe --dy-probe "https://v.douyin.com/xxxx/"
   会依次做「链接识别 → 分享页 → 真实捕获(和界面上点识别完全同一条路)」,
   结果写到 data/dy-probe.json 并弹窗显示。 */
async function runDyProbe(link) {
  const out = { time: new Date().toISOString(), link: String(link || '').slice(0, 300), logFile: dyLogFile() };
  const trim = function (cap) {
    return {
      ok: cap && cap.ok,
      kind: cap && cap.kind,
      title: cap && cap.title,
      via: cap && cap.via,
      images: ((cap && cap.images) || []).length,
      firstImage: ((cap && cap.images) || []).slice(0, 1).map(function (u) { return (u || []).slice(0, 2); }),
      videoUrls: ((cap && cap.videoUrls) || []).slice(0, 2),
      message: cap && cap.message,
    };
  };
  try {
    const rr = await resolveDouyinId(link);
    out.resolve = rr;
    if (rr && rr.ok) {
      // 1) 分享页(纯 HTTPS,不建窗口)
      const sh = await dyShare.fetchShare(rr.id, rr.kind || '');
      out.share = {
        ok: sh.ok,
        code: sh.code,
        kind: sh.kind,
        images: (sh.images || []).length,
        videos: (sh.videoUrls || []).length,
        tries: sh.tries,
        finalUrl: sh.finalUrl,
        htmlTitle: sh.htmlTitle,
      };
      // 2) 真实捕获:和用户点「识别」走的是同一个函数
      out.capture = trim(await dyFetchWork(rr.id, rr.kind || ''));
    }
  } catch (e) {
    out.error = String((e && e.stack) || e).slice(0, 800);
  }
  const text = JSON.stringify(out, null, 2);
  let file = '';
  try {
    file = path.join(app.getPath('userData'), 'dy-probe.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  } catch (e) { /* ignore */ }
  dyVideoLog('[探头] ' + text.replace(/\s+/g, ' ').slice(0, 1500));
  const good = !!(out.capture && out.capture.ok);
  dialog.showMessageBox({
    type: 'info',
    title: '抖音解析探头',
    message: good
      ? '解析成功:' + (out.capture.kind === 'images' ? out.capture.images + ' 张图' : out.capture.videoUrls.length + ' 条视频地址')
      : '解析未成功,结果已保存',
    detail: text.slice(0, 1600) + (file ? '\n\n文件:' + file : ''),
    buttons: ['好'],
  });
  app.quit();
}

/* 支付宝解析探头:和 --dy-probe 一个套路,给"双击启动看不到控制台"的场景用。
     B站一键取关助手.exe --ap-probe "https://ur.lepudding.com/xxxx"
   会走「短链 → contentId → 接口 → 清晰度 → 真实下载」全程,结果落盘并弹窗。 */
async function runApProbe(link) {
  const out = { time: new Date().toISOString(), link: String(link || '').slice(0, 300), logFile: dyLogFile() };
  try {
    const r = await alipay.fetchWork(link);
    out.parse = {
      ok: r.ok,
      code: r.code || '',
      message: r.message || '',
      contentId: r.contentId || '',
      title: r.title || '',
      author: r.author || '',
      duration: r.duration || 0,
      qualities: (r.qualities || []).map(function (q) { return { key: q.key, sizeMB: q.sizeMB }; }),
      hops: (r.chain || []).length,
      tries: r.tries || [],
    };
    if (r.ok) out.download = await alipayDownload({ videoUrls: r.videoUrls, title: r.title });
  } catch (e) {
    out.error = String((e && e.stack) || e).slice(0, 800);
  }
  const text = JSON.stringify(out, null, 2);
  let file = '';
  try {
    file = path.join(app.getPath('userData'), 'ap-probe.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  } catch (e) { /* ignore */ }
  dyVideoLog('[支付宝探头] ' + text.replace(/\s+/g, ' ').slice(0, 1500));
  const good = !!(out.parse && out.parse.ok);
  dialog.showMessageBox({
    type: 'info',
    title: '支付宝解析探头',
    message: good
      ? '解析成功:' + (out.parse.qualities || []).length + ' 个清晰度' + (out.download && out.download.ok ? ',已下载' : '')
      : '解析未成功,结果已保存',
    detail: text.slice(0, 1600) + (file ? '\n\n文件:' + file : ''),
    buttons: ['好'],
  });
  app.quit();
}

/* 公众号图文/图片消息探头:只解析不整包下载(原图单张可达 40MB+),
   顺手 HEAD 校验前两张直链。
     B站一键取关助手.exe --wxarticle-probe "https://mp.weixin.qq.com/s/xxxx" */
async function runWxArticleProbe(link) {
  const out = { time: new Date().toISOString(), link: String(link || '').slice(0, 300), logFile: dyLogFile() };
  try {
    const r = await wechatArticle.fetchArticle(link);
    out.parse = {
      ok: r.ok,
      code: r.code || '',
      message: r.message || '',
      kind: r.kind || '',
      title: r.title || '',
      count: r.count || 0,
      modes: (r.modes || []).map(function (m) {
        return {
          key: m.key,
          label: m.label,
          images: (m.images || []).length,
          totalText: m.totalText || '',
          first: ((m.images || [])[0] || {}).url || '',
        };
      }),
      tries: r.tries || [],
    };
    if (r.ok) {
      const first = (((r.modes || [])[0] || {}).images || []).slice(0, 2);
      out.head = await Promise.all(first.map(async function (img) {
        try {
          const res = await fetch(img.url, {
            method: 'HEAD',
            headers: { 'User-Agent': UA, Referer: 'https://mp.weixin.qq.com/' },
            signal: AbortSignal.timeout(15000),
          });
          return { status: res.status, type: res.headers.get('content-type'), length: Number(res.headers.get('content-length') || 0) };
        } catch (e) {
          return { error: (e && e.message) || String(e) };
        }
      }));
    }
  } catch (e) {
    out.error = String((e && e.stack) || e).slice(0, 800);
  }
  const text = JSON.stringify(out, null, 2);
  let file = '';
  try {
    file = path.join(app.getPath('userData'), 'wxarticle-probe.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  } catch (e) { /* ignore */ }
  dyVideoLog('[公众号探头] ' + text.replace(/\s+/g, ' ').slice(0, 1500));
  const good = !!(out.parse && out.parse.ok);
  dialog.showMessageBox({
    type: 'info',
    title: '公众号图集探头',
    message: good
      ? '解析成功:' + out.parse.count + ' 张(' + (out.parse.modes || []).map(function (m) { return m.label + ' ' + m.images; }).join(' / ') + ')'
      : '解析未成功,结果已保存',
    detail: text.slice(0, 1600) + (file ? '\n\n文件:' + file : ''),
    buttons: ['好'],
  });
  app.quit();
}

/* Telegram 解析探头:同套路,顺手把「代理是否通」也记下来 ——
   这个平台九成的"解析失败"其实是代理没开/被改。
     B站一键取关助手.exe --tg-probe "https://t.me/频道名/123" */
async function runTgProbe(link) {
  const out = { time: new Date().toISOString(), link: String(link || '').slice(0, 300), logFile: dyLogFile() };
  try {
    out.net = await telegram.diagnose({ timeout: 12000 });
    const r = await telegram.fetchPost(link);
    out.parse = {
      ok: r.ok,
      code: r.code || '',
      message: r.message || '',
      kind: r.kind || '',
      channel: r.channel || '',
      postId: r.postId || 0,
      title: r.title || '',
      author: r.author || '',
      duration: r.duration || 0,
      width: r.width || 0,
      height: r.height || 0,
      previewOff: !!r.previewOff,
      qualities: (r.qualities || []).map(function (q) { return { label: q.label, sizeMB: q.sizeMB }; }),
      tries: r.tries || [],
    };
    if (r.ok && r.kind === 'video') out.download = await telegramDownload({ videoUrls: r.videoUrls, title: r.title });
  } catch (e) {
    out.error = String((e && e.stack) || e).slice(0, 800);
  }
  const text = JSON.stringify(out, null, 2);
  let file = '';
  try {
    file = path.join(app.getPath('userData'), 'tg-probe.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  } catch (e) { /* ignore */ }
  dyVideoLog('[Telegram探头] ' + text.replace(/\s+/g, ' ').slice(0, 1500));
  const good = !!(out.parse && out.parse.ok);
  dialog.showMessageBox({
    type: 'info',
    title: 'Telegram 解析探头',
    message: good
      ? '解析成功:' + (out.parse.kind === 'photo' ? '图片帖' : '视频 ' + ((out.parse.qualities[0] && out.parse.qualities[0].sizeMB) || '?') + ' MB') +
        (out.download && out.download.ok ? ',已下载' : '')
      : '解析未成功(' + ((out.parse && out.parse.code) || '见详情') + '),结果已保存',
    detail: text.slice(0, 1600) + (file ? '\n\n文件:' + file : ''),
    buttons: ['好'],
  });
  app.quit();
}

/* 本地缓存探头:不联网,只解本机 tdata。用来判断「扫描结果为空」到底是
   没找到 tdata、开了应用锁,还是缓存目录被清过。
     B站一键取关助手.exe --tglocal-probe "自定义tdata路径(可省略)" */
async function runTglocalProbe(tdata) {
  const out = { time: new Date().toISOString(), logFile: dyLogFile() };
  const custom = String(tdata || '').trim();
  try {
    out.probe = tgLocal.probe(custom ? { tdata: custom } : {});
    delete out.probe.candidates;
    if (out.probe.ok) {
      const r = await tgLocal.scan(custom ? { tdata: custom } : {});
      out.scan = {
        ok: r.ok,
        code: r.code || '',
        message: r.message || '',
        tdata: r.tdata || '',
        items: (r.items || []).length,
        stat: r.stat || {},
        locked: r.locked || 0,
        unknown: r.unknown || 0,
        dupes: r.dupes || 0,
        fileCount: r.fileCount || 0,
        cacheMB: r.cacheBytes ? Math.round(r.cacheBytes / 1048576) : 0,
        ms: r.ms || 0,
        sample: (r.items || []).slice(0, 8).map(function (i) {
          return i.kind + '/' + i.ext + ' ' + Math.round(i.size / 1024) + 'KB' + (i.playable ? '' : ' (缺索引)');
        }),
      };
    }
  } catch (e) {
    out.error = String((e && e.stack) || e).slice(0, 800);
  }
  const text = JSON.stringify(out, null, 2);
  let file = '';
  try {
    file = path.join(app.getPath('userData'), 'tglocal-probe.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  } catch (e) { /* ignore */ }
  dyVideoLog('[TG本地探头] ' + text.replace(/\s+/g, ' ').slice(0, 1500));
  const sc = out.scan || {};
  dialog.showMessageBox({
    type: 'info',
    title: 'Telegram 本地缓存探头',
    message: sc.ok
      ? '可恢复 ' + sc.items + ' 条（图片 ' + ((sc.stat && sc.stat.image) || 0) +
        ' / 视频 ' + ((sc.stat && sc.stat.video) || 0) + ' / 语音 ' + ((sc.stat && sc.stat.audio) || 0) + '）'
      : '没扫出东西:' + ((out.probe && out.probe.message) || sc.message || '见详情'),
    detail: text.slice(0, 1600) + (file ? '\n\n文件:' + file : ''),
    buttons: ['好'],
  });
  app.quit();
}

app.on('window-all-closed', () => app.quit());
