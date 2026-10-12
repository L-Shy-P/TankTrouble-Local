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
