const {Match}=require('./match');
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1,rng:'record',rngMode:'record'});
 await m.clearControl();
 const first=await m.eval(`(function(){var o={};try{var t=VantageTree.getTree&&VantageTree.getTree();
   o.treeEmpty=!t;if(t){o.statsKeys=t.stats?Object.keys(t.stats).slice(0,30):null;
     try{var d=JSON.parse(JSON.stringify(VantageTree.dumpDiagnostics(t)));o.diagTop=Object.keys(d).slice(0,25);
       var flat=JSON.stringify(d);o.stallHits=(flat.match(/agent-silent-no-grow/g)||[]).length;
       o.diagLen=flat.length;}catch(e){o.diagErr=String(e.message||e).slice(0,60);}
     try{o.aLen=JSON.stringify(VantageTree.collectAgentNodes(t)).length;}catch(e){o.aErr=String(e.message||e).slice(0,60);}
   }}catch(e){o.err=String(e.message||e).slice(0,80);}return JSON.stringify(o);})()`);
 console.log('SEG0 '+first.slice(0,700));
 const series=[];let prev=null,changes=0,aTaken=0;
 for(let i=0;i<120;i++){ await m.pump(1,{yieldMs:0});
  const s=JSON.parse(await m.eval(`(function(){var o={f:${i}};try{var t=VantageTree.getTree&&VantageTree.getTree();if(!t){o.e=1;return JSON.stringify(o);}
    var st=t.stats||{};for(var k in st){if(/commit|seg|grow|expand|silent/i.test(k))o[k]=st[k];}
    try{var d=JSON.stringify(VantageTree.dumpDiagnostics(t));var mm=d.match(/agent-silent-no-grow/g);o.silent=mm?mm.length:0;o.dLen=d.length;}catch(e){}
    }catch(e){o.err=String(e.message||e).slice(0,60);}return JSON.stringify(o);})()`));
  series.push(s);
 }
 const last=series[series.length-1];
 const numericKeys=[];if(series.length>2)for(const k of Object.keys(series[2]))if(typeof series[2][k]==='number'&&k!=='f')numericKeys.push(k);
 for(const k of numericKeys){let c=0;for(let i=1;i<series.length;i++)if(series[i][k]!==undefined&&series[i-1][k]!==undefined&&series[i][k]!==series[i-1][k])c++;console.log('COUNTER '+k+' first='+series[0][k]+' last='+last[k]+' changes='+c);}
 const segC=numericKeys.map(k=>{let c=0;for(let i=1;i<series.length;i++)if(series[i][k]>series[i-1][k])c++;return{k,c};});
 const totalSeg=segC.map(x=>x.k+':'+x.c).join(' ');
 console.log('SEG_END frames=120 counters=['+numericKeys.join(',')+'] increases=['+totalSeg+'] silent_last='+last.silent+' dLen_last='+last.dLen);
 console.log('SEG_CHECK A_samples_by_seg_boundary='+segC.reduce((a,x)=>a+x.c,0)+' (若取"段末提交"那一个计数器, 以它的 c 为准)');
 await m.close();})();
