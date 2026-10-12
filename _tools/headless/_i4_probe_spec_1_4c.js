'use strict';
/* ============================================================================
 * _i4_ 探针 v3：阶段 1-4（护盾 / 毒雾 / 道具+形状改变）规格核查的【真游戏实测】
 *   A) 护盾：真 crate 拾取 → 夹具；真开火（正打/斜打）→ 反弹 vs 镜面反射预测；到期；真 Shrapnel ×3
 *   B) 毒雾：boot camp 里 storm=true 到底出不出风暴（实测）→ 注入游戏自己的 ZoneState →
 *            四夹具 AABB / 安全区矩形 / 逐帧边界 / 致死帧 vs 预测 / tiles 领先关系
 *   C) 道具：真 crate 拾取（炮管夹具切换）/ 队列上限
 *   D) 炮管夹具参与判死（反例先跑：炮管背对；正例后跑：炮管朝向）
 * 只读 game_core/，只写 _tools/headless/_i4_prof/。
 * ============================================================================ */
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
  'game_core/js/vantage_tree.js',
  'game_core/js/wasm/vantage_core.wasm',
  '_tools/headless/match.js',
];
function fingerprints() {
  const out = [];
  for (const rel of FILES) {
    const p = path.join(__dirname, '..', '..', rel);
    try { const st = fs.statSync(p);
      out.push({ file: rel, mtime: st.mtime.toISOString(), bytes: st.size,
        md5: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') });
    } catch (e) { out.push({ file: rel, err: String(e.message || e) }); }
  }
  return out;
}
const T0 = Date.now();
const report = { startedAt: new Date().toISOString(), fingerprints: fingerprints() };
const P = (...a) => console.log(...a);

const HELPERS = `
window.__i4 = {
  gc: function () { return GameManager.getGameController(); },
  rc: function () { return GameManager.getGameController().roundController; },
  sub: function (x, n) { var p = Math.pow(10, n === undefined ? 3 : n); return (x === null || x === undefined) ? null : Math.round(x * p) / p; },
  types: function () {
    var names = ['Constants','B2DUtils','IdGenerator','TankState','ProjectileState','ZoneState','CollectibleState',
                 'TrapState','UpgradeState','Mine','Shrapnel','StormZone','ShieldUpgrade','Collectible','Pickup',
                 'BootCampGameMode','ClassicGameMode','DeathmatchGameMode','GameMode'];
    var o = {};
    for (var i = 0; i < names.length; i++) { var v = 'ERR'; try { v = eval('typeof ' + names[i]); } catch (e) {} o[names[i]] = v; }
    return o;
  },
  cats: function () { return Constants.COLLISION_CATEGORIES; },
  modeInfo: function () {
    var gc = this.gc(); var gm = gc.getGameMode();
    return { gmRoundControllerNull: (gm.roundController === null || gm.roundController === undefined),
             mode: gm.mode, storm: !!gm.storm, stormSpawned: !!gm.stormSpawned,
             roundDuration: this.sub(gm.roundDuration, 3), className: gm.classs && gm.classs() ? String(gm.classs()) : null,
             gcStorm: gc.getStorm(), state: gc.getState() };
  },
  tank: function (id) { var t = this.gc().getTank(id); return t ? { id: id, x: this.sub(t.getX()), y: this.sub(t.getY()), rot: this.sub(t.getRotation(), 4) } : null; },
  fixtures: function (id) {
    var t = this.gc().getTank(id); if (!t) return null;
    var b = t.getB2DBody(); if (!b) return null;
    var out = [];
    for (var f = b.GetFixtureList(); f !== null; f = f.GetNext()) {
      var ud = f.GetUserData() || {}; var fd = f.GetFilterData(); var sh = f.GetShape();
      var o = { ut: (ud.type === undefined ? null : ud.type), cat: fd.categoryBits, mask: fd.maskBits, st: sh.m_type, r: null, n: null, v: null };
      if (sh.m_radius !== undefined) o.r = this.sub(sh.m_radius, 4);
      if (sh.m_vertexCount !== undefined) { o.n = sh.m_vertexCount; o.v = [];
        for (var i = 0; i < sh.m_vertexCount; i++) { var w = b.GetWorldPoint(sh.m_vertices[i]); o.v.push([this.sub(w.x), this.sub(w.y)]); } }
      out.push(o);
    }
    return out;
  },
  upgrades: function (id) {
    var d = __vtData(this.gc().getRoundState()) || {}; var us = d.upgradeStates || []; var out = [];
    for (var i = 0; i < us.length; i++) if (us[i].playerId === id) {
      var f = {}; try { f = JSON.parse(us[i].fieldsJSON || '{}'); } catch (e) {}
      out.push({ id: us[i].id, type: us[i].type, life: this.sub(f._lifetime, 3) });
    }
    return out;
  },
  collectibles: function () {
    var d = __vtData(this.gc().getRoundState()) || {};
    return (d.collectibleStates || []).map(function (c) { return { id: c.id, type: c.type, x: this.sub(c.x), y: this.sub(c.y) }; }, this);
  },
  weapons: function () {
    var d = __vtData(this.gc().getRoundState()) || {};
    return (d.weaponStates || []).map(function (w) { var f = {}; try { f = JSON.parse(w.fieldsJSON || '{}'); } catch (e) {}
      return { id: w.id, owner: w.playerId, type: w.type, num: f._numBullets, mines: f._numMines, launched: f._launched }; });
  },
  bullets: function () {
    var d = __vtData(this.gc().getRoundState()) || {}; var gc = this.gc();
    return (d.projectileStates || []).map(function (p) {
      var live = null;
      try { var o = gc.getProjectile(p.id); if (o) live = { deadly: o.isDeadlyToOwner(), stopped: !!o.stopped }; } catch (e) {}
      return { id: p.id, o: p.playerId, t: p.type, x: this.sub(p.x), y: this.sub(p.y), vx: this.sub(p.vx),
               vy: this.sub(p.speedY), sp: this.sub(Math.sqrt(p.speedX * p.speedX + p.speedY * p.speedY)), live: live };
    }, this);
  },
  zones: function () {
    var gc = this.gc(); var zs = gc.getZones(); var out = [];
    for (var k in zs) { if (!zs.hasOwnProperty(k)) continue;
      var z = zs[k]; var c = null; try { c = z.getCorners(); } catch (e) {}
      var o = { id: k, type: z.getType(), corners: c, side: z._expansionSide, t: this.sub(z._expansionTime, 4),
                r: z._expansionTilesRight, b: z._expansionTilesBottom, l: z._expansionTilesLeft, tp: z._expansionTilesTop,
                tilesN: null, tiles: null, isPhysical: null, aabb: [] };
      try { o.isPhysical = z.isPhysical(); } catch (e) {}
      try { var tl = z.getTiles() || []; o.tilesN = tl.length; o.tiles = tl.slice(0, 8).map(function (p) { return p.x + ',' + p.y; }); } catch (e) {}
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
    var out = { tileBounds: tb, width: mz.getWidth(), height: mz.getHeight(), seq: mz.getStormExpansionSequence(),
                TILE: Constants.MAZE_TILE_SIZE.m, WALL: Constants.MAZE_WALL_WIDTH.m,
                stormAppearAt: Constants.CLASSIC_STORM_APPEAR_DURATION, cells: [] };
    for (var i = 0; i < tiles.length; i++) for (var j = 0; j < tiles[i].length; j++)
      if (tiles[i][j][0] === 1) out.cells.push({ x: i, y: j, top: tiles[i][j][1], left: tiles[i][j][2] });
    return out;
  },
  spawnCrate: function (type, x, y, rot) { var st = CollectibleState.withState(IdGenerator.instance.gen('c'), type, x, y, rot || 0); this.rc().setCollectibleState(st); return st.getId(); },
  spawnShrapnel: function (id, owner, x, y, vx, vy) { this.rc().setProjectileState(ProjectileState.withState(id, owner, Constants.WEAPON_TYPES.MINE, x, y, vx, vy)); return id; },
  setStormFlag: function (on) { var gc = this.gc(); gc.setStorm(!!on); gc.getGameMode().setStorm(!!on); return { gcStorm: gc.getStorm(), gmStorm: !!gc.getGameMode().storm }; },
  injectStorm: function () {
    var gc = this.gc(); var mz = gc.getMaze();
    var tb = mz.getTileBounds(); var seq = mz.getStormExpansionSequence();
    var fields = JSON.stringify({ _expansionTime: 0, _expansionSequence: seq, _tileBounds: tb,
      _expansionSide: 0, _expansionTilesRight: 0, _expansionTilesBottom: 0, _expansionTilesLeft: 0, _expansionTilesTop: 0 });
    var zs = ZoneState.withState(IdGenerator.instance.gen('sz'), Constants.ZONE_TYPES.STORM, [], fields);
    gc.roundController.setZoneState(zs);
    return { id: zs.getId(), seq: seq, tileBounds: tb };
  },
  tankBox: function (id) {
    var fxs = this.fixtures(id); if (!fxs) return null;
    for (var i = 0; i < fxs.length; i++) if (fxs[i].ut === 'base') {
      var v = fxs[i].v, mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
      for (var k = 0; k < v.length; k++) { if (v[k][0] < mnx) mnx = v[k][0]; if (v[k][0] > mxx) mxx = v[k][0];
        if (v[k][1] < mny) mny = v[k][1]; if (v[k][1] > mxy) mxy = v[k][1]; }
      return [mnx, mny, mxx, mxy];
    }
    return null;
  }
};
`;

/* 找直线走廊：水平或垂直，返回 {axis, cells} */
function findLane(ti, minLen) {
  const rows = {}, cols = {};
  for (const c of ti.cells) { (rows[c.y] = rows[c.y] || []).push(c); (cols[c.x] = cols[c.x] || []).push(c); }
  function scan(map, horiz) {
    let best = null;
    for (const k of Object.keys(map)) {
      const line = map[k].slice().sort((a, b) => (horiz ? a.x - b.x : a.y - b.y));
      let run = [line[0]];
      for (let i = 1; i < line.length; i++) {
        const p = line[i - 1], c = line[i];
        const adj = horiz ? (c.x === p.x + 1 && c.left === 0) : (c.y === p.y + 1 && c.top === 0);
        if (adj) run.push(c); else { if (!best || run.length > best.length) best = run; run = [c]; }
      }
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
function lanePose(lane, idx, lateral) {
  const c = lane.cells[idx];
  const lat = lateral || 0;
  if (lane.axis === 'x') return { x: c.x * TILE + TILE / 2, y: c.y * TILE + TILE / 2 + lat, rot: Math.PI / 2 };
  return { x: c.x * TILE + TILE / 2 + lat, y: c.y * TILE + TILE / 2, rot: 0 };
}
async function openMatch(o) {
  const m = new Match(); const t0 = Date.now();
  await m.open(o); m._openMs = Date.now() - t0;
  await m.clearControl(); await m.eval(HELPERS);
  return m;
}

/* =============================== A 护盾 =============================== */
async function partA(A) {
  const m = await openMatch({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
  try {
    A.openMs = m._openMs;
    A.types = await m.eval('window.__i4.types()');
    A.cats = await m.eval('window.__i4.cats()');
    A.modeInfo = await m.eval('window.__i4.modeInfo()');
    const ti = await m.eval('window.__i4.tileInfo()');
    A.maze = { bounds: ti.tileBounds, w: ti.width, h: ti.height, seqLen: ti.seq.length, WALL: ti.WALL, TILE: ti.TILE };
    const lane = findLane(ti, 5);
    if (!lane) throw new Error('no lane');
    A.lane = { axis: lane.axis, cells: lane.cells.map((c) => c.x + ',' + c.y) };
    const far = lanePose(lane, lane.cells.length - 1), near = lanePose(lane, lane.cells.length - 2);
    A.pose = { shooter: far, target: near };
    await m.teleport('tank_c', lanePose(lane, 0).x, lanePose(lane, 0).y + (lane.axis === 'x' ? 20 : 0), 0).catch(() => {});
    await m.teleport('tank_b', near.x, near.y, near.rot);
    await m.pump(3);
    A.before = { fx: await m.eval("window.__i4.fixtures('tank_b')"), up: await m.eval("window.__i4.upgrades('tank_b')") };
    A.crateId = await m.eval(`window.__i4.spawnCrate(6, ${near.x}, ${near.y}, 0)`);
    for (let i = 0; i < 10; i++) { await m.pump(1); if ((await m.eval("window.__i4.upgrades('tank_b')")).length) break; }
    A.after = { fx: await m.eval("window.__i4.fixtures('tank_b')"), up: await m.eval("window.__i4.upgrades('tank_b')"),
                left: await m.eval('window.__i4.collectibles()') };
    P('A1 upgrade=' + JSON.stringify(A.after.up)); P('A1 fixtures=' + JSON.stringify(A.after.fx));
    const shield = (A.after.fx || []).find((f) => f.cat === 32);
    A.shieldFixture = shield;
    if (!shield) throw new Error('no shield fixture');

    async function shoot(frames) {
      await m.setControl({ fire: true }); await m.pump(1); await m.setControl({ fire: false });
      const rows = []; let seen = false;
      for (let i = 0; i <= frames; i++) {
        const b = await m.eval('window.__i4.bullets()');
        const t = await m.eval("window.__i4.tank('tank_b')");
        rows.push({ f: i, b: b, alive: !!t });
        if (b.length) seen = true; else if (seen) break;
        await m.pump(1);
      }
      return rows.filter((r) => r.b.length).map((r) => r.b[0]);
    }
    await m.teleport('tank_a', far.x, far.y, far.rot);
    await m.pump(3);
    // 正打
    let hb = await shoot(200);
    let flip = -1;
    for (let i = 1; i < hb.length; i++) {
      const dv = Math.hypot(hb[i].vx - hb[i - 1].vx, hb[i].vy - hb[i - 1].vy);
      if (dv > 1e-6) { flip = i; break; }
    }
    A.headOn = { n: hb.length, flipIdx: flip,
      inV: flip > 0 ? [hb[flip - 1].vx, hb[flip - 1].vy, hb[flip - 1].sp] : null,
      outV: flip > 0 ? [hb[flip].vx, hb[flip].vy, hb[flip].sp] : null,
      posAtFlip: flip > 0 ? [hb[flip].x, hb[flip].y] : null,
      deadlyBefore: flip > 0 ? hb[flip - 1].live.deadly : null, deadlyAfter: flip > 0 ? hb[flip].live.deadly : null,
      minDistToShieldCenter: hb.length ? +Math.min(...hb.map((p) => Math.hypot(p.x - near.x, p.y - near.y))).toFixed(3) : null,
      targetAliveEnd: !!(await m.eval("window.__i4.tank('tank_b')")) };
    P('A2 headOn flip@' + flip + ' in=' + JSON.stringify(A.headOn.inV) + ' out=' + JSON.stringify(A.headOn.outV) +
      ' at=' + JSON.stringify(A.headOn.posAtFlip) + ' deadly ' + A.headOn.deadlyBefore + '->' + A.headOn.deadlyAfter +
      ' minDist=' + A.headOn.minDistToShieldCenter + ' alive=' + A.headOn.targetAliveEnd);

    // 斜打：目标横移 2.5m
    const lat = lane.axis === 'x' ? 2.5 : 2.5;
    const near2 = { x: near.x, y: near.y + lat, rot: near.rot };
    await m.teleport('tank_b', near2.x, near2.y, near2.rot);
    await m.pump(3);
    A.obliqueGeom = { center: [near2.x, near2.y], shotLine: lane.axis === 'x' ? ['y=', far.y] : ['x=', far.x], shieldR: shield.r, bulletR: 0.25 };
    let ob = await shoot(200);
    let oflip = -1;
    for (let i = 1; i < ob.length; i++) if (Math.abs(ob[i].vy - ob[i - 1].vy) > 1e-6 || Math.abs(ob[i].vx - ob[i - 1].vx) > 1e-6) { oflip = i; break; }
    A.oblique = { n: ob.length, flipIdx: oflip,
      inV: oflip > 0 ? [ob[oflip - 1].vx, ob[oflip - 1].vy, ob[oflip - 1].sp] : null,
      outV: oflip > 0 ? [ob[oflip].vx, ob[oflip].vy, ob[oflip].sp] : null,
      posAtFlip: oflip > 0 ? [ob[oflip].x, ob[oflip].y] : null,
      targetAliveEnd: !!(await m.eval("window.__i4.tank('tank_b')")) };
    if (oflip > 0) {
      const C = [near2.x, near2.y], p = [ob[oflip].x, ob[oflip].y];
      const d = [p[0] - C[0], p[1] - C[1]]; const L = Math.hypot(d[0], d[1]);
      const n = [d[0] / L, d[1] / L];
      const vin = [ob[oflip - 1].vx, ob[oflip - 1].vy]; const dot = vin[0] * n[0] + vin[1] * n[1];
      A.oblique.predicted = [+(vin[0] - 2 * dot * n[0]).toFixed(3), +(vin[1] - 2 * dot * n[1]).toFixed(3)];
      A.oblique.normal = [+n[0].toFixed(3), +n[1].toFixed(3)]; A.oblique.distAtFlip = +L.toFixed(3);
    }
    P('A3 oblique flip@' + oflip + ' in=' + JSON.stringify(A.oblique.inV) + ' out=' + JSON.stringify(A.oblique.outV) +
      ' predicted=' + JSON.stringify(A.oblique.predicted) + ' |p-C|=' + A.oblique.distAtFlip + ' alive=' + A.oblique.targetAliveEnd);

    // 到期
    await m.teleport('tank_b', near.x, near.y, near.rot);
    A.expiredAtFrame = -1;
    for (let i = 0; i < 900; i++) { const up = await m.eval("window.__i4.upgrades('tank_b')"); if (!up.length) { A.expiredAtFrame = i; break; } await m.pump(1); }
    A.afterExpiry = { fx: await m.eval("window.__i4.fixtures('tank_b')"), up: await m.eval("window.__i4.upgrades('tank_b')") };
    P('A4 expiry frame=' + A.expiredAtFrame + ' fixtures=' + JSON.stringify(A.afterExpiry.fx));

    // 破片
    A.shrapnel = {};
    if (!A.afterExpiry.up.length) { await m.eval(`window.__i4.spawnCrate(6, ${near.x}, ${near.y}, 0)`); for (let i = 0; i < 10; i++) { await m.pump(1); if ((await m.eval("window.__i4.upgrades('tank_b')")).length) break; } }
    for (const spec of [['outside8m', 8.0], ['insideShieldOutsideBox', 3.0], ['insideBox', 1.0]]) {
      const tag = spec[0], off = spec[1];
      const tb = await m.eval("window.__i4.tank('tank_b')");
      if (!tb) { A.shrapnel[tag] = { skipped: 'tank gone' }; break; }
      if (!(await m.eval("window.__i4.upgrades('tank_b')")).length) { A.shrapnel[tag] = { skipped: 'no shield' }; break; }
      const id = 'i4mb_' + tag;
      const dir = lane.axis === 'x' ? 1 : 1;
      await m.eval(`window.__i4.spawnShrapnel(${JSON.stringify(id)}, 'tank_a', ${tb.x + off}, ${tb.y}, -30, 0)`);
      const rec = { off: off, center: [tb.x, tb.y], frames: [] };
      for (let i = 0; i < 20; i++) {
        const b = (await m.eval('window.__i4.bullets()')).filter((x) => x.id === id);
        const t = await m.eval("window.__i4.tank('tank_b')");
        rec.frames.push({ f: i, d: b[0] ? +Math.hypot(b[0].x - tb.x, b[0].y - tb.y).toFixed(3) : null,
          sp: b[0] ? b[0].sp : null, deadly: b[0] && b[0].live ? b[0].live.deadly : null, alive: !!t });
        if (!b.length) { rec.goneAt = i; break; }
        if (!t) { rec.killedAt = i; break; }
        await m.pump(1);
      }
      A.shrapnel[tag] = rec;
      P('A5 shrapnel[' + tag + '] ' + JSON.stringify(rec.frames.map((x) => x.d === null ? ('GONE alive=' + x.alive) : ('d=' + x.d + ' |v|=' + x.sp + ' deadly=' + x.deadly))));
      if (rec.killedAt !== undefined) { A.killedByShrapnel = tag; break; }
      await m.pump(3);
    }
    A.pageErrors = m.pageErrors.slice(0, 5);
  } finally { try { await m.close(); } catch (e) {} }
  return A;
}

/* =============================== B 毒雾 =============================== */
async function partB(B) {
  const m = await openMatch({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
  try {
    B.openMs = m._openMs;
    B.types = await m.eval('window.__i4.types()');
    B.modeInfoBefore = await m.eval('window.__i4.modeInfo()');
    const ti = await m.eval('window.__i4.tileInfo()');
    B.maze = { bounds: ti.tileBounds, w: ti.width, h: ti.height, seq: ti.seq, TILE: ti.TILE, WALL: ti.WALL, appearAt: ti.stormAppearAt };
    B.victimCell = { x: ti.tileBounds.maxX, y: Math.round((ti.tileBounds.minY + ti.tileBounds.maxY) / 2) };
    if (!ti.cells.some((c) => c.x === B.victimCell.x && c.y === B.victimCell.y)) B.victimCell = { x: ti.cells[0].x, y: ti.cells[0].y };
    const vx = B.victimCell.x * TILE + TILE / 2, vy = B.victimCell.y * TILE + TILE / 2;
    B.victimWorld = { x: vx, y: vy };
    await m.teleport('tank_b', vx, vy, 0);
    await m.pump(3);
    B.victimBox = await m.eval("window.__i4.tankBox('tank_b')");
    B.stormFlag = await m.eval('window.__i4.setStormFlag(true)');
    P('B0 mode=' + JSON.stringify(B.modeInfoBefore) + ' stormFlag=' + JSON.stringify(B.stormFlag));
    P('B0 bounds=' + JSON.stringify(ti.tileBounds) + ' seq=' + ti.seq.join(',') + ' appearAt=' + ti.stormAppearAt);
    P('B0 victimCell=' + JSON.stringify(B.victimCell) + ' world=' + JSON.stringify(B.victimWorld) + ' box=' + JSON.stringify(B.victimBox));

    // ① boot camp 里 storm=true 会不会出风暴：先推 120 帧看
    await m.pump(120);
    B.zonesAfter120 = await m.eval('window.__i4.zones()');
    B.modeInfoAfter120 = await m.eval('window.__i4.modeInfo()');
    P('B1 bootcamp storm=true 推 120 帧后：zones=' + B.zonesAfter120.length + ' mode=' + JSON.stringify(B.modeInfoAfter120));

    // ② 注入游戏自己的 ZoneState（与 ClassicGameMode 创建风暴走同一段 RoundController.setZoneState 代码）
    const inj = await m.eval('window.__i4.injectStorm()');
    B.injected = inj;
    const z0 = (await m.eval('window.__i4.zones()'))[0];
    B.spawnSnapshot = z0;
    P('B2 注入后 zone: side=' + z0.side + ' t=' + z0.t + ' corners=' + JSON.stringify(z0.corners));
    P('B2 4 个夹具 AABB=' + JSON.stringify(z0.aabb) + ' isPhysical=' + z0.isPhysical + ' tilesN=' + z0.tilesN + ' tiles=' + JSON.stringify(z0.tiles));

    B.rows = []; let deathFrame = -1;
    for (let i = 0; i < 900; i++) {
      const zs = await m.eval('window.__i4.zones()');
      const t = await m.eval("window.__i4.tank('tank_b')");
      B.rows.push({ f: i, z: zs[0] || null, tankB: t ? t.x : null });
      if (!t) { deathFrame = i; break; }
      await m.pump(1);
    }
    B.deathFrame = deathFrame;
    B.deathRow = deathFrame >= 0 ? B.rows[deathFrame] : null;
    B.prevRow = deathFrame > 0 ? B.rows[deathFrame - 1] : null;
    if (B.prevRow && B.prevRow.z) P('B3 死前帧 f=' + B.prevRow.f + ' sR=' + B.prevRow.z.corners.stormStartRight + ' tilesN=' + B.prevRow.z.tilesN + ' tiles=' + JSON.stringify(B.prevRow.z.tiles));
    if (B.deathRow && B.deathRow.z) P('B3 死亡帧 f=' + B.deathRow.f + ' sR=' + B.deathRow.z.corners.stormStartRight + ' tilesN=' + B.deathRow.z.tilesN + ' tiles=' + JSON.stringify(B.deathRow.z.tiles));
    const step = Math.max(1, Math.floor(B.rows.length / 14));
    for (let i = 0; i < B.rows.length; i += step) {
      const r = B.rows[i]; if (!r.z) continue;
      P('   f' + r.f + ' t=' + r.z.t + ' side=' + r.z.side + ' RBLT=' + r.z.r + r.z.b + r.z.l + r.z.tp +
        ' sR=' + r.z.corners.stormStartRight + ' eL=' + r.z.corners.stormEndLeft + ' aabbR=' + JSON.stringify(r.z.aabb[0]) +
        ' tilesN=' + r.z.tilesN + ' tankB=' + r.tankB);
    }
    P('B3 deathFrame=' + deathFrame + ' = ' + (deathFrame * DT).toFixed(2) + 's（自注入）');
    B.pageErrors = m.pageErrors.slice(0, 6);
  } finally { try { await m.close(); } catch (e) {} }
  return B;
}

/* =============================== C 道具 =============================== */
async function partC(C) {
  const m = await openMatch({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
  try {
    C.openMs = m._openMs;
    const ti = await m.eval('window.__i4.tileInfo()');
    const lane = findLane(ti, 5);
    C.lane = { axis: lane.axis, cells: lane.cells.map((c) => c.x + ',' + c.y) };
    const p = lanePose(lane, 0);
    await m.teleport('tank_a', p.x, p.y, p.rot); await m.pump(3);
    C.fx_default = await m.eval("window.__i4.fixtures('tank_a')");
    C.weapons_default = await m.eval('window.__i4.weapons()');
    P('C0 lane=' + lane.axis + ' ' + JSON.stringify(C.lane.cells) + ' pose=' + JSON.stringify(p));
    P('C0 default fixtures=' + JSON.stringify(C.fx_default));
    C.crate1 = await m.eval(`window.__i4.spawnCrate(2, ${p.x}, ${p.y}, 0)`);
    for (let i = 0; i < 10; i++) { await m.pump(1); if ((await m.eval('window.__i4.weapons()')).some((w) => w.owner === 'tank_a' && w.type === 2)) break; }
    C.fx_shotgun = await m.eval("window.__i4.fixtures('tank_a')");
    C.weapons_shotgun = await m.eval('window.__i4.weapons()');
    C.cratesLeft = await m.eval('window.__i4.collectibles()');
    P('C1 after shotgun fixtures=' + JSON.stringify(C.fx_shotgun));
    P('C1 weapons=' + JSON.stringify(C.weapons_shotgun) + ' cratesLeft=' + JSON.stringify(C.cratesLeft));
    C.queue = [];
    for (const t of [1, 3, 5, 4, 2]) {
      const id = await m.eval(`window.__i4.spawnCrate(${t}, ${p.x}, ${p.y}, 0)`);
      await m.pump(4);
      const w = (await m.eval('window.__i4.weapons()')).filter((x) => x.owner === 'tank_a');
      const left = await m.eval('window.__i4.collectibles()');
      C.queue.push({ crateType: t, crateId: id, weaponTypes: w.map((x) => x.type + '(' + x.num + ')'), crateStillThere: left.some((c) => c.id === id) });
      P('C2 spawn type=' + t + ' -> weapons=[' + C.queue[C.queue.length - 1].weaponTypes.join(',') + '] crateStillThere=' + C.queue[C.queue.length - 1].crateStillThere);
    }
    C.fx_afterQueue = await m.eval("window.__i4.fixtures('tank_a')");
    P('C2 fixtures after queue=' + JSON.stringify(C.fx_afterQueue));
    C.pageErrors = m.pageErrors.slice(0, 5);
  } finally { try { await m.close(); } catch (e) {} }
  return C;
}

/* =============================== D 炮管夹具判死 =============================== */
async function partD(D) {
  const m = await openMatch({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
  try {
    D.openMs = m._openMs;
    const ti = await m.eval('window.__i4.tileInfo()');
    const lane = findLane(ti, 4);
    if (!lane || lane.axis !== 'x') { D.skip = 'no x-lane (axis=' + (lane && lane.axis) + ')'; return D; }
    const c0 = lanePose(lane, 0), c1 = lanePose(lane, 2);
    const tx = c1.x, ty = c1.y;
    const sx = c0.x, sy = c0.y - 2.4;    // 射手在目标 -y 侧 2.4m，朝 +x
    D.geom = { target: [tx, ty], shooter: [sx, sy], aimLineY: sy, note: '子弹沿 +x，走 y=shooter.y 这条线；目标中心在 y=ty（差 2.4）' };
    D.cases = {};
    for (const spec of [['barrelAway', Math.PI, 'expectSurvive'], ['barrelToward', 0, 'expectDie']]) {
      const tag = spec[0], rot = spec[1], expect = spec[2];
      await m.teleport('tank_b', tx, ty, rot);
      await m.teleport('tank_c', tx + 30, ty + 30, 0).catch(() => {});
      await m.teleport('tank_a', sx, sy, Math.PI / 2);
      await m.pump(4);
      const fx = await m.eval("window.__i4.fixtures('tank_b')");
      const box = await m.eval("window.__i4.tankBox('tank_b')");
      await m.setControl({ fire: true }); await m.pump(1); await m.setControl({ fire: false });
      let deadAt = -1; const trace = []; let seen = false;
      for (let i = 0; i < 150; i++) {
        const t = await m.eval("window.__i4.tank('tank_b')");
        const b = await m.eval('window.__i4.bullets()');
        if (b.length) seen = true;
        trace.push({ f: i, alive: !!t, b: b.map((x) => [x.x, x.y]) });
        if (!t) { deadAt = i; break; }
        if (seen && b.length === 0) break;
        await m.pump(1);
      }
      const bs = trace.filter((r) => r.b.length).map((r) => r.b[0]);
      D.cases[tag] = { rot: rot, expect: expect, deadAt: deadAt, fx: fx, box: box,
        bulletXRange: bs.length ? [+Math.min(...bs.map((x) => x[0])).toFixed(2), +Math.max(...bs.map((x) => x[0])).toFixed(2)] : null,
        bulletYMean: bs.length ? +(bs.reduce((a, x) => a + x[1], 0) / bs.length).toFixed(3) : null, frames: trace.length };
      P('D[' + tag + '] rot=' + rot + ' deadAt=' + deadAt + ' (expect ' + expect + ') bulletX=' + JSON.stringify(D.cases[tag].bulletXRange) +
        ' bulletYmean=' + D.cases[tag].bulletYMean + ' baseBoxY=' + JSON.stringify([box[1], box[3]]) +
        ' turret=' + JSON.stringify((fx || []).filter((f) => f.ut === 'turret').map((f) => f.v)));
      await m.pump(20);
    }
    D.pageErrors = m.pageErrors.slice(0, 5);
  } finally { try { await m.close(); } catch (e) {} }
  return D;
}

(async () => {
  try {
    fs.mkdirSync(PROF, { recursive: true });
    for (const pair of [['A', partA], ['B', partB], ['C', partC], ['D', partD]]) {
      try { report[pair[0]] = await pair[1]({}); }
      catch (e) { report[pair[0] + '_err'] = String((e && e.stack) || e); P('X ' + pair[0] + ': ' + report[pair[0] + '_err']); }
      try { fs.writeFileSync(path.join(PROF, '_i4_probe_spec_1_4c.json'), JSON.stringify(report, null, 1)); } catch (e) {}
    }
  } catch (e) { report.fatal = String((e && e.stack) || e); console.error('FATAL:', report.fatal); process.exitCode = 1; }
  finally {
    try { fs.writeFileSync(path.join(PROF, '_i4_probe_spec_1_4c.json'), JSON.stringify(report, null, 1)); } catch (e) {}
    P('\n[done] ' + ((Date.now() - T0) / 1000).toFixed(1) + 's');
  }
})();
