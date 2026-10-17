const {Match}=require('./match');
const INSTALL=[
 "(function(){var br={};",
 " br.mk=function(t){return {name:'nnbridge'+t,isReady:function(){return true;},",
 "   decide:function(){return (t==='B'?window.__nnBundleB:window.__nnBundleA)||null;}};};",
 " br.setup=function(){var A=VantageTreeInterface.Agents;A.register(br.mk('A'),'A');A.register(br.mk('B'),'B');",
 "   A.use('nnbridgeA','A');A.use('nnbridgeB','B');return 'ok';};",
 " br.frame=function(k){try{var t=VantageTree.getTree();var r=VantageTree.collectAgentNodes(t);var a=Array.isArray(r)?r:[];",
 "   var grow=null,deep=null;for(var i=0;i<a.length;i++){var o=a[i];if(!o)continue;",
 "     if(grow===null&&o.hasGrown===false&&!o.invalid&&!o.exhausted)grow=o.id;",
 "     if(deep===null&&o.depth>=1&&!o.invalid&&!o.exhausted)deep=o.id;}",
 "   window.__nnBundleA=(grow===null)?null:{picks:[{nodeId:grow,back:0}],memory:{nntag:'M1',step:k}};",
 "   window.__nnBundleB=(deep===null)?null:{picks:[{nodeId:deep,back:0}],memory:{nntag:'B1',step:k}};",
 "   window.__lastInj={grow:grow,deep:deep,A:window.__nnBundleA,B:window.__nnBundleB};",
 "   return JSON.stringify({grow:grow,deep:deep});}catch(e){return 'err';}};",
 " br.stat=function(){var g=window.__vantageIface||{};var t=VantageTree.getTree();var st=(t&&t.stats)||{};",
 "   return JSON.stringify({callsA:g.callsA,callsB:g.callsB,picks:g.picks,giveUpA:g.giveUpA,giveUpB:g.giveUpB,skipped:g.skipped,",
 "     memShared:JSON.stringify(t._agentMemory||null).slice(0,80),memA:JSON.stringify(t._agentMemoryA||null).slice(0,80),
 "     memB:JSON.stringify(t._agentMemoryB||null).slice(0,80),freshRoots:st.freshRoots});};",
 " window.__br=br;return 'installed';})()"].join("\n");
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1,rng:'record',rngMode:'record'});
 await m.clearControl(); await m.eval(INSTALL); console.log('SETUP '+String(await m.eval('window.__br.setup()')).slice(0,20));
 for(let i=0;i<120;i++){ await m.eval('window.__br.frame('+i+')'); await m.pump(1,{yieldMs:0});
  if(i===1) console.log('INJ_AT1 '+String(await m.eval('JSON.stringify(window.__lastInj)')).slice(0,260));
  if(i%40===39||i===119) console.log('S '+String(await m.eval('window.__br.stat()')).slice(0,300)); }
 await m.close();})();
