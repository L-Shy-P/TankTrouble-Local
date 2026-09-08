#!/usr/bin/env node
// v78 regression: new-bullet immediate death scan must use the JS fused
// authority, shorten to deathFrame-1, and update tEndSec/fullDeathFrame.
'use strict';
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const root = path.resolve(__dirname, '..');
const Constants = {
  BULLET:{RADIUS:{m:0.25},OFFSET:{m:2.5}}, TANK:{WIDTH:{m:3},HEIGHT:{m:4}},
  BULLET_TURRET:{WIDTH:{m:0.7},HEIGHT:{m:1.4},OFFSET_X:{m:0},OFFSET_Y:{m:-2}},
  LASER_TURRET:{ANTENNA_WIDTH:{m:0.1},ANTENNA_HEIGHT:{m:1.4},ANTENNA_OFFSET_X:{m:0},ANTENNA_OFFSET_Y:{m:-2},DISH_WIDTH:{m:2},DISH_HEIGHT:{m:0.5},DISH_OFFSET_X:{m:0},DISH_OFFSET_Y:{m:-1.85}},
  DOUBLE_BARREL_TURRET:{WIDTH:{m:1.6},HEIGHT:{m:1.1},OFFSET_X:{m:0},OFFSET_Y:{m:-1.75}},
  SHOTGUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},
  MISSILE_TURRET:{WIDTH:{m:0.3},CENTER_HEIGHT:{m:1.4},SIDE_HEIGHT:{m:0.4},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},
  GATLING_GUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},
  MAZE_TILE_SIZE:{m:10}
};
const sandbox={console,performance,Math,JSON,Array,Object,String,Number,isFinite,parseInt,parseFloat,Infinity,NaN,Date,Constants};
sandbox.global=sandbox;
sandbox.VantageSandbox={OPERATIONS:[
 {name:'still',inputs:{forward:false,back:false,left:false,right:false}},
 {name:'forward',inputs:{forward:true,back:false,left:false,right:false}},
 {name:'back',inputs:{forward:false,back:true,left:false,right:false}},
 {name:'left',inputs:{forward:false,back:false,left:true,right:false}},
 {name:'right',inputs:{forward:false,back:false,left:false,right:true}},
 {name:'forward-left',inputs:{forward:true,back:false,left:true,right:false}},
 {name:'forward-right',inputs:{forward:true,back:false,left:false,right:true}},
 {name:'back-left',inputs:{forward:false,back:true,left:true,right:false}},
 {name:'back-right',inputs:{forward:false,back:true,left:false,right:true}}
]};
const ctx=vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_scoring.js'),'utf8'),ctx,{filename:'scoring.js'});
vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_tree.js'),'utf8'),ctx,{filename:'tree.js'});
const VT=sandbox.VantageTree;
const tree=VT.createTree({x:0,y:0,rot:0});
tree.rootAbsT=0; tree.root.tEndSec=0; tree.root.simState={tank:{x:0,y:0,rot:0},tGlobal:0};
const node=VT.createTreeNode(tree.root,{forward:true,back:false,left:false,right:false},{tank:{x:1,y:0,rot:0},tGlobal:0.2});
node.plannedFrames=10; node.segmentFrames=10; node.rolloutStartT=0; node.rolloutSamples=[];
for(let k=0;k<=10;k++) node.rolloutSamples.push({x:k*0.1,y:0,rot:0});
node.perFrameScores=[0,0,0,0,0,0,0,0,0,0]; node.status='alive'; node.fullDeathFrame=-1; node.deathAuthority='fused'; node.tEndSec=0.2;
VT.attachChild(tree,tree.root,node);
tree.commitNode=node;
const threat={id:'b-new',speed:18,anchorOffset:0,tIn:0,track:[]};
for(let k=0;k<=10;k++) threat.track.push({x:k*0.1,y:0,alive:true});
tree.threats=[threat]; tree._pendingThreats=[threat]; tree._hasOffsetThreats=true;
const adapter={simulateTankBatchJsFused:function(){return [{dead:true,deathFrame:10,rustPhysics:false}];},simulateTankBatch:function(){return [{dead:true,deathFrame:10,rustPhysics:false}];}};
const hit=VT.invalidateStaleNodes(tree,adapter);
if(hit!==true) throw new Error('expected commitHit true');
if(node.segmentFrames!==5) throw new Error('segmentFrames should be 5 (fd10 * 0.5), got '+node.segmentFrames);
if(node.fullDeathFrame!==10) throw new Error('fullDeathFrame should be 10');
if(node.deathAuthority!=='fused') throw new Error('authority should be fused');
if(Math.abs(node.tEndSec-0.10)>1e-9) throw new Error('tEndSec should be 0.10');
console.log('diff_tree_death_shorten PASS (seg='+node.segmentFrames+' fd='+node.fullDeathFrame+' tEnd='+node.tEndSec+')');
