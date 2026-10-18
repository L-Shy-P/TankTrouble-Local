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
// E4（S8）：`VantageScoring.scorePaths / scorePath` 没把 nowTGlobal 传下去时，
// 「节点起点在未来」的候选会多扣 min(tGlobal, nowTGlobal) 秒子弹寿命。
//
// 场景（全部量都是"根时间轴"秒数）：
//   根 = 0，现在 μ = 0.30s（= 15 帧），节点起点 T = 0.50s（= 25 帧，在过去与现在之后）
//   威胁锚点 A = 0（这颗弹在根那一刻被树锚定，track[0] = 根时刻的弹位）
//   真实弹：现在(μ)的位置 = track[15]，年龄 = 0.30s，lifetime LT = 0.70s
//   ⇒ 节点起点(T)处正确的剩余寿命 = LT - 0.30 - (0.50-0.30) = 0.20s（10 帧）
//   ⇒ 少传 nowTGlobal 时 = LT - 0.30 - 0.50 = -0.10s ⇒ 夹到 0（第一帧就退场）
//   坦克静止在 (5,8)，子弹在 T 时刻位于 track[25]=(5,11)，第 3 帧打到坦克。
//
// 判据：
//   PHASE=before：fd_missing === fd_correct === -1（缺陷：两路都漏死）
//   PHASE=after ：fd_correct === 命中帧，fd_missing === -1（补传 nowTGlobal 生效）
// ===========================================================================
'use strict';

const FRAME = 0.02;
const MU = 15 * FRAME;    // nowTGlobal = "现在"相对根 = 0.30s
const TG = 25 * FRAME;    // 节点起点 tGlobal = 0.50s
const LT = 0.70;          // 子弹总寿命（从锚点算）
const A = 0.0;            // 威胁锚点（相对根）
const VY = -18.0;

let globalSandbox = null;
let globalBridge = null;

async function main() {
  globalSandbox = loadSandbox();
  const sandbox = globalSandbox;
  sandbox.WebAssembly = WebAssembly;
  sandbox.fetch = async function () {
    const bytes = fs.readFileSync(wasmPath);
    return {
      ok: true,
      arrayBuffer: async function () {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  };
  const Box2D = sandbox.Box2D;
  const Constants = sandbox.Constants;
  const VantageSandbox = sandbox.VantageSandbox;
  const VantageScoring = sandbox.VantageScoring;
  if (!VantageSandbox) throw new Error('VantageSandbox was not defined');
  if (!VantageScoring) throw new Error('VantageScoring was not defined');

  const ops = VantageSandbox.OPERATIONS;
  const frames = 75;
  const cfg = {
    deathPenalty: 0, stuckPenalty: 4.0, stuckDistEps: 0.05, stuckRotEps: 0.05,
    lanePenaltyRatio: 0, springRopeEnabled: false,
  };

  const maze = makeMaze(4, 3);
  const startPose = { x: 5.0, y: 8.0, rot: 0.0 };
  const tank = makeFakeTank(Box2D, startPose.x, startPose.y, startPose.rot);
  const bullet = makeFakeProjectile(Box2D, Constants, 5.0, 20.0, 0.0, VY, 0.25);
  bullet.lifetime = LT;
  const projectiles = { b1: bullet };
  const adapter = VantageSandbox.createAdapter(
    makeGameController(maze, tank, projectiles), 'p0'
  );

  function placeBullet(x, y, age) {
    bullet._x = x; bullet._y = y;
    bullet.getB2DBody().SetPositionAndAngle(Box2D.Common.Math.b2Vec2.Make(x, y), 0);
    bullet.getB2DBody().SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(0, VY));
    bullet.age = age;
  }

  // ① 在锚点时刻生成轨迹：track[0] = 根时刻的弹位
  placeBullet(5.0, 20.0, 0);
  const tracks = adapter.simulateBulletTracks(frames);
  if (!tracks || !tracks.length || !tracks[0].frames.length) throw new Error('no track');
  const track = tracks[0].frames;
  const nowIdx = Math.round(MU / FRAME);
  const nodeIdx = Math.round(TG / FRAME);
  const nowFrame = track[nowIdx] || track[track.length - 1];
  const nodeFrame = track[nodeIdx] || track[track.length - 1];
  // ② 真实弹挪到"现在"
  placeBullet(nowFrame.x, nowFrame.y, MU - A);

  const threats = [{
    id: 'b1', track: track, trackFrameDt: FRAME, anchorOffset: A,
    speed: 18.0, bulletRadius: 0.25, lifeLeftSeconds: LT,
  }];

  const L_now = LT - bullet.getTimeAlive();
  const lifeAtNodeStartCorrect = L_now - (TG - MU);
  const lifeAtNodeStartMissing = L_now - TG;     // nowTGlobal 缺省 0
  console.log('scene            : S8 未来节点 + 弹在节点起点附近到期');
  console.log('  μ(nowTGlobal)=' + MU.toFixed(2) + 's  T(tGlobal)=' + TG.toFixed(2) + 's  A=' + A.toFixed(2) +
    's  LT=' + LT.toFixed(2) + 's');
  console.log('  现在剩余寿命 L_now=' + L_now.toFixed(3) + 's');
  console.log('  节点起点正确剩余寿命 = ' + lifeAtNodeStartCorrect.toFixed(3) + 's（' +
    (lifeAtNodeStartCorrect / FRAME).toFixed(1) + ' 帧）');
  console.log('  少传 nowTGlobal 时 = ' + lifeAtNodeStartMissing.toFixed(3) + 's ⇒ 少 ' +
    ((lifeAtNodeStartCorrect - lifeAtNodeStartMissing) / FRAME).toFixed(1) + ' 帧');
  console.log('  track 长度=' + track.length + '  节点起点的弹位 = track[' + nodeIdx + '] = (' +
    nodeFrame.x.toFixed(2) + ',' + nodeFrame.y.toFixed(2) + ')');

  const simMissing = { tank: startPose, tGlobal: TG, nowTGlobal: 0 };
  const simCorrect = { tank: startPose, tGlobal: TG, nowTGlobal: MU };
  const rMissing = VantageScoring.scorePaths(adapter, simMissing, ops, frames, threats, cfg);
  const rCorrect = VantageScoring.scorePaths(adapter, simCorrect, ops, frames, threats, cfg);
  const fdMissing = rMissing.map((r) => r.deathFrame);
  const fdCorrect = rCorrect.map((r) => r.deathFrame);
  const audit = adapter.getLastFusedBatchSummary ? adapter.getLastFusedBatchSummary() : null;
  console.log('  fd_missing(nowTGlobal=0) = ' + JSON.stringify(fdMissing));
  console.log('  fd_correct(nowTGlobal=μ) = ' + JSON.stringify(fdCorrect));
  if (audit) {
    console.log('  [audit] purpose=' + audit.purpose + ' tGlobal=' + audit.tGlobal +
      ' nowTGlobal=' + audit.nowTGlobal + ' 摆弹=' + JSON.stringify((audit.placements || [])[0]));
  }

  const i0 = 0;
  const phase = process.env.PHASE || 'after';
  if (phase === 'before') {
    if (fdCorrect[i0] !== -1) throw new Error('E1/E4 FAIL：修正前 fd_correct 竟然不是 -1（缺陷没复现）');
    if (fdMissing[i0] !== -1) throw new Error('E1/E4 FAIL：fd_missing ≠ -1');
    console.log('DIFF SCORE PATHS NOWTGLOBAL: 缺陷已复现（before）两路都 = -1');
  } else {
    if (fdCorrect[i0] < 0) throw new Error('E4 FAIL：补传 nowTGlobal 后仍漏死（fd=' + fdCorrect[i0] + '）');
    if (fdMissing[i0] !== -1) throw new Error('E4 FAIL：不传 nowTGlobal 竟然也判死（fd=' + fdMissing[i0] + '）');
    console.log('DIFF SCORE PATHS NOWTGLOBAL PASSED (after) 命中帧=' + fdCorrect[i0]);
  }
}

main().catch((e) => {
  console.error('diff_score_paths_nowtglobal.js error:', (e && e.stack) || e);
  process.exitCode = 2;
});
