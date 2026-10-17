const {Match}=require('./match');
const INSTALL=[
 "(function(){var br={};",
 " br.mk=function(t){return {name:'nnbridge'+t,isReady:function(){return true;},",
 "   decide:function(){return (t==='B'?window.__nnBundleB:window.__nnBundleA)||null;}};};",
 " br.setup=function(){var A=VantageTreeInterface.Agents;A.register(br.mk('A'),'A');A.register(br.mk('B'),'B');",
 "   A.use('nnbridgeA','A');A.use('nnbridgeB','B');return 'ok';};",
 " br.nodes=function(){try{var t=VantageTree.getTree();var r=VantageTree.collectAgentNodes(t);var a=Array.isArray(r)?r:[];",
 "   var grow=null,root=null;for(var i=0;i<a.length;i++){var o=a[i];if(!o)continue;",
 "     if(grow===null&&o.hasGrown===false&&!o.invalid&&!o.exhausted)grow=o.id;",
 "     if(root===null&&(o.depth===0||o.parentId===null))root=o.id;}",
 "   window.__gId=grow;window.__rId=root;return JSON.stringify({n:a.length,grow:grow,root:root,keys:a[0]?Object.keys(a[0]).slice(0,20):null});}catch(e){return 'err';}};",
 " br.inject=function(k){var ok=0;",
 "   window.__nnBundleA=(window.__gId===null||window.__gId===undefined)?null:{picks:[{nodeId:window.__gId,back:0}],memory:{nntag:'M1',step:k}};",
 "   window.__nnBundleB=(window.__rId===null||window.__rId===undefined)?null:{picks:[{nodeId:window.__rId,back:0}]};",
 "   if(window.__nnBundleA)ok++;if(window.__nnBundleB)ok++;return ok;};",
 " br.memA=function(){try{var t=VantageTree.getTree();return JSON.stringify(t._agentMemoryA||null).slice(0,120);}catch(e){return 'err';}};",
 " br.stat=function(){var g=window.__vantageIface||{};return JSON.stringify({callsA:g.callsA,callsB:g.callsB,picks:g.picks,growAt:g.growAt,giveUpA:g.giveUpA,giveUpB:g.giveUpB,skipped:g.skipped});};",
 " window.__br=br;return 'installed';})()"].join("\n");
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1,rng:'record',rngMode:'record'});
 await m.clearControl(); await m.eval(INSTALL); console.log('SETUP '+String(await m.eval('window.__br.setup()')).slice(0,20));
 await m.pump(5,{yieldMs:0}); console.log('NODES '+String(await m.eval('window.__br.nodes()')).slice(0,300));
 let mem0=null,mem1=null;
 for(let i=0;i<100;i++){ await m.eval('window.__candA='+i); await m.eval('window.__br.inject('+i+')');
  await m.pump(1,{yieldMs:0});
  if(i===20) mem0=String(await m.eval('window.__br.memA()'));
  if(i===21) mem1=String(await m.eval('window.__br.memA()'));
  if(i%40===39) console.log('S '+String(await m.eval('window.__br.stat()')).slice(0,240));
 }
 console.log('MEM_AT20 '+String(mem0).slice(0,120));
 console.log('MEM_AT21 '+String(mem1).slice(0,120));
 console.log('FINAL '+String(await m.eval('window.__br.stat()')).slice(0,240));
 await m.close();})();
