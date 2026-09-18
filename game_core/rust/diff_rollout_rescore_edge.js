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

let globalSandbox = null;
let globalBridge = null;

function loadBridge(sandbox) {
  const ctxBridge = sandbox._ctx;
  vm.runInContext(fs.readFileSync(bridgePath, 'utf8'), ctxBridge, { filename: bridgePath });
  return sandbox.VantageRustBridge;
}


async function main() {
  globalSandbox = loadSandbox();
  const sandbox = globalSandbox;
  sandbox.WebAssembly = WebAssembly;
  sandbox.fetch = async function () {
    const bytes = fs.readFileSync(wasmPath);
    return { ok: true, arrayBuffer: async function () { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
  };
  vm.runInContext(fs.readFileSync(bridgePath, 'utf8'), sandbox._ctx, { filename: bridgePath });
  globalBridge = sandbox.VantageRustBridge;
  const Box2D = sandbox.Box2D, Constants = sandbox.Constants, VantageSandbox = sandbox.VantageSandbox, VantageScoring = sandbox.VantageScoring;
  const ops = VantageSandbox.OPERATIONS;
  const frames = 75;
  const cfg = { deathPenalty: 0, stuckPenalty: 4, stuckDistEps: 0.05, stuckRotEps: 0.05, lanePenaltyRatio: 0, springRopeEnabled: false };
  const maze = makeMaze(4, 3, [], []);
  const startPose = { x: 5.0, y: 8.0, rot: 0.0 };

  function compareBatch(name, fused, rust) {
    let maxPos = 0, maxAng = 0, at = '';
    for (let op = 0; op < ops.length; op++) {
      if (fused[op].dead !== rust[op].dead || fused[op].deathFrame !== rust[op].deathFrame) {
        throw new Error(name + ' death mismatch op ' + op + ' fused=' + fused[op].deathFrame + ' rust=' + rust[op].deathFrame);
      }
      for (let f = 0; f < fused[op].samples.length; f++) {
        const a = fused[op].samples[f], b = rust[op].samples[f];
        const pe = Math.hypot(a.x - b.x, a.y - b.y), ae = Math.abs(a.rot - b.rot);
        if (pe > maxPos) { maxPos = pe; at = 'op ' + op + ' f ' + f; }
        if (ae > maxAng) maxAng = ae;
      }
    }
    console.log('scene            :', name);
    console.log('  max position err:', maxPos.toExponential(9), 'at', at);
    console.log('  max angle err   :', maxAng.toExponential(9));
    if (maxPos > 1e-9 || maxAng > 1e-9) throw new Error(name + ' trajectory mismatch');
  }

  // Laser: point-radius, very fast projectile.
  const laser = makeFakeProjectile(Box2D, Constants, 5.0, 12.0, 0.0, -180.0, 0.0);
  const laserTank = makeFakeTank(Box2D, startPose.x, startPose.y, startPose.rot);
  const laserAdapter = VantageSandbox.createAdapter(makeGameController(maze, laserTank, { l1: laser }), 'p0');
  const laserOpt = { startPose, threats: [], tGlobal: 0 };
  const laserFused = laserAdapter.simulateTankBatch(startPose, ops, frames, laserOpt);

  // Many simultaneous bullets (double-barrel/shootout stress): 120 > old 64 cap.
  const manyTank = makeFakeTank(Box2D, 15.0, 15.0, 0.2);
  const manyProjectiles = {};
  for (let i = 0; i < 120; i++) {
    manyProjectiles['m' + i] = makeFakeProjectile(Box2D, Constants,
      10 + (i % 10) * 3, 2 + (i % 10) * 2, (i % 2 ? -1 : 1) * 15, 18, 0.25);
  }
  const manyAdapter = VantageSandbox.createAdapter(makeGameController(maze, manyTank, manyProjectiles), 'p0');
  const manyPose = { x: 15.0, y: 15.0, rot: 0.2 };
  const manyOpt = { startPose: manyPose, threats: [], tGlobal: 0 };
  const manyFused = manyAdapter.simulateTankBatch(manyPose, ops, 30, manyOpt);

  const init = await globalBridge.init('js/wasm/vantage_core.wasm');
  if (!init.ok) throw new Error('bridge init failed: ' + init.error);
  if (globalBridge.version() !== 7) throw new Error('expected ABI v6, got ' + globalBridge.version());
  VantageSandbox.setRustPhysicsEnabled(true);

  const laserRust = laserAdapter.simulateTankBatch(startPose, ops, frames, laserOpt);
  compareBatch('bridge laser point-radius 180 m/s', laserFused, laserRust);

  const manyRust = manyAdapter.simulateTankBatch(manyPose, ops, 30, manyOpt);
  compareBatch('bridge 120 simultaneous bullets', manyFused, manyRust);

  // Rescore the stored laser trajectories through the new incremental path.
  const laserNodes = laserFused.map((r, j) => ({
    samples: r.samples, moving: isMovingInputs(ops[j].inputs), startT: 0, frames,
  }));
  const laserThreats = [{
    id: 'l1', path: [{ x: 5, y: 12 }, { x: 5, y: -40 }], speed: 180,
    anchorOffset: 0, bulletRadius: 0, lifeLeftSeconds: 0.8,
  }];
  const rescored = laserAdapter.rescoreTankSamples(laserNodes, laserThreats, cfg);
  if (!rescored) throw new Error('laser rescore returned null');

  const fakeAdapter = {
    constants: laserAdapter.constants,
    bulletPosAt: laserAdapter.bulletPosAt,
    simulateTankBatch: function () { return laserFused; },
  };
  const jsRef = VantageScoring.scorePaths(fakeAdapter, { tank: startPose, tGlobal: 0 }, ops, frames, laserThreats, cfg);
  let maxScore = 0, maxTotal = 0;
  for (let op = 0; op < ops.length; op++) {
    if (rescored[op].deathFrame !== jsRef[op].deathFrame) throw new Error('laser rescore death mismatch op ' + op);
    for (let f = 0; f < jsRef[op].perFrameScores.length; f++) {
      maxScore = Math.max(maxScore, Math.abs(jsRef[op].perFrameScores[f] - rescored[op].perFrameScores[f]));
    }
    maxTotal = Math.max(maxTotal, Math.abs(jsRef[op].totalScore - rescored[op].totalScore));
  }
  console.log('scene            : bridge laser rescore (radius 0)');
  console.log('  max per-frame err:', maxScore.toExponential(9));
  console.log('  max total err    :', maxTotal.toExponential(9));
  if (maxScore > 1e-9 || maxTotal > 1e-9) throw new Error('laser rescore score mismatch');

  VantageSandbox.setRustPhysicsEnabled(false);
  console.log('DIFF ROLLOUT/RESCORE EDGE PASSED');
}

main().catch((e) => { console.error('diff_rollout_rescore_edge.js error:', (e && e.stack) || e); process.exitCode = 2; });
