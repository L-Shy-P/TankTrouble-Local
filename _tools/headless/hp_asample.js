const fs=require('fs');const {Match}=require('./match');
const TAG=process.env.TAG||'hp', FRAMES=Number(process.env.FRAMES||60);
(async()=>{const m=new Match();await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.pump(FRAMES,{yieldMs:0});
 const probe=await m.eval(`(function(){var o={};var gc=GameManager.getGameController();var ad=VantageSandbox.createAdapter(gc,'tank_a');
  o.adapterFn=Object.keys(ad);
  var tk=ad.getTanks();var pid=null;for(var k in tk){if(k!=='tank_a'){pid=k;break;}}
  o.pid=pid;var t=tk[pid];
  if(t){ o.tankKeys=Object.keys(t).filter(function(n){return /health|hp|life|live|dead|alive|kill|score/i.test(n);}).slice(0,20);
   o.hpTry={};
   ['getHealth','getHp','getHP','getLives','getLife','getRemainingHealth','getIsAlive','isAlive','getDead'].forEach(function(n){
    try{o.hpTry[n]=(typeof t[n]==='function')?JSON.stringify(t[n]()).slice(0,40):(typeof t[n]);}catch(e){o.hpTry[n]='err:'+String(e.message||e).slice(0,40);}});
   var p=null;try{p=t.getPrototype&&t.getPrototype();}catch(e){}
   try{o.protoNames=Object.getOwnPropertyNames(Object.getPrototypeOf(t)).filter(function(n){return /health|hp|life|live|dead/i.test(n);}).slice(0,15);}catch(e){o.protoErr=String(e.message||e).slice(0,60);}
  }
  try{var tr=(typeof VantageTree.getTree==='function')?VantageTree.getTree():null;o.treeEmpty=!tr;
   if(tr){var t0=Date.now();var a=VantageTree.collectAgentNodes(tr);o.aMs=Date.now()-t0;o.aLen=JSON.stringify(a).length;}
  }catch(e){o.treeErr=String(e.message||e).slice(0,80);}
  return JSON.stringify(o);})()`);
 console.log('HP '+probe.slice(0,1500));
 fs.writeFileSync('D:/vt_run/datasets/hp_'+TAG+'.json',probe);
 await m.close();})();
