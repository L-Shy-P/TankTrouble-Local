#!/usr/bin/env node
// Differential test: real JS `VantageScoring.scorePaths` reference (over a
// real JS fused batch) vs the new Rust/WASM nine-operation scored rollout
// path (`adapter.simulateTankBatchScored` -> vt_score_paths, ABI v6).
//
// Scenes: far bullet, near bullet, crossing bullet, laser radius 0, death.
// Compares samples, perFrameScores, totalScore, and deathFrame exactly.

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

  const Box2D = sandbox.Box2D;
  const Constants = sandbox.Constants;
  const VantageSandbox = sandbox.VantageSandbox;
  const VantageScoring = sandbox.VantageScoring;
  const ops = VantageSandbox.OPERATIONS;
  const frames = 75;
  const cfg = { deathPenalty: 0, stuckPenalty: 4, stuckDistEps: 0.05, stuckRotEps: 0.05, lanePenaltyRatio: 0, springRopeEnabled: false };
  const maze = makeMaze(4, 3);
  const startPose = { x: 5.0, y: 8.0, rot: 0.0 };

  const scenes = [
    {
      name: 'far bullet',
      projectile: { x: 35.0, y: 2.0, vx: -18.0, vy: 0.0, radius: 0.25 },
      threats: [{
        id: 'far1',
        path: [{ x: 35.0, y: 2.0 }, { x: -10.0, y: 2.0 }],
        speed: 18.0,
        anchorOffset: 0,
        useTrack: false
      }]
    },
    {
      name: 'near bullet',
      projectile: { x: 8.0, y: 8.0, vx: -18.0, vy: 0.0, radius: 0.25 },
      threats: [{
        id: 'near1',
        path: [{ x: 8.0, y: 8.0 }, { x: -20.0, y: 8.0 }],
        speed: 18.0,
        anchorOffset: 0,
        useTrack: true
      }]
    },
    {
      name: 'crossing bullet',
      projectile: { x: 5.0, y: -5.0, vx: 0.0, vy: 18.0, radius: 0.25 },
      threats: [{
        id: 'cross1',
        path: [{ x: 5.0, y: -5.0 }, { x: 5.0, y: 40.0 }],
        speed: 18.0,
        anchorOffset: 0,
        useTrack: false
      }]
    },
    {
      name: 'laser radius 0',
      projectile: { x: 5.0, y: 12.0, vx: 0.0, vy: -180.0, radius: 0.0 },
      threats: [{
        id: 'laser1',
        path: [{ x: 5.0, y: 12.0 }, { x: 5.0, y: -40.0 }],
        speed: 180.0,
        anchorOffset: 0,
        useTrack: false
      }]
    },
    {
      name: 'death head-on',
      projectile: { x: 5.0, y: 12.0, vx: 0.0, vy: -18.0, radius: 0.25 },
      threats: [{
        id: 'death1',
        path: [{ x: 5.0, y: 12.0 }, { x: 5.0, y: -40.0 }],
        speed: 18.0,
        anchorOffset: 0,
        useTrack: false
      }]
    }
  ];

  // JS fused batches (Rust physics still disabled at this point).
  const prepared = [];
  for (let si = 0; si < scenes.length; si++) {
    const sc = scenes[si];
    const tank = makeFakeTank(Box2D, startPose.x, startPose.y, startPose.rot);
    const pr = sc.projectile;
    const projectile = makeFakeProjectile(Box2D, Constants, pr.x, pr.y, pr.vx, pr.vy, pr.radius);
    const projectiles = { p1: projectile };
    const adapter = VantageSandbox.createAdapter(makeGameController(maze, tank, projectiles), 'p0');
    const fused = adapter.simulateTankBatch(startPose, ops, frames, { startPose, threats: [], tGlobal: 0 });
    let threats = sc.threats;
    if (sc.threats[0].useTrack) {
      const tracks = adapter.simulateBulletTracks(frames);
      if (!tracks || !tracks.length || !tracks[0].frames || !tracks[0].frames.length) {
        throw new Error(sc.name + ': simulateBulletTracks returned no track');
      }
      threats = [{
        id: sc.threats[0].id,
        track: tracks[0].frames,
        anchorOffset: 0,
        speed: sc.threats[0].speed,
      }];
    }
    prepared.push({ scene: sc, adapter, fused, threats });
  }

  const init = await globalBridge.init('js/wasm/vantage_core.wasm');
  if (!init.ok) throw new Error('bridge init failed: ' + init.error);
  if (globalBridge.version() !== 6) {
    throw new Error('expected wasm ABI v6, got ' + globalBridge.version());
  }
  VantageSandbox.setRustPhysicsEnabled(true);

  const rustNativeWarn = globalSandbox.console.warn.bind(globalSandbox.console);
  let rustWarnCount = 0;
  globalSandbox.console.warn = function () {
    rustWarnCount++;
    rustNativeWarn.apply(null, arguments);
  };

  let totalOpsCompared = 0;
  let totalFramesCompared = 0;
  for (let si = 0; si < prepared.length; si++) {
    const prep = prepared[si];
    const sc = prep.scene;
    const adapter = prep.adapter;
    const fused = prep.fused;
    const threats = prep.threats;

    // JS reference: use the real fused batch but score through VantageScoring.
    const fakeAdapter = {
      constants: adapter.constants,
      bulletPosAt: adapter.bulletPosAt,
      simulateTankBatch: function () { return fused; },
    };
    const jsResults = VantageScoring.scorePaths(
      fakeAdapter, { tank: startPose, tGlobal: 0 }, ops, frames, threats, cfg
    );

    // Rust path: adapter.simulateTankBatchScored (vt_score_paths ABI v6).
    const rustResults = adapter.simulateTankBatchScored(startPose, ops, frames, {
      startPose,
      threats,
      tGlobal: 0,
      cfg,
    });
    if (!rustResults || rustResults.length !== ops.length) {
      throw new Error(sc.name + ': simulateTankBatchScored returned null/invalid');
    }

    let maxPos = 0, maxAng = 0, maxScore = 0, maxTotal = 0, maxPosAt = '', maxScoreAt = '';
    for (let op = 0; op < ops.length; op++) {
      const js = jsResults[op];
      const rs = rustResults[op];
      if (rs.deathAuthority !== 'rust-candidate') {
        throw new Error(sc.name + ' op ' + op + ': missing rust-candidate authority');
      }
      if (js.deathFrame !== rs.deathFrame) {
        throw new Error(sc.name + ' op ' + op + ': deathFrame mismatch JS=' +
          js.deathFrame + ' Rust=' + rs.deathFrame);
      }
      if (js.perFrameScores.length !== rs.perFrameScores.length) {
        throw new Error(sc.name + ' op ' + op + ': per-frame count mismatch JS=' +
          js.perFrameScores.length + ' Rust=' + rs.perFrameScores.length);
      }
      for (let f = 0; f < js.perFrameScores.length; f++) {
        const err = Math.abs(js.perFrameScores[f] - rs.perFrameScores[f]);
        if (err > maxScore) { maxScore = err; maxScoreAt = 'op ' + op + ' frame ' + (f + 1); }
        if (err > 1e-9 && si === 0 && op === 0 && f < 3) {
          console.log('  sample mismatch detail op0 f' + (f + 1) +
            ' js=' + js.perFrameScores[f].toFixed(15) + ' rust=' + rs.perFrameScores[f].toFixed(15));
        }
      }
      const totalErr = Math.abs(js.totalScore - rs.totalScore);
      if (totalErr > maxTotal) maxTotal = totalErr;

      // Sample identity: the Rust path re-simulates; positions must match the
      // JS fused batch to the same tolerance as diff_rollout_bridge.
      if (js.samples.length !== rs.samples.length) {
        throw new Error(sc.name + ' op ' + op + ': sample count mismatch');
      }
      for (let f = 0; f < js.samples.length; f++) {
        const a = js.samples[f], b = rs.samples[f];
        const pe = Math.hypot(a.x - b.x, a.y - b.y);
        const ae = Math.abs(a.rot - b.rot);
        if (pe > maxPos) { maxPos = pe; maxPosAt = 'op ' + op + ' frame ' + f; }
        if (ae > maxAng) maxAng = ae;
      }
      totalOpsCompared++;
      totalFramesCompared += js.perFrameScores.length;
    }

    console.log('scene            :', sc.name);
    console.log('  ops compared   :', ops.length);
    console.log('  frames compared:', jsResults[0] ? jsResults[0].perFrameScores.length : 0);
    console.log('  max position err:', maxPos.toExponential(9), 'm at', maxPosAt);
    console.log('  max angle err   :', maxAng.toExponential(9));
    console.log('  max per-frame err:', maxScore.toExponential(9), 'at', maxScoreAt);
    console.log('  max total err    :', maxTotal.toExponential(9));
    if (maxPos > POS_TOL || maxAng > ANG_TOL || maxScore > 1e-9 || maxTotal > 1e-9) {
      throw new Error(sc.name + ': comparison failed');
    }
  }

  // Fallback checks: unsupported configs must return null so rolloutNine can
  // fall back to VantageScoring.scorePaths.
  const prep0 = prepared[0];
  const laneCfg = Object.assign({}, cfg, { lanePenaltyRatio: 0.5 });
  if (prep0.adapter.simulateTankBatchScored(startPose, ops, frames,
      { startPose, threats: prep0.threats, tGlobal: 0, cfg: laneCfg }) !== null) {
    throw new Error('lane>0 must return null from simulateTankBatchScored');
  }
  const springCfg = Object.assign({}, cfg, { springRopeEnabled: true });
  if (prep0.adapter.simulateTankBatchScored(startPose, ops, frames,
      { startPose, threats: prep0.threats, tGlobal: 0, cfg: springCfg }) !== null) {
    throw new Error('spring rope enabled must return null from simulateTankBatchScored');
  }
  console.log('scene            : unsupported config fallback');
  console.log('  lane>0 / spring rope returned null: PASS');

  if (rustWarnCount !== 0) {
    throw new Error('Rust scored path emitted ' + rustWarnCount + ' fallback warning(s)');
  }

  VantageSandbox.setRustPhysicsEnabled(false);
  console.log('total compared  : ' + totalOpsCompared + ' ops, ' + totalFramesCompared + ' scored frames');
  console.log('DIFF SCORE PATHS BRIDGE PASSED');
}

main().catch((e) => {
  console.error('diff_score_paths_bridge.js error:', (e && e.stack) || e);
  process.exitCode = 2;
});
