'use strict';
/* _i4_ 探针 v6：拾取判定到底用坦克哪个 fixture？
 *   正例：箱子只压住【炮管】(不含 base) → 应被捡
 *   反例：箱子谁都压不到（炮管前方 1.1m 外）→ 不应被捡
 * 只读 game_core/，只写 _tools/headless/_i4_prof/
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Match } = require('./match');
const TILE = 10;
const PROF = path.join(__dirname, '_i4_prof');
const FILES = ['game_core/js/b714588dc4621fe104113111ba90b1a7.js', 'game_core/js/46989e393ad0e356ac8a0c6c53b362f9.js',
  'game_core/js/82e43ebfcdffdaf490dbe79c9c119d29.js', 'game_core/js/vantage_sandbox.js', '_tools/headless/match.js'];
function fp() { const o = []; for (const r of FILES) { const p = path.join(__dirname, '..', '..', r);
  try { const st = fs.statSync(p); o.push({ file: r, mtime: st.mtime.toISOString(), bytes: st.size, md5: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') }); }
  catch (e) { o.push({ file: r, err: String(e.message || e) }); } } return o; }
const T0 = Date.now(); const report = { startedAt: new Date().toISOString(), fingerprints: fp() };
const P = (...a) => console.log(...a);
const H = `
window.__v6 = {
  gc: function(){ return GameManager.getGameController(); },
  rc: function(){ return GameManager.getGameController().roundController; },
  fixtures: function(id){ var t=this.gc().getTank(id); if(!t) return null; var b=t.getB2DBody(); var out=[];
    for(var f=b.GetFixtureList(); f!==null; f=f.GetNext()){ var ud=f.GetUserData()||{}; var sh=f.GetShape(); var o={ut:ud.type===undefined?null:ud.type, v:null, r:sh.m_radius!==undefined?+sh.m_radius.toFixed(4):null};
      if(sh.m_vertexCount!==undefined){ o.v=[]; for(var i=0;i<sh.m_vertexCount;i++){ var w=b.GetWorldPoint(sh.m_vertices[i]); o.v.push([+w.x.toFixed(3),+w.y.toFixed(3)]); } } out.push(o); }
    return out; },
  collectibles: function(){ var d=__vtData(this.gc().getRoundState())||{};
    return (d.collectibleStates||[]).map(function(c){ return {id:c.id,type:c.type,x:+c.x.toFixed(3),y:+c.y.toFixed(3)}; }); },
  weapons: function(id){ var d=__vtData(this.gc().getRoundState())||{};
    return (d.weaponStates||[]).filter(function(w){return w.playerId===id;}).map(function(w){ return {type:w.type,id:w.id}; }); },
  spawnCrate: function(type,x,y){ var st=CollectibleState.withState(IdGenerator.instance.gen('c'),type,x,y,0); this.rc().setCollectibleState(st); return st.getId(); }
};`;
(async () => {
  let m;
  try {
    fs.mkdirSync(PROF, { recursive: true });
    m = new Match();
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    await m.clearControl(); await m.eval(H);
    // 挑一个开阔格：用 maze 的 cells 里 y 最大的行里 x 居中的格（保证下方有空间）
    const ti = await m.eval(`(() => { var mz=GameManager.getGameController().getMaze(); var tb=mz.getTileBounds(); var tiles=mz.getTiles(); var out={cells:[],bounds:tb};
      for (var i=0;i<tiles.length;i++) for (var j=0;j<tiles[i].length;j++) if (tiles[i][j][0]===1) out.cells.push({x:i,y:j,top:tiles[i][j][1],left:tiles[i][j][2]}); return out; })()`);
    const mid = Math.round((ti.bounds.minY + ti.bounds.maxY) / 2);
    let cell = ti.cells.find((c) => c.y === mid && c.x === Math.round((ti.bounds.minX + ti.bounds.maxX) / 2));
    if (!cell) cell = ti.cells[Math.floor(ti.cells.length / 2)];
    report.cell = cell;
    const tx = cell.x * TILE + 5, ty = cell.y * TILE + 5;
    report.tankPos = { tx, ty };
    await m.teleport('tank_a', tx, ty, 0);   // rot=0 → 炮管朝 -y
    await m.pump(4);
    report.fx = await m.eval("window.__v6.fixtures('tank_a')");
    P('v6 tank_a 夹具=' + JSON.stringify(report.fx));
    const turret = (report.fx || []).find((f) => f.ut === 'turret');
    const base = (report.fx || []).find((f) => f.ut === 'base');
    report.turretY = turret ? [Math.min(...turret.v.map((v) => v[1])), Math.max(...turret.v.map((v) => v[1]))] : null;
    report.baseY = base ? [Math.min(...base.v.map((v) => v[1])), Math.max(...base.v.map((v) => v[1]))] : null;
    P('v6 turret y=' + JSON.stringify(report.turretY) + ' base y=' + JSON.stringify(report.baseY));
    report.cases = {};
    // 正例：箱子只压炮管（箱子半宽 1.6；中心放 y = ty-3.7 → 覆盖 [ty-5.3, ty-2.1]，只与炮管[ty-2.7,ty-1.3]相交）
    // 反例：中心放 y = ty-6.0 → 覆盖 [ty-7.6, ty-4.4]，炮管最远 ty-2.7 → 差 1.7 > 0 ✓
    for (const spec of [['turretOnly', ty - 3.7, 'expectPickup'], ['nothing', ty - 6.0, 'expectNoPickup']]) {
      const tag = spec[0], cy = spec[1];
      const before = await m.eval("window.__v6.collectibles()");
      const id = await m.eval(`window.__v6.spawnCrate(2, ${tx}, ${cy})`);
      await m.pump(6);
      const after = await m.eval("window.__v6.collectibles()");
      const w = await m.eval("window.__v6.weapons('tank_a')");
      report.cases[tag] = { crateY: cy, crateId: id, expect: spec[2],
        crateGone: !after.some((c) => c.id === id), weapons: w, cratesBefore: before.length, cratesAfter: after.length,
        droppedY: (after.find((c) => c.id === id) || {}).y || null };
      P('v6 [' + tag + '] crateY=' + cy + ' (' + spec[2] + ') crateGone=' + report.cases[tag].crateGone +
        ' weapons=' + JSON.stringify(w.map((x) => x.type)) + ' crateYNow=' + report.cases[tag].droppedY);
      if (tag === 'turretOnly') { await m.eval('window.__v6.gc().destroyCollectible({getCollectibleId:function(){return ' + JSON.stringify(id) + ';},getPlayerId:function(){return "nobody";}})'); }
    }
    report.pageErrors = m.pageErrors.slice(0, 5);
  } catch (e) { report.err = String((e && e.stack) || e); P('X: ' + report.err); }
  finally {
    try { await m.close(); } catch (e) {}
    try { fs.writeFileSync(path.join(PROF, '_i4_probe_spec_1_4f.json'), JSON.stringify(report, null, 1)); } catch (e) {}
    P('[done] ' + ((Date.now() - T0) / 1000).toFixed(1) + 's');
  }
})();
