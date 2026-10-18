#!/usr/bin/env node
// 探针（新建，不动产品代码）：量融合世界/轨迹世界里“撞墙接触”的逐帧形态，
// 用来为 bounce 上限（35ms 窗口内 ≥5 次接触）与霰弹撞墙减命选一个可复现的场景。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const jsBox2D = path.join(root, 'js', 'f1a5ef972c273fb89a098cb50b0f22e7.js');
const jsBundle = path.join(root, 'js', 'b714588dc4621fe104113111ba90b1a7.js');

function load() {
  const sandbox = { console };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(jsBox2D, 'utf8'), ctx, { filename: jsBox2D });
  function makeClass() {
    const C = {};
    C.classFields = function (o) { Object.assign(C, o); return C; };
    C.classMethods = function (o) { Object.assign(C, o); return C; };
    C.methods = function () { return C; };
    C.fields = function () { return C; };
    C.name = function () { return C; };
    return C;
  }
  sandbox.Classy = { newClass: makeClass };
  const lines = fs.readFileSync(jsBundle, 'utf8').split(/\r?\n/).filter((l) => /^\s*var mod_pagespeed_/.test(l));
  for (const name of ['mod_pagespeed_QSIkKJ9Ibg', 'mod_pagespeed__SHLt6ORr2']) {
    const line = lines.find((l) => l.indexOf('var ' + name) >= 0);
    vm.runInContext(line, ctx, { filename: name + '.js' });
    vm.runInContext(sandbox[name], ctx, { filename: name + '-eval.js' });
  }
  return sandbox;
}

function makeMaze(W, H, topWalls, leftWalls) {
  const tiles = [];
  for (let i = 0; i < W; i++) {
    tiles[i] = [];
    for (let j = 0; j < H; j++) tiles[i][j] = [1, j === 0 ? 1 : 0, i === 0 ? 1 : 0];
  }
  if (topWalls) for (const [i, j] of topWalls) tiles[i][j][1] = 1;
  if (leftWalls) for (const [i, j] of leftWalls) tiles[i][j][2] = 1;
  return { getTiles: () => tiles };
}

function makeProj(S, x, y, vx, vy, radius, id) {
  return {
    id, _x: x, _y: y, _vx: vx, _vy: vy, lifetime: 10, age: 0,
    done: () => false, getTimeAlive: () => 0,
    getType: () => S.Constants.WEAPON_TYPES.BULLET,
    getX: () => x, getY: () => y, getSpeedX: () => vx, getSpeedY: () => vy,
  };
}

const S = load();
const Box2D = S.Box2D, B2DUtils = S.B2DUtils, Constants = S.Constants;
const PROJ = Constants.COLLISION_CATEGORIES.PROJECTILE;
const HARD = Constants.COLLISION_CATEGORIES.MAZE | Constants.COLLISION_CATEGORIES.SHIELD;

function sample(name, maze, proj, radius, frames, dt) {
  const w = new Box2D.Dynamics.b2World(Box2D.Common.Math.b2Vec2.Make(0, 0), true);
  B2DUtils.createMaze(w, maze);
  const p = makeProj(S, proj.x, proj.y, proj.vx, proj.vy, radius, proj.id || 'p');
  const body = B2DUtils.createProjectileBody(w, p, radius);
  const rows = [];
  for (let k = 0; k <= frames; k++) {
    if (k > 0) w.Step(dt, 10, 10);
    let touches = 0, contactTotal = 0;
    const pos = body.GetPosition();
    const vel = body.GetLinearVelocity();
    let c = w.GetContactList();
    while (c) {
      contactTotal++;
      if (c.IsTouching()) {
        const ca = c.GetFixtureA().GetFilterData().categoryBits;
        const cb = c.GetFixtureB().GetFilterData().categoryBits;
        if (((ca & PROJ) && (cb & HARD)) || ((cb & PROJ) && (ca & HARD))) touches++;
      }
      c = c.GetNext();
    }
    rows.push({ k, x: +pos.x.toFixed(4), y: +pos.y.toFixed(4), vx: +vel.x.toFixed(3), vy: +vel.y.toFixed(3), touching: touches, contacts: contactTotal });
  }
  console.log('=== ' + name + ' ===');
  console.log(JSON.stringify(rows.slice(0, 14)));
  const tr = rows.filter((r) => r.touching > 0);
  console.log('  touching frames:', tr.length, 'first:', tr.slice(0, 8).map((r) => r.k + ':' + r.touching).join(' '));
  return rows;
}

// A) 内角：左下角 (0.4,0.4)（两堵墙的 fixture 在此重叠）
sample('A corner seed v(0,0.5)', makeMaze(4, 3), { id: 'c1', x: 0.4, y: 0.4, vx: 0, vy: 0.5 }, 0.25, 12, 1 / 60);
sample('A2 corner seed v(0.5,0.5)', makeMaze(4, 3), { id: 'c2', x: 0.4, y: 0.4, vx: 0.5, vy: 0.5 }, 0.25, 12, 1 / 60);
sample('A3 corner seed v(1,1)', makeMaze(4, 3), { id: 'c3', x: 0.4, y: 0.4, vx: 1, vy: 1 }, 0.25, 12, 1 / 60);
sample('A4 corner seed v(0,3)', makeMaze(4, 3), { id: 'c4', x: 0.45, y: 0.45, vx: 0, vy: 3 }, 0.25, 12, 1 / 60);
sample('A5 corner seed v(3,3)', makeMaze(4, 3), { id: 'c5', x: 0.45, y: 0.45, vx: 3, vy: 3 }, 0.25, 12, 1 / 60);
// B) 长走廊：底墙 y=0.4，顶墙 = 顶行 top wall -> y≈29.6
const mazeCorr = makeMaze(6, 3, [[0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2]]);
sample('B corridor v(0,18) 600f', mazeCorr, { id: 'b1', x: 5, y: 15, vx: 0, vy: 18 }, 0.25, 600, 1 / 60);
// C) 窄缝：左右两墙 x=0.4 与 x=? 由 left wall of tile 1 -> x≈9.6
const mazeNarrow = makeMaze(6, 3, null, [[1, 1]]);
sample('C narrow gap x0.4..9.6 v(0,2)', mazeNarrow, { id: 'n1', x: 0.6, y: 5, vx: 0, vy: 2 }, 0.25, 30, 1 / 60);
