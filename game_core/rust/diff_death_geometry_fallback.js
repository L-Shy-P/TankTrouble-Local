#!/usr/bin/env node
// v153 回归：几何判死必须是"回溯补判"（不改轨迹），且 deathFrame 数的是能走几步。
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const sb=fs.readFileSync(path.join(root,'js','vantage_sandbox.js'),'utf8');

// ① 几何判死扫描存在，但只记不改速
assert(sb.includes('polyGap-scan'),'缺几何判死扫描');
assert(sb.includes('geoHit[i] = k;'),'缺逐帧几何重叠记录');
assert(sb.includes('if (geoHit[i] >= 0) continue;'),'必须只记第一次重叠');

// ② 回溯补判：rollout 跑完后才置 dead，不能在 rollout 中改速
assert(sb.includes('if (!dead[i] && geoHit[i] >= 0)'),'必须是回溯补判');
assert(sb.includes('audit.geometryFallback'),'缺回溯补判标记');
assert(sb.indexOf('if (!dead[i] && geoHit[i] >= 0)') >
       sb.indexOf('for (k = 0; k <= durationFrames; k++)'),
       '回溯补判必须在 rollout 主循环之后');
// 轨迹一致性：rollout 循环内不得因几何判死而置 dead
const loopStart = sb.indexOf('for (k = 0; k <= durationFrames; k++)');
const loopEnd = sb.indexOf('audit.deathFrames = deathFrame.slice();');
const loopBody = sb.slice(loopStart, loopEnd);
assert(!/geoHit\[[^\]]*\]\s*=\s*k;\s*\n\s*dead\[/.test(loopBody),
       '不得在 rollout 循环内因几何判死置 dead（会令 JS/Rust 轨迹分叉）');

// ③ fd 口径：能走几步，不是走完后第几格
assert(sb.includes('deathFrame[i] = geoHit[i];'),'回溯补判必须写 deathFrame');
assert(sb.includes('deathFrame[op] = k;'),'接触扫描必须是同一口径');
assert(!sb.includes('deathFrame[op] = k + 1'),'旧口径 k+1 不得回归');

// ④ 性能：精确多边形距离必须先经 AABB 粗筛
assert(sb.includes('gg.gap < 0.35'),'精确距离必须先 AABB 粗筛');
assert(sb.includes('gGate.gap >= 0.35'),'几何判死也必须先 AABB 粗筛');

console.log('diff_death_geometry_fallback PASS (回溯补判不改轨迹 + 能走几步口径 + 粗筛性能)');
