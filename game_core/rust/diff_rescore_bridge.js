#!/usr/bin/env node
// Differential test: real JS `VantageScoring.scorePaths` reference (over a
// real fused batch) vs the in-game Rust/WASM incremental rescore path
// (`adapter.rescoreTankSamples` behind
// VantageSandbox.setRustPhysicsEnabled(true)).
//
// This exercises the exact browser hot-path wiring: stored rolloutSamples are
// rescored by vt_rescore_nodes (ABI v3) through VantageRustBridge, and the
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
    return {
      ok: true,
      arrayBuffer: async function () {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  };
  vm.runInContext(fs.readFileSync(bridgePath, 'utf8'), sandbox._ctx, { filename: bridgePath });
  globalBridge = sandbox.VantageRustBridge;

  const Box2D = sandbox.Box2D;
  const Constants = sandbox.Constants;
  const VantageSandbox = sandbox.VantageSandbox;
  const VantageScoring = sandbox.VantageScoring;
  if (!VantageSandbox) throw new Error('VantageSandbox was not defined');
  if (!VantageScoring) throw new Error('VantageScoring was not defined');

  const ops = VantageSandbox.OPERATIONS;
  const frames = 75;
  const cfg = {
    deathPenalty: 0,
    stuckPenalty: 4.0,
    stuckDistEps: 0.05,
    stuckRotEps: 0.05,
    lanePenaltyRatio: 0,
    springRopeEnabled: false,
  };

  const maze = makeMaze(4, 3);
  const startPose = { x: 5.0, y: 8.0, rot: 0.0 };
  const tank = makeFakeTank(Box2D, startPose.x, startPose.y, startPose.rot);
  const bullet = makeFakeProjectile(Box2D, Constants, 5.0, 12.0, 0.0, -18.0, 0.25);
  const projectiles = { b1: bullet };
  const adapter = VantageSandbox.createAdapter(
    makeGameController(maze, tank, projectiles), 'p0'
  );

  // Build the same Box2D bullet track the tree would use for threats, then
  // obtain the REAL JS fused batch while Rust physics is still disabled.
  const tracks = adapter.simulateBulletTracks(frames);
  if (!tracks || !tracks.length || !tracks[0].frames.length) {
    throw new Error('simulateBulletTracks returned no track');
  }
  const track = tracks[0].frames;
  const threats = [{
    id: 'b1',
    track: track,
    anchorOffset: 0,
    speed: 18.0,
    bulletRadius: 0.25,
    lifeLeftSeconds: 10,
  }];
  const opt = { startPose, threats: threats, tGlobal: 0 };
  const fusedBatch = adapter.simulateTankBatch(startPose, ops, frames, opt);

  // Performance reference: warm JS fused batch average (3 calls) on the same
  // 9-node x 76-sample x 1-threat scene, measured BEFORE Rust is enabled.
  let fusedMs = 0;
  for (let t = 0; t < 3; t++) {
    const t0 = performance.now();
    adapter.simulateTankBatch(startPose, ops, frames, opt);
    fusedMs += performance.now() - t0;
  }
  fusedMs /= 3;

  const init = await globalBridge.init('js/wasm/vantage_core.wasm');
  if (!init.ok) throw new Error('bridge init failed: ' + init.error);
  if (globalBridge.version() !== 3) {
    throw new Error('expected wasm ABI v3, got ' + globalBridge.version());
  }
  VantageSandbox.setRustPhysicsEnabled(true);

  // Stored samples = the real fused trajectory, by reference.
  const nodes = fusedBatch.map((r, j) => ({
    samples: r.samples,
    moving: isMovingInputs(ops[j].inputs),
    startT: 0,
    frames: frames,
  }));

  // a. New hot-path call.
  const rustRescore1 = adapter.rescoreTankSamples(nodes, threats, cfg);
  if (!rustRescore1) throw new Error('adapter.rescoreTankSamples returned null on the first call');

  // b. JS reference with a fake adapter returning the stored batch instantly.
  const fakeAdapter = {
    constants: adapter.constants,
    bulletPosAt: function (path, speed, timeSec) {
      return adapter.bulletPosAt(path, speed, timeSec);
    },
    simulateTankBatch: function () {
      return fusedBatch;
    },
  };
  const jsResults = VantageScoring.scorePaths(
    fakeAdapter,
    { tank: startPose, tGlobal: 0 },
    ops,
    frames,
    threats,
    cfg
  );

  if (rustRescore1.length !== jsResults.length) {
    throw new Error(
      'result count mismatch: Rust=' + rustRescore1.length + ', JS=' + jsResults.length
    );
  }

  let maxScoreError = 0;
  let maxScoreAt = '';
  let maxTotalError = 0;
  let maxTotalAt = '';
  let mismatchCount = 0;
  for (let op = 0; op < jsResults.length; op++) {
    const js = jsResults[op];
    const rs = rustRescore1[op];
    if (!rs) throw new Error('Rust rescore missing op ' + op);

    // Sample identity and length must be preserved exactly.
    if (rs.samples !== nodes[op].samples) {
      throw new Error('op ' + op + ': Rust rescore did not preserve sample identity');
    }
    if (rs.samples.length !== fusedBatch[op].samples.length) {
      throw new Error(
        'op ' + op + ': sample length mismatch: Rust=' + rs.samples.length +
        ', fused=' + fusedBatch[op].samples.length
      );
    }

    if (js.perFrameScores.length !== rs.perFrameScores.length) {
      throw new Error(
        'op ' + op + ': per-frame score count mismatch: JS=' + js.perFrameScores.length +
        ', Rust=' + rs.perFrameScores.length
      );
    }
    for (let f = 0; f < js.perFrameScores.length; f++) {
      const err = Math.abs(js.perFrameScores[f] - rs.perFrameScores[f]);
      if (err > maxScoreError) {
        maxScoreError = err;
        maxScoreAt = 'op ' + op + ' frame ' + (f + 1);
      }
      if (err > 1e-9 && mismatchCount < 5) {
        mismatchCount++;
        console.log(
          '  SCORE MISMATCH op ' + op + ' frame ' + (f + 1) +
          ' js=' + js.perFrameScores[f].toFixed(15) +
          ' rust=' + rs.perFrameScores[f].toFixed(15) +
          ' err=' + err.toExponential(6)
        );
      }
    }
    const totalErr = Math.abs(js.totalScore - rs.totalScore);
    if (totalErr > maxTotalError) {
      maxTotalError = totalErr;
      maxTotalAt = 'op ' + op;
    }
    if (js.deathFrame !== rs.deathFrame) {
      throw new Error(
        'op ' + op + ': deathFrame mismatch: JS=' + js.deathFrame +
        ', Rust=' + rs.deathFrame
      );
    }
  }

  console.log('scene            : bridge rescore head-on bullet');
  console.log('  ops compared   :', jsResults.length);
  console.log('  frames compared:', jsResults[0] ? jsResults[0].perFrameScores.length : 0);
  console.log('  sample identity/length: PASS');
  console.log('  max per-frame err:', maxScoreError.toExponential(9), 'at', maxScoreAt);
  console.log('  max total err    :', maxTotalError.toExponential(9), 'at', maxTotalAt);
  console.log('  per-frame 1e-9   :', maxScoreError <= 1e-9 ? 'PASS' : 'FAIL');
  console.log('  total 1e-9       :', maxTotalError <= 1e-9 ? 'PASS' : 'FAIL');
  console.log('  deathFrame exact : PASS');
  if (maxScoreError > 1e-9 || maxTotalError > 1e-9) {
    throw new Error('bridge rescore score comparison failed');
  }

  // Warm persistence: same cache id, same nodes/threats -> identical scores.
  const rustRescore2 = adapter.rescoreTankSamples(nodes, threats, cfg);
  if (!rustRescore2) throw new Error('adapter.rescoreTankSamples returned null on the warm call');
  for (let op = 0; op < nodes.length; op++) {
    const a = rustRescore1[op];
    const b = rustRescore2[op];
    if (a.deathFrame !== b.deathFrame || a.totalScore !== b.totalScore ||
        JSON.stringify(a.perFrameScores) !== JSON.stringify(b.perFrameScores)) {
      throw new Error('warm persistence mismatch op ' + op);
    }
  }
  console.log('scene            : warm persistence');
  console.log('  calls compared : 2');
  console.log('  identical       : PASS');

  // Performance: 1 warmup + 3 timed real-wasm rescore calls.
  adapter.rescoreTankSamples(nodes, threats, cfg);
  let rescoreMs = 0;
  for (let t = 0; t < 3; t++) {
    const t0 = performance.now();
    adapter.rescoreTankSamples(nodes, threats, cfg);
    rescoreMs += performance.now() - t0;
  }
  rescoreMs /= 3;
  console.log('perf             : rescoreTankSamples avg ' + rescoreMs.toFixed(3) +
    ' ms, fused simulateTankBatch avg ' + fusedMs.toFixed(3) + ' ms');

  // Spring rope enabled must make the adapter return null (tree would fall back).
  const cfgSpring = Object.assign({}, cfg, { springRopeEnabled: true });
  const springResult = adapter.rescoreTankSamples(nodes, threats, cfgSpring);
  if (springResult !== null) {
    throw new Error('spring rope enabled must return null from rescoreTankSamples');
  }
  console.log('scene            : spring rope fallback');
  console.log('  rescoreTankSamples returned null (JS fallback path would be used): PASS');

  VantageSandbox.setRustPhysicsEnabled(false);
  console.log('DIFF RESCORE BRIDGE PASSED');
}

main().catch((e) => {
  console.error('diff_rescore_bridge.js error:', (e && e.stack) || e);
  process.exitCode = 2;
});
