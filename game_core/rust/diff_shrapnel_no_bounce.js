#!/usr/bin/env node
// v162/v171 回归：地雷破片不反弹（激光 v171 起改为镜面反弹） —— 路径计算必须用 0 次反弹（1 次射线）。
// 依据：Shrapnel.hitMaze 把速度清零（撞墙即停）、done() 在速度≈0 时返回 true。
// 原来一律用全局 pathBounces=5 → 6 次全图射线 × 30 片 = 180 次，是地雷卡死的来源。
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const sb=fs.readFileSync(path.join(root,'js','vantage_sandbox.js'),'utf8');

// ① 必须按弹种决定反弹次数
assert(sb.includes('var effBounces = bounces;'),'getProjectilePaths 必须有按弹种的反弹次数');
// v164：反弹次数改由「弹种档案」决定（原来只特判 MINE 的写法已并入档案）。
assert(sb.includes('projectileProfileOf'),'必须有弹种档案查询');
assert(/effBounces = _profP\.bounces;/.test(sb),'必须从弹种档案取反弹次数');
assert(/put\(W\.MINE,\s*\{[^}]*bounces:\s*0/.test(sb),'地雷破片必须在档案里登记 0 次反弹');
// v171（1-2③）：实测（激光判死几何实测-2026-10-11）证明真激光撞墙是
// **镜面反弹、|v| 不变、0.8s 寿命到才消失**，不是撞墙消失 ⟹ 档案必须是
// `bounces: null`（用全局反弹计数）。旧的 0 是错的，本条随之翻转。
assert(/put\(W\.LASER,\s*\{[^}]*bounces:\s*null/.test(sb),'激光档案必须是 null 反弹次数（真激光镜面反弹）');
assert(!/put\(W\.LASER,\s*\{[^}]*bounces:\s*0/.test(sb),'激光不得再登记 0 次反弹（旧错误语义）');
assert(sb.includes('calculateProjectilePath(world, p, effBounces, maxLen, false)'),
       '必须把 effBounces 传进 calculateProjectilePath');

// ② 依据必须写进注释（以后好查）
assert(sb.includes('hitMaze'),'注释必须写明依据：Shrapnel.hitMaze 清零速度');
assert(sb.includes('撞墙即停、不反弹'),'注释必须写明结论');

// ③ 不能误伤会反弹的弹种（霰弹撞墙后还活 0.7s，是反弹的）
assert(!/SHOTGUN[\s\S]{0,120}effBounces = 0/.test(sb),'霰弹会反弹，不得被判成 0 次');

// ④ 地雷常量口径核对：30 片、速度 25~35、单点出生
const mineSrc=fs.readFileSync(path.join(root,'js','7b2ed8ad3598d7321f8f3d2b04b1eac8.js'),'utf8');
assert(/MINE_NUM_SHRAPNEL/.test(mineSrc),'应能找到 MINE_NUM_SHRAPNEL');
assert(/this\.x,this\.y,speedX,speedY/.test(mineSrc),'破片必须从地雷中心点出发（无半径偏移）');

// ⑤ 0 次反弹 = 1 次射线（读 calculatePath 的循环条件）
const b2d=fs.readFileSync(path.join(root,'js','b714588dc4621fe104113111ba90b1a7.js'),'utf8');
assert(/while\(remainingLength>0&&bounces<=maxBounces\)/.test(b2d),
       'calculatePath 的循环条件必须是 bounces<=maxBounces（maxBounces=0 → 1 次射线）');

console.log('diff_shrapnel_no_bounce PASS (破片 0 次反弹 = 1 次射线，省 6 倍；霰弹不受影响)');
