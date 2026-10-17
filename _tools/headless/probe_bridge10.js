const fs=require('fs');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_bridge.js','utf8');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1,rng:'record',rngMode:'record'});
 await m.clearControl();
 console.log('EVAL '+String(await m.eval(SRC)).slice(0,30));
 console.log('SETUP '+String(await m.eval('window.__probe.setup()')).slice(0,90));
 for(let i=0;i<120;i++){ await m.eval('window.__probe.frame('+i+')'); await m.pump(1,{yieldMs:0});
  if(i===1) console.log('INJ '+String(await m.eval('JSON.stringify(window.__lastInj)')).slice(0,200));
  if(i%40===39||i===119) console.log('S '+String(await m.eval('window.__probe.stat()')).slice(0,330)); }
 await m.close();})();
