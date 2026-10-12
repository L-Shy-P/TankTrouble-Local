'use strict';
/* _i4_ 探针 v5（小）：① 自己打出的弹会不会被自己的护盾弹回（穿过去？）
 *                 ② 护盾自然到期 → 夹具消失（形状恢复）
 * 只读 game_core/，只写 _tools/headless/_i4_prof/
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Match } = require('./match');
const TILE = 10, DT = 1 / 60;
const PROF = path.join(__dirname, '_i4_prof');
const FILES = ['game_core/js/7b2ed8ad3598d7321f8f3d2b04b1eac8.js', 'game_core/js/46989e393ad0e356ac8a0c6c53b362f9.js',
  'game_core/js/418577fd210ad079ea3d1e5e04050fe0.js', 'game_core/js/b714588dc4621fe104113111ba90b1a7.js',
  'game_core/js/vantage_sandbox.js', '_tools/headless/match.js'];
function fp() { const o = []; for (const r of FILES) { const p = path.join(__dirname, '..', '..', r);
  try { const st = fs.statSync(p); o.push({ file: r, mtime: st.mtime.toISOString(), bytes: st.size, md5: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') }); }
  catch (e) { o.push({ file: r, err: String(e.message || e) }); } } return o; }
const T0 = Date.now(); const report = { startedAt: new Date().toISOString(), fingerprints: fp() };
const P = (...a) => console.log(...a);
const H = `
window.__v5 = {
  gc: function(){ return GameManager.getGameController(); },
  rc: function(){ return GameManager.getGameController().roundController; },
  tank: function(id){ var t=this.gc().getTank(id); return t?{x:+t.getX().toFixed(3),y:+t.getY().toFixed(3),rot:+t.getRotation().toFixed(4)}:null; },
  fixtures: function(id){ var t=this.gc().getTank(id); if(!t) return null; var b=t.getB2DBody(); var out=[];
    for(var f=b.GetFixtureList(); f!==null; f=f.GetNext()){ var ud=f.GetUserData()||{}; var fd=f.GetFilterData(); var sh=f.GetShape();
      out.push({ut:ud.type===undefined?null:ud.type, cat:fd.categoryBits, mask:fd.maskBits, st:sh.m_type, r:sh.m_radius!==undefined?+sh.m_radius.toFixed(4):null}); }
    return out; },
  upgrades: function(id){ var d=__vtData(this.gc().getRoundState())||{}; var us=d.upgradeStates||[]; var o=[];
    for(var i=0;i<us.length;i++) if(us[i].playerId===id){ var f={}; try{f=JSON.parse(us[i].fieldsJSON||'{}');}catch(e){} o.push({type:us[i].type, life:+(f._lifetime||0).toFixed(3)}); } return o; },
  bullets: function(owner){ var d=__vtData(this.gc().getRoundState())||{}; var o=[];
    for(var i=0;i<(d.projectileStates||[]).length;i++){ var p=d.projectileStates[i]; if(owner&&p.playerId!==owner) continue;
      o.push({id:p.id,o:p.playerId,x:+p.x.toFixed(3),y:+p.y.toFixed(3),vx:+p.speedX.toFixed(3),vy:+p.speedY.toFixed(3)}); } return o; },
  spawnCrate: function(type,x,y){ var st=CollectibleState.withState(IdGenerator.instance.gen('c'),type,x,y,0); this.rc().setCollectibleState(st); return st.getId(); }
};`;
function findLane(ti, minLen) {
  const rows = {}, cols = {};
  for (const c of ti.cells) { (rows[c.y] = rows[c.y] || []).push(c); (cols[c.x] = cols[c.x] || []).push(c); }
  function scan(map, horiz) { let best = null;
    for (const k of Object.keys(map)) { const line = map[k].slice().sort((a, b) => (horiz ? a.x - b.x : a.y - b.y));
      let run = [line[0]];
      for (let i = 1; i < line.length; i++) { const p = line[i - 1], c = line[i];
        const adj = horiz ? (c.x === p.x + 1 && c.left === 0) : (c.y === p.y + 1 && c.top === 0);
        if (adj) run.push(c); else { if (!best || run.length > best.length) best = run; run = [c]; } }
      if (!best || run.length > best.length) best = run; } return best; }
  const h = scan(rows, true), v = scan(cols, false);
  if (h && h.length >= minLen) return { axis: 'x', cells: h.slice(0, minLen) };
  if (v && v.length >= minLen) return { axis: 'y', cells: v.slice(0, minLen) };
  if (h && h.length >= 3) return { axis: 'x', cells: h.slice(0, 3) };
  if (v && v.length >= 3) return { axis: 'y', cells: v.slice(0, 3) };
  return null;
}
(async () => {
  let m;
  try {
    fs.mkdirSync(PROF, { recursive: true });
    m = new Match();
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    await m.clearControl(); await m.eval(H);
    const ti = await m.eval(`(() => { var mz = GameManager.getGameController().getMaze(); var tb = mz.getTileBounds(); var tiles = mz.getTiles();
      var out = { cells: [], bounds: tb, TILE: Constants.MAZE_TILE_SIZE.m };
      for (var i = 0; i < tiles.length; i++) for (var j = 0; j < tiles[i].length; j++) if (tiles[i][j][0] === 1) out.cells.push({x:i,y:j,top:tiles[i][j][1],left:tiles[i][j][2]});
      return out; })()`);
    const lane = findLane(ti, 4);
    report.lane = { axis: lane.axis, cells: lane.cells.map((c) => c.x + ',' + c.y) };
    const c0 = lane.cells[0], c1 = lane.cells[lane.cells.length - 1];
    const ax = lane.axis === 'x' ? c0.x * TILE + 5 : c0.x * TILE + 5;
    const ay = lane.axis === 'x' ? c0.y * TILE + 5 : c0.y * TILE + 5;
    const rot = lane.axis === 'x' ? Math.PI / 2 : Math.PI;   // 朝 +x / +y
    await m.teleport('tank_a', ax, ay, rot); await m.pump(3);
    await m.eval(`window.__v5.spawnCrate(6, ${ax}, ${ay})`);
    for (let i = 0; i < 10; i++) { await m.pump(1); if ((await m.eval("window.__v5.upgrades('tank_a')")).length) break; }
    report.fxWithShield = await m.eval("window.__v5.fixtures('tank_a')");
    report.up0 = await m.eval("window.__v5.upgrades('tank_a')");
    P('v5 拿盾后夹具=' + JSON.stringify(report.fxWithShield) + ' 升级=' + JSON.stringify(report.up0));
    // 自己开一炮：看弹能不能飞出 4.3m（若被自己护盾弹回，dist 不会超过 ~4.3）
    await m.setControl({ fire: true }); await m.pump(1); await m.setControl({ fire: false });
    const rows = [];
    for (let i = 0; i < 40; i++) {
      const b = (await m.eval("window.__v5.bullets('tank_a')"))[0];
      const t = await m.eval("window.__v5.tank('tank_a')");
      rows.push(b ? { f: i, d: +Math.hypot(b.x - t.x, b.y - t.y).toFixed(3), vx: b.vx, vy: b.vy } : { f: i, gone: true });
      if (!b) break;
      await m.pump(1);
    }
    report.ownBullet = rows;
    P('v5 自己打出的弹（到自己中心的距离）: ' + JSON.stringify(rows.map((r) => r.gone ? 'GONE' : (r.d + '|v' + r.vx + ',' + r.vy))));
    // 到期
    let expFrame = -1;
    for (let i = 0; i < 500; i++) { if (!(await m.eval("window.__v5.upgrades('tank_a')")).length) { expFrame = i; break; } await m.pump(1); }
    report.expiredAtFrame = expFrame;
    report.fxAfterExpiry = await m.eval("window.__v5.fixtures('tank_a')");
    P('v5 到期帧=' + expFrame + ' 到期后夹具=' + JSON.stringify(report.fxAfterExpiry));
    report.pageErrors = m.pageErrors.slice(0, 5);
  } catch (e) { report.err = String((e && e.stack) || e); P('X: ' + report.err); }
  finally {
    try { await m.close(); } catch (e) {}
    try { fs.writeFileSync(path.join(PROF, '_i4_probe_spec_1_4e.json'), JSON.stringify(report, null, 1)); } catch (e) {}
    P('[done] ' + ((Date.now() - T0) / 1000).toFixed(1) + 's');
  }
})();
