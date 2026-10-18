#!/usr/bin/env node
// 探针（新建，不动产品代码）：给 ① 霰弹撞墙减命 / ② 反弹去抖上限 选可复现场景，
// 并为两个 diff 对拍验证 JS↔Rust 的可比性。
'use strict';
const H = require('./_diff_proj_semantics_harness.js');

async function runScene(name, scene) {
  const S = H.loadSandbox();
  const Box2D = S.Box2D, Constants = S.Constants, VB = S.VantageSandbox;
  VB.setFrameDtSec(scene.dt);
  if (scene.patchConstants) scene.patchConstants(Constants);
  const maze = scene.maze();
  const tank = H.makeFakeTank(Box2D, scene.tank.x, scene.tank.y, scene.tank.rot);
  const projs = {};
  const p = H.makeFakeProjectile(Box2D, Constants, scene.bullet);
  projs[p.id] = p;
  const gc = H.makeGameController(maze, tank, projs);
  const adapter = VB.createAdapter(gc, 'p0');
  const pose = { x: scene.tank.x, y: scene.tank.y, rot: scene.tank.rot };
  const ops = [];
  for (let i = 0; i < 9; i++) ops.push(H.staticOp());
  const opt = { startPose: pose, threats: [], tGlobal: 0 };

  VB.setRustPhysicsEnabled(false);
  const js = adapter.simulateTankBatch(pose, ops, scene.frames, opt);

  const bridge = await H.initRust(S);
  if (!global.__vtWrapped) {
    global.__vtWrapped = true;
    const orig = bridge.rolloutBatch;
    bridge.rolloutBatch = function (input) {
      console.log('  [bridge] abiVersion=' + bridge.version() + ' bulletCount=' + (input.bullets || []).length +
        ' b0=' + JSON.stringify((input.bullets || [])[0]));
      return orig.apply(bridge, arguments);
    };
  }
  VB.setRustPhysicsEnabled(true);
  const rust = adapter.simulateTankBatch(pose, ops, scene.frames, opt);

  const jsDead = js.map((r) => r.dead), rustDead = rust.map((r) => r.dead);
  const jsDf = js.map((r) => r.deathFrame), rustDf = rust.map((r) => r.deathFrame);
  console.log('=== ' + name + ' ===');
  console.log('  JS   dead=' + JSON.stringify(jsDead.slice(0, 3)) + ' df=' + JSON.stringify(jsDf.slice(0, 3)));
  console.log('  Rust dead=' + JSON.stringify(rustDead.slice(0, 3)) + ' df=' + JSON.stringify(rustDf.slice(0, 3)));
  for (const opi of [0, 1]) {
    console.log('   op' + opi + ' JS  f0..f3 ' + [0, 1, 2, 3].map((f) => js[opi].samples[f].x.toFixed(9) + ',' + js[opi].samples[f].y.toFixed(9)).join(' | '));
    console.log('   op' + opi + ' Rust f0..f3 ' + [0, 1, 2, 3].map((f) => rust[opi].samples[f].x.toFixed(9) + ',' + rust[opi].samples[f].y.toFixed(9)).join(' | '));
  }
  try {
    const cmp = H.compareBatches(name, js, rust);
    console.log('  JS<->Rust maxPos=' + cmp.maxPos + ' maxAng=' + cmp.maxAng + ' (' + cmp.maxPosAt + ')');
  } catch (e) {
    console.log('  JS<->Rust MISMATCH: ' + e.message);
  }
  return { js, rust };
}

(async function () {
  // A) 内角夹死（实测 §二.4 实验④B 同款种子）：每帧 2 次接触 → 第 3 帧 6>=5 销毁
  await runScene('A corner jam (2/frame)', {
    dt: 1 / 60, frames: 75,
    maze: () => H.makeMaze(4, 4),
    bullet: { id: 'c1', x: 0.45, y: 0.45, vx: 0, vy: 3, radius: 0.25, lifetime: 10 },
    tank: { x: 2.0, y: 4.0, rot: 0 },
  });

  // A2) 反事实：把「35ms 内 ≥5」的上限关掉（只改 JS Constants）→ 弹不销毁 → 坦克该被 24 帧打死
  await runScene('A2 corner jam, count=99 (JS counterfactual only)', {
    dt: 1 / 60, frames: 75,
    maze: () => H.makeMaze(4, 4),
    bullet: { id: 'c2', x: 0.45, y: 0.45, vx: 0, vy: 3, radius: 0.25, lifetime: 10 },
    tank: { x: 2.0, y: 4.0, rot: 0 },
    patchConstants: (C) => { C.PROJECTILE_BOUNCE_TIMEOUT_COUNT = 99; },
  });

  // D) 贴墙滑行（1 次接触/帧，长期不累积）：正确语义下弹活满视界并打死坦克；
  //    任何「总接触数/不剪枝」的实现都会在第 5 帧把弹杀掉 → 坦克存活。
  await runScene('D wall slide 1/frame', {
    dt: 1 / 60, frames: 75,
    maze: () => H.makeMaze(3, 4),
    bullet: { id: 'd2', x: 0.45, y: 5, vx: 0, vy: 18, radius: 0.25, lifetime: 10 },
    tank: { x: 2.0, y: 25, rot: 0 },
  });

  // C) 出生点就压在墙里（深穿透）→ 第 1 帧必然 touching；霰弹应立刻被钳到 0.7s。
  await runScene('C deep penetration shotgun', {
    dt: 1 / 60, frames: 75,
    maze: () => H.makeMaze(3, 4),
    bullet: { id: 'd1', x: 0.45, y: 5, vx: 0, vy: 18, radius: 0.25, lifetime: 2.0, type: 2 },
    tank: { x: 2.0, y: 25, rot: 0 },
  });

  // B) 长走廊：霰弹先在左墙撞一下（帧 1）→ 剩余寿命被钳到 <=0.7s，
  //    0.7s 后（约 42 帧）到期 ⇒ 走不到 x=20 的坦克（需 ~55 帧）。
  const W = 5;
  const topRow = [];
  for (let i = 0; i < W; i++) topRow.push([i, 1]);     // 在 j=1 行加墙 = 走廊下墙
  for (const [nm, patch] of [['shotgun clamp ON ', null], ['shotgun clamp OFF', 2.0]]) {
    await runScene('B corridor shotgun (' + nm.trim() + ')', {
      dt: 1 / 60, frames: 75,
      maze: () => H.makeMaze(W, 4, topRow),
      bullet: { id: 's1', x: 0.8, y: 5, vx: -18, vy: 0, radius: 0.25,
                lifetime: 2.0, type: S_g_W(), age: 0 },
      tank: { x: 20, y: 5, rot: 0 },
      patchConstants: patch ? function (C) { C.SHOTGUN_LIFETIME_AFTER_MAZE_HIT = patch; } : null,
    });
  }
})().catch((e) => { console.error(e); process.exit(1); });
function S_g_W() { return 2; }
