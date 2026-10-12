'use strict';
/* 铁律 1 的验收：20 次【独立新录 → 回放】，每次 1200 帧。
 * 判定 = 回放#1 与原始录制逐帧完全相同（compareFrames.ok）。
 * 用法: node _tools/headless/_reg_1200x20.js [--runs=20] [--frames=1200] [--dir=/tmp/reg1200]
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { Match } = require('./match');
const { recordEpisode, replayEpisode, readRecording, compareFrames } = require('./record');

const argv = process.argv.slice(2);
const num = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : Number(argv[i + 1]); };
const str = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const RUNS = num('runs', 20), FRAMES = num('frames', 1200);
const DIR = str('dir', path.join(os.tmpdir(), 'vt_reg1200'));

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  let pass = 0, fail = 0;
  const t0 = Date.now();
  for (let i = 1; i <= RUNS; i++) {
    const f = path.join(DIR, 'ep' + i + '.jsonl');
    const f1 = path.join(DIR, 'ep' + i + '.r1.jsonl');
    let line = { run: i, ok: false };
    try {
      const m = new Match();
      const rec = await recordEpisode(m, { frames: FRAMES, ids: ['tank_a', 'tank_b'], out: f });
      await m.close();
      line.rec = { frames: rec.frames, chunks: rec.chunks, drive: rec.drive && rec.drive.errs, rng: rec.rng && rec.rng.overflow };
      line.replayFrames = 0;
      const r = readRecording(f);
      await replayEpisode(r, { out: f1 });
      const r2 = readRecording(f1);
      const c = compareFrames(r.frames, r2.frames, 'rec vs replay1');
      line.ok = !!c.ok && (!rec.rng || !rec.rng.overflow) && !(rec.drive && rec.drive.errs);
      line.frames = c.framesA + '/' + c.framesB;
      line.opMismatch = c.opMismatch; line.poseMismatch = c.poseMismatch;
      line.projMismatch = c.projMismatch; line.timeMismatch = c.timeMismatch;
      line.hiddenMismatch = c.hiddenMismatch; line.driveMismatch = c.driveMismatch;
      line.rngMismatch = c.rngMismatch; line.stateMismatch = c.stateMismatch;
      line.maxPoseDiff = c.maxPoseDiff;
      if (c.examples && c.examples.length) line.ex = c.examples.slice(0, 2);
    } catch (e) {
      line.err = String((e && e.message) || e).slice(0, 220);
    }
    if (line.ok) pass++; else fail++;
    console.log(JSON.stringify(line));
    try { fs.rmSync(f, { force: true }); fs.rmSync(f1, { force: true }); } catch (e) {}
  }
  console.log(JSON.stringify({ done: true, pass: pass, fail: fail, frames: FRAMES, runs: RUNS, wallMs: Date.now() - t0 }));
  process.exitCode = fail ? 1 : 0;
})();
