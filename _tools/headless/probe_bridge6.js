const {Match}=require('./match');
const INSTALL=[
 "(function(){var br={};",
 " br.mk=function(t){return {name:'nnbridge'+t,isReady:function(){return true;},",
 "   decide:function(){return (t==='B'?window.__nnBundleB:window.__nnBundleA)||null;}};};",
 " br.setup=function(){var A=VantageTreeInterface.Agents;A.register(br.mk('A'),'A');A.register(br.mk('B'),'B');",
 "   A.use('nnbridgeA','A');A.use('nnbridgeB','B');return 'ok';};",
 " br.pickA=function(){try{var t=VantageTree.getTree();var r=VantageTree.collectAgentNodes(t);var a=Array.isArray(r)?r:[];",
 "   var cands=[];for(var i=0;i<a.length;i++){var o=a[i];if(!o)continue;",
 "     if(o.hasGrown===false&&!o.invalid&&!o.exhausted)cands.push(o.id);}",
 "   window.__candA=cands.length; return cands.length?cands[cands.length-1]:null;}catch(e){return null;}};",
 " br.injectA=function(){var id=window.__candA_id||null;window.__nnBundleA=id===null?null:{picks:[{nodeId:id,back:0}],memory:{nntag:'M1'}};return id===null?0:1;};",
 " br.mem=function(){try{var t=VantageTree.getTree();var o={};",
 "   o.hasA=!!(t&&t._agentDecision);o.hasB=!!(t&&t._agentDecisionB);",
 "   if(t&&t._agentDecision)o.Amem=JSON.stringify(t._agentDecision.memory||null).slice(0,80);",
 "   if(t&&t._agentDecision)o.Akeys=Object.keys(t._agentDecision).slice(0,10);",
 "   return JSON.stringify(o);}catch(e){return 'err';}};",
 " window.__br=br;return 'installed';})()"].join("\n");
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1,rng:'record',rngMode:'record'});
 await m.clearControl(); await m.eval(INSTALL); console.log('SETUP '+String(await m.eval('window.__br.setup()')).slice(0,40));
 let cands=0,inj=0;let last=null;
 for(let i=0;i<120;i++){ const p=await m.eval('window.__br.pickA()');
  if(p!==null&&p!==undefined){ await m.eval('window.__candA_id='+Number(p)); cands++; }
  else await m.eval('window.__candA_id=null');
  const r=await m.eval('window.__br.injectA()'); if(Number(r)===1)inj++;
  await m.pump(1,{yieldMs:0});
  if(i===5||i===6) console.log('MEM_'+i+' '+String(await m.eval('window.__br.mem()')).slice(0,260));
  if(i===119){ last=String(await m.eval('JSON.stringify(window.__br.stat?window.__br.stat():{})')); }
 }
 const g=JSON.parse(await m.eval('JSON.stringify({callsA:(window.__vantageIface||{}).callsA,callsB:(window.__vantageIface||{}).callsB,picks:(window.__vantageIface||{}).picks,growAt:(window.__vantageIface||{}).growAt,giveUpA:(window.__vantageIface||{}).giveUpA,giveUpB:(window.__vantageIface||{}).giveUpB,skipped:(window.__vantageIface||{}).skipped})'));
 console.log('GATE '+JSON.stringify(g));
 console.log('CANDS '+cands+' INJECTA_OK '+inj+'/120');
 console.log('MEM_FINAL '+String(await m.eval('window.__br.mem()')).slice(0,260));
 await m.close();})();
