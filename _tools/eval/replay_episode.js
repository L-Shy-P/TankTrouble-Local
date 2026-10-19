#!/usr/bin/env node
/**
 * 回放器（父代理 2026-10-19）：读 `S30_COMPACT=1` 产出的 `replay.jsonl`，重跑游戏复现那一局。
 *
 * 原理：本游戏是确定性的 —— 同一个 `mazeSeed` + 同一串 `rngSeq` ⟹ 同地图、同物理。
 *   所以只需 `{scene, mazeSeed, rngSeqLen, acts:[[nodeId,fire],...]}` 就能完整复现，
 *   无需存几百帧完整观测（每局 ~9MB → 几 KB）。
 *
 * 用法：
 *   node _tools/eval/replay_episode.js --replay D:/vt_run/A2/replay.jsonl --index 0 [--visible 1]
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
process.chdir(ROOT);
const { Match } = require(path.join(ROOT, '_tools/headless/match.js'));
const { lcgSeq } = require(path.join(ROOT, '_tools/eval/run_scenes_30.js')) || {};

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const LCG = (seed, n) => {           // 与 run_scenes_30.js 的 rngSeq 同口径
  let s = seed >>> 0; const out = new Array(n);
  for (let i = 0; i < n; i++) { s = (1664525 * s + 1013904223) >>> 0; out[i] = s; }
  return out;
};
(async () => {
  const file = arg('replay');
  const idx = Number(arg('index', 0));
  const visible = arg('visible', '0') === '1';
  const recs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const r = recs[idx];
  if (!r) throw new Error('没有第 ' + idx + ' 条回放记录（共 ' + recs.length + ' 条）');
  const m = new Match();
  const openOpts = { humanIds: [], players: r.players, storm: !!r.storm, crates: r.crates,
                     control: false, epoch: r.epoch };
  if (r.rngSeqLen > 0) openOpts.rngSeq = LCG(r.mazeSeed, r.rngSeqLen);
  if (visible) openOpts.headless = false;
  await m.open(openOpts);
  const SRC = fs.readFileSync(path.join(ROOT, '_tools/headless/_g1_inject.js'), 'utf8');
  await m.eval(SRC); await m.eval('window.__g1.subscribe()'); await m.eval('window.__g1.setup()');
  await m.pump(25, { yieldMs: 0 });
  let nodeId = 0;
  for (let f = 0; f < r.acts.length; f++) {
    const [nid, fire] = r.acts[f];
    await m.eval('window.__g1.step(' + (nid >= 0 ? nid : 0) + ')');
    await m.eval('window.__g1.setFire(' + (fire ? 1 : 0) + ')');
    await m.pump(1, { yieldMs: 0 });
    if (nid >= 0) nodeId = nid;
  }
  console.log('REPLAY_DONE scene=%s frames=%d win=%s result=%s', r.scene, r.acts.length, r.win, r.result);
  await m.close();
})().catch((e) => { console.log('FATAL ' + ((e && e.stack) || e)); process.exit(1); });
