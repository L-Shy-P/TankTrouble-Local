const fs=require('fs');const {spawn}=require('child_process');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_sarl2.js','utf8');
const N=Number(process.env.N||120);
function ask(srv,o){return new Promise(r=>{srv.stdin.write(JSON.stringify(o)+'\n');srv.stdout.once('data',d=>{try{r(JSON.parse(String(d).trim()))}catch(e){r({lp:null,v:null})}});});}
(async()=>{const srv=spawn('py',['-3.13','_tools/training/policy_server_graph.py'],{env:{...process.env,PYTHONIOENCODING:'utf-8'}});   // ⭐ 图路（原路 = policy_server.py，USE_GRAPH=0 可退回）
 await new Promise(r=>setTimeout(r,3000));
 await new Promise(r=>{const h=(d)=>{const s=String(d);console.log('SRV_HEADER '+s.trim().slice(0,80));if(s.includes('WARMUP_FWD')){srv.stdout.off('data',h);r();}};srv.stdout.on('data',h);});   // ⭐ 显式读掉 header 行 + WARMUP_DONE 行（读到就停、每行都打）——不静默跳过
 const m=new Match(); await m.open({humanIds:['tank_a'],aiCount:1,vantCount:1});
 await m.clearControl(); try{await m.installControl('tank_a')}catch(e){}
 await m.eval(SRC); await m.eval('window.__probe.setup()');
 const rows=[];let nodeId=0;let errCount=0;
 for(let i=0;i<N;i++){
   const o=JSON.parse(await m.eval('window.__b.step('+nodeId+')'));
   if(o.err){ console.log('JS_OBS_ERR '+o.err+' gKeys='+JSON.stringify(o.gKeys)+' nKeys='+JSON.stringify(o.nKeys)); process.exit(1); }
   const p=await ask(srv,{h:o.h,g:o.g,n:o.n});
   if(p.err){ if(errCount<3) console.log('SRV_ERR '+String(p.err).slice(0,160)); errCount++; }
   if(typeof p.nodeId==='number') nodeId=p.nodeId;
   rows.push({f:i,s:o.h,r:o.alive?1:0,a:nodeId,lp:p.lp,v:p.v});
   await m.pump(1,{yieldMs:0});
 }
 srv.kill();
 const out='D:/vt_run/datasets/sarl2_'+N+'.jsonl'; fs.writeFileSync(out,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 const sU=new Set(rows.map(r=>r.s)).size, lU=new Set(rows.map(r=>String(r.lp))).size, vU=new Set(rows.map(r=>String(r.v))).size;
 const lpF=rows.filter(r=>typeof r.lp==='number'&&isFinite(r.lp)).length;
 console.log('SARL2 rows='+rows.length+' s_unique='+sU+' lp_unique='+lU+' v_unique='+vU+' lp_finite='+lpF+' bytes='+fs.statSync(out).size);
 console.log('SAMPLE '+JSON.stringify(rows.slice(0,3)));
 await m.close();})();
