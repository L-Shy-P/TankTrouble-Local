const { Match } = require('../headless/match');
(async()=>{
 const m=new Match();
 await m.open({players:2,control:false});
 await m.eval('window.__g1 = window.__g1 || {}; 1');
 await m.pump(40);
 const IF = `(function(){ var I=window.__vantageIface||{}; var g=GameManager.getGame(); return JSON.stringify({calls:I.calls, callsA:I.callsA, shots: (window.__ppShots||0), paused:g.paused, tpaused:g.time?g.time.paused:null, physPaused: g.physics? g.physics.paused: null}); })()`;
 const snap = async () => JSON.parse(await m.eval(IF));
 console.log('baseline        ', JSON.stringify(await snap()));
 await m.pump(5); console.log('  after 5 pump  ', JSON.stringify(await snap()));
 const cands = [
   ['g.paused=true', 'g.paused=true', 'g.paused=false'],
   ['g.time.paused=true', 'g.time.paused=true', 'g.time.paused=false'],
   ['state.pause', 'if(g.state&&g.state.activeState&&g.state.activeState.pause) g.state.activeState.pause()', 'if(g.state&&g.state.activeState&&g.state.activeState.resume) g.state.activeState.resume()'],
   ['gc.gameMode.pause', '', ''],
   ['g.physics.paused', 'g.physics.paused=true', 'g.physics.paused=false'],
 ];
 for (const [name, on, off] of cands) {
   if (!on) continue;
   const okOn = await m.eval(`(function(){ var g=GameManager.getGame(); try{ ${on}; return 'ok'; }catch(e){ return String(e); } })()`);
   const c0 = await snap(); await m.pump(5); const c1 = await snap();
   console.log((name+'               ').slice(0,16), 'set='+okOn, JSON.stringify(c0), '->', JSON.stringify(c1), 'Δcalls=', (c1.calls-c0.calls));
   await m.eval(`(function(){ var g=GameManager.getGame(); try{ ${off}; }catch(e){} return 1; })()`);
   await m.pump(3);
 }
 await m.close();
})().catch(e=>{console.error(e);process.exit(1)});
