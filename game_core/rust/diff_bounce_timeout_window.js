#!/usr/bin/env node
// v166/v171 / ABI v11 回归 ②：`Projectile.done()` 第三支 = **反弹去抖上限**
// 「最近 35ms 窗口内累计 ≥5 次撞墙/撞盾接触就当卡住、直接销毁」，
// **不是**「总共反弹 5 次消失」。三处同改：JS track / JS 融合 / Rust。
//
// 游戏依据（【代码原文】真 bundle `418577fd210ad079ea3d1e5e04050fe0.js`）：
//   Projectile.update: var currentTimeout = new Date().getTime() - this.timeoutWindow;
//                      for (i=0;i<this.bounces.length;++i) {
//                          if (this.bounces[i] >= currentTimeout) { this.bounces.splice(0,i); break; } }
//   hitMaze/hitShield: this.bounces.push(new Date().getTime());
//   done:              timeAlive>=lifetime || stopped || bounces.length>=timeoutBounceCount;
//   HomingMissile.update 里**自己复制了一份剪枝循环**（它不走基类 update）。
// Constants: PROJECTILE_BOUNCE_TIMEOUT_WINDOW=35(毫秒) / PROJECTILE_BOUNCE_TIMEOUT_COUNT=5
//
// 实测定性（`docs/Vantage躲弹实现/03-踩坑与待查/实测数据/弹种实测-反弹上限与激光-2026-10-10.md` §二）：
//   · 长走廊 600 帧、**21 次**撞墙，`bounces.length` 最大只有 **1**，弹活满 10.0s ⇒ 正常飞行永不触发；
//   · 把弹种在两面墙内角（每帧 2 次接触）→ 3 帧内 6 次 ⇒ **第 3 帧销毁**；
//   · 剪枝**粘性**：只在找到一条 35ms 内的记录时才删前缀，全过期时一条都不删
//     （单条记录实测撑到 467ms）。
// ⛔ 任何「总共弹 5 次消失」的写法都会让长走廊的弹被提前判死，与游戏不一致。
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./_diff_proj_semantics_harness.js');

const root = path.resolve(__dirname, '..');
const sb = fs.readFileSync(path.join(root, 'js', 'vantage_sandbox.js'), 'utf8');
const rolloutSrc = fs.readFileSync(path.join(root, 'rust', 'vantage_core', 'src', 'rollout.rs'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'js', '418577fd210ad079ea3d1e5e04050fe0.js'), 'utf8');
const constBundle = fs.readFileSync(path.join(root, 'js', 'b714588dc4621fe104113111ba90b1a7.js'), 'utf8');

let failures = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { console.log('  ✗ ' + msg); failures++; }
}

console.log('== ② 反弹去抖上限：静态依据 ==');
// 1) 游戏原文
ok(bundle.indexOf('var currentTimeout=new Date().getTime()-this.timeoutWindow;') >= 0,
  '真 bundle：Projectile.update 用 new Date().getTime() 剪枝 ⇒ 单位是**毫秒**');
ok(bundle.indexOf('this.bounces.splice(0,i);break;') >= 0,
  '真 bundle：剪枝是「找到第一条窗口内记录才 splice(0,i) 并 break」= **粘性**剪枝');
ok(/done:function\(\)\{return this\.timeAlive>=this\.lifetime\|\|this\.stopped\|\|this\.bounces\.length>=this\.timeoutBounceCount;\}/.test(bundle),
  '真 bundle：done() 第三支 = bounces.length >= timeoutBounceCount');
ok((bundle.split('var currentTimeout=new Date().getTime()-this.timeoutWindow;').length - 1) >= 2,
  'HomingMissile.update 里复制了同一段剪枝循环（≥2 处出现）');
ok(/PROJECTILE_BOUNCE_TIMEOUT_WINDOW:35,PROJECTILE_BOUNCE_TIMEOUT_COUNT:5/.test(constBundle),
  'Constants：WINDOW=35 / COUNT=5');

// 2) JS 侧（track + 融合）
ok(sb.indexOf('function pruneBounceStamps(stamps, nowSec, windowSec)') >= 0 &&
   sb.indexOf('stamps.splice(0, i);') >= 0 && sb.indexOf('break;', sb.indexOf('stamps.splice(0, i);')) > 0,
  'JS：pruneBounceStamps 逐字照抄粘性剪枝');
ok(sb.indexOf('Constants.PROJECTILE_BOUNCE_TIMEOUT_WINDOW !== undefined') >= 0 &&
   sb.indexOf('ms / 1000;   // 原版用 new Date().getTime()（毫秒）') >= 0,
  'JS：窗口常量读游戏 Constants 并毫秒→秒');
ok((sb.split('pruneBounceStamps(').length - 1) >= 3 && (sb.split('bounceTimeoutCount()').length - 1) >= 3,
  'JS：track 与融合两条路径都做了「剪枝 + ≥5」（≥3 次出现含定义/两处调用）');
ok(sb.indexOf('if (!bs.isShrapnel) {') >= 0 && sb.indexOf('if (hsB.isShrapnel) continue;   // 破片 hitMaze 不调 super') >= 0,
  'JS：破片不 push、不吃 ②（Shrapnel.hitMaze 完全覆盖不调 super）');
ok(sb.indexOf('不是“总共弹 5 次”') >= 0 || sb.indexOf('不是"总共弹 5 次"') >= 0 || sb.indexOf('绝不许写成“总共反弹 5 次消失”') >= 0,
  'JS：注释里明确写了「不是总共弹 5 次」这条禁令');

// 3) Rust 侧
ok(rolloutSrc.indexOf('BOUNCE_TIMEOUT_WINDOW_SEC: f64 = 0.035') >= 0 &&
   rolloutSrc.indexOf('BOUNCE_TIMEOUT_COUNT: usize = 5') >= 0,
  'Rust：窗口 35ms→0.035s / 次数 5');
ok(rolloutSrc.indexOf('fn prune_bounce_stamps(stamps: &mut Vec<f64>, now_sec: f64, window_sec: f64)') >= 0 &&
   rolloutSrc.indexOf('stamps.drain(0..i);') >= 0,
  'Rust：prune_bounce_stamps 与 JS 同口径（drain(0..i) = splice(0,i)）');
ok(rolloutSrc.indexOf('prune_bounce_stamps(&mut slot.bounces, bounce_now, BOUNCE_TIMEOUT_WINDOW_SEC)') >= 0 &&
   rolloutSrc.indexOf('if slot.bounces.len() >= BOUNCE_TIMEOUT_COUNT') >= 0,
  'Rust：逐弹 update 里先剪枝、再判 ≥5（顺序同原版）');
ok(rolloutSrc.indexOf('for _ in 0..hit_this_frame[si] {') >= 0 &&
   rolloutSrc.indexOf('slots[si].bounces.push(bounce_now);') >= 0,
  'Rust：同一帧每个 touching 接触各 push 一条时间戳');
ok(rolloutSrc.indexOf('if !slot.is_shrapnel {') >= 0,
  'Rust：破片不吃 ②（Shrapnel.hitMaze 不调 super ⇒ 永不 push）');

// ---------------------------------------------------------------------------
// 数值对拍
// ---------------------------------------------------------------------------
function scene1000(name, bullet, tank, patchConstants, maze, dt, frames) {
  return { name, bullet, tank, patchConstants, maze, dt: dt || 1 / 60, frames: frames || 75 };
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

  // JS track（第三条链）也走同一套语义：观察子弹轨迹长度
  const track = adapter.simulateBulletTracks(scene.frames, [scene.bullet.id]);

  VB.setRustPhysicsEnabled(false);
  const js = adapter.simulateTankBatch(pose, ops, scene.frames, opt);
  const bridge = await H.initRust(S);
  VB.setRustPhysicsEnabled(true);
  const rust = adapter.simulateTankBatch(pose, ops, scene.frames, opt);
  const trackFrames = (track && track.length && track[0].frames) ? track[0].frames.length : -1;
  return { js, rust, bridge, trackFrames };
}

(async function main() {
  console.log('== ② 反弹去抖上限：数值对拍（JS 融合 vs wasm Rust，容差 1e-9）==');

  // (A) 内角夹死：每帧 2 次接触 → 帧1=2 / 帧2=4 / 帧3=6 ≥5 ⇒ 第 3 帧销毁
  const cornerA = scene1000('corner', {
    id: 'c1', x: 0.45, y: 0.45, vx: 0, vy: 3, radius: 0.25, lifetime: 10,
  }, { x: 2.0, y: 4.0, rot: 0 }, null, () => H.makeMaze(4, 4));
  const A = await run(cornerA);
  ok(A.bridge.version() === 12, 'wasm ABI = v12（实际 ' + A.bridge.version() + '）');
  ok(A.js.every((r) => !r.dead) && A.rust.every((r) => !r.dead),
    '弹被夹在内角（2 次接触/帧）第 3 帧销毁 ⇒ 59 帧外的坦克**活**（JS/Rust 一致）');
  ok(A.trackFrames > 0 && A.trackFrames <= 8,
    'JS track 链同上：轨迹只到第 ' + String(A.trackFrames - 1) + ' 帧就断供（≤8 帧）');
  const cmpA = H.compareBatches('corner jam', A.js, A.rust);
  ok(cmpA.ok, 'JS↔Rust 逐帧一致：maxPos=' + cmpA.maxPos + '（≤1e-9）');

  // (A2) 反事实：关掉上限（只改 JS Constants）→ 弹不销毁 → 坦克该在第 24 帧被打死
  const A2 = await run(scene1000('corner-count99', {
    id: 'c2', x: 0.45, y: 0.45, vx: 0, vy: 3, radius: 0.25, lifetime: 10,
  }, { x: 2.0, y: 4.0, rot: 0 }, (C) => { C.PROJECTILE_BOUNCE_TIMEOUT_COUNT = 99; }, () => H.makeMaze(4, 4)));
  ok(A2.js.every((r) => r.dead) && A2.js[0].deathFrame === 24,
    '把 COUNT 改成 99 后 JS 在第 ' + A2.js[0].deathFrame + ' 帧被打死 ⇒ (A) 的"活"确实来自 ≥5 规则');

  // (B) 贴墙滑行：1 次接触/帧、连续几十帧 → 稳态只有最近 3 条 ⇒ **永不触发**；
  //     任何「不剪枝/按总接触数」的实现都会在第 5 帧把弹杀掉（坦克就会活）。
  const slide = scene1000('wall-slide', {
    id: 'w1', x: 0.45, y: 5, vx: 0, vy: 18, radius: 0.25, lifetime: 10,
  }, { x: 2.0, y: 25, rot: 0 }, null, () => H.makeMaze(3, 4));
  const Bd = await run(slide);
  ok(Bd.js.every((r) => r.dead) && Bd.rust.every((r) => r.dead) &&
     Bd.js[0].deathFrame === 60 && Bd.rust[0].deathFrame === 60,
    '贴墙滑行 60 帧后仍打死坦克（第 ' + Bd.js[0].deathFrame + ' 帧）⇒ 1 次/帧**不累积**（不是"总接触数"）');
  ok(Bd.trackFrames >= Bd.js[0].deathFrame,
    'JS track 链：轨迹活满 ' + Bd.trackFrames + ' 帧（≥ 死亡帧），弹没有被误杀');
  const cmpBd = H.compareBatches('wall slide', Bd.js, Bd.rust);
  ok(cmpBd.ok, 'JS↔Rust 逐帧一致：maxPos=' + cmpBd.maxPos);

  // (C) 帧长敏感性（信息项 + JS/Rust 必须同步这条）：
  //     35ms 是**时间**窗口，不是"5 帧"。dt=0.02s（未校准的默认）时，
  //     2 次/帧的夹死场景在 3 帧内够不到 5（粘性剪枝留下 3 条）。
  const Cd = await run(scene1000('corner-dt0.02', {
    id: 'c3', x: 0.45, y: 0.45, vx: 0, vy: 3, radius: 0.25, lifetime: 10,
  }, { x: 2.0, y: 4.0, rot: 0 }, null, () => H.makeMaze(4, 4), 0.02));
  console.log('  · 信息：dt=0.02 时内角场景 JS dead=' + Cd.js[0].dead + '（第 ' + Cd.js[0].deathFrame +
    ' 帧）、track 帧数=' + Cd.trackFrames + ' —— 35ms≈1.75 帧 < 2 帧，累积不够');
  const cmpC = H.compareBatches('corner dt=0.02', Cd.js, Cd.rust);
  ok(cmpC.ok, '任何帧长下 JS↔Rust 都必须逐帧一致：dt=0.02 maxPos=' + cmpC.maxPos);

  console.log('  · 存量对照：实测长走廊 600 帧 21 次撞墙时 bounces.length 最大=1 ⇒ 本条规则永不触发。');
  console.log(failures === 0
    ? 'diff_bounce_timeout_window PASS（② 35ms 内 ≥5 去抖上限：JS track/融合 + Rust 三处同改；无「总共 5 次」实现）'
    : 'diff_bounce_timeout_window FAIL (' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('diff_bounce_timeout_window error:', e); process.exit(1); });
