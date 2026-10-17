const {Match}=require('./match');
const FR=Number(process.env.FRAMES||300);
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1,rng:'record',rngMode:'record'});
 await m.clearControl();
 const api=await m.eval(`(function(){var o={};try{o.AgentsKeys=Object.keys(VantageTreeInterface.Agents);
  o.useType=typeof VantageTreeInterface.Agents.use;o.currentType=typeof VantageTreeInterface.Agents.current;
  try{o.useSrc=String(VantageTreeInterface.Agents.use).slice(0,200);}catch(e){}
  try{o.aNow=String((VantageTreeInterface.Agents.current('A')||{}).name);}catch(e){o.aNow='err';}
  o.bridgeOk=false;
  try{var bridge={name:'nnbridge',isReady:function(){return true;},decide:function(){return window.__nnBundleA||null;}};
    VantageTreeInterface.Agents.use('A',bridge);o.afterA=String((VantageTreeInterface.Agents.current('A')||{}).name);o.bridgeOk=(o.afterA==='nnbridge');}catch(e){o.regErr=String(e.message||e).slice(0,120);}
 }catch(e){o.err=String(e.message||e).slice(0,80);}return JSON.stringify(o);})()`);
 console.log('BRIDGE_API '+api.slice(0,700));
 const st0=await m.eval('JSON.stringify(window.__vantageIface||null)');
 console.log('IFACE0 '+String(st0).slice(0,300));
 let validId=await m.eval(`(function(){try{var t=VantageTree.getTree&&VantageTree.getTree();if(!t)return JSON.stringify(null);
   var a=VantageTree.collectAgentNodes(t);var nodes=Array.isArray(a)?a:(a&&a.nodes)||[];
   for(var i=0;i<nodes.length;i++){var n=nodes[i];if(n&&(n.nodeId!==undefined||n.uid!==undefined))return JSON.stringify(n.nodeId!==undefined?n.nodeId:n.uid);}
   return JSON.stringify(null);}catch(e){return JSON.stringify('err:'+String(e.message||e).slice(0,40));}})()`);
 console.log('VALID_NODE '+String(validId).slice(0,80));
 const inj=async(mode)=>{await m.eval(`(function(){try{window.__nnBundleA=${mode==='valid'? '{picks:[{nodeId:'+validId+',back:0}]}' : 'null'};}catch(e){}return 1;})()`);};
 let firstDec=0;for(let i=0;i<FR;i++){ await inj(i===0?'valid':'null'); await m.pump(1,{yieldMs:0}); }
 const st1=await m.eval('JSON.stringify(window.__vantageIface||null)');
 const s1=JSON.parse(st1||'{}');
 const tail=await m.eval(`(function(){var o={};try{var t=VantageTree.getTree();var st=t.stats||{};o.asf=st.agentSkippedFull||0;o.rt=st.agentRouteUsed||0;
   var d=JSON.stringify(VantageTree.dumpDiagnostics(t));var mm=d.match(/agent-silent-no-grow/g);o.silent=mm?mm.length:0;}catch(e){o.err=1;}return JSON.stringify(o);})()`);
 console.log('IFACE1 '+JSON.stringify(s1).slice(0,400));
 console.log('STATS1 '+String(tail).slice(0,300));
 await m.close();})();
