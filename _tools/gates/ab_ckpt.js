// 同条件 A/B 对比两份 ckpt：交替跑同一批回合，输出带 Wilson 区间的对比表
// 用法: node _tools/gates/ab_ckpt.js --a <ckptA> --b <ckptB> [--rounds 6] [--cap 3000]
const fs=require('fs'),path=require('path');const {spawn}=require('child_process');
const ROOT='C:/Users/L_Shy_P user/Desktop/Code/Python/Projects/TankTrouble Local';
process.chdir(ROOT);
const {Match}=require(ROOT+'/_tools/headless/match.js');
const {makeAsk}=require(ROOT+'/_tools/headless/_policy_client.js');
const SRC=fs.readFileSync(ROOT+'/_tools/headless/inject_fire.js','utf8');
const arg=(n,d)=>{const i=process.argv.indexOf('--'+n);return i<0?d:process.argv[i+1];};
const A=arg('a',null), B=arg('b',null), ROUNDS=+arg('rounds',6), CAP=+arg('cap',3000);
function wilson(w,n){if(!n)return[0,0];const p=w/n,z=1.96,d=1+z*z/n,c=p+z*z/(2*n),m=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n));return[Math.max(0,(c-m)/d),Math.min(1,(c+m)/d)];}
function startSrv(ck){return spawn('py',['-3.13','_tools/training/policy_server_graph.py'],{env:Object.assign({},process.env,{PYTHONIOENCODING:'utf-8',VT_CKPT:ck})});}
async function bootSrv(ck){
  const s=startSrv(ck);let loaded=false;
  s.stdout.setEncoding('utf8');s.stderr.setEncoding('utf8');
  s.stderr.on('data',d=>{if(String(d).indexOf('CKPT_LOADED')>=0)loaded=true;});
  await new Promise(r=>{const h=d=>{if(String(d).indexOf('WARMUP_SAMPLE')<0)return;s.stdout.off('data',h);r();};s.stdout.on('data',h);});
  if(!loaded){s.kill();throw new Error('⛔ 服务端没有 CKPT_LOADED：'+ck);}   // ⛔ 不许随机权重
  return {s,ask:makeAsk(s)};
}
(async()=>{
  if(!A||!B||!fs.existsSync(A)||!fs.existsSync(B)){console.log('⛔ 需要 --a <ckptA> --b <ckptB>（两份都要存在）');process.exit(2);}
  const arms=[{tag:'A',ck:A,rs:[]},{tag:'B',ck:B,rs:[]}];
  const m=new Match(); await m.open({humanIds:[],aiCount:1,vantCount:1,control:false});
  await m.eval(SRC); await m.eval("window.__b.tankId='vantage_1'"); await m.eval('window.__probe.setup()');
  for(let r=0;r<ROUNDS;r++){
    const arm=arms[r%2];                       // ⭐ 交替，抵消漂移
    const {s,ask}=await bootSrv(arm.ck);
    // 等回到 in round
    const inR=await m.eval("(()=>{try{return GameModel._STATES.IN_ROUND}catch(e){return 'in round'}})()");
    let ready=false;
    for(let w=0;w<1200;w++){const st=await m.eval("(()=>{var g=GameManager.getGameController();return g?g.getState():null})()");if(st===inR){ready=true;break;}await m.pump(1,{yieldMs:0});}
    if(!ready){console.log('['+arm.tag+'] ⚠️ 等不到 in round，本轮跳过');s.kill();continue;}
    let nodeId=0,fr=0,fireF=0,spawns=0,lastBF=null,ended=false,win=null,prevState=inR;
    for(let f=0;f<CAP;f++){
      const o=JSON.parse(await m.eval('window.__b.step('+nodeId+',1)'));
      if(!o.err){const N=(o.n||[]).length;
        if(N>0){const o15=(()=>{const a=(o.opp||[]).slice(0,15);while(a.length<15)a.push(0);return a;})();
          const it=Array.from({length:8},()=>[0,0,0,0,0,0]);
          const bl=(o.b&&o.b.length)?o.b:[[0,0,0,0,0,0,0]];
          const p=await ask({N:N,seed:f+1,segs:{node:o.n,bullet:bl,global:[o.g],opp:[o15],item:it}});
          if(!p.err&&typeof p.nodeId==='number'&&p.nodeId>=0&&p.nodeId<N){nodeId=p.nodeId;}
          if(!p.err&&p.fire===1)fireF++;}}
      await m.pump(1,{yieldMs:0});
      fr++;
      const snap=await m.snapshot();
      const bf=+(await m.eval("(()=>{try{var g=GameManager.getGameController();var r=g.getRoundState();var ws=r.weaponStates||r.weapons||[];var t=0;for(var i=0;i<ws.length;i++){var w=ws[i];var pid=String(w.playerId||w.owner||w.aiId||'');if(pid.indexOf('vantage')>=0){t+=+((w._bulletsFired!==undefined?w._bulletsFired:w.bulletsFired)||0);}}return t}catch(e){return -1}})()"))||0;   // 真发射（在飞计数，增量法）= 打不死人的核心指标
      if(lastBF!==null&&bf>lastBF)spawns+=bf-lastBF;
      lastBF=bf;
      const st=String(await m.eval("(()=>{var g=GameManager.getGameController();return g?g.getState():''})()")||'');
      if(st!=='in round'){ if(st==='ended'){ended=true;} else { break; } }   // ⭐ 只有 ended 才算结束；其它状态=回合间隙⟹本回合作废
      if(ended)break;
    }
    const sc=await m.eval("(()=>{var g=GameManager.getGameController();try{var s=g.getScores(),o={};for(var k in s){var x=s[k];o[String(x.getPlayerId?x.getPlayerId():x.playerId)+':'+String(x.getType?x.getType():x.type)]=x.getValue?x.getValue():x.value;}}catch(e){}return JSON.stringify(o)})()");
    const scores=JSON.parse(sc||'{}');
    for(const k in scores){ if(k.indexOf(':1')>0&&scores[k]>0) win=(k.indexOf('vantage')===0)?1:0; }
    arm.rs.push({fr,firePct:fr?+(100*fireF/fr).toFixed(1):0,spawns,ended,win});
    console.log(`[${arm.tag}] round ${r+1} frames=${fr} fire%=${arm.rs[arm.rs.length-1].firePct} spawns=${spawns} ended=${ended} win=${win}`);
    s.kill();
  }
  console.log('\n| 臂 | ckpt | 回合 | 平均帧 | fire% | 真发射合计 | 结束局 | 胜/负/未决 | 胜率 | Wilson95% |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for(const a of arms){
    const n=a.rs.length, dec=a.rs.filter(r=>r.win!==null), w=dec.filter(r=>r.win===1).length, l=dec.length-w;
    const u=n-dec.length, wr=dec.length?w/dec.length:0, [lo,hi]=wilson(w,dec.length);
    const avg=Math.round(a.rs.reduce((s,r)=>s+r.fr,0)/Math.max(1,n));
    const fp=(a.rs.reduce((s,r)=>s+r.firePct,0)/Math.max(1,n)).toFixed(1);
    const sp=a.rs.reduce((s,r)=>s+r.spawns,0), en=a.rs.filter(r=>r.ended).length;
    console.log(`| ${a.tag} | ${path.basename(path.dirname(path.dirname(a.ck)))} | ${n} | ${avg} | ${fp} | ${sp} | ${en} | ${w}/${l}/${u} | ${(100*wr).toFixed(1)}% | [${(100*lo).toFixed(0)},${(100*hi).toFixed(0)}] |`);
  }
  await m.close(); if(!fs.existsSync('D:/vt_run/ab'))fs.mkdirSync('D:/vt_run/ab',{recursive:true});
  fs.writeFileSync('D:/vt_run/ab/last.json',JSON.stringify({a:A,b:B,rounds:ROUNDS,cap:CAP,arms:arms.map(a=>({tag:a.tag,ck:a.ck,rs:a.rs}))},null,2));
  console.log('\nAB_DONE → D:/vt_run/ab/last.json');
})().catch(e=>{console.log('FATAL '+((e&&e.stack)||e));process.exit(1)});
