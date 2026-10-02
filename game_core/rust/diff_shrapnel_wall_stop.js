#!/usr/bin/env node
// v162 回归：破片撞墙即停（复刻 Shrapnel.hitMaze 的速度清零），融合世界不得让它反弹。
// 实证：录制 vantage_record_1790925717252.json 地雷致死时
//   placements=30/36/72、contacts=[]、dfs=[-1]、killer polyGap=1.22
//   —— 破片在融合世界里该停的地方弹走了，擦过 1.22 米 → 树全绿 → 死。
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const sb=fs.readFileSync(path.join(root,'js','vantage_sandbox.js'),'utf8');

// ① 必须标记破片
assert(sb.includes('slot.isShrapnel'),'摆弹时必须标记破片');
assert(/getType\(\) === Constants\.WEAPON_TYPES\.MINE/.test(sb),'必须按 MINE 类型判定');

// ② 必须做方向变化的检测（反弹 = 方向变）
assert(sb.includes('bs.prevDirX'),'必须记上一帧方向');
assert(/dot < 0\.999/.test(sb),'必须用方向点积判反弹');
assert(/SetLinearVelocity\(Box2D\.Common\.Math\.b2Vec2\.Make\(0, 0\)\)/.test(sb.slice(sb.indexOf('bs.isShrapnel && bs.prevDirX'))),
       '撞墙后必须把速度清零');

// ③ 只对破片生效，不能误伤会反弹的弹种
const idx=sb.indexOf('bs.isShrapnel && bs.prevDirX');
const blk=sb.slice(idx, idx+700);
assert(blk.includes('bs.active = false'),'撞墙后必须停用该破片');
assert(!/SHOTGUN|GATLING|DOUBLE_BARREL/.test(blk),'反弹弹种不得被这条影响');

// ④ 依据写进注释（以后好查）
assert(sb.includes('Shrapnel.hitMaze'),'注释必须写明依据');
assert(sb.includes('polyGap=1.22'),'注释必须写明实证数据');

// ⑤ 地雷破片不反弹这条语义，和 §9.6 语义表一致
const doc=fs.readFileSync(path.join(root,'..','docs','Vantage躲弹实现','待查清单-不确定项与判别方法.md'),'utf8');
assert(doc.includes('9.6 各弹种物理语义总表'),'文档必须有弹种语义表');
assert(/MINE\(破片\)[\s\S]{0,80}速度清零/.test(doc),'语义表必须写明破片速度清零');

console.log('diff_shrapnel_wall_stop PASS (破片撞墙清零停止，反弹弹种不受影响)');
