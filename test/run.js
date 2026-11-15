/* ============================================================
 * 渲染层端到端自检(用真的 renderer/index.html + 真的 app.js/tgl-local.js)
 * ------------------------------------------------------------
 * 本机 Electron 直接双击起不来,没法手点界面;所以用隐藏窗口加载真实页面、
 * 把 window.bili 换成 test/preload-stub.js 里的假接口,再用 executeJavaScript
 * 模拟点击、读 DOM 断言。跑法:
 *     npx electron test/run.js
 * 结果同时打印到控制台并写到 test/result.json。
 * ============================================================ */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'result.json');
const consoleLines = [];
const checks = [];

function check(name, pass, detail) {
  checks.push({ name: name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined ? '  →  ' + detail : ''));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1000,
    webPreferences: {
      preload: path.join(__dirname, 'preload-stub.js'),
      contextIsolation: false,
      nodeIntegration: false,
      offscreen: true,
    },
  });
  win.webContents.setFrameRate(20);
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) consoleLines.push('[console ' + level + '] ' + msg);
  });
  win.webContents.on('preload-error', (_e, p, err) => consoleLines.push('[preload-error] ' + p + ' ' + (err && err.message)));

  const js = (code) => win.webContents.executeJavaScript(code, true);

  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await wait(900); // 等页面里的自动 probe 跑完

    /* --- 1. 自动概览 --- */
    const status0 = await js("document.getElementById('tglStatus').textContent");
    check('页面加载后自动探测 tdata', /已找到数据目录/.test(status0), status0.slice(0, 80));

    /* --- 2. 扫描 --- */
    await js("document.getElementById('tglScanBtn').click()");
    await wait(700);
    const items = await js("document.querySelectorAll('#tglList .tgl-item').length");
    const total = await js("document.getElementById('tglCount').textContent");
    // 6 条里有 1 条 5KB,默认「隐藏 ≤20KB」应当把它滤掉
    check('扫描后渲染 5 条(20KB 以下被过滤)', items === 5, '渲染 ' + items + ' 条 · ' + total);
    check('统计文案带总数', /共 6 条/.test(total), total);
    check('筛选行与导出按钮出现', await js("!document.getElementById('tglFilters').classList.contains('hidden') && !document.getElementById('tglExportRow').classList.contains('hidden')"), '');
    const warnTag = await js("document.querySelectorAll('#tglList .tgl-tag.warn').length");
    check('缺索引的视频被标出来', warnTag === 1, warnTag + ' 个 warn 标记');
    const scanStatus = await js("document.getElementById('tglStatus').textContent");
    check('扫描结果文案含未识别数量', /未识别 474/.test(scanStatus), scanStatus.slice(0, 100));

    /* --- 3. 缩略图懒加载 --- */
    await wait(600);
    const imgs = await js("document.querySelectorAll('#tglList img.tgl-media').length");
    const phs = await js("document.querySelectorAll('#tglList .tgl-ph').length");
    check('缩略图被写回列表', imgs + phs === 5, 'img ' + imgs + ' / 占位 ' + phs);
    const noThumb = await js("Array.prototype.filter.call(document.querySelectorAll('#tglList .tgl-item'), function(e){return e.dataset.id==='a3'}).map(function(e){return e.querySelector('.tgl-ph')?e.querySelector('.tgl-ph').textContent:'img'})[0]");
    check('抽不出帧的视频降级成类型占位', noThumb === '视频', '占位文案 ' + noThumb);

    /* --- 4. 勾选 --- */
    await js("document.querySelector('#tglList .tgl-item').click()");
    await wait(120);
    const sel1 = await js("document.getElementById('tglCount').textContent");
    check('点一下即选中', /已选 1 条/.test(sel1), sel1);
    const onClass = await js("document.querySelectorAll('#tglList .tgl-item.on').length");
    check('选中态写在 class 上', onClass === 1, onClass + ' 个 .on');

    await js("document.getElementById('tglSelAllBtn').click()");
    await wait(120);
    const selAll = await js("document.getElementById('tglCount').textContent");
    check('全选只选当前可见的 5 条', /已选 5 条/.test(selAll), selAll);

    /* --- 5. 筛选 --- */
    await js("var v=document.getElementById('tglKVideo'); v.checked=false; v.dispatchEvent(new Event('change'))");
    await wait(200);
    const onlyImg = await js("document.querySelectorAll('#tglList .tgl-item').length");
    check('去掉视频后剩 3 条图片', onlyImg === 3, onlyImg + ' 条');

    await js("var v=document.getElementById('tglKVideo'); v.checked=true; v.dispatchEvent(new Event('change')); var p=document.getElementById('tglOnlyPlayable'); p.checked=true; p.dispatchEvent(new Event('change'))");
    await wait(200);
    const playableOnly = await js("document.querySelectorAll('#tglList .tgl-item').length");
    check('只看能播的视频后剩 4 条', playableOnly === 4, playableOnly + ' 条');

    /* --- 6. 导出 --- */
    await js("document.getElementById('tglSelAllBtn').click()");
    await wait(100);
    await js("document.getElementById('tglExportBtn').click()");
    await wait(600);
    const exportStatus = await js("document.getElementById('tglStatus').textContent");
    const exportCall = await js("JSON.stringify(window.__tglLastExport)");
    const openShown = await js("!document.getElementById('tglOpenBtn').classList.contains('hidden')");
    check('导出成功文案', /已导出/.test(exportStatus), exportStatus.slice(0, 90));
    check('导出入参带上了选中的 id', /ids/.test(String(exportCall)) && JSON.parse(String(exportCall)).ids.length === 4, exportCall);
    check('导出后出现「打开导出目录」', openShown, '');

    /* --- 7. 进度事件 --- */
    await js("window.__tglProgress({phase:'export',done:2,total:4})");
    await wait(100);
    const bar = await js("document.getElementById('tglBar').style.width");
    check('进度事件能推动进度条', bar === '50%', bar);

    /* --- 8. 没有脚本报错 --- */
    check('页面无脚本错误', consoleLines.length === 0, consoleLines.join(' | ').slice(0, 300));
  } catch (e) {
    check('自检异常', false, (e && e.stack) || e);
  }

  const failed = checks.filter((c) => !c.pass).length;
  const summary = { time: new Date().toISOString(), total: checks.length, failed: failed, checks: checks, console: consoleLines };
  try { fs.writeFileSync(OUT, JSON.stringify(summary, null, 2), 'utf8'); } catch (e) { /* ignore */ }
  console.log('\n' + (failed ? failed + ' 项失败' : '全部通过') + ' (' + checks.length + ' 项) → ' + OUT);
  app.exit(failed ? 1 : 0);
});

app.on('window-all-closed', () => app.quit());
