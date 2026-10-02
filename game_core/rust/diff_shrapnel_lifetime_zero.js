#!/usr/bin/env node
// v163 回归：`lifetime === 0` 表示"这颗弹不靠寿命结束"，不得当 0 秒寿命用。
// 原游戏 Projectile.constructor(state, lifetime, ...)；只有地雷破片传 0
// （Shrapnel.create(state, 0, ...)），它靠 done()（速度≈0）结束。
// 旧实现当 0 用 ⇒ lifeLeft=0 ⇒ 融合世界第一帧就杀掉破片 ⇒ 地雷绿死。
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const sb=fs.readFileSync(path.join(root,'js','vantage_sandbox.js'),'utf8');

// ① 必须有 lifetimeSecOf 且 0 走哨兵值
assert(sb.includes('function lifetimeSecOf'),'缺 lifetimeSecOf');
assert(/NO_LIFETIME_SEC = 1e9/.test(sb),'缺哨兵常量');
assert(/return \(lt > 0\) \? lt : NO_LIFETIME_SEC;/.test(sb),'lifetime<=0 必须走哨兵值');

// ② 所有 lifeTotal 取值点都必须走 lifetimeSecOf，不得残留旧写法
assert(!/\(typeof pr\.lifetime === 'number'\) \? pr\.lifetime : 10/.test(sb),
       '不得残留”把 0 当寿命”的旧写法');
const uses=[...sb.matchAll(/lifeTotal = lifetimeSecOf\(pr\)/g)];
assert(uses.length >= 3, '所有 lifeTotal 取值点都要改，实测 '+uses.length);

// ③ 融合世界的逐帧到期判据必须还在（只是破片不再被它命中）
assert(/bs\.lifeLeft -= FRAME;/.test(sb),'融合世界逐帧到期判据必须保留');

// ④ 依据写进注释
assert(sb.includes('Shrapnel.create'),'注释必须写明依据（破片传 0）');
assert(sb.includes('不靠寿命结束'),'注释必须写明语义');

// ⑤ 只有 MINE 传 0 —— 核对原游戏各弹种的 create 参数
const rm=fs.readFileSync(path.join(root,'js','46989e393ad0e356ac8a0c6c53b362f9.js'),'utf8');
const m=[...rm.matchAll(/case Constants\.WEAPON_TYPES\.(\w+):\{projectile=(\w+)\.create\(projectileState,([^,]+),/g)];
const zero=m.filter(x=>/^0$/.test(x[3].trim())).map(x=>x[1]);
assert.deepStrictEqual(zero,['MINE'],'只有 MINE 的 lifetime 是 0，实测: '+JSON.stringify(zero));
console.log('diff_shrapnel_lifetime_zero PASS (lifetime=0 走哨兵值；只有 MINE 是 0)');
