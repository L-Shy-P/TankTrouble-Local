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
const crateDir = path.join(root, 'rust', 'vantage_core');
const scenePath = path.join(os.tmpdir(), 'vantage_rollout_scenes.json');

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

function bulletInputFromFake(projectile) {
  const rb = projectile.getB2DBody();
  const p = rb.GetPosition();
  const v = rb.GetLinearVelocity();
  const radius = rb.GetFixtureList().GetShape().m_radius;
  return {
    x: p.x,
    y: p.y,
    vx: v.x,
    vy: v.y,
    radius: radius,
    lifeLeft: projectile.lifetime - projectile.getTimeAlive(),
    active: true,
  };
}

function buildScene(maze, startPose, ops, bullets, frames, cacheId) {
  return {
    walls: extractWallPolygons(globalSandbox, maze),
    startPose: startPose,
    ops: ops,
    bullets: bullets,
    frames: frames,
    cacheId: cacheId || 0,
  };
}

// ---------------------------------------------------------------------------
// Rust CLI
// ---------------------------------------------------------------------------
function runRustScenes(scenes) {
  fs.writeFileSync(scenePath, JSON.stringify({ scenes: scenes }));
  const cmd = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const env = Object.assign({}, process.env);
  const cargoBin = path.join(process.env.USERPROFILE || '', '.cargo', 'bin');
  env.PATH = cargoBin + path.delimiter + (env.PATH || '');
  const res = spawnSync(cmd, ['run', '--quiet', '--bin', 'rollout_trace', '--', scenePath], {
    cwd: crateDir,
    encoding: 'utf8',
    shell: false,
    env: env,
  });
  if (res.status !== 0) {
    throw new Error(
      'cargo run failed (' + res.status + ')\nstdout:\n' + res.stdout + '\nstderr:\n' + res.stderr
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
function compareScene(name, jsResults, rustResult) {
  if (!rustResult.ok) {
    throw new Error('[' + name + '] Rust scene failed');
  }
  if (jsResults.length !== rustResult.samples.length) {
    throw new Error(
      '[' + name + '] op count mismatch: JS=' + jsResults.length +
      ', Rust=' + rustResult.samples.length
    );
  }

  let maxPosError = 0;
  let maxAngError = 0;
  let maxPosAt = '';
  let maxAngAt = '';
  let mismatchCount = 0;

  for (let op = 0; op < jsResults.length; op++) {
    const js = jsResults[op];
    const rs = rustResult.samples[op];
    if (js.samples.length !== rs.length) {
      throw new Error(
        '[' + name + '] sample count mismatch op ' + op + ': JS=' + js.samples.length +
        ', Rust=' + rs.length
      );
    }
    for (let f = 0; f < js.samples.length; f++) {
      const j = js.samples[f];
      const r = rs[f];
      const dx = Math.abs(j.x - r.x);
      const dy = Math.abs(j.y - r.y);
      const posErr = Math.hypot(dx, dy);
      const angErr = Math.abs(j.rot - r.rot);
      if (posErr > maxPosError) {
        maxPosError = posErr;
        maxPosAt = 'op ' + op + ' frame ' + f;
      }
      if (angErr > maxAngError) {
        maxAngError = angErr;
        maxAngAt = 'op ' + op + ' frame ' + f;
      }
      if ((posErr > POS_TOL || angErr > ANG_TOL) && mismatchCount < 5) {
        mismatchCount++;
        console.log(
          '  MISMATCH op ' + op + ' frame ' + f +
          ' js=(' + j.x.toFixed(12) + ',' + j.y.toFixed(12) + ',' + j.rot.toFixed(12) + ')' +
          ' rust=(' + r.x.toFixed(12) + ',' + r.y.toFixed(12) + ',' + r.rot.toFixed(12) + ')' +
          ' posErr=' + posErr.toExponential(6) + ' angErr=' + angErr.toExponential(6)
        );
      }
    }
    if (js.dead !== !!rustResult.dead[op]) {
      throw new Error(
        '[' + name + '] dead mismatch op ' + op + ': JS=' + js.dead +
        ', Rust=' + rustResult.dead[op]
      );
    }
    if (js.deathFrame !== rustResult.deathFrame[op]) {
      throw new Error(
        '[' + name + '] deathFrame mismatch op ' + op + ': JS=' + js.deathFrame +
        ', Rust=' + rustResult.deathFrame[op]
      );
    }
  }

  const posOk = maxPosError <= POS_TOL;
  const angOk = maxAngError <= ANG_TOL;
  console.log('scene            :', name);
  console.log('  ops compared   :', jsResults.length);
  console.log('  samples per op :', jsResults[0].samples.length);
  console.log('  max position err:', maxPosError.toExponential(9), 'm at', maxPosAt);
  console.log('  max angle err   :', maxAngError.toExponential(9), 'rad at', maxAngAt);
  console.log('  position ' + POS_TOL + ' :', posOk ? 'PASS' : 'FAIL');
  console.log('  angle ' + ANG_TOL + '    :', angOk ? 'PASS' : 'FAIL');
  return posOk && angOk;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let globalSandbox = null;

function main() {
  globalSandbox = loadSandbox();
  const Box2D = globalSandbox.Box2D;
  const Constants = globalSandbox.Constants;
  const VantageSandbox = globalSandbox.VantageSandbox;
  if (!VantageSandbox) throw new Error('VantageSandbox was not defined');

  const startPoseA = { x: 10.0, y: 15.0, rot: 0.0 };
  const adapterOps = VantageSandbox.OPERATIONS;

  // Fake tank and maze. A 4x3 tile arena gives a 40m x 30m floor.
  const maze = makeMaze(4, 3);
  const tank = makeFakeTank(Box2D, startPoseA.x, startPoseA.y, startPoseA.rot);
  const projectiles = {};
  const gameController = makeGameController(maze, tank, projectiles);
  const adapter = VantageSandbox.createAdapter(gameController, 'p0');

  const allOps = computeOpSpeeds({ operations: adapterOps });
  const rustScenes = [];

  // Scene a: free motion with boundary walls, no bullets, all 9 ops, 75 frames.
  let jsResults = adapter.simulateTankBatch(startPoseA, adapterOps, 75, {
    startPose: startPoseA,
    threats: [],
    tGlobal: 0,
  });
  rustScenes.push(buildScene(maze, startPoseA, allOps, [], 75, 1));

  // Scene b: head-on bullet at tGlobal=0.
  const bulletB = makeFakeProjectile(Box2D, Constants, 5.0, 12.0, 0.0, -18.0, 0.25);
  const projectilesB = { b1: bulletB };
  const adapterB = VantageSandbox.createAdapter(
    makeGameController(maze, makeFakeTank(Box2D, 5.0, 8.0, 0.0), projectilesB),
    'p0'
  );
  const startPoseB = { x: 5.0, y: 8.0, rot: 0.0 };
  jsResults = adapterB.simulateTankBatch(startPoseB, adapterOps, 75, {
    startPose: startPoseB,
    threats: [],
    tGlobal: 0,
  });
  rustScenes.push(buildScene(maze, startPoseB, allOps, [bulletInputFromFake(bulletB)], 75, 2));

  // Scene c: tGlobal=0.5 placement from the adapter's own bullet track.
  const bulletC = makeFakeProjectile(Box2D, Constants, 5.0, 12.0, 0.0, -18.0, 0.25);
  const projectilesC = { c1: bulletC };
  const adapterC = VantageSandbox.createAdapter(
    makeGameController(maze, makeFakeTank(Box2D, 5.0, 4.0, 0.0), projectilesC),
    'p0'
  );
  const startPoseC = { x: 5.0, y: 4.0, rot: 0.0 };
  const tracks = adapterC.simulateBulletTracks(75);
  if (!tracks || !tracks.length || !tracks[0].frames.length) {
    throw new Error('scene c: simulateBulletTracks returned no track');
  }
  const trackC = tracks[0].frames;
  const qC = 0.5;
  const idxC = Math.round(qC / 0.02);
  const sNow = trackC[idxC];
  const sNext = trackC[idxC + 1];
  if (!sNow || sNow.alive === false || !sNext || sNext.alive === false) {
    throw new Error('scene c: track does not cover tGlobal=0.5');
  }
  const dirC = { x: sNext.x - sNow.x, y: sNext.y - sNow.y };
  const dirLenC = Math.hypot(dirC.x, dirC.y);
  const speedC = 18.0;
  const rustBulletC = {
    x: sNow.x,
    y: sNow.y,
    vx: dirC.x / dirLenC * speedC,
    vy: dirC.y / dirLenC * speedC,
    radius: 0.25,
    lifeLeft: bulletC.lifetime - qC,
    active: true,
  };
  jsResults = adapterC.simulateTankBatch(startPoseC, adapterOps, 75, {
    startPose: startPoseC,
    threats: [{ id: 'c1', track: trackC, anchorOffset: 0, speed: speedC }],
    tGlobal: 0.5,
  });
  rustScenes.push(buildScene(maze, startPoseC, allOps, [rustBulletC], 75, 3));

  // Scene d: oblique bullet wall-bounce and at least one candidate death.
  const mazeD = makeMaze(4, 3);
  const bulletD = makeFakeProjectile(Box2D, Constants, 5.0, 10.0, 10.0, 18.0, 0.25);
  const projectilesD = { d1: bulletD };
  const adapterD = VantageSandbox.createAdapter(
    makeGameController(mazeD, makeFakeTank(Box2D, 15.0, 25.0, 0.0), projectilesD),
    'p0'
  );
  const startPoseD = { x: 15.0, y: 25.0, rot: 0.0 };
  jsResults = adapterD.simulateTankBatch(startPoseD, adapterOps, 75, {
    startPose: startPoseD,
    threats: [],
    tGlobal: 0,
  });
  if (!jsResults.some((r) => r.dead)) {
    throw new Error('scene d: expected at least one candidate death in JS');
  }
  rustScenes.push(buildScene(mazeD, startPoseD, allOps, [bulletInputFromFake(bulletD)], 75, 4));

  // Scene f: rotated tank backing into the bottom wall. Regression for the
  // JS TOI target quirk (`0.02 * totalRadius`, not `0.02 * separation`).
  const startPoseF = { x: 25.0, y: 25.0, rot: -0.2 };
  const adapterF = VantageSandbox.createAdapter(
    makeGameController(maze, makeFakeTank(Box2D, startPoseF.x, startPoseF.y, startPoseF.rot), {}),
    'p0'
  );
  const jsF = adapterF.simulateTankBatch(startPoseF, adapterOps, 40, {
    startPose: startPoseF,
    threats: [],
    tGlobal: 0,
  });
  rustScenes.push(buildScene(maze, startPoseF, allOps, [], 40, 6));

  // Scene e: two consecutive identical calls on the same adapter (warm-start).
  const startPoseE = { x: 8.0, y: 15.0, rot: 0.3 };
  const bulletE = makeFakeProjectile(Box2D, Constants, 7.0, 13.0, -3.0, -6.0, 0.25);
  const projectilesE = { e1: bulletE };
  const adapterE = VantageSandbox.createAdapter(
    makeGameController(maze, makeFakeTank(Box2D, startPoseE.x, startPoseE.y, startPoseE.rot), projectilesE),
    'p0'
  );
  const jsE1 = adapterE.simulateTankBatch(startPoseE, adapterOps, 75, {
    startPose: startPoseE,
    threats: [],
    tGlobal: 0,
  });
  const jsE2 = adapterE.simulateTankBatch(startPoseE, adapterOps, 75, {
    startPose: startPoseE,
    threats: [],
    tGlobal: 0,
  });
  const bulletEInput = bulletInputFromFake(bulletE);
  rustScenes.push(buildScene(maze, startPoseE, allOps, [bulletEInput], 75, 5));
  rustScenes.push(buildScene(maze, startPoseE, allOps, [bulletEInput], 75, 5));

  // Rust runs all scenes sequentially in one process (persistent cache).
  const rustResults = runRustScenes(rustScenes);
  if (rustResults.length !== rustScenes.length) {
    throw new Error(
      'scene count mismatch: JS=' + rustScenes.length + ', Rust=' + rustResults.length
    );
  }

  const allJs = [
    adapter.simulateTankBatch(startPoseA, adapterOps, 75, {
      startPose: startPoseA,
      threats: [],
      tGlobal: 0,
    }),
    adapterB.simulateTankBatch(startPoseB, adapterOps, 75, {
      startPose: startPoseB,
      threats: [],
      tGlobal: 0,
    }),
    adapterC.simulateTankBatch(startPoseC, adapterOps, 75, {
      startPose: startPoseC,
      threats: [{ id: 'c1', track: trackC, anchorOffset: 0, speed: speedC }],
      tGlobal: 0.5,
    }),
    adapterD.simulateTankBatch(startPoseD, adapterOps, 75, {
      startPose: startPoseD,
      threats: [],
      tGlobal: 0,
    }),
    jsF,
    jsE1,
    jsE2,
  ];
  const names = [
    'a free motion, no bullets',
    'b head-on bullet tGlobal=0',
    'c bullet track tGlobal=0.5',
    'd oblique bullet wall-slide + death',
    'f rotated back into bottom wall (TOI target quirk)',
    'e1 persistent warm-start call 1',
    'e2 persistent warm-start call 2',
  ];

  let allOk = true;
  for (let i = 0; i < allJs.length; i++) {
    const ok = compareScene(names[i], allJs[i], rustResults[i]);
    allOk = allOk && ok;
    console.log('');
  }

  try {
    fs.unlinkSync(scenePath);
  } catch (_) {
    // Best-effort cleanup only.
  }

  if (!allOk) {
    console.error('DIFF ROLLOUT FAILED');
    process.exitCode = 1;
  } else {
    console.log('DIFF ROLLOUT PASSED');
  }
}

try {
  main();
} catch (e) {
  console.error('diff_rollout.js error:', (e && e.stack) || e);
  process.exitCode = 2;
}
