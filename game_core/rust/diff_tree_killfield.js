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
VT.setCurrentTile(0,0);   // v102: 杀戮场按“相对当前格子的安全提升”打分

const deadTile=mk(1,5,5,50);    // tile 0: dangerous
const openTile=mk(2,25,5,50);   // tile 2: safe
if(VT.killfieldScoreAtTank(openTile.simState.tank)<=VT.killfieldScoreAtTank(deadTile.simState.tank)) {
    throw new Error('killfield should rate open tile safer than dead end');
}
if(VT.pickBestChildByRolloutTotal([deadTile,openTile])!==openTile) {
    throw new Error('equal safety scores should prefer higher killfield terrain score');
}
// v102: 当前格就是安全格时，再往同分格走不该有加成（静止 0 分）。
VT.setCurrentTile(2,0);
if(VT.pickBestChildByRolloutTotal([deadTile,openTile])!==openTile) {
    throw new Error('killfield must not reward moving backwards into a worse tile');
}
if(VT.killfieldScoreAtTank(deadTile.simState.tank)>=VT.killfieldScoreAtTank(openTile.simState.tank)) {
    throw new Error('killfield score at current safe tile must still rank terrain correctly');
}
VT.setCurrentTile(0,0);

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

// ---- v102: 距离梯度必须在“空场 + 无弹 + 地图开阔”时真的把 AI 拉向安全区 ----
// 7x1 直走廊：两端是贴墙的死角，中间 5 格是开阔安全区。AI 站在最左端，
// 它能做的“前进”和“静止”两个操作，安全分完全一样（都没子弹），唯一
// 的区别就是距离梯度 —— 这正是主人说“空场开关没用、AI 不提前走”的场景。
const corridor={
    getWidth:function(){return 7;},
    getHeight:function(){return 1;},
    isPositionInsideMaze:function(){return true;},
    getDeadEndPenalty:function(tile){return (tile.x===0||tile.x===6)?5:0;}
};
VT.setKillfieldEnabled(true);
VT.setKillfieldWeight(1);
VT.ensureKillfield(corridor);       // 迷宫引用变了，会重建表
VT.clearMoveTarget();
VT.setLiveProjectilesNow(0);
VT.setEmptyFieldSafety(true);
const tileCenter=t=>t*10+5;
const atLeftEnd=mk(10,tileCenter(0),5,2960);      // 第 0 格：贴墙死角
const stepIn=mk(11,tileCenter(1),5,2960);         // 第 1 格：往开阔区挪了一步
stepIn.inputs={forward:true,back:false,left:false,right:false};
if(VT.killfieldScoreAtTank(stepIn.simState.tank)<=VT.killfieldScoreAtTank(atLeftEnd.simState.tank)){
    throw new Error('corridor: tile 1 must score safer than the wall-side dead end tile 0');
}
VT.setCurrentTile(0,0);
if(VT.pickBestChildByRolloutTotal([atLeftEnd,stepIn])!==stepIn){
    throw new Error('empty-field safety must pull the tank out of the wall-side dead end');
}
// 反向验证：已经在安全格上时，退回墙角不该有加成。
VT.setCurrentTile(1,0);
if(VT.pickBestChildByRolloutTotal([stepIn,atLeftEnd])!==stepIn){
    throw new Error('empty-field safety must not walk back into the wall-side dead end');
}
// 权重必须真的控制“能压过多大的安全分差”：安全分差 20 分时，低权重压不过，
// 高权重（400%，主人要的上限）要能压过并选择更安全的走位。
const worseSafetyButSaferTile=mk(12,tileCenter(1),5,2980);
worseSafetyButSaferTile.inputs={forward:true,back:false,left:false,right:false};  // 安全分低 20
const betterSafetyInDeadEnd=mk(13,tileCenter(0),5,3000);                          // 安全分高 20
VT.setCurrentTile(0,0);
VT.setKillfieldWeight(0.1);
if(VT.pickBestChildByRolloutTotal([worseSafetyButSaferTile,betterSafetyInDeadEnd])!==betterSafetyInDeadEnd){
    throw new Error('low killfield weight must not override a real safety-score difference');
}
VT.setKillfieldWeight(4);
if(VT.pickBestChildByRolloutTotal([worseSafetyButSaferTile,betterSafetyInDeadEnd])!==worseSafetyButSaferTile){
    throw new Error('400% killfield weight must be able to override a small safety-score difference');
}
VT.setKillfieldWeight(1);
VT.setKillfieldEnabled(false);
console.log('diff_tree_killfield PASS (dead-end avoided; user path dominates; empty-field rules; distance gradient pulls out of dead end; weight scales its authority)');
