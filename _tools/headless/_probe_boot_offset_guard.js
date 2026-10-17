'use strict';
/* 证明修法语义（纯 Node，不开浏览器）：
 *   rn 的【恒定 boot 偏移】放行（信息项）；【局内变化】仍硬 FAIL。
 * 用真实失败样本 FAIL_record_20261012-222726.verify.json 的回放帧做 B 侧，
 * 构造 A = B 且 rn 恒 +1 —— 正是观测到的 A=4420/B=4419、1200 帧恒定差 1 的签名。
 *   node _tools/headless/_probe_boot_offset_guard.js
 */
const fs = require('fs'), path = require('path');
const { compareFrames } = require('./record');
const clone = (x) => JSON.parse(JSON.stringify(x));
function brief(c) {
  return { ok: c.ok, rngMismatch: c.rngMismatch, rngBootOffset: c.rngBootOffset, rngOffsetFrames: c.rngOffsetFrames,
           hidden: c.hiddenMismatch, hiddenObs: c.hiddenObsMismatch, pose: c.poseMismatch, proj: c.projMismatch,
           drive: c.driveMismatch, examples: (c.examples || []).slice(0, 2) };
}
(async () => {
  const p = path.join(__dirname, 'prof', 'FAIL_record_20261012-222726.verify.json');
  const vj = JSON.parse(fs.readFileSync(p, 'utf8'));
  const B = (vj.rec && vj.rec.frames) || [];
  if (!B.length) { console.log(JSON.stringify({ ok: false, why: 'no frames in verify.json' })); process.exitCode = 1; return; }

  const self = compareFrames(B, B, 'self');

  // A1: 恒定 +1（真实失败签名）
  const A1 = clone(B); for (const f of A1) if (typeof f.rn === 'number') f.rn += 1;
  const c1 = compareFrames(A1, B, 'const+1');

  // A2: 从第 600 帧起 +1（局内变化 = 真漂移）
  const A2 = clone(B); for (let i = 600; i < A2.length; i++) if (typeof A2[i].rn === 'number') A2[i].rn += 1;
  const c2 = compareFrames(A2, B, 'step@600');

  // A3: 只改一帧
  const A3 = clone(B); if (typeof A3[300].rn === 'number') A3[300].rn += 1;
  const c3 = compareFrames(A3, B, 'single@300');

  // A4: 一侧 rn 缺失
  const A4 = clone(B); delete A4[300].rn;
  const c4 = compareFrames(A4, B, 'missing@300');

  const res = { self: brief(self), const_plus1: brief(c1), step_600: brief(c2), single_300: brief(c3), missing_300: brief(c4) };
  const checks = {
    self_pass: self.ok && self.rngMismatch === 0,
    const_offset_pass: c1.ok && c1.rngMismatch === 0 && Math.abs(c1.rngBootOffset) === 1 && c1.rngOffsetFrames === B.length,
    step_fail: !c2.ok && c2.rngMismatch > 0,
    single_fail: !c3.ok && c3.rngMismatch > 0,
    missing_fail: !c4.ok && c4.rngMismatch > 0,
  };
  fs.writeFileSync(path.join(__dirname, 'prof', 'detfix', 'boot_offset_guard.json'), JSON.stringify({ checks, res }, null, 1));
  console.log(JSON.stringify({ checks, res }, null, 1));
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
})().catch((e) => { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; });
