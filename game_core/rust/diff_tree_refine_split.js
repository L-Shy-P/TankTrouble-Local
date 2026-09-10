#!/usr/bin/env node
// v85 regression: horizon cap can be disabled and refine-beyond can split a
// long leaf even when no normal growable leaf exists.
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
VT.setRefineBeyondLimits(true);
const tree=VT.createTree({x:0,y:0,rot:0});
tree.rootAbsT=0;tree.root.simState={tank:{x:0,y:0,rot:0},tGlobal:0};tree.root.tEndSec=0;
tree.threats=[];tree._hasOffsetThreats=false;tree._pendingThreats=[];
const leaf=VT.createTreeNode(tree.root,{forward:true,back:false,left:false,right:false},{tank:{x:0,y:0,rot:0},tGlobal:8.1});
leaf.status='alive';leaf.fullDeathFrame=-1;leaf.rolloutSamples=Array.from({length:11},(_,k)=>({x:k,y:0,rot:0}));
leaf.plannedFrames=10;leaf.segmentFrames=10;leaf.perFrameScores=Array(10).fill(1);leaf.rolloutStartT=8.1;leaf.tEndSec=8.3;leaf.deathAuthority='fused';
VT.attachChild(tree,tree.root,leaf);
const adapter={constants:{FRAME_DT:0.02},simulateTankBatch:function(state,ops,frames){return ops.map(()=>({samples:Array.from({length:frames+1},(_,k)=>({x:state.x+k*0.01,y:state.y,rot:state.rot})),hitWall:false,dead:false,deathFrame:-1}))}};
VT.growStep(tree,adapter,[]);
var splitNode = tree.root.children.find(function(c) { return c !== leaf && c.children.length === 9; });
if (!splitNode) throw new Error('refine split did not expand 9 children');
if(tree.nodeCount!==12) throw new Error('nodeCount should be 12, got '+tree.nodeCount);
console.log('diff_tree_refine_split PASS (splitChildren='+splitNode.children.length+' nodeCount='+tree.nodeCount+')');
