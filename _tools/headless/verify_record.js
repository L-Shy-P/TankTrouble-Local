'use strict';
/* 阶段0-0e 对拍脚本：同一份录制【回放两遍】，逐帧比 opName(含 fire) + 坦克位姿 + 子弹位姿
 *
 *   node _tools/headless/verify_record.js --in _tools/headless/prof/base400.jsonl --runs 2
 *
 * 判定：
 *   · 两遍回放逐帧完全一致 → PASS（《总体路线方针》阶段0 的验收标准）
 *   · ★ 2026-10-11 硬化：「回放 vs 原始录制」不再是信息项，不一致 = FAIL。
 *     理由：只比两遍回放只能证明"播放路径自洽"，证明不了"录制→回放可复现"；
 *     1200 帧 12 次里 2 PASS/10 FAIL 正是这么漏掉的（基线稳定性调查 §2.2）。
 *   · 随机序列溢出（play 时序列用尽会返回常数 0）必须为 0，否则说明发散
 *   · 0-3「不丢」：重读文件数帧行 + 自己算一遍 FNV，与页面/meta 的哈希对
 */
const fs = require('fs');
const path = require('path');
const { readRecording, replayEpisode, compareFrames, fnvStep, FNV0 } = require('./record');

const NL = String.fromCharCode(10);

/** 独立复核一个录制文件：帧行数 + FNV 是否与页面/Node 导出时一致 */
function checkLossless(file, rec) {
  const rawLines = fs.readFileSync(file, 'utf8').split(NL).filter((l) => l.length > 0);
  const frameLines = rawLines.filter((l) => l.indexOf('"k":"frame"') >= 0);
  let h = FNV0;
  for (let i = 0; i < frameLines.length; i++) {
    if (i > 0) h = fnvStep(h, NL);
    h = fnvStep(h, frameLines[i]);
  }
  const metaHash = rec.meta && rec.meta.fnv;
  const pageHash = rec.meta && rec.meta.pageFnv;
  return {
    lines: rawLines.length, frameLines: frameLines.length, frames: rec.frames.length,
    fileHash: h, metaHash, pageHash,
    ok: frameLines.length === rec.frames.length && h === metaHash &&
        (pageHash === undefined || h === pageHash),
  };
}

(async () => {
  const argv = process.argv.slice(2);
  const str = (name, d) => { const i = argv.indexOf('--' + name); return i < 0 ? d : argv[i + 1]; };
  const flag = (name) => argv.includes('--' + name);
  const file = str('in', path.join(__dirname, 'prof', 'base400.jsonl'));
  const runs = Number(str('runs', 2));
  const verbose = flag('verbose');

  const rec = readRecording(file);
  let ok = true;

  const loss = checkLossless(file, rec);
  console.log(`落盘复核: 文件 ${loss.lines} 行（frame ${loss.frameLines}/${loss.frames} 条）; ` +
    `文件哈希=${loss.fileHash} meta=${loss.metaHash} 页面=${loss.pageHash} → ` +
    (loss.ok ? '一条不丢' : '异常'));
  if (!loss.ok) ok = false;

  console.log(`录制: ${file}`);
  console.log(`  header: v=${rec.header.v} page=${rec.header.init.page} 玩家=${JSON.stringify(rec.header.init.players)}`);
  console.log(`  初始位姿=${JSON.stringify(rec.header.init.tanks)}`);
  console.log('  地图=' + (rec.header.init.maze ?
    (rec.header.init.maze.width + 'x' + rec.header.init.maze.height + ' 主题=' + rec.header.init.maze.theme) : 'null') +
    '  回合设置=' + JSON.stringify(rec.header.init.consts));
  console.log(`  帧数=${rec.frames.length}  随机序列=${rec.rng ? rec.rng.length : 0}  录制时 RNG 溢出=${rec.meta && rec.meta.rngOverflow}`);

  const results = [];
  for (let i = 1; i <= runs; i++) {
    const out = file.replace(/[.]jsonl$/, '') + '.replay' + i + '.jsonl';
    console.log('');
    console.log(`---- 回放 #${i} → ${out}`);
    const r = await replayEpisode(rec, { out, verbose });
    console.log('  initPose = ' + JSON.stringify(r.initPose));
    console.log('  drive    = ' + JSON.stringify(r.drive));
    console.log('  rng      = ' + JSON.stringify(r.rngState));
    console.log('  导出      = frames=' + r.pageStats.n + ' 分片=' + r.chunks +
      ' 页面fnv=' + r.pageStats.fnv + ' 落盘一致=' + r.framesMatch + ' wallMs=' + r.wallMs);
    const rr = readRecording(out);
    const l2 = checkLossless(out, rr);
    console.log('  复核      = ' + (l2.ok ? '一条不丢' : '异常') + ' (文件 ' + l2.lines + ' 行)');
    if (!l2.ok || !r.framesMatch) ok = false;
    if (rr.meta && rr.meta.err) { console.log('  ⚠️ 回放页面录制器报错: ' + rr.meta.err); ok = false; }
    if (r.drive && r.drive.errs) { console.log('  ⚠️ 回放注入报错 errs=' + r.drive.errs); ok = false; }
    if (r.rngState && r.rngState.overflow) { console.log('  ⚠️ RNG 序列用尽 overflow=' + r.rngState.overflow); ok = false; }
    if (r.rngState && r.rngState.siteOverflow) { console.log('  ⚠️ 调用点分流序列用尽 siteOverflow=' + r.rngState.siteOverflow); ok = false; }
    results.push({ run: i, rec: rr, info: r });
  }

  console.log('');
  console.log('================ 对拍结果 ================');
  if (results.length >= 2) {
    const c = compareFrames(results[0].rec.frames, results[1].rec.frames, '回放#1 vs 回放#2');
    console.log('【验收】两遍回放: ' + (c.ok ? 'PASS 逐帧完全相同' : 'FAIL'));
    console.log('  帧数=' + c.framesA + '/' + c.framesB +
      ' opName(含fire)不一致=' + c.opMismatch +
      ' 坦克位姿不一致=' + c.poseMismatch + ' (最大差 ' + c.maxPoseDiff + ')' +
      ' 子弹位姿不一致=' + c.projMismatch +
      ' 回合状态不一致=' + c.stateMismatch + ' 随机数消费不一致=' + c.rngMismatch +
      ' 决定性隐藏不一致=' + c.hiddenMismatch + ' 观测性不一致(仅信息)=' + c.hiddenObsMismatch +
      ' 时间不一致=' + c.timeMismatch + ' (最大差 ' + c.maxTimeDiff + 'ms)');
    if (c.examples.length) console.log('  例子: ' + c.examples.join(' ; '));
    ok = ok && c.ok;
  }

  const cmp = compareFrames(rec.frames, results[0].rec.frames, '原始录制 vs 回放#1');
  console.log('');
  console.log('【验收】回放#1 vs 原始录制: ' + (cmp.ok ? 'PASS 逐帧完全相同' : 'FAIL'));
  console.log('  opName(含fire)不一致=' + cmp.opMismatch + ' 坦克位姿不一致=' + cmp.poseMismatch +
    ' (最大差 ' + cmp.maxPoseDiff + ') 子弹位姿不一致=' + cmp.projMismatch +
    ' 回合状态不一致=' + cmp.stateMismatch + ' 随机数消费不一致=' + cmp.rngMismatch +
    ' 决定性隐藏不一致=' + cmp.hiddenMismatch + ' 观测性不一致(仅信息)=' + cmp.hiddenObsMismatch +
    ' 实际输入不一致=' + cmp.driveMismatch +
    ' 时间不一致=' + cmp.timeMismatch + ' (最大差 ' + cmp.maxTimeDiff + 'ms)');
  if (cmp.examples.length) console.log('  例子: ' + cmp.examples.join(' ; '));
  if (cmp.obsExamples && cmp.obsExamples.length) console.log('  观测性例子(不计 FAIL): ' + cmp.obsExamples.join(' ; '));
  if (!cmp.ok) ok = false;   // ★ 硬化：录制→回放不可复现 = 硬 FAIL

  fs.writeFileSync(file.replace(/[.]jsonl$/, '') + '.verify.json', JSON.stringify({
    file, frames: rec.frames.length, runs,
    lossless: loss,
    run1vsRun2: results.length >= 2 ? compareFrames(results[0].rec.frames, results[1].rec.frames, 'r1v2') : null,
    recordingVsRun1: cmp,
    perRun: results.map((r) => ({ run: r.run, initPose: r.info.initPose, drive: r.info.drive,
                                  rng: r.info.rngState, framesMatch: r.info.framesMatch, chunks: r.info.chunks })),
    ok,
  }, null, 2));

  console.log('');
  console.log(ok ? '结论: PASS' : '结论: FAIL');
  if (!ok) process.exitCode = 1;
})().catch((e) => {
  console.error('FAILED:', (e && e.stack) || e);
  process.exitCode = 1;
});
