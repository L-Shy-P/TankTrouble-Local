#!/usr/bin/env node
// v118 回归：新弹粗筛必须用**子弹当前位置**量距离（原来用发射点 → 时间基准不一致
// → 子弹飞到跟前还被判"打不到" → 正在执行的节点永不重算 → 绿节点死亡）。
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..');
const Constants={BULLET:{RADIUS:{m:0.25},OFFSET:{m:2.5}},TANK:{WIDTH:{m:3},HEIGHT:{m:4}},BULLET_TURRET:{WIDTH:{m:0.7},HEIGHT:{m:1.4},OFFSET_X:{m:0},OFFSET_Y:{m:-2}},LASER_TURRET:{ANTENNA_WIDTH:{m:0.1},ANTENNA_HEIGHT:{m:1.4},ANTENNA_OFFSET_X:{m:0},ANTENNA_OFFSET_Y:{m:-2},DISH_WIDTH:{m:2},DISH_HEIGHT:{m:0.5},DISH_OFFSET_X:{m:0},DISH_OFFSET_Y:{m:-1.85}},DOUBLE_BARREL_TURRET:{WIDTH:{m:1.6},HEIGHT:{m:1.1},OFFSET_X:{m:0},OFFSET_Y:{m:-1.75}},SHOTGUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MISSILE_TURRET:{WIDTH:{m:0.3},CENTER_HEIGHT:{m:1.4},SIDE_HEIGHT:{m:0.4},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},GATLING_GUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MAZE_TILE_SIZE:{m:10},PIXELS_PER_METER:20};
const sb={console,performance,Math,JSON,Array,Object,String,Number,isFinite,parseInt,parseFloat,Infinity,NaN,Date,Constants};
sb.global=sb; sb.VantageSandbox={fusedEnabled:()=>false,OPERATIONS:Array.from({length:9},(_,i)=>({name:'op'+i,inputs:{forward:i===1,back:i===2,left:i===3,right:i===4}}))};
const ctx=vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_scoring.js'),'utf8'),ctx,{filename:'s.js'});
vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_tree.js'),'utf8'),ctx,{filename:'t.js'});
const VT=sb.VantageTree, C=VT._coarse;
function assert(c,m){ if(!c) throw new Error('ASSERT FAILED: '+m); }
const FRAME=0.02;

// ---- 场景：坦克在 (55,55)，段盒覆盖现在起 14 帧（0.28 秒）----
const now=0.50, rootAbsT=0.0;
C.setNow(now, rootAbsT);
const samples=[];
for(let k=0;k<=14;k++) samples.push({x:55,y:55,rot:0});
const node={rolloutStartT:now-rootAbsT, segmentFrames:14, rolloutSamples:samples};
const nb=C.nodeCoarseBox({rootAbsT:rootAbsT}, node);
assert(Math.abs(nb.t0-now)<1e-9 && Math.abs(nb.t1-(now+0.28))<1e-9, '段盒时间窗应当 = 现在起 14 帧');

// ---- ① bug 场景：子弹 20m/s 从 49 米外发射，已飞到距坦克 9 米处 ----
//     旧代码：dist(发射点→盒) − speed×剩余时间 = 49 − 5.6 = 43.4 > 4 → 误判"打不到"
//     正确：dist(当前位置→盒) − 5.6 = 9 − 5.6 = 3.4 ≤ 4 → 能打到
const track=[];
const launchX=6.0;              // 发射点（约 49 米外）
const speed=20, dtTravel=0.02;
// 已飞 0.5 秒 → 10 米 → 当前在 x=16？要让当前位置距坦克 9 米 → x=46
const travelled=speed*now;      // 10 米
const curX=launchX+travelled;   // 16 → 距坦克 39 米？重算：发射点应更远
// 取发射点 = 坦克x - 9 - travelled = 55-9-10 = 36 → 当前位置 46，距坦克 9 米
const launchX2=55-9-travelled;
const threat={ id:'t1', speed:speed, anchorOffset:0, track:[] };   // track[0] 在 rootAbsT 时刻（=0.5 秒前）
// track[0] = 发射点（绝对时刻 rootAbsT+0），现在 _timeAcc=0.5 → 已飞 0.5 秒
for(let k=0;k<=40;k++) threat.track.push({x:launchX2+k*speed*dtTravel, y:55});
// 用当前位置判定
const pCur=C.threatCurrentPoint(threat);
assert(pCur && Math.abs(pCur.x-46)<1.0, '当前点应当在 x≈46，实际 '+(pCur&&pCur.x));
const cannot=C.bulletCannotReach(threat, pCur, nb);
assert(cannot===false, '子弹已飞到 9 米外、0.45 秒后命中，粗筛必须判"能打到"（旧代码会误判打不到）');

// ---- ② 反例：子弹在远处且背向飞 → 确实打不到 ----
const awayTrack=[];
for(let k=0;k<=40;k++) awayTrack.push({x:1000+k, y:1000});
const away={id:'t2', speed:speed, anchorOffset:0, track:awayTrack};
const pAway=C.threatCurrentPoint(away);
assert(C.bulletCannotReach(away, pAway, nb)===true, '远处背向的子弹应当判"打不到"');

// ---- ③ 回归：旧写法（发射点）在①场景下确实会误判，证明这条修的是真 bug ----
const pStart=C.threatStartPoint(threat);
assert(Math.abs(pStart.x-launchX2)<1e-6, '发射点是 track[0]');
assert(C.bulletCannotReach(threat, pStart, nb)===true,
  '用发射点量距离时确实会误判"打不到"（这就是原来的 bug，回归要守住）');

// ---- ④ 同一 bug 的第二个副本：nodePossiblyAffectedByPending 也必须判"受影响" ----
{
  const node2 = { rolloutStartT: now - rootAbsT, segmentFrames: 14, rolloutSamples: samples };
  const tree2 = { rootAbsT: rootAbsT };
  const boxes2 = [C.threatCoarseBox(threat, rootAbsT)];
  const affected = C.nodePossiblyAffectedByPending(tree2, node2, [threat], boxes2);
  assert(affected === true,
    '正在逼近的子弹必须让节点判为"受影响"（旧写法用发射点会漏判，第二处副本同样致命）');
}

console.log('diff_tree_coarse_reach PASS：新弹粗筛用当前位置（9 米外判"能打到"）；发射点写法会误判（已证明）；远处背向仍正确跳过；两处副本都覆盖');
