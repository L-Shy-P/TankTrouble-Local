#!/usr/bin/env node
// v88 regression: continuous refine must run on its own switch, even while a
// normal front leaf is still growable (horizon cap ON). It also must not split
// the same long leaf twice.
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

function freshTree(){
    const tree=VT.createTree({x:0,y:0,rot:0});
    tree.rootAbsT=0;tree.root.simState={tank:{x:0,y:0,rot:0},tGlobal:0};tree.root.tEndSec=0;
    tree.threats=[];tree._hasOffsetThreats=false;tree._pendingThreats=[];
    return tree;
}
function mkLeaf(parent,op,tEnd,segFrames,total){
    const n=VT.createTreeNode(parent,{forward:op===1,back:op===2,left:op===3,right:op===4},{tank:{x:0,y:0,rot:0},tGlobal:Math.max(0,tEnd-segFrames*0.02)});
    n.status='alive';n.fullDeathFrame=-1;n.rolloutDeathFrame=-1;n.deathAuthority='fused';
    n.plannedFrames=segFrames;n.segmentFrames=segFrames;
    n.rolloutSamples=Array.from({length:segFrames+1},(_,k)=>({x:k*0.01,y:0,rot:0}));
    n.perFrameScores=Array(segFrames).fill(total/segFrames);
    n.segmentScore=total;n.rolloutTotal=total;n.subtreeBest=total;
    n.rolloutStartT=0;n.tEndSec=tEnd;n.opName='op'+op;
    return n;
}
const adapter={constants:{FRAME_DT:0.02},simulateTankBatch:function(state,ops,frames){
    return ops.map(()=>({samples:Array.from({length:frames+1},(_,k)=>({x:state.x+k*0.01,y:state.y,rot:state.rot})),hitWall:false,dead:false,deathFrame:-1}));
}};
function build(withContinuous){
    const tree=freshTree();
    tree.cfg.growWithoutThreats=true;
    tree.cfg.continuousRefine=withContinuous;
    VT.setGrowWithoutThreatsEnabled(true);
    VT.setContinuousRefine(withContinuous);
    const normal=mkLeaf(tree.root,1,0.5,10,10);   // still behind 8s horizon → normal growth
    const longA=mkLeaf(tree.root,2,1.0,75,5);    // long operation → refine target
    const longB=mkLeaf(tree.root,3,1.0,75,5);    // second long operation
    VT.attachChild(tree,tree.root,normal);
    VT.attachChild(tree,tree.root,longA);
    VT.attachChild(tree,tree.root,longB);
    tree.commitNode=normal;tree.root.next=normal;
    return {tree,normal,longA,longB};
}
function refinePrefixes(c){
    return c.tree.root.children.filter(function(k){
        return k!==c.normal&&k!==c.longA&&k!==c.longB&&k.children.length===9;
    });
}

// A. switch OFF: normal leaf expands, long leaves are untouched.
{
    const c=build(false);
    VT.growStep(c.tree,adapter,[]);
    if(c.tree.nodeCount!==13) throw new Error('off: nodeCount should be 13, got '+c.tree.nodeCount);
    if(c.tree.stats.refineSplits) throw new Error('off: continuous refine should not run');
    if(c.longA._refineSplit||c.longB._refineSplit) throw new Error('off: long leaves must not be split');
}

// B. switch ON: normal leaf still expands AND one long operation is split+expanded.
{
    const c=build(true);
    VT.growStep(c.tree,adapter,[]);
    if(!c.tree.stats.refineSplits) throw new Error('on: refine did not run while a normal leaf existed');
    const marked=(c.longA._refineSplit?1:0)+(c.longB._refineSplit?1:0);
    if(marked!==1) throw new Error('on: exactly one long leaf should be marked, got '+marked);
    if(refinePrefixes(c).length!==1) throw new Error('on: refine prefix was not expanded');
    if(c.tree.nodeCount!==23) throw new Error('on: nodeCount should be 23, got '+c.tree.nodeCount);
}

// C. the marked long leaf must not be split twice; next tick refines the other one.
{
    const c=build(true);
    VT.growStep(c.tree,adapter,[]);
    VT.growStep(c.tree,adapter,[]);
    if(c.tree.stats.refineSplits!==2) throw new Error('twice: refineSplits should be 2, got '+c.tree.stats.refineSplits);
    if(!c.longA._refineSplit||!c.longB._refineSplit) throw new Error('twice: both long leaves should be marked');
    const names=refinePrefixes(c).map(function(k){return k.opName;}).sort();
    if(names.length!==2||names[0]===names[1]) throw new Error('twice: same long leaf was refined again ('+names.join(',')+')');
    if(c.tree.nodeCount!==42) throw new Error('twice: nodeCount should be 42, got '+c.tree.nodeCount);
}

VT.setContinuousRefine(false);
VT.setGrowWithoutThreatsEnabled(false);
console.log('diff_tree_continuous_refine PASS (off=13, on=23, two ticks=42, distinct prefixes)');
