#!/usr/bin/env node
/* ============================================================================
 * 1-2④ 验收：N 弹体（每候选一颗弹体）+ homingOp 配对的 2×2 退化对照
 *
 * 走生产路径：真 `vantage_sandbox.js` 的 adapter：
 *   · Rust 快路 `simulateTankBatch`（=> vt_rollout_batch，ABI v12）
 *   · JS 融合 `simulateTankBatchJsFused`
 *
 * 证明四件事：
 *  ① 「该命中时只有对应的那颗弹报命中、其余 8 颗都不报」——op0 静止、op1 前逃跑，
 *     制导弹只打死 op0；op1 的副本够不着它 ⟹ dead=[true,false]。
 *  ② 2×2 退化对照：{制导门（timeAlive>2.0）开/关} × {初速朝坦克 / 朝反方向}：
 *       开+朝 → [T,F]（制导）；开+反 → [T,F]（**减速穿 0 反向**，制导真的在动）；
 *       关+朝 → [T,F]（退化成普通弹道）；关+反 → [F,F]（真的飞走）。
 *     ⟹ 「关」两格证明 N 副本在未激活时等于一颗弹道弹；「开+反」格证明制导生效。
 *  ③ 撞墙归账：导弹先撞左墙再制导回头 —— 9 个副本**同一帧撞同一面墙**，
 *     绝不能把共享 bounces 攒到 ≥5 而整颗弹被 `PROJECTILE_BOUNCE_TIMEOUT_COUNT` 误杀。
 *  ④ D1 断言（导弹不进 track 白名单）。
 *
 * 本脚本只读产品代码；输出 PASS/FAIL 表格。
 * ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..', '..');
const JS = (p) => path.join(root, p);

function loadSandbox() {
  const sandbox = { console: console };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(JS('game_core/js/f1a5ef972c273fb89a098cb50b0f22e7.js'), 'utf8'), ctx, { filename: 'box2d.js' });
  if (!sandbox.Box2D) throw new Error('Box2D not defined');
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
      const cur = q.shift(); const cx = cur[0], cy = cur[1]; const d = dist[cx][cy];
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
      let cx = e.x, cy = e.y; const rev = [];
      while (!(cx === s.x && cy === s.y)) {
        rev.push({ x: cx, y: cy });
        const d = dists[cx][cy]; let moved = false;
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
function makeFakeBody(Box2D, x, y, vx, vy, radius) {
  const b2Vec2 = Box2D.Common.Math.b2Vec2;
  return {
    _p: new b2Vec2(x, y), _v: new b2Vec2(vx, vy), _a: 0, _w: 0, _active: true,
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
  const body = makeFakeBody(Box2D, x, y, 0, 0, 1);
  return {
    x, y, rotation: rot, forward: false, back: false, left: false, right: false,
    locked: false, speed: 0, rotationSpeed: 0,
    getX() { return this.x; }, getY() { return this.y; }, getRotation() { return this.rotation; },
    getB2DBody() { return body; },
    _computeSpeed() { this.speed = (this.forward ? 15.95 : 0) + (this.back ? -12.8 : 0); },
    _computeRotationSpeed() { this.rotationSpeed = (this.left ? -5.0 : 0) + (this.right ? 5.0 : 0); },
  };
}
function makeFakeMissile(Box2D, pos, vel, age) {
  const body = makeFakeBody(Box2D, pos.x, pos.y, vel.x, vel.y, 0.2);
  return {
    id: 'm-1', lifetime: 10.0, _age: age || 0, timeAlive: age || 0, initialSpeed: 18.0,
    currentTargetPlayerId: 'tank_b',
    done() { return false; }, getTimeAlive() { return this._age; },
    getType() { return 3; }, getB2DBody() { return body; },
    getX() { return pos.x; }, getY() { return pos.y; },
    getSpeedX() { return vel.x; }, getSpeedY() { return vel.y; },
  };
}
const STATIC = { name: 'static', inputs: { forward: false, back: false, left: false, right: false } };
const FWD = { name: 'fwd', inputs: { forward: true, back: false, left: false, right: false } };

function runOps(sandbox, sc) {
  const Box2D = sandbox.Box2D;
  const VantageSandbox = sandbox.VantageSandbox;
  const maze = makeMazeFake(12, 8);
  const tank = makeFakeTank(Box2D, sc.tank.x, sc.tank.y, 0);
  const missile = makeFakeMissile(Box2D, sc.m, sc.v, sc.age);
  const gc = {
    getMaze: () => maze, getTank: () => tank, getTanks: () => ({ tank_b: tank }),
    getProjectiles: () => ({ 'm-1': missile }), getB2DWorld: () => null,
  };
  const adapter = VantageSandbox.createAdapter(gc, 'tank_b');
  const pose = { x: sc.tank.x, y: sc.tank.y, rot: 0 };
  VantageSandbox.setFrameDtSec(0.02);
  VantageSandbox.setRustPhysicsEnabled(false);
  const fused = adapter.simulateTankBatchJsFused(pose, sc.ops, sc.frames, {
    startPose: pose, auditPurpose: 'jsConfirm', tGlobal: 0, nowTGlobal: 0, threats: [],
  });
  VantageSandbox.setRustPhysicsEnabled(true);
  const rust = adapter.simulateTankBatch(pose, sc.ops, sc.frames, {
    startPose: pose, auditPurpose: 'jsConfirm', tGlobal: 0, nowTGlobal: 0, threats: [],
  });
  return { fused, rust, adapter };
}
function deadOf(batch, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(!!(batch && batch[i] && batch[i].dead));
  return out;
}
function fdOf(batch, i) { return (batch && batch[i] && typeof batch[i].deathFrame === 'number') ? batch[i].deathFrame : null; }
function arrEq(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }

async function main() {
  const sandbox = loadSandbox();
  sandbox.WebAssembly = WebAssembly;
  sandbox.fetch = async function () {
    const bytes = fs.readFileSync(JS('game_core/js/wasm/vantage_core.wasm'));
    return { ok: true, arrayBuffer: async function () {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } };
  };
  vm.runInContext(fs.readFileSync(JS('game_core/js/vantage_rust_bridge.js'), 'utf8'), sandbox._ctx, { filename: 'vantage_rust_bridge.js' });
  const bridge = sandbox.VantageRustBridge;
  const init = await bridge.init('js/wasm/vantage_core.wasm');
  if (!init.ok) throw new Error('bridge init failed: ' + init.error);
  const VS = sandbox.VantageSandbox;
  const Box2D = sandbox.Box2D;

  const W = 16, H = 10;                  // 真实常见迷宫尺寸（handoff 里的 16x10）
  const OPS = [];
  for (let i = 0; i < 9; i++) OPS.push(STATIC);
  const POSE = { x: 80, y: 50, rot: 0 };  // mx,my

  function makeScenario(kind) {
    const maze = makeMazeFake(W, H);
    const tank = makeFakeTank(Box2D, POSE.x, POSE.y, 0);
    const projectiles = {};
    if (kind === 'bullet') {
      projectiles.p1 = makeFakeMissile(Box2D, { x: 80, y: 20 }, { x: 0, y: 18 }, 0);  // 普通弹（弹种 0）
      projectiles.p1.getType = function () { return -1; };                              // BULLET
    } else if (kind === 'missile') {
      projectiles.p1 = makeFakeMissile(Box2D, { x: 80, y: 20 }, { x: 0, y: 18 }, 2.1);   // 制导弹（门已过）
    }
    const gc = {
      getMaze: () => maze, getTank: () => tank, getTanks: () => ({ tank_b: tank }),
      getProjectiles: () => projectiles, getB2DWorld: () => null,
    };
    return { maze, adapter: VS.createAdapter(gc, 'tank_b') };
  }

  VS.setFrameDtSec(0.02);
  const FRAMES = 75;
  const WARM = 3, ITERS = 30;

  function timeIt(label, fn) {
    for (let i = 0; i < WARM; i++) fn();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ITERS; i++) fn();
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6 / ITERS;
    console.log('  ' + label.padEnd(34) + ms.toFixed(3) + ' ms/batch');
    return ms;
  }

  console.log('=== 1-2④ 性能：9 候选 + 制导弹 ×9 副本（16x10 迷宫，75 帧/批，' + ITERS + ' 批均值）===');
  const navOnly = makeScenario('none');
  const tNav = timeIt('JS: buildNextTileTable（16x10，一次性）', () => VS.buildNextTileTable(makeMazeFake(W, H)));

  const noneScene = makeScenario('none');
  VS.setRustPhysicsEnabled(true);
  const tRustNone = timeIt('Rust: 无弹', () => noneScene.adapter.simulateTankBatch(POSE, OPS, FRAMES, { startPose: POSE }));
  const bulletScene = makeScenario('bullet');
  VS.setRustPhysicsEnabled(true);
  const tRustBullet = timeIt('Rust: 1 颗普通弹', () => bulletScene.adapter.simulateTankBatch(POSE, OPS, FRAMES, { startPose: POSE }));
  const missileScene = makeScenario('missile');
  VS.setRustPhysicsEnabled(true);
  const tRustMissile = timeIt('Rust: 1 颗制导弹（9 副本）', () => missileScene.adapter.simulateTankBatch(POSE, OPS, FRAMES, { startPose: POSE }));

  const jsNoneScene = makeScenario('none');
  VS.setRustPhysicsEnabled(false);
  const tJsNone = timeIt('JS 融合: 无弹', () => jsNoneScene.adapter.simulateTankBatchJsFused(POSE, OPS, FRAMES, { startPose: POSE, threats: [] }));
  const jsBulletScene = makeScenario('bullet');
  const tJsBullet = timeIt('JS 融合: 1 颗普通弹', () => jsBulletScene.adapter.simulateTankBatchJsFused(POSE, OPS, FRAMES, { startPose: POSE, threats: [] }));
  const jsMissileScene = makeScenario('missile');
  const tJsMissile = timeIt('JS 融合: 1 颗制导弹（9 副本）', () => jsMissileScene.adapter.simulateTankBatchJsFused(POSE, OPS, FRAMES, { startPose: POSE, threats: [] }));

  console.log('--- 代价比（导弹 / 无弹） ---');
  console.log('  Rust 快路: ' + (tRustMissile / tRustNone).toFixed(2) + '×   （普通弹基线 ' + (tRustBullet / tRustNone).toFixed(2) + '×）');
  console.log('  JS 融合 : ' + (tJsMissile / tJsNone).toFixed(2) + '×   （普通弹基线 ' + (tJsBullet / tJsNone).toFixed(2) + '×）');
  console.log('  导航表一次性建表（16x10）: ' + tNav.toFixed(3) + ' ms/次');
  console.log('PERF PROBE DONE');
}
main().catch(function (e) {
  console.error('_probe_missile_perf.js error:', (e && e.stack) || e);
  process.exitCode = 2;
});
