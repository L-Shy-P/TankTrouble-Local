'use strict';
/* _i4_ 探针 v4：A 斜打反弹预测 / B 毒雾致死时序与序列可重复性 / D 补测（清干净旧弹）
 * 只读 game_core/，只写 _tools/headless/_i4_prof/
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Match } = require('./match');
const TILE = 10, DT = 1 / 60;
const PROF = path.join(__dirname, '_i4_prof');
const FILES = [
  'game_core/js/82e43ebfcdffdaf490dbe79c9c119d29.js',
  'game_core/js/7b2ed8ad3598d7321f8f3d2b04b1eac8.js',
  'game_core/js/46989e393ad0e356ac8a0c6c53b362f9.js',
  'game_core/js/418577fd210ad079ea3d1e5e04050fe0.js',
  'game_core/js/b714588dc4621fe104113111ba90b1a7.js',
  'game_core/js/54518faa8d672020d7af8ed7c353bc1b.js',
  'game_core/js/ce217c9b090cc73ce0e1faa13d20ca15.js',
  'game_core/js/local_patch.js',
  'game_core/js/vantage_sandbox.js',
  '_tools/headless/match.js',
];
function fp() {
  const out = [];
  for (const rel of FILES) { const p = path.join(__dirname, '..', '..', rel);
    try { const st = fs.statSync(p); out.push({ file: rel, mtime: st.mtime.toISOString(), bytes: st.size,
      md5: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') }); }
    catch (e) { out.push({ file: rel, err: String(e.message || e) }); } }
  return out;
}
const T0 = Date.now();
const report = { startedAt: new Date().toISOString(), fingerprints: fp() };
const P = (...a) => console.log(...a);

const H = `
window.__i4 = {
  gc: function () { return GameManager.getGameController(); },
  rc: function () { return GameManager.getGameController().roundController; },
  sub: function (x, n) { var p = Math.pow(10, n === undefined ? 3 : n); return (x === null || x === undefined) ? null : Math.round(x * p) / p; },
  tank: function (id) { var t = this.gc().getTank(id); return t ? { id: id, x: this.sub(t.getX()), y: this.sub(t.getY()), rot: this.sub(t.getRotation(), 4) } : null; },
  fixtures: function (id) {
    var t = this.gc().getTank(id); if (!t) return null; var b = t.getB2DBody(); if (!b) return null;
    var out = [];
    for (var f = b.GetFixtureList(); f !== null; f = f.GetNext()) {
      var ud = f.GetUserData() || {}; var fd = f.GetFilterData(); var sh = f.GetShape();
      var o = { ut: (ud.type === undefined ? null : ud.type), cat: fd.categoryBits, mask: fd.maskBits, st: sh.m_type,
                r: sh.m_radius !== undefined ? this.sub(sh.m_radius, 4) : null,
                center: (sh.m_p !== undefined) ? [this.sub(sh.m_p.x, 4), this.sub(sh.m_p.y, 4)] : null, v: null };
      if (sh.m_vertexCount !== undefined) { o.n = sh.m_vertexCount; o.v = [];
        for (var i = 0; i < sh.m_vertexCount; i++) { var w = b.GetWorldPoint(sh.m_vertices[i]); o.v.push([this.sub(w.x), this.sub(w.y)]); } }
      out.push(o);
    }
    return out;
  },
  upgrades: function (id) {
    var d = __vtData(this.gc().getRoundState()) || {}; var us = d.upgradeStates || []; var out = [];
    for (var i = 0; i < us.length; i++) if (us[i].playerId === id) { var f = {}; try { f = JSON.parse(us[i].fieldsJSON || '{}'); } catch (e) {}
      out.push({ id: us[i].id, type: us[i].type, life: this.sub(f._lifetime, 3) }); }
    return out;
  },
  bullets: function (owner) {
    var d = __vtData(this.gc().getRoundState()) || {}; var gc = this.gc(); var self = this;
    return (d.projectileStates || []).filter(function (p) { return !owner || p.playerId === owner; }).map(function (p) {
      var live = null; try { var o = gc.getProjectile(p.id); if (o) live = { deadly: o.isDeadlyToOwner(), stopped: !!o.stopped }; } catch (e) {}
      return { id: p.id, o: p.playerId, t: p.type, x: self.sub(p.x), y: self.sub(p.y),
               vx: self.sub(p.speedX), vy: self.sub(p.speedY), sp: self.sub(Math.sqrt(p.speedX * p.speedX + p.speedY * p.speedY)), live: live };
    });
  },
  clearBullets: function () { var gc = this.gc(); var b = this.bullets(); var n = 0;
    for (var i = 0; i < b.length; i++) { try { gc.destroyProjectile(b[i].id); n++; } catch (e) {} } return n; },
  collectibles: function () { var d = __vtData(this.gc().getRoundState()) || {};
    return (d.collectibleStates || []).map(function (c) { return { id: c.id, type: c.type, x: c.x, y: c.y }; }); },
  spawnCrate: function (type, x, y, rot) { var st = CollectibleState.withState(IdGenerator.instance.gen('c'), type, x, y, rot || 0); this.rc().setCollectibleState(st); return st.getId(); },
  zones: function () {
    var gc = this.gc(); var zs = gc.getZones(); var out = [];
    for (var k in zs) { if (!zs.hasOwnProperty(k)) continue; var z = zs[k];
      var c = null; try { c = z.getCorners(); } catch (e) {}
      var o = { id: k, type: z.getType(), corners: c, side: z._expansionSide, t: this.sub(z._expansionTime, 4),
                r: z._expansionTilesRight, b: z._expansionTilesBottom, l: z._expansionTilesLeft, tp: z._expansionTilesTop,
                tilesN: null, tiles: null, aabb: [], seqLen: null, seq: null };
      try { var tl = z.getTiles() || []; o.tilesN = tl.length; o.tiles = tl.slice(0, 10).map(function (p) { return p.x + ',' + p.y; }); } catch (e) {}
      try { var flds = JSON.parse(z.getUpgradeState ? '{}' : (z.getFields ? JSON.stringify(z.getFields()) : '{}')); } catch (e) {}
      try { var s = z._expansionSequence; o.seqLen = s ? s.length : null; o.seq = s ? s.join(',') : null; } catch (e) {}
      var body = z.getB2DBody();
      if (body) for (var f = body.GetFixtureList(); f !== null; f = f.GetNext()) {
        var sh = f.GetShape(); var mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
        for (var i = 0; i < sh.m_vertexCount; i++) { var v = sh.m_vertices[i];
          if (v.x < mnx) mnx = v.x; if (v.x > mxx) mxx = v.x; if (v.y < mny) mny = v.y; if (v.y > mxy) mxy = v.y; }
        o.aabb.push([this.sub(mnx), this.sub(mny), this.sub(mxx), this.sub(mxy)]);
      }
      out.push(o);
    }
    return out;
  },
  tileInfo: function () {
    var gc = this.gc(); var mz = gc.getMaze(); var tb = mz.getTileBounds(); var tiles = mz.getTiles();
    var out = { tileBounds: tb, TILE: Constants.MAZE_TILE_SIZE.m, WALL: Constants.MAZE_WALL_WIDTH.m,
                appearAt: Constants.CLASSIC_STORM_APPEAR_DURATION, cells: [] };
    for (var i = 0; i < tiles.length; i++) for (var j = 0; j < tiles[i].length; j++)
      if (tiles[i][j][0] === 1) out.cells.push({ x: i, y: j, top: tiles[i][j][1], left: tiles[i][j][2] });
    return out;
  },
  seqRepeatTest: function () { var mz = this.gc().getMaze();
    var a = mz.getStormExpansionSequence(), b = mz.getStormExpansionSequence();
    return { a: a.join(','), b: b.join(','), same: a.join(',') === b.join(',') }; },
  injectStorm: function () {
    var gc = this.gc(); var mz = gc.getMaze(); var tb = mz.getTileBounds(); var seq = mz.getStormExpansionSequence();
    var fields = JSON.stringify({ _expansionTime: 0, _expansionSequence: seq, _tileBounds: tb,
      _expansionSide: 0, _expansionTilesRight: 0, _expansionTilesBottom: 0, _expansionTilesLeft: 0, _expansionTilesTop: 0 });
    var zs = ZoneState.withState(IdGenerator.instance.gen('sz'), Constants.ZONE_TYPES.STORM, [], fields);
    gc.roundController.setZoneState(zs);
    return { id: zs.getId(), seq: seq, tileBounds: tb };
  },
  setStormFlag: function (on) { var gc = this.gc(); gc.setStorm(!!on); gc.getGameMode().setStorm(!!on); return { gmStorm: !!gc.getGameMode().storm }; },
  modeInfo: function () { var gc = this.gc(); var gm = gc.getGameMode();
    return { mode: gm.mode, storm: !!gm.storm, roundDuration: this.sub(gm.roundDuration, 3),
             gmRoundControllerNull: (gm.roundController === null || gm.roundController === undefined), state: gc.getState() }; }
};
`;
function findLane(ti, minLen) {
  const rows = {}, cols = {};
  for (const c of ti.cells) { (rows[c.y] = rows[c.y] || []).push(c); (cols[c.x] = cols[c.x] || []).push(c); }
  function scan(map, horiz) {
    let best = null;
    for (const k of Object.keys(map)) {
      const line = map[k].slice().sort((a, b) => (horiz ? a.x - b.x : a.y - b.y));
      let run = [line[0]];
      for (let i = 1; i < line.length; i++) { const p = line[i - 1], c = line[i];
        const adj = horiz ? (c.x === p.x + 1 && c.left === 0) : (c.y === p.y + 1 && c.top === 0);
        if (adj) run.push(c); else { if (!best || run.length > best.length) best = run; run = [c]; } }
      if (!best || run.length > best.length) best = run;
    }
    return best;
  }
  const h = scan(rows, true), v = scan(cols, false);
  if (h && h.length >= minLen) return { axis: 'x', cells: h.slice(0, minLen) };
  if (v && v.length >= minLen) return { axis: 'y', cells: v.slice(0, minLen) };
  if (h && h.length >= 3) return { axis: 'x', cells: h.slice(0, 3) };
  if (v && v.length >= 3) return { axis: 'y', cells: v.slice(0, 3) };
  return null;
}
/* 沿 lane 正方向：idx 小的在前，朝向 +x 或 +y */
function poseAt(lane, idx, lateral) {
  const c = lane.cells[idx]; const lat = lateral || 0;
  if (lane.axis === 'x') return { x: c.x * TILE + TILE / 2, y: c.y * TILE + TILE / 2 + lat, rot: Math.PI / 2 };  // rot=π/2 → +x
  return { x: c.x * TILE + TILE / 2 + lat, y: c.y * TILE + TILE / 2, rot: Math.PI };                            // rot=π → +y
}
async function openMatch(o) { const m = new Match(); const t = Date.now(); await m.open(o); m._openMs = Date.now() - t;
  await m.clearControl(); await m.eval(H); return m; }

(async () => {
  try {
    fs.mkdirSync(PROF, { recursive: true });
    /* ---------- A′ 斜打反弹 + 护盾圆心 / 序列可重复性 ---------- */
    const m = await openMatch({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
    const A = report.A2 = { openMs: m._openMs };
    try {
      const ti = await m.eval('window.__i4.tileInfo()');
      A.maze = { bounds: ti.tileBounds, WALL: ti.WALL, TILE: ti.TILE };
      A.seqRepeat = await m.eval('window.__i4.seqRepeatTest()');
      P('A0 seq 两次调用相同? ' + A.seqRepeat.same + '\n   a=' + A.seqRepeat.a.slice(0, 60) + '\n   b=' + A.seqRepeat.b.slice(0, 60));
      const lane = findLane(ti, 5);
      A.lane = { axis: lane.axis, cells: lane.cells.map((c) => c.x + ',' + c.y) };
      const shooter = poseAt(lane, 0, 0);
      const target = poseAt(lane, 3, 0);
      A.pose = { shooter: shooter, target: target };
      // 目标拿护盾
      await m.teleport('tank_b', target.x, target.y, target.rot); await m.pump(3);
      await m.eval(`window.__i4.spawnCrate(6, ${target.x}, ${target.y}, 0)`);
      for (let i = 0; i < 10; i++) { await m.pump(1); if ((await m.eval("window.__i4.upgrades('tank_b')")).length) break; }
      const fxs = await m.eval("window.__i4.fixtures('tank_b')");
      A.shield = fxs.find((f) => f.cat === 32);
      P('A1 shield fixture=' + JSON.stringify(A.shield));
      // 目标横移 2.5（在格子内）
      const lat = 2.5;
      const t2 = { x: target.x + (lane.axis === 'y' ? lat : 0), y: target.y + (lane.axis === 'x' ? lat : 0), rot: target.rot };
      await m.teleport('tank_b', t2.x, t2.y, t2.rot); await m.pump(3);
      A.obliqueGeom = { center: [t2.x, t2.y], shooterLine: lane.axis === 'x' ? ('y=' + shooter.y) : ('x=' + shooter.x), shieldR: A.shield.r, bulletR: 0.25, lateral: lat };
      await m.eval('window.__i4.clearBullets()');
      await m.teleport('tank_c', shooter.x - 30, shooter.y + 30, 0).catch(() => {});
      await m.teleport('tank_a', shooter.x, shooter.y, shooter.rot); await m.pump(3);
      await m.setControl({ fire: true }); await m.pump(1); await m.setControl({ fire: false });
      const rows = []; let seen = false;
      for (let i = 0; i <= 220; i++) {
        const b = await m.eval("window.__i4.bullets('tank_a')");
        const ta = await m.eval("window.__i4.tank('tank_a')");
        const tb = await m.eval("window.__i4.tank('tank_b')");
        rows.push({ f: i, b: b[0] ? [b[0].x, b[0].y, b[0].vx, b[0].vy, b[0].sp, b[0].live.deadly] : null, aAlive: !!ta, bAlive: !!tb });
        if (b.length) seen = true; else if (seen) break;
        await m.pump(1);
      }
      A.trace = rows;
      const pts = rows.filter((r) => r.b);
      let flip = -1;
      for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].b[3] - pts[i - 1].b[3]) > 1e-6 || Math.abs(pts[i].b[2] - pts[i - 1].b[2]) > 1e-6) { flip = i; break; }
      A.flipIdx = flip;
      A.inV = flip > 0 ? pts[flip - 1].b.slice(2, 5) : null;
      A.outV = flip > 0 ? pts[flip].b.slice(2, 5) : null;
      A.posAtFlip = flip > 0 ? pts[flip].b.slice(0, 2) : null;
      if (flip > 0) {
        const C = [t2.x, t2.y], p = A.posAtFlip, d = [p[0] - C[0], p[1] - C[1]], L = Math.hypot(d[0], d[1]);
        const n = [d[0] / L, d[1] / L], vin = A.inV.slice(0, 2), dot = vin[0] * n[0] + vin[1] * n[1];
        A.normal = [+n[0].toFixed(3), +n[1].toFixed(3)]; A.distAtFlip = +L.toFixed(3);
        A.predicted = [+(vin[0] - 2 * dot * n[0]).toFixed(3), +(vin[1] - 2 * dot * n[1]).toFixed(3)];
        A.predErr = +Math.hypot(A.predicted[0] - A.outV[0], A.predicted[1] - A.outV[1]).toFixed(3);
      }
      A.shooterAliveEnd = rows[rows.length - 1].aAlive;
      A.targetAliveEnd = rows[rows.length - 1].bAlive;
      A.minDistToShieldCenter = pts.length ? +Math.min(...pts.map((r) => Math.hypot(r.b[0] - t2.x, r.b[1] - t2.y))).toFixed(3) : null;
      P('A2 oblique flip@' + flip + ' in=' + JSON.stringify(A.inV) + ' out=' + JSON.stringify(A.outV) +
        ' predicted=' + JSON.stringify(A.predicted) + ' err=' + A.predErr + ' |p-C|=' + A.distAtFlip +
        ' minDist=' + A.minDistToShieldCenter);
      P('A2 frames=' + rows.length + ' shooterAliveEnd=' + A.shooterAliveEnd + ' targetAliveEnd=' + A.targetAliveEnd);
      P('A2 逐帧: ' + JSON.stringify(rows.filter((r) => r.b).map((r) => 'f' + r.f + '(' + r.b[0] + ',' + r.b[1] + ' v' + r.b[2] + ',' + r.b[3] + ')').slice(Math.max(0, flip - 3), flip + 4)));
    } catch (e) { A.err = String((e && e.stack) || e); P('X A2: ' + A.err); }
    try { await m.close(); } catch (e) {}

    /* ---------- B′ 毒雾：注入 → 按【注入的序列】选受害者 → 致死时序 ---------- */
    const m2 = await openMatch({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
    const B = report.B2 = { openMs: m2._openMs };
    try {
      const ti = await m2.eval('window.__i4.tileInfo()');
      B.tileBounds = ti.tileBounds; B.WALL = ti.WALL; B.TILE = ti.TILE; B.appearAt = ti.appearAt;
      B.modeInfo = await m2.eval('window.__i4.modeInfo()');
      B.stormFlag = await m2.eval('window.__i4.setStormFlag(true)');
      await m2.pump(120);
      B.zonesAfter120FramesInBootCamp = (await m2.eval('window.__i4.zones()')).length;
      const inj = await m2.eval('window.__i4.injectStorm()');
      B.injected = inj;
      const first = inj.seq[0];
      B.firstSide = first;
      const tb = inj.tileBounds;
      const mid = (a, b) => Math.round((a + b) / 2);
      let want = null;
      if (first === 0) want = { x: tb.maxX, y: mid(tb.minY, tb.maxY) };
      else if (first === 2) want = { x: tb.minX, y: mid(tb.minY, tb.maxY) };
      else if (first === 1) want = { x: mid(tb.minX, tb.maxX), y: tb.maxY };
      else want = { x: mid(tb.minX, tb.maxX), y: tb.minY };
      const cellOK = ti.cells.some((c) => c.x === want.x && c.y === want.y);
      if (!cellOK) {
        const cands = ti.cells.filter((c) => first === 0 ? c.x === tb.maxX : first === 2 ? c.x === tb.minX : first === 1 ? c.y === tb.maxY : c.y === tb.minY);
        if (cands.length) want = { x: cands[0].x, y: cands[0].y };
      }
      B.victimCell = want; B.victimCellWasPresent = cellOK;
      const vx = want.x * TILE + TILE / 2, vy = want.y * TILE + TILE / 2;
      await m2.teleport('tank_b', vx, vy, 0);
      await m2.pump(2);
      B.victimPlaced = await m2.eval("window.__i4.tank('tank_b')");
      B.victimBox = (await m2.eval("window.__i4.fixtures('tank_b')")).find((f) => f.ut === 'base').v;
      P('B0 firstSide=' + first + ' victimCell=' + JSON.stringify(want) + ' pos=' + JSON.stringify(B.victimPlaced) + ' box=' + JSON.stringify(B.victimBox));

      const rows = []; let deathFrame = -1; let firstMove = -1; let prevSR = null, prevEL = null, prevSB = null, prevET = null;
      for (let i = 0; i < 900; i++) {
        const zs = await m2.eval('window.__i4.zones()');
        const t = await m2.eval("window.__i4.tank('tank_b')");
        const z = zs[0] || null;
        rows.push({ f: i, z: z, aliveX: t ? t.x : null });
        if (z) {
          const c = z.corners;
          if (firstMove < 0 && prevSR !== null && (c.stormStartRight !== prevSR || c.stormEndLeft !== prevEL || c.stormStartBottom !== prevSB || c.stormEndTop !== prevET)) firstMove = i;
          prevSR = c.stormStartRight; prevEL = c.stormEndLeft; prevSB = c.stormStartBottom; prevET = c.stormEndTop;
        }
        if (!t) { deathFrame = i; break; }
        await m2.pump(1);
      }
      B.rows = rows; B.deathFrame = deathFrame; B.firstMoveFrame = firstMove;
      B.deathRow = deathFrame >= 0 ? rows[deathFrame] : null;
      B.prevRow = deathFrame > 0 ? rows[deathFrame - 1] : null;
      B.zone0 = rows[0] && rows[0].z;
      B.zoneAtDeath = B.deathRow && B.deathRow.z;
      if (B.zone0) P('B1 注入后立即: corners=' + JSON.stringify(B.zone0.corners) + ' AABB=' + JSON.stringify(B.zone0.aabb) + ' tilesN=' + B.zone0.tilesN + ' tiles=' + JSON.stringify(B.zone0.tiles));
      if (B.deathRow && B.deathRow.z) P('B2 死亡帧 f=' + deathFrame + ' sR=' + B.deathRow.z.corners.stormStartRight + ' eL=' + B.deathRow.z.corners.stormEndLeft + ' tilesN=' + B.deathRow.z.tilesN);
      if (B.prevRow && B.prevRow.z) P('B2 死前帧 f=' + B.prevRow.f + ' sR=' + B.prevRow.z.corners.stormStartRight + ' eL=' + B.prevRow.z.corners.stormEndLeft + ' tilesN=' + B.prevRow.z.tilesN);
      const step = Math.max(1, Math.floor(rows.length / 16));
      for (let i = 0; i < rows.length; i += step) { const r = rows[i]; if (!r.z) continue;
        P('   f' + r.f + ' t=' + r.z.t + ' side=' + r.z.side + ' RBLT=' + r.z.r + r.z.b + r.z.l + r.z.tp +
          ' sR=' + r.z.corners.stormStartRight + ' eL=' + r.z.corners.stormEndLeft + ' aabbTop=' + JSON.stringify(r.z.aabb[0]) +
          ' tilesN=' + r.z.tilesN + ' tankX=' + r.aliveX); }
      P('B3 deathFrame=' + deathFrame + ' = ' + (deathFrame * DT).toFixed(2) + 's 后；首次边界移动帧=' + firstMove + ' = ' + (firstMove * DT).toFixed(2) + 's');
      P('B3 注入序列=' + inj.seq.join(',') + ' (len ' + inj.seq.length + ')');
    } catch (e) { B.err = String((e && e.stack) || e); P('X B2: ' + B.err); }
    try { await m2.close(); } catch (e) {}
  } catch (e) { report.fatal = String((e && e.stack) || e); console.error('FATAL:', report.fatal); process.exitCode = 1; }
  finally {
    try { fs.writeFileSync(path.join(PROF, '_i4_probe_spec_1_4d.json'), JSON.stringify(report, null, 1)); } catch (e) {}
    P('\n[done] ' + ((Date.now() - T0) / 1000).toFixed(1) + 's');
  }
})();
