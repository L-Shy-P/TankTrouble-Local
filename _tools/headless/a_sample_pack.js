// A 样本二进制瘦身 + 分片滚动（无损），并做 写->读->比对
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const OUT='D:/vt_run/datasets/ashards';
const FIELDS=['nodeId','uid','depth','tAbs','tRel','nFire','fdFrame','parentId','x','y','rot','score','alive','stale','opType'];
function fakeSample(N=400){const a=[];for(let i=0;i<N;i++){const o={};for(const f of FIELDS){o[f]=(f==='nodeId'||f==='uid'||f==='parentId'||f==='depth'||f==='nFire')?(i+1):(f==='alive'||f==='stale')?(i%7===0):(Math.random()*1000);} a.push(o);} return a;}
function packSample(a){                     // 无损：字段名走表、整数走 int32、浮点走 float64
  const idx=FIELDS; const buf=Buffer.alloc(4+4+a.length*idx.length*8); let off=0;
  buf.writeUInt32LE(a.length,off);off+=4; buf.writeUInt32LE(idx.length,off);off+=4;
  for(const rec of a) for(const f of idx){ const v=rec[f]; buf.writeDoubleLE(Number(v),off); off+=8; }
  return buf;}
function unpackSample(buf){const n=buf.readUInt32LE(0),nf=buf.readUInt32LE(4);let off=8;const out=[];
  for(let i=0;i<n;i++){const o={};for(let j=0;j<nf;j++){o[FIELDS[j]]=buf.readDoubleLE(off);off+=8;}out.push(o);} return out;}
function eq(a,b){return JSON.stringify(a)===JSON.stringify(b);}
fs.mkdirSync(OUT,{recursive:true});
const S=fakeSample(400), txt=JSON.stringify(S), bin=packSample(S), back=unpackSample(bin);
console.log('SAMPLE n=%d json=%dB bin=%dB ratio=%.2fx lossless=%s',S.length,Buffer.byteLength(txt),bin.length,(Buffer.byteLength(txt)/bin.length).toFixed(2),eq(S,back));
// 分片滚动：每片 3 个样本
const SHARD=3; let written=[],idxLines=[];
for(let s=0;s<5;s++){const smp=fakeSample(400);const b=packSample(smp);const name='shard_'+String(s).padStart(3,'0')+'.abin';
  fs.writeFileSync(path.join(OUT,name),Buffer.concat([b]));               // 实际会追加多帧；此处 1 样本/片便于演示
  const md5=crypto.createHash('md5').update(b).digest('hex');idxLines.push(JSON.stringify({name,samples:1,bytes:b.length,md5}));written.push({name,smp});}
fs.writeFileSync(path.join(OUT,'index.jsonl'),idxLines.join('\n')+'\n');
let ok=true;for(const w of written){const b=fs.readFileSync(path.join(OUT,w.name));if(!eq(w.smp,unpackSample(b)))ok=false;}
const idx=fs.readFileSync(path.join(OUT,'index.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
console.log('SHARDS n=%d index=%d readback_ok=%s totalBin=%dB avgPerSample=%dB',written.length,idx.length,ok,
  idx.reduce((a,x)=>a+x.bytes,0), Math.round(idx.reduce((a,x)=>a+x.bytes,0)/idx.length));
const perRound=Math.round(bin.length/1);  // 1 条 A 样本（400 节点规模）
console.log('EXTRAPOLATE perSample_400nodes=%dB  (real 1000nodes~=%.0fKB)  perRound_20samples~=%.1fMB',perRound,bin.length/1000*2.5,bin.length/1000*2.5*20/1000);
