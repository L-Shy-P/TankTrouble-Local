const fs=require('fs');const {spawn}=require('child_process');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_sarl2.js','utf8');
function ask(srv,o){return new Promise(r=>{srv.stdin.write(JSON.stringify(o)+'\n');srv.stdout.once('data',d=>{try{r(JSON.parse(String(d).trim()))}catch(e){r({lp:null,v:null})}});});}
(async()=>{const srv=spawn('py',['-3.13','_tools/training/policy_server_graph.py'],{env:{...process.env,PYTHONIOENCODING:'utf-8'}});
 await new Promise(r=>setTimeout(r,3000));
 const m=new Match(); await m.open({humanIds:['tank_a'],aiCount:1,vantCount:1});
 await m.clearControl(); try{await m.installControl('tank_a')}catch(e){}
 await m.eval(SRC); await m.eval('window.__probe.setup()');
 await m.pump(30,{yieldMs:0});
 console.log('INIT_OK');
 const N=120; let t1=0,t2=0,t3=0,t4=0,t5=0,walls=[]; let nodeId=0; const rows=[];
 for(let i=0;i<N;i++){
   const w0=Date.now();
   let a=process.hrtime.bigint();
   const o=JSON.parse(await m.eval('window.__b.step('+nodeId+')'));
   let b=process.hrtime.bigint(); t1+=Number(b-a)/1e6;
   const p=await ask(srv,{h:o.h,g:o.g,n:o.n});
   let c=process.hrtime.bigint(); t2+=Number(c-b)/1e6;
   if(typeof p.nodeId==='number') nodeId=p.nodeId;
   let d=process.hrtime.bigint(); t4+=Number(d-c)/1e6;
   rows.push({f:i,s:o.h,lp:p.lp,v:p.v});
   let e=process.hrtime.bigint(); t5+=Number(e-d)/1e6;
   await m.pump(1,{yieldMs:0});
   let f=process.hrtime.bigint(); t3+=Number(f-e)/1e6;
   walls.push(Date.now()-w0);
 }
 const ms=x=>x/N; walls.sort((a,b)=>a-b);
 const fin=rows.filter(r=>typeof r.lp==='number'&&isFinite(r.lp)).length;
 const lpu=new Set(rows.map(r=>String(r.lp))).size, vu=new Set(rows.map(r=>String(r.v))).size;
 console.log('SEG_1_EVAL_OBS ms/frame '+ms(t1).toFixed(2));
 console.log('SEG_2_ASK_FWD ms/frame '+ms(t2).toFixed(2));
 console.log('SEG_3_PUMP ms/frame '+ms(t3).toFixed(2));
 console.log('SEG_4_WRITEBACK ms/frame '+ms(t4).toFixed(2));
 console.log('SEG_5_PERSIST ms/frame '+ms(t5).toFixed(2));
 console.log('SEG_SUM5 ms/frame '+(ms(t1)+ms(t2)+ms(t3)+ms(t4)+ms(t5)).toFixed(2));
 console.log('SEG_WALL_median ms/frame '+walls[Math.floor(N/2)].toFixed(2));
 console.log('SEG_RESIDUAL ms/frame '+(walls[Math.floor(N/2)]-(ms(t1)+ms(t2)+ms(t3)+ms(t4)+ms(t5))).toFixed(2));
 console.log('SEG_QUAL lp_finite='+fin+'/'+N+' lp_unique='+lpu+' v_unique='+vu);
 await m.close(); srv.kill();})();
