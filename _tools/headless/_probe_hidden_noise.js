'use strict';
/* 探针：抓「只差 hidden 哨兵」的失败，并逐字段定位到底是哪个字段不同（拆分前的对照证据）。
 * 判定口径与 _reg_1200x20.js 相同：recordEpisode → replayEpisode → compareFrames。
 * 只在 hiddenMismatch>0 且其它计数全 0 时留存证据（prof/detfix/hsnoise_*）。
 *   node _tools/headless/_probe_hidden_noise.js --runs 40 --frames 1200
 */
const fs = require('fs'), path = require('path');
const { Match } = require('./match');
const { recordEpisode, replayEpisode, readRecording, compareFrames } = require('./record');

const argv = process.argv.slice(2);
const num = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : Number(argv[i + 1]); };
const RUNS = num('runs', 40), FRAMES = num('frames', 1200);
const DIR = path.join(__dirname, 'prof', 'detfix');

function hsKeys(frame) { return Object.keys((frame && frame.hs) || {}); }
function diffFrame(a, b) {
  const zones = [{ n: 'hs', a: a.hs, b: b.hs }, { n: 'hx', a: a.hx, b: b.hx }];
  const out = [];
  for (const z of zones) {
    const keys = Array.from(new Set(Object.keys(z.a || {}).concat(Object.keys(z.b || {}))));
    for (const k of keys) {
      const va = JSON.stringify(z.a ? z.a[k] : undefined);
      const vb = JSON.stringify(z.b ? z.b[k] : undefined);
      if (va !== vb) out.push({ zone: z.n, k, A: String(va).slice(0, 240), B: String(vb).slice(0, 240) });
    }
  }
  return out;
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  let pass = 0, fail = 0, hiddenOnly = 0, obsOnly = 0;
  const t0 = Date.now();
  for (let i = 1; i <= RUNS; i++) {
    const f = path.join(DIR, `hsnoise_ep_${i}.jsonl`);
    const f1 = path.join(DIR, `hsnoise_ep_${i}.r1.jsonl`);
    const line = { run: i, ok: false };
    try {
      const m = new Match();
      await recordEpisode(m, { frames: FRAMES, ids: ['tank_a', 'tank_b'], out: f });
      await m.close();
      const r = readRecording(f);
      await replayEpisode(r, { out: f1 });
      const r2 = readRecording(f1);
      const c = compareFrames(r.frames, r2.frames, 'rec vs replay1');
      line.ok = !!c.ok;
      line.hiddenMismatch = c.hiddenMismatch; line.hiddenObsMismatch = c.hiddenObsMismatch; line.opMismatch = c.opMismatch;
      line.poseMismatch = c.poseMismatch; line.projMismatch = c.projMismatch;
      line.rngMismatch = c.rngMismatch; line.stateMismatch = c.stateMismatch;
      line.timeMismatch = c.timeMismatch; line.driveMismatch = c.driveMismatch;
      const others = c.opMismatch + c.poseMismatch + c.projMismatch + c.rngMismatch +
                     c.stateMismatch + c.timeMismatch + c.driveMismatch;
      if (c.ok && others === 0 && c.hiddenMismatch === 0 && c.hiddenObsMismatch > 0) {
        obsOnly++; line.obsOnly = true;
        const N = Math.min(r.frames.length, r2.frames.length);
        const first = [], perKey = {};
        for (let k = 0; k < N; k++) {
          const d = diffFrame(r.frames[k], r2.frames[k]);
          if (!d.length) continue;
          for (const x of d) {
            const key = x.zone + '.' + x.k;
            perKey[key] = (perKey[key] || 0) + 1;
            if (first.length < 6) first.push(Object.assign({ f: k }, x));
          }
          if (first.length >= 6) break;
        }
        line.firstDiffs = first; line.perKeyFrames = perKey;
        try { fs.copyFileSync(f, path.join(DIR, `hsobs_KEEP_${i}_rec.jsonl`)); } catch (e) {}
        try { fs.copyFileSync(f1, path.join(DIR, `hsobs_KEEP_${i}_rep.jsonl`)); } catch (e) {}
      }
      if (!c.ok && c.hiddenMismatch > 0 && others === 0) {
        hiddenOnly++;
        const N = Math.min(r.frames.length, r2.frames.length);
        const first = [], perKey = {};
        for (let k = 0; k < N; k++) {
          const d = diffFrame(r.frames[k], r2.frames[k]);
          if (!d.length) continue;
          for (const x of d) {
            perKey[x.k] = (perKey[x.k] || 0) + 1;
            if (first.length < 6) first.push(Object.assign({ f: k }, x));
          }
          if (first.length >= 6) break;
        }
        line.firstDiffs = first;
        line.perKeyFrames = perKey;
        try { fs.copyFileSync(f, path.join(DIR, `hsnoise_KEEP_${i}_rec.jsonl`)); } catch (e) {}
        try { fs.copyFileSync(f1, path.join(DIR, `hsnoise_KEEP_${i}_rep.jsonl`)); } catch (e) {}
      }
    } catch (e) { line.err = String((e && e.message) || e).slice(0, 220); }
    if (line.ok) pass++; else fail++;
    console.log(JSON.stringify(line));
    try { if (!line.firstDiffs) { fs.rmSync(f, { force: true }); fs.rmSync(f1, { force: true }); } } catch (e) {}
  }
  console.log(JSON.stringify({ done: true, runs: RUNS, frames: FRAMES, pass, fail, hiddenOnly, obsOnly, wallMs: Date.now() - t0 }));
})().catch((e) => { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; });
