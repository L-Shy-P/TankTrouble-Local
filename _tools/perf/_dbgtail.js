const fs=require('fs'),path=require('path');
const { spawn } = require('child_process');
const { makeAsk } = require('../headless/_policy_client.js');
const REPO=path.resolve(__dirname,'..','..');
const cap=JSON.parse(fs.readFileSync('D:/vt_run/perf/payload_p8_N124.json','utf8'));
const FAST=process.argv[2]||'mem,echo,json,tensor,argmax,sync';
const NROW=Number(process.argv[3]||208);
const env=Object.assign({},process.env,{PYTHONIOENCODING:'utf-8',VT_CKPT:'D:/vt_run/cyc_1/ckpt/model_latest.pt',VT_PROBE_MS:'1'});
const proc=spawn('py',['-3.13','_tools/training/policy_server_graph.py'],{cwd:REPO,env});
const PT=require('stream').PassThrough; const pt=new PT(); pt.setEncoding('utf8');
let rb=''; let ready=null; const R=new Promise(r=>ready=r);
proc.stderr.setEncoding('utf8'); proc.stderr.on('data',d=>String(d).split('\n').forEach(l=>{if(l.indexOf('MEM_STATE')<0&&l.trim())0;}));
proc.stdout.setEncoding('utf8');
proc.stdout.on('data',d=>{rb+=d;let i;while((i=rb.indexOf('\n'))>=0){const l=rb.slice(0,i);rb=rb.slice(i+1);if(!l.trim())continue;if(l.trim()[0]==='{')pt.write(l+'\n');else if(l.indexOf('WARMUP_SAMPLE')>=0)ready();}});
const ask=makeAsk({stdin:proc.stdin,stdout:pt});
const med=a=>{const b=a.slice().sort((x,y)=>x-y);const m=b.length>>1;return b.length%2?b[m]:(b[m-1]+b[m])/2};
function scale(base,n){const p=JSON.parse(JSON.stringify(base));const src=p.segs.node,rows=[];
 for(let i=0;i<n;i++)rows.push(src[i%src.length].slice()); rows[0][1]=-1; for(let i=1;i<n;i++)rows[i][1]=(i-1)%64;
 p.segs.node=rows;p.N=n;return p;}
(async()=>{
 await R;
 const p=Object.assign(scale(cap.payload,NROW),{_fast:FAST});
 if(process.env.MEMON==='1') p.mem_on=1;
 if(process.env.RID) p.round_id=process.env.RID;
 for(let k=0;k<20;k++) await ask(p);
 const keys={};
 for(let k=0;k<150;k++){ const j=await ask(p); if(j&&j._pm) for(const kk in j._pm) (keys[kk]=keys[kk]||[]).push(j._pm[kk]); }
 const m={}; for(const k in keys) m[k]=+med(keys[k]).toFixed(3);
 console.log('FAST='+FAST+' N='+NROW);
 console.log(JSON.stringify(m));
 const T=m.total;
 const order=['parse','mem','tensor','copy','replay','post','dumps'];
 const seg=(a,b)=> (m[a]!==undefined&&m[b]!==undefined)? +(m[b]-m[a]).toFixed(3):null;
 console.log('sum(parts)=', +(order.reduce((x,k)=>x+(m[k]||0),0)).toFixed(3), ' total=',T);
 console.log('scalars(after post->+sync)', seg('t_scalars0','t_scalars1'), ' fire_block', seg('t_scalars1','t_fire1'), ' memecho', seg('t_fire1','t_mem_echo'), ' rest_to_total', +(T-m.t_mem_echo).toFixed(3));
 try{proc.stdin.end()}catch(e){}
 setTimeout(()=>{try{proc.kill()}catch(e){}},1200);
})();
