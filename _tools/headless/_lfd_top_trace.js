'use strict';
/* _lfd_ 逐帧追踪：复现某个 top 例子，打印 sweep/contact/final 每帧标记
 * 用法：node _tools/headless/_lfd_top_trace.js [--rows _lfd_rows_e4530739.json] [--which 0]
 */
const fs=require('fs'), path=require('path');
const H=require('../../game_core/rust/_diff_proj_semantics_harness.js');
function arg(n,d){const i=process.argv.indexOf('--'+n);return i<0?d:process.argv[i+1];}
const rowsFile=path.join(__dirname,'prof',arg('rows','_lfd_rows_e4530739.json'));
const WHICH=Number(arg('which',0));
const FROZEN=arg('frozen',null);
const FROZEN_PATH=FROZEN==='v172'?path.resolve(__dirname,'..','..','_backup','12d_missile_20261013','vantage_sandbox.js'):(FROZEN?path.resolve(FROZEN):null);
const D=JSON.parse(fs.readFileSync(rowsFile,'utf8'));
const target=D.top[WHICH];
if(!target){console.error('no top['+WHICH+']');process.exit(1);}
const SEED=D.seed, FRAMES=D.frames;
let _s=SEED>>>0;
function rnd(){_s=(_s*1664525+1013904223)>>>0;return _s/4294967296;}
function rr(a,b){return a+(b-a)*rnd();}
function pick(a){return a[Math.floor(rnd()*a.length)%a.length];}
const WEAPONS=[
 {name:'BULLET',type:-1,radius:0.25,speed:18.0,life:10.0},{name:'DOUBLE_BARREL',type:1,radius:0.25,speed:18.0,life:6.0},
 {name:'LASER',type:0,radius:0.0,speed:180.0,life:0.8},{name:'SHOTGUN',type:2,radius:0.1,speed:32.5,life:2.0},
 {name:'GATLING_GUN',type:5,radius:0.1,speed:27.5,life:2.0},{name:'HOMING_MISSILE',type:3,radius:0.2,speed:18.0,life:10.0},
 {name:'MINE_SHRAPNEL',type:4,radius:0.1,speed:30.0,life:10.0}];
function weaponMix(){const r=rnd();if(r<0.40)return WEAPONS[0];if(r<0.50)return WEAPONS[1];if(r<0.65)return WEAPONS[2];if(r<0.78)return WEAPONS[3];if(r<0.88)return WEAPONS[4];if(r<0.94)return WEAPONS[5];return WEAPONS[6];}
(async()=>{
  let S;
  if(FROZEN_PATH){const orig=fs.readFileSync;fs.readFileSync=function(p2,...rest){if(typeof p2==='string'&&p2.indexOf('vantage_sandbox.js')>=0)return orig.call(fs,FROZEN_PATH,...rest);return orig.call(fs,p2,...rest);};try{S=H.loadSandbox();}finally{fs.readFileSync=orig;}}
  else S=H.loadSandbox();
  const C=S.Constants,Box2D=S.Box2D,VS=S.VantageSandbox;
  await H.initRust(S,'js/wasm/vantage_core.wasm'); VS.setRustPhysicsEnabled(true); VS.setFrameDtSec(1/60);
  const OPS=VS.OPERATIONS;
  let scene=null;
  for(let sc=0;sc<=target.sc;sc++){
    const W=pick([4,5,5,6]),Hh=pick([3,4,4,5]),maze=H.makeMaze(W,Hh);
    const pose={x:rr(3,W*10-3),y:rr(3,Hh*10-3),rot:rr(-Math.PI,Math.PI)};
    const tank=H.makeFakeTank(Box2D,pose.x,pose.y,pose.rot); const projs={};
    const nB=1+Math.floor(rnd()*3); const sceneBullets=[];
    for(let bi=0;bi<nB;bi++){
      const wpn=weaponMix(); const dist=rr(6,14); const ang=rr(-Math.PI,Math.PI);
      const bx=pose.x+Math.cos(ang)*dist,by=pose.y+Math.sin(ang)*dist;
      const off=(rnd()<0.5)?rr(-1.0,1.0):rr(-3.0,3.0);
      const nx=-Math.sin(ang),ny=Math.cos(ang);
      const aim={x:pose.x+nx*off-bx,y:pose.y+ny*off-by}; const al=Math.hypot(aim.x,aim.y)||1;
      const sp=wpn.speed*rr(0.95,1.05); const id='b'+bi;
      projs[id]=H.makeFakeProjectile(Box2D,C,{id:id,x:bx,y:by,vx:aim.x/al*sp,vy:aim.y/al*sp,radius:wpn.radius,type:wpn.type,lifetime:wpn.life,age:rr(0,wpn.life*0.4)});
      sceneBullets.push({id:id,w:wpn.name,r:wpn.radius===0?0.05:wpn.radius,sp:+sp.toFixed(2),d:+dist.toFixed(2),off:+off.toFixed(2),x:+bx.toFixed(2),y:+by.toFixed(2),vx:+(aim.x/al*sp).toFixed(2),vy:+(aim.y/al*sp).toFixed(2)});
    }
    if(sc===target.sc) scene={W:W,H:Hh,maze:maze,pose:pose,tank:tank,projs:projs,gc:H.makeGameController(maze,tank,projs),sceneBullets:sceneBullets};
  }
  const adapter=VS.createAdapter(scene.gc,'lfd_top'+target.sc);
  const opt={startPose:scene.pose,threats:[],tGlobal:0,nowTGlobal:0,cfg:{}};
  const js=adapter.simulateTankBatchJsFused(scene.pose,OPS,FRAMES,Object.assign({},opt,{auditPurpose:'jsConfirm'}));
  const fb=adapter.getLastFusedBatchSummary();
  const rust=adapter.simulateTankBatchScored(scene.pose,OPS,FRAMES,Object.assign({},opt));
  const i=target.i;
  console.log('=== _lfd_ top trace (rows='+path.basename(rowsFile)+' which='+WHICH+') ===');
  console.log('scene sc='+target.sc+' op='+target.op+' i='+i+' pose='+JSON.stringify(scene.pose));
  console.log('bullets='+JSON.stringify(scene.sceneBullets));
  console.log('jsDF='+js[i].deathFrame+' rustDF='+rust[i].deathFrame+' jsSweepHit='+(fb.sweepHits?fb.sweepHits[i]:null)+' sweepFallback='+!!fb.sweepFallback+' geoFallback='+!!fb.geometryFallback);
  const contacts=(fb.contacts||[]).filter(c=>c.op===i).slice().sort((a,b)=>a.k-b.k);
  console.log('contacts(op='+i+') n='+contacts.length);
  contacts.slice(0,30).forEach(c=>console.log('  k='+c.k+' cat='+c.category+(c.source?'/'+c.source:'')+
    (c.bullet?' bullet=('+c.bullet.x+','+c.bullet.y+') r='+c.bullet.r+' gap='+c.gapAtContact+' polyGap='+c.polyGapAtContact:'')));
  const lo=Math.min(js[i].deathFrame,rust[i].deathFrame,fb.sweepHits?fb.sweepHits[i]:0);
  const hi=Math.max(js[i].deathFrame,rust[i].deathFrame);
  console.log('frame table k='+lo+'..'+Math.min(hi+2,FRAMES)+':');
  for(let k=lo;k<=Math.min(hi+2,FRAMES);k++){
    const marks=[];
    if(fb.sweepHits&&fb.sweepHits[i]===k)marks.push('S(sweep)');
    contacts.filter(c=>c.k===k).forEach(c=>marks.push('C:'+c.category+(c.source?'/'+c.source:'')));
    if(rust[i].deathFrame===k)marks.push('R(rustFinal)');
    if(js[i].deathFrame===k)marks.push('J(jsFinal)');
    if(marks.length)console.log('  k='+String(k).padStart(3)+'  '+marks.join('  '));
  }
})().catch(e=>{console.error('FATAL',(e&&e.stack)||e);process.exitCode=1;});
