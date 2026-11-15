/* ============================================================
 * Telegram 本地缓存恢复(离线)
 * ------------------------------------------------------------
 * 和「粘贴链接解析」完全无关:那条走网络、受频道有没有开网页预览限制;
 * 这条只读本机 tdata,解出来的是本机看过的媒体,私密频道/群一样有。
 * 界面只拿 id(内容 md5),缩略图和导出都按 id 回主进程要 ——
 * 渲染层因此没有「指定任意路径」的能力。
 * ============================================================ */
const tglState = {
  scanning: false,
  running: false,
  items: [],
  byId: new Map(),
  selected: new Set(),
  /* skipSmall 默认关:圆视频(webm)普遍只有 12~60KB,一开就全被藏起来了 */
  filter: { image: true, video: true, audio: true, onlyPlayable: false, skipSmall: false },
  dest: '',
  outDir: '',
};
const tglThumbData = new Map(); // id -> dataUrl
const tglThumbNone = new Set(); // id -> 已知取不到缩略图
const tglThumbBusy = new Set();
const tglNodes = new Map();     // id -> 元素(局部刷新缩略图用)
let tglQueue = [];
let tglThumbRunning = 0;
let tglObserver = null;

function tglLogLine(line) {
  const el = $('tglLog');
  const time = new Date().toTimeString().slice(0, 8);
  el.textContent += '[' + time + '] ' + line + '\n';
  const lines = el.textContent.split('\n');
  if (lines.length > 300) el.textContent = lines.slice(-200).join('\n');
  el.scrollTop = el.scrollHeight;
}

function tglStatus(html) { $('tglStatus').innerHTML = html; }

function tglSetBar(phase, done, total) {
  const wrap = $('tglProgressWrap');
  if (!phase) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  const pct = total ? Math.min(99, Math.round((done / total) * 100)) : 0;
  $('tglStage').textContent = phase === 'scan' ? '扫描' : '导出';
  $('tglBar').style.width = Math.max(2, pct) + '%';
  $('tglPct').textContent = total ? done + '/' + total : '';
}

function tglKindLabel(it) {
  if (!it) return '?';
  if (it.kind === 'video') return it.ext === 'webm' ? '圆视频' : '视频';
  if (it.kind === 'audio') return '语音';
  return it.ext === 'gif' ? '动图' : '图片';
}

/* 缓存文件的 mtime = 下载到本机的时间,比文件名有用得多 */
function tglAgo(ms) {
  const n = Number(ms) || 0;
  if (!n) return '';
  const d = Date.now() - n;
  if (d < 0) return '';
  const min = Math.floor(d / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const h = Math.floor(min / 60);
  if (h < 24) return h + ' 小时前';
  const day = Math.floor(h / 24);
  if (day < 30) return day + ' 天前';
  const dt = new Date(n);
  return (dt.getMonth() + 1) + '/' + dt.getDate();
}

function tglFiltered() {
  const f = tglState.filter;
  return tglState.items.filter(function (it) {
    if (!f[it.kind]) return false;
    if (it.kind === 'video' && f.onlyPlayable && !it.playable) return false;
    if (f.skipSmall && it.size <= 20 * 1024) return false;
    return true;
  });
}

function tglSelectedBytes() {
  let n = 0;
  for (const id of tglState.selected) {
    const it = tglState.byId.get(id);
    if (it) n += it.size || 0;
  }
  return n;
}

function tglUpdateCount() {
  const sel = tglState.selected.size;
  $('tglCount').textContent = '显示 ' + $('tglList').childElementCount + ' / 共 ' + tglState.items.length + ' 条' +
    (sel ? ' · 已选 ' + sel + ' 条(' + fmtSize(tglSelectedBytes()) + ')' : '');
  $('tglExportBtn').disabled = tglState.running || sel === 0;
}

/* 只重建网格;缩略图靠 IntersectionObserver 按需拉,别一次要几百张 base64 */
function renderTglList() {
  const list = tglFiltered();
  const box = $('tglList');
  tglNodes.clear();
  box.innerHTML = list
    .map(function (it) {
      const data = tglThumbData.get(it.id);
      const label = tglKindLabel(it);
      const tag = it.kind === 'video' && !it.playable
        ? '<span class="tgl-tag warn">缺索引</span>'
        : '<span class="tgl-tag">' + esc(label) + '</span>';
      const media = data
        ? '<img class="tgl-media" alt="" src="' + data + '">'
        : '<div class="tgl-ph">' + (tglThumbNone.has(it.id) ? esc(label) : '…') + '</div>';
      const when = tglAgo(it.mtime);
      return '<div class="tgl-item' + (tglState.selected.has(it.id) ? ' on' : '') + '" data-id="' + esc(it.id) + '">' +
        media + tag + '<div class="tgl-tick">✓</div>' +
        '<div class="tgl-meta">' + esc(fmtSize(it.size)) + ' · ' + esc(it.ext) + (when ? ' · ' + esc(when) : '') + '</div>' +
        '</div>';
    })
    .join('');

  tglObserve();
  tglUpdateCount();
  $('tglFilters').classList.toggle('hidden', !tglState.items.length);
  $('tglExportRow').classList.toggle('hidden', !tglState.items.length);
}

function tglObserve() {
  if (tglObserver) { tglObserver.disconnect(); tglObserver = null; }
  const box = $('tglList');
  const els = box.querySelectorAll('.tgl-item');
  for (const el of els) tglNodes.set(el.dataset.id, el);
  if (typeof IntersectionObserver !== 'function') {
    for (const el of els) if (el.querySelector('.tgl-ph')) tglEnqueueThumb(el.dataset.id);
    return;
  }
  tglObserver = new IntersectionObserver(function (entries) {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      tglObserver.unobserve(en.target);
      if (en.target.querySelector('.tgl-ph')) tglEnqueueThumb(en.target.dataset.id);
    }
  }, { root: box, rootMargin: '240px' });
  for (const el of els) tglObserver.observe(el);
}

function tglEnqueueThumb(id) {
  if (!id) return;
  if (tglThumbData.has(id) || tglThumbNone.has(id) || tglThumbBusy.has(id)) return;
  tglThumbBusy.add(id);
  tglQueue.push(id);
  tglPumpThumbs();
}

/* 并发 3:图片是 nativeImage 解码,视频要起 ffmpeg 抽帧,一次几十个会把主进程压死 */
function tglPumpThumbs() {
  while (tglThumbRunning < 3 && tglQueue.length) {
    const id = tglQueue.shift();
    tglThumbRunning += 1;
    window.bili.tglThumb(id)
      .then(function (r) {
        if (r && r.ok && r.dataUrl) {
          tglThumbData.set(id, r.dataUrl);
          tglPatchThumb(id, r.dataUrl);
        } else {
          tglThumbNone.add(id);
          tglPatchThumb(id, null);
        }
      })
      .catch(function () {
        tglThumbNone.add(id);
        tglPatchThumb(id, null);
      })
      .then(function () {
        tglThumbRunning -= 1;
        tglThumbBusy.delete(id);
        tglPumpThumbs();
      });
  }
}

function tglPatchThumb(id, dataUrl) {
  const node = tglNodes.get(id);
  if (!node) return;
  const old = node.querySelector('.tgl-media, .tgl-ph');
  if (!old) return;
  if (dataUrl) {
    const img = document.createElement('img');
    img.className = 'tgl-media';
    img.alt = '';
    img.src = dataUrl;
    old.replaceWith(img);
  } else {
    const div = document.createElement('div');
    div.className = 'tgl-ph';
    div.textContent = tglKindLabel(tglState.byId.get(id));
    old.replaceWith(div);
  }
}

async function tglProbe() {
  const p = await window.bili.tglProbe({ tdata: $('tglPath').value.trim() || undefined });
  if (!p || !p.ok) {
    tglStatus('<span style="color:#e8891a">' + esc((p && p.message) || '没找到 Telegram 数据目录') + '</span>');
    return false;
  }
  tglStatus('已找到数据目录:<span style="user-select:text">' + esc(p.tdata) + '</span><br>' +
    '缓存 ' + p.fileCount + ' 个文件 / ' + fmtSize(p.bytes) + ',本地密钥可用。点「扫描本地缓存」开始。');
  return true;
}

$('tglScanBtn').addEventListener('click', async () => {
  if (tglState.scanning || tglState.running) return;
  const custom = $('tglPath').value.trim();
  tglState.scanning = true;
  $('tglScanBtn').disabled = true;
  $('tglExportBtn').disabled = true;
  tglStatus('扫描中…(解密要读一遍缓存,1GB 大约 3 秒)');
  tglSetBar('scan', 0, 0);
  tglLogLine('开始扫描' + (custom ? ':' + custom : ''));
  try {
    const r = await window.bili.tglScan({ tdata: custom || undefined });
    if (!r || !r.ok) {
      tglSetBar(null);
      tglStatus('<span style="color:#ff5c7c">扫描失败:' + esc((r && r.message) || '未知原因') + '</span>');
      tglLogLine('扫描失败 ' + ((r && (r.code + ' ' + r.message)) || ''));
      return;
    }
    tglState.items = r.items || [];
    tglState.byId = new Map(tglState.items.map(function (i) { return [i.id, i]; }));
    tglState.selected.clear();
    tglThumbData.clear();
    tglThumbNone.clear();
    tglThumbBusy.clear();
    tglQueue = [];
    $('tglCImage').textContent = (r.stat && r.stat.image) || 0;
    $('tglCVideo').textContent = (r.stat && r.stat.video) || 0;
    $('tglCAudio').textContent = (r.stat && r.stat.audio) || 0;
    tglSetBar(null);
    const stat = r.stat || {};
    if (!tglState.items.length) {
      tglStatus('这个缓存里没有可识别的媒体。可能清过缓存,或者最近只聊了文字。');
      tglLogLine('扫描完成,0 条可恢复 / ' + r.fileCount + ' 个文件');
      renderTglList();
      return;
    }
    tglStatus('扫描完成:可恢复 <b>' + tglState.items.length + '</b> 条(图片 ' + (stat.image || 0) +
      ' / 视频 ' + (stat.video || 0) + ' / 语音 ' + (stat.audio || 0) + '),共 ' + fmtSize(r.bytes || 0) +
      '。未识别 ' + (r.unknown || 0) + ' 个(视频中段分片),重复 ' + (r.dupes || 0) + ' 个已合并。<br>' +
      '<span class="muted">点缩略图勾选,或点「全选」。</span>');
    tglLogLine('扫描完成 ' + tglState.items.length + ' 条 / ' + r.fileCount + ' 个文件 / 耗时 ' + r.ms + 'ms');
    renderTglList();
  } catch (e) {
    tglSetBar(null);
    tglStatus('<span style="color:#ff5c7c">扫描异常:' + esc((e && e.message) || e) + '</span>');
    tglLogLine('异常 ' + ((e && e.message) || e));
  } finally {
    tglState.scanning = false;
    $('tglScanBtn').disabled = false;
    tglUpdateCount();
  }
});

$('tglList').addEventListener('click', function (e) {
  const item = e.target.closest('.tgl-item');
  if (!item) return;
  const id = item.dataset.id;
  if (!id) return;
  if (tglState.selected.has(id)) {
    tglState.selected.delete(id);
    item.classList.remove('on');
  } else {
    tglState.selected.add(id);
    item.classList.add('on');
  }
  tglUpdateCount();
});

/* 勾选只改 class,不重建列表 —— 重建会把几百张已加载的缩略图和滚动位置全丢掉 */
function tglSetAllVisible(on) {
  for (const it of tglFiltered()) {
    if (on) tglState.selected.add(it.id);
    else tglState.selected.delete(it.id);
  }
  for (const el of $('tglList').children) {
    el.classList.toggle('on', tglState.selected.has(el.dataset.id));
  }
  tglUpdateCount();
}

$('tglSelAllBtn').addEventListener('click', () => tglSetAllVisible(true));
$('tglSelNoneBtn').addEventListener('click', () => tglSetAllVisible(false));

['tglKImage', 'tglKVideo', 'tglKAudio', 'tglOnlyPlayable', 'tglSkipSmall'].forEach(function (id) {
  $(id).addEventListener('change', function () {
    tglState.filter = {
      image: $('tglKImage').checked,
      video: $('tglKVideo').checked,
      audio: $('tglKAudio').checked,
      onlyPlayable: $('tglOnlyPlayable').checked,
      skipSmall: $('tglSkipSmall').checked,
    };
    renderTglList();
  });
});

$('tglPickBtn').addEventListener('click', async () => {
  const r = await window.bili.tglPickDir();
  if (r && r.ok && r.dir) {
    tglState.dest = r.dir;
    $('tglDest').textContent = '导出到:' + r.dir;
  }
});

$('tglOpenBtn').addEventListener('click', () => {
  if (tglState.outDir) window.bili.tglOpen(tglState.outDir);
});

$('tglExportBtn').addEventListener('click', async () => {
  if (tglState.running) return;
  const ids = Array.from(tglState.selected);
  if (!ids.length) return;
  tglState.running = true;
  $('tglExportBtn').disabled = true;
  $('tglScanBtn').disabled = true;
  tglSetBar('export', 0, ids.length);
  tglStatus('导出中…(已存在的同名同大小文件会跳过)');
  tglLogLine('开始导出 ' + ids.length + ' 条' + (tglState.dest ? ' → ' + tglState.dest : ''));
  try {
    const r = await window.bili.tglExport({ ids: ids, dest: tglState.dest || undefined, byKind: true });
    if (!r || !r.ok) {
      tglSetBar(null);
      tglStatus('<span style="color:#ff5c7c">导出失败:' + esc((r && r.message) || '未知原因') + '</span>');
      tglLogLine('导出失败 ' + ((r && r.message) || ''));
      return;
    }
    tglSetBar('export', ids.length, ids.length);
    $('tglBar').style.width = '100%';
    tglState.outDir = r.dest;
    $('tglOpenBtn').classList.remove('hidden');
    tglStatus('✅ 已导出 <b>' + r.count + '</b> 项(新写 ' + (r.written || 0) + ' / 已存在 ' + (r.skipped || 0) +
      ', ' + fmtSize(r.bytes || 0) + ')→ <span style="user-select:text">' + esc(r.dest) + '</span><br>' +
      '<span class="muted">同目录下的 index.html 可以直接在浏览器里翻看,manifest.json 是同一份清单。</span>');
    tglLogLine('导出完成 ' + r.count + ' 项,新写 ' + (r.written || 0));
  } catch (e) {
    tglSetBar(null);
    tglStatus('<span style="color:#ff5c7c">导出异常:' + esc((e && e.message) || e) + '</span>');
    tglLogLine('异常 ' + ((e && e.message) || e));
  } finally {
    tglState.running = false;
    $('tglScanBtn').disabled = false;
    tglUpdateCount();
  }
});

if (window.bili.onTglProgress) {
  window.bili.onTglProgress(function (p) {
    if (p && p.phase) tglSetBar(p.phase, p.done || 0, p.total || 0);
  });
}

/* 进界面就先探一下:用户点「扫描」之前就该知道有没有找到 tdata、是不是被应用锁挡住 */
(async function () {
  try { await tglProbe(); } catch (e) { /* 没装 Telegram 的机器上不需要报错 */ }
})();
