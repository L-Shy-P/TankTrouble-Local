const { Match } = require('../headless/match');
(async()=>{
 const m=new Match();
 await m.open({players:2,control:false});
 await m.pump(60);
 const P = `(function(){ var gc=GameManager.getGameController(); var g=GameManager.getGame(); var t=gc.getTanks?gc.getTanks():{};
   var ks=Object.keys(t||{}); var o=[];
   for (var i=0;i<ks.length;i++){ var s=t[ks[i]]; try{ var d=s.getState?s.getState():null; }catch(e){}
     var raw = (s.constructor&&s.constructor.name)||''; o.push(ks[i]+':'+raw); }
   // 用"坦克在动"当探针：取全部坦克坐标
   var pos={}; for (var i=0;i<ks.length;i++){ var tn=t[ks[i]]; try{ pos[ks[i]] = (tn.getTransform? (tn.getTransform().x.toFixed(3)+','+tn.getTransform().y.toFixed(3)) : null); }catch(e){ pos[ks[i]]='err'; } }
   return JSON.stringify({ pos: pos, paused: g.paused, t: g.time? g.time.now : null }); })()`;
 const snap = async () => JSON.parse(await m.eval(P));
 const a0 = await snap(); await m.pump(10); const a1 = await snap();
 console.log('baseline   ', JSON.stringify(a0.pos), '->', JSON.stringify(a1.pos));
 const cands = [
   ['g.paused=true', 'g.paused=true', 'g.paused=false'],
   ['g.time.paused=true', 'g.time.paused=true', 'g.time.paused=false'],
   ['activeState.pause()', 'if(g.state&&g.state.activeState&&g.state.activeState.pause) g.state.activeState.pause()', 'if(g.state&&g.state.activeState&&g.state.activeState.resume) g.state.activeState.resume()'],
   ['g.physics.paused=true', 'g.physics.paused=true', 'g.physics.paused=false'],
 ];
 for (const [name,on,off] of cands){
   const r = await m.eval(`(function(){ var g=GameManager.getGame(); try{ ${on}; return 'ok'; }catch(e){ return String(e); } })()`);
   const c0 = await snap(); await m.pump(10); const c1 = await snap();
   const moved = JSON.stringify(c0.pos) !== JSON.stringify(c1.pos);
   console.log((name+'                    ').slice(0,22), 'set='+r, 'moved='+moved, JSON.stringify(c1.pos));
   await m.eval(`(function(){ var g=GameManager.getGame(); try{ ${off}; }catch(e){} return 1; })()`);
   await m.pump(5);
 }
 await m.close();
})().catch(e=>{console.error(e);process.exit(1)});
