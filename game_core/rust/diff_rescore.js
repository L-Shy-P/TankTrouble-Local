#!/usr/bin/env node
// Differential test: real game JS `simulateFusedBatch` vs
// vantage_core::rollout `run_rollout_batch` (Rust/WASM path).
//
// Runs the REAL `adapter.simulateTankBatch` through the real VantageSandbox
// modules in a Node vm and compares every op, every sample, and death data
// against the Rust `rollout_trace` binary.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const jsBox2D = path.join(root, 'js', 'f1a5ef972c273fb89a098cb50b0f22e7.js');
const jsBundle = path.join(root, 'js', 'b714588dc4621fe104113111ba90b1a7.js');
const jsTactics = path.join(root, 'js', 'ai_tactics.js');
const jsSandbox = path.join(root, 'js', 'vantage_sandbox.js');
const jsScoring = path.join(root, 'js', 'vantage_scoring.js');
const crateDir = path.join(root, 'rust', 'vantage_core');
const scenePath = path.join(os.tmpdir(), 'vantage_rescore_scenes.json');

const POS_TOL = 1e-9;
const ANG_TOL = 1e-9;

// ---------------------------------------------------------------------------
// VM loading (same recipe as the browser / diff_box2d)
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

  // d/e. Real AI tactics and VantageSandbox modules.
  vm.runInContext(fs.readFileSync(jsTactics, 'utf8'), ctx, { filename: jsTactics });
  vm.runInContext(fs.readFileSync(jsSandbox, 'utf8'), ctx, { filename: jsSandbox });
  vm.runInContext(fs.readFileSync(jsScoring, 'utf8'), ctx, { filename: jsScoring });

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
    // Exact Tank class formulas with modifier 1.0.
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

function makeMaze(W, H, extraTopWalls, extraLeftWalls) {
  const tiles = [];
  for (let i = 0; i < W; i++) {
    tiles[i] = [];
    for (let j = 0; j < H; j++) {
      tiles[i][j] = [1, j === 0 ? 1 : 0, i === 0 ? 1 : 0];
    }
  }
  if (extraTopWalls) {
    for (const [i, j] of extraTopWalls) tiles[i][j][1] = 1;
  }
  if (extraLeftWalls) {
    for (const [i, j] of extraLeftWalls) tiles[i][j][2] = 1;
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

// ---------------------------------------------------------------------------
// Wall polygon extraction (exact polygons the JS createMaze uses)
// ---------------------------------------------------------------------------
function extractWallPolygons(sandbox, maze) {
  const Box2D = sandbox.Box2D;
  const B2DUtils = sandbox.B2DUtils;
  const Constants = sandbox.Constants;
  const b2Vec2 = Box2D.Common.Math.b2Vec2;
  const world = new Box2D.Dynamics.b2World(new b2Vec2(0, 0), true);
  B2DUtils.createMaze(world, maze);

  const collected = [];
  for (let b = world.GetBodyList(); b; b = b.GetNext()) {
    for (let f = b.GetFixtureList(); f; f = f.GetNext()) {
      if (f.GetFilterData().categoryBits & Constants.COLLISION_CATEGORIES.MAZE) {
        const shape = f.GetShape();
        const verts = [];
        for (let k = 0; k < shape.m_vertexCount; k++) {
          const v = shape.m_vertices[k];
          verts.push([v.x, v.y]);
        }
        collected.push({ verts: verts });
      }
    }
  }
  // Body/fixture lists are prepended in this Box2D revision; reverse to get
  // creation order so Rust builds walls in exactly the same order.
  return collected.reverse();
}

// ---------------------------------------------------------------------------
// Scene construction
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Scene construction (rescore-specific)
// ---------------------------------------------------------------------------
function computeOpSpeeds(adapter) {
  return adapter.operations.map((op) => {
    const f = !!op.inputs.forward;
    const b = !!op.inputs.back;
    const l = !!op.inputs.left;
    const r = !!op.inputs.right;
    return {
      speed: (f ? 15.95 : 0) + (b ? -12.8 : 0),
      rotationSpeed: (l ? -5.0 : 0) + (r ? 5.0 : 0),
    };
  });
}

function isMovingInputs(inputs) {
  return !!(inputs && (inputs.forward || inputs.back || inputs.left || inputs.right));
}

function makeFakeScoreAdapter(realAdapter, batch) {
  return {
    constants: realAdapter.constants,
    bulletPosAt: function (path, speed, timeSec) {
      return realAdapter.bulletPosAt(path, speed, timeSec);
    },
    simulateTankBatch: function () {
      return batch;
    },
  };
}

function batchToNodes(batch, ops, startT, frames) {
  return batch.map((r, j) => ({
    samples: r.samples.map((s) => [s.x, s.y, s.rot]),
    moving: isMovingInputs(ops[j].inputs),
    startT: startT,
    frames: frames,
  }));
}

function threatToJson(th) {
  const o = {
    id: th.id,
    speed: th.speed || 0,
    anchorOffset: th.anchorOffset || 0,
    bulletRadius: th.bulletRadius || 0.25,
    lifeLeftSeconds: th.lifeLeftSeconds !== undefined ? th.lifeLeftSeconds : 10,
  };
  if (th.track) {
    o.track = th.track.map((f) => [f.x, f.y, f.alive !== false]);
  }
  if (th.path) {
    o.path = th.path.map((p) => [p.x, p.y]);
  }
  return o;
}

function buildRescoreScene(cacheId, maze, batch, ops, threats, startT, frames, cfg) {
  return {
    cacheId: cacheId,
    walls: extractWallPolygons(globalSandbox, maze),
    nodes: batchToNodes(batch, ops, startT, frames),
    threats: threats.map(threatToJson),
    cfg: {
      deathPenalty: cfg.deathPenalty,
      stuckPenalty: cfg.stuckPenalty,
      stuckDistEps: cfg.stuckDistEps,
      stuckRotEps: cfg.stuckRotEps,
      lanePenaltyRatio: cfg.lanePenaltyRatio,
      springRopeEnabled: cfg.springRopeEnabled,
    },
  };
}

function buildManualScene(cacheId, maze, batch, ops, threats, startT, frames, cfg) {
  return buildRescoreScene(cacheId, maze, batch, ops, threats, startT, frames, cfg);
}

// ---------------------------------------------------------------------------
// Rust CLI
// ---------------------------------------------------------------------------
function runRustRescore(scenes) {
  fs.writeFileSync(scenePath, JSON.stringify({ scenes: scenes }));
  const cmd = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const env = Object.assign({}, process.env);
  const cargoBin = path.join(process.env.USERPROFILE || '', '.cargo', 'bin');
  env.PATH = cargoBin + path.delimiter + (env.PATH || '');
  const res = spawnSync(cmd, ['run', '--quiet', '--bin', 'rescore_trace', '--', scenePath], {
    cwd: crateDir,
    encoding: 'utf8',
    shell: false,
    env: env,
  });
  if (res.status !== 0) {
    throw new Error(
      'cargo run rescore_trace failed (' + res.status + ')\nstdout:\n' + res.stdout +
      '\nstderr:\n' + res.stderr
    );
  }
  const stdout = (res.stdout || '').trim();
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const jsonLine = lines[lines.length - 1];
  return JSON.parse(jsonLine);
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------
function compareRescoreScene(name, jsResults, rustNodes, batchDeath) {
  if (!Array.isArray(rustNodes)) {
    throw new Error('[' + name + '] Rust result has no nodes array');
  }
  if (jsResults.length !== rustNodes.length) {
    throw new Error(
      '[' + name + '] op count mismatch: JS=' + jsResults.length +
      ', Rust=' + rustNodes.length
    );
  }

  let maxScoreError = 0;
  let maxScoreAt = '';
  let maxTotalError = 0;
  let maxTotalAt = '';
  let mismatchCount = 0;

  for (let op = 0; op < jsResults.length; op++) {
    const js = jsResults[op];
    const rs = rustNodes[op];
    if (!rs.ok) {
      throw new Error('[' + name + '] Rust node ' + op + ' reported ok=false');
    }
    if (js.perFrameScores.length !== rs.perFrameScores.length) {
      throw new Error(
        '[' + name + '] per-frame score count mismatch op ' + op +
        ': JS=' + js.perFrameScores.length + ', Rust=' + rs.perFrameScores.length
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
        '[' + name + '] deathFrame mismatch op ' + op +
        ': JS=' + js.deathFrame + ', Rust=' + rs.deathFrame
      );
    }
    if (batchDeath && batchDeath[op].deathFrame !== rs.deathFrame) {
      throw new Error(
        '[' + name + '] deathFrame vs real fused batch mismatch op ' + op +
        ': batch=' + batchDeath[op].deathFrame + ', Rust=' + rs.deathFrame
      );
    }
  }

  const scoreOk = maxScoreError <= 1e-9;
  const totalOk = maxTotalError <= 1e-9;
  console.log('scene            :', name);
  console.log('  ops compared   :', jsResults.length);
  console.log('  frames compared:', jsResults[0] ? jsResults[0].perFrameScores.length : 0);
  console.log('  max per-frame err:', maxScoreError.toExponential(9), 'at', maxScoreAt);
  console.log('  max total err    :', maxTotalError.toExponential(9), 'at', maxTotalAt);
  console.log('  per-frame 1e-9   :', scoreOk ? 'PASS' : 'FAIL');
  console.log('  total 1e-9       :', totalOk ? 'PASS' : 'FAIL');
  console.log('  deathFrame exact : PASS');
  return scoreOk && totalOk;
}

function checkNoDangerSteps(name, rustNodes) {
  for (let op = 0; op < rustNodes.length; op++) {
    const rs = rustNodes[op];
    if (!rs.ok) throw new Error('[' + name + '] node ' + op + ' ok=false');
    if (rs.deathFrame !== -1) {
      throw new Error('[' + name + '] node ' + op + ' deathFrame=' + rs.deathFrame);
    }
    if (rs.verifiedFrames !== 0) {
      throw new Error('[' + name + '] node ' + op + ' verifiedFrames=' + rs.verifiedFrames);
    }
  }
  console.log('scene            :', name);
  console.log('  danger steps   : 0 for all nodes');
  console.log('  deathFrame     : -1 for all nodes');
  console.log('  zero world steps: PASS');
  return true;
}

function checkSpringUnsupported(name, rustNodes) {
  for (let op = 0; op < rustNodes.length; op++) {
    const rs = rustNodes[op];
    if (rs.ok !== false) {
      throw new Error('[' + name + '] expected ok=false, got ' + rs.ok);
    }
  }
  console.log('scene            :', name);
  console.log('  expected ok=false (spring rope unsupported): PASS');
  return true;
}
let globalSandbox = null;

function main() {
  globalSandbox = loadSandbox();
  const Box2D = globalSandbox.Box2D;
  const Constants = globalSandbox.Constants;
  const VantageSandbox = globalSandbox.VantageSandbox;
  const VantageScoring = globalSandbox.VantageScoring;
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
  const rustScenes = [];
  const jsResults = [];
  const batchDeath = [];
  const names = [];

  // Scene a: head-on bullet, tGlobal=0, all 9 ops, 75 frames.
  const startPoseA = { x: 5.0, y: 8.0, rot: 0.0 };
  const tankA = makeFakeTank(Box2D, startPoseA.x, startPoseA.y, startPoseA.rot);
  const bulletA = makeFakeProjectile(Box2D, Constants, 5.0, 12.0, 0.0, -18.0, 0.25);
  const adapterA = VantageSandbox.createAdapter(
    makeGameController(maze, tankA, { a1: bulletA }), 'p0'
  );
  const realBatchA = adapterA.simulateTankBatch(startPoseA, ops, frames, {
    startPose: startPoseA,
    threats: [],
    tGlobal: 0,
  });
  const tracksA = adapterA.simulateBulletTracks(frames);
  if (!tracksA || !tracksA.length || !tracksA[0].frames.length) {
    throw new Error('scene a: simulateBulletTracks returned no track');
  }
  const trackA = tracksA[0].frames;
  const threatsA = [{
    id: 'a1',
    track: trackA,
    anchorOffset: 0,
    speed: 18.0,
    bulletRadius: 0.25,
    lifeLeftSeconds: 10,
  }];
  const jsA = VantageScoring.scorePaths(
    makeFakeScoreAdapter(adapterA, realBatchA),
    { tank: startPoseA, tGlobal: 0 },
    ops,
    frames,
    threatsA,
    cfg
  );
  rustScenes.push(buildRescoreScene(1, maze, realBatchA, ops, threatsA, 0, frames, cfg));
  jsResults.push(jsA);
  batchDeath.push(realBatchA);
  names.push('a head-on bullet tGlobal=0');

  // Scene b: tGlobal>0 with a threat.track.
  const startPoseB = { x: 5.0, y: 8.0, rot: 0.0 };
  const tankB = makeFakeTank(Box2D, startPoseB.x, startPoseB.y, startPoseB.rot);
  const bulletB = makeFakeProjectile(Box2D, Constants, 5.0, 12.0, 0.0, -18.0, 0.25);
  const adapterB = VantageSandbox.createAdapter(
    makeGameController(maze, tankB, { b1: bulletB }), 'p0'
  );
  const tGlobalB = 0.5;
  const tracksB = adapterB.simulateBulletTracks(Math.round(tGlobalB / 0.02) + frames + 5);
  if (!tracksB || !tracksB.length || !tracksB[0].frames.length) {
    throw new Error('scene b: simulateBulletTracks returned no track');
  }
  const trackB = tracksB[0].frames;
  const idxB = Math.round(tGlobalB / 0.02);
  if (!trackB[idxB] || !trackB[idxB + 1] || trackB[idxB].alive === false || trackB[idxB + 1].alive === false) {
    throw new Error('scene b: track does not cover tGlobal=0.5');
  }
  const realBatchB = adapterB.simulateTankBatch(startPoseB, ops, frames, {
    startPose: startPoseB,
    threats: [{ id: 'b1', track: trackB, anchorOffset: 0, speed: 18.0 }],
    tGlobal: tGlobalB,
  });
  const threatsB = [{
    id: 'b1',
    track: trackB,
    anchorOffset: 0,
    speed: 18.0,
    bulletRadius: 0.25,
    lifeLeftSeconds: 10,
  }];
  const jsB = VantageScoring.scorePaths(
    makeFakeScoreAdapter(adapterB, realBatchB),
    { tank: startPoseB, tGlobal: tGlobalB },
    ops,
    frames,
    threatsB,
    cfg
  );
  rustScenes.push(buildRescoreScene(2, maze, realBatchB, ops, threatsB, tGlobalB, frames, cfg));
  jsResults.push(jsB);
  batchDeath.push(realBatchB);
  names.push('b bullet track tGlobal=0.5');

  // Scene c: anchorOffset > 0 so q is negative in early frames.  The bullet
  // track is generated far from the tank so verification finds no death; this
  // scene isolates the anchor-offset scoring semantics.
  const startPoseC = { x: 5.0, y: 8.0, rot: 0.0 };
  const tankC = makeFakeTank(Box2D, startPoseC.x, startPoseC.y, startPoseC.rot);
  const bulletC = makeFakeProjectile(Box2D, Constants, 35.0, 2.0, 18.0, 0.0, 0.25);
  const adapterC = VantageSandbox.createAdapter(
    makeGameController(maze, tankC, { c1: bulletC }), 'p0'
  );
  const tracksC = adapterC.simulateBulletTracks(frames);
  if (!tracksC || !tracksC.length || !tracksC[0].frames.length) {
    throw new Error('scene c: simulateBulletTracks returned no track');
  }
  const trackC = tracksC[0].frames;
  const adapterNoBulletC = VantageSandbox.createAdapter(
    makeGameController(maze, makeFakeTank(Box2D, startPoseC.x, startPoseC.y, startPoseC.rot), {}),
    'p0'
  );
  const realBatchC = adapterNoBulletC.simulateTankBatch(startPoseC, ops, frames, {
    startPose: startPoseC,
    threats: [],
    tGlobal: 0,
  });
  const threatsC = [{
    id: 'c1',
    track: trackC,
    anchorOffset: 0.5,
    speed: 18.0,
    bulletRadius: 0.25,
    lifeLeftSeconds: 10,
  }];
  const jsC = VantageScoring.scorePaths(
    makeFakeScoreAdapter(adapterNoBulletC, realBatchC),
    { tank: startPoseC, tGlobal: 0 },
    ops,
    frames,
    threatsC,
    cfg
  );
  rustScenes.push(buildRescoreScene(3, maze, realBatchC, ops, threatsC, 0, frames, cfg));
  jsResults.push(jsC);
  batchDeath.push(null);
  names.push('c anchorOffset=0.5 track');

  // Scene d: rotated tank backing into the bottom wall, no bullets. Danger
  // filter must mark zero frames and the verification world must not step.
  const startPoseD = { x: 25.0, y: 25.0, rot: -0.2 };
  const adapterD = VantageSandbox.createAdapter(
    makeGameController(maze, makeFakeTank(Box2D, startPoseD.x, startPoseD.y, startPoseD.rot), {}),
    'p0'
  );
  const framesD = 40;
  const realBatchD = adapterD.simulateTankBatch(startPoseD, ops, framesD, {
    startPose: startPoseD,
    threats: [],
    tGlobal: 0,
  });
  const jsD = VantageScoring.scorePaths(
    makeFakeScoreAdapter(adapterD, realBatchD),
    { tank: startPoseD, tGlobal: 0 },
    ops,
    framesD,
    [],
    cfg
  );
  rustScenes.push(buildRescoreScene(4, maze, realBatchD, ops, [], 0, framesD, cfg));
  jsResults.push(jsD);
  batchDeath.push(null);
  names.push('d rotated tank backs into wall, no bullets');

  // Scene e: two consecutive rescore calls for the same cacheId. Scores and
  // death frames must be unchanged by warm persistence.
  rustScenes.push(buildRescoreScene(5, maze, realBatchA, ops, threatsA, 0, frames, cfg));
  rustScenes.push(buildRescoreScene(5, maze, realBatchA, ops, threatsA, 0, frames, cfg));

  // Scene f: spring rope enabled must report ok=false for every node.
  const cfgSpring = Object.assign({}, cfg, { springRopeEnabled: true });
  rustScenes.push(buildRescoreScene(6, maze, realBatchA, ops, threatsA, 0, frames, cfgSpring));

  const rustResults = runRustRescore(rustScenes);
  if (rustResults.length !== rustScenes.length) {
    throw new Error(
      'scene count mismatch: JS=' + rustScenes.length + ', Rust=' + rustResults.length
    );
  }

  let allOk = true;

  allOk = compareRescoreScene(names[0], jsResults[0], rustResults[0].nodes, batchDeath[0]) && allOk;
  console.log('');

  allOk = compareRescoreScene(names[1], jsResults[1], rustResults[1].nodes, batchDeath[1]) && allOk;
  console.log('');

  allOk = compareRescoreScene(names[2], jsResults[2], rustResults[2].nodes, null) && allOk;
  console.log('');

  allOk = compareRescoreScene(names[3], jsResults[3], rustResults[3].nodes, null) && allOk;
  allOk = checkNoDangerSteps('d zero-step check', rustResults[3].nodes) && allOk;
  console.log('');

  allOk = compareRescoreScene('e warm persistence call 1', jsResults[0], rustResults[4].nodes, batchDeath[0]) && allOk;
  allOk = compareRescoreScene('e warm persistence call 2', jsResults[0], rustResults[5].nodes, batchDeath[0]) && allOk;
  for (let op = 0; op < rustResults[4].nodes.length; op++) {
    const a = rustResults[4].nodes[op];
    const b = rustResults[5].nodes[op];
    if (a.deathFrame !== b.deathFrame || a.totalScore !== b.totalScore ||
        a.verifiedFrames !== b.verifiedFrames ||
        JSON.stringify(a.perFrameScores) !== JSON.stringify(b.perFrameScores)) {
      throw new Error('e warm persistence mismatch op ' + op);
    }
  }
  console.log('scene            : e warm persistence unchanged');
  console.log('  calls compared : 2');
  console.log('  identical       : PASS');
  console.log('');

  allOk = checkSpringUnsupported('f spring rope unsupported fallback', rustResults[6].nodes) && allOk;

  try {
    fs.unlinkSync(scenePath);
  } catch (_) {
    // Best-effort cleanup only.
  }

  if (!allOk) {
    console.error('DIFF RESCORE FAILED');
    process.exitCode = 1;
  } else {
    console.log('DIFF RESCORE PASSED');
  }
}

try {
  main();
} catch (e) {
  console.error('diff_rescore.js error:', (e && e.stack) || e);
  process.exitCode = 2;
}
