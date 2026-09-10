#!/usr/bin/env node
// v82 regression: a soft-dead leaf (fd>=2) must still be growable.
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
const tree=VT.createTree({x:0,y:0,rot:0});
tree.rootAbsT=0;tree.root.simState={tank:{x:0,y:0,rot:0},tGlobal:0};
tree.threats=[]; tree._hasOffsetThreats=false; tree._pendingThreats=[];
const leaf=VT.createTreeNode(tree.root,{forward:true,back:false,left:false,right:false},{tank:{x:1,y:0,rot:0},tGlobal:0.2});
leaf.status='dead'; leaf.fullDead=true; leaf.fullDeathFrame=2; leaf.rolloutDeathFrame=2;
leaf.plannedFrames=3; leaf.segmentFrames=1; leaf.perFrameScores=[1,-100]; leaf.rolloutTotal=-99;
leaf.tEndSec=0.22; leaf.rolloutStartT=0.2; leaf.deathAuthority='fused';
leaf.rolloutSamples=Array.from({length:4},(_,k)=>({x:k,y:0,rot:0}));
VT.attachChild(tree,tree.root,leaf);
tree.root.next=leaf; tree.commitNode=leaf;
const adapter={constants:{FRAME_DT:0.02},simulateTankBatch:function(state,ops,frames){return ops.map(()=>({samples:Array.from({length:frames+1},(_,k)=>({x:state.x+k*0.01,y:state.y,rot:state.rot})),hitWall:false,dead:false,deathFrame:-1}))}};
VT.growStep(tree,adapter,[]);
if(leaf.children.length!==9) throw new Error('soft-dead leaf should have 9 children, got '+leaf.children.length);
if(tree.nodeCount!==11) throw new Error('nodeCount should be 11, got '+tree.nodeCount);
console.log('diff_tree_soft_dead_growth PASS (children='+leaf.children.length+' nodeCount='+tree.nodeCount+')');
