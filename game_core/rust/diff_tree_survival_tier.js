#!/usr/bin/env node
// v156 回归：存活分层——绿 > 橙 > 红。低层连参选资格都没有。
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const s=fs.readFileSync(path.join(root,'js','vantage_tree.js'),'utf8');

// ① 分层函数存在且口径正确
assert(s.includes('function survivalTierOf'),'缺存活分层');
assert(s.includes('function bestSurvivalTier'),'缺最低层计算');
assert(s.includes('if (survivalTierOf(c) > minTier) continue;'),'pickBestChild 必须按层过滤');
assert(s.includes('if (survivalTierOf(c) > minTierBest) continue;'),'pickBest 必须按层过滤');
// v157 分工：commit 兜底只挡红；绿>橙 的层过滤只在选路阶段
assert(s.includes('best = enforceNonRedPrefer(tree, best, root);'),'commit 兜底必须挡红');
assert(s.includes('if (survivalTierOf(c) > minTier) continue;'),'选路阶段必须做存活分层');

// ② 载入模块跑真实场景
const Constants={BULLET:{RADIUS:{m:0.25},OFFSET:{m:2.5}},TANK:{WIDTH:{m:3},HEIGHT:{m:4}},BULLET_TURRET:{WIDTH:{m:0.7},HEIGHT:{m:1.4},OFFSET_X:{m:0},OFFSET_Y:{m:-2}},LASER_TURRET:{ANTENNA_WIDTH:{m:0.1},ANTENNA_HEIGHT:{m:1.4},ANTENNA_OFFSET_X:{m:0},ANTENNA_OFFSET_Y:{m:-2},DISH_WIDTH:{m:2},DISH_HEIGHT:{m:0.5},DISH_OFFSET_X:{m:0},DISH_OFFSET_Y:{m:-1.85}},DOUBLE_BARREL_TURRET:{WIDTH:{m:1.6},HEIGHT:{m:1.1},OFFSET_X:{m:0},OFFSET_Y:{m:-1.75}},SHOTGUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MISSILE_TURRET:{WIDTH:{m:0.3},CENTER_HEIGHT:{m:1.4},SIDE_HEIGHT:{m:0.4},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},GATLING_GUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MAZE_TILE_SIZE:{m:10}};
const sb={console,performance,Math,JSON,Array,Object,String,Number,isFinite,parseInt,parseFloat,Infinity,NaN,Date,Constants};
sb.global=sb; sb.VantageSandbox={fusedEnabled:()=>true,OPERATIONS:Array.from({length:9},(_,i)=>({name:'op'+i,inputs:{}}))};
const ctx=vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_scoring.js'),'utf8'),ctx);
vm.runInContext(s,ctx,{filename:'t.js'});
const VT=sb.VantageTree;
function kid(fd,total){return {id:Math.random()*1e9|0,invalid:false,exhausted:false,fullDeathFrame:fd,segmentFrames:1,plannedFrames:1,status:fd>=0&&fd<=1?'dead':'alive',segmentScore:total,baseExt:0,rolloutTotal:total,subtreeBest:total,children:[],parent:null,perFrameScores:[total]};}

// 场景A：主人实测的 bug——有绿却选了橙（橙分数高）
const green=kid(-1, 1), orangeHigh=kid(2, 9999);
assert.strictEqual(VT.enforceSurvivalTier({diag:{}}, orangeHigh, {children:[green,orangeHigh]}), green, '有绿时绝不能选橙');
// commit 兜底只挡红：橙不该被换掉（兄弟的绿可能是未确认值）
assert.strictEqual(VT.enforceNonRedPrefer({diag:{}}, orangeHigh, {children:[green,orangeHigh]}), orangeHigh, 'commit 兜底不得把已确认的橙换成未确认的绿');

// 场景B：有绿时也绝不能选红（红分数最高）
const redTop=kid(1, 99999);
assert.strictEqual(VT.enforceSurvivalTier({diag:{}}, redTop, {children:[green,orangeHigh,redTop]}), green, '有绿时绝不能选红');
// commit 兜底只挡红，非红里按分数取最高（不是强制选绿——兄弟的绿可能是未确认值）
assert.strictEqual(VT.enforceNonRedPrefer({diag:{}}, redTop, {children:[green,orangeHigh,redTop]}), orangeHigh, 'commit 兜底挡红后按分数取非红');
assert.strictEqual(VT.enforceNonRedPrefer({diag:{}}, redTop, {children:[redTop,kid(1,5)]}), redTop, '全红=节点真死，commit 兜底不得改选');

// 场景C：没绿时，橙压红
const orangeLow=kid(2, 1), red=kid(1, 9999);
assert.strictEqual(VT.enforceSurvivalTier({diag:{}}, red, {children:[orangeLow,red]}), orangeLow, '没绿时橙压红');

// 场景D：只有红 → 不干预（节点真死）
const r1=kid(1,5), r2=kid(0,999);
assert.strictEqual(VT.enforceSurvivalTier({diag:{}}, r1, {children:[r1,r2]}), r1, '全是红=节点真死，不干预');

// 场景E：选中已是最低层 → 不干预
assert.strictEqual(VT.enforceSurvivalTier({diag:{}}, green, {children:[green,orangeHigh]}), green, '选中绿不得改选');

// 场景F：tier 口径
assert.strictEqual(VT.survivalTierOf(kid(-1,0)), 0, '绿=0');
assert.strictEqual(VT.survivalTierOf(kid(2,0)), 1, '橙=1');
assert.strictEqual(VT.survivalTierOf(kid(3,0)), 1, '橙=1');
assert.strictEqual(VT.survivalTierOf(kid(1,0)), 2, '红=2');
assert.strictEqual(VT.survivalTierOf(kid(0,0)), 2, 'fd=0 也是红');

console.log('diff_tree_survival_tier PASS (绿压橙压红 / 全红不干预 / tier 口径)');
