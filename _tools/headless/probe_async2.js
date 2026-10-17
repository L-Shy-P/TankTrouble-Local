const fs=require('fs');const {spawn}=require('child_process');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_async2.js','utf8');
const N=Number(process.env.N||150);
function ask(srv,obj){return new Promise((res)=>{srv.stdin.write(JSON.stringify(obj)+'\n');srv.stdout.once('data',d=>{try{res(JSON.parse(String(d).trim()))}catch(e){res({lp:null,v:null,err:'parse'})}});});}
(async()=>{const srv=spawn('py',['-3.13','_tools/training/policy_server.py'],{env:{...process.env,PYTHONIOENCODING:'utf-8'}});
 await new Promise(r=>setTimeout(r,3000));
 const m=new Match(); await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl(); await m.eval(SRC); await m.eval('window.__probe.setup()');
 const rows=[];let tEnc=0,tFwd=0,tPump=0;let nodeId=0;
 for(let i=0;i<N;i++){
  const a=Date.now();
  const o=JSON.parse(await m.eval('window.__b.step('+nodeId+')')); const b=Date.now();
  const pol=await ask(srv,{h:o.h}); const c=Date.now();
  nodeId=(typeof pol.nodeId==='number')?pol.nodeId:0;
  await m.pump(1,{yieldMs:0}); const d=Date.now();
  tEnc+=(b-a); tFwd+=(c-b); tPump+=(d-c);
  rows.push({f:i,s:o.h,dots:o.dots,r:o.alive?1:0,lp:pol.lp,v:pol.v,a:nodeId});
 }
 srv.kill();
 const out='D:/vt_run/datasets/async2_'+N+'.jsonl'; fs.writeFileSync(out,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 const sU=new Set(rows.map(r=>r.s)).size, lU=new Set(rows.map(r=>String(r.lp))).size;
 const per=(tEnc+tFwd+tPump)/N;
 console.log('ASYNC2 rows='+rows.length+' s_unique='+sU+' lp_unique='+lU+' bytes='+fs.statSync(out).size);
 console.log('MS_PER_FRAME enc='+(tEnc/N).toFixed(2)+' fwd='+(tFwd/N).toFixed(2)+' pump='+(tPump/N).toFixed(2)+' total='+per.toFixed(2));
 console.log('PER_ROUND_3158f_S='+(per*3158/1000).toFixed(1)+'  SAMPLE '+JSON.stringify(rows.slice(0,2)));
 await m.close();})();
