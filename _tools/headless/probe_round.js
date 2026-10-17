const fs=require('fs');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_round.js','utf8');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl(); console.log('EVAL '+String(await m.eval(SRC)).slice(0,20));
 console.log('SETUP '+String(await m.eval('window.__probe.setup()')).slice(0,10));
 for(let i=0;i<3600;i++){ await m.eval('window.__probe.step('+i+')'); await m.pump(1,{yieldMs:0});
  if((i+1)%900===0){ const s=String(await m.eval('window.__probe.stat()'));
   console.log('T'+(i+1)+' '+s.slice(0,300));
   if(s.indexOf('"changes":[]')<0) break; } }
 console.log('FINAL '+String(await m.eval('window.__probe.stat()')).slice(0,500));
 await m.close();})();
