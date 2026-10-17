const fs=require('fs');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_seg4.js','utf8');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl(); console.log('EVAL '+String(await m.eval(SRC)).slice(0,20));
 for(let i=0;i<600;i++){ await m.eval('window.__s4.step()'); await m.pump(1,{yieldMs:0}); }
 console.log('SEG4 '+String(await m.eval('window.__s4.stat()')).slice(0,400));
 await m.close();})();
