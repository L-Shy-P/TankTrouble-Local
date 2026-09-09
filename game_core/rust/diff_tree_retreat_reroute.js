#!/usr/bin/env node
// v81 regression: true-dead retreat must rewire ancestor.next to the
// retreat target, and force early reselect when the bad branch is on route.
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..');
const Constants={BULLET:{RADIUS:{m:0.25},OFFSET:{m:2.5}},TANK:{WIDTH:{m:3},HEIGHT:{m:4}},BULLET_TURRET:{WIDTH:{m:0.7},HEIGHT:{m:1.4},OFFSET_X:{m:0},OFFSET_Y:{m:-2}},LASER_TURRET:{ANTENNA_WIDTH:{m:0.1},ANTENNA_HEIGHT:{m:1.4},ANTENNA_OFFSET_X:{m:0},ANTENNA_OFFSET_Y:{m:-2},DISH_WIDTH:{m:2},DISH_HEIGHT:{m:0.5},DISH_OFFSET_X:{m:0},DISH_OFFSET_Y:{m:-1.85}},DOUBLE_BARREL_TURRET:{WIDTH:{m:1.6},HEIGHT:{m:1.1},OFFSET_X:{m:0},OFFSET_Y:{m:-1.75}},SHOTGUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MISSILE_TURRET:{WIDTH:{m:0.3},CENTER_HEIGHT:{m:1.4},SIDE_HEIGHT:{m:0.4},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},GATLING_GUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MAZE_TILE_SIZE:{m:10}};
const sandbox={console,performance,Math,JSON,Array,Object,String,Number,isFinite,parseInt,parseFloat,Infinity,NaN,Date,Constants};sandbox.global=sandbox;
sandbox.VantageSandbox={OPERATIONS:Array.from({length:9},(_,i)=>({name:'op'+i,inputs:{forward:i===1,back:i===2,left:i===3,right:i===4}})),fusedEnabled:()=>false};
const ctx=vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_scoring.js'),'utf8'),ctx,{filename:'s.js'});
vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_tree.js'),'utf8'),ctx,{filename:'t.js'});
const VT=sandbox.VantageTree;
const tree=VT.createTree({x:0,y:0,rot:0});
tree.rootAbsT=0;tree.root.simState={tank:{x:0,y:0,rot:0},tGlobal:0};
function mk(parent,op){const n=VT.createTreeNode(parent,{forward:op===1,back:op===2,left:op===3,right:op===4},{tank:{x:0,y:0,rot:0},tGlobal:0.2});n.plannedFrames=10;n.segmentFrames=10;n.rolloutSamples=[{x:0,y:0,rot:0},{x:1,y:0,rot:0}];n.perFrameScores=[0];n.status='alive';n.fullDeathFrame=-1;n.deathAuthority='fused';n.tEndSec=0.2;n.opName='op'+op;return n;}
const A=mk(tree.root,1), B=mk(tree.root,2);
VT.attachChild(tree,tree.root,A);VT.attachChild(tree,tree.root,B);
tree.commitNode=A;tree.root.next=A;
const L=mk(A,3);VT.attachChild(tree,A,L);
for(let i=0;i<9;i++){const d=mk(L,i);d.status='dead';d.fullDeathFrame=1;d.plannedFrames=1;d.segmentFrames=1;VT.attachChild(tree,L,d);}
const rt=VT.applyRetreatAfterExpand(tree,L,{});
if(rt===null) throw new Error('retreat target not found');
if(tree.root.next!==B) throw new Error('root.next was not rewired to B');
if(tree.stats.retreatReroutes!==1) throw new Error('retreatReroutes should be 1');
if(A.tEndSec!==0 || tree._forcedReselect!==true) throw new Error('commitNode should be forced to reselect');
console.log('diff_tree_retreat_reroute PASS (root.next='+tree.root.next.opName+' reroutes='+tree.stats.retreatReroutes+')');
