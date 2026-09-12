#!/usr/bin/env node
// v89 regression: no-bullet warmup must stop at warmupMaxNodes even when the
// normal node cap is off, and the limit must lift as soon as bullets exist.
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..');
const Constants={BULLET:{RADIUS:{m:0.25},OFFSET:{m:2.5}},TANK:{WIDTH:{m:3},HEIGHT:{m:4}},BULLET_TURRET:{WIDTH:{m:0.7},HEIGHT:{m:1.4},OFFSET_X:{m:0},OFFSET_Y:{m:-2}},LASER_TURRET:{ANTENNA_WIDTH:{m:0.1},ANTENNA_HEIGHT:{m:1.4},ANTENNA_OFFSET_X:{m:0},ANTENNA_OFFSET_Y:{m:-2},DISH_WIDTH:{m:2},DISH_HEIGHT:{m:0.5},DISH_OFFSET_X:{m:0},DISH_OFFSET_Y:{m:-1.85}},DOUBLE_BARREL_TURRET:{WIDTH:{m:1.6},HEIGHT:{m:1.1},OFFSET_X:{m:0},OFFSET_Y:{m:-1.75}},SHOTGUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MISSILE_TURRET:{WIDTH:{m:0.3},CENTER_HEIGHT:{m:1.4},SIDE_HEIGHT:{m:0.4},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},GATLING_GUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MAZE_TILE_SIZE:{m:10}};
const sandbox={console,performance,Math,JSON,Array,Object,String,Number,isFinite,parseInt,parseFloat,Infinity,NaN,Date,Constants};sandbox.global=sandbox;
sandbox.VantageSandbox={fusedEnabled:()=>true,OPERATIONS:Array.from({length:9},(_,i)=>({name:'op'+i,inputs:{forward:i===1,back:i===2,left:i===3,right:i===4}}))};
const ctx=vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_scoring.js'),'utf8'),ctx,{filename:'s.js'});
vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_tree.js'),'utf8'),ctx,{filename:'t.js'});
const VT=sandbox.VantageTree;

VT.setGrowWithoutThreatsEnabled(true);
VT.setGrowLayersPerTick(1);
VT.setHorizonCapEnabled(false);     // isolate the warmup cap from the 8s horizon
VT.setNodeCapEnabled(false);        // normal node cap is off
VT.setWarmupMaxNodes(120);          // warmup hard cap
const tree=VT.createTree({x:0,y:0,rot:0});
tree.rootAbsT=0;tree.root.simState={tank:{x:0,y:0,rot:0},tGlobal:0};tree.root.tEndSec=0;
tree.threats=[];tree._hasOffsetThreats=false;tree._pendingThreats=[];
const adapter={constants:{FRAME_DT:0.02},simulateTankBatch:function(state,ops,frames){
    return ops.map(()=>({samples:Array.from({length:frames+1},(_,k)=>({x:state.x+k*0.01,y:state.y,rot:state.rot})),hitWall:false,dead:false,deathFrame:-1}));
}};
for(let i=0;i<40;i++) VT.growStep(tree,adapter,[]);
if(tree.nodeCount>120) throw new Error('warmup grew past cap: '+tree.nodeCount);
if(tree.nodeCount<110) throw new Error('warmup did not reach near cap: '+tree.nodeCount);
if(!VT.warmupCapReached(tree,9)) throw new Error('warmupCapReached should be true at cap');

// Even refine-beyond/node-cap-off must not bypass the no-bullet warmup cap.
VT.setRefineBeyondLimits(true);
const capped=tree.nodeCount;
VT.growStep(tree,adapter,[]);
if(tree.nodeCount!==capped) throw new Error('refineBeyond bypassed warmup cap: '+tree.nodeCount);

// Bullets appear → warmup cap lifts, growth resumes even with node cap off.
tree.threats=[{id:'b1',speed:0,anchorOffset:0,tIn:0,track:[{x:100,y:100},{x:100,y:100}]}];
if(VT.warmupCapReached(tree,9)) throw new Error('warmup cap should lift when bullets exist');
const before=tree.nodeCount;
VT.growStep(tree,adapter,tree.threats);
if(tree.nodeCount<=before) throw new Error('growth did not resume after bullets appeared');

VT.setRefineBeyondLimits(false);
VT.setWarmupMaxNodes(500);
VT.setNodeCapEnabled(true);
VT.setHorizonCapEnabled(true);
VT.setGrowWithoutThreatsEnabled(false);
console.log('diff_tree_warmup_cap PASS (cap=120, stopped='+capped+', resumed='+before+'->'+tree.nodeCount+')');
