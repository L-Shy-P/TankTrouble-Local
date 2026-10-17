const fs=require('fs');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_wrap.js','utf8');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1,rng:'record',rngMode:'record'});
 await m.clearControl(); console.log('EVAL '+String(await m.eval(SRC)).slice(0,20));
 console.log('SETUP '+String(await m.eval('window.__probe.setup()')).slice(0,20));
 for(let i=0;i<40;i++){ await m.eval('window.__probe.frame('+i+')'); await m.pump(1,{yieldMs:0}); }
 const g=JSON.parse(await m.eval('JSON.stringify({callsA:(window.__vantageIface||{}).callsA,callsB:(window.__vantageIface||{}).callsB,giveUpA:(window.__vantageIface||{}).giveUpA,giveUpB:(window.__vantageIface||{}).giveUpB})'));
 console.log('GATE '+JSON.stringify(g));
 console.log('WRAPLOG '+String(await m.eval('window.__probe.log()')).slice(0,400));
 console.log('RESTORE '+String(await m.eval('window.__probe.restore()')).slice(0,20));
 await m.close();})();
