#!/usr/bin/env node
// v161 回归：地雷破片不反弹 —— 路径计算必须用 0 次反弹（1 次射线）。
// 依据：Shrapnel.hitMaze 把速度清零（撞墙即停）、done() 在速度≈0 时返回 true。
// 原来一律用全局 pathBounces=5 → 6 次全图射线 × 30 片 = 180 次，是地雷卡死的来源。
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const sb=fs.readFileSync(path.join(root,'js','vantage_sandbox.js'),'utf8');

// ① 必须按弹种决定反弹次数
assert(sb.includes('var effBounces = bounces;'),'getProjectilePaths 必须有按弹种的反弹次数');
assert(/effBounces = 0;/.test(sb),'地雷必须用 0 次反弹');
assert(/p\.getType\(\) === Constants\.WEAPON_TYPES\.MINE/.test(sb),'必须按 MINE 类型判定');
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
