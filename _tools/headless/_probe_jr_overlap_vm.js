#!/usr/bin/env node
'use strict';
/* 小探针：初始即重叠（子弹摆在坦克体内）时 JS 融合 vs Rust 谁判死。
   用途：判断"df=0 的 JS-only 死"是不是代码级差异（而不是摆位退化造成的巧合）。 */
const H = require('../../game_core/rust/_diff_proj_semantics_harness.js');
(async () => {
  const S = H.loadSandbox();
  const C = S.Constants, Box2D = S.Box2D, VS = S.VantageSandbox;
  await H.initRust(S, 'js/wasm/vantage_core.wasm');
  VS.setRustPhysicsEnabled(true);
  VS.setFrameDtSec(1 / 60);
  const OPS = VS.OPERATIONS;
  function run(name, maze, pose, bulletsSpec, frames) {
    const tank = H.makeFakeTank(Box2D, pose.x, pose.y, pose.rot);
    const projs = {};
    bulletsSpec.forEach(function (b, i) { projs['b' + i] = H.makeFakeProjectile(Box2D, C, Object.assign({ id: 'b' + i }, b)); });
    const gc = H.makeGameController(maze, tank, projs);
    const ad = VS.createAdapter(gc, 'ovl');
    const opt = { startPose: pose, threats: [], tGlobal: 0, nowTGlobal: 0, auditPurpose: 'jsConfirm', cfg: { deathPenalty: 0, lanePenaltyRatio: 0 } };
    const js = ad.simulateTankBatchJsFused(pose, OPS, frames, opt);
    const sum = ad.getLastFusedBatchSummary();
    const rust = ad.simulateTankBatchScored(pose, OPS, frames, opt);
    const jdf = js.map(r => r.dead ? r.deathFrame : -1), rdf = rust.map(r => r.dead ? r.deathFrame : -1);
    console.log(JSON.stringify({ name, rustUsed: !!(rust[0] && rust[0].rustPhysics), jdf, rdf,
      geo: sum ? !!sum.geometryFallback : null, contacts: sum && sum.contacts ? sum.contacts.length : null,
      overlapNoContact: sum && sum.overlapNoContact ? sum.overlapNoContact.length : null,
      firstContact: sum && sum.contacts && sum.contacts[0] ? sum.contacts[0] : null }));
  }
  const maze = H.makeMaze(4, 3);
  const pose = { x: 15, y: 15, rot: 0 };
  // ① 子弹正好在坦克中心
  run('bullet-at-tank-center', maze, pose, [{ x: 15, y: 15, vx: 0, vy: 18, radius: 0.25, type: -1, lifetime: 10 }], 75);
  // ② 子弹在坦克体内 0.5m
  run('bullet-inside-0.5m', maze, pose, [{ x: 15.5, y: 15, vx: 0, vy: 18, radius: 0.25, type: -1, lifetime: 10 }], 75);
  // ③ 子弹贴着坦克边缘外 0.2m（不重叠）
  run('bullet-outside-0.2m', maze, pose, [{ x: 15.0, y: 17.25, vx: 0, vy: 18, radius: 0.25, type: -1, lifetime: 10 }], 75);
  // ④ 远处飞来（正常情形）
  run('bullet-far-8m', maze, pose, [{ x: 15, y: 7, vx: 0, vy: 18, radius: 0.25, type: -1, lifetime: 10 }], 75);
  // ⑤ 阶段静止：让坦克停在原地（用静止操作只看 df0）
  run('still-far-8m', maze, pose, [{ x: 15, y: 7, vx: 0, vy: 0, radius: 0.25, type: -1, lifetime: 10 }], 0);
})().catch(e => { console.error('FAIL', e && e.stack || e); process.exit(1); });
