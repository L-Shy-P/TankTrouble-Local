const {Match}=require('./match');
const FR=Number(process.env.FRAMES||300);
const INSTALL=[
 "(function(){",
 " var br={};",
 " br.mk=function(tag){ return { name:'nnbridge'+tag, isReady:function(){return true;},",
 "   decide:function(){ return (tag==='B'?window.__nnBundleB:window.__nnBundleA)||null; } }; };",
 " br.setup=function(){ var A=VantageTreeInterface.Agents;",
 "   A.register(br.mk('A'),'A'); A.register(br.mk('B'),'B');",
 "   A.use('nnbridgeA','A'); A.use('nnbridgeB','B');",
 "   return JSON.stringify({ a:String((A.current('A')||{}).name), b:String((A.current('B')||{}).name) }); };",
 " br.val=function(){ var o={};",
 "   try{ o.bundle=String(VantageTreeInterface.validateBundle).slice(0,500); }catch(e){o.bundle='err';}",
 "   try{ o.decision=String(VantageTreeInterface.validateDecision).slice(0,320); }catch(e){o.decision='err';}",
 "   return JSON.stringify(o); };",
 " br.inject=function(){ try{ var t=VantageTree.getTree(); if(!t) return 0;",
 "   var r=VantageTree.collectAgentNodes(t); var arr=Array.isArray(r)?r:[];",
 "   var id=null; for(var i=0;i<arr.length;i++){ if(arr[i]&&arr[i].id!==undefined&&arr[i].id!==null){ id=arr[i].id; break; } }",
 "   window.__nnId=id;",
 "   window.__nnBundleA = (id===null)?null:{ picks:[{nodeId:id}] };",
 "   window.__nnBundleB = (id===null)?null:{ picks:[{nodeId:id}] };",
 "   return id===null?0:1; }catch(e){ return -1; } };",
 " br.stat=function(){ var o={}; try{ var g=window.__vantageIface||{};",
 "   o.callsA=g.callsA; o.callsB=g.callsB; o.picks=g.picks; o.growAt=g.growAt; o.rejected=g.rejected;",
 "   o.skipped=g.skipped; o.giveUpA=g.giveUpA; o.tSF=g.tickSkippedFull; o.id=window.__nnId;",
 "   var t=VantageTree.getTree(); var st=(t&&t.stats)||{}; o.expands=st.expands; o.commits=st.commits;",
 "   var d=JSON.stringify(VantageTree.dumpDiagnostics(t)); var m2=d.match(/agent-silent-no-grow/g); o.silent=m2?m2.length:0;",
 " }catch(e){ o.err=String(e.message||e).slice(0,60); } return o; };",
 " window.__br=br; return 'installed'; })()"].join("\n");
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1,rng:'record',rngMode:'record'});
 await m.clearControl();
 console.log('INSTALL '+String(await m.eval(INSTALL)).slice(0,40));
 console.log('SETUP '+String(await m.eval('window.__br.setup()')).slice(0,120));
 console.log('VAL '+String(await m.eval('window.__br.val()')).slice(0,900));
 let ok=0;
 for(let i=0;i<FR;i++){ const r=await m.eval('window.__br.inject()'); if(Number(r)===1)ok++;
  await m.pump(1,{yieldMs:0});
  if(i%75===74||i===FR-1){ const s=String(await m.eval('JSON.stringify(window.__br.stat())')); console.log('S '+s.slice(0,260)); } }
 console.log('INJECT_OK '+ok+'/'+FR);
 await m.close();})();
