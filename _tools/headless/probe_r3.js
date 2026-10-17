const fs=require('fs');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_r3.js','utf8');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl(); await m.eval(SRC);
 for(let i=0;i<900;i++){ await m.eval('window.__r3.step('+i+')'); await m.pump(1,{yieldMs:0}); }
 console.log('R3 '+String(await m.eval('window.__r3.stat()')).slice(0,400));
 await m.close();})();
