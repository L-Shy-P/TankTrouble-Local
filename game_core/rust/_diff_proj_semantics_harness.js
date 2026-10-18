#!/usr/bin/env node
// 新建的共享对拍脚手架（只给 diff_shotgun_wall_lifetime / diff_bounce_timeout_window 用）。
// 加载配方与 diff_rollout_bridge.js 完全一致（同一份 Box2D/Constants/B2DUtils/
// VantageSandbox/VantageRustBridge），保证两条新对拍跑的就是生产链路。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const jsBox2D = path.join(root, 'js', 'f1a5ef972c273fb89a098cb50b0f22e7.js');
const jsBundle = path.join(root, 'js', 'b714588dc4621fe104113111ba90b1a7.js');
const jsTactics = path.join(root, 'js', 'ai_tactics.js');
const jsSandbox = path.join(root, 'js', 'vantage_sandbox.js');
const bridgePath = path.join(root, 'js', 'vantage_rust_bridge.js');
const wasmPath = path.join(root, 'js', 'wasm', 'vantage_core.wasm');

function loadSandbox() {
  const sandbox = { console: console };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(jsBox2D, 'utf8'), ctx, { filename: jsBox2D });
  if (!sandbox.Box2D) throw new Error('Box2D missing');

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

  const lines = fs.readFileSync(jsBundle, 'utf8').split(/\r?\n/).filter((l) => /^\s*var mod_pagespeed_/.test(l));
  for (const name of ['mod_pagespeed_QSIkKJ9Ibg', 'mod_pagespeed__SHLt6ORr2']) {
    const line = lines.find((l) => l.indexOf('var ' + name) >= 0);
    if (!line) throw new Error('bundle line missing ' + name);
    vm.runInContext(line, ctx, { filename: 'bundle-' + name + '.js' });
    vm.runInContext(sandbox[name], ctx, { filename: 'bundle-' + name + '-eval.js' });
  }
  vm.runInContext(fs.readFileSync(jsTactics, 'utf8'), ctx, { filename: jsTactics });
  vm.runInContext(fs.readFileSync(jsSandbox, 'utf8'), ctx, { filename: jsSandbox });
  sandbox._ctx = ctx;
  return sandbox;
}

async function initRust(sandbox, cacheBust) {
  sandbox.WebAssembly = WebAssembly;
  sandbox.fetch = async function () {
    const bytes = fs.readFileSync(wasmPath);
    return { ok: true, arrayBuffer: async function () { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
  };
  vm.runInContext(fs.readFileSync(bridgePath, 'utf8'), sandbox._ctx, { filename: bridgePath });
  const bridge = sandbox.VantageRustBridge;
  const init = await bridge.init(cacheBust || 'js/wasm/vantage_core.wasm');
  if (!init.ok) throw new Error('bridge init failed: ' + init.error);
  return bridge;
}

function makeFakeTankBody(Box2D, x, y, rot) {
  const b2Vec2 = Box2D.Common.Math.b2Vec2;
  return {
    _pos: new b2Vec2(x, y), _vel: new b2Vec2(0, 0), _angle: rot, _angVel: 0, _active: true,
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

function makeFakeTank(Box2D, x, y, rot) {
  const body = makeFakeTankBody(Box2D, x, y, rot);
  return {
    x: x, y: y, rotation: rot, forward: false, back: false, left: false, right: false,
    locked: false, speed: 0, rotationSpeed: 0,
    getX: function () { return this.x; },
    getY: function () { return this.y; },
    getRotation: function () { return this.rotation; },
    getB2DBody: function () { return body; },
    _computeSpeed: function () { this.speed = (this.forward ? 15.95 : 0) + (this.back ? -12.8 : 0); },
    _computeRotationSpeed: function () { this.rotationSpeed = (this.left ? -5.0 : 0) + (this.right ? 5.0 : 0); },
  };
}

function makeFakeProjectileBody(Box2D, x, y, vx, vy, radius) {
  const b2Vec2 = Box2D.Common.Math.b2Vec2;
  return {
    _pos: new b2Vec2(x, y), _vel: new b2Vec2(vx, vy), _angle: 0, _angVel: 0, _active: true,
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

function makeFakeProjectile(Box2D, Constants, opts) {
  const body = makeFakeProjectileBody(Box2D, opts.x, opts.y, opts.vx, opts.vy, opts.radius);
  const type = (opts.type !== undefined) ? opts.type : Constants.WEAPON_TYPES.BULLET;
  const lifetime = (opts.lifetime !== undefined) ? opts.lifetime : 10;
  const age = opts.age || 0;
  return {
    id: opts.id || 'p1', _x: opts.x, _y: opts.y, _vx: opts.vx, _vy: opts.vy,
    lifetime: lifetime, age: age,
    done: function () { return false; },
    getTimeAlive: function () { return age; },
    getType: function () { return type; },
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
    for (let j = 0; j < H; j++) tiles[i][j] = [1, j === 0 ? 1 : 0, i === 0 ? 1 : 0];
  }
  if (extraTopWalls) for (const [i, j] of extraTopWalls) tiles[i][j][1] = 1;
  if (extraLeftWalls) for (const [i, j] of extraLeftWalls) tiles[i][j][2] = 1;
  return { getTiles: function () { return tiles; } };
}

function makeGameController(maze, tank, projectiles) {
  return {
    getMaze: function () { return maze; },
    getTank: function () { return tank; },
    getTanks: function () { return { p0: tank }; },
    getProjectiles: function () { return projectiles; },
    getB2DWorld: function () { return null; },
  };
}

function extractWallPolygons(sandbox, maze) {
  const Box2D = sandbox.Box2D, B2DUtils = sandbox.B2DUtils, Constants = sandbox.Constants;
  const world = new Box2D.Dynamics.b2World(Box2D.Common.Math.b2Vec2.Make(0, 0), true);
  B2DUtils.createMaze(world, maze);
  const collected = [];
  for (let b = world.GetBodyList(); b; b = b.GetNext()) {
    for (let f = b.GetFixtureList(); f; f = f.GetNext()) {
      if (f.GetFilterData().categoryBits & Constants.COLLISION_CATEGORIES.MAZE) {
        const shape = f.GetShape(), verts = [];
        for (let k = 0; k < shape.m_vertexCount; k++) {
          const v = shape.m_vertices[k];
          verts.push({ x: v.x, y: v.y });
        }
        collected.push({ verts: verts });
      }
    }
  }
  return collected.reverse();
}

function staticOp() {
  return { name: '静止', inputs: { forward: false, back: false, left: false, right: false } };
}

/** 对比 JS 融合批次与 Rust 批次；返回 {ok, maxPos, maxAng, maxPosAt, maxAngAt} */
function compareBatches(name, jsBatch, rustBatch) {
  let maxPos = 0, maxAng = 0, maxPosAt = '', maxAngAt = '';
  if (jsBatch.length !== rustBatch.length) throw new Error(name + ': op count mismatch');
  for (let op = 0; op < jsBatch.length; op++) {
    if (jsBatch[op].dead !== rustBatch[op].dead || jsBatch[op].deathFrame !== rustBatch[op].deathFrame) {
      throw new Error(name + ' death mismatch op ' + op + ': js=' + jsBatch[op].dead + '/' + jsBatch[op].deathFrame +
        ' rust=' + rustBatch[op].dead + '/' + rustBatch[op].deathFrame);
    }
    for (let f = 0; f < jsBatch[op].samples.length; f++) {
      const a = jsBatch[op].samples[f], b = rustBatch[op].samples[f];
      const pe = Math.hypot(a.x - b.x, a.y - b.y);
      const ae = Math.abs(a.rot - b.rot);
      if (pe > maxPos) { maxPos = pe; maxPosAt = 'op ' + op + ' frame ' + f; }
      if (ae > maxAng) { maxAng = ae; maxAngAt = 'op ' + op + ' frame ' + f; }
    }
  }
  return { ok: maxPos <= 1e-9 && maxAng <= 1e-9, maxPos: maxPos, maxAng: maxAng, maxPosAt: maxPosAt, maxAngAt: maxAngAt };
}

module.exports = {
  root: root, wasmPath: wasmPath,
  loadSandbox: loadSandbox, initRust: initRust,
  makeFakeTank: makeFakeTank, makeFakeProjectile: makeFakeProjectile,
  makeMaze: makeMaze, makeGameController: makeGameController,
  extractWallPolygons: extractWallPolygons, staticOp: staticOp, compareBatches: compareBatches,
};
