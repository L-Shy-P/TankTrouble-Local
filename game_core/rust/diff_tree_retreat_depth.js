#!/usr/bin/env node
// v89 regression: retreat amount has two independent units (nodes and frames).
// Node limit picks how many ancestors to climb; frame limit stops earlier when
// the undone segments already add up to the frame budget.
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
function build(nodeLimit,frameLimit){
    const tree=VT.createTree({x:0,y:0,rot:0});
    tree.rootAbsT=0;tree.root.simState={tank:{x:0,y:0,rot:0},tGlobal:0};tree.root.tEndSec=0;
    tree.cfg.retreatNodes=nodeLimit;
    tree.cfg.retreatFrames=frameLimit;
    VT.setRetreatNodes(nodeLimit);
    VT.setRetreatFrames(frameLimit);

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

// A. node limit 1: starts at parent A2, then the search still walks up to A1;
//    local C is picked (node unit drives).
{
    const c=build(1,200);
    const rt=VT.applyRetreatAfterExpand(c.tree,c.D,{});
    if(rt===null) throw new Error('nodes=1: retreat target not found');
    if(!c.A1.next||c.A1.next!==c.C) throw new Error('nodes=1: A1.next should point to local C');
    if(c.tree.root.next===c.B) throw new Error('nodes=1: should not jump to global B');
    if(c.tree.stats.retreatReroutes!==1) throw new Error('nodes=1: retreatReroutes should be 1');
}

// B. node limit 3: starts at root; global best B wins (node unit drives).
{
    const c=build(3,200);
    const rt=VT.applyRetreatAfterExpand(c.tree,c.D,{});
    if(rt===null) throw new Error('nodes=3: retreat target not found');
    if(c.tree.root.next!==c.B) throw new Error('nodes=3: root.next should point to global B');
    if(c.A1.next) throw new Error('nodes=3: local A1.next should stay empty');
    if(c.tree.stats.retreatReroutes!==1) throw new Error('nodes=3: retreatReroutes should be 1');
}

// C. frame limit 10 with a large node limit: one 10-frame segment fills the
//    budget, so the search starts low (A2) and local C wins (frame unit drives).
{
    const c=build(32,10);
    const rt=VT.applyRetreatAfterExpand(c.tree,c.D,{});
    if(rt===null) throw new Error('frames=10: retreat target not found');
    if(!c.A1.next||c.A1.next!==c.C) throw new Error('frames=10: A1.next should point to local C');
    if(c.tree.root.next===c.B) throw new Error('frames=10: should not jump to global B');
}

// D. frame limit 200: budget is not reached, node limit also large → root/B.
{
    const c=build(32,200);
    const rt=VT.applyRetreatAfterExpand(c.tree,c.D,{});
    if(rt===null) throw new Error('frames=200: retreat target not found');
    if(c.tree.root.next!==c.B) throw new Error('frames=200: root.next should point to global B');
}

// setters clamp to the documented ranges; old setRetreatDepth stays an alias.
if(VT.setRetreatNodes(0)!==1) throw new Error('retreatNodes low clamp should be 1');
if(VT.setRetreatNodes(99)!==32) throw new Error('retreatNodes high clamp should be 32');
if(VT.setRetreatFrames(5)!==10) throw new Error('retreatFrames low clamp should be 10');
if(VT.setRetreatFrames(999)!==200) throw new Error('retreatFrames high clamp should be 200');
if(VT.setRetreatDepth(5)!==5) throw new Error('setRetreatDepth alias should map to nodes');
VT.setRetreatNodes(3);VT.setRetreatFrames(200);VT.setRetreatDepth(3);
console.log('diff_tree_retreat_depth PASS (nodes=1 local C, nodes=3 global B, frames=10 local C, frames=200 global B, clamp ok)');
