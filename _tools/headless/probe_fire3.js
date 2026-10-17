const fs=require('fs');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_fire3.js','utf8');
const pc=async(m)=>{try{return await m.projectileCount()}catch(e){return 'n/a'}};
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:1,vantCount:1});
 await m.clearControl(); try{ await m.installControl('tank_a'); }catch(e){}
 await m.eval(SRC); await m.eval('window.__probe.setup()');
 // A 组：带射击帧
 await m.eval("window.__g.mode='shoot'"); const pcA0=await pc(m);
 for(let i=0;i<200;i++){ await m.eval('window.__probe.step()'); await m.pump(1,{yieldMs:0}); }
 const pcA1=await pc(m); const stA=JSON.parse(await m.eval('window.__probe.stat()'));
 // B 组：不带射击帧
 await m.eval("window.__g.mode='noshoo'; window.__g.xFound=0; window.__g.xNull=0; window.__g.nodeCounts=[];");
 const pcB0=await pc(m);
 for(let i=0;i<200;i++){ await m.eval('window.__probe.step()'); await m.pump(1,{yieldMs:0}); }
 const pcB1=await pc(m); const stB=JSON.parse(await m.eval('window.__probe.stat()'));
 console.log('A(带射击帧) pc:'+JSON.stringify(pcA0)+'->'+JSON.stringify(pcA1)+'  '+JSON.stringify(stA));
 console.log('B(不带)      pc:'+JSON.stringify(pcB0)+'->'+JSON.stringify(pcB1)+'  '+JSON.stringify(stB));
 await m.close();})();
