/* 渲染层自检用的假 bili 接口(只在 test/run.js 里挂载,不参与打包)。
   真机点不到的地方(比如没有 Telegram 的机器)靠它把界面流程跑通。 */
const now = Date.now();
const ITEMS = [
  { id: 'a1', source: 'cache', kind: 'image', ext: 'jpg', size: 210 * 1024, playable: true, complete: true, mtime: now - 3600e3 },
  { id: 'a2', source: 'cache', kind: 'image', ext: 'webp', size: 30 * 1024, playable: true, complete: true, mtime: now - 7200e3 },
  { id: 'a3', source: 'media_cache', kind: 'video', ext: 'mp4', size: 8 * 1024 * 1024, playable: false, complete: false, mtime: now - 600e3 },
  { id: 'a4', source: 'cache', kind: 'video', ext: 'webm', size: 16 * 1024, playable: true, complete: true, mtime: now - 120e3 },
  { id: 'a5', source: 'cache', kind: 'image', ext: 'jpg', size: 5 * 1024, playable: true, complete: true, mtime: now - 900e3 },
  { id: 'a6', source: 'media_cache', kind: 'video', ext: 'mp4', size: 1536 * 1024, playable: true, complete: true, mtime: now - 3600e3 },
];
// 1x1 gif,只用来确认"缩略图确实被写进 img"
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const noop = () => {};
const ok = (v) => Promise.resolve(v);

window.__tglCalls = { scan: 0, export: 0, thumb: 0 };

window.bili = {
  /* --- 本地缓存恢复:被测的那套 --- */
  tglProbe: () => ok({ ok: true, tdata: 'C:\\Users\\test\\AppData\\Roaming\\Telegram Desktop\\tdata', fileCount: 926, bytes: 1093794296, keyOk: true }),
  tglScan: () => {
    window.__tglCalls.scan += 1;
    return ok({
      ok: true, tdata: 'C:\\tdata', items: ITEMS,
      stat: { image: 3, video: 3, audio: 0 }, bytes: 9.9 * 1048576,
      locked: 0, unknown: 474, dupes: 0, fileCount: 926, ms: 2900,
    });
  },
  tglThumb: (id) => {
    window.__tglCalls.thumb += 1;
    // a3 是缺索引的分片:模拟"抽不出缩略图"的那条路
    return ok(id === 'a3' ? { ok: false } : { ok: true, dataUrl: PIXEL });
  },
  tglPickDir: () => ok({ ok: true, dir: 'D:\\导出' }),
  tglExport: (args) => {
    window.__tglCalls.export += 1;
    window.__tglLastExport = args;
    return ok({ ok: true, dest: 'D:\\导出\\Telegram本地缓存', count: args.ids.length, written: args.ids.length, skipped: 0, bytes: 1234567 });
  },
  tglOpen: () => ok({ ok: true }),
  onTglProgress: (cb) => { window.__tglProgress = cb; },

  /* --- 以下都是主界面其它模块启动时会调到的东西,给最小可用返回即可 --- */
  checkLogin: () => ok({ loggedIn: false }),
  ffmpegCheck: () => ok({ ok: true, path: 'ffmpeg' }),
  wxvStatus: () => ok({}),
  emojiStatus: () => ok({ tool: { found: true, version: 'test' } }),
  emojiAccounts: () => ok({ ok: true, accounts: [] }),
  pickSave: () => ok(''),
  onDlProgress: noop,
  onLoginSuccess: noop,
  onWxvCaptured: noop,
  onWxvLog: noop,
  onWxvStatus: noop,
  onWxvFeed: noop,
  onEmojiLog: noop,
  onEmojiProgress: noop,
  onEmojiDone: noop,
};
