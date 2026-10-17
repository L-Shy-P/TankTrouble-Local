// 探针：策略的输出到底有没有驱动 vantage_1（位置/朝向是否在变）+ 桥接受率
const fs=require('fs');const {spawn}=require('child_process');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_fire.js','utf8');
const NFR=+process.env.P_NFR||300, CKPT=process.env.VT_CKPT||'';
function ask(srv,o){return new Promise(r=>{srv.stdin.write(JSON.stringify(o)+'\n');srv.stdout.once('data',d=>{try{r(JSON.parse(String(d).trim()))}catch(e){r({err:'parse'})}});});}
(async()=>{
  const env=Object.assign({},process.env,{PYTHONIOENCODING:'utf-8'}); if(CKPT) env.VT_CKPT=CKPT;
  const srv=spawn('py',['-3.13','_tools/training/policy_server_graph.py'],{env});
  srv.stderr.on('data',d=>{const t=String(d);if(t.indexOf('CKPT_')>=0)console.log('SRV_CKPT '+t.trim().slice(0,100));});
  await new Promise(r=>{const h=d=>{if(String(d).indexOf('WARMUP_SAMPLE')<0)return;console.log('SRV_READY');srv.stdout.off('data',h);r();};srv.stdout.on('data',h);});
  const m=new Match(); await m.open({humanIds:[],aiCount:1,vantCount:1,control:false});
  await m.eval(SRC); await m.eval("window.__b.tankId='vantage_1'"); await m.eval('window.__probe.setup()');
  await m.pump(20,{yieldMs:0});
  let nodeId=0, moves=0, poses=new Set(), vFireFrames=0, accepted=0, submitted=0, samePos=true;
  let prev=null;
  for(let f=0; f<NFR; f++){
    const o=JSON.parse(await m.eval('window.__b.step('+nodeId+',1)'));
    if(o.err){console.log('STEP_ERR '+o.err);break;}
    const N=(o.n||[]).length;
    if(N<1){ await m.pump(1,{yieldMs:0}); continue; }
    const bRows=(o.b&&o.b.length)?o.b:[[0,0,0,0,0,0,0]];
    const p=await ask(srv,{N:N,seed:f+1,segs:{node:o.n,bullet:bRows,global:[o.g]}});
    submitted++;
    if(typeof p.nodeId==='number'&&p.nodeId<N&&p.nodeId>=0){nodeId=p.nodeId; accepted++;}
    const st=await m.eval("(()=>{var gc=GameManager.getGameController();var r=gc.getRoundState();var t=(r.tankStates||[]).filter(function(x){return x.playerId==='vantage_1'})[0];return t?JSON.stringify({x:+t.x.toFixed(2),y:+t.y.toFixed(2),rot:+t.rot.toFixed(2)}):'null'})()");
    const proj=(await m.snapshot()).projectiles||[];
    if(proj.some(x=>String(x.owner)==='vantage_1')) vFireFrames++;
    if(st!=='null'){ const s=JSON.parse(st); const key=s.x+','+s.y+','+s.rot; poses.add(key);
      if(prev){ if(Math.abs(s.x-prev.x)>1e-9||Math.abs(s.y-prev.y)>1e-9||Math.abs(s.rot-prev.rot)>1e-9) moves++; }
      prev=s; }
    await m.pump(1,{yieldMs:0});
  }
  const bs=JSON.parse(await m.eval("(()=>{var b=window.__b||{};return JSON.stringify({buildOK:b.buildOK,buildMisses:b.buildMisses,buildErr:b.buildErr||null,lastBuilt:b.lastBuilt})})()"));
  const iface=JSON.parse(await m.eval("(()=>{var s=window.__vantageIface||{};return JSON.stringify({calls:s.calls,callsA:s.callsA,callsB:s.callsB,skipped:s.skipped})})()"));
  console.log('RESULT '+JSON.stringify({frames:NFR,submitted,accepted,vantageMoves:moves,distinctPoses:poses.size,vFireFrames,bridge:bs,iface}));
  await m.close(); srv.kill();
})().catch(e=>{console.log('FATAL '+((e&&e.stack)||e));process.exit(1)});
