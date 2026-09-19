#!/usr/bin/env node
// v91 regression: prediction horizon slider + prune compensation.
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

// defaults + clamps
const t0=VT.createTree({x:0,y:0,rot:0});
if(t0.cfg.horizonSec!==8) throw new Error('default horizonSec should be 8');
// v119：两类补偿默认开，各 1 层 / 10 帧
if(t0.cfg.pruneCompensateLayers!==1) throw new Error('default compensate layers should be 1');
if(t0.cfg.pruneCompensateFrames!==10) throw new Error('default compensate frames should be 10');
if(t0.cfg.retreatCompensateLayers!==1) throw new Error('default retreat compensate layers should be 1');
if(t0.cfg.retreatCompensateFrames!==10) throw new Error('default retreat compensate frames should be 10');
if(VT.setHorizonSec(0)!==1 || VT.setHorizonSec(99)!==15 || VT.setHorizonSec(8)!==8) throw new Error('horizonSec clamp failed');
if(VT.setPruneCompensateLayers(-1)!==0 || VT.setPruneCompensateLayers(99)!==9) throw new Error('compensate layers clamp failed');
if(VT.setPruneCompensateFrames(0)!==1 || VT.setPruneCompensateFrames(99)!==60) throw new Error('compensate frames clamp failed');
if(VT.setRetreatCompensateLayers(-1)!==0 || VT.setRetreatCompensateLayers(99)!==9) throw new Error('retreat compensate layers clamp failed');
if(VT.setRetreatCompensateFrames(0)!==1 || VT.setRetreatCompensateFrames(99)!==60) throw new Error('retreat compensate frames clamp failed');

function mkAdapter(){return {constants:{FRAME_DT:0.02},simulateTankBatch:function(state,ops,frames){
    return ops.map(()=>({samples:Array.from({length:frames+1},(_,k)=>({x:state.x+k*0.01,y:state.y,rot:state.rot})),hitWall:false,dead:false,deathFrame:-1}));
}};}
function freshTree(layers,framesCount,boostLayers){
    VT.setGrowWithoutThreatsEnabled(true);
    VT.setGrowLayersPerTick(layers);
    VT.setHorizonCapEnabled(false);
    VT.setNodeCapEnabled(false);
    VT.setPruneCompensateLayers(boostLayers);
    VT.setPruneCompensateFrames(framesCount);
    const t=VT.createTree({x:0,y:0,rot:0});
    t.rootAbsT=0;t.root.simState={tank:{x:0,y:0,rot:0},tGlobal:0};t.root.tEndSec=0;
    t.threats=[];t._hasOffsetThreats=false;t._pendingThreats=[];
    return t;
}

// no compensation → 1 layer/tick
{
    const t=freshTree(1,1,0), a=mkAdapter();
    t.nodeCount=100;
    const lost=VT.notePruneLoss(t,200,'test');
    if(lost!==100) throw new Error('notePruneLoss should report 100, got '+lost);
    if(t._growBoosts && t._growBoosts.length) throw new Error('layers=0 must not create a boost');
    const e0=t.stats.expands;
    VT.growStep(t,a,[]);
    if(t.stats.expands-e0!==1) throw new Error('without compensation should expand 1 layer');
}

// with compensation → 1 + 2 layers for 2 ticks, then back to 1
{
    const t=freshTree(1,2,2), a=mkAdapter();
    t.nodeCount=100;
    VT.notePruneLoss(t,200,'test');
    if(!t._growBoosts || t._growBoosts.length!==1 || t._growBoosts[0].layers!==2 || t._growBoosts[0].framesLeft!==2) throw new Error('boost state wrong');
    const e0=t.stats.expands;
    VT.growStep(t,a,[]);
    if(t.stats.expands-e0!==3) throw new Error('boost tick1 should expand 3 layers, got '+(t.stats.expands-e0));
    if(!t._growBoosts || t._growBoosts.length!==1 || t._growBoosts[0].framesLeft!==1) throw new Error('boost should have 1 frame left');
    const e1=t.stats.expands;
    VT.growStep(t,a,[]);
    if(t.stats.expands-e1!==3) throw new Error('boost tick2 should expand 3 layers, got '+(t.stats.expands-e1));
    if(t._growBoosts && t._growBoosts.length) throw new Error('boost should be consumed after 2 ticks');
    const e2=t.stats.expands;
    VT.growStep(t,a,[]);
    if(t.stats.expands-e2!==1) throw new Error('after boost should expand 1 layer, got '+(t.stats.expands-e2));
}

VT.setPruneCompensateLayers(1);VT.setPruneCompensateFrames(10);VT.setHorizonSec(8);
console.log('diff_tree_prune_compensation PASS (horizon 1..15, compensate 0..9 / 1..60, boost 2x2 ticks)');
