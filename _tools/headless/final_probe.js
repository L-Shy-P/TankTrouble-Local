const fs=require('fs');const {Match}=require('./match');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl();
 await m.pump(60,{yieldMs:0});
 const out=await m.eval(`(function(){var o={};
  try{var gc=GameManager.getGameController();o.gcKeys=Object.keys(gc).filter(function(k){return /round|end|win|dead|state|score/i.test(k);});
   var p=Object.getPrototypeOf(gc);o.gcProtoM=p.getOwnPropertyNames(p).filter(function(k){return /round|end|win|dead|state|score/i.test(k);}).slice(0,25);
   try{o.roundState=gc.roundController?JSON.stringify(gc.roundController.getRoundState(true)).slice(0,300):'no roundController';}catch(e){o.roundStateErr=String(e.message||e);}
   try{o.gameState=String(gc.getGameState&&gc.getGameState());}catch(e){}
   try{o.ttGameKeys=gc.game?Object.keys(gc.game).filter(function(k){return /round|end|win|player|score/i.test(k);}).slice(0,20):null;}catch(e){}
   var ad=VantageSandbox.createAdapter(gc,'tank_a');o.adapterFn=Object.keys(ad);
   o.roundLike={};['getRoundState','getRoundNumber','isRoundOver','getAlivePlayers','getScores','getGamePhase'].forEach(function(n){try{if(typeof ad[n]==='function')o.roundLike[n]=JSON.stringify(ad[n]()).slice(0,120);else o.roundLike[n]='absent';}catch(e){o.roundLike[n]='err:'+String(e.message||e);}});
  }catch(e){o.err=String(e.message||e);}
  try{o.vantage={hasTree:!!window.VantageTree,treeKeys:window.VantageTree?Object.keys(window.VantageTree).slice(0,20):null,
   managerKeys:(window.VantageAIManager?Object.keys(window.VantageAIManager):null),
   aiMgr:Object.keys(window).filter(function(k){return /vantage|Vantage/i.test(k);}).slice(0,12)};}catch(e){o.vErr=String(e.message||e);}
  return JSON.stringify(o);})()`);
 console.log('PROBE '+out.slice(0,1900));
 fs.writeFileSync('D:/vt_run/datasets/final_probe.json',out);
 await m.close();})();
