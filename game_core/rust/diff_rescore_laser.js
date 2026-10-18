#!/usr/bin/env node
/* ============================================================================
 * 1-2③ 收尾：Rust rescore 激光路径差分对拍（**修前 FAIL / 修后 PASS**）
 *
 * 走生产路径：真 `vantage_sandbox.js` 的 adapter -> `rescoreTankSamples`
 * -> VantageRustBridge -> `vt_rescore_nodes`（部署 wasm）。
 *
 * 场景：5 个真游戏 golden 激光局面（同一份数据见
 * `_tools/headless/_probe_laser_sweep_counterexample.js`）：
 *   激光一帧跨过坦克 ⇒ JS 融合 dead=true/fd=0（验收探针已证）。
 *   把融合轨迹存成 rescore node、把激光轨迹存成 kind=3/sweep threat，
 *   要求 Rust rescore 同样 dead=true/fd=0，且与 JS scorePaths 参考
 *   的 perFrameScores/totalScore 在 1e-9 内一致。
 *
 * 修前（rescore_nodes 用 `death_frame > 0` 丢掉 fd=0）预期 FAIL；
 * 修后（`>= 0` + JS dead 判 `>= 0`）预期 PASS。
 * 容差 1e-9。本脚本一旦落地不再改（修前/修后同一份）。
 * ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const JS = (p) => path.join(root, p);
const POS_TOL = 1e-9;

const GOLDEN = [
  { name: 'full_edge',       p0: { x: 59.56, y: 15 }, p1: { x: 62.62, y: 15 }, C: { x: 61.09, y: 15 }, rot: 0 },
  { name: 'miss_almostfull', p0: { x: 49.56, y: 25 }, p1: { x: 52.62, y: 25 }, C: { x: 50.89, y: 23.15 }, rot: -0.1745 },
  { name: 'miss_oblique',    p0: { x: 59.56, y: 25 }, p1: { x: 62.62, y: 25 }, C: { x: 60.74, y: 23.25 }, rot: -0.7854 },
  { name: 'miss_corner',     p0: { x: 39.56, y: 15 }, p1: { x: 42.62, y: 15 }, C: { x: 40.69, y: 13 }, rot: -0.8727 },
  { name: 'miss_turret',     p0: { x: 59.56, y: 5 },  p1: { x: 62.62, y: 5 },  C: { x: 61.49, y: 6.9 }, rot: -0.5236 },
];

function loadSandbox() {
  const sandbox = { console: console };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(JS('game_core/js/f1a5ef972c273fb89a098cb50b0f22e7.js'), 'utf8'), ctx,
    { filename: 'box2d.js' });
  const Box2D = sandbox.Box2D;
  if (!Box2D) throw new Error('Box2D not defined');
  function makeClass() {
    const C = {};
    C.classFields = function (o) { for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) C[k] = o[k]; return C; };
    C.classMethods = function (o) { for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) C[k] = o[k]; return C; };
    C.methods = function () { return C; };
    C.fields = function () { return C; };
    C.name = function () { return C; };
    return C;
  }
  sandbox.Classy = { newClass: makeClass };
  const bundleSrc = fs.readFileSync(JS('game_core/js/b714588dc4621fe104113111ba90b1a7.js'), 'utf8');
  const lines = bundleSrc.split(/\r?\n/).filter((l) => /^\s*var mod_pagespeed_/.test(l));
  for (const name of ['mod_pagespeed_QSIkKJ9Ibg', 'mod_pagespeed__SHLt6ORr2']) {
    const line = lines.find((l) => l.indexOf('var ' + name) >= 0);
    if (!line) throw new Error('bundle line not found: ' + name);
    vm.runInContext(line, ctx, { filename: name });
    vm.runInContext(sandbox[name], ctx, { filename: name + '-eval' });
  }
  vm.runInContext(fs.readFileSync(JS('game_core/js/ai_tactics.js'), 'utf8'), ctx, { filename: 'ai_tactics.js' });
  vm.runInContext(fs.readFileSync(JS('game_core/js/vantage_sandbox.js'), 'utf8'), ctx, { filename: 'vantage_sandbox.js' });
  vm.runInContext(fs.readFileSync(JS('game_core/js/vantage_scoring.js'), 'utf8'), ctx, { filename: 'vantage_scoring.js' });
  sandbox._ctx = ctx;
  return sandbox;
}

/* ---------------------------------------------------------------------------
 * 四、最小 fake（只满足 fused 判死路径所需接口）
 * ------------------------------------------------------------------------- */
function makeMaze(W, H) {
  const tiles = [];
  for (let i = 0; i < W; i++) {
    tiles[i] = [];
    for (let j = 0; j < H; j++) tiles[i][j] = [1, j === 0 ? 1 : 0, i === 0 ? 1 : 0];
  }
  return { getTiles: () => tiles };
}
function makeFakeBody(Box2D, x, y, vx, vy, rot) {
  const b2Vec2 = Box2D.Common.Math.b2Vec2;
  return {
    _p: new b2Vec2(x, y), _v: new b2Vec2(vx, vy), _a: rot, _w: 0, _active: true,
    GetPosition() { return new b2Vec2(this._p.x, this._p.y); },
    GetAngle() { return this._a; },
    GetLinearVelocity() { return new b2Vec2(this._v.x, this._v.y); },
    GetAngularVelocity() { return this._w; },
    SetPositionAndAngle(p, a) { this._p.x = p.x; this._p.y = p.y; this._a = a; },
    SetLinearVelocity(v) { this._v.x = v.x; this._v.y = v.y; },
    SetAngularVelocity(w) { this._w = w; },
    SetAwake() {}, SetActive(a) { this._active = a; }, IsActive() { return this._active; },
  };
}
function makeFakeTank(Box2D, x, y, rot) {
  const body = makeFakeBody(Box2D, x, y, 0, 0, rot);
  return {
    x, y, rotation: rot, forward: false, back: false, left: false, right: false,
    locked: false, speed: 0, rotationSpeed: 0,
    getX() { return this.x; }, getY() { return this.y; }, getRotation() { return this.rotation; },
    getB2DBody() { return body; },
    _computeSpeed() { this.speed = (this.forward ? 15.95 : 0) + (this.back ? -12.8 : 0); },
    _computeRotationSpeed() { this.rotationSpeed = (this.left ? -5.0 : 0) + (this.right ? 5.0 : 0); },
  };
}
function makeFakeLaser(Box2D, gameP, gameV, radius, lifetime, age) {
  const body = makeFakeBody(Box2D, gameP.x, gameP.y, gameV.x, gameV.y, 0);
  body.GetFixtureList = function () { return { GetShape() { return { m_radius: radius }; } }; };
  return {
    id: 'l-golden', lifetime: lifetime, _age: age,
    done() { return false; },
    getTimeAlive() { return this._age; },
    getType() { return 0; },                       // Constants.WEAPON_TYPES.LASER
    getB2DBody() { return body; },
    getX() { return gameP.x; }, getY() { return gameP.y; },
    getSpeedX() { return gameV.x; }, getSpeedY() { return gameV.y; },
  };
}
function makeGameController(maze, tank, projectiles) {
  return {
    getMaze: () => maze,
    getTank: () => tank,
    getTanks: () => ({ tank_b: tank }),
    getProjectiles: () => projectiles,
    getB2DWorld: () => null,
  };
}

/* ---------------------------------------------------------------------------
 * 五、几何 oracle：线段 ∩ 真坦克夹具（3.0×4.0 车体 + 0.7×1.4 炮塔）
 *   ⚠️ 这里不硬编码"应该命中"结论，而是用真 Constants 里的夹具尺寸重建多边形；
 *      golden 的 chord/g05/g25 来自真游戏报告，用于反证 oracle 与实测一致。
 * ------------------------------------------------------------------------- */

function makeCfg() {
  return {
    deathPenalty: 10.0,
    stuckPenalty: 4.0,
    stuckDistEps: 0.05,
    stuckRotEps: 0.05,
    lanePenaltyRatio: 0,
    springRopeEnabled: false,
    occlusionEnabled: true,
  };
}

function norm(vx, vy) {
  const l = Math.hypot(vx, vy);
  return { x: vx / l, y: vy / l };
}

function makeLaserThreat(scene, frames, dt) {
  const u = norm(scene.p1.x - scene.p0.x, scene.p1.y - scene.p0.y);
  const track = [];
  for (let i = 0; i <= frames + 1; i++) {
    track.push({ x: scene.p0.x + u.x * 180.0 * dt * i, y: scene.p0.y + u.y * 180.0 * dt * i, alive: true });
  }
  const last = track[track.length - 1];
  return {
    id: 'l-golden',
    type: 0,                 // Constants.WEAPON_TYPES.LASER
    sweep: true,             // 显式扫掠能力位（沙箱用它译码为 ABI kind=3）
    track: track,
    path: [{ x: scene.p0.x, y: scene.p0.y }, { x: last.x, y: last.y }],
    speed: 180.0,
    anchorOffset: 0,
    bulletRadius: 0,         // 真激光半径 0；禁止用半径 0.05 判种
    lifeLeftSeconds: 0.8,
    isNew: true,
  };
}

function maxScoreDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function runRescoreScene(sandbox, scene) {
  const Box2D = sandbox.Box2D;
  const VantageSandbox = sandbox.VantageSandbox;
  const VantageScoring = sandbox.VantageScoring;
  const dt = 0.02;   // 与 rescore 的 frame_dt 口径一致（下面显式 setFrameDtSec）
  const frames = 3;

  const maze = makeMaze(12, 8);
  const tank = makeFakeTank(Box2D, scene.C.x, scene.C.y, scene.rot);
  const u = norm(scene.p1.x - scene.p0.x, scene.p1.y - scene.p0.y);
  const laser = makeFakeLaser(Box2D, scene.p0, { x: u.x * 180.0, y: u.y * 180.0 }, 0, 0.8, 0.2);
  const gc = makeGameController(maze, tank, { 'l-golden': laser });
  const adapter = VantageSandbox.createAdapter(gc, 'tank_b');

  const pose = { x: scene.C.x, y: scene.C.y, rot: scene.rot };
  const ops = [{ name: 'static', inputs: { forward: false, back: false, left: false, right: false } }];

  // 1) JS 融合（Rust 关）：真实激光扫掠的参考死帧。
  VantageSandbox.setRustPhysicsEnabled(false);
  const fused = adapter.simulateTankBatchJsFused(pose, ops, frames, {
    startPose: pose, auditPurpose: 'jsConfirm', tGlobal: 0, nowTGlobal: 0, threats: [],
  });
  if (!fused || !fused[0] || fused[0].dead !== true || fused[0].deathFrame !== 0) {
    throw new Error(scene.name + ': JS fused did not report dead=true/fd=0');
  }

  // 2) rescore node = 融合轨迹；threat = 激光 track（kind via sweep=true）。
  const nodes = [{ samples: fused[0].samples, moving: false, startT: 0, frames: frames }];
  const threats = [makeLaserThreat(scene, frames, dt)];

  VantageSandbox.setRustPhysicsEnabled(true);
  if (VantageSandbox.setFrameDtSec) VantageSandbox.setFrameDtSec(dt);
  const rust = adapter.rescoreTankSamples(nodes, threats, makeCfg(), threats);

  // 3) JS scorePaths 参考（同一批融合轨迹 + 同一 threat）。
  const fakeAdapter = {
    constants: adapter.constants,
    simulateTankBatch: function () { return fused; },
    bulletPosAt: function (p, s, t) { return adapter.bulletPosAt(p, s, t); },
    checkDeathSweep: function (tankState, segments) { return adapter.checkDeathSweep(tankState, segments); },
  };
  const jsRef = VantageScoring.scorePaths(fakeAdapter, { tank: pose, tGlobal: 0 }, ops, frames, threats, makeCfg());

  return { fused: fused[0], rust: rust && rust[0], jsRef: jsRef && jsRef[0] };
}

async function main() {
  const sandbox = loadSandbox();
  sandbox.WebAssembly = WebAssembly;
  sandbox.fetch = async function () {
    const bytes = fs.readFileSync(JS('game_core/js/wasm/vantage_core.wasm'));
    return { ok: true, arrayBuffer: async function () {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } };
  };
  vm.runInContext(fs.readFileSync(JS('game_core/js/vantage_rust_bridge.js'), 'utf8'), sandbox._ctx,
    { filename: 'vantage_rust_bridge.js' });
  const bridge = sandbox.VantageRustBridge;
  const init = await bridge.init('js/wasm/vantage_core.wasm');
  if (!init.ok) throw new Error('bridge init failed: ' + init.error);
  console.log('=== 1-2③ rescore 激光差分（ABI v' + bridge.version() + '，容差 ' + POS_TOL + '） ===');

  let fails = 0;
  const results = [];
  for (const s of GOLDEN) {
    const r = runRescoreScene(sandbox, s);
    const rustDead = !!(r.rust && r.rust.dead);
    const rustFd = r.rust ? r.rust.deathFrame : null;
    const jsDead = !!(r.jsRef && r.jsRef.dead);
    const jsFd = r.jsRef ? r.jsRef.deathFrame : null;
    const scoreDiff = r.rust && r.jsRef
      ? Math.max(maxScoreDiff(r.rust.perFrameScores, r.jsRef.perFrameScores),
                 Math.abs((r.rust.totalScore || 0) - (r.jsRef.totalScore || 0)))
      : Infinity;
    const ok = r.fused.dead === true && r.fused.deathFrame === 0 &&
               rustDead === true && rustFd === 0 &&
               jsDead === true && jsFd === 0 && scoreDiff <= POS_TOL;
    results.push({ s, r, rustFd, jsFd, scoreDiff, ok });
    if (!ok) fails++;
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + s.name.padEnd(17) +
      ' jsFused=' + r.fused.dead + '/' + r.fused.deathFrame +
      ' rustRescore=' + rustDead + '/' + rustFd +
      ' jsScorePaths=' + jsDead + '/' + jsFd +
      ' scoreDiff=' + (isFinite(scoreDiff) ? scoreDiff.toExponential(3) : 'Inf'));
    if (!ok) {
      if (!rustDead || rustFd !== 0) {
        console.log('        ↳ Rust rescore 没把 fd=0 当死：pre-fix `rescore_nodes` 用 `death_frame > 0` 丢掉了 verify 的 (0, …)。');
      }
      if (scoreDiff > POS_TOL) {
        console.log('        ↳ rust vs js perFrameScores/totalScore 超差：' + scoreDiff);
      }
    }
  }
  console.log('\n' + (fails ? ('DIFF RESCORE LASER FAILED (' + fails + '/' + GOLDEN.length + ')')
                            : ('DIFF RESCORE LASER PASSED (' + GOLDEN.length + '/' + GOLDEN.length + ')')));
  process.exitCode = fails ? 1 : 0;
}

main().catch(function (e) {
  console.error('diff_rescore_laser.js error:', (e && e.stack) || e);
  process.exitCode = 2;
});
