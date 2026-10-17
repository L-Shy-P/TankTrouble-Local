'use strict';
/* ============================================================================
 * _i4_ 探针：② STORM（毒雾）分支【端到端】实测
 *
 * 要回答：
 *   1) 按 2-2 给的方法能不能真的跑通 STORM 分支（并且它的"一行"要不要补 `_expansionSide = -1`）
 *   2) TANK_DESTROYED 采集路径对毒雾是否也生效、位置拿不拿得到
 *   3) 这次是用什么方式造的毒雾（能不能当未来验收口径）
 *
 * 做法（只读产品代码）：
 *   · 毒雾 = `gc.roundController.setZoneState(StormZone.createInitialZoneState(id, maze.getStormExpansionSequence(), maze.getTileBounds()))`
 *     —— 与 ClassicGameMode.update 里那一行**同一个函数**（只是调用者换成我们）
 *   · 用真采集器（VantageSandbox.createAdapter → getDeaths）读死亡记录
 *   · 另外自己挂一个【裸】round 监听器，把 TANK_ZONE_COLLISION / TANK_DESTROYED 的原始载荷存下来
 *
 * 用法：node _tools/headless/_i4_probe_storm_e2e.js
 * 产物：_tools/headless/_i4_prof/_i4_storm_e2e.json
 * ============================================================================ */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Match } = require('./match');
const PROF = path.join(__dirname, '_i4_prof');
const FILES = [
  'game_core/js/54518faa8d672020d7af8ed7c353bc1b.js',
  'game_core/js/7b2ed8ad3598d7321f8f3d2b04b1eac8.js',
  'game_core/js/46989e393ad0e356ac8a0c6c53b362f9.js',
  'game_core/js/82e43ebfcdffdaf490dbe79c9c119d29.js',
  'game_core/js/b714588dc4621fe104113111ba90b1a7.js',
  'game_core/js/local_patch.js',
  'game_core/js/vantage_sandbox.js',
  'game_core/js/vantage_tree.js',
  '_tools/headless/match.js',
];
function fp() {
  const o = [];
  for (const r of FILES) { const p = path.join(__dirname, '..', '..', r);
    try { const st = fs.statSync(p); o.push({ file: r, mtime: st.mtime.toISOString(), bytes: st.size,
      md5: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') }); }
    catch (e) { o.push({ file: r, err: String(e.message || e) }); } }
  return o;
}
const T0 = Date.now();
const report = { startedAt: new Date().toISOString(), fingerprints: fp() };
const P = (...a) => console.log(...a);

const H = `
window.__st = {
  gc: function(){ return GameManager.getGameController(); },
  r4: function(x){ return (x===null||x===undefined)?null:Math.round(x*10000)/10000; },
  /** 裸 round 监听器：把 4 条相关事件的原始载荷存到 window.__raw */
  installRaw: function(){
    var gc=this.gc();
    window.__raw=[];
    if(window.__rawSub) return 'already';
    var r4=function(x){ return Math.round(x*10000)/10000; };
    var cb=function(self,gameId,evt,data){
      var E=RoundModel._EVENTS;
      if(evt!==E.TANK_ZONE_COLLISION && evt!==E.TANK_DESTROYED && evt!==E.TANK_KILLED && evt!==E.TANK_DEADLY_COLLISION) return;
      var rec={evt:evt,t:window.__vt?window.__vt.t:null};
      try{
        if(evt===E.TANK_ZONE_COLLISION){
          rec.zoneType=data.zone?data.zone.getType():null;
          rec.isPhysical=data.zone&&data.zone.isPhysical?data.zone.isPhysical():null;
          rec.tankPid=data.tankA?data.tankA.getPlayerId():null;
          if(data.collisionPoint) rec.pt=[r4(data.collisionPoint.x),r4(data.collisionPoint.y)];
          if(data.collisionNormal) rec.n=[r4(data.collisionNormal.x),r4(data.collisionNormal.y)];
        } else if(evt===E.TANK_DESTROYED){
          rec.pid=(typeof data==='string')?data:String(data);
        } else if(evt===E.TANK_KILLED){
          rec.victim=data.getVictimPlayerId(); rec.killer=data.getKillerPlayerId();
          rec.exp=data.getExperience(); rec.deadlyType=data.getDeadlyType();
        } else {
          rec.tankPid=data.tankA?data.tankA.getPlayerId():null;
          rec.projOwner=data.projectile?data.projectile.getPlayerId():null;
        }
      }catch(e){ rec.err=String(e); }
      window.__raw.push(rec);
    };
    gc.addRoundEventListener(cb, null);   // ★ 签名 = (ctx, gameId, evt, data)
    window.__rawSub=true;
    return 'installed';
  },
  raw: function(){ return window.__raw; },
  deaths: function(){ try{ var AD=window.__ad; if(!AD) return {err:'no adapter'};
      return { n:AD.getDeathsCount(), list:AD.getDeaths(), status:AD.getDeathHookStatus() }; }catch(e){ return {err:String(e)}; } },
  lastRound: function(){ try{ return window.__ad.getLastRoundDeaths(); }catch(e){ return {err:String(e)}; } },
  /** 造毒雾：与 ClassicGameMode.update 同一句 setZoneState */
  makeStorm: function(id){
    var gc=this.gc(); var maze=gc.getMaze();
    gc.roundController.setZoneState(StormZone.createInitialZoneState(id, maze.getStormExpansionSequence(), maze.getTileBounds()));
    var z=gc.getZones()[id];
    return z ? { ok:true, type:z.getType(), isPhysical:z.isPhysical(),
                 side:z._expansionSide, t:this.r4(z._expansionTime),
                 seq:z._expansionSequence, seq0:z._expansionSequence[0],
                 bounds:z._tileBounds, corners:z.getCorners() } : { ok:false };
  },
  /** 2-2 建议的"一行"（只压 _expansionTime，不动 side） */
  forceOneLine: function(id){ var z=this.gc().getZones()[id]; if(!z) return {gone:true};
    z._expansionTime=Constants.STORM_ZONE_START_GROW_TIME;
    return { t:this.r4(z._expansionTime), side:z._expansionSide, corners:z.getCorners() }; },
  /** 正确版：把状态设成"自然重置后、正要扩张"的那一刻（side=-1, t=START_GROW_TIME） */
  forceCorrect: function(id){ var z=this.gc().getZones()[id]; if(!z) return {gone:true};
    z._expansionSide=-1; z._expansionTime=Constants.STORM_ZONE_START_GROW_TIME;
    return { t:this.r4(z._expansionTime), side:z._expansionSide,
             tiles:[z._expansionTilesRight,z._expansionTilesBottom,z._expansionTilesLeft,z._expansionTilesTop] }; },
  zone: function(id){ var z=this.gc().getZones()[id]; if(!z) return {gone:true};
    var c=z.getCorners(); return { side:z._expansionSide, t:this.r4(z._expansionTime),
      RBLT:[z._expansionTilesRight,z._expansionTilesBottom,z._expansionTilesLeft,z._expansionTilesTop],
      corners:c, tilesN:(z.getTiles()||[]).length, phys:z.isPhysical() }; },
  tank: function(id){ var t=this.gc().getTank(id); return t?{x:this.r4(t.getX()),y:this.r4(t.getY()),rot:this.r4(t.getRotation())}:null; },
  fixtures: function(id){ var t=this.gc().getTank(id); if(!t) return null; var b=t.getB2DBody(); var out=[];
    for(var f=b.GetFixtureList(); f!==null; f=f.GetNext()){ var ud=f.GetUserData()||{}; var fd=f.GetFilterData(); var sh=f.GetShape();
      var o={ut:(ud.type===undefined?null:ud.type),cat:fd.categoryBits,r:sh.m_radius!==undefined?this.r4(sh.m_radius):null,v:null};
      if(sh.m_vertexCount!==undefined){ o.v=[]; for(var i=0;i<sh.m_vertexCount;i++){ var w=b.GetWorldPoint(sh.m_vertices[i]); o.v.push([this.r4(w.x),this.r4(w.y)]); } }
      out.push(o); }
    return out; },
  /** 毒雾 4 个夹具的世界 AABB（用于和 corners 对照） */
  stormAabbs: function(id){ var z=this.gc().getZones()[id]; if(!z) return null; var b=z.getB2DBody(); var out=[];
    for(var f=b.GetFixtureList(); f!==null; f=f.GetNext()){ var sh=f.GetShape();
      var mnx=1e9,mny=1e9,mxx=-1e9,mxy=-1e9;
      for(var i=0;i<sh.m_vertexCount;i++){ var v=sh.m_vertices[i];
        if(v.x<mnx)mnx=v.x; if(v.x>mxx)mxx=v.x; if(v.y<mny)mny=v.y; if(v.y>mxy)mxy=v.y; }
      out.push([this.r4(mnx),this.r4(mny),this.r4(mxx),this.r4(mxy)]); }
    return out; },
  tiles: function(){ var gc=this.gc(); var mz=gc.getMaze(); var tb=mz.getTileBounds(); var t=mz.getTiles();
    var cells=[]; for(var i=0;i<t.length;i++)for(var j=0;j<t[i].length;j++) if(t[i][j][0]===1) cells.push({x:i,y:j,top:t[i][j][1],left:t[i][j][2]});
    return {bounds:tb, TILE:Constants.MAZE_TILE_SIZE.m, WALL:Constants.MAZE_WALL_WIDTH.m, cells:cells,
            stormAppearAt:Constants.CLASSIC_STORM_APPEAR_DURATION}; }
};
`;

(async () => {
  let m;
  try {
    fs.mkdirSync(PROF, { recursive: true });
    m = new Match();
    await m.open({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
    await m.clearControl();
    await m.eval(H);
    report.adapter = await m.eval('(window.__ad = VantageSandbox.createAdapter(GameManager.getGameController(), "i4_storm"), "ok")');
    report.rawSub = await m.eval('window.__st.installRaw()');
    report.hook = (await m.eval('window.__st.deaths()')).status;

    const ti = await m.eval('window.__st.tiles()');
    report.maze = { bounds: ti.bounds, TILE: ti.TILE, WALL: ti.WALL, cells: ti.cells.length, stormAppearAt: ti.stormAppearAt };
    P('0) 迷宫 bounds=' + JSON.stringify(ti.bounds) + ' TILE=' + ti.TILE + ' WALL=' + ti.WALL);

    // 1) 造毒雾（与 ClassicGameMode.update 同一句 setZoneState）
    const mk = await m.eval('window.__st.makeStorm("i4sz")');
    report.makeStorm = mk;
    P('1) 造毒雾: type=' + mk.type + ' isPhysical=' + mk.isPhysical + ' side=' + mk.side + ' t=' + mk.t +
      '\n   seq=' + JSON.stringify(mk.seq) + '  seq0=' + mk.seq0 + '\n   corners=' + JSON.stringify(mk.corners));

    // 1b) 先试 2-2 给的"一行"（只压 _expansionTime）
    const one = await m.eval('window.__st.forceOneLine("i4sz")');
    const oneAfter2 = [];
    for (let i = 0; i < 2; i++) { await m.pump(1); oneAfter2.push(await m.eval('window.__st.zone("i4sz")')); }
    report.oneLineRecipe = { before: one, after2Frames: oneAfter2 };
    P('1b) 2-2 的"一行"(只压 t) 之后 2 帧：' + JSON.stringify(oneAfter2.map((z) => ({ side: z.side, sR: z.corners.stormStartRight, eL: z.corners.stormEndLeft }))));

    // 2) 正确版（补 _expansionSide = -1）
    const corr = await m.eval('window.__st.forceCorrect("i4sz")');
    report.correctRecipe = corr;
    P('2) 正确版: side=' + corr.side + ' t=' + corr.t + ' tiles=' + JSON.stringify(corr.tiles));

    // 3) 选受害者格：按【注入进 zone 的】seq[0] 决定先吃哪条边
    const first = mk.seq0, tb = mk.bounds;
    const midY = Math.round((tb.minY + tb.maxY) / 2), midX = Math.round((tb.minX + tb.maxX) / 2);
    let want = first === 0 ? { x: tb.maxX, y: midY } : first === 2 ? { x: tb.minX, y: midY } : first === 1 ? { x: midX, y: tb.maxY } : { x: midX, y: tb.minY };
    if (!ti.cells.some((c) => c.x === want.x && c.y === want.y)) {
      const cands = ti.cells.filter((c) => first === 0 ? c.x === tb.maxX : first === 2 ? c.x === tb.minX : first === 1 ? c.y === tb.maxY : c.y === tb.minY);
      if (cands.length) want = { x: cands[0].x, y: cands[0].y };
    }
    const vx = want.x * ti.TILE + ti.TILE / 2, vy = want.y * ti.TILE + ti.TILE / 2;
    await m.teleport('tank_b', vx, vy, 0);
    await m.pump(2);
    report.victim = { cell: want, world: { x: vx, y: vy }, placed: await m.eval('window.__st.tank("tank_b")'), box: (await m.eval('window.__st.fixtures("tank_b")')).find((f) => f.ut === 'base') };
    P('3) 受害者: seq[0]=' + first + ' cell=' + JSON.stringify(want) + ' world=(' + vx + ',' + vy + ') 落位=' + JSON.stringify(report.victim.placed) +
      '\n   base box=' + JSON.stringify(report.victim.box.v));
    const aabbs0 = await m.eval('window.__st.stormAabbs("i4sz")');
    report.aabbsAtStart = aabbs0;
    P('   4 夹具 AABB=' + JSON.stringify(aabbs0));

    // 4) 逐帧到死亡
    const rows = []; let deathFrame = -1, firstMove = -1; let pv = null;
    for (let i = 0; i < 900; i++) {
      const z = await m.eval('window.__st.zone("i4sz")');
      const t = await m.eval('window.__st.tank("tank_b")');
      rows.push({ f: i, z: z.gone ? null : z, victim: t });
      if (z.gone === undefined) {
        const c = z.corners;
        const sig = JSON.stringify([c.stormStartRight, c.stormEndLeft, c.stormStartBottom, c.stormEndTop]);
        if (firstMove < 0 && pv !== null && sig !== pv) firstMove = i;
        pv = sig;
      }
      if (!t) { deathFrame = i; break; }
      await m.pump(1);
    }
    report.rows = rows.length; report.deathFrame = deathFrame; report.firstMoveFrame = firstMove;
    report.zoneAtDeath = deathFrame >= 0 && rows[deathFrame] ? rows[deathFrame].z : null;
    report.zoneBeforeDeath = deathFrame > 0 && rows[deathFrame - 1] ? rows[deathFrame - 1].z : null;
    const step = Math.max(1, Math.floor(rows.length / 12));
    for (let i = 0; i < rows.length; i += step) {
      const r = rows[i]; if (!r.z) continue;
      P('   f' + r.f + ' t=' + r.z.t + ' side=' + r.z.side + ' RBLT=' + r.z.RBLT.join(',') +
        ' sR=' + r.z.corners.stormStartRight + ' eL=' + r.z.corners.stormEndLeft + ' tilesN=' + r.z.tilesN + ' victim=' + JSON.stringify(r.victim));
    }
    P('4) 死亡帧=' + deathFrame + '（自"正确版强制"起 ≈ ' + (deathFrame * (1 / 60)).toFixed(2) + ' s）首次边界移动帧=' + firstMove);
    if (report.zoneBeforeDeath) P('   死前帧 corners=' + JSON.stringify(report.zoneBeforeDeath.corners) + ' RBLT=' + report.zoneBeforeDeath.RBLT.join(','));
    if (report.zoneAtDeath) P('   死亡帧 corners=' + JSON.stringify(report.zoneAtDeath.corners));

    // 5) 采集器 + 裸监听器
    const dd = await m.eval('window.__st.deaths()');
    report.deaths = dd;
    report.raw = (await m.eval('window.__st.raw()')).slice(-10);
    const rec = (dd.list || []).find((r) => r.victimPlayerId === 'tank_b');
    report.record = rec || null;
    P('5) 采集器记录（tank_b）=' + JSON.stringify(rec));
    P('   hookStatus=' + JSON.stringify(dd.status));
    P('   裸事件最后 10 条=' + JSON.stringify(report.raw));
    report.verdict = rec ? {
      causeIsStorm: rec.cause === 'storm',
      srcIsTankDestroyed: rec.src === 'TANK_DESTROYED',
      posAvailable: rec.x !== null && rec.y !== null,
      contactAvailable: rec.contactX !== null && rec.contactY !== null,
      contactSrc: rec.contactSrc,
      killerIsNull: rec.killerPlayerId === null,
    } : null;
    P('6) 判定=' + JSON.stringify(report.verdict));

    // 7) 毒雾在本地能不能自然出现（复核）
    report.modeInfo = await m.eval(`(() => { var gc=GameManager.getGameController(); var gm=gc.getGameMode();
      return { mode:gm.mode, storm:!!gm.storm, stormSpawned:!!gm.stormSpawned,
               gmRoundControllerNull:(gm.roundController===null||gm.roundController===undefined),
               roundDuration:(gm.roundDuration===undefined?null:gm.roundDuration), state:gc.getState(),
               appearAt:Constants.CLASSIC_STORM_APPEAR_DURATION }; })()`);
    P('7) 本地模式=' + JSON.stringify(report.modeInfo));
    report.pageErrors = m.pageErrors.slice(0, 5);
  } catch (e) { report.err = String((e && e.stack) || e); P('X: ' + report.err); }
  finally {
    try { if (m) await m.close(); } catch (e) {}
    try { fs.writeFileSync(path.join(PROF, '_i4_storm_e2e.json'), JSON.stringify(report, null, 1)); } catch (e) {}
    P('[done] ' + ((Date.now() - T0) / 1000).toFixed(1) + 's');
  }
})();
