#!/usr/bin/env node
'use strict';
/* G5 沙箱侧三态（护盾 PreSolve 三条规则）—— 每帧都跑一批融合世界，读累计账 */
const fs = require('fs'), path = require('path');
const { Match } = require('./match');
const OUT = path.join(__dirname, '_g5_prof');
const INSTALL = `(() => { window.__s = {
  gc: function () { return GameManager.getGameController(); },
  pose: function (pid) { var t = GameManager.getGameController().getTank(pid); return t ? { x: t.getX(), y: t.getY(), rot: t.getRotation() } : null; },
  findPose: function () { var gc=GameManager.getGameController(), maze=gc.getMaze(), world=gc.getB2DWorld();
    var T=Constants.MAZE_TILE_SIZE.m, out=null;
    for (var i=1;i<maze.width-1&&!out;i++) for (var j=2;j<maze.height-1&&!out;j++){var x=i*T+T/2,y=j*T+T/2,bx=x,by=y-2.8,cA=false,cB=false;
      try{cA=B2DUtils.checkLineForMazeCollision(world,Box2D.Common.Math.b2Vec2.Make(x,y-1.2),Box2D.Common.Math.b2Vec2.Make(bx,by-0.4))!==true;
          cB=B2DUtils.checkLineForMazeCollision(world,Box2D.Common.Math.b2Vec2.Make(bx,by-0.4),Box2D.Common.Math.b2Vec2.Make(bx,by+0.4))!==true;}catch(e){}
      if(cA&&cB) out={x:x,y:y,rot:0};}
    return out; },
  grantShield: function (pid) { var gc=GameManager.getGameController();
    var st=ShieldUpgrade.createInitialUpgradeState(IdGenerator.instance.gen('g5u'),pid); gc.roundController.setUpgradeState(st); return st.getId(); },
  spawn: function (x,y,vx,vy,owner,type) { var rc=GameManager.getGameController().roundController;
    var id=IdGenerator.instance.gen('g5s'); rc.setProjectileState(ProjectileState.withState(id,owner,type,x,y,vx,vy)); return id; },
  proj: function (id) { var p=GameManager.getGameController().getProjectile(id); if(!p) return null;
    var b=p.getB2DBody(), pos=b.GetPosition(), v=b.GetLinearVelocity();
    return { x:pos.x,y:pos.y,vx:v.x,vy:v.y,speed:Math.sqrt(v.x*v.x+v.y*v.y) }; },
  batch: function (pid, frames) { var gc=GameManager.getGameController(); var ad=VantageSandbox.createAdapter(gc,pid);
    var p=window.__s.pose(pid); var ops=[{name:'hold',inputs:{forward:false,back:false,left:false,right:false}}];
    ad.simulateTankBatchJsFused(p,ops,frames||30,{startPose:p,threats:[],tGlobal:0,nowTGlobal:0,auditPurpose:'scanNodeDeath'});
    var st=ad.getFusedShieldStats();
    return { bounce:st.bounceContacts, stops:st.shrapnelStops, own:st.ownPassThrough,
             slots:st.roundSlots.map(function(s){return {pid:s.pid,rule:s.rule,allows:s.allows,hit:s.hitFrames};}),
             shield:ad.getFusedCandidateShield(0) }; }
}; return {ok:true}; })()`;
(async () => {
  const res = { steps: [], errors: [] };
  const m = new Match();
  const add = (n, o) => { res.steps.push(Object.assign({ name: n }, o)); console.log(n + ' ' + JSON.stringify(o)); };
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b', 'tank_c'], aiCount: 0, vantCount: 0 });
    await m.clearControl(); await m.eval(INSTALL);
    const P = await m.eval('window.__s.findPose()'); res.pose = P;
    for (const t of [['tank_a', P.x, P.y, 0], ['tank_b', 65, 45, 0], ['tank_c', 5, 45, 0]]) await m.teleport(t[0], t[1], t[2], t[3]).catch(() => {});
    await m.eval(`window.__s.grantShield('tank_a')`); await m.pump(2, { yieldMs: 0 });
    // ① 外来弹 → 反弹
    const b1 = await m.eval(`window.__s.spawn(${P.x}, ${P.y - 9.0}, 0, 6.0, 'tank_b', -1)`);
    let last = null;
    for (let f = 0; f < 40; f++) {
      const st = await m.eval(`window.__s.proj(${JSON.stringify(b1)})`); last = st;
      const sb = await m.eval(`window.__s.batch('tank_a', 30)`);
      if (f === 0 || f === 39) add('A1_frame' + f, { realVy: st ? st.vy : null, sandbox: { bounce: sb.bounce, slots: sb.slots } });
      await m.pump(1, { yieldMs: 0 });
      if (!st) break;
    }
    add('A1_bounce_summary', { bullet: b1, lastReal: last, sandbox: await m.eval(`window.__s.batch('tank_a',30)`) });
    // ③ 自己的弹 → 穿过
    const b2 = await m.eval(`window.__s.spawn(${P.x}, ${P.y - 1.2}, 0, -6.0, 'tank_a', -1)`);
    const sb2 = await m.eval(`window.__s.batch('tank_a', 40)`);
    add('A3_own_pass', { bullet: b2, sandbox: { own: sb2.own, slots: sb2.slots } });
    for (let f = 0; f < 12; f++) await m.pump(1, { yieldMs: 0 });
    // ② 破片 → 停
    const b3 = await m.eval(`window.__s.spawn(${P.x}, ${P.y - 8.0}, 0, 18.0, 'tank_b', 4)`);
    let before = null, after = null;
    for (let f = 0; f < 30; f++) {
      const st = await m.eval(`window.__s.proj(${JSON.stringify(b3)})`);
      if (st && before === null) before = st;
      const sb = await m.eval(`window.__s.batch('tank_a', 6)`);
      if (f === 0 || f === 29) add('A2_frame' + f, { real: st, sandbox: { stops: sb.stops, slots: sb.slots } });
      if (st) after = st;
      await m.pump(1, { yieldMs: 0 });
      if (!st) break;
    }
    add('A2_shrapnel_summary', { bullet: b3, before: before && { y: before.y, speed: before.speed },
      after: after && { y: after.y, speed: after.speed }, sandbox: await m.eval(`window.__s.batch('tank_a',6)`) });
    res.finalStats = await m.eval(`VantageSandbox.getShieldStats()`);
  } catch (e) { res.errors.push(String((e && e.stack) || e)); }
  finally { try { await m.close(); } catch (e) {} }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, '_g5_sandbox.json'), JSON.stringify(res, null, 1));
  console.log('WROTE _g5_sandbox.json  ERRORS ' + JSON.stringify(res.errors));
  process.exitCode = res.errors.length ? 1 : 0;
})();
