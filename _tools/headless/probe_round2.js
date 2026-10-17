const fs=require('fs');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_round2.js','utf8');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl(); await m.eval(SRC);
 for(let i=0;i<900;i++){ await m.eval('window.__q.step('+i+')'); await m.pump(1,{yieldMs:0}); }
 console.log('R2 '+String(await m.eval('window.__q.stat()')).slice(0,700));
 await m.close();})();
