const fs=require('fs');const {spawn}=require('child_process');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_sarl2.js','utf8');
function ask(srv,o){return new Promise(r=>{srv.stdin.write(JSON.stringify(o)+'\n');srv.stdout.once('data',d=>{try{r(JSON.parse(String(d).trim()))}catch(e){r({lp:null,v:null})}});});}
(async()=>{const U=process.env.USE_GRAPH||'1';
 const srv=spawn('py',['-3.13','_tools/training/policy_server_graph.py'],{env:{...process.env,PYTHONIOENCODING:'utf-8',USE_GRAPH:U}});
 await new Promise(r=>setTimeout(r,3000));
 await new Promise(r=>{const h=(d)=>{const s=String(d);console.log('SRV_HEADER '+s.trim().slice(0,80));if(s.includes('WARMUP_SAMPLE')){srv.stdout.off('data',h);r();}};srv.stdout.on('data',h);});   // ⭐ 读到 WARMUP_DONE 为止、每行都打
 const m=new Match(); await m.open({humanIds:['tank_a'],aiCount:1,vantCount:1});
 await m.clearControl(); try{await m.installControl('tank_a')}catch(e){}
 await m.eval(SRC); await m.eval('window.__probe.setup()');
 await m.pump(30,{yieldMs:0});
 console.log('INIT_OK USE_GRAPH='+U);
 const N=120; const rows=[]; let nodeId=0;
 for(let i=0;i<N;i++){
   const w0=process.hrtime.bigint();
   const o=JSON.parse(await m.eval('window.__b.step('+nodeId+')'));
   let b=process.hrtime.bigint(); const te=Number(b-w0)/1e6;
   const p=await ask(srv,{h:o.h,g:o.g,n:o.n});
   let c=process.hrtime.bigint(); const ta=Number(c-b)/1e6;
   if(typeof p.nodeId==='number') nodeId=p.nodeId;
   await m.pump(1,{yieldMs:0});
   let d=process.hrtime.bigint(); const tp=Number(d-c)/1e6;
   rows.push({f:i,total:Number(d-w0)/1e6,eval:te,ask:ta,pump:tp,lp:p.lp,nLen:(o.n||[]).length});
 }
 const tot=rows.map(r=>r.total).slice().sort((a,b)=>a-b);
 const slow=rows.filter(r=>r.total>30);
 const nulls=rows.filter(r=>!(typeof r.lp==='number'&&isFinite(r.lp)));
 console.log('SLOW_COUNT n='+slow.length+' of '+N+' ('+(100*slow.length/N).toFixed(1)+'%)');
 for(const r of slow.slice(0,6)) console.log('SLOW_FRAME f='+r.f+' total='+r.total.toFixed(1)+' eval='+r.eval.toFixed(1)+' ask='+r.ask.toFixed(1)+' pump='+r.pump.toFixed(1));
 console.log('NULL_FRAMES '+nulls.map(r=>r.f+'(n='+r.nLen+')').join(','));
 console.log('TOTAL_MS median='+tot[Math.floor(tot.length/2)].toFixed(2)+' mean='+(rows.reduce((a,b)=>a+b.total,0)/N).toFixed(2)+' max='+tot[tot.length-1].toFixed(2)+' min='+tot[0].toFixed(2));
 console.log('FIRST5 '+rows.slice(0,5).map(r=>r.total.toFixed(1)).join(','));
 console.log('LP_FINITE '+rows.filter(r=>typeof r.lp==='number'&&isFinite(r.lp)).length+'/'+N);
 await m.close(); srv.kill();})();
