'use strict';
// 决定性测试：当前选路会不会选"晚死但干净"而放弃"全程存活但被遮蔽压分"的活路？
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..');
const Constants={BULLET:{RADIUS:{m:0.25},OFFSET:{m:2.5}},TANK:{WIDTH:{m:3},HEIGHT:{m:4}},BULLET_TURRET:{WIDTH:{m:0.7},HEIGHT:{m:1.4},OFFSET_X:{m:0},OFFSET_Y:{m:-2}},LASER_TURRET:{ANTENNA_WIDTH:{m:0.1},ANTENNA_HEIGHT:{m:1.4},ANTENNA_OFFSET_X:{m:0},ANTENNA_OFFSET_Y:{m:-2},DISH_WIDTH:{m:2},DISH_HEIGHT:{m:0.5},DISH_OFFSET_X:{m:0},DISH_OFFSET_Y:{m:-1.85}},DOUBLE_BARREL_TURRET:{WIDTH:{m:1.6},HEIGHT:{m:1.1},OFFSET_X:{m:0},OFFSET_Y:{m:-1.75}},SHOTGUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MISSILE_TURRET:{WIDTH:{m:0.3},CENTER_HEIGHT:{m:1.4},SIDE_HEIGHT:{m:0.4},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},GATLING_GUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MAZE_TILE_SIZE:{m:10},PIXELS_PER_METER:20};
const sb={console,performance,Math,JSON,Array,Object,String,Number,isFinite,parseInt,parseFloat,Infinity,NaN,Date,Constants};
sb.global=sb; sb.VantageSandbox={fusedEnabled:()=>false,OPERATIONS:Array.from({length:9},(_,i)=>({name:'op'+i,inputs:{forward:i===1,back:i===2,left:i===3,right:i===4}}))};
const ctx=vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_scoring.js'),'utf8'),ctx,{filename:'s.js'});
vm.runInContext(fs.readFileSync(path.join(root,'js','vantage_tree.js'),'utf8'),ctx,{filename:'t.js'});
const VT=sb.VantageTree;
function mk(op,total,death){const n=VT.createTreeNode(null,{forward:false,back:false,left:false,right:false},{tank:{x:5,y:5,rot:0},tGlobal:0});
 n.id=op; n.status='alive'; n.fullDeathFrame=death; n.plannedFrames=10; n.segmentFrames=10;
 n.segmentScore=total; n.baseExt=0; n.rolloutTotal=total; n.subtreeBest=total; n.opName='op'+op;
 n.perFrameScores=undefined; return n;}
// A：第 60 帧才死、死前全程干净（子弹 3.05m 断崖外看不到）→ 总分 60×39.5≈2370（取 2765 模拟更好情况）
// B：全程存活 75 帧，但躲进被 3 颗弹围住的安全角，40 帧被遮蔽压到 ~8 分/帧 → 总分 ~1700
const A=mk(1,2765,60), B=mk(2,1702,-1);
const pick=VT.pickBestChildByRolloutTotal([A,B]);
// 正式断言见下
console.log('选中 =', pick===A?'A（第60帧死，总分2765）':(pick===B?'B（全程存活，总分1702）':'无'));
console.log(pick===A?'❌ 证明：选了死路 —— 「树有解却操作到死」的机制成立':'✅ 选了活路');

// ---------- 正式断言 ----------
function assert(cond,msg){ if(!cond) throw new Error('ASSERT FAILED: '+msg); }
// ① 有活路就不走死路（主人报的「树明明有解却操作到死」）
{ const A=mk(1,2765,60), B=mk(2,1702,-1);
  const p=VT.pickBestChildByRolloutTotal([A,B]);
  assert(p===B,'必须选全程存活的 B，实际选了 '+(p&&p.opName)); }
// ② 全都死：死得晚的（分高）赢 —— 「双 dead 取活最久」
{ const A=mk(1,2370,60), B=mk(2,1500,20);
  const p=VT.pickBestChildByRolloutTotal([A,B]);
  assert(p===A,'全死时应选死得晚的 A，实际 '+(p&&p.opName)); }
// ③ 段内死亡的仍被旧底线滤掉（status='dead'）
{ const A=mk(1,2961,3); A.status='dead';
  const B=mk(2,100,-1);
  const p=VT.pickBestChildByRolloutTotal([A,B]);
  assert(p===B,'段内死者必须被滤掉，实际 '+(p&&p.opName)); }
// ④ 关遮蔽的对照：活路总分必然最高时本来就该赢（回归不破坏这个）
{ const A=mk(1,2370,60), B=mk(2,2961,-1);
  const p=VT.pickBestChildByRolloutTotal([A,B]);
  assert(p===B,'高分活路必须赢'); }
console.log('diff_tree_select_survival PASS：有活路不走死路；全死取活最久；段内死仍被滤；高分活路照常赢');
