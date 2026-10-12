'use strict';
/* _i4x_ 复核探针（2026-10-12 清理轮的追加复核）
 *   ① 确证 `_i4_probe_spec_1_4c.js:105` 的 `vx: this.sub(p.vx)` 在【真局】里恒为 null，
 *      并对照"若用正确键 speedX"时同一段判据会怎么变（正打护盾反弹的 flip 检测）。
 *   ② 实测 `record_page.js:206-210` 的 `wpn` 哨兵在【非 BULLET】弹种上到底是什么，
 *      以及"开火/发射"这种状态变化它能不能看见。
 * 只读 game_core/（不写产品目录）；只写 _tools/headless/_i4x_prof/。
 */
const fs = require('fs');
const path = require('path');
const { Match } = require('./match');
const OUT = path.join(__dirname, '_i4x_prof');
const TILE = 10;

const HELPERS = `
window.__i4x = {
  gc: function(){ return GameManager.getGameController(); },
  rc: function(){ return GameManager.getGameController().roundController; },
  sub: function (x, n) { var p = Math.pow(10, n === undefined ? 3 : n); return (x === null || x === undefined) ? null : Math.round(x * p) / p; },
  /* 完全照抄 _i4_probe_spec_1_4c.js:100-107 的映射（含 vx: this.sub(p.vx) 这个错键） */
  bullets4c: function () {
    var d = __vtData(this.gc().getRoundState()) || {}; var gc = this.gc();
    return (d.projectileStates || []).map(function (p) {
      var live = null;
      try { var o = gc.getProjectile(p.id); if (o) live = { deadly: o.isDeadlyToOwner(), stopped: !!o.stopped }; } catch (e) {}
      return { id: p.id, o: p.playerId, t: p.type, x: this.sub(p.x), y: this.sub(p.y), vx: this.sub(p.vx),
               vy: this.sub(p.speedY), sp: this.sub(Math.sqrt(p.speedX * p.speedX + p.speedY * p.speedY)), live: live };
    }, this);
  },
  /* 同一帧的【正确】版本（schema 键 = speedX/speedY） */
  bulletsOk: function () {
    var d = __vtData(this.gc().getRoundState()) || {};
    return (d.projectileStates || []).map(function (p) {
      return { id: p.id, x: this.sub(p.x), y: this.sub(p.y), vx: this.sub(p.speedX), vy: this.sub(p.speedY),
               raw_has_vx: Object.prototype.hasOwnProperty.call(p, 'vx'),
               raw_has_speedX: Object.prototype.hasOwnProperty.call(p, 'speedX'),
               typeof_vx: String(typeof p.vx) };
    }, this);
  },
  fixtures: function(id){ var t=this.gc().getTank(id); if(!t) return null; var b=t.getB2DBody(); var out=[];
    for(var f=b.GetFixtureList(); f!==null; f=f.GetNext()){ var ud=f.GetUserData()||{}; var sh=f.GetShape();
      var o={ut:ud.type===undefined?null:ud.type, cat:f.GetFilterData().categoryBits, mask:f.GetFilterData().maskBits,
             st:sh.m_type, r:sh.m_radius!==undefined?+sh.m_radius.toFixed(4):null};
      if(sh.m_vertexCount!==undefined){ o.n=sh.m_vertexCount; o.v=[]; for(var i=0;i<sh.m_vertexCount;i++){ var w=b.GetWorldPoint(sh.m_vertices[i]); o.v.push([+w.x.toFixed(3),+w.y.toFixed(3)]); } }
      out.push(o); }
    return out; },
  upgrades: function(id){ var d=__vtData(this.gc().getRoundState())||{}; var us=d.upgradeStates||[]; var o=[];
    for(var i=0;i<us.length;i++) if(us[i].playerId===id){ var f={}; try{f=JSON.parse(us[i].fieldsJSON||'{}');}catch(e){}
      o.push({type:us[i].type, life:+(f._lifetime||0).toFixed(3)}); } return o; },
  spawnCrate: function(type,x,y,rot){ var st=CollectibleState.withState(IdGenerator.instance.gen('c'),type,x,y,rot||0); this.rc().setCollectibleState(st); return st.getId(); },
  tileInfo: function () {
    var mz = this.gc().getMaze(); var tiles = mz.getTiles();
    var out = { TILE: Constants.MAZE_TILE_SIZE.m, cells: [] };
    for (var i = 0; i < tiles.length; i++) for (var j = 0; j < tiles[i].length; j++)
      if (tiles[i][j][0] === 1) out.cells.push({ x: i, y: j, top: tiles[i][j][1], left: tiles[i][j][2] });
    return out; },
  /* ---- ② wpn 哨兵：逐字照抄 record_page.js:206-210 的三元组 ---- */
  wpnRows: function () {
    var d = __vtData(this.gc().getRoundState()) || {};
    var ws = (d.weaponStates || []), wout = [];
    for (var i = 0; i < Math.min(ws.length, 16); i++) {
      var w = ws[i], f = {};
      try { f = JSON.parse(w.fieldsJSON || '{}'); } catch (e) {}
      wout.push([w.playerId, w.type, f._numBullets, f._bulletsFired,
                 f._timeAlive == null ? null : +(+f._timeAlive).toFixed(4)]);
    }
    return wout; },
  wpnJSON: function () { return JSON.stringify(this.wpnRows()); },
  weaponDetail: function (id) {
    var d = __vtData(this.gc().getRoundState()) || {}; var ws = d.weaponStates || []; var o = [];
    for (var i = 0; i < ws.length; i++) if (!id || ws[i].playerId === id) {
      var f = {}; try { f = JSON.parse(ws[i].fieldsJSON || '{}'); } catch (e) {}
      o.push({ id: ws[i].id, owner: ws[i].playerId, type: ws[i].type, keys: Object.keys(f).sort(), fields: f });
    }
    return o; },
  injectWeapon: function (kind, id) {
    var gc = this.gc(); var ws = null; var C = Constants;
    if (kind === 'HOMING') ws = HomingMissileWeapon.createInitialWeaponState(IdGenerator.instance.gen('hmw'), id);
    else if (kind === 'LASER') ws = LaserWeapon.createInitialWeaponState(IdGenerator.instance.gen('lw'), id);
    else if (kind === 'MINE') ws = MineWeapon.createInitialWeaponState(IdGenerator.instance.gen('mw'), id, C.MINE_AMMO_COUNT);
    else if (kind === 'SHOTGUN') ws = ShotgunWeapon.createInitialWeaponState(IdGenerator.instance.gen('sw'), id, C.SHOTGUN_AMMO_COUNT);
    else if (kind === 'DOUBLE_BARREL') ws = DoubleBarrelWeapon.createInitialWeaponState(IdGenerator.instance.gen('dbw'), id, C.DOUBLE_BARREL_AMMO_COUNT);
    else if (kind === 'GATLING') ws = GatlingGunWeapon.createInitialWeaponState(IdGenerator.instance.gen('ggw'), id, C.GATLING_GUN_AMMO_COUNT);
    if (!ws) return { err: 'unknown kind ' + kind };
    gc.roundController.setWeaponState(ws);
    return { ok: true, id: ws.getId(), type: ws.getType() };
  },
  weaponTypes: function () { return JSON.parse(JSON.stringify(Constants.WEAPON_TYPES)); }
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
  return null;
}
const lanePose = (lane, idx) => lane.axis === 'x'
  ? { x: lane.cells[idx].x * TILE + TILE / 2, y: lane.cells[idx].y * TILE + TILE / 2, rot: Math.PI / 2 }
  : { x: lane.cells[idx].x * TILE + TILE / 2, y: lane.cells[idx].y * TILE + TILE / 2, rot: 0 };

(async () => {
  const out = { startedAt: new Date().toISOString(), A: {}, B: {} };
  let m;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    m = new Match();
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    await m.clearControl();
    await m.eval(HELPERS);
    out.weaponTypes = await m.eval('window.__i4x.weaponTypes()');

    /* ============ A. vx 实测 + 正打护盾反弹重测 ============ */
    try {
      await m.setControl({ fire: true }); await m.pump(3, { yieldMs: 0 }); await m.setControl({ fire: false });
      let seen = 0;
      for (let i = 0; i < 40; i++) { seen = await m.eval('window.__i4x.bulletsOk().length'); if (seen) break; await m.pump(1, { yieldMs: 0 }); }
      out.A.liveFrame = { n: seen,
        buggy: await m.eval('window.__i4x.bullets4c()'),
        fixed: await m.eval('window.__i4x.bulletsOk()') };
      out.A.vx恒null = (out.A.liveFrame.buggy || []).every((b) => b.vx === null) &&
                       (out.A.liveFrame.fixed || []).every((b) => typeof b.vx === 'number');

      const ti = await m.eval('window.__i4x.tileInfo()');
      const lane = findLane(ti, 5);
      out.A.lane = lane ? { axis: lane.axis, cells: lane.cells.map((c) => c.x + ',' + c.y) } : null;
      if (lane) {
        const near = lanePose(lane, lane.cells.length - 2), far = lanePose(lane, lane.cells.length - 1);
        out.A.pose = { shooter: far, target: near };
        await m.teleport('tank_b', near.x, near.y, near.rot);
        await m.pump(3, { yieldMs: 0 });
        out.A.crateId = await m.eval(`window.__i4x.spawnCrate(6, ${near.x}, ${near.y}, 0)`);
        for (let i = 0; i < 12; i++) { await m.pump(1, { yieldMs: 0 }); if ((await m.eval("window.__i4x.upgrades('tank_b')")).length) break; }
        out.A.shieldUpgrade = await m.eval("window.__i4x.upgrades('tank_b')");
        out.A.fixtures = await m.eval("window.__i4x.fixtures('tank_b')");
        const shield = (out.A.fixtures || []).find((f) => f.cat === 32);
        out.A.shieldR = shield ? shield.r : null;
        await m.teleport('tank_a', far.x, far.y, far.rot);
        await m.pump(3, { yieldMs: 0 });
        await m.setControl({ fire: true }); await m.pump(1, { yieldMs: 0 }); await m.setControl({ fire: false });
        const rows = []; let any = false;
        for (let i = 0; i <= 200; i++) {
          const bg = await m.eval('window.__i4x.bullets4c()');
          const ok = await m.eval('window.__i4x.bulletsOk()');
          const tb = await m.eval("(()=>{var t=window.__i4x.gc().getTank('tank_b');return t?{x:t.getX(),y:t.getY()}:null})()");
          rows.push({ f: i, bg: bg, ok: ok, tb: tb });
          if (bg.length) any = true; else if (any) break;
          await m.pump(1, { yieldMs: 0 });
        }
        const used = rows.filter((r) => r.bg.length);
        let flipBuggy = -1, flipFixed = -1;
        for (let i = 1; i < used.length; i++) {
          const dvg = Math.hypot(used[i].bg[0].vx - used[i - 1].bg[0].vx, used[i].bg[0].vy - used[i - 1].bg[0].vy);
          const dvf = Math.hypot(used[i].ok[0].vx - used[i - 1].ok[0].vx, used[i].ok[0].vy - used[i - 1].ok[0].vy);
          if (flipBuggy < 0 && dvg > 1e-6) flipBuggy = i;
          if (flipFixed < 0 && dvf > 1e-6) flipFixed = i;
        }
        const minDist = used.length && used[0].tb
          ? +Math.min(...used.map((r) => Math.hypot(r.ok[0].x - r.tb.x, r.ok[0].y - r.tb.y))).toFixed(3) : null;
        const tail = used.slice(-3).map((r) => ({ f: r.f, x: r.ok[0].x, y: r.ok[0].y, vx: r.ok[0].vx, vy: r.ok[0].vy, bg_vx: r.bg[0].vx }));
        out.A.headOn = {
          bulletsSeen: used.length, flipBuggy: flipBuggy, flipFixed: flipFixed,
          minDistToTargetCenter: minDist,
          firstRow_ok: used.length ? used[0].ok[0] : null,
          lastRow_ok: used.length ? used[used.length - 1].ok[0] : null,
          head: used.slice(0, 4).map((r) => ({ f: r.f, x: r.ok[0].x, vx: r.ok[0].vx, bg_vx: r.bg[0].vx })),
          tail: tail
        };
      }
    } catch (e) { out.A.err = String((e && e.stack) || e); }

    /* ============ B. wpn 哨兵实测 ============ */
    const snapshot = async (tag) => ({
      tag: tag,
      wpn: await m.eval('window.__i4x.wpnRows()'),
      wpnJSON: await m.eval('window.__i4x.wpnJSON()'),
      detail: await m.eval('window.__i4x.weaponDetail()')
    });
    try {
      out.B.steps = [];
      out.B.steps.push(await snapshot('开局默认(BULLET)'));
      for (const kind of ['HOMING', 'LASER', 'MINE', 'SHOTGUN', 'GATLING']) {
        out.B['inject_' + kind] = await m.eval(`window.__i4x.injectWeapon(${JSON.stringify(kind)}, 'tank_a')`);
        await m.pump(1, { yieldMs: 0 });
        out.B.steps.push(await snapshot('注入 ' + kind + ' 后'));
      }
      out.B['inject_HOMING2'] = await m.eval("window.__i4x.injectWeapon('HOMING','tank_a')");
      await m.pump(1, { yieldMs: 0 });
      const beforeFire = await snapshot('发射前(HOMING)');
      await m.setControl({ fire: true }); await m.pump(3, { yieldMs: 0 }); await m.setControl({ fire: false });
      await m.pump(2, { yieldMs: 0 });
      const afterFire = await snapshot('发射后(HOMING)');
      out.B.fired = {
        wpnJSON_before: beforeFire.wpnJSON, wpnJSON_after: afterFire.wpnJSON,
        wpnChanged: beforeFire.wpnJSON !== afterFire.wpnJSON,
        tankA_fields_after: (afterFire.detail || []).filter((w) => w.owner === 'tank_a'),
        projN: await m.eval('window.__i4x.bulletsOk().length')
      };
      out.B.pageErr = m.pageErrors.slice(0, 3);
    } catch (e) { out.B.err = String((e && e.stack) || e); }
  } catch (e) {
    out.err = String((e && e.stack) || e);
    try { out.pageErrors = m.pageErrors.slice(0, 5); } catch (e2) {}
  } finally {
    try { fs.writeFileSync(path.join(OUT, '_i4x_vx_wpn_check.json'), JSON.stringify(out, null, 2)); } catch (e) {}
    try { await m.close(); } catch (e) {}
  }
  console.log(JSON.stringify(out, null, 2));
})();
