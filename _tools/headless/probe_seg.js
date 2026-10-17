const fs=require('fs');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_seg.js','utf8');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl(); console.log('EVAL '+String(await m.eval(SRC)).slice(0,20));
 for(let i=0;i<200;i++){ await m.eval('window.__seg.step()'); await m.pump(1,{yieldMs:0}); }
 console.log('SEG '+String(await m.eval('window.__seg.stat()')).slice(0,200));
 await m.close();})();
