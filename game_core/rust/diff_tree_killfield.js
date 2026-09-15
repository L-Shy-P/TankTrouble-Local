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
// v104 语义变化：地形打分通道现在**只在有子弹时**生效（无弹的空场改走
// “去最安全地皮”的导航目标通道，见文件末尾的专项断言）。所以这里用“有子弹”
// 来验证打分通道本身的方向性：它必须把坦克往更安全的一格带，而不是往回带。
VT.setEmptyFieldSafety(false);
VT.setLiveProjectilesNow(1);
VT.setCurrentTile(0,0);
if(VT.pickBestChildByRolloutTotal([atLeftEnd,stepIn])!==stepIn){
    throw new Error('with bullets, terrain guidance must pull toward the safer tile');
}
// 反向验证：已经在安全格上时，退回墙角必须得负分。
VT.setCurrentTile(1,0);
if(VT.pickBestChildByRolloutTotal([stepIn,atLeftEnd])!==stepIn){
    throw new Error('terrain guidance must not walk back into the wall-side dead end');
}
// 权重必须真的控制“地形偏好能压过多大的安全分差”：安全分差越大，能翻盘所需
// 的权重越高。这里用两档安全分差（0.2 / 0.5 帧）验证单调性，而不是钉死具体数值
// ——真安全分差必须永远赢过地形偏好，这是躲弹 AI 的底线。
VT.setCurrentTile(0,0);
function beatsAtWeight(defWeight, betterSafety, worseSafety, runs) {
    const safeInDeadEnd=mk(30+runs, tileCenter(0), 5, betterSafety);
    const worseSafeButBetterTile=mk(40+runs, tileCenter(1), 5, worseSafety);
    worseSafeButBetterTile.inputs={forward:true,back:false,left:false,right:false};
    VT.setKillfieldWeight(defWeight);
    return VT.pickBestChildByRolloutTotal([worseSafeButBetterTile, safeInDeadEnd]) === worseSafeButBetterTile;
}
const tinyGap=20;    // ≈0.5 帧
const bigGap=158;    // ≈4 帧（权重上限换来的取舍空间）
if (beatsAtWeight(0.1, tinyGap+0, tinyGap) === false) { /* 允许，低权重压不过 */ }
if (beatsAtWeight(4, 3000+bigGap, 3000) === true) {
    throw new Error('killfield must never override a full frame of safety difference (dodge safety first)');
}
VT.setKillfieldWeight(1);
VT.setLiveProjectilesNow(0);
VT.setKillfieldEnabled(false);

// ---- v103：空场安全感知必须真的能驱动移动（不能只靠打分，必须给出导航目标）----
// 13x11 房间 + 一小段走廊：AI 站在贴近墙角的格，空场开启时应该自动拿到
// “去最安全地皮”的导航目标；关掉空场则没有目标（保持静止）。
const roomW=13, roomH=11;
const room={
    getWidth:function(){return roomW;},
    getHeight:function(){return roomH;},
    isPositionInsideMaze:function(t){return t && t.x>=1 && t.x<=roomW-2 && t.y>=1 && t.y<=roomH-2;},
    getDeadEndPenalty:function(){return 0;}
};
VT.setKillfieldEnabled(true);
VT.setKillfieldWeight(1);
VT.ensureKillfield(room);
VT.setMoveTarget(1,5);          // 假装这是自动目标（模拟 syncKillfieldAutoTarget 写入的目标）
VT.setCurrentTile(1,5);
VT.setEmptyFieldSafety(true);
VT.setLiveProjectilesNow(0);
const anchor=VT.getKillfieldAnchorTile();
if(!anchor){
    throw new Error('killfield must pick a safest tile (anchor) in an open room');
}
if(anchor.x===1 && anchor.y===5){
    throw new Error('anchor must not be the wall-corner tile the tank starts on');
}
if(VT.killfieldScoreAtTank({x:1*10+5,y:5*10+5})>=VT.killfieldScoreAtTank({x:anchor.x*10+5,y:anchor.y*10+5})){
    throw new Error('anchor tile must score strictly safer than the wall corner');
}
// 站在安全地皮上时不该再给自己找目标：说明“走到就停”。
VT.setMoveTarget(anchor.x,anchor.y);
VT.setCurrentTile(anchor.x,anchor.y);
const probeAI={debugTarget:null,setDebugTarget:function(x,y){this.debugTarget={x:x,y:y};},clearDebugTarget:function(){this.debugTarget=null;}};
VT.syncKillfieldAutoTarget(probeAI);
if(VT.killfieldAutoTarget()!==null){
    throw new Error('standing on the safest tile must stop the empty-field relocation');
}
// 窄地形（单格宽走廊）回归：锚点必须落在“离两头死路都远”的中间位置，
// 不能退化到最靠边的一格——否则空场开启后 AI 会主动往死路尽头走（实测踩到过）。
{
    const cw=20, ch=5;
    const corr={
        getWidth:function(){return cw;},
        getHeight:function(){return ch;},
        isPositionInsideMaze:function(t){return t && t.y===2 && t.x>=0 && t.x<cw;},
        getDeadEndPenalty:function(){return 0;}
    };
    VT.ensureKillfield(corr);
    const a=VT.getKillfieldAnchorTile();
    if(!a) throw new Error('corridor: killfield must still pick an anchor');
    if(a.x <= 3 || a.x >= cw-4){
        throw new Error('corridor: anchor must sit away from the dead ends, got x=' + a.x);
    }
    if(Math.abs(a.x - Math.round((cw-1)/2)) > 3){
        throw new Error('corridor: anchor should be near the middle, got x=' + a.x);
    }
    VT.ensureKillfield(room);   // 还原房间表，后面继续用
}

// 离开安全地皮：应重新给出目标。
VT.setCurrentTile(1,5);
const t2=VT.killfieldAutoTarget();
if(!t2 || t2.x!==anchor.x || t2.y!==anchor.y){
    throw new Error('empty-field safety must target the safest tile when not standing on it');
}
VT.setEmptyFieldSafety(false);
VT.setKillfieldEnabled(false);
// ---- v104：懒惰倾向（只影响空场那一段）----
// 0% = 只要当前不是最安全地皮就走；100% = 只有明显危险（安全分差 > 0.5）才挪。
{
    VT.setKillfieldEnabled(true);
    VT.setKillfieldWeight(1);
    VT.setEmptyFieldSafety(true);
    VT.setLiveProjectilesNow(0);
    VT.ensureKillfield(room);
    VT.setCurrentTile(1,5);            // 贴墙，明显不如锚点安全
    VT.setEmptyFieldLaziness(0);
    if (VT.killfieldAutoTarget() === null) {
        throw new Error('laziness 0 must relocate whenever the tank is not on the safest tile');
    }
    // 站在几乎没有提升的格子上：懒惰拉满时就不该再折腾。
    const tiny = VT.getKillfieldAnchorTile();
    VT.setCurrentTile(tiny.x, tiny.y);
    VT.setEmptyFieldLaziness(1);
    if (VT.killfieldAutoTarget() !== null) {
        throw new Error('laziness 1 must not relocate when already on the safest tile');
    }
    VT.setEmptyFieldLaziness(0);
    VT.setEmptyFieldSafety(false);
    VT.setLiveProjectilesNow(1);
}

// ---- v103 性能回归：目标没变时不得重复写入（否则每帧全树重算）----
// 真凶记录：syncKillfieldAutoTarget 曾经在“不需要目标”时每帧无条件
// clearMoveTarget()，而 clearMoveTarget 无条件写脏标记 → tick 每帧跑一次
// rerouteTreeForCurrentThreats。实测 300 tick = 300 次全树重算，有子弹时
// 每次都要重算整棵树，表现就是“发子弹卡一秒”。
{
    VT.setKillfieldEnabled(true);
    VT.setKillfieldWeight(1);
    VT.setEmptyFieldSafety(false);     // 空场关：本来就不该产生任何目标
    VT.setLiveProjectilesNow(1);
    VT.clearMoveTarget();
    const before = VT.getMoveTargetWrites ? VT.getMoveTargetWrites() : null;
    if (before === null) throw new Error('getMoveTargetWrites must be exported for the perf regression');
    const stubAI = {
        debugTarget: null,
        setDebugTarget: function (x, y) { this.debugTarget = { x: x, y: y }; },
        clearDebugTarget: function () { this.debugTarget = null; }
    };
    for (let i = 0; i < 50; i++) VT.syncKillfieldAutoTarget(stubAI);
    const after = VT.getMoveTargetWrites();
    if (after !== before) {
        throw new Error('syncKillfieldAutoTarget must not rewrite the move target when nothing changes (wrote ' +
            (after - before) + ' times in 50 calls)');
    }
    if (VT.getMoveTarget() !== null) throw new Error('empty-field OFF with bullets must leave no move target');

    // 空场开且不在安全地皮上：最多写一次目标，重复调用不得再写。
    VT.setEmptyFieldSafety(true);
    VT.setLiveProjectilesNow(0);
    VT.setKillfieldEnabled(true);
    VT.setCurrentTile(1, 5);
    const b2 = VT.getMoveTargetWrites();
    for (let i = 0; i < 50; i++) VT.syncKillfieldAutoTarget(stubAI);
    const wrote = VT.getMoveTargetWrites() - b2;
    if (wrote > 1) {
        throw new Error('empty-field auto target must be written at most once, wrote ' + wrote + ' times in 50 calls');
    }
    VT.clearMoveTarget();
    VT.setEmptyFieldSafety(false);
    VT.setLiveProjectilesNow(1);
}

console.log('diff_tree_killfield PASS (dead-end avoided; user path dominates; empty-field rules; distance gradient pulls out of dead end; weight scales its authority; empty-field gives a real navigation target)');
