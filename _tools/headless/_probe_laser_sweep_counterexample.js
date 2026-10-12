#!/usr/bin/env node
/* ============================================================================
 * 1-2③ 激光扫掠 —— 反例探针（**修前必 FAIL、修后必 PASS**）
 *
 * 本文件是【新建探针】，不改任何产品代码。
 * 它把《激光判死几何实测-2026-10-11.md》里 5 类真游戏构造冻成 golden scene，
 * 用 **真实的 vantage_sandbox.js（VM 里跑）** 调 `simulateTankBatchJsFused`，
 * 判据 = ① 几何 oracle（线段 ∩ 真坦克夹具多边形）判"应命中"、
 *        ② 修复后沙箱必须 dead=true 且 deathFrame 与 oracle 的首次命中帧一致。
 *
 * 现在（扫掠未做）预期：5 类里 4 类 FAIL（只有 full_edge 偶然 catch）。
 * 修完 1-2③ 后预期：全 PASS，且 **本脚本一行不用改**。
 *
 * 用法：
 *   node _tools/headless/_probe_laser_sweep_counterexample.js           # 契约模式：任一 FAIL 退出码 1
 *   node _tools/headless/_probe_laser_sweep_counterexample.js --report  # 只报告，退出码 0
 *   node _tools/headless/_probe_laser_sweep_counterexample.js --static  # 只跑静态契约
 * ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const JS = (p) => path.join(root, p);
const REPORT = process.argv.includes('--report');
const STATIC_ONLY = process.argv.includes('--static');
const POS_TOL = 1e-9;

/* ---------------------------------------------------------------------------
 * 一、golden 数据：来自真游戏实拍（报告 §三）
 *   p0/p1 = 该帧激光真实位置；C/rot = 坦克真实位姿；
 *   gameKill = 真游戏是否判死（已实测）；chord/g05/g25 = 用真夹具算的几何。
 *   期望（修复后）：dead=true，fd=0（这一帧就跨过）。
 * ------------------------------------------------------------------------- */
const GOLDEN = [
  { name: 'full_edge',        p0: { x: 59.56, y: 15 }, p1: { x: 62.62, y: 15 }, C: { x: 61.09, y: 15 }, rot: 0,
    chord: 3.0,      g05: -0.02,   g25: -0.22,   gameKill: true, expectDeadAfterFix: true,  expectFdAfterFix: 0 },
  { name: 'miss_almostfull',  p0: { x: 49.56, y: 25 }, p1: { x: 52.62, y: 25 }, C: { x: 50.89, y: 23.15 }, rot: -0.1745,
    chord: 2.2226,   g05: 0.0723,  g25: -0.1277, gameKill: true, expectDeadAfterFix: true,  expectFdAfterFix: 0 },
  { name: 'miss_oblique',     p0: { x: 59.56, y: 25 }, p1: { x: 62.62, y: 25 }, C: { x: 60.74, y: 23.25 }, rot: -0.7854,
    chord: 1.4497,   g05: 0.5168,  g25: 0.3168,  gameKill: true, expectDeadAfterFix: true,  expectFdAfterFix: 0 },
  { name: 'miss_corner',      p0: { x: 39.56, y: 15 }, p1: { x: 42.62, y: 15 }, C: { x: 40.69, y: 13 }, rot: -0.8727,
    chord: 0.8827,   g05: 0.7084,  g25: 0.5084,  gameKill: true, expectDeadAfterFix: true,  expectFdAfterFix: 0 },
  { name: 'miss_turret',      p0: { x: 59.56, y: 5 },  p1: { x: 62.62, y: 5 },  C: { x: 61.49, y: 6.9 }, rot: -0.5236,
    chord: 1.3442,   g05: 0.3214,  g25: 0.1214,  gameKill: true, expectDeadAfterFix: true,  expectFdAfterFix: 0 },
];

/* ---------------------------------------------------------------------------
 * 二、静态契约（修复后必须出现；现在必 FAIL）
 *   只查语义标记，不查实现细节（实现可以换名字，但下面这些语义必须被读/传）。
 * ------------------------------------------------------------------------- */
function staticContract() {
  const read = (p) => fs.readFileSync(JS(p), 'utf8');
  const sb = read('game_core/js/vantage_sandbox.js');
  const bridge = read('game_core/js/vantage_rust_bridge.js');
  const rollout = read('game_core/rust/vantage_core/src/rollout.rs');
  const rescore = read('game_core/rust/vantage_core/src/rescore.rs');
  const lib = read('game_core/rust/vantage_core/src/lib.rs');
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });
  const has = (s, re) => (re instanceof RegExp ? re.test(s) : s.indexOf(re) >= 0);

  // 1) LASER 的 needsSweep 必须被真正读取（现在只有定义+注释）
  add('JS: needsSweep 被读取（不再只是元数据）',
      has(sb, /needsSweep/ ) && /needsSweep[\s\S]{0,400}(slot|kind|sweep|acquire)/.test(sb),
      '要求：profile 的 needsSweep 进入 slot/kind 并在判死处使用');
  // 2) 扫掠几何：线段 × 候选 sensor 多边形
  add('JS 融合: 有“线段 × sensor 多边形”测试',
      /Segment|segment/.test(sb) && /(Sensor|sensor)[A-Za-z]*Poly|Poly[A-Za-z]*Sensor/.test(sb),
      '要求：与 fusedCircleSensorPolyGap 并列的 segment 版本');
  add('JS 融合: 有 sweep 回溯补判结果（sweepHit/geoHit 同款）',
      /(sweepHit|segmentHit|laserHit)/.test(sb),
      '要求：rollout 后回溯补判，不能中途停车（v153）');
  // 3) LASER 必须离开 getProjectilePaths 的 bounces:0（真实是镜面反弹 + 0.8s）
  add('JS: LASER 档案 bounces 不再是 0（真激光撞墙镜面反弹）',
      !/put\(W\.LASER,[^\n]*bounces:\s*0/.test(sb),
      '上一份实测：laser 撞墙 |v| 不变、镜面反射、0.8s 寿命才消失');
  // 4) track 白名单必须把 LASER 纳入（或显式 kind 表）
  add('JS track: LASER 不再是硬白名单外',
      /WEAPON_TYPES\.LASER/.test(sb.slice(sb.indexOf('function isBallisticProjectile'), sb.indexOf('function isBallisticProjectile') + 1200)) ||
      /function projectileKind|isTrackable/.test(sb),
      '要求：kind 表/白名单包含 LASER，并带 trackable/sweepable 能力位');
  // 5) Rust BulletInput / RescoreThreatInput 带 sweep 标志
  add('Rust rollout: BulletInput 带 sweep/laser 标志',
      /(needs_sweep|is_laser|bullet_kind)/.test(rollout),
      '要求：从 ABI 弹种码译码，不许只看半径');
  add('Rust rescore: 威胁输入带 sweep/laser 标志',
      /(needs_sweep|is_laser|threat_kind)/.test(rescore) || /(needs_sweep|is_laser|threat_kind)/.test(lib),
      '要求：rescore 的 threat 也要能区分激光');
  // 6) ABI：vt_version 必须 >= 11（弹种码新增 3=LASER / rescore 新参数）
  const vm_ = lib.match(/fn vt_version\(\) -> u32 \{[\s\S]*?\n\s*([0-9]+)\s*\n/);
  add('ABI: vt_version >= 11', vm_ && Number(vm_[1]) >= 11, '当前=' + (vm_ ? vm_[1] : '?'));
  // 7) bridge 必须发弹种码 3（不许只看半径 0/0.05）
  add('bridge: 弹种码含 LASER(=3)（不是只看 radius）',
      /(isLaser|needsSweep|LASER_KIND|BULLET_KIND_LASER|===\s*3)/.test(bridge),
      '要求：bullet kind 数组扩到 3=LASER，rescore 新参数传 kind');
  return checks;
}

/* ---------------------------------------------------------------------------
 * 三、VM 加载真实沙箱（recipe 同 game_core/rust/diff_rollout_bridge.js）
 * ------------------------------------------------------------------------- */
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
  sandbox._ctx = ctx;
  return sandbox;
}

/* ---------------------------------------------------------------------------
 * 四、最小 fake（只满足 fused 判死路径所需接口）
 * ------------------------------------------------------------------------- */
function makeMaze(W, H) {
  const tiles = [];
  for (let i = 0; i < W; i++) {
    tiles[i] = [];
    for (let j = 0; j < H; j++) tiles[i][j] = [1, j === 0 ? 1 : 0, i === 0 ? 1 : 0];
  }
  return { getTiles: () => tiles };
}
function makeFakeBody(Box2D, x, y, vx, vy, rot) {
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
  };
}
function makeFakeTank(Box2D, x, y, rot) {
  const body = makeFakeBody(Box2D, x, y, 0, 0, rot);
  return {
    x, y, rotation: rot, forward: false, back: false, left: false, right: false,
    locked: false, speed: 0, rotationSpeed: 0,
    getX() { return this.x; }, getY() { return this.y; }, getRotation() { return this.rotation; },
    getB2DBody() { return body; },
    _computeSpeed() { this.speed = (this.forward ? 15.95 : 0) + (this.back ? -12.8 : 0); },
    _computeRotationSpeed() { this.rotationSpeed = (this.left ? -5.0 : 0) + (this.right ? 5.0 : 0); },
  };
}
function makeFakeLaser(Box2D, gameP, gameV, radius, lifetime, age) {
  const body = makeFakeBody(Box2D, gameP.x, gameP.y, gameV.x, gameV.y, 0);
  body.GetFixtureList = function () { return { GetShape() { return { m_radius: radius }; } }; };
  return {
    id: 'l-golden', lifetime: lifetime, _age: age,
    done() { return false; },
    getTimeAlive() { return this._age; },
    getType() { return 0; },                       // Constants.WEAPON_TYPES.LASER
    getB2DBody() { return body; },
    getX() { return gameP.x; }, getY() { return gameP.y; },
    getSpeedX() { return gameV.x; }, getSpeedY() { return gameV.y; },
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

/* ---------------------------------------------------------------------------
 * 五、几何 oracle：线段 ∩ 真坦克夹具（3.0×4.0 车体 + 0.7×1.4 炮塔）
 *   ⚠️ 这里不硬编码"应该命中"结论，而是用真 Constants 里的夹具尺寸重建多边形；
 *      golden 的 chord/g05/g25 来自真游戏报告，用于反证 oracle 与实测一致。
 * ------------------------------------------------------------------------- */
function tankPolys(Constants) {
  const w = Constants.TANK.WIDTH.m / 2, h = Constants.TANK.HEIGHT.m / 2;
  const tw = Constants.BULLET_TURRET.WIDTH.m / 2, th = Constants.BULLET_TURRET.HEIGHT.m / 2;
  const oy = Constants.BULLET_TURRET.OFFSET_Y.m;
  return [
    [[-w, -h], [w, -h], [w, h], [-w, h]],
    [[-tw, oy - th], [tw, oy - th], [tw, oy + th], [-tw, oy + th]],
  ];
}
function toWorld(poly, C, rot) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return poly.map(([x, y]) => ({ x: C.x + c * x - s * y, y: C.y + s * x + c * y }));
}
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (((a.y > p.y) !== (b.y > p.y)) && (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)) inside = !inside;
  }
  return inside;
}
function segInt(a, b, c, d) {
  const d1 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d2 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
  const d3 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
  const d4 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
function segHitsPoly(a, b, poly) {
  if (pointInPoly(a, poly) || pointInPoly(b, poly)) return true;
  for (let i = 0; i < poly.length; i++) if (segInt(a, b, poly[i], poly[(i + 1) % poly.length])) return true;
  return false;
}
function oracleHits(scene, Constants) {
  const polys = tankPolys(Constants).map((p) => toWorld(p, scene.C, scene.rot));
  return polys.some((poly) => segHitsPoly(scene.p0, scene.p1, poly));
}

/* ---------------------------------------------------------------------------
 * 六、跑一个 golden scene：真实 JS 融合世界（1 操作 / 3 帧 / tGlobal=0）
 * ------------------------------------------------------------------------- */
function runScene(sandbox, scene) {
  const Box2D = sandbox.Box2D;
  const Constants = sandbox.Constants;
  const VantageSandbox = sandbox.VantageSandbox;
  const maze = makeMaze(12, 8);
  const tank = makeFakeTank(Box2D, scene.C.x, scene.C.y, scene.rot);
  const u = { x: scene.p1.x - scene.p0.x, y: scene.p1.y - scene.p0.y };
  const len = Math.hypot(u.x, u.y);
  const v = { x: u.x / len * 180, y: u.y / len * 180 };
  const laser = makeFakeLaser(Box2D, scene.p0, v, 0, 0.8, 0.2);
  const gc = makeGameController(maze, tank, { 'l-golden': laser });
  const adapter = VantageSandbox.createAdapter(gc, 'tank_b');
  const pose = { x: scene.C.x, y: scene.C.y, rot: scene.rot };
  const ops = [{ name: 'static', inputs: { forward: false, back: false, left: false, right: false } }];
  const res = adapter.simulateTankBatchJsFused(pose, ops, 3, {
    startPose: pose, auditPurpose: 'jsConfirm', tGlobal: 0, nowTGlobal: 0, threats: [],
  });
  const sum = adapter.getLastFusedBatchSummary ? adapter.getLastFusedBatchSummary() : null;
  let proxMin = null;
  if (sum && sum.geometry && sum.geometry.proximity) {
    for (const k in sum.geometry.proximity) {
      const g = sum.geometry.proximity[k];
      if (g && (proxMin === null || g.polyGap < proxMin)) proxMin = g.polyGap;
    }
  }
  return { dead: !!(res && res[0] && res[0].dead), fd: res && res[0] ? res[0].deathFrame : null,
           proxMin, auditPurpose: 'jsConfirm' };
}

/* ---------------------------------------------------------------------------
 * 七、main
 * ------------------------------------------------------------------------- */
function main() {
  const problems = [];
  const statics = staticContract();
  console.log('=== 1-2③ 激光扫掠 反例探针（新建；不改产品代码） ===');
  console.log('\n[静态契约]  修后必须 PASS；现在预期 FAIL');
  for (const c of statics) {
    console.log('  ' + (c.ok ? 'PASS' : 'FAIL') + '  ' + c.name + (c.detail ? '  [' + c.detail + ']' : ''));
    if (!c.ok) problems.push('static: ' + c.name);
  }
  if (STATIC_ONLY) {
    console.log('\n(静态模式：只跑静态契约)');
    process.exitCode = problems.length ? 1 : 0;
    return;
  }

  const sandbox = loadSandbox();
  const Constants = sandbox.Constants;
  console.log('\n[几何 oracle + JS 融合沙箱]  golden 来自真游戏（报告 §三）');
  const rows = [];
  for (const s of GOLDEN) {
    const oracle = oracleHits(s, Constants);
    const cur = runScene(sandbox, s);
    const good = oracle && cur.dead === s.expectDeadAfterFix && cur.fd === s.expectFdAfterFix;
    rows.push({ s, oracle, cur, good });
    if (!oracle) problems.push('oracle: ' + s.name + ' 线段没有命中坦克（golden 数据坏了）');
    if (!good) problems.push('behavior: ' + s.name + ' 现在 dead=' + cur.dead + '/fd=' + cur.fd +
      '，修复后期望 dead=' + s.expectDeadAfterFix + '/fd=' + s.expectFdAfterFix);
  }
  console.log('  name              gameKill  chord   g05     oracle  fusedDead fusedFD  proxMin  修复后期望  现在');
  for (const r of rows) {
    const s = r.s, c = r.cur;
    console.log('  ' + s.name.padEnd(17) + String(s.gameKill).padEnd(10) +
      String(s.chord).padEnd(8) + String(s.g05).padEnd(8) +
      String(r.oracle).padEnd(8) + String(c.dead).padEnd(10) + String(c.fd).padEnd(9) +
      String(c.proxMin).padEnd(9) + (s.expectDeadAfterFix + '/' + s.expectFdAfterFix).padEnd(13) +
      (r.good ? 'PASS' : 'FAIL'));
  }
  console.log('\n[结论]');
  const fails = rows.filter((r) => !r.good).length;
  console.log('  ' + (rows.length - fails) + '/' + rows.length + ' golden scene 通过；静态契约 ' +
    statics.filter((c) => c.ok).length + '/' + statics.length + ' 通过。');
  if (problems.length) {
    console.log('  ⚠️ 扫掠未做（或契约未落）→ 本探针按设计 FAIL：');
    for (const p of problems.slice(0, 12)) console.log('     - ' + p);
  } else {
    console.log('  ✅ 全部 PASS：扫掠已生效。');
  }
  process.exitCode = problems.length ? 1 : 0;
}
main();
