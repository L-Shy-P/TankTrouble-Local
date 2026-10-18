#!/usr/bin/env node
// v166 / ABI v10 回归 ①：霰弹撞墙/撞盾**减命**（剩余寿命 ≤ 0.7s）——三处同改的对拍。
//
// 游戏依据（【代码原文】真 bundle `418577fd210ad079ea3d1e5e04050fe0.js`）：
//   Shotgun.methods({ hitShield: function () { this._super();
//       this.timeAlive = Math.max(this.timeAlive, MAX - AFTER); },
//     hitMaze: function () { this._super(); this.timeAlive = Math.max(this.timeAlive, MAX - AFTER); } });
//   MAX = Constants.SHOTGUN_MAX_LIFETIME = 2.0，AFTER = SHOTGUN_LIFETIME_AFTER_MAZE_HIT = 0.7
//   （建弹：`46989e…js` `Shotgun.create(projectileState, Constants.SHOTGUN_MAX_LIFETIME, 35, 5, …)`）
// ⟹ **撞墙是减命，不是续命**（AGENTS.md「第十轮第十轮复盘」第 2 条更正；方向反了就是平衡性事故）。
//
// 三处同改：JS track（`simulateBulletTracks`）/ JS 融合（`simulateFusedBatch`）/ Rust（`rollout.rs`）。
// 数值口径：JS 融合批次 vs wasm Rust 批次，容差 1e-9（同 `diff_rollout_bridge.js` 的官方口径）。
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./_diff_proj_semantics_harness.js');

const root = path.resolve(__dirname, '..');
const sb = fs.readFileSync(path.join(root, 'js', 'vantage_sandbox.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(root, 'js', 'vantage_rust_bridge.js'), 'utf8');
const libSrc = fs.readFileSync(path.join(root, 'rust', 'vantage_core', 'src', 'lib.rs'), 'utf8');
const rolloutSrc = fs.readFileSync(path.join(root, 'rust', 'vantage_core', 'src', 'rollout.rs'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'js', '418577fd210ad079ea3d1e5e04050fe0.js'), 'utf8');
const constBundle = fs.readFileSync(path.join(root, 'js', 'b714588dc4621fe104113111ba90b1a7.js'), 'utf8');
// 建弹在 RoundModel 那份 bundle（`46989e…js`）。
const roundBundle = fs.readFileSync(path.join(root, 'js', '46989e393ad0e356ac8a0c6c53b362f9.js'), 'utf8');

let failures = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { console.log('  ✗ ' + msg); failures++; }
}

console.log('== ① 霰弹撞墙减命：静态依据 ==');
// 1) 游戏原文（不可改的依据）
ok(bundle.indexOf('SHOTGUN_MAX_LIFETIME-Constants.SHOTGUN_LIFETIME_AFTER_MAZE_HIT') >= 0,
  '真 bundle 里 Shotgun.hitMaze/hitShield 确实是 timeAlive=max(timeAlive, MAX-AFTER)');
ok(/SHOTGUN_LIFETIME_AFTER_MAZE_HIT:0\.7/.test(constBundle) && /SHOTGUN_MAX_LIFETIME:2\.0/.test(constBundle),
  'Constants：SHOTGUN_MAX_LIFETIME=2.0 / SHOTGUN_LIFETIME_AFTER_MAZE_HIT=0.7');
ok(roundBundle.indexOf('Shotgun.create(projectileState,Constants.SHOTGUN_MAX_LIFETIME,Constants.PROJECTILE_BOUNCE_TIMEOUT_WINDOW') >= 0,
  '霰弹的 lifetime 就是 SHOTGUN_MAX_LIFETIME（⇒ JS 原式可化简为 min(lifeLeft,AFTER)）');

// 2) JS 两处（track + 融合）都要用同一个公式
ok((sb.split('clampShotgunLifeLeftAfterHit').length - 1) >= 3,
  'JS：函数定义 + track/融合两处调用（共 ≥3 次出现）');
ok(sb.indexOf('var clampedAge = Math.max(ageNow, maxL - after);') >= 0 &&
   sb.indexOf('return Math.max(0, lifeTotal - clampedAge);') >= 0,
  'JS 公式 = lifeTotal − max(lifeTotal−lifeLeft, MAX−AFTER)（逐字对齐原版）');
ok((sb.split('if (s.isShotgun)').length - 1) >= 1 && (sb.split('if (hsB.isShotgun)').length - 1) >= 1,
  'JS：track 与融合两条路径**都**在命中帧调用钳制');
ok((sb.split('isShotgun: !!slot.isShotgun').length - 1) === 2,
  'JS：两个 Rust ABI 入口（simulateRustBatch / simulateTankBatchScored）都透传 isShotgun');

// 3) Rust 侧
ok(rolloutSrc.indexOf('SHOTGUN_LIFETIME_AFTER_MAZE_HIT_SEC: f64 = 0.7') >= 0,
  'Rust：SHOTGUN_LIFETIME_AFTER_MAZE_HIT_SEC = 0.7');
ok(rolloutSrc.indexOf('fn clamp_shotgun_life_left_after_hit') >= 0 &&
   rolloutSrc.indexOf('life_left.max(0.0).min(SHOTGUN_LIFETIME_AFTER_MAZE_HIT_SEC)') >= 0,
  'Rust：同一公式的化简式 min(lifeLeft, 0.7)（霰弹 lifeTotal≡MAX，代数等价）');
ok(rolloutSrc.indexOf('if slots[si].is_shotgun {') >= 0,
  'Rust：接触帧才钳（不是无条件钳 —— 无条件钳 = 霰弹永远活不过 0.7s，方向反了）');

// 4) ABI v11 弹种码 0/1/2/3
ok(bridgeSrc.indexOf("bulletIsShrapnel[i] = b.isLaser ? 3 : (b.isShotgun ? 2 : (b.isShrapnel ? 1 : 0));") >= 0,
  'JS bridge：弹种码 2=霰弹（旧 JS 只发 0/1，向后兼容）');
ok(libSrc.indexOf('is_shotgun: bullet_is_shrapnel_slice[i] == 2') >= 0 &&
   libSrc.indexOf('is_shrapnel: bullet_is_shrapnel_slice[i] == 1') >= 0,
  'Rust ABI：按码**精确**判定（不能写 `!= 0`，否则 2 会被当成破片）');

// ---------------------------------------------------------------------------
// 数值对拍：长走廊一发霰弹先撞左墙（帧 1）→ 剩余寿命被钳到 0.7s（=42 帧@1/60），
// 走不到 x=20 的坦克（需 ~60 帧）。
// ---------------------------------------------------------------------------
const W = 5;
const topRow = [];
for (let i = 0; i < W; i++) topRow.push([i, 1]);   // 在 j=1 行加墙 = 走廊下墙

function corridorScene(bulletType, patchConstants) {
  return {
    dt: 1 / 60, frames: 75,
    maze: () => H.makeMaze(W, 4, topRow),
    bullet: { id: 's1', x: 0.8, y: 5, vx: -18, vy: 0, radius: 0.25, lifetime: 2.0, type: bulletType },
    tank: { x: 20, y: 5, rot: 0 },
    patchConstants: patchConstants,
  };
}

async function run(scene) {
  const S = H.loadSandbox();
  const Box2D = S.Box2D, Constants = S.Constants, VB = S.VantageSandbox;
  VB.setFrameDtSec(scene.dt);
  if (scene.patchConstants) scene.patchConstants(Constants);
  const maze = scene.maze();
  const tank = H.makeFakeTank(Box2D, scene.tank.x, scene.tank.y, scene.tank.rot);
  const p = H.makeFakeProjectile(Box2D, Constants, scene.bullet);
  const projs = {}; projs[p.id] = p;
  const gc = H.makeGameController(maze, tank, projs);
  const adapter = VB.createAdapter(gc, 'p0');
  const pose = { x: scene.tank.x, y: scene.tank.y, rot: scene.tank.rot };
  const ops = []; for (let i = 0; i < 9; i++) ops.push(H.staticOp());
  const opt = { startPose: pose, threats: [], tGlobal: 0 };

  VB.setRustPhysicsEnabled(false);
  const js = adapter.simulateTankBatch(pose, ops, scene.frames, opt);
  const bridge = await H.initRust(S);
  VB.setRustPhysicsEnabled(true);
  const rust = adapter.simulateTankBatch(pose, ops, scene.frames, opt);
  const sameWorld = S.VantageSandbox === VB;
  return { js, rust, bridge, sameWorld };
}

(async function main() {
  console.log('== ① 霰弹撞墙减命：数值对拍（JS 融合 vs wasm Rust，容差 1e-9）==');

  // (a) 真配置：霰弹 → 撞墙后 0.7s 到期 → 坦克活
  const a = await run(corridorScene(2 /* SHOTGUN */, null));
  ok(a.bridge.version() === 12, 'wasm ABI = v12（实际 ' + a.bridge.version() + '）');
  const aDead = a.js.map((r) => r.dead), aRustDead = a.rust.map((r) => r.dead);
  ok(aDead.every((d) => d === false) && aRustDead.every((d) => d === false),
    '霰弹撞墙后被钳到 ≤0.7s ⇒ 59 帧外的坦克**活**（JS=' + aDead[0] + ' Rust=' + aRustDead[0] + '）');
  const cmpA = H.compareBatches('shotgun corridor', a.js, a.rust);
  ok(cmpA.ok, 'JS↔Rust 逐帧一致：maxPos=' + cmpA.maxPos + '（≤1e-9）');

  // (b) 反事实①：同场景、同速度、只把弹种换成普通弹（不钳）→ 坦克该死
  const b = await run(corridorScene(-1 /* BULLET */, null));
  ok(b.js.every((r) => r.dead) && b.js[0].deathFrame === 60 && b.rust.every((r) => r.dead) && b.rust[0].deathFrame === 60,
    '同几何的**普通弹**在第 ' + b.js[0].deathFrame + ' 帧打死坦克（JS/Rust 同帧）⇒ 存活差异来自霰弹标记');
  const cmpB = H.compareBatches('plain bullet corridor', b.js, b.rust);
  ok(cmpB.ok, 'JS↔Rust 逐帧一致：maxPos=' + cmpB.maxPos);

  // (c) 反事实②：只改 JS Constants，把 AFTER 设成 2.0（钳制退化为恒等）→ JS 也该死
  const c = await run(corridorScene(2, (C) => { C.SHOTGUN_LIFETIME_AFTER_MAZE_HIT = 2.0; }));
  ok(c.js.every((r) => r.dead) && c.js[0].deathFrame === 60,
    '把 SHOTGUN_LIFETIME_AFTER_MAZE_HIT 改成 2.0（钳制退化）后 JS 也在第 ' + c.js[0].deathFrame +
    ' 帧被打死 ⇒ 上面的"活"确实来自这条钳制');

  // (d) 深穿透出生点：弹一开始就压墙里，也必须在第 1 帧就被钳
  const d = await run({
    dt: 1 / 60, frames: 75,
    maze: () => H.makeMaze(3, 4),
    bullet: { id: 'd1', x: 0.45, y: 5, vx: 0, vy: 18, radius: 0.25, lifetime: 2.0, type: 2 },
    tank: { x: 2.0, y: 25, rot: 0 },
  });
  ok(d.js.every((r) => !r.dead) && d.rust.every((r) => !r.dead),
    '出生即压墙（深穿透）的霰弹同样被钳（JS/Rust 都活）');
  const cmpD = H.compareBatches('deep penetration shotgun', d.js, d.rust);
  ok(cmpD.ok, 'JS↔Rust 逐帧一致：maxPos=' + cmpD.maxPos);

  console.log(failures === 0
    ? 'diff_shotgun_wall_lifetime PASS（① 霰弹撞墙减命：JS track/融合 + Rust + ABI v11 弹种码，三处同改且逐帧一致）'
    : 'diff_shotgun_wall_lifetime FAIL (' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('diff_shotgun_wall_lifetime error:', e); process.exit(1); });
