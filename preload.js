/* 预加载脚本:向渲染进程暴露受控的 IPC 接口 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bili', {
  /* 登录 */
  checkLogin: () => ipcRenderer.invoke('login:check'),
  startLogin: () => ipcRenderer.invoke('login:start'),
  logout: () => ipcRenderer.invoke('login:logout'),
  onLoginSuccess: (cb) => ipcRenderer.on('login:success', (_e, info) => cb(info)),
  /* 取关 */
  nav: () => ipcRenderer.invoke('bili:nav'),
  followingsPage: (mid, pn, ps) => ipcRenderer.invoke('bili:followings', mid, pn, ps),
  unfollow: (mid) => ipcRenderer.invoke('bili:unfollow', mid),
  /* 视频下载 */
  resolveVideo: (text) => ipcRenderer.invoke('video:resolve', text),
  getPlayurl: (bvid, cid) => ipcRenderer.invoke('video:playurl', bvid, cid),
  pickSave: (defaultName) => ipcRenderer.invoke('video:pick-save', defaultName),
  downloadStreams: (args) => ipcRenderer.invoke('video:download', args),
  mux: (args) => ipcRenderer.invoke('video:mux', args),
  cleanup: (files) => ipcRenderer.invoke('video:cleanup', files),
  ffmpegCheck: () => ipcRenderer.invoke('video:ffmpeg-check'),
  onDlProgress: (cb) => ipcRenderer.on('dl:progress', (_e, p) => cb(p)),
  /* 窗口 */
  openUnfollow: () => ipcRenderer.invoke('unfollow:open'),
  /* 抖音(视频 / 图集) */
  resolveDyVideo: (text) => ipcRenderer.invoke('dyvideo:resolve', text),
  fetchDyVideo: (id, kind) => ipcRenderer.invoke('dyvideo:fetch', id, kind),
  downloadDyVideo: (args) => ipcRenderer.invoke('dyvideo:download', args),
  pickDir: (title) => ipcRenderer.invoke('dyvideo:pick-dir', title),
  downloadDyImages: (args) => ipcRenderer.invoke('dyvideo:download-images', args),
  /* 支付宝(生活号 / 视频号) */
  fetchAlipay: (text) => ipcRenderer.invoke('alipay:fetch', text),
  downloadAlipay: (args) => ipcRenderer.invoke('alipay:download', args),
  /* Telegram(公开频道帖;预览关闭的频道会如实报错) */
  fetchTelegram: (text) => ipcRenderer.invoke('telegram:fetch', text),
  downloadTelegram: (args) => ipcRenderer.invoke('telegram:download', args),
  saveTelegramPhoto: (args) => ipcRenderer.invoke('telegram:save-photo', args),
  /* MTProto:用本机 tdata 已登录的授权解析/下载(私密频道、预览关闭的频道都能拿) */
  fetchTelegramMt: (args) => ipcRenderer.invoke('telegram:mtfetch', args),
  downloadTelegramMt: (args) => ipcRenderer.invoke('telegram:mtdownload', args),
  /* Telegram 本地缓存恢复(离线:解本机 Telegram Desktop 的 tdata) */
  tglProbe: (opts) => ipcRenderer.invoke('tglocal:probe', opts),
  tglScan: (opts) => ipcRenderer.invoke('tglocal:scan', opts),
  tglThumb: (id) => ipcRenderer.invoke('tglocal:thumb', id),
  tglPickDir: () => ipcRenderer.invoke('tglocal:pick-dir'),
  tglExport: (args) => ipcRenderer.invoke('tglocal:export', args),
  tglOpen: (dir) => ipcRenderer.invoke('tglocal:open', dir),
  onTglProgress: (cb) => ipcRenderer.on('tglocal:progress', (_e, p) => cb(p)),
  /* 通用短链嗅探(自动判断落到哪个平台) */
  sniffShare: (text) => ipcRenderer.invoke('share:sniff', text),
  /* 微信视频号(实验) */
  wxvStart: () => ipcRenderer.invoke('wxv:start'),
  wxvStop: () => ipcRenderer.invoke('wxv:stop'),
  wxvStatus: () => ipcRenderer.invoke('wxv:status'),
  wxvInstallCert: () => ipcRenderer.invoke('wxv:install-cert'),
  wxvUninstallCert: () => ipcRenderer.invoke('wxv:uninstall-cert'),
  wxvCertInfo: () => ipcRenderer.invoke('wxv:cert-info'),
  wxvDownload: (url, savePath, reqHeaders) => ipcRenderer.invoke('wxv:download', url, savePath, reqHeaders),
  wxvOpen: (p) => ipcRenderer.invoke('wxv:open', p),
  onWxvCaptured: (cb) => ipcRenderer.on('wxv:captured', (_e, info) => cb(info)),
  onWxvLog: (cb) => ipcRenderer.on('wxv:log', (_e, line) => cb(line)),
  onWxvStatus: (cb) => ipcRenderer.on('wxv:status', (_e, s) => cb(s)),
  onWxvFeed: (cb) => ipcRenderer.on('wxv:feed', (_e, item) => cb(item)),
  downloadWxvFeed: (item, savePath) => ipcRenderer.invoke('wxv:feed-download', item, savePath),
  downloadWxvStream: (item, savePath) => ipcRenderer.invoke('wxv:stream-download', item, savePath),
  renameWxvStream: (item) => ipcRenderer.invoke('wxv:rename-stream', item),
  thumbWxvStream: (item) => ipcRenderer.invoke('wxv:stream-thumb', item),
  deleteWxvStream: (id) => ipcRenderer.invoke('wxv:delete-stream', id),
  clearWxvCaptures: () => ipcRenderer.invoke('wxv:clear-captures'),
  scanWxvCacheDb: () => ipcRenderer.invoke('wxv:scan-cache-db'),
  wxvCacheInfo: () => ipcRenderer.invoke('wxv:cache-info'),
  wxvCacheClear: () => ipcRenderer.invoke('wxv:cache-clear'),
  wxvCacheRestore: () => ipcRenderer.invoke('wxv:cache-restore'),
  /* 微信表情包导出 */
  emojiStatus: () => ipcRenderer.invoke('emoji:status'),
  emojiAccounts: () => ipcRenderer.invoke('emoji:accounts'),
  emojiInstall: (mode) => ipcRenderer.invoke('emoji:install', mode),
  emojiPickDir: () => ipcRenderer.invoke('emoji:pick-dir'),
  emojiOpen: (p) => ipcRenderer.invoke('emoji:open', p),
  emojiExport: (opts) => ipcRenderer.invoke('emoji:export', opts),
  emojiStop: () => ipcRenderer.invoke('emoji:stop'),
  onEmojiLog: (cb) => ipcRenderer.on('emoji:log', (_e, p) => cb(p && p.msg)),
  onEmojiProgress: (cb) => ipcRenderer.on('emoji:progress', (_e, p) => cb(p)),
  onEmojiDone: (cb) => ipcRenderer.on('emoji:done', (_e, p) => cb(p)),
});
