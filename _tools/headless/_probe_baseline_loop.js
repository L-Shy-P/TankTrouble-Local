'use strict';
/* 探针：基线稳定性循环测试（只读 + 只新建探针，不动 game_core）
 *
 * 目标：让「同一录制反复回放 → 逐帧逐字节相同」这条基线接受足够多次的证伪。
 *
 * 模式：
 *   --mode replay  （默认）同一录制回放 N 遍，每遍与原始录制逐帧对拍
 *   --mode record  每次新录一局（新地图/新随机序列）→ 回放 N 次 → 与录制对拍
 *   --parallel K   并发跑 K 个回放（每页独立 Match / 独立浏览器 / 独立 python server）
 *   --slow MS      回放阶段每帧之间真实 sleep MS 毫秒（放大真实时间渗入）
 *   --slow-asset MS  资产加载阶段每帧之间真实 sleep MS（放大泵帧数漂移）
 *   --frames N     record 模式的帧数（默认 900）
 *   --iters N      迭代次数
 *
 * 失败时：把当次回放文件另存为 prof/FAIL_<ts>_*.jsonl，并写 FAIL_*.verify.json。
 * 日志一行一个 JSON，便于重定向后统计。
 *
 *   node _tools/headless/_probe_baseline_loop.js --in prof/base400.jsonl --iters 30
 */
const fs = require('fs');
const path = require('path');

// ---- 在 require('./match') 之前，给每次 launch 分配独占调试端口，避免并发撞端口 ----
const cdp = require('./cdp');
const realLaunch = cdp.launch;
let launchSeq = 0;
const LAUNCH_BASE = 17100 + (process.pid % 50) * 40;   // 避开其它工具常用的 9300~9700
cdp.launch = function (opts) {
  const o = Object.assign({}, opts || {});
  if (!o.port) o.port = LAUNCH_BASE + (launchSeq++) % 40;
  return realLaunch(o);
};

const { Match } = require('./match');
const {
  readRecording, replayEpisode, compareFrames, recordEpisode, fnvStep, FNV0,
} = require('./record');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROF = path.join(__dirname, 'prof');
const argv = process.argv.slice(2);
const num = (name, d) => { const i = argv.indexOf('--' + name); return i < 0 ? d : Number(argv[i + 1]); };
const str = (name, d) => { const i = argv.indexOf('--' + name); return i < 0 ? d : argv[i + 1]; };

const MODE = str('mode', 'replay');
const ITERS = num('iters', 20);
const PARALLEL = num('parallel', 1);
const SLOW = num('slow', 0);
const SLOW_ASSET = num('slow-asset', 0);
const REC_FRAMES = num('frames', 900);
const IN = str('in', path.join(PROF, 'base400.jsonl'));

// ---- 时间抖动注入：慢放/慢加载（不改虚拟时钟，只改真实让出时间） ----
const origOpen = Match.prototype.open;
Match.prototype.open = async function (opts) {
  this.__probePhase = 'open';
  try { return await origOpen.call(this, opts || {}); }
  finally { this.__probePhase = 'play'; }
};
const origPump = Match.prototype.pump;
Match.prototype.pump = async function (n, opts) {
  const ms = (this.__probePhase === 'open') ? SLOW_ASSET : SLOW;
  if (!ms) return origPump.call(this, n, opts);
  let done = 0;
  while (done < n) {
    await origPump.call(this, 1, { yieldMs: 0 });
    done++;
    await sleep(ms);
  }
  return done;
};

function ts() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fnvFile(frames) {
  let h = FNV0;
  for (let i = 0; i < frames.length; i++) {
    if (i > 0) h = fnvStep(h, '\n');
    h = fnvStep(h, frames[i].__raw || JSON.stringify(frames[i]));
  }
  return h >>> 0;
}

/** 对拍并返回精简摘要；失败时落盘证据 */
function judge(rec, file, label, tag) {
  const rr = readRecording(file);
  const c = compareFrames(rec.frames, rr.frames, label);
  const out = {
    ok: c.ok, frames: rr.frames.length,
    opMismatch: c.opMismatch, poseMismatch: c.poseMismatch, maxPoseDiff: c.maxPoseDiff,
    projMismatch: c.projMismatch, stateMismatch: c.stateMismatch,
    rngMismatch: c.rngMismatch, rngBootOffset: c.rngBootOffset, rngOffsetFrames: c.rngOffsetFrames,
    timeMismatch: c.timeMismatch, maxTimeDiff: c.maxTimeDiff,
    hiddenMismatch: c.hiddenMismatch, hiddenObsMismatch: c.hiddenObsMismatch, driveMismatch: c.driveMismatch,
    examples: c.examples.slice(0, 3),
  };
  if (!c.ok) {
    const t = ts();
    const keep = path.join(PROF, `FAIL_${tag}_${t}.jsonl`);
    const keepV = path.join(PROF, `FAIL_${tag}_${t}.verify.json`);
    try { fs.copyFileSync(file, keep); } catch (e) {}
    try { fs.writeFileSync(keepV, JSON.stringify({ file, label, compare: c, rec: rr, source: IN }, null, 2)); } catch (e) {}
    out.kept = keep;
    out.keptVerify = keepV;
  }
  return out;
}

async function oneReplay(rec, outFile, i, tag) {
  const t0 = Date.now();
  const r = await replayEpisode(rec, { out: outFile });
  const wallMs = Date.now() - t0;
  const j = judge(rec, outFile, `iter${i} vs rec`, tag);
  // 额外：回放自己的元信息（页面统计 / rng idx / 注入统计）
  const rr = readRecording(outFile);
  return Object.assign(j, {
    wallMs,
    rngIdx: r.rngState && r.rngState.idx, rngLen: r.rngState && r.rngState.len,
    rngOverflow: r.rngState && r.rngState.overflow,
    rngCalls: r.rngState && r.rngState.calls, rngSites: r.rngState && r.rngState.siteCount,
    siteOverflow: r.rngState && r.rngState.siteOverflow,
    driveErrs: r.drive && r.drive.errs, driveApplied: r.drive && r.drive.applied,
    driveSkipped: r.drive && r.drive.skipped,
    pageFrames: r.pageStats && r.pageStats.n, framesMatch: r.framesMatch,
    recMeta: rr.meta ? { frames: rr.meta.frames, fnv: rr.meta.fnv, pageFnv: rr.meta.pageFnv } : null,
  });
}

async function recordThenReplay(i, tag) {
  const recFile = path.join(PROF, `_loop_rec_${tag}_${i}.jsonl`);
  const repFile = path.join(PROF, `_loop_rep_${tag}_${i}.jsonl`);
  const m = new Match();
  const t0 = Date.now();
  const recInfo = await recordEpisode(m, { frames: REC_FRAMES, out: recFile });
  await m.close();
  const rec = readRecording(recFile);
  const r = await replayEpisode(rec, { out: repFile });
  const j = judge(rec, repFile, `iter${i} replay vs fresh rec`, tag);
  // 有失败才留文件；成功删掉临时文件（保留最后一份用于审计）
  if (j.ok) {
    try { fs.copyFileSync(repFile, path.join(PROF, '_loop_last_ok.jsonl')); } catch (e) {}
    try { fs.copyFileSync(recFile, path.join(PROF, '_loop_last_ok_rec.jsonl')); } catch (e) {}
    try { fs.unlinkSync(repFile); fs.unlinkSync(recFile); } catch (e) {}
  } else {
    j.keptRec = recFile; j.keptReplay = repFile;
  }
  return Object.assign(j, {
    wallMs: Date.now() - t0,
    recFrames: recInfo.frames, recRngLen: recInfo.rng.len, recOverflow: recInfo.rng.overflow,
    recHash: recInfo.fnv, recPageHash: recInfo.pageFnv, recFramesMatch: recInfo.framesMatch,
    replayRngOverflow: r.rngState && r.rngState.overflow,
    replayDriveErrs: r.drive && r.drive.errs,
    replayFramesMatch: r.framesMatch,
    headerMaze: rec.header.init.maze ? `${rec.header.init.maze.width}x${rec.header.init.maze.height}/theme${rec.header.init.maze.theme}` : null,
  });
}

(async () => {
  fs.mkdirSync(PROF, { recursive: true });
  const tag = `${MODE}${PARALLEL > 1 ? '_p' + PARALLEL : ''}${SLOW ? '_slow' + SLOW : ''}${SLOW_ASSET ? '_sa' + SLOW_ASSET : ''}`;
  console.log(JSON.stringify({ start: new Date().toISOString(), mode: MODE, iters: ITERS, parallel: PARALLEL, slow: SLOW, slowAsset: SLOW_ASSET, in: IN, recFrames: REC_FRAMES, pid: process.pid }));

  let rec = null;
  if (MODE === 'replay') {
    rec = readRecording(IN);
    console.log(JSON.stringify({ loaded: IN, frames: rec.frames.length, rngLen: rec.rng ? rec.rng.length : 0, headerMaze: rec.header.init.maze }));
  }

  let pass = 0, fail = 0;
  for (let i = 0; i < ITERS; i++) {
    try {
      if (MODE === 'record') {
        const j = await recordThenReplay(i, tag);
        console.log(JSON.stringify(Object.assign({ i }, j)));
        j.ok ? pass++ : fail++;
      } else if (PARALLEL > 1) {
        const outs = [];
        for (let k = 0; k < PARALLEL; k++) outs.push(path.join(PROF, `_loop_p${k}.jsonl`));
        const rs = await Promise.all(outs.map((o, k) => oneReplay(rec, o, i + '.' + k, `${tag}_k${k}`)));
        rs.forEach((r, k) => console.log(JSON.stringify(Object.assign({ i, k }, r))));
        rs.every((r) => r.ok) ? pass++ : fail++;
      } else {
        const out = path.join(PROF, `_loop_one.jsonl`);
        const j = await oneReplay(rec, out, i, tag);
        console.log(JSON.stringify(Object.assign({ i }, j)));
        j.ok ? pass++ : fail++;
      }
    } catch (e) {
      fail++;
      console.log(JSON.stringify({ i, ok: false, error: String((e && e.stack) || e).slice(0, 1500) }));
    }
  }
  console.log(JSON.stringify({ done: new Date().toISOString(), iters: ITERS, pass, fail }));
})().catch((e) => {
  console.error('FAILED:', (e && e.stack) || e);
  process.exitCode = 1;
});
