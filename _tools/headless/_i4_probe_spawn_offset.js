'use strict';
/* ============================================================================
 * _i4_ 探针：① 出膛点几何（子弹出膛时是否在自己的炮塔夹具内部）
 *                      + 是原版还是我们的 + 影响面（killer==victim 发生率）
 *
 * 方法（只读产品代码，不改任何东西）：
 *   · 用游戏自己的 `RoundController.pullTrigger(pid)`（= 游戏每帧开火时调的那个函数）
 *     手动开一枪，**在 world.Step 之前**读弹体位置 ⟹ 拿到【真正的出膛点】
 *   · 同时读炮塔夹具的世界顶点 + 坦克质心 ⟹ 自己算"圆心到多边形"的最近距离
 *   · 再把世界接触链表里 "同主人 TANK↔PROJECTILE" 的接触抓一份（引擎侧佐证，带保留说明）
 *   · 影响面：真对局（1 人 + 2 AI）跑 N 帧，用 2-2 采集器 getDeaths() 统计 killer==victim
 *
 * 用法：node _tools/headless/_i4_probe_spawn_offset.js
 * 产物：_tools/headless/_i4_prof/_i4_spawn_offset.json（日志 < 100KB）
 * ============================================================================ */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Match } = require('./match');
const PROF = path.join(__dirname, '_i4_prof');
const FILES = [
  'game_core/js/b714588dc4621fe104113111ba90b1a7.js',
  'game_core/js/418577fd210ad079ea3d1e5e04050fe0.js',
  'game_core/js/46989e393ad0e356ac8a0c6c53b362f9.js',
  'game_core/js/82e43ebfcdffdaf490dbe79c9c119d29.js',
  'game_core/js/7b2ed8ad3598d7321f8f3d2b04b1eac8.js',
  'game_core/js/local_patch.js',
  'game_core/js/ai_tactics.js',
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
window.__sp = {
  gc: function(){ return GameManager.getGameController(); },
  rc: function(){ return GameManager.getGameController().roundController; },
  r4: function(x){ return Math.round(x*10000)/10000; },
  /** 游戏自己的常量：6 种武器的出膛偏移 / 半径 + 对应炮塔几何 */
  weaponConsts: function(){
    var C = Constants;
    function turret(t){ return t ? { W: t.WIDTH ? t.WIDTH.m : null, H: t.HEIGHT ? t.HEIGHT.m : (t.CENTER_HEIGHT?t.CENTER_HEIGHT.m:null),
      OY: t.OFFSET_Y ? t.OFFSET_Y.m : null } : null; }
    return {
      BULLET: { off: C.BULLET.OFFSET.m, r: C.BULLET.RADIUS.m, t: turret(C.BULLET_TURRET) },
      LASER: { off: C.LASER.OFFSET.m, r: C.LASER.RADIUS.m, t: turret(C.LASER_TURRET) },
      DOUBLE_BARREL: { off: C.DOUBLE_BARREL.OFFSET.m, r: C.DOUBLE_BARREL.RADIUS.m, t: turret(C.DOUBLE_BARREL_TURRET) },
      SHOTGUN: { off: C.SHOTGUN.OFFSET.m, r: C.SHOTGUN.RADIUS.m, t: turret(C.SHOTGUN_TURRET) },
      HOMING_MISSILE: { off: C.HOMING_MISSILE.OFFSET.m, r: C.HOMING_MISSILE.RADIUS.m, t: turret(C.MISSILE_TURRET) },
      GATLING_GUN: { off: C.GATLING_GUN.OFFSET.m, r: C.GATLING_GUN.RADIUS.m, t: turret(C.GATLING_GUN_TURRET) },
      MINE: { off: C.MINE.OFFSET ? C.MINE.OFFSET.m : null, r: C.MINE.RADIUS.m, t: null },
      TANK: { W: C.TANK.WIDTH.m, H: C.TANK.HEIGHT.m },
      WEAPON_TYPES: C.WEAPON_TYPES, COLLECTIBLE_TYPES: C.COLLECTIBLE_TYPES
    };
  },
  tank: function(id){ var t=this.gc().getTank(id); return t?{x:this.r4(t.getX()),y:this.r4(t.getY()),rot:this.r4(t.getRotation())}:null; },
  /** 坦克夹具（含世界顶点）+ 每个 fixture 的 userData.type */
  fixtures: function(id){
    var t=this.gc().getTank(id); if(!t) return null; var b=t.getB2DBody(); var out=[];
    for(var f=b.GetFixtureList(); f!==null; f=f.GetNext()){
      var ud=f.GetUserData()||{}; var fd=f.GetFilterData(); var sh=f.GetShape();
      var o={ut:(ud.type===undefined?null:ud.type),cat:fd.categoryBits,mask:fd.maskBits,r:sh.m_radius!==undefined?this.r4(sh.m_radius):null,v:null};
      if(sh.m_vertexCount!==undefined){ o.v=[]; for(var i=0;i<sh.m_vertexCount;i++){ var w=b.GetWorldPoint(sh.m_vertices[i]); o.v.push([this.r4(w.x),this.r4(w.y)]); } }
      out.push(o);
    }
    return out;
  },
  weapons: function(id){ var d=__vtData(this.gc().getRoundState())||{};
    return (d.weaponStates||[]).filter(function(w){return w.playerId===id;}).map(function(w){ return {id:w.id,type:w.type}; }); },
  /** 手动开一枪（游戏自己的开火函数），返回新弹的【Step 之前】位置 */
  fireNow: function(id){
    var gc=this.gc(), rc=this.rc();
    var before={}; var ps=gc.getProjectiles(); for(var k in ps) before[k]=1;
    rc.pullTrigger(id);
    var after=gc.getProjectiles(); var fresh=null;
    for(var k2 in after){ if(!before[k2]){ fresh=after[k2]; break; } }
    if(!fresh) return { err:'no new projectile (weapon.fire() 返回 false? 或该武器走 delayedFire)' };
    var b=fresh.getB2DBody(); var p=b.GetPosition(); var v=b.GetLinearVelocity();
    var t=gc.getTank(id);
    var out={ id:fresh.getId(), type:fresh.getType(), x:this.r4(p.x), y:this.r4(p.y),
      vx:this.r4(v.x), vy:this.r4(v.y), sp:this.r4(Math.sqrt(v.x*v.x+v.y*v.y)),
      tx:this.r4(t.getX()), ty:this.r4(t.getY()), rot:this.r4(t.getRotation()),
      deadly: fresh.isDeadlyToOwner(), timeAlive: fresh.getTimeAlive() };
    out.d = this.r4(Math.hypot(out.x-out.tx, out.y-out.ty));
    return out;
  },
  releaseTrigger: function(id){ this.rc().releaseTrigger(id); return 'released'; },
  clearBullets: function(){ var gc=this.gc(), n=0; var ps=gc.getProjectiles();
    for(var k in ps){ try{ gc.destroyProjectile(k); n++; }catch(e){} } return n; },
  /** 世界接触链表里 "同主人 TANK↔PROJECTILE" 的接触（引擎侧佐证） */
  sameOwnerContacts: function(){
    var gc=this.gc(); var w=gc.getB2DWorld(); var out=[];
    if(!w||!w.GetContactList) return out;
    var c=w.GetContactList();
    while(c){
      try{
        var fa=c.GetFixtureA(), fb=c.GetFixtureB();
        var ca=fa.GetFilterData().categoryBits, cb=fb.GetFilterData().categoryBits;
        var TANK=Constants.COLLISION_CATEGORIES.TANK, PROJ=Constants.COLLISION_CATEGORIES.PROJECTILE;
        if((ca===TANK&&cb===PROJ)||(ca===PROJ&&cb===TANK)){
          var fT=(ca===TANK)?fa:fb, fP=(ca===TANK)?fb:fa;
          var tank=fT.GetUserData().gameObject, proj=fP.GetUserData().gameObject;
          var pidT=tank&&tank.getPlayerId?tank.getPlayerId():null, pidP=proj&&proj.getPlayerId?proj.getPlayerId():null;
          if(pidT===pidP){
            var bp=proj.getB2DBody().GetPosition();
            out.push({ projId:proj.getId(), owner:pidP, touching:!!c.IsTouching(),
              bx:this.r4(bp.x), by:this.r4(bp.y),
              d:this.r4(Math.hypot(bp.x-tank.getX(), bp.y-tank.getY())), fixtureUt:fT.GetUserData().type||null });
          }
        }
      }catch(e){}
      c=c.GetNext();
    }
    return out;
  },
  spawnCrate: function(type,x,y){ var st=CollectibleState.withState(IdGenerator.instance.gen('c'),type,x,y,0);
    this.rc().setCollectibleState(st); return st.getId(); },
  upgrades: function(id){ var d=__vtData(this.gc().getRoundState())||{}; var us=d.upgradeStates||[];
    return us.filter(function(u){return u.playerId===id;}).length; },
  deaths: function(){ try{ var AD=window.__ad || VantageSandbox.createAdapter(this.gc(),'i4_probe');
      if(!window.__ad) window.__ad = AD;
      return { n: AD.getDeathsCount(), list: AD.getDeaths(), status: AD.getDeathHookStatus() }; }catch(e){ return { err:String(e) }; } }
};
`;

/* ---------------- 圆 × 轴对齐矩形（局部坐标下炮塔是 AABB）---------------- */
function circleVsBoxOverlap(cx, cy, r, box) {
  // box = [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
  const xs = box.map((p) => p[0]), ys = box.map((p) => p[1]);
  const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
  const nx = Math.max(x1, Math.min(cx, x2));
  const ny = Math.max(y1, Math.min(cy, y2));
  const d = Math.hypot(cx - nx, cy - ny);
  return { dist: +d.toFixed(4), overlap: d < r, deepest: +(r - d).toFixed(4), box: [x1, y1, x2, y2] };
}
/** 把点从世界转到坦克局部（本地朝向：forward = (sin r, -cos r)）*/
function worldToLocal(px, py, tx, ty, rot) {
  const dx = px - tx, dy = py - ty, s = Math.sin(rot), c = Math.cos(rot);
  // 游戏里 body 的旋转就是 rot（b2Body 角度 = rot）⟹ 局部 = R(-rot) * (p - t)
  const lx = dx * Math.cos(rot) + dy * Math.sin(rot);
  const ly = -dx * Math.sin(rot) + dy * Math.cos(rot);
  return { lx: +lx.toFixed(4), ly: +ly.toFixed(4), s: +s.toFixed(4) };
}

(async () => {
  let m;
  try {
    fs.mkdirSync(PROF, { recursive: true });
    /* ============ ① a) 几何：常量 + 实测出膛点 ============ */
    m = new Match();
    await m.open({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
    await m.clearControl(); await m.eval(H);
    const C = report.weaponConsts = await m.eval('window.__sp.weaponConsts()');
    P('== 常量（游戏自己的 Constants）==');
    for (const k of ['BULLET', 'LASER', 'DOUBLE_BARREL', 'SHOTGUN', 'HOMING_MISSILE', 'GATLING_GUN']) {
      const w = C[k];
      const tip = w.t && w.t.OY !== null ? (Math.abs(w.t.OY) + w.t.H / 2) : null;
      P(`  ${k.padEnd(15)} 出膛偏移=${w.off}  弹半径=${w.r}  炮塔(宽${w.t && w.t.W}×长${w.t && w.t.H}@y${w.t && w.t.OY}) 尖端=${tip === null ? '-' : tip.toFixed(3)}  出膛点+半径=${(w.off + w.r).toFixed(3)}  ${tip !== null && w.off < tip ? '★出膛即在炮塔内' : ''}`);
    }
    // 解析判定（圆 vs 炮塔矩形，局部坐标：炮塔中心在 (0, OY)）
    report.analytic = {};
    for (const k of ['BULLET', 'LASER', 'DOUBLE_BARREL', 'SHOTGUN', 'HOMING_MISSILE', 'GATLING_GUN']) {
      const w = C[k]; if (!w.t) continue;
      const cy = w.t.OY - w.off;                       // 弹心相对炮塔中心（沿前向 = -y）
      const box = [[-w.t.W / 2, w.t.OY - w.t.H / 2], [w.t.W / 2, w.t.OY - w.t.H / 2], [w.t.W / 2, w.t.OY + w.t.H / 2], [-w.t.W / 2, w.t.OY + w.t.H / 2]];
      const r = circleVsBoxOverlap(0, -w.off, w.r, box);
      report.analytic[k] = { off: w.off, r: w.r, tip: Math.abs(w.t.OY) + w.t.H / 2, overlapBoxDist: r.dist, overlap: r.overlap, deepest: r.deepest, box };
    }
    P('== 解析：弹圆 ∩ 炮弹炮塔矩形 ==');
    for (const k of Object.keys(report.analytic)) {
      const a = report.analytic[k];
      P(`  ${k.padEnd(15)} 出膛点=${a.off} r=${a.r} 炮塔尖=${a.tip.toFixed(3)} 圆心到炮塔面=${a.overlapBoxDist} 重叠=${a.overlap ? '★是' : '否'} 最深=${a.deepest}`);
    }

    // 实测：3 辆坦克 + 3 种武器
    const ti = await m.eval(`(() => { var mz=GameManager.getGameController().getMaze(); var tb=mz.getTileBounds(); var tiles=mz.getTiles();
      var out={cells:[],bounds:tb,TILE:Constants.MAZE_TILE_SIZE.m};
      for(var i=0;i<tiles.length;i++)for(var j=0;j<tiles[i].length;j++)if(tiles[i][j][0]===1)out.cells.push({x:i,y:j});
      return out; })()`);
    const mid = Math.round((ti.bounds.minY + ti.bounds.maxY) / 2);
    const plans = [
      { tank: 'tank_a', crate: null, name: 'BULLET(默认)' },
      { tank: 'tank_b', crate: 2, name: 'SHOTGUN(箱 type=2)' },
      { tank: 'tank_c', crate: 3, name: 'HOMING_MISSILE(箱 type=3)' },
    ];
    report.empirical = {};
    let slot = 0;
    for (const pl of plans) {
      let cell = ti.cells.find((c) => c.y === mid && c.x === ti.bounds.minX + 2 + slot * 3);
      if (!cell) cell = ti.cells[(slot * 7) % ti.cells.length];
      slot++;
      const x = cell.x * ti.TILE + ti.TILE / 2, y = cell.y * ti.TILE + ti.TILE / 2;
      await m.teleport(pl.tank, x, y, 0);      // rot=0 → 前方 = -y（世界）
      await m.pump(3);
      if (pl.crate !== null) {
        await m.eval(`window.__sp.spawnCrate(${pl.crate}, ${x}, ${y})`);
        for (let i = 0; i < 10; i++) { await m.pump(1); if ((await m.eval(`window.__sp.weapons(${JSON.stringify(pl.tank)})`)).some((w) => w.type === pl.crate)) break; }
      }
      const fx = await m.eval(`window.__sp.fixtures(${JSON.stringify(pl.tank)})`);
      const fire = await m.eval(`window.__sp.fireNow(${JSON.stringify(pl.tank)})`);
      const contactsSameFrame = await m.eval('window.__sp.sameOwnerContacts()');
      let post = null;
      if (!fire.err) { await m.pump(1); post = await m.eval('window.__sp.sameOwnerContacts()'); }
      await m.eval(`window.__sp.releaseTrigger(${JSON.stringify(pl.tank)})`);
      await m.eval('window.__sp.clearBullets()');
      const turret = (fx || []).find((f) => f.ut === 'turret');
      let geom = null;
      if (turret && fire && !fire.err) {
        const loc = worldToLocal(fire.x, fire.y, fire.tx, fire.ty, fire.rot);
        const locV = turret.v.map((p) => { const l = worldToLocal(p[0], p[1], fire.tx, fire.ty, fire.rot); return [l.lx, l.ly]; });
        const ov = circleVsBoxOverlap(loc.lx, loc.ly, C.BULLET ? (pl.crate === 2 ? C.SHOTGUN.r : pl.crate === 3 ? C.HOMING_MISSILE.r : C.BULLET.r) : 0.25, locV);
        geom = { localBullet: [loc.lx, loc.ly], localTurret: locV, overlap: ov, tipLocalY: Math.min(...locV.map((v) => v[1])) };
      }
      report.empirical[pl.name] = { tank: pl.tank, pose: { x, y, rot: 0 }, fixtures: fx, fire, contactsSameFrame: contactsSameFrame, contactsAfter1Step: post, geom };
      P(`== 实测 ${pl.name} @${pl.tank} ==`);
      P('  fire(Step 前) = ' + JSON.stringify(fire));
      if (geom) P('  局部弹心=' + JSON.stringify(geom.localBullet) + ' 局部炮塔=' + JSON.stringify(geom.localTurret) +
        '\n  圆心到炮塔面=' + geom.overlap.dist + '  重叠=' + (geom.overlap.overlap ? '★是' : '否') + ' 最深=' + geom.overlap.deepest + ' 炮塔尖端局部y=' + geom.tipLocalY);
      P('  同主人 TANK↔PROJECTILE 接触: 本帧(未 Step)=' + JSON.stringify(contactsSameFrame) + ' 1 步后=' + JSON.stringify(post));
      await m.pump(5);
    }
    report.pageErrorsGeom = m.pageErrors.slice(0, 4);
    try { await m.close(); } catch (e) {}
    m = null;

    /* ============ ① b) 影响面：真对局 killer==victim 发生率 ============ */
    const F = report.impact = { frames: 0, samples: [] };
    const m2 = new Match();
    await m2.open({ humanIds: ['tank_a'], aiCount: 2, vantCount: 0 });   // Laika + Dimitri
    await m2.clearControl();
    await m2.eval(H);      // 装助手（含 window.__sp）
    await m2.eval('window.__ad = VantageSandbox.createAdapter(GameManager.getGameController(), \"i4_impact\")');
    F.aiReady = await m2.eval('({ai: (typeof AIs !== "undefined") ? AIs.isReady() : null, tanks: Object.keys(GameManager.getGameController().getTanks())})');
    P('== 影响面：tanks=' + JSON.stringify(F.aiReady) + ' ==');
    let lastN = 0;
    const CH = 30;
    const acc = new Map();                 // 跨回合累积（每回合清表，按 key 去重）
    function absorb(d) {
      if (!d || !d.list) return;
      for (const r of d.list) {
        const key = [r.victimPlayerId, r.tWallMs, r.seq, r.src].join('|');
        if (!acc.has(key)) acc.set(key, r);
      }
    }
    for (let k = 0; k < 320; k++) {
      await m2.pump(CH);
      F.frames += CH;
      if (k % 10 === 0) {
        const d = await m2.eval('window.__sp.deaths()');
        absorb(d);
        if (d && d.n !== undefined) lastN = d.n;
        if (k % 50 === 0) P('   frames=' + F.frames + ' 本回合deaths=' + (d && d.n) + ' 累积=' + acc.size + ' err=' + (d && d.err) +
          ' tanks=' + JSON.stringify(await m2.eval('Object.keys(GameManager.getGameController().getTanks())')));
        if (acc.size >= 40) break;
      }
    }
    const dd = await m2.eval('window.__sp.deaths()');
    absorb(dd);
    F.framesTotal = F.frames;
    F.currentRoundN = dd.n;
    F.status = dd.status;
    F.list = Array.from(acc.values()).map((r) => ({
      victim: r.victimPlayerId, killer: r.killerPlayerId, src: r.src, cause: r.cause,
      deadlyType: r.deadlyType, exp: r.experience, x: r.x, y: r.y, contact: [r.contactX, r.contactY],
      paired: r.pairedEvents
    }));
    const kills = F.list.filter((r) => r.killer !== null && r.killer !== undefined);
    const selfKills = kills.filter((r) => r.killer === r.victim);
    F.summary = { deaths: F.list.length, killEvents: kills.length, selfKills: selfKills.length,
      selfKillRateOfKills: kills.length ? +(selfKills.length / kills.length).toFixed(3) : null,
      byCause: F.list.reduce((a, r) => { a[r.cause] = (a[r.cause] || 0) + 1; return a; }, {}),
      selfKillExp: selfKills.map((r) => r.exp) };
    P('== 影响面结果 == ' + JSON.stringify(F.summary));
    P('  自杀死者样本: ' + JSON.stringify(selfKills.slice(0, 6)));
    P('  全部死亡样本(前12): ' + JSON.stringify(F.list.slice(0, 12)));
    report.pageErrorsImpact = m2.pageErrors.slice(0, 4);
    await m2.close();
  } catch (e) { report.err = String((e && e.stack) || e); P('X: ' + report.err); }
  finally {
    try { if (m) await m.close(); } catch (e) {}
    try { fs.writeFileSync(path.join(PROF, '_i4_spawn_offset.json'), JSON.stringify(report, null, 1)); } catch (e) {}
    P('[done] ' + ((Date.now() - T0) / 1000).toFixed(1) + 's');
  }
})();
