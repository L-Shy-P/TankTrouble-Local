const {Match}=require('./match');
const FR=Number(process.env.FRAMES||300);
const INSTALL=[
 "(function(){",
 " var br={};",
 " br.setup=function(){",
 "  var mk=function(tag){ return { name:'nnbridge'+tag, isReady:function(){return true;},",
 "    decide:function(){ return (tag==='B'?window.__nnBundleB:window.__nnBundleA)||null; } }; };",
 "  var A=VantageTreeInterface.Agents;",
 "  A.register('nnbridgeA', mk('A')); A.register('nnbridgeB', mk('B'));",
 "  A.use('nnbridgeA','A'); A.use('nnbridgeB','B');",
 "  return JSON.stringify({ a:String((A.current('A')||{}).name), b:String((A.current('B')||{}).name) });",
 " };",
 " br.struct=function(){ try{ var t=VantageTree.getTree(); if(!t) return 'no-tree';",
 "  var r=VantageTree.collectAgentNodes(t); var isArr=Array.isArray(r);",
 "  var arr=isArr?r:((r&&(r.nodes||r.leaves))||[]); var one=arr[0];",
 "  return JSON.stringify({isArray:isArr, len:(r&&r.length)||null, topKeys:isArr?null:Object.keys(r).slice(0,10),",
 "    n:arr.length, oneKeys:one?Object.keys(one).slice(0,20):null, oneSample:one?JSON.stringify(one).slice(0,220):null});",
 " }catch(e){ return 'err:'+String(e.message||e).slice(0,80); } };",
 " br.inject=function(){ try{ var t=VantageTree.getTree(); if(!t) return 0;",
 "  var r=VantageTree.collectAgentNodes(t); var arr=Array.isArray(r)?r:((r&&(r.nodes||r.leaves))||[]);",
 "  var id=null; for(var i=0;i<arr.length;i++){ var o=arr[i]; if(!o) continue;",
 "    if(o.nodeId!==undefined && o.nodeId!==null){ id=o.nodeId; break; }",
 "    if(o.uid!==undefined && o.uid!==null){ id=o.uid; break; } }",
 "  window.__nnId=id;",
 "  window.__nnBundleA = id===null?null:{picks:[{nodeId:id,back:0}]};",
 "  window.__nnBundleB = id===null?null:{picks:[{nodeId:id,back:0}]};",
 "  return id===null?0:1; }catch(e){ return -1; } };",
 " br.stat=function(){ try{ var o={}; var g=window.__vantageIface||{};",
 "  o.callsA=g.callsA; o.callsB=g.callsB; o.picks=g.picks; o.growAt=g.growAt; o.rejected=g.rejected;",
 "  o.skipped=g.skipped; o.tSF=g.tickSkippedFull; o.tickCalls=g.tickCalls; o.giveUpA=g.giveUpA;",
 "  o.id=window.__nnId; var t=VantageTree.getTree(); var st=(t&&t.stats)||{}; o.depth=t?t.depth:null;",
 "  for(var k in st){ if(/fresh|rebuild|reset|commit|expand|skip|node/i.test(k)) o['s_'+k]=st[k]; }",
 "  var d=JSON.stringify(VantageTree.dumpDiagnostics(t)); var mm=d.match(/agent-silent-no-grow/g); o.silent=mm?mm.length:0;",
 "  return o; }catch(e){ return {err:String(e.message||e).slice(0,60)}; } };",
 " window.__br=br; return 'installed'; })()"].join("\n");
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1,rng:'record',rngMode:'record'});
 await m.clearControl();
 console.log('INSTALL '+String(await m.eval(INSTALL)).slice(0,60));
 console.log('SETUP '+String(await m.eval('window.__br.setup()')).slice(0,120));
 await m.pump(5,{yieldMs:0});
 console.log('STRUCT '+String(await m.eval('window.__br.struct()')).slice(0,420));
 let injOk=0;
 for(let i=0;i<FR;i++){ const r=await m.eval('window.__br.inject()'); if(Number(r)===1)injOk++;
  await m.pump(1,{yieldMs:0});
  if(i%50===49||i===FR-1){ const s=String(await m.eval('JSON.stringify(window.__br.stat())')); console.log('S '+s.slice(0,300)); } }
 console.log('INJECT_OK_FRAMES '+injOk+'/'+FR);
 await m.close();})();
