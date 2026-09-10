#!/usr/bin/env node
// v88 regression: retreat depth is a real tunable. Deeper search starts higher
// and can pick the globally better sibling; shallow search stays local.
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

function mk(parent,opName,segmentScore,frames){
    const n=VT.createTreeNode(parent,{forward:false,back:false,left:false,right:false},{tank:{x:0,y:0,rot:0},tGlobal:0});
    n.plannedFrames=frames;n.segmentFrames=frames;
    n.rolloutSamples=[{x:0,y:0,rot:0},{x:1,y:0,rot:0}];
    n.perFrameScores=[segmentScore/frames];
    n.segmentScore=segmentScore;n.rolloutTotal=segmentScore;n.subtreeBest=segmentScore;
    n.status='alive';n.fullDeathFrame=-1;n.deathAuthority='fused';n.tEndSec=0.2;n.opName=opName;
    return n;
}
function build(depth){
    const tree=VT.createTree({x:0,y:0,rot:0});
    tree.rootAbsT=0;tree.root.simState={tank:{x:0,y:0,rot:0},tGlobal:0};tree.root.tEndSec=0;
    tree.cfg.retreatDepth=depth;
    VT.setRetreatDepth(depth);

    const A1=mk(tree.root,'A1',5,10);
    const B=mk(tree.root,'B',1000,10);      // globally best, but only reachable at root
    const A2=mk(A1,'A2',5,10);
    const C=mk(A1,'C',1,10);                // local alternative inside A1
    const D=mk(A2,'D',5,10);                // true-dead parent of 9 one-frame dead kids
    VT.attachChild(tree,tree.root,A1);VT.attachChild(tree,tree.root,B);
    VT.attachChild(tree,A1,A2);VT.attachChild(tree,A1,C);
    VT.attachChild(tree,A2,D);
    for(let i=0;i<9;i++){
        const kid=mk(D,'d'+i,0,1);
        kid.status='dead';kid.fullDeathFrame=1;kid.plannedFrames=1;kid.segmentFrames=1;
        VT.attachChild(tree,D,kid);
    }
    return {tree,A1,B,C,D};
}

// depth=1: start at parent A2, then step up to A1; local C wins.
{
    const c=build(1);
    const rt=VT.applyRetreatAfterExpand(c.tree,c.D,{});
    if(rt===null) throw new Error('depth1: retreat target not found');
    if(!c.A1.next||c.A1.next!==c.C) throw new Error('depth1: A1.next should point to local C');
    if(c.tree.root.next===c.B) throw new Error('depth1: should not jump to global B');
    if(c.tree.stats.retreatReroutes!==1) throw new Error('depth1: retreatReroutes should be 1');
}

// depth=3: start at root, global best B wins.
{
    const c=build(3);
    const rt=VT.applyRetreatAfterExpand(c.tree,c.D,{});
    if(rt===null) throw new Error('depth3: retreat target not found');
    if(c.tree.root.next!==c.B) throw new Error('depth3: root.next should point to global B');
    if(c.A1.next) throw new Error('depth3: local A1.next should stay empty');
    if(c.tree.stats.retreatReroutes!==1) throw new Error('depth3: retreatReroutes should be 1');
}

// out-of-range values are clamped by the setter.
VT.setRetreatDepth(0);if(VT.setRetreatDepth(0)!==1) throw new Error('clamp low should be 1');
if(VT.setRetreatDepth(99)!==8) throw new Error('clamp high should be 8');
VT.setRetreatDepth(3);
console.log('diff_tree_retreat_depth PASS (depth=1 local C, depth=3 global B, clamp 1..8)');
