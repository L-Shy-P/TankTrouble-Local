const fs=require('fs');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_mem.js','utf8');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1,rng:'record',rngMode:'record'});
 await m.clearControl(); console.log('EVAL '+String(await m.eval(SRC)).slice(0,20));
 console.log('SETUP '+String(await m.eval('window.__probe.setup()')).slice(0,20));
 for(let i=0;i<60;i++){ await m.eval('window.__probe.frame('+i+')'); await m.pump(1,{yieldMs:0});
  if(i===30||i===59) console.log('IDENT '+String(await m.eval('window.__probe.ident()')).slice(0,420)); }
 const g=JSON.parse(await m.eval('JSON.stringify({callsA:(window.__vantageIface||{}).callsA,callsB:(window.__vantageIface||{}).callsB,giveUpA:(window.__vantageIface||{}).giveUpA,giveUpB:(window.__vantageIface||{}).giveUpB,skipped:(window.__vantageIface||{}).skipped})'));
 console.log('GATE '+JSON.stringify(g));
 await m.close();})();
