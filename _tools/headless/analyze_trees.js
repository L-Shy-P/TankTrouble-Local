'use strict';
/* 分析采集到的真实树分布 —— 用来冻结归一化，别再拍脑袋写"深度 1~20" */
const fs = require('fs');
const path = require('path');
const f = process.argv[2] || path.join(__dirname, 'real_trees.json');
const recs = JSON.parse(fs.readFileSync(f, 'utf8'));

const mn = (a) => a.reduce((x, y) => (y < x ? y : x), Infinity);
const mx = (a) => a.reduce((x, y) => (y > x ? y : x), -Infinity);
const q = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const fin = (a) => a.filter((x) => Number.isFinite(x));

const nodeCounts = [], depths = [], kids = [], fds = [], segs = [], tEnds = [], deadRates = [], roots = [];
for (const r of recs) {
  const byId = new Map();
  for (const n of r.nodes) byId.set(n.id, n);
  nodeCounts.push(r.nodes.length);
  let dead = 0;
  for (const n of r.nodes) {
    let d = 0, p = n.parentId, g = 0;
    while (p !== null && p !== undefined && p !== -1 && byId.has(p) && g++ < 999) { d++; p = byId.get(p).parentId; }
    depths.push(d);
    kids.push(r.nodes.filter((x) => x.parentId === n.id).length);
    const fd = (n.fullDeathFrame === undefined || n.fullDeathFrame === null) ? -1 : n.fullDeathFrame;
    fds.push(fd);
    segs.push(n.segmentFrames || 0);
    tEnds.push(n.tEndSec || 0);
    if (fd >= 0 && fd <= 1) dead++;
  }
  deadRates.push(dead / Math.max(1, r.nodes.length));
  roots.push(r.rootId);
}

const P = (name, a, extra = {}) => ({
  name, n: a.length,
  min: +mn(a).toFixed(3), p25: +q(a, .25).toFixed(3), p50: +q(a, .5).toFixed(3),
  p75: +q(a, .75).toFixed(3), p95: +q(a, .95).toFixed(3), p99: +q(a, .99).toFixed(3),
  max: +mx(a).toFixed(3), mean: +mean(a).toFixed(3), ...extra,
});

console.log(`记录 ${recs.length} 条  文件 ${(fs.statSync(f).size / 1048576).toFixed(1)} MB\n`);
const rows = [
  P('节点总数/记录', nodeCounts),
  P('深度(层)', depths),
  P('子节点数', kids),
  P('段长(帧)', fin(segs)),
  P('fullDeathFrame', fin(fds), { 负一占比: +(fds.filter((x) => x < 0).length / fds.length).toFixed(3) }),
  P('tEndSec(秒)', fin(tEnds)),
  P('真死节点占比', deadRates),
];
const H = ['name', 'n', 'min', 'p25', 'p50', 'p75', 'p95', 'p99', 'max', 'mean'];
for (const h of H) process.stdout.write(String(h).padStart(11));
console.log();
for (const r of rows) {
  for (const h of H) process.stdout.write(String(r[h] === undefined ? '-' : r[h]).padStart(11));
  if (r.负一占比 !== undefined) process.stdout.write(`   fd<0占比=${r.负一占比}`);
  console.log();
}

// 关键归一化建议
console.log('\n===== 归一化建议（按 p99 / max 取，别再用拍脑袋值）=====');
console.log(`  节点数   : / ${Math.max(q(nodeCounts, .99), 1)}   (p99=${q(nodeCounts, .99)}, max=${mx(nodeCounts)})`);
console.log(`  深度     : / ${Math.max(q(depths, .99), 1)}   (p99=${q(depths, .99)}, max=${mx(depths)})`);
console.log(`  子节点数 : / ${Math.max(mx(kids), 1)}`);
console.log(`  段长     : ${mn(fin(segs))} ~ ${mx(fin(segs))} 帧`);
console.log(`  tEndSec  : ${mn(fin(tEnds))} ~ ${mx(fin(tEnds))} 秒`);
const fdPos = fin(fds).filter((x) => x >= 0);
console.log(`  fd>=0    : ${fdPos.length ? mn(fdPos) : '-'} ~ ${fdPos.length ? mx(fdPos) : '-'}`);
console.log(`\n结论：真实树节点数中位数 ${q(nodeCounts, .5)}、p99 ${q(nodeCounts, .99)}、最大 ${mx(nodeCounts)}`);
console.log(`      训练时 pad 到 ${mx(nodeCounts)} 会浪费 ${(1 - mean(nodeCounts) / mx(nodeCounts)).toFixed(1) * 100}% 算力 —— 必须分桶`);
