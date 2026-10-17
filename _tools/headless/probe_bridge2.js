const {Match}=require('./match');
const FR=Number(process.env.FRAMES||300);
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1,rng:'record',rngMode:'record'});
 await m.clearControl();
 const setup=await m.eval(`(function(){var o={};try{
  var mk=function(tag){return {name:'nnbridge'+tag, isReady:function(){return true;},
    decide:function(){return (tag==='B'?window.__nnBundleB:window.__nnBundleA)||null;}};};
  var a=mk('A'),b=mk('B');
  o.regA=(typeof VantageTreeInterface.Agents.register==='function');VantageTreeInterface.Agents.register('nnbridgeA',a);VantageTreeInterface.Agents.register('nnbridgeB',b);
  VantageTreeInterface.Agents.use('nnbridgeA','A');VantageTreeInterface.Agents.use('nnbridgeB','B');
  o.aName=String((VantageTreeInterface.Agents.current('A')||{}).name);o.bName=String((VantageTreeInterface.Agents.current('B')||{}).name);
  // collectAgentNodes 结构
  var t=VantageTree.getTree&&VantageTree.getTree();o.treeEmpty=!t;
  if(t){var r=VantageTree.collectAgentNodes(t);o.rType=Array.isArray(r)?'array':typeof r;o.rKeys=r&&!Array.isArray(r)?Object.keys(r).slice(0,10):null;o.rLen=r&&r.length;
    var one=Array.isArray(r)?r[0]:(r&&(r.nodes||r.leaves)||[])[0];o.oneType=typeof one;o.oneKeys=one?Object.keys(one).slice(0,18):null;
    o.oneSample=one?JSON.stringify(one).slice(0,200):null;}
 }catch(e){o.err=String(e.message||e).slice(0,100);}return JSON.stringify(o);})()`);
 console.log('SETUP '+setup.slice(0,900));
 const series=[];
 for(let i=0;i<FR;i++){
  if(i%20===0){ try{ await m.eval(`(function(){try{var t=VantageTree.getTree();var r=VantageTree.collectAgentNodes(t);
    var one=Array.isArray(r)?r[0]:(r&&(r.nodes||r.leaves)||[])[0];
    var id=one?(one.nodeId!==undefined?one.nodeId:(one.uid!==undefined?one.uid:null)):null;
    window.__nnId=id;window.__nnBundleA=id?{picks:[{nodeId:id,back:0}]}:null;window.__nnBundleB=id?{picks:[{nodeId:id,back:0}]}:null;
   }catch(e){}return 1;})()`);}catch(e){}
  await m.pump(1,{yieldMs:0});
  if(i%50===49||i===FR-1){ const s=JSON.parse(await m.eval(`(function(){var o={f:${i+1}};try{var g=window.__vantageIface||{};o.callsA=g.callsA;o.callsB=g.callsB;o.picks=g.picks;o.growAt=g.growAt;o.rejected=g.rejected;o.skipped=g.skipped;o.tSF=g.tickSkippedFull;
    var st=(VantageTree.getTree()||{}).stats||{};for(var k in st){if(/fresh|rebuild|reset|commit|expand|skip/i.test(k))o['s_'+k]=st[k];}
   }catch(e){o.err=1;}return JSON.stringify(o);})()`)); series.push(s); }
 }
 for(const s of series)console.log('S '+JSON.stringify(s).slice(0,260));
 await m.close();})();
