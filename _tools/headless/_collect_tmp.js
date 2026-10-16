// 最小采集器（父代理 2026-10-17 夜）：2 人局 Vantage vs Laika → 逐帧记录 → 每局一行 JSON 喂训练器
const fs=require('fs');const {spawn}=require('child_process');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_fire.js','utf8');
const OUT=(process.env.C_OUT||'D:/vt_run/collect')+'/';
const ROUNDS=+process.env.C_ROUNDS||3, CAP=+process.env.C_CAP||900, FIRE=+process.env.C_FIRE||1;
const NODE_SLOTS=1000, BUL_SLOTS=64, OPP=15, ITEM_R=8, ITEM_C=6, GLB=38;
function pad(rows,slot,w){ if(rows.length>=slot) return rows.slice(0,slot); const out=rows.slice(); const z=new Array(w).fill(0); while(out.length<slot) out.push(z.slice()); return out; }
function ask(srv,o){return new Promise(r=>{srv.stdin.write(JSON.stringify(o)+'\n');srv.stdout.once('data',d=>{try{r(JSON.parse(String(d).trim()))}catch(e){r({lp:null,err:'parse'})}});});}
const SCORE_SRC="(()=>{var gc=GameManager.getGameController();var out={state:gc?gc.getState():null,scores:{}};try{var ss=gc.getScores();for(var k in ss){var s=ss[k];var pid=s.getPlayerId?s.getPlayerId():s.playerId;var t=s.getType?s.getType():s.type;var v=s.getValue?s.getValue():s.value;out.scores[pid+':'+t]=v;}}catch(e){out.err=String(e&&e.message||e);}return out})()";
(async()=>{
  fs.mkdirSync(OUT,{recursive:true});
  const srv=spawn('py',['-3.13','_tools/training/policy_server_graph.py'],{env:{...process.env,PYTHONIOENCODING:'utf-8'}});
  srv.stderr.on('data',d=>{ const t=String(d); if(t.indexOf('CKPT_')>=0) console.log('SRV_CKPT '+t.trim().slice(0,120)); });
  const m=new Match(); const op=await m.open({humanIds:[],aiCount:1,vantCount:1,control:false});
  console.log('OPEN '+JSON.stringify({ai:op.aiIds,vant:op.vantageIds}));
  await m.eval(SRC); console.log('SETUP '+await m.eval('window.__probe.setup()'));
  await m.pump(20,{yieldMs:0});
  const inRound=await m.eval("(()=>{try{return GameModel._STATES.IN_ROUND}catch(e){return 'in round'}})()");
  const episodes=[]; let totalFrames=0, totalProj=0, vFire=0, truncated=0, lpOk=0, lpTot=0, oob=0, skippedNoTree=0, badLp=0;
  for(let ep=1; ep<=ROUNDS; ep++){
    const frames=[]; let nodeId=0, done=false, won=null, f=0, prevState=null;
    for(f=0; f<CAP; f++){
      const st=await m.eval(SCORE_SRC);
      if(f>20 && st.state && st.state!==inRound){ done=true;
        let v={}; for(const k in st.scores){ if(k.indexOf(':1')>0) v[k.split(':')[0]]=st.scores[k]; }
        const ids=Object.keys(v);
        if(ids.length===1) won=(ids[0]==='vantage_1')?1:0; else won=(ids.length===0)?-1:null;
        if(won===null){ var anyV=false; for(var k2 in st.scores){ if(k2.indexOf(':1')>0&&st.scores[k2]>0) anyV=true; }
          if(anyV){ var vp=Object.keys(st.scores).filter(function(k3){return k3.indexOf(':1')>0&&st.scores[k3]>0;})[0];
                    won=(vp.indexOf('vantage_1')===0)?1:0; } }
        console.log('EP'+ep+' ROUND_END state='+st.state+' scores='+JSON.stringify(st.scores)+' won='+won);
        break; }
      const o=JSON.parse(await m.eval('window.__b.step('+nodeId+','+FIRE+')'));
      if(o.err){ console.log('STEP_ERR '+o.err); break; }
      const N=(o.n||[]).length;
      if(N<1){ skippedNoTree++; await m.pump(1,{yieldMs:0}); continue; }   // ⭐ 空树帧（回合间隙）不进数据
      const bRows=(o.b&&o.b.length)?o.b:[[0,0,0,0,0,0,0]];   // ⭐ 没子弹时不能发 []（服务端要求二维）
      const p=await ask(srv,{N:N,seed:ep*100000+f,segs:{node:o.n,bullet:bRows,global:[o.g]}});
      lpTot++; const lpOkF=(typeof p.lp==='number'&&isFinite(p.lp)); if(lpOkF)lpOk++;
      if(!lpOkF){ badLp++; if(badLp<=3) console.log('BAD_LP ep='+ep+' f='+f+' lp='+p.lp+' err='+(p.err||'')); await m.pump(1,{yieldMs:0}); continue; }   // ⭐ 非有限 lp ⟹ 该帧不进数据（⛔ 不许静默写 0）
      if(p.err){ if(!global.__errSeen)global.__errSeen={}; if(!global.__errSeen[p.err]){global.__errSeen[p.err]=0; console.log('SRV_ERR '+p.err);} global.__errSeen[p.err]=(global.__errSeen[p.err]||0)+1; }
      if(typeof p.nodeId==='number'){ if(p.nodeId>=N||p.nodeId<0)oob++; nodeId=p.nodeId; }
      const proj=(await m.snapshot()).projectiles||[];
      const nProj=proj.length; if(nProj>totalProj)totalProj=nProj;
      if(proj.some(x=>String(x.owner)==='vantage_1')) vFire++;
      frames.push({t:f,N:N,
        obs:{node:o.n,opp:[new Array(OPP).fill(0)],bullet:pad(bRows,BUL_SLOTS,7),item:Array.from({length:8},()=>new Array(6).fill(0)),global:[o.g]},
        act:{nodeId:(typeof p.nodeId==='number'?p.nodeId:0),fire:FIRE?1:0,picks:[{nodeId:(typeof p.nodeId==='number'?p.nodeId:0),back:0}]},
        lp:(lpOkF?p.lp:0),v:(typeof p.v==='number'&&isFinite(p.v)?p.v:0),
        r:{total:1.0,result:0,survive:1.0,legal:0},done:false});
      await m.pump(1,{yieldMs:0});
    }
    if(!done){ truncated++; }
    if(frames.length){ const last=frames[frames.length-1]; last.done=true; last.r.result=(won===null?0:(won===1?1:(won===-1?-0.25:-1))); last.r.total=last.r.result+(last.r.survive||0); }
    episodes.push({ep:ep,scene:{players:2,mapW:(await m.maze()).width,mapH:(await m.maze()).height,storm:false,crates:[]},frames:frames,win:won});
    totalFrames+=frames.length;
    // 每局复位：重开一局（原版会自动开新回合）
  }
  const summary={rounds:episodes.length,totalFrames,totalProj,vFire,truncated,lpOk,lpTot,oob,skippedNoTree,badLp,win:episodes.map(e=>e.win)};
  fs.writeFileSync(OUT+'episodes.jsonl',episodes.map(e=>JSON.stringify(e)).join('\n')+'\n');
  fs.writeFileSync(OUT+'summary.json',JSON.stringify(summary,null,2));
  console.log('SUMMARY '+JSON.stringify(summary));
  await m.close(); srv.kill();
})().catch(e=>{console.log('FATAL '+((e&&e.stack)||e));process.exit(1)});
