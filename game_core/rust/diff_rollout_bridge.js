#!/usr/bin/env node
// Differential test: real JS `simulateFusedBatch` vs the in-game Rust/WASM
// integration path (`VantageRustBridge.rolloutBatch` behind
// VantageSandbox.setRustPhysicsEnabled(true)).
//
// This exercises the exact browser hot-path wiring: adapter.simulateTankBatch
// uses the zero-frame fused pre-pass for bullet placement, extracts cached wall
// shapes, then calls the compiled vantage_core.wasm.

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
const bridgePath = path.join(root, 'js', 'vantage_rust_bridge.js');
const wasmPath = path.join(root, 'js', 'wasm', 'vantage_core.wasm');
const scenePath = path.join(os.tmpdir(), 'vantage_rollout_bridge_scenes.json');

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

  // The browser game also has local_patch.js, which supplies the polygon
  // shape GetVertex helper used by VantageSandbox.cloneFusedShape. This
  // Box2D revision only has GetVertices/GetVertexCount on b2PolygonShape.
  const b2PolygonShape = Box2D.Collision.Shapes.b2PolygonShape;
  if (b2PolygonShape && !b2PolygonShape.prototype.GetVertex) {
    b2PolygonShape.prototype.GetVertex = function (i) { return this.m_vertices[i]; };
  }

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
  const maze = makeMaze(4, 3, [], []);
  const startPose = { x: 5.0, y: 8.0, rot: 0.0 };
  const tank = makeFakeTank(Box2D, startPose.x, startPose.y, startPose.rot);
  const bullet = makeFakeProjectile(Box2D, Constants, 5.0, 12.0, 0.0, -18.0, 0.25);
  const projectiles = { b1: bullet };
  const adapter = VantageSandbox.createAdapter(makeGameController(maze, tank, projectiles), 'p0');
  const ops = VantageSandbox.OPERATIONS;

  const opt = { startPose, threats: [], tGlobal: 0 };
  const fused = adapter.simulateTankBatch(startPose, ops, 75, opt);

  const init = await globalBridge.init('js/wasm/vantage_core.wasm');
  if (!init.ok) throw new Error('bridge init failed: ' + init.error);
  VantageSandbox.setRustPhysicsEnabled(true);

  function compareBatch(name, fusedBatch, rustBatch) {
    let maxPos = 0, maxAng = 0, maxPosAt = '', maxAngAt = '';
    for (let op = 0; op < ops.length; op++) {
      if (fusedBatch[op].dead !== rustBatch[op].dead ||
          fusedBatch[op].deathFrame !== rustBatch[op].deathFrame) {
        throw new Error(name + ' death mismatch op ' + op +
          ' fused=' + fusedBatch[op].dead + '/' + fusedBatch[op].deathFrame +
          ' rust=' + rustBatch[op].dead + '/' + rustBatch[op].deathFrame);
      }
      for (let f = 0; f < fusedBatch[op].samples.length; f++) {
        const a = fusedBatch[op].samples[f], b = rustBatch[op].samples[f];
        const pe = Math.hypot(a.x - b.x, a.y - b.y);
        const ae = Math.abs(a.rot - b.rot);
        if (pe > maxPos) { maxPos = pe; maxPosAt = 'op ' + op + ' frame ' + f; }
        if (ae > maxAng) { maxAng = ae; maxAngAt = 'op ' + op + ' frame ' + f; }
      }
    }
    console.log('scene            :', name);
    console.log('  ops compared   :', ops.length);
    console.log('  samples per op :', fusedBatch[0].samples.length);
    console.log('  max position err:', maxPos.toExponential(9), 'm at', maxPosAt);
    console.log('  max angle err   :', maxAng.toExponential(9), 'rad at', maxAngAt);
    return maxPos <= 1e-9 && maxAng <= 1e-9;
  }

  const rust1 = adapter.simulateTankBatch(startPose, ops, 75, opt);
  const ok1 = compareBatch('bridge head-on bullet, call 1', fused, rust1);

  // Same adapter / same world: exercises the persistent Rust cache_id and
  // the persistent JS fused warm-starting state together.
  const fused2 = adapter.simulateTankBatch(startPose, ops, 75, opt);
  const rust2 = adapter.simulateTankBatch(startPose, ops, 75, opt);
  const ok2 = compareBatch('bridge head-on bullet, call 2 (warm)', fused2, rust2);

  VantageSandbox.setRustPhysicsEnabled(false);

  if (!ok1 || !ok2) {
    console.error('DIFF ROLLOUT BRIDGE FAILED');
    process.exitCode = 1;
  } else {
    console.log('DIFF ROLLOUT BRIDGE PASSED');
  }
}

main().catch((e) => {
  console.error('diff_rollout_bridge.js error:', (e && e.stack) || e);
  process.exitCode = 2;
});
