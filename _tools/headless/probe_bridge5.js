const {Match}=require('./match');
const FR=Number(process.env.FRAMES||200);
const INSTALL=[
 "(function(){",
 " var br={};",
 " br.mk=function(tag){ return { name:'nnbridge'+tag, isReady:function(){return true;},",
 "   decide:function(){ return (tag==='B'?window.__nnBundleB:window.__nnBundleA)||null; } }; };",
 " br.setup=function(){ var A=VantageTreeInterface.Agents;",
 "   A.register(br.mk('A'),'A'); A.register(br.mk('B'),'B'); A.use('nnbridgeA','A'); A.use('nnbridgeB','B');",
 "   return JSON.stringify({a:String((A.current('A')||{}).name),b:String((A.current('B')||{}).name)}); };",
 " br.val2=function(){ try{ return String(VantageTreeInterface.validateBundle).slice(500,1500); }catch(e){ return 'err'; } };",
 " br.inject=function(){ try{ var t=VantageTree.getTree(); if(!t) return 0;",
 "   var r=VantageTree.collectAgentNodes(t); var arr=Array.isArray(r)?r:[]; var id=null;",
 "   for(var i=0;i<arr.length;i++){ if(arr[i]&&arr[i].id!==undefined&&arr[i].id!==null){id=arr[i].id;break;} }",
 "   window.__nnId=id; var b = (id===null)?null:{ picks:[{nodeId:id,back:0}], memory:{nntag:window.__nnMem||'M0'} };",
 "   window.__nnBundleA=b; window.__nnBundleB=b; return id===null?0:1; }catch(e){ return -1; } };",
 " br.mem=function(){ try{ var t=VantageTree.getTree(); var o={};",
 "   o.keysMem=Object.keys(t).filter(function(k){return /mem/i.test(k);});",
 "   for(var i=0;i<o.keysMem.length;i++){ var k=o.keysMem[i]; o[k]=JSON.stringify(t[k]).slice(0,120); }",
 "   return JSON.stringify(o); }catch(e){ return 'err:'+String(e.message||e).slice(0,50); } };",
 " br.stat=function(){ var o={}; try{ var g=window.__vantageIface||{};",
 "   o.callsA=g.callsA;o.callsB=g.callsB;o.picks=g.picks;o.growAt=g.growAt;o.rejected=g.rejected;o.giveUpA=g.giveUpA;o.giveUpB=g.giveUpB;o.skipped=g.skipped;o.id=window.__nnId;",
 "   var t=VantageTree.getTree();var st=(t&&t.stats)||{};o.expands=st.expands;o.commits=st.commits;",
 " }catch(e){o.err=1;} return o; };",
 " window.__br=br; return 'installed';})()"].join("\n");
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1,rng:'record',rngMode:'record'});
 await m.clearControl();
 console.log('INSTALL '+String(await m.eval(INSTALL)).slice(0,40));
 console.log('SETUP '+String(await m.eval('window.__br.setup()')).slice(0,120));
 await m.eval("window.__nnMem='M1'");
 await m.pump(5,{yieldMs:0});
 console.log('VAL2 '+String(await m.eval('window.__br.val2()')).slice(0,900));
 let ok=0;
 for(let i=0;i<FR;i++){ const r=await m.eval('window.__br.inject()'); if(Number(r)===1)ok++;
  await m.pump(1,{yieldMs:0});
  if(i===9) console.log('MEM_after10 '+String(await m.eval('window.__br.mem()')).slice(0,300));
  if(i%60===59||i===FR-1){ console.log('S '+String(await m.eval('JSON.stringify(window.__br.stat())')).slice(0,260)); } }
 console.log('INJECT_OK '+ok+'/'+FR);
 await m.close();})();
