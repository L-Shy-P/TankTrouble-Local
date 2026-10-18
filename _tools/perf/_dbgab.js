const fs=require('fs'),path=require('path');
const { spawn } = require('child_process');
const { makeAsk } = require('../headless/_policy_client.js');
const REPO=path.resolve(__dirname,'..','..');
const cap=JSON.parse(fs.readFileSync('D:/vt_run/perf/payload_p8_N124.json','utf8'));
const env=Object.assign({},process.env,{PYTHONIOENCODING:'utf-8',VT_CKPT:'D:/vt_run/cyc_1/ckpt/model_latest.pt',VT_PROBE_MS:'1'});
const proc=spawn('py',['-3.13','_tools/training/policy_server_graph.py'],{cwd:REPO,env});
const PT=require('stream').PassThrough; const pt=new PT(); pt.setEncoding('utf8');
let rb='',boot=[];
proc.stderr.setEncoding('utf8'); proc.stderr.on('data',d=>String(d).split('\n').forEach(l=>{if(l.trim())console.log('E '+l.slice(0,200))}));
proc.stdout.setEncoding('utf8');
let ready=null; const R=new Promise(r=>ready=r);
proc.stdout.on('data',d=>{rb+=d;let i;while((i=rb.indexOf('\n'))>=0){const l=rb.slice(0,i);rb=rb.slice(i+1);if(!l.trim())continue;if(l.trim()[0]==='{')pt.write(l+'\n');else{boot.push(l);if(l.indexOf('WARMUP_SAMPLE')>=0)ready();}}});
const ask=makeAsk({stdin:proc.stdin,stdout:pt});
(async()=>{
 await R;
 const p=Object.assign({},cap.payload);
 console.log('ask1', JSON.stringify(await ask(p)).slice(0,300));
 const p2=Object.assign({},cap.payload,{_fast:'tensor'});
 console.log('ask2', JSON.stringify(await ask(p2)).slice(0,300));
 try{proc.stdin.end()}catch(e){}
 setTimeout(()=>{try{proc.kill()}catch(e){}},1500);
})();
