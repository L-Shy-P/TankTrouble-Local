const { Match } = require('../headless/match');
(async()=>{
 const m=new Match();
 await m.open({players:2,control:false});
 await m.pump(30);
 await m.eval(`window.__pp = { probe: function(){ var g=GameManager.getGame(); var gc=GameManager.getGameController();
   return { t: g.time? g.time.now : null, upd: g.updatesThisFrame, paused: g.paused, timePaused: g.time? g.time.paused : null,
            state: gc? gc.getState() : null, rs: (gc&&gc.getRoundState)? (gc.getRoundState()||{}).time : null }; } }; 1`);
 const snap = async () => JSON.parse(await m.eval('JSON.stringify(window.__pp.probe())'));
 const pump = async (n) => m.pump(n);
 const a0 = await snap(); await pump(5); const a1 = await snap();
 console.log('baseline      ', JSON.stringify(a0), '->', JSON.stringify(a1));
 for (const cand of ['g.paused=true', 'g.time.paused=true', 'g.physics.paused=true']) {
   await m.eval(`(function(){ var g=GameManager.getGame(); ${cand}; return 1; })()`);
   const b0 = await snap(); await pump(5); const b1 = await snap();
   console.log((cand+'        ').slice(0,14), JSON.stringify(b0), '->', JSON.stringify(b1));
   await m.eval(`(function(){ var g=GameManager.getGame(); g.paused=false; g.time.paused=false; if(g.physics) g.physics.paused=false; return 1; })()`);
   await pump(2);
 }
 await m.close();
})().catch(e=>{console.error(e);process.exit(1)});
