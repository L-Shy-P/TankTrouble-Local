#!/usr/bin/env node
// v86 regression: disabling the node cap must allow growth past maxNodes;
// enabling it must stop near the cap.
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..');
const Constants={BULLET:{RADIUS:{m:0.25},OFFSET:{m:2.5}},TANK:{WIDTH:{m:3},HEIGHT:{m:4}},BULLET_TURRET:{WIDTH:{m:0.7},HEIGHT:{m:1.4},OFFSET_X:{m:0},OFFSET_Y:{m:-2}},LASER_TURRET:{ANTENNA_WIDTH:{m:0.1},ANTENNA_HEIGHT:{m:1.4},ANTENNA_OFFSET_X:{m:0},ANTENNA_OFFSET_Y:{m:-2},DISH_WIDTH:{m:2},DISH_HEIGHT:{m:0.5},DISH_OFFSET_X:{m:0},DISH_OFFSET_Y:{m:-1.85}},DOUBLE_BARREL_TURRET:{WIDTH:{m:1.6},HEIGHT:{m:1.1},OFFSET_X:{m:0},OFFSET_Y:{m:-1.75}},SHOTGUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MISSILE_TURRET:{WIDTH:{m:0.3},CENTER_HEIGHT:{m:1.4},SIDE_HEIGHT:{m:0.4},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},GATLING_GUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MAZE_TILE_SIZE:{m:10}};
function makeCtx(){const sb={console,performance,Math,JSON,Array,Object,String,Number,isFinite,parseInt,parseFloat,Infinity,NaN,Date,Constants};sb.global=sb;sb.VantageSandbox={fusedEnabled:()=>true,OPERATIONS:Array.from({length:9},(_,i)=>({name:'op'+i,inputs:{forward:i===1,back:i===2,left:i===3,right:i===4}}))};const ctx=vm.createContext(sb);vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_scoring.js'),'utf8'),ctx);vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_tree.js'),'utf8'),ctx);return sb;}
function mkAdapter(){return {constants:{FRAME_DT:0.02},simulateTankBatch:function(state,ops,frames){return ops.map(()=>({samples:Array.from({length:frames+1},(_,k)=>({x:state.x+k*0.01,y:state.y,rot:state.rot})),hitWall:false,dead:false,deathFrame:-1}))}};}
function run(nodeCap){const sb=makeCtx(),VT=sb.VantageTree;VT.setGrowWithoutThreatsEnabled(true);VT.setGrowLayersPerTick(1);VT.setMaxNodes(100);VT.setHorizonCapEnabled(true);VT.setNodeCapEnabled(nodeCap);const t=VT.createTree({x:0,y:0,rot:0});t.rootAbsT=0;t.root.tEndSec=0;t.root.simState={tank:{x:0,y:0,rot:0},tGlobal:0};t.threats=[];const a=mkAdapter();for(let i=0;i<15;i++) VT.growStep(t,a,[]);return t.nodeCount;}
const off=run(false), on=run(true);
if(off<=100) throw new Error('nodeCap off should grow past 100, got '+off);
if(on>100) throw new Error('nodeCap on should stop at/near 100, got '+on);
console.log('diff_tree_growth_switch PASS (capOff='+off+' capOn='+on+')');
