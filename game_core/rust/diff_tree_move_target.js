#!/usr/bin/env node
// v92 regression: click target is only a tie-break after safety scores are equal.
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..');
const Constants={BULLET:{RADIUS:{m:0.25},OFFSET:{m:2.5}},TANK:{WIDTH:{m:3},HEIGHT:{m:4}},BULLET_TURRET:{WIDTH:{m:0.7},HEIGHT:{m:1.4},OFFSET_X:{m:0},OFFSET_Y:{m:-2}},LASER_TURRET:{ANTENNA_WIDTH:{m:0.1},ANTENNA_HEIGHT:{m:1.4},ANTENNA_OFFSET_X:{m:0},ANTENNA_OFFSET_Y:{m:-2},DISH_WIDTH:{m:2},DISH_HEIGHT:{m:0.5},DISH_OFFSET_X:{m:0},DISH_OFFSET_Y:{m:-1.85}},DOUBLE_BARREL_TURRET:{WIDTH:{m:1.6},HEIGHT:{m:1.1},OFFSET_X:{m:0},OFFSET_Y:{m:-1.75}},SHOTGUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MISSILE_TURRET:{WIDTH:{m:0.3},CENTER_HEIGHT:{m:1.4},SIDE_HEIGHT:{m:0.4},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},GATLING_GUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MAZE_TILE_SIZE:{m:10}};
const sandbox={console,performance,Math,JSON,Array,Object,String,Number,isFinite,parseInt,parseFloat,Infinity,NaN,Date,Constants};sandbox.global=sandbox;
let cacheCleared=0;
sandbox.VantageSandbox={fusedEnabled:()=>true,clearCaches:function(){cacheCleared++;},OPERATIONS:Array.from({length:9},(_,i)=>({name:'op'+i,inputs:{forward:i===1,back:i===2,left:i===3,right:i===4}}))};
const ctx=vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_scoring.js'),'utf8'),ctx,{filename:'s.js'});
vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_tree.js'),'utf8'),ctx,{filename:'t.js'});
const VT=sandbox.VantageTree;

function mk(id,x,y,rot,total) {
    const n=VT.createTreeNode(null,{forward:false,back:false,left:false,right:false},{tank:{x:x,y:y,rot:rot},tGlobal:0});
    n.id=id;n.status='alive';n.fullDeathFrame=-1;n.exhausted=false;n.invalid=false;
    n.plannedFrames=10;n.segmentFrames=10;n.segmentScore=total;n.baseExt=0;n.rolloutTotal=total;n.subtreeBest=total;
    return n;
}

// target API
if(VT.setTargetMixRatio(9)!==3) throw new Error('target mix ratio should clamp to 300%');
VT.setTargetMixRatio(0.5);
VT.setMoveTarget(5,5);
const mt=VT.getMoveTarget();
if(!mt || mt.x!==5 || mt.y!==5) throw new Error('setMoveTarget failed');
if(!VT.clearMoveTarget() && VT.getMoveTarget()!==null) throw new Error('clearMoveTarget failed');

// equal safety score: facing the target wins
{
    const away=mk(1,55,0,0,50);          // target center (55,55); rot 0 faces up
    const toward=mk(2,55,0,Math.PI,50);  // rot PI faces down, toward target
    VT.setMoveTarget(5,5);
    const picked=VT.pickBestChildByRolloutTotal([away,toward]);
    if(picked!==toward) throw new Error('equal scores should prefer the target-facing node');
    if(VT.pickBest([away,toward])!==toward) throw new Error('pickBest equal scores should prefer target-facing node');
}

// different safety score: target must NOT override the higher safety score
{
    const away=mk(3,55,0,0,90);
    const toward=mk(4,55,0,Math.PI,50);
    VT.setMoveTarget(5,5);
    const picked=VT.pickBestChildByRolloutTotal([away,toward]);
    if(picked!==away) throw new Error('higher safety score must win before target scoring');
}

// no target: preserve original behavior (ties fall back to id order)
{
    VT.clearMoveTarget();
    const a=mk(10,55,0,0,50);
    const b=mk(11,55,0,Math.PI,50);
    if(VT.pickBestChildByRolloutTotal([b,a])!==a) throw new Error('without target, id tie-break should be preserved');
}

// hybrid mode: target bonus can override a slightly lower safety score
{
    VT.clearMoveTarget();
    VT.setTargetMixEnabled(false);
    const safeFar=mk(20,0,0,0,100);
    const unsafeNear=mk(21,55,55,0,90);
    VT.setMoveTarget(5,5);
    if(VT.pickBestChildByRolloutTotal([safeFar,unsafeNear])!==safeFar) {
        throw new Error('two-phase mode must keep the higher safety score');
    }
    VT.setTargetMixEnabled(true);
    VT.setTargetMixRatio(1);
    if(VT.pickBestChildByRolloutTotal([safeFar,unsafeNear])!==unsafeNear) {
        throw new Error('hybrid mode should allow target-near lower-safety node to win');
    }
    // two-phase ignores the coefficient: re-enable two-phase, high safety still wins
    VT.setTargetMixEnabled(false);
    VT.setTargetMixRatio(0);
    if(VT.pickBestChildByRolloutTotal([safeFar,unsafeNear])!==safeFar) {
        throw new Error('two-phase mode must ignore target coefficient');
    }
    // hybrid mode still refuses a soft-dead node when an alive node exists
    const aliveSafe=mk(22,0,0,0,90);
    const deadNear=mk(23,55,55,0,100);
    deadNear.status='dead';deadNear.fullDeathFrame=20;
    VT.setTargetMixEnabled(true);VT.setTargetMixRatio(1);
    if(VT.pickBestChildByRolloutTotal([deadNear,aliveSafe])!==aliveSafe) {
        throw new Error('hybrid mode must keep an alive candidate over a soft-dead one');
    }
    VT.setTargetMixEnabled(false);
    VT.setTargetMixRatio(0.5);
}

VT.setMoveTarget(1,1);
VT.reset();
if(VT.getMoveTarget()!==null) throw new Error('reset should clear move target');
if(cacheCleared<1) throw new Error('reset should clear sandbox caches');
console.log('diff_tree_move_target PASS (tie-break + hybrid mix + reset cache clear)');
