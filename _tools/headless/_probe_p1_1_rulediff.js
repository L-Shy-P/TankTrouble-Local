'use strict';
/* 阶段1-1 探针：规则版决策「校准开 vs 校准关」逐帧对拍（同一条随机序列 = 同一张图/同一个世界）
 *
 *   node _tools/headless/_probe_p1_1_rulediff.js <A.jsonl> <B.jsonl>
 *
 * 两份 JSONL 由 _probe_p1_1_dt.js 产出：
 *   A: --case laika --tag rule_on  --dump-rng rng.json
 *   B: --case laika --tag rule_off --rngseq rng.json --calib-off
 * 输出：首个决策分歧帧、分歧帧占比、位姿最大差、RNG 消费是否对齐。
 */
const fs = require('fs');
const A = process.argv[2], B = process.argv[3];
if (!A || !B) { console.error('用法: node _probe_p1_1_rulediff.js <A.jsonl> <B.jsonl>'); process.exit(2); }
const load = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
const a = load(A), b = load(B);
const n = Math.min(a.length, b.length);
let firstOp = null, firstCommit = null, firstPose = null, firstRng = null;
let firstCommitA = null, firstCommitB = null, firstTEnd = null, firstNodes = null;
let opDiff = 0, commitDiff = 0, poseDiff = 0, rngDiff = 0, tEndDiff = 0, nodeDiff = 0;
let maxPose = 0, endPoseA = null, endPoseB = null;
for (let i = 0; i < n; i++) {
  const x = a[i], y = b[i];
  if (x.op !== y.op) { opDiff++; if (firstOp === null) firstOp = x.f; }
  const ka = x.commit && (x.commit.id + '|' + x.commit.op + '|' + x.commit.seg + '|' + x.commit.st + '|' + x.commit.fd);
  const kb = y.commit && (y.commit.id + '|' + y.commit.op + '|' + y.commit.seg + '|' + y.commit.st + '|' + y.commit.fd);
  if (ka !== kb) {
    commitDiff++;
    if (firstCommit === null) { firstCommit = x.f; firstCommitA = ka; firstCommitB = kb; }
  }
  const ta = x.commit ? x.commit.tEnd : null, tb = y.commit ? y.commit.tEnd : null;
  if (ta !== tb) { tEndDiff++; if (firstTEnd === null) firstTEnd = x.f; }
  if (x.nodes !== y.nodes) { nodeDiff++; if (firstNodes === null) firstNodes = x.f; }
  if (x.tank && y.tank) {
    const d = Math.hypot(x.tank.x - y.tank.x, x.tank.y - y.tank.y);
    if (d > 1e-6) { poseDiff++; if (firstPose === null) firstPose = x.f; }
    if (d > maxPose) maxPose = d;
    if (i === n - 1) { endPoseA = x.tank; endPoseB = y.tank; }
  }
  if (x.rngIdx !== y.rngIdx) { rngDiff++; if (firstRng === null) firstRng = x.f; }
}
const fdA = a[0] && a[0].frameDt, fdB = b[0] && b[0].frameDt;
console.log('A = ' + A);
console.log('B = ' + B);
console.log('帧数 A/B = ' + a.length + '/' + b.length + '   对比前 ' + n + ' 帧');
console.log('首帧 FRAME_DT: A=' + fdA + ' B=' + fdB + ' ; 末帧 FRAME_DT: A=' + (a[a.length-1]||{}).frameDt + ' B=' + (b[b.length-1]||{}).frameDt);
console.log('首个 op 分歧帧 = ' + firstOp + ' ; 首个 commitNode 分歧帧 = ' + firstCommit +
  ' ; 首个位姿分歧帧 = ' + firstPose + ' ; 首个 RNG 消费分歧帧 = ' + firstRng);
console.log('分歧帧数: op ' + opDiff + '/' + n + ' (' + (100*opDiff/n).toFixed(1) + '%)' +
  ' ; commit(不含tEnd) ' + commitDiff + '/' + n + ' ; tEnd ' + tEndDiff + '/' + n +
  ' ; nodes ' + nodeDiff + '/' + n + ' ; 位姿>1e-6 ' + poseDiff + '/' + n + ' ; rngIdx ' + rngDiff + '/' + n);
console.log('首个 commit(不含tEnd) 分歧帧 = ' + firstCommit + ' ; tEnd 首个分歧帧 = ' + firstTEnd + ' ; nodes 首个分歧帧 = ' + firstNodes);
console.log('位姿最大差 = ' + maxPose.toFixed(4) + ' m ; 末帧位姿 A=' + JSON.stringify(endPoseA) + ' B=' + JSON.stringify(endPoseB));
console.log('末帧 rng overflow A=' + (a[a.length-1]||{}).rngOverflow + ' B=' + (b[b.length-1]||{}).rngOverflow);
if (firstCommitA !== null) console.log('首个 commit 分歧详情: A=' + firstCommitA + '  B=' + firstCommitB);
