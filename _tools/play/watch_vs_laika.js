// 实机观战：开【可见】浏览器，Vantage(策略) vs Laika，自动一局接一局
// 用法： VT_CKPT=D:/vt_run/dist/step6/ckpt/model_latest.pt node _tools/play/watch_vs_laika.js
const {makeAsk}=require('../headless/_policy_client');
const fs=require('fs'),path=require('path');const {spawn}=require('child_process');
const {Match}=require('../headless/match');
const SRC=fs.readFileSync(path.join(__dirname,'..','headless','inject_fire.js'),'utf8');
const ROUNDS=+process.env.W_ROUNDS||0, CAP=+process.env.W_FRAMES||0;   // 0 = 一直跑
const RULES=(process.env.W_RULES||'0')==='1';   // 1 = 不注入策略，纯原生 AI 对打
let ask=null;   // 由 makeAsk(srv) 赋值（按行缓冲，⛔ 不再 once('data')）
(async()=>{
  let srv=null;
  if(!RULES){
    const ck=process.env.VT_CKPT;
    if(!ck||!fs.existsSync(ck)){console.log('⛔ 策略模式请给 VT_CKPT=<model_latest.pt>；只想看原生 AI 对打请加 W_RULES=1');process.exit(2);}
    srv=spawn('py',['-3.13','_tools/training/policy_server_graph.py'],{env:Object.assign({},process.env,{PYTHONIOENCODING:'utf-8'})});
    srv.stderr.on('data',d=>{const t=String(d); if(t.indexOf('CKPT_')>=0)console.log('策略 '+t.trim().slice(0,90));});
    await new Promise(r=>{const h=d=>{if(String(d).indexOf('WARMUP_SAMPLE')<0)return;srv.stdout.off('data',h);r();};srv.stdout.on('data',h);});
  ask=makeAsk(srv);   // ⭐ 按行缓冲客户端
  }
  const m=new Match();
  await m.open({humanIds:[],aiCount:1,vantCount:1,control:false,headless:false});
  if(!RULES){ await m.eval(SRC); await m.eval("window.__b.tankId='vantage_1'"); await m.eval('window.__probe.setup()'); }
  const sn0=await m.snapshot();
  console.log('坦克清单 = '+JSON.stringify((sn0.tanks||[]).map(function(t){return t.id;})));
  console.log('★ 游客皮肤那只 = vantage_1（'+(RULES?'原生规则版 Vantage':'我们的策略')+'）；Laika 皮肤那只 = 6148530');
  console.log('窗口保持打开，按 Ctrl+C 结束');
  let nodeId=0, f=0, ep=1, lastStage='';
  while(CAP===0||f<CAP){
    if(ROUNDS&&ep>ROUNDS) break;
    const o=RULES?{err:'rules'}:JSON.parse(await m.eval('window.__b.step('+nodeId+',1)'));
    if(!o.err){
      const N=(o.n||[]).length;
      if(N>0){
        const bRows=(o.b&&o.b.length)?o.b:[[0,0,0,0,0,0,0]];
        const p=await ask(srv,{N:N,seed:(f+1)*7919,segs:{node:o.n,bullet:bRows,global:[o.g]}});
        if(typeof p.nodeId==='number'&&p.nodeId>=0&&p.nodeId<N) nodeId=p.nodeId;
      }
    }
    await m.pump(1,{yieldMs:0});
    f++;
    if(f%300===0){
      const snap=await m.snapshot();
      const st=String(snap.stage||'');
      if(st!==lastStage){ if(lastStage&&st.indexOf('in round')<0){ep++;} lastStage=st; }
      console.log('f='+f+' 局≈'+ep+' 阶段='+st+' 坦克='+(snap.tanks||[]).length+' 子弹='+(snap.projectiles||[]).length);
    }
  }
  await m.close(); if(srv)srv.kill(); console.log('结束');
})().catch(e=>{console.log('FATAL '+((e&&e.stack)||e));process.exit(1)});
