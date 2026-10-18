#!/usr/bin/env node
'use strict';
const H = require('./_diff_proj_semantics_harness.js');
(async () => {
  const S = H.loadSandbox();
  const C = S.Constants, Box2D = S.Box2D, VS = S.VantageSandbox;
  await H.initRust(S, 'js/wasm/vantage_core.wasm');
  VS.setRustPhysicsEnabled(true);

  function run(name, maze, tankPose, projOpts, frames, dt) {
    if (dt) VS.setFrameDtSec(dt);
    const tank = H.makeFakeTank(Box2D, tankPose.x, tankPose.y, tankPose.rot);
    const pr = H.makeFakeProjectile(Box2D, C, projOpts);
    const gc = H.makeGameController(maze, tank, { p1: pr });
    const adapter = VS.createAdapter(gc, 'p0');
    const ops = [H.staticOp()];
    const opt = { startPose: { x: tankPose.x, y: tankPose.y, rot: tankPose.rot }, threats: [], tGlobal: 0 };
    const js = adapter.simulateTankBatchJsFused({ x: tankPose.x, y: tankPose.y, rot: tankPose.rot }, ops, frames, opt);
    const rust = adapter.simulateTankBatch({ x: tankPose.x, y: tankPose.y, rot: tankPose.rot }, ops, frames, opt);
    const usedRust = !!(rust[0] && rust[0].rustPhysics);
    const cmp = H.compareBatches(name, js, rust);
    console.log(JSON.stringify({ name, usedRust, jsDead: js[0].dead, jsDF: js[0].deathFrame, rustDead: rust[0].dead, rustDF: rust[0].deathFrame, maxPos: cmp.maxPos, maxAng: cmp.maxAng }));
  }
  const maze1 = H.makeMaze(4, 3);
  run('shotgun-baseline', maze1, { x: 10, y: 7, rot: 0 },
    { id: 'sg1', x: 10, y: 1.0, vx: 0, vy: -3, radius: 0.1, type: C.WEAPON_TYPES.SHOTGUN, lifetime: 2.0 }, 75);
  VS.setFrameDtSec(1 / 60);
  const maze2 = H.makeMaze(4, 3);
  run('corner-baseline', maze2, { x: 2.0, y: 3.2, rot: 0 },
    { id: 'c1', x: 0.45, y: 0.45, vx: 0, vy: 3, radius: 0.25, type: C.WEAPON_TYPES.BULLET, lifetime: 10 }, 75);
  run('corner-control', maze2, { x: 2.0, y: 3.2, rot: 0 },
    { id: 'c2', x: 0.7, y: 0.7, vx: 0, vy: 3, radius: 0.25, type: C.WEAPON_TYPES.BULLET, lifetime: 10 }, 75);
})().catch((e) => { console.error('PROBE FAIL', e && e.stack || e); process.exit(1); });
