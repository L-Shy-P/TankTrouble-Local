'use strict';
/* ============================================================================
 * 1-2④ 追踪导弹：**先实测**（只读产品代码；本文件是新建探针）
 *
 *   A) 桩事实：常量 / 武器 / 「真 crate 拾取 == 直接工厂」等价性
 *   B) 主飞行：激活门（2.0s）、转向速率、速度模、目标时间线 + TARGET_CHANGED 事件
 *   C) 寿命终点（10.0s？）
 *   ★ 全程内置【逐帧精确复刻对拍】：用游戏自己的 maze API 复算 aim
 *     → 预测下一帧速度 → 与实测逐分量比对（暴露“我理解错了算法”）
 *
 * 用法：node _tools/headless/_probe_homing_facts.js
 * 产物：prof/probe_homing_work.csv + prof/probe_homing_facts.json + stdout
 * ============================================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Match } = require('./match');

const TILE = 10;
const PROFDIR = path.join(__dirname, 'prof');

const FILES = [
  'game_core/index.html',
  'game_core/js/418577fd210ad079ea3d1e5e04050fe0.js',
  'game_core/js/b714588dc4621fe104113111ba90b1a7.js',
  'game_core/js/46989e393ad0e356ac8a0c6c53b362f9.js',
  'game_core/js/82e43ebfcdffdaf490dbe79c9c119d29.js',
  'game_core/js/7b2ed8ad3598d7321f8f3d2b04b1eac8.js',
  'game_core/js/vantage_tree.js',
  'game_core/js/vantage_sandbox.js',
  'game_core/js/vantage_rust_bridge.js',
  'game_core/js/wasm/vantage_core.wasm',
  '_tools/headless/match.js',
  '_tools/headless/clock.js',
];
function fingerprints() {
  const out = [];
  for (const rel of FILES) {
    const p = path.join(__dirname, '..', '..', rel);
    try {
      const st = fs.statSync(p);
      out.push({ file: rel, mtime: st.mtime.toISOString(), bytes: st.size,
        md5: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') });
    } catch (e) { out.push({ file: rel, err: String(e.message || e) }); }
  }
  return out;
}

const HELPERS = `
window.__vtHm = {
  on: false, rows: [], cols: [], evs: [], _inst: false, tag: '',
  r: function (x) { return Math.round(x * 10000) / 10000; },
  install: function () {
    if (this._inst) return 'already';
    this._inst = true;
    var self = this;
    window.__vtAfter.push(function () {
      if (!self.on) return;
      var s = self.sample();
      if (s) { s.tag = self.tag; self.rows.push(s); }
    });
    var gc = GameManager.getGameController();
    var rm = gc.roundController && gc.roundController.model;
    if (rm && rm.addEventListener) {
      rm.addEventListener(function (ctx, gid, evt, data) {
        if (evt === 'homing missile target changed') {
          var o = { f: window.__vt.steps, t: window.__vt.t, kind: 'targetChanged' };
          try { o.projectileId = data.getProjectileId ? data.getProjectileId() : null;
                o.targetId = data.getTargetId ? data.getTargetId() : null; } catch (e) { o.err = String(e && e.message || e); }
          self.evs.push(o);
        } else if (evt === 'projectile timeout' || evt === 'projectile destroyed' ||
                   evt === 'tank deadly collision' || evt === 'tank killed') {
          var d = { f: window.__vt.steps, t: window.__vt.t, kind: evt };
          try { if (data && data.projectile) { d.id = data.projectile.getId(); d.ty = data.projectile.getType(); d.ta = data.projectile.getTimeAlive(); } } catch (e) {}
          try { if (typeof data === 'string') d.data = data;
                if (data && data.getVictimPlayerId) d.victim = data.getVictimPlayerId();
                if (data && data.getKillerPlayerId) d.killer = data.getKillerPlayerId(); } catch (e) {}
          self.evs.push(d);
        } else if (evt === 'projectile maze collision' || evt === 'projectile shield collision') {
          try {
            var p = data.projectile;
            if (p.getType() === 3) self.cols.push({ f: window.__vt.steps, t: window.__vt.t, id: p.getId(), evt: evt,
              cx: self.r(data.collisionPoint.x), cy: self.r(data.collisionPoint.y),
              nx: self.r(data.collisionNormal.x), ny: self.r(data.collisionNormal.y) });
          } catch (e) {}
        }
      }, null, gc.getId());
    }
    return 'installed';
  },
  clear: function () { var n = this.rows.length; this.rows = []; this.cols = []; this.evs = []; return n; },
  sample: function () {
    var gc = GameManager.getGameController();
    if (!gc) return null;
    var rm = gc.roundController && gc.roundController.model;
    var maze = rm ? rm.getMaze() : null;
    var tiles = Constants.MAZE_TILE_SIZE.m;
    var tExact = window.__vt.epoch + window.__vt.t;          // 未截断
    var nowMs = Math.floor(tExact);                          // 游戏 new Date().getTime() 的截断值
    var dtNext = (Math.floor(tExact + window.__vt.dt) - nowMs) / 1000;
    var dt = window.__vt.dt / 1000;
    var out = { f: window.__vt.steps, t: Math.round(window.__vt.t * 100) / 100, dt: dt, nowMs: nowMs, dtNext: dtNext, m: [], tk: [] };

    var tanks = rm ? rm.getTanks() : {};
    for (var id in tanks) {
      out.tk.push({ id: id, x: this.r(tanks[id].getX()), y: this.r(tanks[id].getY()),
                    tx: Math.floor(tanks[id].getX() / tiles), ty: Math.floor(tanks[id].getY() / tiles) });
    }

    var ps = gc.getProjectiles();
    for (var k in ps) {
      var p = ps[k];
      if (p.getType() !== 3) continue;
      var b = p.getB2DBody(), v = b.GetLinearVelocity();
      var mrow = {
        id: k, o: p.getPlayerId(), x: this.r(p.getX()), y: this.r(p.getY()),
        vx: this.r(v.x), vy: this.r(v.y), sp: this.r(v.Length()),
        ta: this.r(p.getTimeAlive()), la: p.lifetime, dto: p.isDeadlyToOwner(), nb: p.bounces.length,
        tgt: p.currentTargetPlayerId === null || p.currentTargetPlayerId === undefined ? null : p.currentTargetPlayerId,
        initSpSq: Math.round(p.initialSpeedSquared * 10000) / 10000, st: p.stopped
      };
      try {
        var startPosition = { x: Math.floor(p.x / tiles), y: Math.floor(p.y / tiles) };
        var distances = maze.getDistancesFromPosition(startPosition);
        if (distances === false) { mrow.aimErr = 'no-distances'; }
        else {
          var shortestDistance = null, targetPosition = null, targetPlayerId = null, cands = [];
          for (var tank in tanks) {
            var ep = { x: Math.floor(tanks[tank].getX() / tiles), y: Math.floor(tanks[tank].getY() / tiles) };
            var cd = maze.getDistanceToPosition(distances, ep);
            cands.push({ tank: tank, tile: [ep.x, ep.y], dist: cd });
            if (cd !== false) {
              if (shortestDistance === null || cd < shortestDistance ||
                  (cd === shortestDistance && tank !== p.getPlayerId())) {
                shortestDistance = cd; targetPosition = ep; targetPlayerId = tank;
              }
            }
          }
          mrow.cands = cands;
          mrow.tgtMy = targetPlayerId;
          mrow.sd = shortestDistance;
          mrow.aimKind = null;
          if (targetPlayerId) {
            var aim = null;
            if (shortestDistance <= 1) { aim = { x: tanks[targetPlayerId].getX(), y: tanks[targetPlayerId].getY() }; mrow.aimKind = 'tank-exact'; }
            else {
              var path = maze.getShortestPathWithGraph(startPosition, targetPosition);
              if (!path || !path.length) mrow.aimErr = 'empty-path';
              else { aim = { x: (path[0].x + 0.5) * tiles, y: (path[0].y + 0.5) * tiles }; mrow.aimKind = 'next-tile'; mrow.path0 = path[0]; }
            }
            if (aim) {
              mrow.aim = { x: this.r(aim.x), y: this.r(aim.y) };
              var rel = B2DUtils.toLocalSpace(b, aim);
              mrow.rel = { x: this.r(rel.x), y: this.r(rel.y) };
              var willActivate = (p.getTimeAlive() + dt) > Constants.HOMING_MISSILE_ACTIVATION_TIME;
              mrow.predGate = willActivate;
              if (!willActivate) {
                mrow.pred = { x: this.r(v.x), y: this.r(v.y), renorm: false, gate: 'pre' };
              } else {
                var acc = Constants.HOMING_MISSILE.ACCELERATION;
                var nx = v.x + (rel.x < 0 ? -1 : 1) * acc * dtNext;
                var ny = v.y + (rel.y < 0 ? -1 : 1) * acc * dtNext;
                var nsq = nx * nx + ny * ny, len = Math.sqrt(nsq), renorm = false;
                if (nsq - p.initialSpeedSquared > 0.01) { nx = nx / len * p.initialSpeed; ny = ny / len * p.initialSpeed; renorm = true; }
                mrow.pred = { x: this.r(nx), y: this.r(ny), renorm: renorm, gate: 'act' };
              }
            }
          }
        }
      } catch (e) { mrow.aimErr = String(e && e.message || e); }
      out.m.push(mrow);
    }
    return out;
  },
  chunk: function (from, n) { return this.rows.slice(from, from + n); }
};
window.__vtProjN = function (ty) {
  var gc = GameManager.getGameController(), ps = gc.getProjectiles(), n = 0;
  for (var k in ps) { if (ty === undefined || ps[k].getType() === ty) n++; }
  return n;
};
`;

const writeCsv = (file, rows) => { fs.writeFileSync(file, rows.join('\n') + '\n'); return { file, rows: rows.length, bytes: fs.statSync(file).size }; };
async function dumpRows(m, n = 250) {
  const rows = [];
  for (let from = 0; ; from += n) {
    const part = await m.eval(`window.__vtHm.chunk(${from}, ${n})`);
    if (!Array.isArray(part) || !part.length) break;
    for (const r of part) rows.push(r);
    if (part.length < n) break;
  }
  return rows;
}
const key = (x, y) => x + ',' + y;
const DIRS = [
  { dx: 1, dy: 0, rot: Math.PI / 2, name: '+x' },
  { dx: -1, dy: 0, rot: -Math.PI / 2, name: '-x' },
  { dx: 0, dy: 1, rot: Math.PI, name: '+y' },
  { dx: 0, dy: -1, rot: 0, name: '-y' },
];
function findLane(mz) {
  const S = new Set(mz.reachable.map((r) => key(r.x, r.y)));
  let best = null;
  for (const r of mz.reachable) for (const d of DIRS) {
    let n = 1;
    while (S.has(key(r.x + n * d.dx, r.y + n * d.dy))) n++;
    if (!best || n > best.n) best = { n, start: r, dir: d };
  }
  return best;
}
function analyze(rows, cols, evs, id) {
  const seq = rows.map((r) => ({ f: r.f, t: r.t, dt: r.dt, tk: r.tk, m: r.m.find((x) => x.id === id) || null })).filter((s) => s.m);
  const colFrames = new Set(cols.filter((c) => c.id === id).map((c) => c.f));
  const out = { frames: seq.length, colFrames: [...colFrames] };
  if (!seq.length) return out;
  out.first = seq[0].m; out.last = seq[seq.length - 1].m;
  let minSp = 1e9, maxSp = -1e9, spBad = 0;
  const turns = [];
  for (let i = 0; i < seq.length; i++) {
    const p = seq[i].m;
    minSp = Math.min(minSp, p.sp); maxSp = Math.max(maxSp, p.sp);
    if (Math.abs(p.sp - 18) > 1e-6) spBad++;
    if (i === 0) continue;
    const q = seq[i - 1].m;
    let d0 = Math.atan2(p.vy, p.vx) - Math.atan2(q.vy, q.vx);
    while (d0 > Math.PI) d0 -= 2 * Math.PI; while (d0 < -Math.PI) d0 += 2 * Math.PI;
    if (Math.abs(d0) > 1e-9) turns.push({ f: seq[i].f, ta: p.ta, deg: d0 * 180 / Math.PI, collided: colFrames.has(seq[i].f), from: { vx: q.vx, vy: q.vy }, to: { vx: p.vx, vy: p.vy } });
  }
  out.speed = { min: minSp, max: maxSp, bad: spBad };
  out.firstTurn = turns[0] || null;
  out.turnCount = turns.length;
  out.turnsNonCollision = turns.filter((t) => !t.collided);
  out.maxTurnGuided = out.turnsNonCollision.filter((t) => t.ta > 2.0).reduce((a, t) => Math.max(a, Math.abs(t.deg)), 0);
  out.maxTurnPre = out.turnsNonCollision.filter((t) => t.ta <= 2.0).reduce((a, t) => Math.max(a, Math.abs(t.deg)), 0);
  let n = 0, ok = 0; const bad = [];
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1].m, cur = seq[i].m;
    if (!prev.pred || prev.aimErr || cur.aimErr) continue;
    if (colFrames.has(seq[i].f)) continue;
    n++;
    const ex = Math.abs(prev.pred.x - cur.vx), ey = Math.abs(prev.pred.y - cur.vy);
    if (ex < 1e-9 && ey < 1e-9) ok++; else if (bad.length < 10) bad.push({ f: seq[i].f, ta: cur.ta, pred: prev.pred, actual: { vx: cur.vx, vy: cur.vy }, aimKind: prev.aimKind, predGate: prev.predGate, tgt: prev.tgt, d: [ex, ey] });
  }
  out.predCmp = { n, ok, bad };
  const tl = []; let cur = undefined;
  for (const s of seq) if (s.m.tgt !== cur) { tl.push({ f: s.f, ta: s.m.ta, from: cur === undefined ? null : cur, to: s.m.tgt, myTgt: s.m.tgtMy, sd: s.m.sd }); cur = s.m.tgt; }
  out.targetTimeline = tl;
  out.evs = evs;
  return out;
}
async function giveMissile(m, tankId) {
  return m.eval(`(() => {
    var gc = GameManager.getGameController();
    var ws = HomingMissileWeapon.createInitialWeaponState(IdGenerator.instance.gen('hmw'), ${JSON.stringify(tankId)});
    gc.roundController.setWeaponState(ws);
    var w = gc.getActiveWeapon(${JSON.stringify(tankId)});
    return { activeType: w ? w.getType() : null, fields: w ? JSON.stringify(w.getFields()) : null };
  })()`);
}
async function fireOne(m, tankId) {
  await m.eval(`window.__vtTankId = ${JSON.stringify(tankId)}; 1`);
  await m.setControl({ fwd: false, back: false, left: false, right: false, fire: false });
  await m.setControl({ fire: true }); await m.pump(1); await m.setControl({ fire: false });
  return m.eval('window.__vtProjN(3)');
}
async function drain(m, P, cap = 400) {
  for (let i = 0; i < cap; i++) {
    if ((await m.eval('window.__vtProjN()')) === 0) return i;
    await m.pump(2);
  }
  P('  !! drain cap reached, projectiles still alive');
  return cap;
}
async function ensureTanks(m, P, spots) {
  const alive = await m.eval(`(() => { var ts = GameManager.getGameController().getTanks(); var o = {}; for (var k in ts) o[k] = 1; return o; })()`);
  for (const tid of ['tank_a', 'tank_b', 'tank_c']) {
    if (!alive[tid]) {
      const sp = spots[tid] || spots.tank_a;
      await m.eval(`GameManager.getGameController().roundController.spawnTank(${JSON.stringify(tid)}, {x:${sp.x},y:${sp.y},rotation:0}, true); 1`);
      P('  [setup] respawn ' + tid);
      await m.pump(2);
    }
  }
}
async function missileTa(m) {
  return m.eval(`(() => { var gc=GameManager.getGameController(), ps=gc.getProjectiles();
    for (var k in ps) if (ps[k].getType()===3) return { ta: ps[k].getTimeAlive(), id: k, tgt: ps[k].currentTargetPlayerId,
      dto: ps[k].isDeadlyToOwner(), nb: ps[k].bounces.length, x: ps[k].getX(), y: ps[k].getY(),
      vx: ps[k].getSpeedX(), vy: ps[k].getSpeedY() };
    return null; })()`);
}

(async () => {
  const m = new Match();
  const report = { fingerprints: fingerprints(), stages: [] };
  const P = (s) => console.log(s);
  const T0 = Date.now();
  const R = {};
  const push = (o) => { report.stages.push(o); return o; };

  try {
    P('=== 版本指纹 ===');
    for (const f of report.fingerprints) P(`  ${f.file}  ${f.mtime}  ${f.md5}  ${f.bytes}`);

    await m.open({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
    P(`\n=== open: ${JSON.stringify(m.roundWait)} ===`);
    await m.eval(HELPERS);
    P('  helper: ' + (await m.eval('window.__vtHm.install()')));
    const mz = await m.maze();
    const reach = mz.reachable;
    P(`  迷宫 ${mz.width}x${mz.height} 可达 ${reach.length}`);
    const lane = findLane(mz);
    const laneTiles = [];
    for (let i = 0; i < lane.n; i++) laneTiles.push({ x: lane.start.x + i * lane.dir.dx, y: lane.start.y + i * lane.dir.dy });
    const laneStartPose = { x: laneTiles[0].x * TILE + 5, y: laneTiles[0].y * TILE + 5, rot: lane.dir.rot };
    const laneEndPose = { x: laneTiles[lane.n - 1].x * TILE + 5, y: laneTiles[lane.n - 1].y * TILE + 5 };
    const offLane = reach.filter((r) => !laneTiles.some((t) => t.x === r.x && t.y === r.y));
    const park = offLane[offLane.length - 1] || reach[reach.length - 1];
    R.lane = { lane, laneTiles, laneStartPose, laneEndPose, park };
    P(`  最长直道: ${JSON.stringify(lane)}`);
    P(`  直道格=${JSON.stringify(laneTiles)} 起点位姿=${JSON.stringify(laneStartPose)} 终点=${JSON.stringify(laneEndPose)} 停车格=${JSON.stringify(park)}`);

    /* ================= A) 桩事实 ================= */
    const A = push({ tag: 'A_facts' });
    try {
      A.consts = await m.eval(`({
        HM_ACT: Constants.HOMING_MISSILE_ACTIVATION_TIME, HM_MAX_LIFE: Constants.HOMING_MISSILE_MAX_LIFETIME,
        HM_ACC: Constants.HOMING_MISSILE.ACCELERATION, HM_RADIUS: Constants.HOMING_MISSILE.RADIUS.m,
        HM_SPEED: Constants.HOMING_MISSILE.SPEED.m, HM_OFFSET: Constants.HOMING_MISSILE.OFFSET.m,
        TILE: Constants.MAZE_TILE_SIZE.m })`);
      P('\n=== A) 桩事实 ===');
      P('  常量: ' + JSON.stringify(A.consts));
      const spot = reach[Math.floor(reach.length / 2)];
      const cpos = { x: spot.x * TILE + 5, y: spot.y * TILE + 5 };
      await m.teleport('tank_c', cpos.x + TILE, cpos.y, 0);
      await m.pump(4);
      await m.eval(`GameManager.getGameController().roundController.spawnCrate(Constants.COLLECTIBLE_TYPES.CRATE_HOMING_MISSILE, {x:${cpos.x},y:${cpos.y},rotation:0}); 1`);
      await m.pump(4);
      A.spawned = await m.eval(`(() => { var cs = GameManager.getGameController().getCollectibles(), n=0, one=null;
        for (var k in cs) { n++; one = { id:k, type: cs[k].getType(), x: cs[k].getX(), y: cs[k].getY() }; } return { n:n, one:one }; })()`);
      P('  spawnCrate(CRATE_HOMING_MISSILE) → ' + JSON.stringify(A.spawned));
      await m.teleport('tank_c', cpos.x, cpos.y, 0);
      await m.pump(10);
      A.afterPickup = await m.eval(`(() => { var gc = GameManager.getGameController(); var w = gc.getActiveWeapon('tank_c');
        return { weaponId: w && w.getId(), weaponType: w && w.getType(), fields: w ? w.getFields() : null,
                 isDefault: w ? w.isDefault() : null, movementLocked: w ? w.movementLocked() : null, done: w ? w.done() : null }; })()`);
      A.direct = await m.eval(`(() => { var ws = HomingMissileWeapon.createInitialWeaponState(IdGenerator.instance.gen('hmw'), 'tank_c');
        return { type: ws.getType(), fields: ws.getFields() }; })()`);
      P('  真 crate 拾取后: ' + JSON.stringify(A.afterPickup));
      P('  直接工厂: ' + JSON.stringify(A.direct));
      P('  ⟹ 等价: ' + JSON.stringify({ typeEq: A.afterPickup.weaponType === A.direct.type,
        fieldsEq: JSON.stringify(A.afterPickup.fields) === JSON.stringify(A.direct.fields) }));
      await m.eval(`(() => { var gc = GameManager.getGameController(); var w = gc.getActiveWeapon('tank_c');
        if (w && w.getType() === 3) gc.roundController.destroyWeapon(WeaponDeactivation.create(w.getId(), 'tank_c')); return 1; })()`);
      await m.pump(4);
    } catch (e) { A.err = String((e && e.stack) || e); P('  X A 失败: ' + A.err); }

    /* ================= B) 主飞行（沿直道 → 激活 → 把目标摆到侧面看转向） ================= */
    const B = push({ tag: 'B_flight' });
    try {
      P('\n=== B) 主飞行 ===');
      await m.setControl({ fwd: false, back: false, left: false, right: false, fire: false });
      await m.teleport('tank_a', laneStartPose.x, laneStartPose.y, laneStartPose.rot);
      await m.teleport('tank_b', laneEndPose.x, laneEndPose.y, 0);
      await m.teleport('tank_c', park.x * TILE + 5, park.y * TILE + 5, 0);
      await m.pump(6);
      B.setup = { laneStartPose, laneEndPose, park };
      P('  给武器: ' + JSON.stringify(await giveMissile(m, 'tank_a')));
      await m.eval(`window.__vtHm.clear(); window.__vtHm.tag='B'; window.__vtHm.on = true;`);
      await drain(m, P);
      await ensureTanks(m, P, { tank_a: laneStartPose, tank_b: laneEndPose, tank_c: { x: park.x * TILE + 5, y: park.y * TILE + 5 } });
      await m.teleport('tank_a', laneStartPose.x, laneStartPose.y, laneStartPose.rot);
      await m.teleport('tank_b', laneEndPose.x, laneEndPose.y, 0);
      await m.teleport('tank_c', park.x * TILE + 5, park.y * TILE + 5, 0);
      await m.pump(4);
      const n0 = await fireOne(m, 'tank_a');
      P(`  开火后导弹数=${n0}（tank_a @${JSON.stringify(laneStartPose)} 朝 ${lane.dir.name}）`);
      // ★ 立刻把发射者挪到停车格：否则导弹 2s 后会把「发射者」当最近目标回头打它
      await m.teleport('tank_a', park.x * TILE + 5, park.y * TILE + 5, 0);
      P('  已把 tank_a 挪到停车格 ' + JSON.stringify(park));
      let st = null;
      for (let i = 0; i < 220; i++) {
        await m.pump(1);
        st = await missileTa(m);
        if (!st) { P('  !! 导弹提前消失'); break; }
        if (st.ta > 2.15) break;
      }
      P(`  ta≈2.15 时: ${JSON.stringify(st)}`);
      B.at215 = st;
      if (st) {
        const mv0 = { x: st.x, y: st.y, vx: st.vx, vy: st.vy };
        const mtile = { x: Math.floor(mv0.x / TILE), y: Math.floor(mv0.y / TILE) };
        const perp = Math.abs(mv0.vx) > Math.abs(mv0.vy) ? [{ dx: 0, dy: 1 }, { dx: 0, dy: -1 }] : [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }];
        let sideTile = null;
        for (const d of perp) {
          const c = { x: mtile.x + d.dx, y: mtile.y + d.dy };
          if (reach.some((r) => r.x === c.x && r.y === c.y)) { sideTile = c; break; }
        }
        B.sideTile = sideTile; B.missileAt215 = mv0;
        P(`  导弹@${JSON.stringify(mv0)} tile=${JSON.stringify(mtile)} → 侧面格=${JSON.stringify(sideTile)}`);
        if (sideTile) {
          await m.teleport('tank_b', sideTile.x * TILE + 5, sideTile.y * TILE + 5, 0);
          P('  已把 tank_b 挪到侧面（迷宫距离 1 → aim=tank-exact → 满转向）');
        }
      }
      for (let i = 0; i < 72; i++) {
        await m.pump(1);
        const s2 = await missileTa(m);
        if (!s2) { P('  导弹在此期间消失'); break; }
      }
      await m.eval('window.__vtHm.on = false');
      const rows = await dumpRows(m);
      const cols = await m.eval('window.__vtHm.cols.slice()');
      const evs = await m.eval('window.__vtHm.evs.slice()');
      const id = rows.map((r) => (r.m[0] || {}).id).find((x) => x) || null;
      B.id = id; B.rows = rows.length;
      B.analysis = analyze(rows, cols, evs, id);
      B.csv = writeCsv(path.join(PROFDIR, 'probe_homing_work.csv'),
        ['f,t,ta,x,y,vx,vy,sp,tgt,tgtMy,sd,aimKind,aimx,aimy,relx,rely,predx,predy,predGate,renorm,dto,nb,err'].concat(
          rows.map((r) => { const p = r.m.find((x) => x.id === id); if (!p) return `${r.f},${r.t},-`; return [r.f, r.t, p.ta, p.x, p.y, p.vx, p.vy, p.sp, p.tgt, p.tgtMy, p.sd, p.aimKind,
            p.aim ? p.aim.x : '', p.aim ? p.aim.y : '', p.rel ? p.rel.x : '', p.rel ? p.rel.y : '',
            p.pred ? p.pred.x : '', p.pred ? p.pred.y : '', p.pred ? p.pred.gate : '', p.pred ? (p.pred.renorm ? 1 : 0) : '',
            p.dto ? 1 : 0, p.nb, p.aimErr || ''].join(','); })));
      const an = B.analysis;
      P(`  采样帧=${an.frames}  首帧=${JSON.stringify(an.first)}`);
      P(`  |v| 范围=[${an.speed.min}, ${an.speed.max}]  ≠18 的帧数=${an.speed.bad}`);
      P(`  首次转向: ${JSON.stringify(an.firstTurn)}`);
      P(`  非碰撞帧：激活前最大转角=${an.maxTurnPre.toFixed(4)}°  激活后最大转角=${an.maxTurnGuided.toFixed(4)}°（理论 atan(40*dt/18)=2.1211°）`);
      P(`  ★ 逐帧精确复刻对拍: ${an.predCmp.ok}/${an.predCmp.n} 完全一致`);
      if (an.predCmp.bad.length) P(`  对拍失败样例: ${JSON.stringify(an.predCmp.bad.slice(0, 4))}`);
      P(`  目标时间线: ${JSON.stringify(an.targetTimeline)}`);
      P(`  TARGET_CHANGED: ${JSON.stringify(an.evs)}`);
      P(`  撞墙帧: ${JSON.stringify(an.colFrames)}`);
      P(`  末帧: ${JSON.stringify(an.last)}`);
    } catch (e) { B.err = String((e && e.stack) || e); P('  X B 失败: ' + B.err); }

    /* ================= C) 寿命终点（种一颗无目标弹：全程直飞） ================= */
    const C = push({ tag: 'C_lifetime' });
    try {
      P('[C] lifetime (seeded, no tanks to chase)');
      await drain(m, P);
      const seeded = await m.eval(`(() => {
        var gc = GameManager.getGameController();
        var ps = ProjectileState.withState('probe_hm_life','tank_a',3, ${laneStartPose.x}, ${laneStartPose.y}, ${Math.sin(laneStartPose.rot) * 18}, ${-Math.cos(laneStartPose.rot) * 18});
        gc.roundController.setProjectileState(ps);
        var p = gc.getProjectile('probe_hm_life');
        return p ? { id: p.getId(), ta: p.getTimeAlive(), la: p.lifetime, x: p.getX(), y: p.getY(), vx: p.getSpeedX(), vy: p.getSpeedY(), tgt: p.currentTargetPlayerId } : null;
      })()`);
      C.seeded = seeded;
      P('  seeded: ' + JSON.stringify(seeded));
      const ev0 = await m.eval('window.__vtHm.evs.length');
      await m.eval(`window.__vtHm.clear(); window.__vtHm.tag='C'; window.__vtHm.on = true;`);
      let lastSt = null, frames = 0;
      for (let i2 = 0; i2 < 700; i2++) {
        await m.pump(2); frames += 2;
        const alive = await m.eval(`!!GameManager.getGameController().getProjectile('probe_hm_life')`);
        if (!alive) { P(`  missile gone after ~${frames} frames`); break; }
        lastSt = await m.eval(`(() => { var p = GameManager.getGameController().getProjectile('probe_hm_life');
          return p ? { ta: p.getTimeAlive(), x: p.getX(), y: p.getY(), vx: p.getSpeedX(), vy: p.getSpeedY(), tgt: p.currentTargetPlayerId, nb: p.bounces.length } : null; })()`);
        if (lastSt && lastSt.ta > 11) { P('  !! ta>11 still alive'); break; }
      }
      await m.eval('window.__vtHm.on = false');
      C.lastSt = lastSt; C.frames = frames;
      C.evs = await m.eval('window.__vtHm.evs.slice()');
      P(`  末态(最后一次读到): ${JSON.stringify(lastSt)}`);
      P(`  事件流: ${JSON.stringify(C.evs.filter((e) => e.kind !== 'targetChanged'))}`);
      P(`  采样帧数: ${(await dumpRows(m)).length}`);
    } catch (e) { C.err = String((e && e.stack) || e); P('  X C failed: ' + C.err); }

    /* ================= C2) lifetime: 把三辆坦克挪到迷宫外 → 导弹无目标 → 只可能自然死亡 ================= */
    const C2 = push({ tag: 'C2_lifetime_empty' });
    try {
      P('[C2] lifetime, all tanks moved OUTSIDE the maze (no target => no steering)');
      await drain(m, P);
      await ensureTanks(m, P, { tank_a: laneStartPose, tank_b: laneEndPose, tank_c: { x: park.x * TILE + 5, y: park.y * TILE + 5 } });
      for (const tid of ['tank_a', 'tank_b', 'tank_c']) {
        await m.teleport(tid, -80 - 12 * ['tank_a', 'tank_b', 'tank_c'].indexOf(tid), -80, 0, { verify: false });
      }
      await m.pump(4);
      C2.outside = await m.eval(`(() => { var gc = GameManager.getGameController(); var mz = gc.getMaze();
        var D = Constants.MAZE_TILE_SIZE.m; var out = {};
        for (var k in gc.getTanks()) { var t = gc.getTanks()[k];
          var tile = { x: Math.floor(t.getX() / D), y: Math.floor(t.getY() / D) };
          out[k] = { x: t.getX(), y: t.getY(), tile: tile, dist: mz.getDistancesFromPosition(tile) === false ? 'false' : 'ok' }; }
        return out; })()`);
      P('  outside: ' + JSON.stringify(C2.outside));
      const seeded2 = await m.eval(`(() => {
        var gc = GameManager.getGameController();
        var ps = ProjectileState.withState('probe_hm_life2','tank_a',3, ${laneStartPose.x}, ${laneStartPose.y}, ${Math.sin(laneStartPose.rot) * 18}, ${-Math.cos(laneStartPose.rot) * 18});
        gc.roundController.setProjectileState(ps);
        var p = gc.getProjectile('probe_hm_life2');
        return p ? { id: p.getId(), ta: p.getTimeAlive(), la: p.lifetime, tgt: p.currentTargetPlayerId, x: p.getX(), y: p.getY(), vx: p.getSpeedX(), vy: p.getSpeedY() } : null; })()`);
      C2.seeded = seeded2;
      P('  seeded: ' + JSON.stringify(seeded2));
      await m.eval(`window.__vtHm.clear(); window.__vtHm.tag='C2'; window.__vtHm.on = true;`);
      let last2 = null, frames2 = 0;
      for (let i2 = 0; i2 < 700; i2++) {
        await m.pump(2); frames2 += 2;
        const alive = await m.eval(`!!GameManager.getGameController().getProjectile('probe_hm_life2')`);
        if (!alive) { P('  [C2] missile gone after ~' + frames2 + ' frames'); break; }
        last2 = await m.eval(`(() => { var p = GameManager.getGameController().getProjectile('probe_hm_life2');
          return p ? { ta: p.getTimeAlive(), x: p.getX(), y: p.getY(), vx: p.getSpeedX(), vy: p.getSpeedY(), tgt: p.currentTargetPlayerId, nb: p.bounces.length, sp: p.getSpeedX()*p.getSpeedX()+p.getSpeedY()*p.getSpeedY() } : null; })()`);
        if (last2 && last2.ta > 11) { P('  [C2] !! ta>11 still alive'); break; }
      }
      await m.eval('window.__vtHm.on = false');
      C2.last = last2; C2.frames = frames2;
      C2.evs = await m.eval('window.__vtHm.evs.slice()');
      P('  [C2] last read: ' + JSON.stringify(last2));
      P('  [C2] events: ' + JSON.stringify(C2.evs.filter((e) => e.kind !== 'targetChanged')));
    } catch (e) { C2.err = String((e && e.stack) || e); P('  X C2 failed: ' + C2.err); }

    /* ================= G) 换目标专项 ================= */
    const G = push({ tag: 'G_switch' });
    try {
      P('[G] target switch');
      await drain(m, P);
      await ensureTanks(m, P, { tank_a: laneStartPose, tank_b: laneEndPose, tank_c: { x: park.x * TILE + 5, y: park.y * TILE + 5 } });
      await m.setControl({ fwd: false, back: false, left: false, right: false, fire: false });
      await m.teleport('tank_a', laneStartPose.x, laneStartPose.y, laneStartPose.rot);
      await m.teleport('tank_b', laneEndPose.x, laneEndPose.y, 0);
      await m.teleport('tank_c', park.x * TILE + 5, park.y * TILE + 5, 0);
      await m.pump(6);
      await giveMissile(m, 'tank_a');
      await m.eval(`window.__vtHm.clear(); window.__vtHm.tag='G'; window.__vtHm.on = true;`);
      const ng = await fireOne(m, 'tank_a');
      await m.teleport('tank_a', park.x * TILE + 5, park.y * TILE + 5, 0);
      P('  fired=' + ng + ', owner parked');
      let cur = null;
      for (let i2 = 0; i2 < 200; i2++) {
        await m.pump(1);
        const sm = await missileTa(m);
        if (!sm) { P('  missile gone early'); break; }
        if (sm.ta > 2.4) { cur = sm; break; }
      }
      P('  before switch: ' + JSON.stringify(cur));
      if (cur && cur.tgt) {
        // 把当前目标挪到最远的直道另一端，再把另一辆挪到导弹旁边（1 格内）
        const mt = { x: Math.floor(cur.x / TILE), y: Math.floor(cur.y / TILE) };
        let nearTile = null;
        for (const d of [{dx:1,dy:0},{dx:-1,dy:0},{dx:0,dy:1},{dx:0,dy:-1}]) {
          const c = { x: mt.x + d.dx, y: mt.y + d.dy };
          if (reach.some((r) => r.x === c.x && r.y === c.y)) { nearTile = c; break; }
        }
        const other = ['tank_a', 'tank_b', 'tank_c'].find((t) => t !== cur.tgt);
        P('  switch: move ' + cur.tgt + ' far, move ' + other + ' to ' + JSON.stringify(nearTile));
        await m.teleport(cur.tgt, laneEndPose.x, laneEndPose.y, 0);
        if (nearTile) await m.teleport(other, nearTile.x * TILE + 5, nearTile.y * TILE + 5, 0);
        for (let i2 = 0; i2 < 40; i2++) {
          await m.pump(1);
          const sm = await missileTa(m);
          if (!sm) { P('  missile gone during switch'); break; }
          if (sm.tgt !== cur.tgt) { P('  ★ target switched to ' + sm.tgt + ' at ta=' + sm.ta); break; }
        }
      }
      await m.eval('window.__vtHm.on = false');
      G.rows = (await dumpRows(m)).length;
      G.evs = await m.eval('window.__vtHm.evs.slice()');
      P('  events: ' + JSON.stringify(G.evs));
    } catch (e) { G.err = String((e && e.stack) || e); P('  X G failed: ' + G.err); }

    /* ================= F) pre-activation: can the missile kill its OWNER? ================= */
    const F = push({ tag: 'F_prekill' });
    try {
      P('\n=== F) pre-activation owner kill ===');
      const aliveF = await m.eval(`(() => { var ts = GameManager.getGameController().getTanks(); var o = {}; for (var k in ts) o[k] = 1; return o; })()`);
      for (const tid of ['tank_a', 'tank_b', 'tank_c']) {
        if (!aliveF[tid]) {
          await m.eval(`GameManager.getGameController().roundController.spawnTank(${JSON.stringify(tid)}, {x:${laneEndPose.x},y:${laneEndPose.y},rotation:0}, true); 1`);
          P('  [F] respawn ' + tid);
        }
      }
      await m.pump(4);
      await m.eval(`window.__vtTankId = 'tank_a'; 1`);
      await m.setControl({ fwd: false, back: false, left: false, right: false, fire: false });
      await m.teleport('tank_a', laneStartPose.x, laneStartPose.y, laneStartPose.rot);
      await m.teleport('tank_b', park.x * TILE + 5, park.y * TILE + 5, 0);
      await m.teleport('tank_c', laneEndPose.x, laneEndPose.y, 0);
      await m.pump(6);
      await giveMissile(m, 'tank_a');
      await drain(m, P);
      await m.eval(`window.__vtHm.clear(); window.__vtHm.tag='F'; window.__vtHm.on = true;`);
      const nf = await fireOne(m, 'tank_a');
      await m.pump(3);
      const st0 = await missileTa(m);
      P('  [F] fired=' + nf + ' missile=' + JSON.stringify(st0));
      if (st0) {
        const mt = { x: Math.floor(st0.x / TILE), y: Math.floor(st0.y / TILE) };
        let idx = 0, best = 1e9;
        for (let i = 0; i < laneTiles.length; i++) { const d = Math.abs(laneTiles[i].x - mt.x) + Math.abs(laneTiles[i].y - mt.y); if (d < best) { best = d; idx = i; } }
        const dest = laneTiles[Math.min(idx + 2, laneTiles.length - 1)];
        const tx = dest.x * TILE + 5, ty = dest.y * TILE + 5;
        await m.teleport('tank_a', tx, ty, laneStartPose.rot);
        P('  [F] owner moved to lane tile ' + JSON.stringify(dest) + ' = (' + tx + ',' + ty + '); missile tile=' + JSON.stringify(mt));
        let dead = false, minDist = 1e9, passed = false;
        for (let i = 0; i < 60; i++) {
          await m.pump(1);
          const a = await m.eval(`!!GameManager.getGameController().getTank('tank_a')`);
          const sm = await missileTa(m);
          if (!a) { dead = true; P('  [F] OWNER DIED at rel frame ' + i + ' missile=' + JSON.stringify(sm)); break; }
          if (!sm) { P('  [F] missile gone at rel frame ' + i); break; }
          const d = Math.hypot(sm.x - tx, sm.y - ty);
          if (d < minDist) minDist = d;
          if (d < 0.5) passed = true;
          if (sm.ta > 2.3) { P('  [F] past activation, stop; missile=' + JSON.stringify(sm)); break; }
        }
        F.summary = { dead, passed, minDistToOwner: minDist, dest };
        P('  [F] dead=' + dead + ' minDistToOwner=' + Math.round(minDist * 1000) / 1000 + ' passedThrough=' + passed);
      }
      await m.eval('window.__vtHm.on = false');
      F.rows = (await dumpRows(m)).length;
      F.evs = await m.eval('window.__vtHm.evs.slice()');
      P('  [F] events: ' + JSON.stringify(F.evs));
    } catch (e) { F.err = String((e && e.stack) || e); P('  X F failed: ' + F.err); }

    P('\n=== vtStats ===\n  ' + JSON.stringify(await m.stats()));
    P('  pageErrors: ' + JSON.stringify(m.pageErrors.slice(0, 6)));
  } catch (e) {
    report.fatal = String((e && e.stack) || e);
    console.error('FATAL:', report.fatal);
    process.exitCode = 1;
  } finally {
    try { fs.writeFileSync(path.join(PROFDIR, 'probe_homing_facts.json'), JSON.stringify(report, null, 1)); } catch (e) {}
    try { await m.close(); } catch (e) {}
    console.log(`\n[done] 用时 ${((Date.now() - T0) / 1000).toFixed(1)}s`);
  }
})();
