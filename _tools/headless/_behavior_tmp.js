// 行为指标探针：合法性 / 移动流畅度 / 是否朝敌开火 / 是否躲弹
const fs=require('fs');const {spawn}=require('child_process');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_fire.js','utf8');
const FR=+process.env.B_FRAMES||1200;
function ask(srv,o){return new Promise(r=>{srv.stdin.write(JSON.stringify(o)+'\n');srv.stdout.once('data',d=>{try{r(JSON.parse(String(d).trim()))}catch(e){r({err:'parse'})}});});}
const ST="(()=>{var gc=GameManager.getGameController();var r=gc.getRoundState();var o={st:gc.getState(),me:null,foe:null,proj:[]};var ts=r.tankStates||[];for(var i=0;i<ts.length;i++){var t=ts[i],pid=t.playerId||t.id;var v={x:+t.x.toFixed(2),y:+t.y.toFixed(2),rot:+t.rot.toFixed(2)};if(String(pid)==='vantage_1')o.me=v;else o.foe=v;}var ps=r.projectileStates||[];for(var j=0;j<ps.length;j++){var p=ps[j];o.proj.push({o:String(p.owner||p.playerId||''),x:p.x,y:p.y,vx:p.speedX||0,vy:p.speedY||0});}return JSON.stringify(o)})()";
(async()=>{
  const env=Object.assign({},process.env,{PYTHONIOENCODING:'utf-8'});
  const srv=spawn('py',['-3.13','_tools/training/policy_server_graph.py'],{env});
  const serr=[]; srv.stderr.on('data',d=>{const t=String(d); if(t.indexOf('CKPT_')>=0)console.log('SRV_CKPT '+t.trim().slice(0,90));});
  await new Promise(r=>{const h=d=>{if(String(d).indexOf('WARMUP_SAMPLE')<0)return;srv.stdout.off('data',h);r();};srv.stdout.on('data',h);});
  const m=new Match(); await m.open({humanIds:[],aiCount:1,vantCount:1,control:false});
  await m.eval(SRC); await m.eval("window.__b.tankId='vantage_1'"); await m.eval('window.__probe.setup()');
  await m.pump(20,{yieldMs:0});
  let nodeId=0, sub=0, ok=0, oob=0, serrN=0, moved=0, framesInRound=0;
  let stall=0, maxStall=0; const steps=[]; let fireFrames=0, aimedFire=0, shotsSeen=0;
  let foeBullets=0, dodgeReact=0, dodgeChance=0; let prev=null, prevFoeProj=null;
  for(let f=0; f<FR; f++){
    const snap=await m.snapshot();
    const _tk=snap.tanks||[], _pj=snap.projectiles||[];
    const s={st:snap.stage,
      me:(function(){for(const t of _tk){if(String(t.id)==='vantage_1')return {x:+t.x.toFixed(2),y:+t.y.toFixed(2),rot:+t.rot.toFixed(2)};}return null;})(),
      foe:(function(){for(const t of _tk){if(String(t.id)!=='vantage_1')return {x:+t.x.toFixed(2),y:+t.y.toFixed(2),rot:+t.rot.toFixed(2)};}return null;})(),
      proj:_pj.map(function(p){return {o:String(p.owner||''),x:p.x,y:p.y,vx:p.vx||0,vy:p.vy||0};})};
    if(!s.me){ await m.pump(1,{yieldMs:0}); continue; }
    framesInRound++;
    const o=JSON.parse(await m.eval('window.__b.step('+nodeId+',1)'));
    if(o.err){serrN++; await m.pump(1,{yieldMs:0}); continue;}
    const N=(o.n||[]).length;
    if(N<1){ await m.pump(1,{yieldMs:0}); continue; }
    const bRows=(o.b&&o.b.length)?o.b:[[0,0,0,0,0,0,0]];
    const p=await ask(srv,{N:N,seed:f+1,segs:{node:o.n,bullet:bRows,global:[o.g]}});
    sub++; if(p.err)serrN++;
    if(typeof p.nodeId==='number'){ if(p.nodeId<0||p.nodeId>=N)oob++; else {nodeId=p.nodeId; ok++;} }
    // 移动
    if(prev){ const d=Math.hypot(s.me.x-prev.x,s.me.y-prev.y); steps.push(d);
      if(d>1e-6){moved++; stall=0;} else {stall++; if(stall>maxStall)maxStall=stall;} }
    // 开火 / 朝向
    const myShots=s.proj.filter(x=>x.o.indexOf('vantage')===0);
    if(myShots.length) fireFrames++;
    if(myShots.length && s.foe){
      for(const sh of myShots){ shotsSeen++;
        const toFoe=Math.atan2(s.foe.y-s.me.y, s.foe.x-s.me.x);
        const shDir=Math.atan2(sh.vy, sh.vx);
        let dd=Math.abs(((shDir-toFoe+Math.PI*3)%(Math.PI*2))-Math.PI);
        if(dd<Math.PI/6) aimedFire++;
      }
    }
    // 躲弹：有敌方子弹朝我飞且 8 单位内 ⟹ 下一帧我是否移动
    const foeP=s.proj.filter(x=>x.o.indexOf('vantage')<0);
    foeBullets+=foeP.length;
    const near=foeP.some(b=>{const d=Math.hypot(b.x-s.me.x,b.y-s.me.y); const va=Math.atan2(s.me.y-b.y,s.me.x-b.x); const ha=Math.atan2(b.vy,b.vx); let a=Math.abs(((ha-va+Math.PI*3)%(Math.PI*2))-Math.PI); return d<8 && a<Math.PI/4;});
    if(near){ dodgeChance++; if(prev && (Math.hypot(s.me.x-prev.x,s.me.y-prev.y)>1e-6||Math.abs(s.me.rot-prev.rot)>1e-6)) dodgeReact++; }
    prev=s.me; await m.pump(1,{yieldMs:0});
  }
  const bs=JSON.parse(await m.eval("(()=>{var b=window.__b||{};return JSON.stringify({buildOK:b.buildOK,buildMisses:b.buildMisses})})()"));
  const ifc=JSON.parse(await m.eval("(()=>{var s=window.__vantageIface||{};return JSON.stringify({calls:s.calls,skipped:s.skipped,giveUpA:s.giveUpA,giveUpB:s.giveUpB})})()"));
  const mean=steps.length?steps.reduce((a,b)=>a+b,0)/steps.length:0;
  const movedRatio=framesInRound?moved/framesInRound:0;
  console.log('BEHAVIOR '+JSON.stringify({
    frames:framesInRound, submitted:sub, parsed:(sub-serrN), nodeId_ok:ok, oob:oob,
    moved_frames:moved, moved_pct:+(movedRatio*100).toFixed(1), mean_step:+mean.toFixed(3),
    max_stall:maxStall, buildOK:bs.buildOK, buildMiss:bs.buildMisses,
    fire_frames:fireFrames, shots:shotsSeen, aimed_at_foe:aimedFire,
    foe_bullet_frames:foeBullets, threat_frames:dodgeChance, reacted:dodgeReact,
    iface:ifc}));
  await m.close(); srv.kill();
})().catch(e=>{console.log('FATAL '+((e&&e.stack)||e));process.exit(1)});
