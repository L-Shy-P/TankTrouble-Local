const {Match}=require('./match');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl();
 const info=JSON.parse(await m.eval(`(function(){var o={};try{var g=GameManager.getGame&&GameManager.getGame();
   o.hasGame=!!g; o.renderer=g&&g.renderer?g.renderer.type:'none'; o.stage=!!(g&&g.stage);
   o.loop=g&&g.loop?{running:g.loop.running,isRunning:g.loop.isRunning}:null;
   o.raf=typeof window.requestAnimationFrame; o.webgl=!!(window.WebGLRenderingContext);
   o.dpr=window.devicePixelRatio; o.canvas=document.querySelectorAll('canvas').length;
   o.forceCanvas=g&&g.canvas?{w:g.canvas.width,h:g.canvas.height}:null;}catch(e){o.err=String(e.message||e).slice(0,50);}return JSON.stringify(o);})()`));
 console.log('GAME '+JSON.stringify(info).slice(0,300));
 // 基准：正常跑 120 帧
 let t0=Date.now(); await m.pump(120,{yieldMs:0}); const normal=Date.now()-t0;
 // 运行时停渲染（可还原）
 const stopped=await m.eval(`(function(){try{var g=GameManager.getGame();window.__origRender=g.renderer.render.bind(g.renderer);
   g.renderer.render=function(){};g.renderer.postRender=function(){};
   return 'stopped';}catch(e){return 'err:'+String(e.message||e).slice(0,40);}})()`);
 let t1=Date.now(); await m.pump(120,{yieldMs:0}); const noRender=Date.now()-t1;
 const restored=await m.eval(`(function(){try{var g=GameManager.getGame();g.renderer.render=window.__origRender;return 'restored';}catch(e){return 'err';}})()`);
 console.log('STOP '+String(stopped).slice(0,40)+'  RESTORE '+String(restored).slice(0,20));
 console.log('PUMP_120 normal_ms='+normal+' noRender_ms='+noRender+' speedup='+(normal/noRender).toFixed(2)+'x  perFrame '+(normal/120).toFixed(2)+' -> '+(noRender/120).toFixed(2)+' ms');
 await m.close();})();
