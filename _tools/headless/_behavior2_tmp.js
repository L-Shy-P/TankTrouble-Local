// 行为指标（用已被验证能跑通的载荷：node=N 行 / bullet 64x7 / global 1x38 / opp 1x15 / item 8x6）
const fs=require('fs');const ROOT=__dirname;process.chdir('C:/Users/L_Shy_P user/Desktop/Code/Python/Projects/TankTrouble Local');
const {spawn}=require('child_process');const {Match}=require(ROOT+'/match.js');const {makeAsk}=require(ROOT+'/_policy_client.js');
const SRC=fs.readFileSync(ROOT+'/inject_fire.js','utf8');
const FR=+process.env.B_FRAMES||1200;
const pads=(rows,slot,w)=>{const o=(rows||[]).slice(0,slot).map(r=>r.slice(0,w));while(o.length<slot)o.push(new Array(w).fill(0));return o;};
(async()=>{
  const srv=spawn('py',['-3.13','_tools/training/policy_server_graph.py'],{env:Object.assign({},process.env,{PYTHONIOENCODING:'utf-8'})});
  srv.stderr.on('data',d=>{const t=String(d);if(t.indexOf('CKPT_')>=0)console.log('SRV '+t.trim().slice(0,80));});
  await new Promise(r=>{const h=d=>{if(String(d).indexOf('WARMUP_SAMPLE')<0)return;srv.stdout.off('data',h);r();};srv.stdout.on('data',h);});
  const ask=makeAsk(srv);
  const m=new Match(); await m.open({humanIds:[],aiCount:1,vantCount:1,control:false});
  await m.eval(SRC); await m.eval("window.__b.tankId='vantage_1'"); await m.eval('window.__probe.setup()');
  await m.pump(20,{yieldMs:0});
  let nodeId=0,fr=0,ok=0,errs=0,moved=0,steps=[],stall=0,maxStall=0,fireF=0,shots=0,aimed=0,threat=0,reacted=0,prev=null,firstErr='';
  for(let f=0;f<FR;f++){
    const snap=await m.snapshot();const tk=snap.tanks||[],pj=snap.projectiles||[];
    const me=(()=>{for(const t of tk)if(String(t.id)==='vantage_1')return{x:+t.x.toFixed(2),y:+t.y.toFixed(2),rot:+t.rot.toFixed(2)};return null;})();
    const foe=(()=>{for(const t of tk)if(String(t.id)!=='vantage_1')return{x:+t.x.toFixed(2),y:+t.y.toFixed(2)};return null;})();
    if(!me){await m.pump(1,{yieldMs:0});continue;}
    fr++;
    const o=JSON.parse(await m.eval('window.__b.step('+nodeId+',1)'));
    if(o.err){errs++;await m.pump(1,{yieldMs:0});continue;}
    const N=(o.n||[]).length;
    if(N<1){await m.pump(1,{yieldMs:0});continue;}
    const o15=(()=>{const a=(o.opp||[]).slice(0,15);while(a.length<15)a.push(0);return a;})();
    const p=await ask({N:N,seed:f+1,segs:{node:o.n,bullet:pads(o.b,64,7),global:[o.g],opp:[o15],item:pads(null,8,6)}});
    if(p.err){errs++;if(!firstErr)firstErr=JSON.stringify(p).slice(0,160);await m.pump(1,{yieldMs:0});continue;}
    if(typeof p.nodeId==='number'&&p.nodeId>=0&&p.nodeId<N){nodeId=p.nodeId;ok++;}
    if(prev){const d=Math.hypot(me.x-prev.x,me.y-prev.y);steps.push(d);if(d>1e-6){moved++;stall=0;}else{stall++;if(stall>maxStall)maxStall=stall;}}
    const mine=pj.filter(x=>String(x.owner||'').indexOf('vantage')===0);
    if(mine.length)fireF++;
    if(mine.length&&foe){for(const s of mine){shots++;const toF=Math.atan2(foe.y-me.y,foe.x-me.x),sh=Math.atan2(s.vy||0,s.vx||0);let dd=Math.abs(((sh-toF+Math.PI*3)%(Math.PI*2))-Math.PI);if(dd<Math.PI/6)aimed++;}}
    const near=(pj.filter(x=>String(x.owner||'').indexOf('vantage')<0)).some(b=>{const d=Math.hypot(b.x-me.x,b.y-me.y),va=Math.atan2(me.y-b.y,me.x-b.x),ha=Math.atan2(b.vy||0,b.vx||0);let a=Math.abs(((ha-va+Math.PI*3)%(Math.PI*2))-Math.PI);return d<8&&a<Math.PI/4;});
    if(near){threat++;const sn=await m.snapshot();const t2=(sn.tanks||[]).find(t=>String(t.id)==='vantage_1');if(t2&&(Math.hypot(t2.x-me.x,t2.y-me.y)>1e-6||Math.abs(t2.rot-me.rot)>1e-6))reacted++;}
    prev=me;await m.pump(1,{yieldMs:0});
  }
  const b=JSON.parse(await m.eval("(()=>{var x=window.__b||{};var i=window.__vantageIface||{};return JSON.stringify({buildOK:x.buildOK,fb:x.buildFallback,why:x.why||null,giveUpB:i.giveUpB,skipped:i.skipped})})()"));
  const mean=steps.length?steps.reduce((a,c)=>a+c,0)/steps.length:0;
  console.log('BEHAVIOR '+JSON.stringify({frames:fr,serverOK:ok,errors:errs,firstErr:firstErr,
    movedPct:+(100*moved/Math.max(1,fr)).toFixed(1),meanStep:+mean.toFixed(3),maxStall,
    fireFrames:fireF,shots,aimedAtFoe:aimed,threatFrames:threat,reacted,bridge:b}));
  await m.close();srv.kill();
})().catch(e=>{console.log('FATAL '+((e&&e.stack)||e));process.exit(1)});
