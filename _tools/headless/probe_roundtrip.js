const {Match}=require('./match');
const N=Number(process.env.N||300);
(async()=>{const m=new Match();
 await m.open({humanIds:['tank_a'],aiCount:2,vantCount:1});
 await m.clearControl();
 // 形态(ii)最小复刻：每帧 = 1 次 eval(写决策) + 1 次 pump
 let tEval=0,tPump=0;
 for(let i=0;i<N;i++){
   const a=Date.now(); await m.eval('window.__d='+i+'||null'); const b=Date.now();
   await m.pump(1,{yieldMs:0}); const c=Date.now();
   tEval+=(b-a); tPump+=(c-b);
 }
 const perFrame=(tEval+tPump)/N;
 console.log('RT N='+N+' evalMs_total='+tEval+' (perFrame='+(tEval/N).toFixed(2)+') pumpMs_total='+tPump+' (perFrame='+(tPump/N).toFixed(2)+')');
 console.log('PER_FRAME_MS='+perFrame.toFixed(2)+'  PER_ROUND_3158f_S='+(perFrame*3158/1000).toFixed(1));
 // 对照：批量（一次 pump + 一次 eval）
 const m2=await (async()=>m)();
 await m.close();})();
