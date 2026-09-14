#!/usr/bin/env node
// v100 regression: killfield terrain guidance and user-path priority.
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..');
const Constants={BULLET:{RADIUS:{m:0.25},OFFSET:{m:2.5}},TANK:{WIDTH:{m:3},HEIGHT:{m:4}},BULLET_TURRET:{WIDTH:{m:0.7},HEIGHT:{m:1.4},OFFSET_X:{m:0},OFFSET_Y:{m:-2}},LASER_TURRET:{ANTENNA_WIDTH:{m:0.1},ANTENNA_HEIGHT:{m:1.4},ANTENNA_OFFSET_X:{m:0},ANTENNA_OFFSET_Y:{m:-2},DISH_WIDTH:{m:2},DISH_HEIGHT:{m:0.5},DISH_OFFSET_X:{m:0},DISH_OFFSET_Y:{m:-1.85}},DOUBLE_BARREL_TURRET:{WIDTH:{m:1.6},HEIGHT:{m:1.1},OFFSET_X:{m:0},OFFSET_Y:{m:-1.75}},SHOTGUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MISSILE_TURRET:{WIDTH:{m:0.3},CENTER_HEIGHT:{m:1.4},SIDE_HEIGHT:{m:0.4},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},GATLING_GUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MAZE_TILE_SIZE:{m:10},PIXELS_PER_METER:20};
const sandbox={console,performance,Math,JSON,Array,Object,String,Number,isFinite,parseInt,parseFloat,Infinity,NaN,Date,Constants};sandbox.global=sandbox;
sandbox.VantageSandbox={fusedEnabled:()=>false,OPERATIONS:Array.from({length:9},(_,i)=>({name:'op'+i,inputs:{forward:i===1,back:i===2,left:i===3,right:i===4}}))};
const ctx=vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_scoring.js'),'utf8'),ctx,{filename:'s.js'});
vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_tree.js'),'utf8'),ctx,{filename:'t.js'});
const VT=sandbox.VantageTree;

function mk(id,x,y,total) {
    const n=VT.createTreeNode(null,{forward:false,back:false,left:false,right:false},{tank:{x:x,y:y,rot:0},tGlobal:0});
    n.id=id;n.status='alive';n.fullDeathFrame=-1;n.plannedFrames=10;n.segmentFrames=10;
    n.segmentScore=total;n.baseExt=0;n.rolloutTotal=total;n.subtreeBest=total;
    return n;
}
// 3x1 maze: tile 0 is a dead end, tiles 1/2 are open.
const fakeMaze={
    getWidth:function(){return 3;},
    getHeight:function(){return 1;},
    isPositionInsideMaze:function(){return true;},
    getDeadEndPenalty:function(tile){return tile.x===0?5:0;}
};
VT.setKillfieldEnabled(true);
VT.setKillfieldWeight(1);
VT.ensureKillfield(fakeMaze);
VT.setLiveProjectilesNow(1);
VT.clearMoveTarget();

const deadTile=mk(1,5,5,50);    // tile 0: dangerous
const openTile=mk(2,25,5,50);   // tile 2: safe
if(VT.killfieldScoreAtTank(openTile.simState.tank)<=VT.killfieldScoreAtTank(deadTile.simState.tank)) {
    throw new Error('killfield should rate open tile safer than dead end');
}
if(VT.pickBestChildByRolloutTotal([deadTile,openTile])!==openTile) {
    throw new Error('equal safety scores should prefer higher killfield terrain score');
}

// User path priority: user clicks tile 0, target score must beat killfield.
VT.setMoveTarget(0,0);
if(VT.pickBestChildByRolloutTotal([openTile,deadTile])!==deadTile) {
    throw new Error('user path target must take priority over killfield guidance');
}
VT.clearMoveTarget();
VT.setLiveProjectilesNow(0);
// Empty-field switch semantics:
// killfield ON + empty OFF + no bullets -> static preference wins;
// killfield ON + empty ON  + no bullets -> killfield guides (safe moving node);
// killfield ON + empty OFF + bullets    -> killfield guides.
const staticDanger=mk(3,5,5,50);            // dead-end tile, static
const moveSafe=mk(4,25,5,50);               // open tile, moving
moveSafe.inputs={forward:true,back:false,left:false,right:false};
VT.setKillfieldEnabled(true);VT.setKillfieldWeight(1);VT.clearMoveTarget();
VT.setLiveProjectilesNow(0);VT.setEmptyFieldSafety(false);
if(VT.pickBestChildByRolloutTotal([staticDanger,moveSafe])!==staticDanger) {
    throw new Error('empty OFF + no bullets should stay static');
}
VT.setEmptyFieldSafety(true);
if(VT.pickBestChildByRolloutTotal([staticDanger,moveSafe])!==moveSafe) {
    throw new Error('empty ON + no bullets should let killfield guide');
}
VT.setEmptyFieldSafety(false);VT.setLiveProjectilesNow(1);
if(VT.pickBestChildByRolloutTotal([staticDanger,moveSafe])!==moveSafe) {
    throw new Error('with bullets killfield should guide even when empty OFF');
}

VT.setLiveProjectilesNow(0);
VT.setKillfieldEnabled(false);
console.log('diff_tree_killfield PASS (dead-end avoided; user path dominates; empty-field rules)');
