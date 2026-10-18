#!/usr/bin/env node
/* ============================================================================
 * 1-2④ 收尾：Rust rescore 追踪导弹路径差分对拍（**修前 FAIL / 修后 PASS**）
 *
 * 走生产路径：真 `vantage_sandbox.js` 的 adapter -> `rescoreTankSamples`
 * -> VantageRustBridge（路线 B2：有制导弹威胁时按 node 逐次调用）
 * -> `vt_rescore_nodes`（部署 wasm）。
 *
 * 先验契约（修前必须响亮 FAIL）：
 *   · wasm ABI >= 12（弹种码 4=HOMING_MISSILE + `vt_set_maze`）；
 *   · `VantageSandbox.missileSteerVelocity` / `getMazeNavTables` / `assertMissileNotBallistic` 存在；
 *   · `adapter.getLastRescoreMissileTracks` 存在（B2 的每 node 轨道快照）。
 * 再看语义：
 *   · 每个场景：JS 融合（带制导）与 Rust rescore 的 dead/deathFrame 必须一致；
 *   · Rust rescore 的 perFrameScores/totalScore 与 JS `scorePaths`（喂同一条
 *     该 node 的导引 track）在 1e-9 内一致；
 *   · B2「每 node 一条轨道」：两个 node 的 track 必须不同；**打乱 node 调用顺序
 *     结果不变**（防逐 node 调用互相污染）。
 *
 * 容差 1e-9。本脚本一旦落地不再改（修前/修后同一份）。
 * ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const JS = (p) => path.join(root, p);
const POS_TOL = 1e-9;

function loadSandbox() {
  const sandbox = { console: console };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(JS('game_core/js/f1a5ef972c273fb89a098cb50b0f22e7.js'), 'utf8'), ctx,
    { filename: 'box2d.js' });
  const Box2D = sandbox.Box2D;
  if (!Box2D) throw new Error('Box2D not defined');
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
  const bundleSrc = fs.readFileSync(JS('game_core/js/b714588dc4621fe104113111ba90b1a7.js'), 'utf8');
  const lines = bundleSrc.split(/\r?\n/).filter((l) => /^\s*var mod_pagespeed_/.test(l));
  for (const name of ['mod_pagespeed_QSIkKJ9Ibg', 'mod_pagespeed__SHLt6ORr2']) {
    const line = lines.find((l) => l.indexOf('var ' + name) >= 0);
    if (!line) throw new Error('bundle line not found: ' + name);
    vm.runInContext(line, ctx, { filename: name });
    vm.runInContext(sandbox[name], ctx, { filename: name + '-eval' });
  }
  vm.runInContext(fs.readFileSync(JS('game_core/js/ai_tactics.js'), 'utf8'), ctx, { filename: 'ai_tactics.js' });
  vm.runInContext(fs.readFileSync(JS('game_core/js/vantage_sandbox.js'), 'utf8'), ctx, { filename: 'vantage_sandbox.js' });
  vm.runInContext(fs.readFileSync(JS('game_core/js/vantage_scoring.js'), 'utf8'), ctx, { filename: 'vantage_scoring.js' });
  sandbox._ctx = ctx;
  return sandbox;
}

/* 与游戏 Maze API 同口径的最小假迷宫（12x8 空场 + 外圈墙）。
 * `getShortestPathWithGraph` 返回的 path[0] = **下一格**（不含起点）——与
 * round-3「下一格表」行走法验证过的口径一致。 */
function makeMazeFake(W, H) {
  const tiles = [];
  for (let x = 0; x < W; x++) {
    tiles[x] = [];
    for (let y = 0; y < H; y++) tiles[x][y] = [1, y === 0 ? 1 : 0, x === 0 ? 1 : 0];
  }
  const inside = (p) => p && p.x >= 0 && p.y >= 0 && p.x < W && p.y < H;
  function bfs(sx, sy) {
    const dist = [];
    for (let x = 0; x < W; x++) { dist[x] = []; for (let y = 0; y < H; y++) dist[x][y] = false; }
    dist[sx][sy] = 0;
    const q = [[sx, sy]];
    while (q.length) {
      const cur = q.shift(); const cx = cur[0], cy = cur[1];
      const d = dist[cx][cy];
      if (cx > 0 && tiles[cx][cy][2] === 0 && dist[cx - 1][cy] === false) { dist[cx - 1][cy] = d + 1; q.push([cx - 1, cy]); }
      if (cx < W - 1 && tiles[cx + 1][cy][2] === 0 && dist[cx + 1][cy] === false) { dist[cx + 1][cy] = d + 1; q.push([cx + 1, cy]); }
      if (cy > 0 && tiles[cx][cy][1] === 0 && dist[cx][cy - 1] === false) { dist[cx][cy - 1] = d + 1; q.push([cx, cy - 1]); }
      if (cy < H - 1 && tiles[cx][cy + 1][1] === 0 && dist[cx][cy + 1] === false) { dist[cx][cy + 1] = d + 1; q.push([cx, cy + 1]); }
    }
    return dist;
  }
  return {
    getWidth: () => W, getHeight: () => H, getTiles: () => tiles,
    getDistancesFromPosition: (p) => inside(p) ? bfs(p.x, p.y) : false,
    getDistanceToPosition: (dists, p) => inside(p) ? dists[p.x][p.y] : false,
    getShortestPathWithGraph: (s, e) => {
      if (!inside(s) || !inside(e)) return null;
      const dists = bfs(s.x, s.y);
      if (dists[e.x][e.y] === false) return null;
      let cx = e.x, cy = e.y;
      const rev = [];
      while (!(cx === s.x && cy === s.y)) {
        rev.push({ x: cx, y: cy });
        const d = dists[cx][cy];
        let moved = false;
        const cand = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]];
        for (const c of cand) {
          const nx = c[0], ny = c[1];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (dists[nx][ny] !== false && dists[nx][ny] === d - 1) {
            let ok = false;
            if (nx === cx - 1) ok = tiles[cx][cy][2] === 0;
            else if (nx === cx + 1) ok = tiles[nx][ny][2] === 0;
            else if (ny === cy - 1) ok = tiles[cx][cy][1] === 0;
            else ok = tiles[nx][ny][1] === 0;
            if (ok) { cx = nx; cy = ny; moved = true; break; }
          }
        }
        if (!moved) return null;
      }
      rev.reverse();
      return rev;
    }
  };
}

function makeFakeBody(Box2D, x, y, vx, vy, rot, radius) {
  const b2Vec2 = Box2D.Common.Math.b2Vec2;
  return {
    _p: new b2Vec2(x, y), _v: new b2Vec2(vx, vy), _a: rot, _w: 0, _active: true,
    GetPosition() { return new b2Vec2(this._p.x, this._p.y); },
    GetAngle() { return this._a; },
    GetLinearVelocity() { return new b2Vec2(this._v.x, this._v.y); },
    GetAngularVelocity() { return this._w; },
    SetPositionAndAngle(p, a) { this._p.x = p.x; this._p.y = p.y; this._a = a; },
    SetLinearVelocity(v) { this._v.x = v.x; this._v.y = v.y; },
    SetAngularVelocity(w) { this._w = w; },
    SetAwake() {}, SetActive(a) { this._active = a; }, IsActive() { return this._active; },
    GetFixtureList() { return { GetShape() { return { m_radius: radius }; } }; },
  };
}
function makeFakeTank(Box2D, x, y, rot) {
  const body = makeFakeBody(Box2D, x, y, 0, 0, rot, 1);
  return {
    x, y, rotation: rot, forward: false, back: false, left: false, right: false,
    locked: false, speed: 0, rotationSpeed: 0,
    getX() { return this.x; }, getY() { return this.y; }, getRotation() { return this.rotation; },
    getB2DBody() { return body; },
    _computeSpeed() { this.speed = (this.forward ? 15.95 : 0) + (this.back ? -12.8 : 0); },
    _computeRotationSpeed() { this.rotationSpeed = (this.left ? -5.0 : 0) + (this.right ? 5.0 : 0); },
  };
}
function makeFakeMissile(Box2D, pos, vel, opts) {
  opts = opts || {};
  const body = makeFakeBody(Box2D, pos.x, pos.y, vel.x, vel.y, 0, 0.2);
  return {
    id: 'm-1', lifetime: 10.0, _age: opts.age || 0, timeAlive: opts.age || 0,
    initialSpeed: 18.0,
    currentTargetPlayerId: opts.target === undefined ? 'tank_b' : opts.target,
    done() { return false; },
    getTimeAlive() { return this._age; },
    getType() { return 3; },                    // Constants.WEAPON_TYPES.HOMING_MISSILE
    getB2DBody() { return body; },
    getX() { return pos.x; }, getY() { return pos.y; },
    getSpeedX() { return vel.x; }, getSpeedY() { return vel.y; },
  };
}
function makeGameController(maze, tank, projectiles) {
  return {
    getMaze: () => maze,
    getTank: () => tank,
    getTanks: () => ({ tank_b: tank }),
    getProjectiles: () => projectiles,
    getB2DWorld: () => null,
  };
}
function makeCfg() {
  return {
    deathPenalty: 10.0,
    stuckPenalty: 4.0,
    stuckDistEps: 0.05,
    stuckRotEps: 0.05,
    lanePenaltyRatio: 0,
    springRopeEnabled: false,
    occlusionEnabled: true,
  };
}
function maxScoreDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}
function straightThreat(scene) {
  const len = Math.hypot(scene.v.x, scene.v.y) || 1;
  const ux = scene.v.x / len, uy = scene.v.y / len;
  const far = 60;
  return {
    id: 'm-1',
    type: 3,                     // HOMING_MISSILE
    path: [{ x: scene.m.x, y: scene.m.y }, { x: scene.m.x + ux * far, y: scene.m.y + uy * far }],
    x: scene.m.x, y: scene.m.y,
    speed: len,
    anchorOffset: 0,
    lifeLeftSeconds: 10,
    isNew: true,
  };
}

/* 一个场景：JS 融合（真制导）→ rescore node → Rust rescore。 */
function runScene(sandbox, scene, frames) {
  const Box2D = sandbox.Box2D;
  const VantageSandbox = sandbox.VantageSandbox;
  const VantageScoring = sandbox.VantageScoring;
  const maze = makeMazeFake(12, 8);
  const tank = makeFakeTank(Box2D, scene.tank.x, scene.tank.y, scene.tank.rot || 0);
  const missile = makeFakeMissile(Box2D, scene.m, scene.v, { age: scene.age, target: scene.target });
  const gc = makeGameController(maze, tank, { 'm-1': missile });
  const adapter = VantageSandbox.createAdapter(gc, 'tank_b');
  const pose = { x: scene.tank.x, y: scene.tank.y, rot: scene.tank.rot || 0 };
  const ops = [scene.op];

  VantageSandbox.setFrameDtSec(0.02);
  VantageSandbox.setRustPhysicsEnabled(false);
  const fused = adapter.simulateTankBatchJsFused(pose, ops, frames, {
    startPose: pose, auditPurpose: 'jsConfirm', tGlobal: 0, nowTGlobal: 0, threats: [],
  });
  if (!fused || !fused[0]) throw new Error(scene.name + ': JS fused returned null');
  const f0 = fused[0];

  const out = {
    name: scene.name,
    fusedDead: !!f0.dead, fusedFd: f0.deathFrame,
    dropStats: adapter.getFusedDropStats ? adapter.getFusedDropStats() : {},
    rust: null, scoreDiff: null, jsRef: null,
    nodeTracks: null, shuffle: null,
  };
  if (scene.expectDrop) {
    // D2：追别人的弹应在建表/摆位就摘掉 → 没有 rescore 参与。
    return out;
  }

  const nodes = [{ samples: f0.samples, moving: false, startT: 0, frames: frames }];
  const threats = [straightThreat(scene)];
  VantageSandbox.setRustPhysicsEnabled(true);
  const rust = adapter.rescoreTankSamples(nodes, threats, makeCfg(), threats, 0);
  out.rust = rust && rust[0] ? rust[0] : null;
  out.nodeTracks = adapter.getLastRescoreMissileTracks ? adapter.getLastRescoreMissileTracks() : null;

  // JS scorePaths 参考：喂**同一条该 node 的导引 track**（B2 快照）。
  let track = null;
  if (out.nodeTracks && out.nodeTracks[0] && out.nodeTracks[0][0]) track = out.nodeTracks[0][0];
  const refThreat = straightThreat(scene);
  if (track) {
    refThreat.track = track;
    refThreat.trackFrameDt = VantageSandbox.getFrameDtSec ? VantageSandbox.getFrameDtSec() : 0.02;
  }
  const fakeAdapter = {
    constants: adapter.constants,
    simulateTankBatch: function () { return fused; },
    bulletPosAt: function (p, s, t) { return adapter.bulletPosAt(p, s, t); },
    checkDeathSweep: function (tankState, segments) { return adapter.checkDeathSweep(tankState, segments); },
  };
  try {
    const jsRef = VantageScoring.scorePaths(fakeAdapter, { tank: pose, tGlobal: 0 }, ops, frames, [refThreat], makeCfg());
    out.jsRef = jsRef && jsRef[0] ? jsRef[0] : null;
  } catch (eRef) {
    out.jsRef = null;
    out.refErr = String((eRef && eRef.message) || eRef);
  }
  if (out.rust && out.jsRef) {
    out.scoreDiff = Math.max(
      maxScoreDiff(out.rust.perFrameScores, out.jsRef.perFrameScores),
      Math.abs((out.rust.totalScore || 0) - (out.jsRef.totalScore || 0)));
  }
  return out;
}

/* B2「打乱 node 调用顺序」：两个 node（静止 / 前进）各带自己的制导弹道。 */
function runShuffle(sandbox, frames) {
  const Box2D = sandbox.Box2D;
  const VantageSandbox = sandbox.VantageSandbox;
  const maze = makeMazeFake(12, 8);
  const tank = makeFakeTank(Box2D, 50, 30, 0);
  const missile = makeFakeMissile(Box2D, { x: 45, y: 55 }, { x: 0, y: -18 }, { age: 2.1, target: 'tank_b' });
  const gc = makeGameController(maze, tank, { 'm-1': missile });
  const adapter = VantageSandbox.createAdapter(gc, 'tank_b');
  const pose = { x: 50, y: 30, rot: 0 };
  const opStatic = { name: 'static', inputs: { forward: false, back: false, left: false, right: false } };
  const opFwd = { name: 'fwd', inputs: { forward: true, back: false, left: false, right: false } };

  VantageSandbox.setFrameDtSec(0.02);
  VantageSandbox.setRustPhysicsEnabled(false);
  function fusedFor(op) {
    const r = adapter.simulateTankBatchJsFused(pose, [op], frames, {
      startPose: pose, auditPurpose: 'jsConfirm', tGlobal: 0, nowTGlobal: 0, threats: [],
    });
    if (!r || !r[0]) throw new Error('shuffle: fused null');
    return r[0];
  }
  const fA = fusedFor(opStatic);
  const fB = fusedFor(opFwd);
  const nodeA = { samples: fA.samples, moving: false, startT: 0, frames: frames };
  const nodeB = { samples: fB.samples, moving: true, startT: 0, frames: frames };
  const threats = [straightThreat({ m: { x: 45, y: 55 }, v: { x: 0, y: -18 } })];

  VantageSandbox.setRustPhysicsEnabled(true);
  const ab = adapter.rescoreTankSamples([nodeA, nodeB], threats, makeCfg(), threats, 0);
  const tracksAB = adapter.getLastRescoreMissileTracks ? JSON.parse(JSON.stringify(adapter.getLastRescoreMissileTracks())) : null;
  const ba = adapter.rescoreTankSamples([nodeB, nodeA], threats, makeCfg(), threats, 0);
  const tracksBA = adapter.getLastRescoreMissileTracks ? JSON.parse(JSON.stringify(adapter.getLastRescoreMissileTracks())) : null;

  let eq = false;
  if (ab && ba && ab.length === 2 && ba.length === 2) {
    const same1 = ab[0].dead === ba[1].dead && ab[0].deathFrame === ba[1].deathFrame &&
      Math.abs((ab[0].totalScore || 0) - (ba[1].totalScore || 0)) < 1e-9 &&
      maxScoreDiff(ab[0].perFrameScores, ba[1].perFrameScores) < 1e-9;
    const same2 = ab[1].dead === ba[0].dead && ab[1].deathFrame === ba[0].deathFrame &&
      Math.abs((ab[1].totalScore || 0) - (ba[0].totalScore || 0)) < 1e-9 &&
      maxScoreDiff(ab[1].perFrameScores, ba[0].perFrameScores) < 1e-9;
    eq = same1 && same2;
  }
  // 每 node 一条轨道：A/B 的 track 必须不同（该 node 的坦克轨迹不同）。
  let tracksDiffer = false;
  if (tracksAB && tracksAB.length === 2 && tracksAB[0] && tracksAB[1] &&
      tracksAB[0][0] && tracksAB[1][0]) {
    const t1 = tracksAB[0][0], t2 = tracksAB[1][0];
    if (t1.length !== t2.length) tracksDiffer = true;
    else {
      for (let i = 0; i < t1.length; i++) {
        if (Math.abs(t1[i].x - t2[i].x) > 1e-9 || Math.abs(t1[i].y - t2[i].y) > 1e-9) { tracksDiffer = true; break; }
      }
    }
  }
  return {
    ab: ab ? ab.map(r => ({ dead: r.dead, fd: r.deathFrame, total: r.totalScore })) : null,
    ba: ba ? ba.map(r => ({ dead: r.dead, fd: r.deathFrame, total: r.totalScore })) : null,
    eq: eq, tracksDiffer: tracksDiffer,
    // 顺序无关：AB 的第 0 条应等于 BA 的第 1 条，AB 的第 1 条应等于 BA 的第 0 条。
    tracksOrderFree: !!(tracksAB && tracksBA && tracksAB.length === 2 && tracksBA.length === 2 &&
      JSON.stringify(tracksAB[0]) === JSON.stringify(tracksBA[1]) &&
      JSON.stringify(tracksAB[1]) === JSON.stringify(tracksBA[0])),
  };
}

async function main() {
  const sandbox = loadSandbox();
  sandbox.WebAssembly = WebAssembly;
  sandbox.fetch = async function () {
    const bytes = fs.readFileSync(JS('game_core/js/wasm/vantage_core.wasm'));
    return { ok: true, arrayBuffer: async function () {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } };
  };
  vm.runInContext(fs.readFileSync(JS('game_core/js/vantage_rust_bridge.js'), 'utf8'), sandbox._ctx,
    { filename: 'vantage_rust_bridge.js' });
  const bridge = sandbox.VantageRustBridge;
  const init = await bridge.init('js/wasm/vantage_core.wasm');
  if (!init.ok) throw new Error('bridge init failed: ' + init.error);
  const VantageSandbox = sandbox.VantageSandbox;

  let fails = 0;
  function check(name, cond, detail) {
    if (!cond) fails++;
    console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '   ' + detail : ''));
  }

  console.log('=== 1-2④ rescore 制导弹差分（ABI v' + bridge.version() + '，容差 ' + POS_TOL + '） ===');
  console.log('--- 契约（修前必 FAIL） ---');
  check('wasm ABI >= 12', Number(bridge.version()) >= 12, 'abi=' + bridge.version());
  check('VantageSandbox.missileSteerVelocity 存在', typeof VantageSandbox.missileSteerVelocity === 'function');
  check('VantageSandbox.getMazeNavTables 存在', typeof VantageSandbox.getMazeNavTables === 'function');
  let d1ok = false, d1err = '';
  try { d1ok = VantageSandbox.assertMissileNotBallistic() === true; } catch (e1) { d1err = String(e1 && e1.message || e1); }
  check('D1 断言：导弹不进 track 白名单', d1ok, d1err);

  const FRAMES = 75;
  const staticOp = { name: 'static', inputs: { forward: false, back: false, left: false, right: false } };
  const SCENES = [
    { name: 'guided_head_on', tank: { x: 50, y: 30 }, m: { x: 50, y: 55 }, v: { x: 0, y: -18 }, age: 2.1, op: staticOp, wantDead: true },
    { name: 'guided_lateral', tank: { x: 50, y: 30 }, m: { x: 45, y: 55 }, v: { x: 0, y: -18 }, age: 2.1, op: staticOp, wantDead: true },
    { name: 'gate_closed_miss', tank: { x: 50, y: 30 }, m: { x: 45, y: 55 }, v: { x: 0, y: -18 }, age: 0.0, op: staticOp, wantDead: false },
    { name: 'reversal_positive', tank: { x: 50, y: 30 }, m: { x: 50, y: 25 }, v: { x: 0, y: -18 }, age: 2.1, op: staticOp, wantDead: true },
    { name: 'target_other_dropped', tank: { x: 50, y: 30 }, m: { x: 50, y: 55 }, v: { x: 0, y: -18 }, age: 2.1, op: staticOp, target: 'tank_c', expectDrop: true, wantDead: false },
  ];
  console.log('--- 场景 ---');
  for (const sc of SCENES) {
    let r = null, err = '';
    try { r = runScene(sandbox, sc, FRAMES); } catch (e) { err = String((e && e.stack) || e); }
    if (!r) { check(sc.name, false, err); continue; }
    let ok = true, why = [];
    if (r.fusedDead !== sc.wantDead) { ok = false; why.push('JS融合 dead=' + r.fusedDead + ' 期望 ' + sc.wantDead); }
    if (sc.expectDrop) {
      if (!r.dropStats || !(r.dropStats.droppedTargetOther > 0)) { ok = false; why.push('droppedTargetOther 未记账'); }
    } else {
      if (!r.rust) { ok = false; why.push('rust rescore 返回 null'); }
      else {
        if (!!r.rust.dead !== !!r.fusedDead) { ok = false; why.push('Rust dead=' + r.rust.dead + ' vs JS ' + r.fusedDead); }
        if (r.rust.deathFrame !== r.fusedFd) { ok = false; why.push('Rust fd=' + r.rust.deathFrame + ' vs JS ' + r.fusedFd); }
      }
      if (!(r.scoreDiff !== null && r.scoreDiff <= POS_TOL)) { ok = false; why.push('scoreDiff=' + r.scoreDiff); }
      if (!(r.nodeTracks && r.nodeTracks[0] && r.nodeTracks[0][0] && r.nodeTracks[0][0].length >= 2)) {
        ok = false; why.push('缺 B2 每 node 轨道快照');
      }
    }
    check(sc.name, ok, 'JS=' + r.fusedDead + '/' + r.fusedFd +
      (r.rust ? ' Rust=' + r.rust.dead + '/' + r.rust.deathFrame : ' (D2 丢弃)') +
      ' scoreDiff=' + (r.scoreDiff === null ? '-' : r.scoreDiff.toExponential(3)) +
      (why.length ? '  ← ' + why.join('; ') : ''));
  }

  console.log('--- B2：打乱 node 调用顺序 + 每 node 一条轨道 ---');
  let sh = null, shErr = '';
  try { sh = runShuffle(sandbox, 75); } catch (e) { shErr = String((e && e.stack) || e); }
  check('打乱 node 调用顺序结果不变', !!(sh && sh.eq), shErr || JSON.stringify(sh));
  check('不同 node 的制导弹道确实不同', !!(sh && sh.tracksDiffer));
  check('两次调用的轨道快照一致（顺序无关）', !!(sh && sh.tracksOrderFree));

  console.log('\n' + (fails ? ('DIFF RESCORE MISSILE FAILED (' + fails + ')') : 'DIFF RESCORE MISSILE PASSED'));
  process.exitCode = fails ? 1 : 0;
}

main().catch(function (e) {
  console.error('diff_rescore_missile.js error:', (e && e.stack) || e);
  process.exitCode = 2;
});
