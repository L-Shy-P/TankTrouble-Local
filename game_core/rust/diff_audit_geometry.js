#!/usr/bin/env node
// v149 回归：几何审计必须覆盖全部 sensor 夹具，且接触瞬间要记真值、体积要有上限。
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const sb=fs.readFileSync(path.join(root,'js','vantage_sandbox.js'),'utf8');
const tr=fs.readFileSync(path.join(root,'js','vantage_tree.js'),'utf8');

// ① 必须返回"全部" sensor 夹具，而不是覆盖式只留一个
assert(sb.includes('function fusedSensorAabbs(body)'), '缺少 fusedSensorAabbs（复数）');
assert(sb.includes('out.push(a);'), '必须把每个 sensor 夹具都 push，不能 out= 覆盖');
assert(!/function fusedSensorAabb\(body\)[\s\S]{0,600}out = \{ minX/.test(sb),
       'v148 覆盖式 fusedSensorAabb 的 bug 不能回归');

// ② gap 要在多个夹具里取最小
assert(sb.includes('for (var i = 0; i < boxes.length; i++)'), 'gap 必须遍历全部 sensor 夹具');

// ③ 接触瞬间必须记录真值
for (const f of ['auditContactTruth','gapAtContact','sensorCount']) assert(sb.includes(f),'缺接触真值字段 '+f);

// ④ 体积上限：坐标压小数 + 只留近失 + 条数上限
assert(sb.includes('function fusedR2(v)'), '必须有坐标压缩函数');
assert(sb.includes('gv.polyGap < 2.0'), 'proximity 必须只留近失');
assert(sb.includes('gk2.length > 16'), 'proximity 必须有条数上限');
assert(tr.includes('recent: ah.slice(-6)'), 'recent 必须收敛到 6 条');

// ⑤ 死亡时整树快照（回答"分叉红、选中橙"）
for (const f of ['compactTreeDump','deathTree','commitIds']) assert(tr.includes(f),'缺整树快照 '+f);
assert(tr.includes('out.length >= 600'), '整树快照必须有节点上限');

console.log('diff_audit_geometry PASS (全夹具 gap / 接触真值 / 体积上限 / 死亡整树快照)');
