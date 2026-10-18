#!/usr/bin/env node
// Differential test: real JS `VantageScoring.scorePaths` reference (over a
// real fused batch) vs the in-game Rust/WASM incremental rescore path
// (`adapter.rescoreTankSamples` behind
// VantageSandbox.setRustPhysicsEnabled(true)).
//
// This exercises the exact browser hot-path wiring: stored rolloutSamples are
// rescored by vt_rescore_nodes (ABI v6) through VantageRustBridge, and the
// result is mapped back into the same shape VantageScoring.scorePaths returns.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');

const root = path.resolve(__dirname, '..');
const jsBox2D = path.join(root, 'js', 'f1a5ef972c273fb89a098cb50b0f22e7.js');
const jsBundle = path.join(root, 'js', 'b714588dc4621fe104113111ba90b1a7.js');
const jsTactics = path.join(root, 'js', 'ai_tactics.js');
const jsSandbox = path.join(root, 'js', 'vantage_sandbox.js');
const jsScoring = path.join(root, 'js', 'vantage_scoring.js');
const bridgePath = path.join(root, 'js', 'vantage_rust_bridge.js');
const wasmPath = path.join(root, 'js', 'wasm', 'vantage_core.wasm');

const POS_TOL = 1e-9;
const ANG_TOL = 1e-9;

// ---------------------------------------------------------------------------
// VM loading (same recipe as diff_rollout_bridge / diff_rescore)
// ---------------------------------------------------------------------------
function loadSandbox() {
  const sandbox = { console: console };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);

  // a. Real Box2D source.
  vm.runInContext(fs.readFileSync(jsBox2D, 'utf8'), ctx, { filename: jsBox2D });
  const Box2D = sandbox.Box2D;
  if (!Box2D) throw new Error('Box2D was not defined after loading the JS file');

  // b. Minimal Classy stub (plain object factory).
  function makeClass() {
    const C = {};
    C.classFields = function (o) {
      for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) C[k] = o[k];
      return C;
    };
    C.classMethods = function (o) {
      for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) C[k] = o[k];
      return C;
    };
    C.methods = function () { return C; };
    C.fields = function () { return C; };
    C.name = function () { return C; };
    return C;
  }
  sandbox.Classy = { newClass: makeClass };

  // c. Load ONLY the Constants and B2DUtils pagespeed lines from the bundle.
  const bundleSrc = fs.readFileSync(jsBundle, 'utf8');
  const bundleLines = bundleSrc.split(/\r?\n/).filter((l) => /^\s*var mod_pagespeed_/.test(l));
  const wanted = ['mod_pagespeed_QSIkKJ9Ibg', 'mod_pagespeed__SHLt6ORr2'];
  for (const name of wanted) {
    const line = bundleLines.find((l) => l.indexOf('var ' + name) >= 0);
    if (!line) throw new Error('bundle line not found: ' + name);
    vm.runInContext(line, ctx, { filename: 'bundle-' + name + '.js' });
    vm.runInContext(sandbox[name], ctx, { filename: 'bundle-' + name + '-eval.js' });
  }

  // d/e/f. Real AI tactics, VantageSandbox and VantageScoring modules.
  vm.runInContext(fs.readFileSync(jsTactics, 'utf8'), ctx, { filename: jsTactics });
  vm.runInContext(fs.readFileSync(jsSandbox, 'utf8'), ctx, { filename: jsSandbox });
  vm.runInContext(fs.readFileSync(jsScoring, 'utf8'), ctx, { filename: jsScoring });
  sandbox._ctx = ctx;

  return sandbox;
}

// ---------------------------------------------------------------------------
// Fakes (minimal but complete for B2DUtils + simulateFusedBatch)
// ---------------------------------------------------------------------------
function makeFakeTankBody(Box2D, x, y, rot) {
  const b2Vec2 = Box2D.Common.Math.b2Vec2;
  return {
    _pos: new b2Vec2(x, y),
    _vel: new b2Vec2(0, 0),
    _angle: rot,
    _angVel: 0,
    _active: true,
    GetPosition: function () { return new b2Vec2(this._pos.x, this._pos.y); },
    GetAngle: function () { return this._angle; },
    GetLinearVelocity: function () { return new b2Vec2(this._vel.x, this._vel.y); },
    GetAngularVelocity: function () { return this._angVel; },
    SetPositionAndAngle: function (p, a) { this._pos.x = p.x; this._pos.y = p.y; this._angle = a; },
    SetLinearVelocity: function (v) { this._vel.x = v.x; this._vel.y = v.y; },
    SetAngularVelocity: function (w) { this._angVel = w; },
    SetAwake: function () {},
    SetActive: function (a) { this._active = a; },
    IsActive: function () { return this._active; },
  };
}

function makeFakeProjectileBody(Box2D, x, y, vx, vy, radius) {
  const b2Vec2 = Box2D.Common.Math.b2Vec2;
  return {
    _pos: new b2Vec2(x, y),
    _vel: new b2Vec2(vx, vy),
    _angle: 0,
    _angVel: 0,
    _active: true,
    _fixture: { GetShape: function () { return { m_radius: radius }; } },
    GetPosition: function () { return new b2Vec2(this._pos.x, this._pos.y); },
    GetAngle: function () { return this._angle; },
    GetLinearVelocity: function () { return new b2Vec2(this._vel.x, this._vel.y); },
    GetAngularVelocity: function () { return this._angVel; },
    GetFixtureList: function () { return this._fixture; },
    SetPositionAndAngle: function (p, a) { this._pos.x = p.x; this._pos.y = p.y; this._angle = a; },
    SetLinearVelocity: function (v) { this._vel.x = v.x; this._vel.y = v.y; },
    SetAngularVelocity: function (w) { this._angVel = w; },
    SetAwake: function () {},
    SetActive: function (a) { this._active = a; },
    IsActive: function () { return this._active; },
  };
}

function makeFakeTank(Box2D, x, y, rot) {
  const body = makeFakeTankBody(Box2D, x, y, rot);
  const tank = {
    x: x,
    y: y,
    rotation: rot,
    forward: false,
    back: false,
    left: false,
    right: false,
    locked: false,
    speed: 0,
    rotationSpeed: 0,
    getX: function () { return this.x; },
    getY: function () { return this.y; },
    getRotation: function () { return this.rotation; },
    getB2DBody: function () { return body; },
    _computeSpeed: function () {
      this.speed = (this.forward ? 15.95 : 0) + (this.back ? -12.8 : 0);
    },
    _computeRotationSpeed: function () {
      this.rotationSpeed = (this.left ? -5.0 : 0) + (this.right ? 5.0 : 0);
    },
  };
  return tank;
}

function makeFakeProjectile(Box2D, Constants, x, y, vx, vy, radius) {
  const body = makeFakeProjectileBody(Box2D, x, y, vx, vy, radius);
  return {
    _x: x,
    _y: y,
    _vx: vx,
    _vy: vy,
    lifetime: 10,
    age: 0,
    done: function () { return false; },
    getTimeAlive: function () { return this.age; },
    getType: function () { return Constants.WEAPON_TYPES.BULLET; },
    getB2DBody: function () { return body; },
    getX: function () { return this._x; },
    getY: function () { return this._y; },
    getSpeedX: function () { return this._vx; },
    getSpeedY: function () { return this._vy; },
  };
}

function makeMaze(W, H) {
  const tiles = [];
  for (let i = 0; i < W; i++) {
    tiles[i] = [];
    for (let j = 0; j < H; j++) {
      tiles[i][j] = [1, j === 0 ? 1 : 0, i === 0 ? 1 : 0];
    }
  }
  return {
    getTiles: function () { return tiles; },
  };
}

function makeGameController(maze, tank, projectiles) {
  return {
    getMaze: function () { return maze; },
    getTank: function (id) { return tank; },
    getTanks: function () { return { p0: tank }; },
    getProjectiles: function () { return projectiles; },
    getB2DWorld: function () { return null; },
  };
}

function isMovingInputs(inputs) {
  return !!(inputs && (inputs.forward || inputs.back || inputs.left || inputs.right));
}


// ===========================================================================
// E3（S7）：`tGlobal≈0` 的融合批次在【段中】（nowTGlobal>0）拿"现在"的真实弹位
// 去当节点起点的弹位 —— 弹位错 tBack×弹速，寿命也少算 tBack 秒。
//
// 场景（节点起点 = 根 = 现在之前 tBack 秒）：
//   真实弹：现在在 (5, 11)，速度 (0,-18)；现在剩余寿命 L_now = 0.10s
//   节点起点（tBack=0.30s 之前）：弹应该在 (5, 16.4)，剩余寿命 0.10+0.30 = 0.40s
//   坦克静止 (5,8)（传感器盒顶 ~9.68）⟹ 从节点起点算，第 ~18 帧才打到
//
//   A/B 用同一个函数、只换 nowTGlobal：
//     nowTGlobal=0     ⇒ 旧行为（real 分支 + qAge 钳 0）：弹摆在 (5,11)，只剩 0.10s
//                         ⇒ 第 3 帧就"撞上"坦克（假死，早 tBack 帧）
//     nowTGlobal=tBack ⇒ 新行为：弹回推到 (5,16.4)，剩 0.40s
//                         ⇒ 第 ~18 帧命中（与节点起点几何一致）
//
// 判据（PHASE=after 默认）：
//   ① 新行为摆位 = (5, 16.4)（误差 < 1e-6），旧行为摆位 = (5, 11)
//   ② 新行为死帧 ≈ 旧行为死帧 + tBack/FRAME 帧（差 ≥ 10 帧）
// ===========================================================================
'use strict';

const FRAME = 0.02;
const T_BACK = 15 * FRAME;      // nowTGlobal = 0.30s（节点起点在过去 15 帧）
const LT = 2.0;
const AGE_ROOT = LT - 0.40;     // 节点起点处剩余 0.40s
const AGE_NOW = AGE_ROOT + T_BACK;  // "现在"剩余 0.10s
const VY = -18.0;
const P_NOW_Y = 11.0;
const P_ROOT_Y = P_NOW_Y + (-VY) * T_BACK;   // 16.4

let globalSandbox = null;

async function main() {
  globalSandbox = loadSandbox();
  const sandbox = globalSandbox;
  const Box2D = sandbox.Box2D;
  const Constants = sandbox.Constants;
  const VantageSandbox = sandbox.VantageSandbox;
  if (!VantageSandbox) throw new Error('VantageSandbox was not defined');

  const ops = VantageSandbox.OPERATIONS;
  const frames = 75;
  const maze = makeMaze(4, 3);
  const startPose = { x: 5.0, y: 8.0, rot: 0.0 };
  const tank = makeFakeTank(Box2D, startPose.x, startPose.y, startPose.rot);
  const bullet = makeFakeProjectile(Box2D, Constants, 5.0, P_NOW_Y, 0.0, VY, 0.25);
  bullet.lifetime = LT;
  const projectiles = { b1: bullet };
  const adapter = VantageSandbox.createAdapter(
    makeGameController(maze, tank, projectiles), 'p0'
  );

  function placeBullet(y, age) {
    bullet._x = 5.0; bullet._y = y;
    bullet.getB2DBody().SetPositionAndAngle(Box2D.Common.Math.b2Vec2.Make(5.0, y), 0);
    bullet.getB2DBody().SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(0, VY));
    bullet.age = age;
  }

  // ① 在"节点起点"生成轨迹（track[0] = 根时刻的弹位 = (5,16.4)），
  //    再把真实弹挪到"现在"。
  placeBullet(P_ROOT_Y, AGE_ROOT);
  const tracks = adapter.simulateBulletTracks(frames);
  if (!tracks || !tracks.length || !tracks[0].frames.length) throw new Error('no track');
  const track = tracks[0].frames;
  placeBullet(P_NOW_Y, AGE_NOW);
  if (Math.abs(bullet.getTimeAlive() - AGE_NOW) > 1e-12) throw new Error('age 设置失败');

  const threats = [{
    id: 'b1', track: track, trackFrameDt: FRAME, anchorOffset: 0,
    speed: 18.0, bulletRadius: 0.25, lifeLeftSeconds: 0.10,
  }];
  console.log('scene            : S7 段中 tGlobal≈0 批次（节点起点在过去 15 帧）');
  console.log('  真实弹现在 = (5, ' + P_NOW_Y.toFixed(2) + ')  速度(0,' + VY + ')  现在剩余寿命 = ' +
    (LT - AGE_NOW).toFixed(2) + 's');
  console.log('  节点起点应在 = (5, ' + P_ROOT_Y.toFixed(2) + ')  该处剩余寿命 = ' +
    (LT - AGE_ROOT).toFixed(2) + 's  trackLen=' + track.length);

  function run(nowTGlobal) {
    const b = adapter.simulateTankBatch(startPose, ops, frames, {
      startPose: startPose, threats: threats, tGlobal: 0, nowTGlobal: nowTGlobal,
      auditPurpose: 's7probe',
    });
    const sum = adapter.getLastFusedBatchSummary();
    const op0 = sum && sum.placements && sum.placements[0];
    const fd = b.map((r) => r.deathFrame);
    return { batch: b, place: op0, fd: fd };
  }

  const oldRun = run(0);
  const newRun = run(T_BACK);
  console.log('  旧（nowTGlobal=0）   : 摆弹=' + JSON.stringify(oldRun.place) + ' fd[0]=' + oldRun.fd[0]);
  console.log('  新（nowTGlobal=' + T_BACK.toFixed(2) + '）: 摆弹=' + JSON.stringify(newRun.place) + ' fd[0]=' + newRun.fd[0]);
  console.log('  期望摆位 y=' + P_ROOT_Y.toFixed(2) + '  旧摆位 y=' + P_NOW_Y.toFixed(2) +
    '（差 ' + (P_ROOT_Y - P_NOW_Y).toFixed(2) + 'm = tBack×弹速）');

  const phase = process.env.PHASE || 'after';
  if (phase === 'before') {
    if (oldRun.place && Math.abs(oldRun.place.y - P_NOW_Y) > 1e-6) throw new Error('before：旧行为摆位不是"现在"弹位');
    if (newRun.place && Math.abs(newRun.place.y - P_ROOT_Y) < 1e-6) throw new Error('before：摆位已经修好了？');
    console.log('DIFF S7 PASTNODE: 缺陷已复现（before）');
    return;
  }
  if (!oldRun.place || !newRun.place) throw new Error('没有摆弹记录');
  if (Math.abs(oldRun.place.y - P_NOW_Y) > 1e-6) {
    throw new Error('S7 FAIL：旧口径摆位应等于"现在"弹位 y=' + P_NOW_Y + '，实得 ' + oldRun.place.y);
  }
  if (Math.abs(newRun.place.y - P_ROOT_Y) > 1e-6) {
    throw new Error('S7 FAIL：新口径摆位应等于节点起点弹位 y=' + P_ROOT_Y + '，实得 ' + newRun.place.y);
  }
  if (newRun.fd[0] - oldRun.fd[0] < 10) {
    throw new Error('S7 FAIL：死帧差应 ≥10 帧（旧 ' + oldRun.fd[0] + ' / 新 ' + newRun.fd[0] + '）');
  }
  console.log('DIFF S7 PASTNODE PASSED (after)：摆位回推 ' + (P_ROOT_Y - P_NOW_Y).toFixed(2) +
    'm，死帧从 ' + oldRun.fd[0] + ' 修到 ' + newRun.fd[0] + '（+15 帧 = tBack）');
}

main().catch((e) => {
  console.error('diff_s7_pastnode.js error:', (e && e.stack) || e);
  process.exitCode = 2;
});
