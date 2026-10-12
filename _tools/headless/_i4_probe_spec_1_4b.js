'use strict';
/* ============================================================================
 * _i4_ 探针：阶段 1-4（护盾 / 毒雾 / 道具+形状改变）规格核查的【真游戏实测】
 *
 *   M1 A) 护盾：真 crate 拾取 → 夹具清单；真开火（正打 / 斜打）→ 反弹角速度 vs 预测；
 *            护盾到期 → 夹具消失；注入【真 Shrapnel】三处 → 停/杀？
 *   M2 B) 毒雾：setStorm(true) 真等自然出现（60s）→ 四夹具 AABB / 安全区矩形 /
 *            逐帧边界 / 致死帧 vs 预测 / tiles 与夹具的领先关系
 *   M3 C) 道具：真 crate 拾取（炮管夹具切换）/ 队列上限
 *   M4 D) 炮管夹具参与判死：反例（炮管背对）先跑，正例（炮管朝向）后跑
 *
 * 只读 game_core/，只写 _tools/headless/_i4_prof/。
 * 用法：node _tools/headless/_i4_probe_spec_1_4b.js
 * ============================================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Match } = require('./match');

const TILE = 10;
const DT = 1 / 60;
const PROF = path.join(__dirname, '_i4_prof');
const FILES = [
  'game_core/js/82e43ebfcdffdaf490dbe79c9c119d29.js',
  'game_core/js/7b2ed8ad3598d7321f8f3d2b04b1eac8.js',
  'game_core/js/46989e393ad0e356ac8a0c6c53b362f9.js',
  'game_core/js/418577fd210ad079ea3d1e5e04050fe0.js',
  'game_core/js/b714588dc4621fe104113111ba90b1a7.js',
  'game_core/js/54518faa8d672020d7af8ed7c353bc1b.js',
  'game_core/js/ce217c9b090cc73ce0e1faa13d20ca15.js',
  'game_core/js/vantage_sandbox.js',
  'game_core/js/vantage_tree.js',
  'game_core/js/wasm/vantage_core.wasm',
  '_tools/headless/match.js',
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
const T0 = Date.now();
const report = { startedAt: new Date().toISOString(), fingerprints: fingerprints() };
const P = (...a) => console.log(...a);

const HELPERS = `
window.__i4 = {
  gc: function () { return GameManager.getGameController(); },
  rc: function () { return GameManager.getGameController().roundController; },
  sub: function (x, n) { var p = Math.pow(10, n === undefined ? 3 : n); return Math.round(x * p) / p; },
  globals: function () {
    var names = ['Constants','B2DUtils','IdGenerator','TankState','ProjectileState','ZoneState',
                 'CollectibleState','TrapState','UpgradeState','WeaponState','Mine','Shrapnel','StormZone',
                 'ShieldUpgrade','Collectible','Pickup','Tank','Zone','GameModel'];
    var o = {};
    for (var i = 0; i < names.length; i++) { var v = 'ERR'; try { v = eval('typeof ' + names[i]); } catch (e) {} o[names[i]] = v; }
    return o;
  },
  cats: function () { return Constants.COLLISION_CATEGORIES; },
  tank: function (id) {
    var t = this.gc().getTank(id);
    if (!t) return null;
    return { id: id, x: this.sub(t.getX()), y: this.sub(t.getY()), rot: this.sub(t.getRotation(), 4) };
  },
  fixtures: function (id) {
    var t = this.gc().getTank(id); if (!t) return null;
    var b = t.getB2DBody(); if (!b) return null;
    var out = [];
    for (var f = b.GetFixtureList(); f !== null; f = f.GetNext()) {
      var ud = f.GetUserData() || {}; var fd = f.GetFilterData(); var sh = f.GetShape();
      var o = { ut: (ud.type === undefined ? null : ud.type), cat: fd.categoryBits, mask: fd.maskBits,
                st: sh.m_type, r: null, n: null, v: null };
      if (sh.m_radius !== undefined) o.r = this.sub(sh.m_radius, 4);
      if (sh.m_vertexCount !== undefined) {
        o.n = sh.m_vertexCount; o.v = [];
        for (var i = 0; i < sh.m_vertexCount; i++) { var w = b.GetWorldPoint(sh.m_vertices[i]); o.v.push([this.sub(w.x), this.sub(w.y)]); }
      }
      out.push(o);
    }
    return out;
  },
  upgrades: function (id) {
    var d = __vtData(this.gc().getRoundState()) || {};
    var us = d.upgradeStates || []; var out = [];
    for (var i = 0; i < us.length; i++) {
      if (us[i].playerId === id) { var f = {}; try { f = JSON.parse(us[i].fieldsJSON || '{}'); } catch (e) {}
        out.push({ id: us[i].id, type: us[i].type, life: f._lifetime }); }
    }
    return out;
  },
  collectibles: function () {
    var d = __vtData(this.gc().getRoundState()) || {};
    return (d.collectibleStates || []).map(function (c) { return { id: c.id, type: c.type, x: this.sub(c.x), y: this.sub(c.y) }; }, this);
  },
  weapons: function () {
    var d = __vtData(this.gc().getRoundState()) || {};
    return (d.weaponStates || []).map(function (w) {
      var f = {}; try { f = JSON.parse(w.fieldsJSON || '{}'); } catch (e) {}
      return { id: w.id, owner: w.playerId, type: w.type, num: f._numBullets, mines: f._numMines, launched: f._launched };
    });
  },
  bullets: function () {
    var d = __vtData(this.gc().getRoundState()) || {};
    var gc = this.gc();
    return (d.projectileStates || []).map(function (p) {
      var live = null;
      try { var o = gc.getProjectile(p.id); if (o) live = { deadly: o.isDeadlyToOwner(), ta: this.sub(o.getTimeAlive(), 3), stopped: !!o.stopped }; } catch (e) {}
      return { id: p.id, o: p.playerId, t: p.type, x: this.sub(p.x), y: this.sub(p.y),
               vx: this.sub(p.speedX), vy: this.sub(p.speedY), sp: this.sub(Math.sqrt(p.speedX * p.speedX + p.speedY * p.speedY)), live: live };
    }, this);
  },
  zones: function () {
    var gc = this.gc(); var zs = gc.getZones(); var out = [];
    for (var k in zs) {
      if (!zs.hasOwnProperty(k)) continue;
      var z = zs[k];
      var c = null; try { c = z.getCorners(); } catch (e) {}
      var o = { id: k, type: z.getType(), corners: c, side: z._expansionSide, t: this.sub(z._expansionTime, 4),
                r: z._expansionTilesRight, b: z._expansionTilesBottom, l: z._expansionTilesLeft, tp: z._expansionTilesTop,
                tilesN: null, tiles: null, aabb: [] };
      try { var tl = z.getTiles() || []; o.tilesN = tl.length; o.tiles = tl.slice(0, 6).map(function (p) { return p.x + ',' + p.y; }); } catch (e) {}
      var body = z.getB2DBody();
      if (body) {
        for (var f = body.GetFixtureList(); f !== null; f = f.GetNext()) {
          var sh = f.GetShape(); var mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
          for (var i = 0; i < sh.m_vertexCount; i++) { var v = sh.m_vertices[i];
            if (v.x < mnx) mnx = v.x; if (v.x > mxx) mxx = v.x; if (v.y < mny) mny = v.y; if (v.y > mxy) mxy = v.y; }
          o.aabb.push([this.sub(mnx), this.sub(mny), this.sub(mxx), this.sub(mxy)]);
        }
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
  roundInfo: function () {
    var gc = this.gc(); var gm = gc.getGameMode();
    return { state: gc.getState(), roundDuration: this.sub(gm.roundDuration, 3), storm: !!gm.storm,
             stormSpawned: !!gm.stormSpawned, tanks: Object.keys(gc.getTanks()).length };
  },
  spawnCrate: function (type, x, y, rot) {
    var st = CollectibleState.withState(IdGenerator.instance.gen('c'), type, x, y, rot || 0);
    this.rc().setCollectibleState(st); return st.getId();
  },
  spawnShrapnel: function (id, owner, x, y, vx, vy) {
    this.rc().setProjectileState(ProjectileState.withState(id, owner, Constants.WEAPON_TYPES.MINE, x, y, vx, vy));
    return id;
  },
  setStormFlag: function (on) {
    var gc = this.gc(); gc.setStorm(!!on); gc.getGameMode().setStorm(!!on);
    return { gcStorm: gc.getStorm(), gmStorm: !!gc.getGameMode().storm };
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

function findLane(ti, minLen) {
  const byRow = {};
  for (const c of ti.cells) (byRow[c.y] = byRow[c.y] || []).push(c);
  let best = null;
  for (const y of Object.keys(byRow)) {
    const row = byRow[y].slice().sort((a, b) => a.x - b.x);
    let run = [row[0]];
    for (let i = 1; i < row.length; i++) {
      const prev = row[i - 1], cur = row[i];
      if (cur.x === prev.x + 1 && cur.left === 0) run.push(cur);
      else { if (!best || run.length > best.length) best = run; run = [cur]; }
    }
    if (!best || run.length > best.length) best = run;
  }
  if (!best || best.length < minLen) return null;
  return best.slice(0, minLen);
}
async function openMatch(o) {
  const m = new Match();
  const t0 = Date.now();
  await m.open(o);
  m._openMs = Date.now() - t0;
  await m.clearControl();
  await m.eval(HELPERS);
  return m;
}

/* ================================ A：护盾 ================================ */
async function partA(A) {
  const m = await openMatch({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
  try {
    A.openMs = m._openMs;
    A.globals = await m.eval('window.__i4.globals()');
    A.cats = await m.eval('window.__i4.cats()');
    const ti = await m.eval('window.__i4.tileInfo()');
    A.tileInfo = { TILE: ti.TILE, WALL: ti.WALL, bounds: ti.tileBounds, width: ti.width, height: ti.height, seqLen: ti.seq.length };
    const lane = findLane(ti, 5);
    if (!lane) throw new Error('no lane');
    A.lane = lane.map((c) => c.x + ',' + c.y);
    const laneY = lane[0].y, x1 = lane[0].x, x2 = lane[lane.length - 1].x;
    const by = laneY * TILE + TILE / 2;
    const bx = (x2 - 1) * TILE + TILE / 2;
    const ax = x1 * TILE + TILE / 2;
    await m.teleport('tank_c', (x1 + 2) * TILE + 5, (laneY + 2) * TILE + 5, 0).catch(() => {});
    await m.teleport('tank_b', bx, by, 0);
    await m.pump(3);
    A.before = { fx: await m.eval("window.__i4.fixtures('tank_b')"), up: await m.eval("window.__i4.upgrades('tank_b')") };

    A.crateId = await m.eval(`window.__i4.spawnCrate(${6}, ${bx}, ${by}, 0)`);
    for (let i = 0; i < 8; i++) { await m.pump(1); if ((await m.eval("window.__i4.upgrades('tank_b')")).length) break; }
    A.after = { fx: await m.eval("window.__i4.fixtures('tank_b')"), up: await m.eval("window.__i4.upgrades('tank_b')"),
                left: await m.eval('window.__i4.collectibles()') };
    P('A1 pickup upgrade=' + JSON.stringify(A.after.up));
    P('A1 fixtures=' + JSON.stringify(A.after.fx));
    const shield = (A.after.fx || []).find((f) => f.cat === 32);
    A.shieldFixture = shield;
    if (!shield) throw new Error('no shield fixture');

    async function shootAndTrace(frames) {
      await m.setControl({ fire: true }); await m.pump(1); await m.setControl({ fire: false });
      const rows = []; let fired = false;
      for (let i = 0; i <= frames; i++) {
        const b = await m.eval('window.__i4.bullets()');
        const t = await m.eval("window.__i4.tank('tank_b')");
        rows.push({ f: i, b: b, alive: !!t });
        if (b.length) fired = true;
        if (fired && b.length === 0) break;
        await m.pump(1);
      }
      return { rows: rows, fired: fired };
    }
    A.headOn = await shootAndTrace(200);
    let hb = A.headOn.rows.filter((r) => r.b.length).map((r) => r.b[0]);
    let flip = -1;
    for (let i = 1; i < hb.length; i++) if (hb[i].vx * hb[i - 1].vx < 0) { flip = i; break; }
    A.headOn.flipIdx = flip;
    A.headOn.inV = flip > 0 ? [hb[flip - 1].vx, hb[flip - 1].vy, hb[flip - 1].sp] : null;
    A.headOn.outV = flip > 0 ? [hb[flip].vx, hb[flip].vy, hb[flip].sp] : null;
    A.headOn.posAtFlip = flip > 0 ? [hb[flip].x, hb[flip].y] : null;
    A.headOn.deadlyBefore = flip > 0 ? hb[flip - 1].live.deadly : null;
    A.headOn.deadlyAfter = flip > 0 ? hb[flip].live.deadly : null;
    A.headOn.tankAliveEnd = A.headOn.rows[A.headOn.rows.length - 1].alive;
    A.headOn.minDistToTarget = hb.length ? +Math.min(...hb.map((p) => Math.hypot(p.x - bx, p.y - by))).toFixed(3) : null;
    P('A2 headOn flip@' + flip + ' in=' + JSON.stringify(A.headOn.inV) + ' out=' + JSON.stringify(A.headOn.outV) +
      ' at=' + JSON.stringify(A.headOn.posAtFlip) + ' deadly=' + A.headOn.deadlyBefore + '->' + A.headOn.deadlyAfter +
      ' minDistToTarget=' + A.headOn.minDistToTarget + ' targetAlive=' + A.headOn.tankAliveEnd);

    // A3 斜打
    const by2 = by + 2.5;
    await m.teleport('tank_b', bx, by2, 0);
    await m.pump(3);
    await m.teleport('tank_a', ax, by, Math.PI / 2);
    await m.pump(3);
    A.obliqueGeom = { center: [bx, by2], shotLineY: by, shieldR: shield.r, bulletR: 0.25 };
    A.oblique = await shootAndTrace(200);
    let ob = A.oblique.rows.filter((r) => r.b.length).map((r) => r.b[0]);
    let oflip = -1;
    for (let i = 1; i < ob.length; i++) if (Math.abs(ob[i].vy - ob[i - 1].vy) > 1e-6 || ob[i].vx * ob[i - 1].vx < 0) { oflip = i; break; }
    A.oblique.flipIdx = oflip;
    A.oblique.inV = oflip > 0 ? [ob[oflip - 1].vx, ob[oflip - 1].vy, ob[oflip - 1].sp] : null;
    A.oblique.outV = oflip > 0 ? [ob[oflip].vx, ob[oflip].vy, ob[oflip].sp] : null;
    A.oblique.posAtFlip = oflip > 0 ? [ob[oflip].x, ob[oflip].y] : null;
    if (oflip > 0) {
      const C = [bx, by2], p = [ob[oflip].x, ob[oflip].y];
      const d = [p[0] - C[0], p[1] - C[1]];
      const L = Math.hypot(d[0], d[1]);
      const n = [d[0] / L, d[1] / L];
      const vin = [ob[oflip - 1].vx, ob[oflip - 1].vy];
      const dot = vin[0] * n[0] + vin[1] * n[1];
      A.oblique.predicted = [+(vin[0] - 2 * dot * n[0]).toFixed(3), +(vin[1] - 2 * dot * n[1]).toFixed(3)];
      A.oblique.normal = n.map((x) => +x.toFixed(3));
      A.oblique.distAtFlip = +L.toFixed(3);
    }
    A.oblique.tankAliveEnd = A.oblique.rows[A.oblique.rows.length - 1].alive;
    P('A3 oblique flip@' + oflip + ' in=' + JSON.stringify(A.oblique.inV) + ' out=' + JSON.stringify(A.oblique.outV) +
      ' predicted=' + JSON.stringify(A.oblique.predicted) + ' |p-C|=' + A.oblique.distAtFlip + ' targetAlive=' + A.oblique.tankAliveEnd);

    // A4 到期
    await m.teleport('tank_b', bx, by, 0);
    A.expiredAtFrame = -1;
    for (let i = 0; i < 900; i++) {
      const up = await m.eval("window.__i4.upgrades('tank_b')");
      if (!up.length) { A.expiredAtFrame = i; break; }
      await m.pump(1);
    }
    A.afterExpiry = { fx: await m.eval("window.__i4.fixtures('tank_b')"), up: await m.eval("window.__i4.upgrades('tank_b')") };
    P('A4 expiry frame=' + A.expiredAtFrame + ' fixtures=' + JSON.stringify(A.afterExpiry.fx));

    // A5 破片
    A.shrapnel = {};
    if (!A.afterExpiry.up.length) {
      await m.eval(`window.__i4.spawnCrate(${6}, ${bx}, ${by}, 0)`);
      for (let i = 0; i < 8; i++) { await m.pump(1); if ((await m.eval("window.__i4.upgrades('tank_b')")).length) break; }
    }
    for (const spec of [['outside8m', 8.0], ['insideShieldOutsideBox', 3.0], ['insideBox', 1.0]]) {
      const tag = spec[0], off = spec[1];
      const tb = await m.eval("window.__i4.tank('tank_b')");
      if (!tb) { A.shrapnel[tag] = { skipped: 'tank gone' }; break; }
      const ups = await m.eval("window.__i4.upgrades('tank_b')");
      if (!ups.length) { A.shrapnel[tag] = { skipped: 'no shield' }; break; }
      const id = 'i4mb_' + tag;
      await m.eval(`window.__i4.spawnShrapnel(${JSON.stringify(id)}, 'tank_a', ${tb.x + off}, ${tb.y}, -30, 0)`);
      const rec = { off: off, center: [tb.x, tb.y], frames: [] };
      for (let i = 0; i < 20; i++) {
        const b = (await m.eval('window.__i4.bullets()')).filter((x) => x.id === id);
        const t = await m.eval("window.__i4.tank('tank_b')");
        rec.frames.push({ f: i, b: b[0] || null, alive: !!t,
          d: b[0] ? +Math.hypot(b[0].x - tb.x, b[0].y - tb.y).toFixed(3) : null });
        if (!b.length) { rec.goneAt = i; break; }
        if (!t) { rec.killedAt = i; break; }
        await m.pump(1);
      }
      A.shrapnel[tag] = rec;
      P('A5 shrapnel[' + tag + '] ' + JSON.stringify(rec.frames.map((x) => x.b ? ('d=' + x.d + ' |v|=' + x.b.sp + ' deadly=' + x.b.live.deadly) : 'GONE alive=' + x.alive)));
      if (rec.killedAt !== undefined) { A.killedByShrapnel = tag; break; }
      await m.pump(3);
    }
    A.pageErrors = m.pageErrors.slice(0, 5);
  } finally { try { await m.close(); } catch (e) {} }
  return A;
}

/* ================================ B：毒雾 ================================ */
async function partB(B) {
  const m = await openMatch({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
  try {
    B.openMs = m._openMs;
    const ti = await m.eval('window.__i4.tileInfo()');
    B.tileInfo = ti;
    const tb = ti.tileBounds;
    B.roundAtStart = await m.eval('window.__i4.roundInfo()');
    const first = ti.seq[0];
    let cell = { x: tb.maxX, y: Math.floor((tb.minY + tb.maxY) / 2) };
    if (!ti.cells.some((c) => c.x === cell.x && c.y === cell.y)) cell = { x: ti.cells[0].x, y: ti.cells[0].y };
    B.victimCell = cell;
    const vx = cell.x * TILE + TILE / 2, vy = cell.y * TILE + TILE / 2;
    B.victimWorld = { x: vx, y: vy };
    await m.teleport('tank_b', vx, vy, 0);
    await m.teleport('tank_a', vx, vy + 60, 0).catch(() => {});
    await m.pump(3);
    B.victimPlaced = await m.eval("window.__i4.tank('tank_b')");
    B.tankBox = await m.eval("window.__i4.tankBox('tank_b')");
    B.stormFlag = await m.eval('window.__i4.setStormFlag(true)');
    P('B0 victimCell=' + JSON.stringify(cell) + ' world=' + JSON.stringify(B.victimWorld) + ' box=' + JSON.stringify(B.tankBox));
    P('B0 round=' + JSON.stringify(B.roundAtStart) + ' stormFlag=' + JSON.stringify(B.stormFlag) +
      ' seq=' + ti.seq.join(',') + ' bounds=' + JSON.stringify(tb) + ' appearAt=' + ti.stormAppearAt);

    let frames = 0, spawn = null;
    for (let k = 0; k < 220; k++) {
      const zs = await m.eval('window.__i4.zones()');
      if (zs.length) { spawn = { frames: frames, z: zs[0], round: await m.eval('window.__i4.roundInfo()') }; break; }
      await m.pump(30); frames += 30;
      if (k % 30 === 0) P('   ...pump ' + frames + ' round=' + JSON.stringify(await m.eval('window.__i4.roundInfo()')));
    }
    B.spawn = spawn;
    P('B1 spawn@frame=' + (spawn && spawn.frames) + ' roundDuration=' + (spawn && spawn.round.roundDuration));
    P('B1 fixtures AABB=' + (spawn && JSON.stringify(spawn.z.aabb)));
    P('B1 corners=' + (spawn && JSON.stringify(spawn.z.corners)) + ' tilesN=' + (spawn && spawn.z.tilesN));
    if (!spawn) throw new Error('no storm in 60s');

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
    if (B.deathRow && B.deathRow.z) P('B2 deathRow f=' + B.deathRow.f + ' sR=' + B.deathRow.z.corners.stormStartRight + ' tilesN=' + B.deathRow.z.tilesN + ' tiles=' + JSON.stringify(B.deathRow.z.tiles));
    if (B.prevRow && B.prevRow.z) P('B2 prevRow f=' + B.prevRow.f + ' sR=' + B.prevRow.z.corners.stormStartRight + ' tilesN=' + B.prevRow.z.tilesN);
    const step = Math.max(1, Math.floor(B.rows.length / 12));
    for (let i = 0; i < B.rows.length; i += step) {
      const r = B.rows[i]; if (!r.z) continue;
      P('   f' + r.f + ' t=' + r.z.t + ' side=' + r.z.side + ' RBLT=' + r.z.r + r.z.b + r.z.l + r.z.tp +
        ' sR=' + r.z.corners.stormStartRight + ' aabbR=' + JSON.stringify(r.z.aabb[0]) + ' tilesN=' + r.z.tilesN + ' tankB=' + r.tankB);
    }
    P('B2 deathFrame=' + deathFrame + ' = ' + (deathFrame * DT).toFixed(2) + 's after spawn; ' + ((spawn.frames + deathFrame) * DT).toFixed(2) + 's after setStorm');
    B.framesAfterSpawn = deathFrame;
    B.pageErrors = m.pageErrors.slice(0, 5);
  } finally { try { await m.close(); } catch (e) {} }
  return B;
}

/* ================================ C：道具 / 形状 ================================ */
async function partC(C) {
  const m = await openMatch({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
  try {
    C.openMs = m._openMs;
    const ti = await m.eval('window.__i4.tileInfo()');
    const lane = findLane(ti, 5);
    const laneY = lane[0].y, x1 = lane[0].x;
    const px = (x1 + 1) * TILE + TILE / 2, py = laneY * TILE + TILE / 2;
    await m.teleport('tank_a', px, py, 0); await m.pump(3);
    C.fx_default = await m.eval("window.__i4.fixtures('tank_a')");
    C.weapons_default = await m.eval('window.__i4.weapons()');
    P('C0 default fixtures=' + JSON.stringify(C.fx_default));
    P('C0 default weapons=' + JSON.stringify(C.weapons_default));

    C.crate1 = await m.eval(`window.__i4.spawnCrate(${2}, ${px}, ${py}, 0)`);
    for (let i = 0; i < 8; i++) { await m.pump(1); if ((await m.eval('window.__i4.weapons()')).some((w) => w.owner === 'tank_a' && w.type === 2)) break; }
    C.fx_shotgun = await m.eval("window.__i4.fixtures('tank_a')");
    C.weapons_shotgun = await m.eval('window.__i4.weapons()');
    C.collectiblesAfter1 = await m.eval('window.__i4.collectibles()');
    P('C1 after shotgun fixtures=' + JSON.stringify(C.fx_shotgun));
    P('C1 after shotgun weapons=' + JSON.stringify(C.weapons_shotgun) + ' cratesLeft=' + JSON.stringify(C.collectiblesAfter1));

    C.queue = [];
    for (const t of [1, 3, 5, 4, 2]) {
      const id = await m.eval(`window.__i4.spawnCrate(${t}, ${px}, ${py}, 0)`);
      await m.pump(4);
      const w = (await m.eval('window.__i4.weapons()')).filter((x) => x.owner === 'tank_a');
      const left = await m.eval('window.__i4.collectibles()');
      C.queue.push({ crateType: t, crateId: id, weaponTypes: w.map((x) => x.type + '(' + x.num + ')'),
                     crateStillThere: left.some((c) => c.id === id) });
      P('C2 spawn type=' + t + ' -> weapons=[' + C.queue[C.queue.length - 1].weaponTypes.join(',') + '] crateStillThere=' + C.queue[C.queue.length - 1].crateStillThere);
    }
    C.fx_afterQueue = await m.eval("window.__i4.fixtures('tank_a')");
    P('C2 fixtures after queue=' + JSON.stringify(C.fx_afterQueue));
    C.pageErrors = m.pageErrors.slice(0, 5);
  } finally { try { await m.close(); } catch (e) {} }
  return C;
}

/* ================================ D：炮管夹具参与判死 ================================ */
async function partD(D) {
  const m = await openMatch({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
  try {
    D.openMs = m._openMs;
    const ti = await m.eval('window.__i4.tileInfo()');
    const lane = findLane(ti, 6);
    if (!lane) throw new Error('no 6-lane');
    const laneY = lane[0].y;
    const tx = (lane[0].x + 2) * TILE + TILE / 2;
    const ty = laneY * TILE + TILE / 2;
    const sx = tx, sy = ty - 14;
    D.geom = { target: [tx, ty], shooter: [sx, sy], aimLineY: ty - 2.4 };
    D.cases = {};
    for (const spec of [['barrelAway', Math.PI, 'expectSurvive'], ['barrelToward', 0, 'expectDie']]) {
      const tag = spec[0], rot = spec[1], expect = spec[2];
      await m.teleport('tank_b', tx, ty, rot);
      await m.teleport('tank_c', tx + 40, ty + 40, 0).catch(() => {});
      await m.teleport('tank_a', sx, sy, Math.PI);
      await m.pump(4);
      const fx = await m.eval("window.__i4.fixtures('tank_b')");
      const box = await m.eval("window.__i4.tankBox('tank_b')");
      await m.setControl({ fire: true }); await m.pump(1); await m.setControl({ fire: false });
      let deadAt = -1; const trace = [];
      for (let i = 0; i < 150; i++) {
        const t = await m.eval("window.__i4.tank('tank_b')");
        const b = await m.eval('window.__i4.bullets()');
        trace.push({ f: i, alive: !!t, b: b.map((x) => [x.x, x.y]) });
        if (!t) { deadAt = i; break; }
        if (b.length === 0 && i > 3) break;
        await m.pump(1);
      }
      const ys = trace.filter((r) => r.b.length).map((r) => r.b[0][1]);
      D.cases[tag] = { rot: rot, expect: expect, deadAt: deadAt, fx: fx, box: box,
                       bulletMaxY: ys.length ? +Math.max(...ys).toFixed(3) : null, bulletMinY: ys.length ? +Math.min(...ys).toFixed(3) : null, traceN: trace.length };
      P('D[' + tag + '] rot=' + rot + ' deadAt=' + deadAt + ' bulletY=' + D.cases[tag].bulletMinY + '..' + D.cases[tag].bulletMaxY +
        ' baseBox=' + JSON.stringify([box[1], box[3]]) + ' turret=' + JSON.stringify((fx || []).filter((f) => f.ut === 'turret').map((f) => f.v)));
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
      try { fs.writeFileSync(path.join(PROF, '_i4_probe_spec_1_4b.json'), JSON.stringify(report, null, 1)); } catch (e) {}
    }
  } catch (e) {
    report.fatal = String((e && e.stack) || e); console.error('FATAL:', report.fatal); process.exitCode = 1;
  } finally {
    try { fs.writeFileSync(path.join(PROF, '_i4_probe_spec_1_4b.json'), JSON.stringify(report, null, 1)); } catch (e) {}
    P('\n[done] ' + ((Date.now() - T0) / 1000).toFixed(1) + 's');
  }
})();
