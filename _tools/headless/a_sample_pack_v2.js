// A 样本二进制 v2：**每字段带类型表**（i=int32 / d=float64 / b=uint8→Boolean），写->读->比对(值+类型)
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const OUT='D:/vt_run/datasets/ashards2';
// 字段 -> 类型（这是"保留类型"的机制：显式类型表，不靠猜）
const T={nodeId:'i',uid:'i',depth:'i',parentId:'i',nFire:'i',tAbs:'d',tRel:'d',fdFrame:'d',x:'d',y:'d',rot:'d',score:'d',alive:'b',stale:'b',opType:'i'};
const FIELDS=Object.keys(T), TYPES=FIELDS.map(f=>T[f]);
function fake(N=400){const a=[];for(let i=0;i<N;i++){const o={};for(const f of FIELDS){const t=T[f];
  o[f]= t==='i'?(i+1): t==='b'?(i%7===0):(Math.random()*1000);}a.push(o);}return a;}
function pack(a){const per=FIELDS.reduce((s,f)=>s+(T[f]==='i'?4:T[f]==='d'?8:1),0);const buf=Buffer.alloc(8+a.length*(4+per));let o=0;
  buf.writeUInt32LE(a.length,o);o+=4;buf.writeUInt32LE(FIELDS.length,o);o+=4;
  for(const r of a){buf.writeUInt32LE(r.__k||0,o);o+=4;                      // 每条一个"种类"标记（留扩展位）
    for(const f of FIELDS){const v=r[f],t=T[f];
      if(t==='i'){buf.writeInt32LE(v|0,o);o+=4;} else if(t==='d'){buf.writeDoubleLE(Number(v),o);o+=8;} else {buf.writeUInt8(v?1:0,o);o+=1;}}}
  return buf.slice(0,o);}
function unpack(buf){const n=buf.readUInt32LE(0),nf=buf.readUInt32LE(4);let o=8;const out=[];
  for(let i=0;i<n;i++){const r={__k:buf.readUInt32LE(o)};o+=4;
    for(let j=0;j<nf;j++){const f=FIELDS[j],t=TYPES[j];
      if(t==='i'){r[f]=buf.readInt32LE(o);o+=4;} else if(t==='d'){r[f]=buf.readDoubleLE(o);o+=8;} else {r[f]=!!buf.readUInt8(o);o+=1;}}out.push(r);}
  return out;}
function cmp(a,b){if(a.length!==b.length)return {ok:false,why:'len'};
  for(let i=0;i<a.length;i++){for(const f of Object.keys(a[i])){const va=a[i][f],vb=b[i][f];
    if(va!==vb) return {ok:false,why:'value '+f+'@'+i+' '+va+' vs '+vb};
    if(typeof va!==typeof vb) return {ok:false,why:'type '+f+'@'+i+' '+typeof va+' vs '+typeof vb};}}return {ok:true};}
fs.mkdirSync(OUT,{recursive:true});
const S=fake(400),txt=JSON.stringify(S),bin=pack(S),back=unpack(bin),cmpR=cmp(S,back);
console.log('V2_SAMPLE n=%d json=%dB bin=%dB ratio=%s lossless_value_and_type=%s %s',
  S.length,Buffer.byteLength(txt),bin.length,(Buffer.byteLength(txt)/bin.length).toFixed(2)+'x',cmpR.ok,cmpR.ok?'':cmpR.why);
console.log('V2_TYPES alive=%s stale=%s nodeId=%s x=%s',typeof back[0].alive,typeof back[0].stale,typeof back[0].nodeId,typeof back[0].x);
const files=[];for(let s=0;s<5;s++){const smp=fake(400),b=pack(smp),name='shard_'+String(s).padStart(3,'0')+'.abin';
  fs.writeFileSync(path.join(OUT,name),b);files.push({name,smp,b,md5:crypto.createHash('md5').update(b).digest('hex')});}
fs.writeFileSync(path.join(OUT,'index.jsonl'),files.map(f=>JSON.stringify({name:f.name,bytes:f.b.length,md5:f.md5})).join('\n')+'\n');
let allOk=true;for(const f of files){const r=cmp(f.smp,unpack(fs.readFileSync(path.join(OUT,f.name))));if(!r.ok){allOk=false;console.log('SHARD_FAIL',f.name,r.why);}}
const idx=fs.readFileSync(path.join(OUT,'index.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
console.log('V2_SHARDS n=%d index=%d readback_value_and_type_ok=%s total=%dB perSample=%dB',files.length,idx.length,allOk,
  idx.reduce((a,x)=>a+x.bytes,0),Math.round(idx.reduce((a,x)=>a+x.bytes,0)/idx.length));
console.log('V2_EXTRAPOLATE perSample_400n=%dB -> 1000n~=%.0fKB -> 20 samples/round ~=%.2fMB',bin.length,bin.length/400*1000/1024,bin.length/400*1000*20/1024/1024);
