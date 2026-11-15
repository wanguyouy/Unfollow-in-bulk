/* ============================================================
 * 本地缓存恢复 · 主进程侧自检(用真 tdata,不联网)
 * ------------------------------------------------------------
 *   node test/local-test.js
 * 1) 扫描真缓存,核对类型分布
 * 2) 挑几张图 + 一个能播的视频真导出到 test/_out
 * 3) 核对落盘文件、manifest.json、index.html
 * 4) 再导一次,确认「已存在」被跳过而不是重解
 * 机器上没有 Telegram Desktop 时直接跳过(退出码 0)。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const tgLocal = require('../telegram-local');

const OUT = path.join(__dirname, '_out');
const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined ? '  →  ' + detail : ''));
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

(async function main() {
  const p = tgLocal.probe();
  if (!p.ok) {
    console.log('跳过:本机没有可用的 tdata（' + (p.message || '') + '）');
    process.exit(0);
  }
  console.log('tdata = ' + p.tdata + '\n缓存文件 ' + p.fileCount + ' 个 / ' + (p.bytes / 1048576).toFixed(1) + ' MB\n');

  const r = await tgLocal.scan({});
  check('扫描成功', r.ok, (r.items || []).length + ' 条 · ' + r.ms + 'ms');
  if (!r.ok) process.exit(1);
  check('识别出图片', (r.stat.image || 0) > 0, r.stat.image + ' 张');
  check('字段完整', r.items.every((i) => i.id && i.file && i.ext && i.size > 0 && i.kind), '');
  check('视频带 playable 标记', r.items.filter((i) => i.kind === 'video').every((i) => typeof i.playable === 'boolean'), '');
  const ids = new Set(r.items.map((i) => i.id));
  check('id(=内容 md5)唯一', ids.size === r.items.length, ids.size + ' / ' + r.items.length);

  /* 挑样本:图片 3 张 + 能播的视频 1 个 */
  const images = r.items.filter((i) => i.kind === 'image').sort((a, b) => b.size - a.size).slice(0, 3);
  const video = r.items.filter((i) => i.kind === 'video' && i.playable).sort((a, b) => a.size - b.size)[0];
  const sample = images.concat(video ? [video] : []);
  check('样本可用于导出', sample.length >= 3, sample.map((s) => s.kind + '/' + s.ext).join(' '));

  rmrf(OUT);
  const e1 = await tgLocal.recover({ items: sample, dest: OUT, tdata: r.tdata });
  check('导出成功', e1.ok, e1.ok ? e1.count + ' 项 → ' + e1.dest : e1.message);
  if (!e1.ok) process.exit(1);
  check('切了子目录', fs.existsSync(path.join(OUT, '图片')) && (!video || fs.existsSync(path.join(OUT, '视频'))), fs.readdirSync(OUT).join(' '));
  check('每项都落盘且大小对得上',
    e1.files.every((f) => {
      const fp = path.join(OUT, f.rel.split('/').join(path.sep));
      try { return fs.statSync(fp).size === f.size; } catch (x) { return false; }
    }), e1.written + ' 个新写');

  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
  check('manifest.json 可解析且条数一致', manifest.count === e1.count && manifest.files.length === e1.count, manifest.count + ' 条');
  const index = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
  check('index.html 是完整页面', /<!DOCTYPE html>/.test(index) && /<\/html>/.test(index), index.length + ' 字节');
  check('索引页里有图片和视频标签', /<img src="图片\//.test(index) && (!video || /<video src="视频\//.test(index)), '');

  /* 图片首字节要真的是 jpg/png/webp —— 解错密钥会写出乱码 */
  const imgFile = e1.files.find((f) => f.kind === 'image');
  const head = fs.readFileSync(path.join(OUT, imgFile.rel.split('/').join(path.sep))).subarray(0, 4);
  const isImg = (head[0] === 0xff && head[1] === 0xd8) || head.toString('latin1', 0, 4) === 'RIFF' || (head[0] === 0x89 && head[1] === 0x50);
  check('导出的图片头部合法', isImg, head.toString('hex'));

  const e2 = await tgLocal.recover({ items: sample, dest: OUT, tdata: r.tdata });
  check('二次导出全部跳过(不重解)', e2.ok && e2.written === 0 && e2.skipped === e1.count, '新写 ' + e2.written + ' / 跳过 ' + e2.skipped);

  const before = e1.bytes;
  rmrf(OUT);
  check('清理测试目录', !fs.existsSync(OUT), before + ' 字节已回收');

  const failed = checks.filter((c) => !c.pass).length;
  console.log('\n' + (failed ? failed + ' 项失败' : '全部通过') + '(' + checks.length + ' 项)');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('自检崩了:', (e && e.stack) || e);
  process.exit(2);
});
