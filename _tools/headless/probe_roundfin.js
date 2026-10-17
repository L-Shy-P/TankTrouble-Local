const fs=require('fs');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_players.js','utf8');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl(); await m.eval(SRC);
 await m.eval('window.__probe.setup()');
 for(let i=0;i<3600;i++){ await m.eval('window.__probe.step('+i+')'); await m.pump(1,{yieldMs:0}); }
 // 按新纪律：分字段取，不切片
 const n=await m.eval('String(window.__probe.n)');
 const nEv=await m.eval('String(window.__probe.ev.length)');
 const roundEv=await m.eval("JSON.stringify(window.__probe.ev.filter(function(e){return /ROUND|CELEBRATION/i.test(e.evt);}))");
 const first5=await m.eval("JSON.stringify(window.__probe.ev.slice(0,5))");
 const last5=await m.eval("JSON.stringify(window.__probe.ev.slice(-5))");
 const st=await m.eval('String(window.__probe.started)');
 const rn=await m.eval('String(window.__probe.running)');
 const dth=await m.eval('String(window.__probe.deaths)');
 const tp=await m.eval('String(window.__probe.totalPlayersNow)');
 console.log('N='+n+' nEvents='+nEv);
 console.log('STARTED='+st+' RUNNING='+rn+' DEATHS='+dth+' PLAYERS='+tp);
 console.log('ROUND_EVENTS='+String(roundEv).slice(0,500));
 console.log('FIRST5='+String(first5).slice(0,200));
 console.log('LAST5='+String(last5).slice(0,300));
 await m.close();})();
