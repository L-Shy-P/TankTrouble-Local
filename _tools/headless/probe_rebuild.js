const {Match}=require('./match');
const TICK=`(function(){var e=VantageObserve.encode({adapter:VantageSandbox.createAdapter(GameManager.getGameController(),'tank_a'),tree:null,horizonSec:10,K_death:1,frameDt:1/60});
 return JSON.stringify({t:e.dims.total,node:e.dims.node,bullet:e.dims.bullet,global:e.dims.global,storm:e.dims.storm,plan:e.dims.plan,g:e.global.globalTok.length,o:(e.global.oppTok||[]).length});})()`;
(async()=>{const t0=Date.now();const A=new Match();
 await A.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rng:'record',rngMode:'record'});
 await A.clearControl(); let last=null;
 for(let i=0;i<120;i++){ await A.pump(1,{yieldMs:0}); if(i===119) last=await A.eval(TICK); }
 const sites=await A.eval('JSON.stringify(window.__vtRng.dumpSites())');
 const seq=await A.eval('JSON.stringify(window.__vtRng.dump())'); await A.close();
 const tRec=Date.now();
 const B=new Match(); await B.open({humanIds:['tank_a'],aiCount:2,vantCount:0,rngSites:JSON.parse(sites),rngSeq:JSON.parse(seq)});
 await B.clearControl(); let lastRep=null;
 for(let i=0;i<120;i++){ await B.pump(1,{yieldMs:0}); if(i===119) lastRep=await B.eval(TICK); }
 await B.close();
 console.log('REBUILD_ENC '+String(lastRep).slice(0,220));
 console.log('SAME_AS_REC '+(String(last)===String(lastRep)));
 console.log('WALL_MS rec_plus_replay '+(Date.now()-t0)+' (120 frames x2)');
})();
