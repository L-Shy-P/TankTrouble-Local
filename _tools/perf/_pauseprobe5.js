const { Match } = require('../headless/match');
(async()=>{
 const m=new Match();
 await m.open({players:2,control:false});
 await m.pump(80);
 const snap = async () => (await m.snapshot()).tanks.map(t=>t.id+'@'+t.x.toFixed(3)+','+t.y.toFixed(3)).join(' | ');
 const a0=await snap(); await m.pump(10); const a1=await snap();
 console.log('baseline            moved='+(a0!==a1)+'  '+a1);
 for (const [name,on,off] of [
   ['g.paused=true', 'g.paused=true', 'g.paused=false'],
   ['g.time.paused=true', 'g.time.paused=true', 'g.time.paused=false'],
   ['activeState.pause', 'if(g.state&&g.state.activeState&&g.state.activeState.pause) g.state.activeState.pause()', 'if(g.state&&g.state.activeState&&g.state.activeState.resume) g.state.activeState.resume()'],
   ['physics.paused=true', 'g.physics.paused=true', 'g.physics.paused=false'],
   ['stage.pause? noop', '', ''],
 ]) {
   if(!on) continue;
   const r = await m.eval(`(function(){ var g=GameManager.getGame(); try{ ${on}; return 'ok'; }catch(e){ return String(e); } })()`);
   const c0=await snap(); await m.pump(10); const c1=await snap();
   console.log((name+'                    ').slice(0,20),'set='+r,'moved='+(c0!==c1)+'  '+c1);
   await m.eval(`(function(){ var g=GameManager.getGame(); try{ ${off}; }catch(e){} return 1; })()`);
   await m.pump(5);
 }
 const d0=await snap(); await m.pump(10); const d1=await snap();
 console.log('after all resume    moved='+(d0!==d1));
 await m.close();
})().catch(e=>{console.error(e);process.exit(1)});
