const { Match } = require('../headless/match');
(async()=>{
 const m=new Match();
 await m.open({players:2,control:false});
 await m.pump(30);
 const r = await m.eval(`(() => {
   var out={};
   try{ out.gmType = typeof GameManager; out.gmKeys = Object.keys(GameManager).slice(0,40); }catch(e){ out.gmErr=String(e); }
   var g=null; try{ g=GameManager.getGame(); }catch(e){ out.gameErr=String(e); }
   if(g){
     out.gameKeys=Object.keys(g).slice(0,40);
     out.loopType=typeof g.loop;
     if(g.loop) out.loopKeys=Object.keys(g.loop).slice(0,30).concat(['running='+g.loop.running,'isRunning='+g.loop.isRunning,'sleep='+typeof g.loop.sleep,'wake='+typeof g.loop.wake,'stop='+typeof g.loop.stop,'start='+typeof g.loop.start,'pause='+typeof g.loop.pause,'resume='+typeof g.loop.resume]);
     out.sceneMgr=typeof g.scene;
     if(g.scene) out.sceneKeys=Object.keys(g.scene).slice(0,20).concat(['pause='+typeof (g.scene&&g.scene.pause),'resume='+typeof (g.scene&&g.scene.resume),'getScenes='+typeof (g.scene&&g.scene.getScenes)]);
     out.loopRunning = g.loop ? g.loop.running : null;
     out.paused = g.isPaused !== undefined ? g.isPaused : undefined;
   }
   try{ out.gcKeys = Object.keys(GameManager.getGameController()||{}).slice(0,40); }catch(e){ out.gcErr=String(e); }
   return JSON.stringify(out,null,1);
 })()`);
 console.log(r);
 await m.close();
})().catch(e=>{console.error(e);process.exit(1)});
