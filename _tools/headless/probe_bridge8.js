const {Match}=require('./match');
const INSTALL=[
 "(function(){var br={};",
 " br.mk=function(t){return {name:'nnbridge'+t,isReady:function(){return true;},",
 "   decide:function(){return (t==='B'?window.__nnBundleB:window.__nnBundleA)||null;}};};",
 " br.setup=function(){var A=VantageTreeInterface.Agents;A.register(br.mk('A'),'A');A.register(br.mk('B'),'B');",
 "   A.use('nnbridgeA','A');A.use('nnbridgeB','B');return 'ok';};",
 " br.frame=function(k){try{var t=VantageTree.getTree();var r=VantageTree.collectAgentNodes(t);var a=Array.isArray(r)?r:[];",
 "   var grow=null,root=null;for(var i=0;i<a.length;i++){var o=a[i];if(!o)continue;",
 "     if(grow===null&&o.hasGrown===false&&!o.invalid&&!o.exhausted)grow=o.id;",
 "     if(root===null&&o.depth===0)root=o.id;}",
 "   window.__nnBundleA=(grow===null)?null:{picks:[{nodeId:grow,back:0}],memory:{nntag:'M1',step:k}};",
 "   window.__nnBundleB=(root===null)?null:{select:root};",
 "   return JSON.stringify({grow:grow,root:root});}catch(e){return 'err';}};",
 " br.stat=function(){var g=window.__vantageIface||{};var t=VantageTree.getTree();var st=(t&&t.stats)||{};",
 "   return JSON.stringify({callsA:g.callsA,callsB:g.callsB,picks:g.picks,growAt:g.growAt,giveUpA:g.giveUpA,giveUpB:g.giveUpB,",
 "     skipped:g.skipped,memA:JSON.stringify(t._agentMemoryA||null).slice(0,90),freshRoots:st.freshRoots,rebuilds:st.rebuilds});};",
 " window.__br=br;return 'installed';})()"].join("\n");
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1,rng:'record',rngMode:'record'});
 await m.clearControl(); await m.eval(INSTALL); console.log('SETUP '+String(await m.eval('window.__br.setup()')).slice(0,20));
 let seen=null;
 for(let i=0;i<150;i++){ const fr=String(await m.eval('window.__br.frame('+i+')'));
  if(i===0) console.log('FR0 '+fr.slice(0,80));
  await m.pump(1,{yieldMs:0});
  if(i%50===49||i===149){ const st=String(await m.eval('window.__br.stat()')); console.log('S '+st.slice(0,260)); } }
 await m.close();})();
