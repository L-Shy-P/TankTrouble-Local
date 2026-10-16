const fs=require('fs');const {spawn}=require('child_process');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_fire.js','utf8');
const OUT='D:/vt_run/g1/';
function ask(srv,o){return new Promise(r=>{srv.stdin.write(JSON.stringify(o)+'\n');srv.stdout.once('data',d=>{try{r(JSON.parse(String(d).trim()))}catch(e){r({lp:null,err:'parse'})}});});}
(async()=>{
  fs.mkdirSync(OUT,{recursive:true});
  const srv=spawn('py',['-3.13','_tools/training/policy_server_graph.py'],{env:{...process.env,PYTHONIOENCODING:'utf-8'}});
  await new Promise(r=>{const h=(d)=>{const s=String(d);if(!s.includes('WARMUP_SAMPLE'))return;console.log('SRV_READY');srv.stdout.off('data',h);r();};srv.stdout.on('data',h);});
  const m=new Match();
  const op=await m.open({humanIds:['tank_a'],aiCount:1,vantCount:1});
  console.log('OPEN '+JSON.stringify({humanIds:op.humanIds,aiIds:op.aiIds,vantageIds:op.vantageIds,warn:op.aiWarn||null,verr:op.vantageErr||null}));
  await m.clearControl(); try{await m.installControl('tank_a')}catch(e){console.log('CTL_ERR '+(e&&e.message||e));}
  await m.eval(SRC); console.log('SETUP '+await m.eval('window.__probe.setup()'));
  await m.pump(30,{yieldMs:0});
  const inRound=await m.eval("(()=>{try{return GameModel._STATES.IN_ROUND}catch(e){return 'in round'}})()");
  const stSrc="(()=>{var gc=GameManager.getGameController();return gc?gc.getState():null})()";
  let frames=0,nodeId=0,picks=0,lpFinite=0,lpTot=0,oob=0,lpVals=[],vantageFireFrames=0;
  let state=await m.eval(stSrc),prevState=state,ended=false,endedAt=-1;
  let ids=null,laikaId=null,prevL=null,laikaMoveFrames=0,laikaFireFrames=0,maxProj=0,laikaSeenFrames=0;
  const t0=Date.now();
  const trail=[];
  while(frames<(+process.env.CAP||5000)){
    const snap=await m.snapshot();
    if(!ids){ ids=(snap.tanks||[]).map(t=>t.id); laikaId=ids.find(x=>x!=='tank_a'&&!String(x).startsWith('vantage_'))||null;
      console.log('TANKS '+JSON.stringify(ids)+'  LAIKA='+laikaId); }
    const L=(snap.tanks||[]).find(t=>t.id===laikaId);
    if(L){ laikaSeenFrames++; if(prevL&&(Math.abs(L.x-prevL.x)>0.01||Math.abs(L.y-prevL.y)>0.01||Math.abs(L.rot-prevL.rot)>0.001)) laikaMoveFrames++; prevL={x:L.x,y:L.y,rot:L.rot}; }
    const np=(snap.projectiles||[]).length; if(np>maxProj)maxProj=np;
    if((snap.projectiles||[]).some(p=>p.owner===laikaId)) laikaFireFrames++;
    if((snap.projectiles||[]).some(p=>String(p.owner).indexOf('vantage')===0)) vantageFireFrames++;
    if(frames%250===0) trail.push({f:frames,t:((Date.now()-t0)/1000).toFixed(1),laika:L?[L.x,L.y,L.rot]:null,projs:np,state});
    const o=JSON.parse(await m.eval('window.__b.step('+nodeId+',1)'));
    const p=await ask(srv,{h:o.h,g:o.g,n:o.n});
    lpTot++; if(typeof p.lp==='number'&&isFinite(p.lp)){lpFinite++; if(lpVals.length<8)lpVals.push(+p.lp.toFixed(4));}
    const N=(o.n||[]).length;
    if(typeof p.nodeId==='number'){ if(p.nodeId>=N)oob++; if(!(+process.env.HOLD>0 && (frames%(+process.env.HOLD))!==0)) nodeId=p.nodeId; picks++; }
    await m.pump(1,{yieldMs:0});
    frames++;
    state=await m.eval(stSrc);
    if(state!==prevState){ console.log('STATE@'+frames+' '+prevState+' -> '+state); prevState=state; }
    if(frames>40&&state!==inRound){ ended=true; endedAt=frames; break; }
  }
  const wall=((Date.now()-t0)/1000).toFixed(1);
  const final=await m.snapshot();
  const summary={frames,ended,endedAt,timeoutSec:+wall,inRoundState:inRound,lastState:state,
    tankIds:ids,laikaId,laikaSeenFrames,laikaMoveFrames,laikaFireFrames,maxProj,
    vantagePicks:picks,vantageFireFrames,lpFinite,lpTot,oob,lpVals,
    finalTanks:(final.tanks||[]).map(t=>({id:t.id,x:t.x,y:t.y,alive:t.alive!==false})),
    finalProjs:(final.projs||[]).length};
  fs.writeFileSync(OUT+'g1_summary.json',JSON.stringify({summary,trail},null,2));
  console.log('TRAIL '+JSON.stringify(trail));
  console.log('SUMMARY '+JSON.stringify(summary));
  try{ console.log('STATS '+JSON.stringify(await m.stats()).slice(0,1200)); }catch(e){ console.log('STATS_ERR '+(e&&e.message||e)); }
  try{ console.log('IFACE '+String(await m.eval("(()=>{try{var s=window.__vantageIface||{};return JSON.stringify({calls:s.calls,callsA:s.callsA,callsB:s.callsB,skipped:s.skipped,giveUpA:s.giveUpA,giveUpB:s.giveUpB,fireSelfHit:s.fireSelfHit,lastCtx:s.lastCtx,lastDecision:s.lastDecision})}catch(e){return 'ERR '+e.message}})()")).slice(0,900)); }catch(e){ console.log('IFACE_ERR '+(e&&e.message||e)); }
  try{ console.log('BSTAT '+String(await m.eval("(()=>{var b=window.__b||{};return JSON.stringify({n:b.n,buildOK:b.buildOK,buildMisses:b.buildMisses,buildErr:b.buildErr||null,lastBuilt:b.lastBuilt})})()")).slice(0,600)); }catch(e){ console.log('BSTAT_ERR '+(e&&e.message||e)); }
  try{ console.log('TREE_STATS '+String(await m.eval("(()=>{var t=VantageTree.getTree();return JSON.stringify((t&&t.stats)||{})})()")).slice(0,700)); }catch(e){ console.log('TREE_ERR '+(e&&e.message||e)); }
  await m.close(); srv.kill();
})().catch(e=>{console.log('FATAL '+((e&&e.stack)||e));process.exit(1)});
