const fs=require('fs');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_resid.js','utf8');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl(); await m.eval(SRC); await m.eval('window.__probe.setup()');
 for(let i=0;i<3500;i++){ await m.eval('window.__probe.step('+i+')'); await m.pump(1,{yieldMs:0}); }
 console.log('AFTER3200 '+String(await m.eval('window.__probe.logAfter(3200)')).slice(0,700));
 const g=await m.eval('JSON.stringify({callsA:(window.__vantageIface||{}).callsA,callsB:(window.__vantageIface||{}).callsB})');
 console.log('GATE '+String(g).slice(0,120));
 await m.close();})();
