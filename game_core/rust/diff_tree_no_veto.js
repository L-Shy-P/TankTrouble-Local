#!/usr/bin/env node
// v158 回归：锁死设计语义——软死与存活一视同仁，谁分高选谁；只挡红。
// 这条已经错过两次（v115 的 anyFullSurvivor、v156 的 survivalTier），必须锁住。
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const s=fs.readFileSync(path.join(root,'js','vantage_tree.js'),'utf8');

// ① 不得存在任何"活>死"的一票否决
assert(!s.includes('survivalTierOf'),'v156 的存活分层已撤回，不得残留');
assert(!s.includes('bestSurvivalTier'),'v156 的存活分层已撤回，不得残留');
assert(!s.includes('enforceSurvivalTier'),'v156 的存活分层已撤回，不得残留');
assert(!s.includes('anyFullSurvivor'),'v115 的一票否决不得回归');
assert(!/minTier/.test(s),'不得按存活层级过滤参选资格');

// ② 红（fd<=1）硬过滤保留——主人不变量「只要有非红，红的就绝对不能选」
assert(s.includes('if (!allTrueDead && isTerminalDead(c)) continue;'),'pickBestChild 必须挡红');
assert(s.includes('if (!onlyImmediateDead && isTerminalDead(c)) continue;'),'pickBest 必须挡红');
assert(s.includes('best = enforceNonRedPrefer(tree, best, root);'),'commit 兜底必须挡红');

// ③ 载入模块跑真实场景
const Constants={BULLET:{RADIUS:{m:0.25},OFFSET:{m:2.5}},TANK:{WIDTH:{m:3},HEIGHT:{m:4}},BULLET_TURRET:{WIDTH:{m:0.7},HEIGHT:{m:1.4},OFFSET_X:{m:0},OFFSET_Y:{m:-2}},LASER_TURRET:{ANTENNA_WIDTH:{m:0.1},ANTENNA_HEIGHT:{m:1.4},ANTENNA_OFFSET_X:{m:0},ANTENNA_OFFSET_Y:{m:-2},DISH_WIDTH:{m:2},DISH_HEIGHT:{m:0.5},DISH_OFFSET_X:{m:0},DISH_OFFSET_Y:{m:-1.85}},DOUBLE_BARREL_TURRET:{WIDTH:{m:1.6},HEIGHT:{m:1.1},OFFSET_X:{m:0},OFFSET_Y:{m:-1.75}},SHOTGUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MISSILE_TURRET:{WIDTH:{m:0.3},CENTER_HEIGHT:{m:1.4},SIDE_HEIGHT:{m:0.4},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},GATLING_GUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MAZE_TILE_SIZE:{m:10}};
const sb={console,performance,Math,JSON,Array,Object,String,Number,isFinite,parseInt,parseFloat,Infinity,NaN,Date,Constants};
sb.global=sb; sb.VantageSandbox={fusedEnabled:()=>true,OPERATIONS:Array.from({length:9},(_,i)=>({name:'op'+i,inputs:{}}))};
const ctx=vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_scoring.js'),'utf8'),ctx);
vm.runInContext(s,ctx,{filename:'t.js'});
const VT=sb.VantageTree;
function kid(fd,total){return {id:Math.random()*1e9|0,invalid:false,exhausted:false,fullDeathFrame:fd,segmentFrames:1,plannedFrames:1,status:fd>=0&&fd<=1?'dead':'alive',segmentScore:total,baseExt:0,rolloutTotal:total,subtreeBest:total,children:[],parent:null,perFrameScores:[total]};}

// 【核心】软死（橙）分高 → 允许压过存活（绿）。这是设计语义，不是 bug。
const greenLow=kid(-1, 1), orangeHigh=kid(2, 9999);
assert.strictEqual(VT.enforceNonRedPrefer({diag:{}}, orangeHigh, {children:[greenLow,orangeHigh]}), orangeHigh,
  '软死与存活一视同仁：橙分高就该选橙，不得因"死过"被换掉');

// 软死 fd 大（活更久）也不得被强制优先，仍然看分数
const orangeShortHigh=kid(2, 9999), orangeLongLow=kid(30, 1);
assert.strictEqual(VT.enforceNonRedPrefer({diag:{}}, orangeShortHigh, {children:[orangeShortHigh,orangeLongLow]}), orangeShortHigh,
  '同为软死，只看分数，不看活得久不久');

// 红必须被挡（主人不变量）
const redTop=kid(1, 99999);
assert.strictEqual(VT.enforceNonRedPrefer({diag:{}}, redTop, {children:[greenLow,orangeHigh,redTop]}), orangeHigh,
  '有非红时红的绝对不能选');

// 全红 = 节点真死 → 不干预
const r1=kid(1,5), r2=kid(0,999);
assert.strictEqual(VT.enforceNonRedPrefer({diag:{}}, r1, {children:[r1,r2]}), r1, '全红=节点真死，不干预');

console.log('diff_tree_no_veto PASS (软死/存活一视同仁 · 谁分高选谁 · 只挡红)');
