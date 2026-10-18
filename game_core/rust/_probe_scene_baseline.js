#!/usr/bin/env node
'use strict';
const H = require('./_diff_proj_semantics_harness.js');
const S = H.loadSandbox();
const C = S.Constants, Box2D = S.Box2D, VS = S.VantageSandbox;

function run(name, maze, tankPose, projOpts, frames) {
  const tank = H.makeFakeTank(Box2D, tankPose.x, tankPose.y, tankPose.rot);
  const pr = H.makeFakeProjectile(Box2D, C, projOpts);
  const gc = H.makeGameController(maze, tank, { p1: pr });
  const adapter = VS.createAdapter(gc, 'p0');
  const ops = [H.staticOp()];
  const opt = { startPose: { x: tankPose.x, y: tankPose.y, rot: tankPose.rot }, threats: [], tGlobal: 0 };
  const t0 = Date.now();
  const batch = adapter.simulateTankBatchJsFused({ x: tankPose.x, y: tankPose.y, rot: tankPose.rot }, ops, frames, opt);
  const ms = Date.now() - t0;
  console.log(JSON.stringify({ name, dead: batch[0].dead, deathFrame: batch[0].deathFrame, samples: batch[0].samples.length, ms }));
  return { batch, adapter, gc, pr };
}

// 场景1：霰弹撞墙减命。霰弹从 (10,1) 向下 3m/s；撞底墙后回弹向上；坦克在 (10,7)。
const maze1 = H.makeMaze(4, 3);
run('shotgun: SHOTGUN (10,1) v=(0,-3) tank(10,7) 75f', maze1, { x: 10, y: 7, rot: 0 },
  { id: 'sg1', x: 10, y: 1.0, vx: 0, vy: -3, radius: 0.1, type: C.WEAPON_TYPES.SHOTGUN, lifetime: 2.0 }, 75);
run('control: BULLET  (10,1) v=(0,-3) tank(10,7) 75f', maze1, { x: 10, y: 7, rot: 0 },
  { id: 'b1', x: 10, y: 1.0, vx: 0, vy: -3, radius: 0.25, type: C.WEAPON_TYPES.BULLET, lifetime: 10 }, 75);

// 场景2：内角卡住（2 接触/帧）。dt=1/60 才会在第 3 帧到 5 次。
VS.setFrameDtSec(1 / 60);
const maze2 = H.makeMaze(4, 3);
run('corner: BULLET seed(0.45,0.45) v=(0,3) tank(2.0,3.2) 75f', maze2, { x: 2.0, y: 3.2, rot: 0 },
  { id: 'c1', x: 0.45, y: 0.45, vx: 0, vy: 3, radius: 0.25, type: C.WEAPON_TYPES.BULLET, lifetime: 10 }, 75);
run('corner-control: seed(0.7,0.7) v=(0,3) tank(2.0,3.2) 75f', maze2, { x: 2.0, y: 3.2, rot: 0 },
  { id: 'c2', x: 0.7, y: 0.7, vx: 0, vy: 3, radius: 0.25, type: C.WEAPON_TYPES.BULLET, lifetime: 10 }, 75);
