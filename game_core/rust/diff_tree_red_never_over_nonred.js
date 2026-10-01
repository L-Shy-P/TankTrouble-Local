#!/usr/bin/env node
// v155 回归：主人不变量——只要有非红候选，红的就绝对不能被选中。
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const s=fs.readFileSync(path.join(root,'js','vantage_tree.js'),'utf8');

// ① 三处过滤都必须用 isTerminalDead（fd<=1），不能只认 fd===1
const oldEq=[...s.matchAll(/fullDeathFrame === 1/g)];
assert(!/if \(!onlyImmediateDead && c\.fullDeathFrame === 1\)/.test(s),'pickBest 的过滤必须改用 isTerminalDead');
assert(!/if \(!allTrueDead && c\.fullDeathFrame === 1\)/.test(s),'pickBestChild 的过滤必须改用 isTerminalDead');
assert(!/if \(c\.fullDeathFrame !== 1\) allTrueDead = false;/.test(s),'allTrueDead 判定必须改用 isTerminalDead');

// ② 必须有选后兜底
assert(s.includes('function enforceNonRedPrefer'),'缺选后兜底');
assert(s.includes('best = enforceNonRedPrefer(tree, best, root);'),'commit 必须调用兜底');
assert(s.includes('red-over-nonred-retarget'),'兜底必须留痕');
assert(s.includes('if (!alt) return chosen;'),'兄弟全是红=节点真死，不得干预');

// ③ 载入模块跑一次真实选择
const Constants={BULLET:{RADIUS:{m:0.25},OFFSET:{m:2.5}},TANK:{WIDTH:{m:3},HEIGHT:{m:4}},BULLET_TURRET:{WIDTH:{m:0.7},HEIGHT:{m:1.4},OFFSET_X:{m:0},OFFSET_Y:{m:-2}},LASER_TURRET:{ANTENNA_WIDTH:{m:0.1},ANTENNA_HEIGHT:{m:1.4},ANTENNA_OFFSET_X:{m:0},ANTENNA_OFFSET_Y:{m:-2},DISH_WIDTH:{m:2},DISH_HEIGHT:{m:0.5},DISH_OFFSET_X:{m:0},DISH_OFFSET_Y:{m:-1.85}},DOUBLE_BARREL_TURRET:{WIDTH:{m:1.6},HEIGHT:{m:1.1},OFFSET_X:{m:0},OFFSET_Y:{m:-1.75}},SHOTGUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MISSILE_TURRET:{WIDTH:{m:0.3},CENTER_HEIGHT:{m:1.4},SIDE_HEIGHT:{m:0.4},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},GATLING_GUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MAZE_TILE_SIZE:{m:10}};
const sb={console,performance,Math,JSON,Array,Object,String,Number,isFinite,parseInt,parseFloat,Infinity,NaN,Date,Constants};
sb.global=sb; sb.VantageSandbox={fusedEnabled:()=>true,OPERATIONS:Array.from({length:9},(_,i)=>({name:'op'+i,inputs:{}}))};
const ctx=vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_scoring.js'),'utf8'),ctx);
vm.runInContext(s,ctx,{filename:'t.js'});
const VT=sb.VantageTree;
function kid(fd,total){return {id:Math.random()*1e9|0,invalid:false,exhausted:false,fullDeathFrame:fd,segmentFrames:1,plannedFrames:1,status:fd>=0&&fd<=1?'dead':'alive',segmentScore:total,baseExt:0,rolloutTotal:total,subtreeBest:total,children:[],parent:null,perFrameScores:[total]};}
// 场景：1 个红(fd=1) + 1 个橙(fd=2)，红的分数高得多 → 必须选橙
const redHigh=kid(1, 9999), orangeLow=kid(2, 1);
const picked=VT.enforceNonRedPrefer({diag:{}}, redHigh, {children:[redHigh,orangeLow]});
assert.strictEqual(picked, orangeLow, '有非红候选时不得选红');
// 场景：全是红 → 不干预
const r1=kid(1,5), r2=kid(0,999);
assert.strictEqual(VT.enforceNonRedPrefer({diag:{}}, r1, {children:[r1,r2]}), r1, '兄弟全是红=节点真死，不得改选');
// 场景：选中的是非红 → 不干预
assert.strictEqual(VT.enforceNonRedPrefer({diag:{}}, orangeLow, {children:[redHigh,orangeLow]}), orangeLow, '选中非红不得干预');
console.log('diff_tree_red_never_over_nonred PASS (红不压非红 / 全红不干预 / fd<=1 口径)');
