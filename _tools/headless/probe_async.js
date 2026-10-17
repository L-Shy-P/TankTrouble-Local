const fs=require('fs');const {spawn}=require('child_process');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_async.js','utf8');
const N=Number(process.env.N||200);
function ask(srv,obj){return new Promise((res)=>{srv.stdin.write(JSON.stringify(obj)+'\n');srv.stdout.once('data',(d)=>{try{res(JSON.parse(String(d).trim()))}catch(e){res({lp:null,v:null,err:'parse'})}});});}
(async()=>{const srv=spawn('py',['-3.13','_tools/training/policy_server.py'],{env:{...process.env,PYTHONIOENCODING:'utf-8'}});
 await new Promise(r=>setTimeout(r,3000));
 const t0=Date.now();const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl(); await m.eval(SRC); await m.eval('window.__probe.setup()');
 const rows=[];let tRt=0;
 for(let i=0;i<N;i++){
  const a=Date.now();
  const obs=JSON.parse(await m.eval('window.__a.obs()'));
  const pol=await ask(srv,{h:obs.h});
  await m.eval('window.__a.write(\'{}\','+String(pol.nodeId===undefined||pol.nodeId===null?0:pol.nodeId)+')');
  const b=Date.now(); tRt+=(b-a);
  await m.pump(1,{yieldMs:0});
  rows.push({f:i,s:obs.h,r:obs.alive?1:0,lp:pol.lp,v:pol.v,a:String(pol.nodeId)});
 }
 const wall=Date.now()-t0; srv.kill();
 const out='D:/vt_run/datasets/async_'+N+'.jsonl';
 fs.writeFileSync(out,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 const lps=rows.map(r=>r.lp).filter(x=>typeof x==='number'&&isFinite(x));
 const uniq=new Set(lps.map(x=>x.toFixed(6))).size;
 console.log('ASYNC rows='+rows.length+' lp_finite='+lps.length+' lp_unique='+uniq+' v_first='+rows[0].v+' bytes='+fs.statSync(out).size);
 console.log('PER_FRAME_MS='+((Date.now()-t0-0)/N).toFixed(2)+' (仅往返部分 '+ (tRt/N).toFixed(2)+') PER_ROUND_3158f_S='+(((Date.now()-t0)/N*3158)/1000).toFixed(1));
 console.log('SAMPLE '+JSON.stringify(rows.slice(0,3)));
 await m.close();})();
