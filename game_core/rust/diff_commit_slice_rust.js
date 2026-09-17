#!/usr/bin/env node
// v114 regression: the commit slice (the "firing a bullet stutters" hot spot) must
// score through the Rust batch when the new knobs are off, fall back to JS when they
// are on, and still hand the *chosen* node's death verdict to the JS fused world.
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..');
const Constants={BULLET:{RADIUS:{m:0.25},OFFSET:{m:2.5}},TANK:{WIDTH:{m:3},HEIGHT:{m:4}},BULLET_TURRET:{WIDTH:{m:0.7},HEIGHT:{m:1.4},OFFSET_X:{m:0},OFFSET_Y:{m:-2}},LASER_TURRET:{ANTENNA_WIDTH:{m:0.1},ANTENNA_HEIGHT:{m:1.4},ANTENNA_OFFSET_X:{m:0},ANTENNA_OFFSET_Y:{m:-2},DISH_WIDTH:{m:2},DISH_HEIGHT:{m:0.5},DISH_OFFSET_X:{m:0},DISH_OFFSET_Y:{m:-1.85}},DOUBLE_BARREL_TURRET:{WIDTH:{m:1.6},HEIGHT:{m:1.1},OFFSET_X:{m:0},OFFSET_Y:{m:-1.75}},SHOTGUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MISSILE_TURRET:{WIDTH:{m:0.3},CENTER_HEIGHT:{m:1.4},SIDE_HEIGHT:{m:0.4},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},GATLING_GUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MAZE_TILE_SIZE:{m:10},PIXELS_PER_METER:20};
function makeCtx(){
  const sb={console,performance,Math,JSON,Array,Object,String,Number,isFinite,parseInt,parseFloat,Infinity,NaN,Date,Constants};
  sb.global=sb;
  sb.VantageSandbox={fusedEnabled:()=>true,OPERATIONS:[
    {name:'静止',inputs:{forward:false,back:false,left:false,right:false}},
    {name:'前',inputs:{forward:true,back:false,left:false,right:false}},
    {name:'后',inputs:{forward:false,back:true,left:false,right:false}},
    {name:'左',inputs:{forward:false,back:false,left:true,right:false}},
    {name:'右',inputs:{forward:false,back:false,left:false,right:true}},
    {name:'前左',inputs:{forward:true,back:false,left:true,right:false}},
    {name:'前右',inputs:{forward:true,back:false,left:false,right:true}},
    {name:'后左',inputs:{forward:false,back:true,left:true,right:false}},
    {name:'后右',inputs:{forward:false,back:true,left:false,right:true}}
  ],clearCaches:()=>{}};
  const ctx=vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_scoring.js'),'utf8'),ctx,{filename:'s.js'});
  vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_tree.js'),'utf8'),ctx,{filename:'t.js'});
  return sb;
}
function samplesFor(state,frames,step){
  const out=[{t:0,x:state.x,y:state.y,rot:state.rot}];
  for(let k=1;k<=frames;k++) out.push({t:k*0.02,x:state.x+k*step,y:state.y,rot:state.rot});
  return out;
}
function makeAdapter(opt){
  opt=opt||{};
  const pose={x:20,y:20,rot:0};
  const a={
    constants:{FRAME_DT:0.02},
    rustCalls:0, jsBatchCalls:0, jsFusedCalls:0, singleCalls:0,
    getTankState:function(){return {x:pose.x,y:pose.y,rot:pose.rot};},
    getProjectiles:function(){return [];},
    checkWall:function(){return false;},
    bulletPosAt:function(){return null;},
    getProjectilePaths:function(){return [];},
    simulateBulletTracks:function(){return [];},
    // Rust 全包：九操作模拟 + 评分（vt_score_paths）
    simulateTankBatchScored:function(state,ops,frames){
      a.rustCalls++;
      return ops.map(function(){
        return {
          samples:samplesFor(state,frames,0.02),
          perFrameScores:new Array(frames+1).fill(2),
          totalScore:frames*2,
          dead:opt.rustDead===true,
          deathFrame:opt.rustDead===true?3:-1
        };
      });
    },
    // JS 融合批量（= 老的 JS 评分路径）
    simulateTankBatch:function(state,ops,frames){
      a.jsBatchCalls++;
      return ops.map(function(){
        return {samples:samplesFor(state,frames,0.02),dead:false,deathFrame:-1,rustPhysics:false};
      });
    },
    // 给「JS 融合世界确认死亡」用的批量
    simulateTankBatchJsFused:function(state,ops,frames){
      a.jsFusedCalls++;
      return ops.map(function(){
        return {samples:samplesFor(state,frames,0.02),dead:opt.jsDead===true,
          deathFrame:opt.jsDead===true?2:-1,rustPhysics:false};
      });
    },
    simulateTank:function(state,inputs,frames){
      a.singleCalls++;
      return {samples:samplesFor({x:state.x,y:state.y,rot:state.rot},frames,0.02),dead:false,deathFrame:-1};
    }
  };
  return a;
}
const fakeMaze={getWidth:()=>4,getHeight:()=>4,isPositionInsideMaze:()=>true,getDeadEndPenalty:()=>0,
  getTiles:()=>[[[1,1,1],[1,0,1],[1,1,1]],[[1,0,1],[0,0,0],[1,0,1]],[[1,1,1],[1,0,1],[1,1,1]]]};
function runTick(VT,adapter){
  const ai={_vantageAdapter:adapter,aiId:1,gameController:{getMaze:()=>fakeMaze},
    debugTarget:null,setDebugTarget:function(x,y){this.debugTarget={x:x,y:y};},clearDebugTarget:function(){this.debugTarget=null;}};
  VT.tick(ai,0.02);
  return VT.getTree();
}
function fail(msg){ throw new Error(msg); }

// ---------- ① 默认设置：提交切片必须走 Rust ----------
{ const sb=makeCtx(), VT=sb.VantageTree;
  VT.setKillfieldEnabled(false); VT.reset();
  const a=makeAdapter();
  const t=runTick(VT,a);
  if((t.stats.commitSliceRustBatches||0)!==1) fail('默认设置下提交切片没走 Rust（commitSliceRustBatches='+(t.stats.commitSliceRustBatches||0)+'）');
  if((t.stats.commitSliceJsBatches||0)!==0) fail('默认设置下不该走 JS（commitSliceJsBatches='+t.stats.commitSliceJsBatches+'）');
  if(a.jsBatchCalls!==0) fail('默认设置下 JS 融合批量被调用了 '+a.jsBatchCalls+' 次');
  if(!t.commitNode) fail('第一 tick 之后没有 commitNode');
  console.log('① 默认设置：提交切片 Rust='+(t.stats.commitSliceRustBatches||0)+' JS='+(t.stats.commitSliceJsBatches||0)+'，JS批量调用='+a.jsBatchCalls+'  PASS');
}

// ---------- ② 打开新参数（k<1）：必须回退 JS ----------
{ const sb=makeCtx(), VT=sb.VantageTree;
  VT.setKillfieldEnabled(false); VT.setSafeFilterK(0.4); VT.reset();
  const a=makeAdapter();
  const t=runTick(VT,a);
  if((t.stats.commitSliceRustBatches||0)!==0) fail('k=0.4 时不该走 Rust（Rust 不认 k）');
  if((t.stats.commitSliceJsBatches||0)<1) fail('k=0.4 时必须走 JS，实际 JS='+(t.stats.commitSliceJsBatches||0));
  if(a.jsBatchCalls<1) fail('k=0.4 时 JS 融合批量没被调用');
  console.log('② k=0.4：提交切片 Rust='+(t.stats.commitSliceRustBatches||0)+' JS='+(t.stats.commitSliceJsBatches||0)+'，JS批量调用='+a.jsBatchCalls+'  PASS');
}

// ---------- ③ 动作成本 > 0：同样回退 JS ----------
{ const sb=makeCtx(), VT=sb.VantageTree;
  VT.setKillfieldEnabled(false); VT.setActionCostPerFrame(3); VT.reset();
  const a=makeAdapter();
  const t=runTick(VT,a);
  if((t.stats.commitSliceRustBatches||0)!==0||(t.stats.commitSliceJsBatches||0)<1) fail('动作成本>0 时必须回退 JS');
  console.log('③ 动作成本=3：提交切片 Rust=0 JS='+(t.stats.commitSliceJsBatches||0)+'  PASS');
}

// ---------- ④ 死亡权威：Rust 说死、JS 说活 → 必须以 JS 为准（翻案） ----------
{ const sb=makeCtx(), VT=sb.VantageTree;
  VT.setKillfieldEnabled(false); VT.reset();
  const a=makeAdapter({rustDead:true,jsDead:false});
  const t=runTick(VT,a);
  if(!t.commitNode) fail('没有 commitNode');
  if(t.commitNode.deathAuthority!=='fused') fail('被选中节点的死亡权威没被 JS 融合世界确认：'+t.commitNode.deathAuthority);
  if((t.stats.jsConfirmCount||0)<1) fail('JS 确认计数没涨');
  if(a.jsFusedCalls<1) fail('没调用 JS 融合批量做确认');
  if(t.commitNode.fullDeathFrame!==-1) fail('Rust 误报死亡未被 JS 翻案：fullDeathFrame='+t.commitNode.fullDeathFrame);
  console.log('④ Rust 误报死亡：JS 融合确认后翻案（authority='+t.commitNode.deathAuthority+' fullDeathFrame='+t.commitNode.fullDeathFrame+' 确认次数='+t.stats.jsConfirmCount+'）PASS');
}

// ---------- ⑤ 死亡权威：Rust 说活、JS 说第 2 帧死 → 以 JS 为准 ----------
{ const sb=makeCtx(), VT=sb.VantageTree;
  VT.setKillfieldEnabled(false); VT.reset();
  const a=makeAdapter({rustDead:false,jsDead:true});
  const t=runTick(VT,a);
  if(!t.commitNode) fail('没有 commitNode');
  if(t.commitNode.deathAuthority!=='fused') fail('权威标记不对：'+t.commitNode.deathAuthority);
  if(t.commitNode.fullDeathFrame!==2) fail('JS 说的死亡帧没写回：'+t.commitNode.fullDeathFrame);
  console.log('⑤ Rust 漏报死亡：JS 融合确认后补上（fullDeathFrame='+t.commitNode.fullDeathFrame+'）PASS');
}

console.log('diff_commit_slice_rust PASS');
