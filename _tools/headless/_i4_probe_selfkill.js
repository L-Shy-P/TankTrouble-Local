'use strict';
/* _i4_ 探针：①-c 出膛点几何怪相的【影响面】
 *   A) 顶墙开火 4 方向（正例）+ 同格背对墙开火 4 组（反例）→ 自杀率
 *   B) 真对局（1 人 + 2 AI，实际只加到 1 个 AI）长跑 → killer==victim 发生率
 * 只读产品代码，产物 _tools/headless/_i4_prof/_i4_selfkill.json
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Match } = require('./match');
const PROF = path.join(__dirname, '_i4_prof');
const FILES = ['game_core/js/b714588dc4621fe104113111ba90b1a7.js', 'game_core/js/82e43ebfcdffdaf490dbe79c9c119d29.js',
  'game_core/js/46989e393ad0e356ac8a0c6c53b362f9.js', 'game_core/js/vantage_sandbox.js', '_tools/headless/match.js'];
const T0 = Date.now();
const rep = { startedAt: new Date().toISOString(), fingerprints: FILES.map((r) => { const p = path.join(__dirname, '..', '..', r);
  try { const st = fs.statSync(p); return { file: r, mtime: st.mtime.toISOString(), bytes: st.size, md5: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') }; }
  catch (e) { return { file: r, err: String(e) }; } }) };
const P = (...a) => console.log(...a);
const TILE = 10;

const H = `
window.__sk = {
  gc: function(){ return GameManager.getGameController(); },
  r4: function(x){ return Math.round(x*10000)/10000; },
  grids: function(){ var mz=this.gc().getMaze(); var tb=mz.getTileBounds(); var t=mz.getTiles(); var cells=[];
    for(var i=0;i<t.length;i++)for(var j=0;j<t[i].length;j++)if(t[i][j][0]===1)cells.push({x:i,y:j,top:t[i][j][1],left:t[i][j][2]});
    return { bounds:tb, TILE:Constants.MAZE_TILE_SIZE.m, WALL:Constants.MAZE_WALL_WIDTH.m, cells:cells }; },
  tank: function(id){ var t=this.gc().getTank(id); return t?{x:this.r4(t.getX()),y:this.r4(t.getY()),rot:this.r4(t.getRotation())}:null; },
  projs: function(owner){ var d=__vtData(this.gc().getRoundState())||{};
    return (d.projectileStates||[]).filter(function(p){return !owner||p.playerId===owner;}).map(function(p){return {x:this.r4(p.x),y:this.r4(p.y),vx:this.r4(p.speedX),vy:this.r4(p.speedY)};},this); },
  fixtures: function(id){ var t=this.gc().getTank(id); if(!t) return null; var b=t.getB2DBody(); var out=[];
    for(var f=b.GetFixtureList(); f!==null; f=f.GetNext()){ var ud=f.GetUserData()||{}; var sh=f.GetShape();
      var o={ut:(ud.type===undefined?null:ud.type),v:null}; if(sh.m_vertexCount!==undefined){ o.v=[]; for(var i=0;i<sh.m_vertexCount;i++){ var w=b.GetWorldPoint(sh.m_vertices[i]); o.v.push([this.r4(w.x),this.r4(w.y)]); } } out.push(o); }
    return out; },
  clearBullets: function(){ var gc=this.gc(), n=0; var ps=gc.getProjectiles(); for(var k in ps){ try{gc.destroyProjectile(k);n++;}catch(e){} } return n; },
  deaths: function(){ try{ var AD=window.__ad; return AD?{n:AD.getDeathsCount(),list:AD.getDeaths(),status:AD.getDeathHookStatus()}:{err:'no ad'}; }catch(e){ return {err:String(e)}; } }
};`;


/** 保证在 IN_ROUND 且 3 辆坦克都在（顶墙自杀死掉一辆后要重开一回合）*/
async function ensureRound(m) {
  const st = await m.eval(`(() => { var gc=GameManager.getGameController();
    return { state: gc.getState(), tanks: Object.keys(gc.getTanks()) }; })()`);
  if (st.tanks.indexOf('tank_a') >= 0 && st.tanks.length >= 3 && String(st.state).indexOf('in round') >= 0) return { ok: true, state: st };
  try { await m.endRound(false); } catch (e) {}
  for (let i = 0; i < 120; i++) {
    await m.pump(30);
    const s2 = await m.eval(`(() => { var gc=GameManager.getGameController();
      return { state: gc.getState(), tanks: Object.keys(gc.getTanks()) }; })()`);
    if (s2.tanks.indexOf('tank_a') >= 0 && s2.tanks.length >= 3 && String(s2.state).indexOf('in round') >= 0) return { ok: true, frames: (i + 1) * 30, state: s2 };
  }
  return { ok: false };
}

async function pressedShot(m, dir, on) {
  // dir: {name, rot, edge:'x+'|'x-'|'y+'|'y-'}
  const setup = await m.eval(`(() => {
    var g=window.__sk.grids(); var tb=g.bounds;
    var pick=null;
    for(var i=0;i<g.cells.length;i++){ var c=g.cells[i];
      if(${JSON.stringify(dir.edge)}==='x+' && c.x===tb.maxX){ pick=c; break; }
      if(${JSON.stringify(dir.edge)}==='x-' && c.x===tb.minX){ pick=c; break; }
      if(${JSON.stringify(dir.edge)}==='y+' && c.y===tb.maxY){ pick=c; break; }
      if(${JSON.stringify(dir.edge)}==='y-' && c.y===tb.minY){ pick=c; break; } }
    if(!pick) return {err:'no edge cell'};
    var cx=pick.x*g.TILE+g.TILE/2, cy=pick.y*g.TILE+g.TILE/2;
    var gc=window.__sk.gc();
    gc.setTankState(TankState.withState('tank_a', cx, cy, false,false,${on}?${JSON.stringify(dir.rot)}:${JSON.stringify(dir.rotBack)}, false,false,false,false), false);
    return { pick:pick, cx:cx, cy:cy, TILE:g.TILE, WALL:g.WALL, bounds:tb,
             wallFace: ${JSON.stringify(dir.edge)}==='x+' ? ((tb.maxX+1)*g.TILE - g.WALL/2) :
                       ${JSON.stringify(dir.edge)}==='x-' ? (tb.minX*g.TILE + g.WALL/2) :
                       ${JSON.stringify(dir.edge)}==='y+' ? ((tb.maxY+1)*g.TILE - g.WALL/2) : (tb.minY*g.TILE + g.WALL/2),
             axis: (${JSON.stringify(dir.edge)}==='x+'||${JSON.stringify(dir.edge)}==='x-') ? 'x' : 'y' };
  })()`);
  if (setup.err) return { err: setup.err };
  await m.pump(3);
  let still = 0, last = null;
  for (let i = 0; on && i < 70; i++) {          // ★ 反例不驱动（只原地开火），否则会撞到别的墙
    await m.setControl({ fwd: true });
    await m.pump(1);
    const t = await m.eval("window.__sk.tank('tank_a')");
    if (last && Math.hypot(t.x - last.x, t.y - last.y) < 0.01) { if (++still >= 3) break; } else still = 0;
    last = t;
  }
  await m.clearControl();
  await m.pump(3);
  const pressed = await m.eval("window.__sk.tank('tank_a')");
  const fx = await m.eval("window.__sk.fixtures('tank_a')");
  const turret = (fx || []).find((f) => f.ut === 'turret');
  let muzzleGeom = null;
  if (pressed) {
    const c = (setup.axis === 'x') ? pressed.x : pressed.y;
    const centerToWall = Math.abs(c - setup.wallFace);
    muzzleGeom = { centerToWall: +centerToWall.toFixed(3), muzzleOffset: 2.5, bulletR: 0.25,
      muzzleLead: +(2.5 + 0.25).toFixed(3), leadInsideWall: +(2.5 + 0.25 - centerToWall).toFixed(3),
      turretTip: 2.7, tipInsideWall: +(2.7 - centerToWall).toFixed(3) };
  }
  await m.setControl({ fire: true });
  await m.pump(1);
  try { await m.setControl({ fire: false }); } catch (eFire) { /* 开火那一帧就把自己打死了 ⟹ 释放失败是预期的 */ }
  let deadAt = -1; const trace = [];
  for (let i = 0; i <= 70; i++) {
    const t = await m.eval("window.__sk.tank('tank_a')");
    const pr = await m.eval("window.__sk.projs('tank_a')");
    trace.push({ f: i, alive: !!t, n: pr.length, p: pr[0] || null });
    if (!t) { deadAt = i; break; }
    if (i > 3 && pr.length === 0) break;
    await m.pump(1);
  }
  await m.eval('window.__sk.clearBullets()');
  return { edge: dir.edge, on: on, setup: setup, pressed: pressed, turret: turret, muzzleGeom: muzzleGeom, deadAt: deadAt,
           traceN: trace.length, trace: trace.slice(0, 14) };
}

(async () => {
  let m;
  try {
    m = new Match();
    await m.open({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
    await m.clearControl(); await m.eval(H);
    const dirs = [
      { name: 'x+', edge: 'x+', rot: Math.PI / 2, rotBack: -Math.PI / 2 },
      { name: 'x-', edge: 'x-', rot: -Math.PI / 2, rotBack: Math.PI / 2 },
      { name: 'y+', edge: 'y+', rot: Math.PI, rotBack: 0 },
      { name: 'y-', edge: 'y-', rot: 0, rotBack: Math.PI },
    ];
    rep.wall = {};
    for (const d of dirs) {
      rep.wall[d.name + '_roundWait'] = await ensureRound(m);
      rep.wall[d.name + '_pressedFire'] = await pressedShot(m, d, true);
      await m.eval(`window.__sk.gc().setTankState(TankState.withState('tank_a', 25, 25, false,false,0,false,false,false,false), false)`).catch(() => {});
      const r = rep.wall[d.name + '_pressedFire'];
      P('A[' + d.name + '] 顶墙开火: 死亡帧=' + r.deadAt + ' 顶墙后位姿=' + JSON.stringify(r.pressed) +
        ' 墙内沿=' + r.setup.wallFace + ' 坦克中心到墙=' + (r.pressed ? Math.abs((d.edge[0] === 'x' ? r.pressed.x : r.pressed.y) - r.setup.wallFace).toFixed(3) : '-') +
        ' 弹道=' + JSON.stringify((r.trace || []).filter((x) => x.p).map((x) => 'f' + x.f + '(' + x.p.x + ',' + x.p.y + ')')));
      await m.pump(5);
    }
    rep.wallControl = {};
    for (const d of dirs) {
      rep.wallControl[d.name + '_roundWait'] = await ensureRound(m);
      rep.wallControl[d.name + '_awayFire'] = await pressedShot(m, d, false);
      const r = rep.wallControl[d.name + '_awayFire'];
      P('A[' + d.name + '] 反例(背对墙开火): 死亡帧=' + r.deadAt + ' 位姿=' + JSON.stringify(r.pressed));
      await m.pump(5);
    }
    rep.pageErrorsWall = m.pageErrors.slice(0, 4);
    await m.close(); m = null;

    /* B) 长跑统计 */
    if (process.env.I4_SKIP_B === '1') { P('B 跳过（I4_SKIP_B=1）'); rep.pageErrorsAI = []; return; }
    const m2 = new Match();
    await m2.open({ humanIds: ['tank_a'], aiCount: 2, vantCount: 0 });
    await m2.clearControl();
    await m2.eval(H);
    await m2.eval('window.__ad = VantageSandbox.createAdapter(GameManager.getGameController(), "i4_sk")');
    const B = rep.aiRun = { frames: 0 };
    const acc = new Map();
    function absorb(d) { if (!d || !d.list) return; for (const r of d.list) { const k = [r.victimPlayerId, r.tWallMs, r.seq, r.src].join('|'); if (!acc.has(k)) acc.set(k, r); } }
    B.tanks0 = await m2.eval('Object.keys(GameManager.getGameController().getTanks())');
    for (let k = 0; k < 700; k++) {
      await m2.pump(30); B.frames += 30;
      if (k % 10 === 0) {
        const d = await m2.eval('window.__sk.deaths()'); absorb(d);
        if (k % 100 === 0) P('   B frames=' + B.frames + ' 累积死亡=' + acc.size + ' 本回合=' + (d && d.n));
        if (acc.size >= 30 || (Date.now() - T0) > 150000) break;
      }
    }
    absorb(await m2.eval('window.__sk.deaths()'));
    B.list = Array.from(acc.values()).map((r) => ({ victim: r.victimPlayerId, killer: r.killerPlayerId, src: r.src, cause: r.cause, exp: r.experience, deadlyType: r.deadlyType, x: r.x, y: r.y }));
    const kills = B.list.filter((r) => r.killer !== null && r.killer !== undefined);
    const self = kills.filter((r) => r.killer === r.victim);
    B.summary = { frames: B.frames, deaths: B.list.length, killEvents: kills.length, selfKills: self.length,
      selfRate: kills.length ? +(self.length / kills.length).toFixed(3) : null,
      byCause: B.list.reduce((a, r) => { a[r.cause] = (a[r.cause] || 0) + 1; return a; }, {}) };
    P('B 结果=' + JSON.stringify(B.summary));
    rep.pageErrorsAI = m2.pageErrors.slice(0, 4);
    await m2.close();
  } catch (e) { rep.err = String((e && e.stack) || e); P('X: ' + rep.err); }
  finally {
    try { if (m) await m.close(); } catch (e) {}
    try { fs.writeFileSync(path.join(PROF, '_i4_selfkill.json'), JSON.stringify(rep, null, 1)); } catch (e) {}
    P('[done] ' + ((Date.now() - T0) / 1000).toFixed(1) + 's');
  }
})();
