#!/usr/bin/env node
'use strict';
/* ============================================================================
 * 1-3 第 5 处 sink：vantage_scoring.js `scorePath` 起点帧 fd=0 差分守卫
 * （落盘后不再修改）
 *
 * 做法：把 **PRE 快照** 与 **POST 当前** 两份真实产品源码各自整模块装进 VM，
 * 用同一个假 adapter（samples/track/checkDeath/checkDeathSweep 全部受控）调用
 * `VantageScoring.scorePath(...)`，对拍：
 *   · POST：起点重叠 → dead=true / deathFrame=0 / perFrameScores=[-deathPenalty]
 *   · PRE ：同一输入 → 不是 fd=0（晚判或直接假绿）⟹ 修前必 FAIL
 *   · 对照：正常第 1 帧命中、远处不命中、激光起点重叠 / 激光首帧内穿越
 *
 * 用法：node _tools/headless/_i3_scorepath_fd0_guard.js [preScoringPath]
 * 退出码：0=PASS，1=FAIL。
 * ============================================================================ */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const POST_PATH = path.join(ROOT, 'game_core', 'js', 'vantage_scoring.js');
const PRE_PATH = process.argv[2] || path.join(ROOT, '_backup', 'i3_scoring_fd0_20261012_1235', 'vantage_scoring.js');
const PRE_MD5_EXPECT = 'd7264e6f070229e3328fe3bd53015145';   // 修改前快照
// v174（1-2④ 第6轮）：vantage_scoring.js 仅新增 D2（追别人的追踪导弹不进威胁表 +
//   只读计数导出），本守卫的 16 条 fd=0 语义断言全部不受影响；md5 钉随落盘更新。
const POST_MD5_EXPECT = '5b1f2a9943a76c0070867efddbd3c175';  // v174 落盘值（D2 追加后）

let FAILS = 0, CHECKS = 0;
function check(name, cond, detail) {
  CHECKS++;
  if (!cond) FAILS++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}
function md5(p) { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'); }

function loadModule(p) {
  const src = fs.readFileSync(p, 'utf8');
  const sb = { console: { log: function () {}, warn: function () {} } };
  sb.window = sb;
  // 评分模块的 exactGeom 需要真实 Constants（产品页面里的全局）；只补它读的字段
  sb.Constants = {
    BULLET: { RADIUS: { m: 0.25 }, OFFSET: { m: 0 } },
    TANK: { WIDTH: { m: 3.0 }, HEIGHT: { m: 4.0 } },
    BULLET_TURRET: { OFFSET_Y: { m: -2.0 }, WIDTH: { m: 0.7 }, HEIGHT: { m: 1.4 } }
  };
  vm.createContext(sb);
  vm.runInContext(src, sb, { filename: p });
  if (!sb.VantageScoring || typeof sb.VantageScoring.scorePath !== 'function') {
    throw new Error('VantageScoring.scorePath not found in ' + p);
  }
  return sb.VantageScoring;
}

const DT = 0.02;
function mkSamples(poses) { return poses.map(function (p, i) { return { t: i * DT, x: p[0], y: p[1], rot: p[2] || 0 }; }); }
function mkTrack(pts) { return pts.map(function (p) { return { x: p[0], y: p[1] }; }); }

function pointInTank(tank, p) {
  const c = Math.cos(tank.rot), s = Math.sin(tank.rot);
  const dx = p.x - tank.x, dy = p.y - tank.y;
  const lx = dx * c + dy * s, ly = -dx * s + dy * c;
  return Math.abs(lx) <= 1.5 && Math.abs(ly) <= 2.0;   // 车体 3.0 x 4.0
}
function segRect(tank, seg) {
  if (tank.rot !== 0) return pointInTank(tank, { x: seg.ax, y: seg.ay }) || pointInTank(tank, { x: seg.bx, y: seg.by });
  let t0 = 0, t1 = 1;
  const dx = seg.bx - seg.ax, dy = seg.by - seg.ay;
  const x0 = seg.ax - tank.x, y0 = seg.ay - tank.y;
  function clip(p, q) {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  }
  if (!clip(-dx, x0 + 1.5)) return false;
  if (!clip(dx, 1.5 - x0)) return false;
  if (!clip(-dy, y0 + 2.0)) return false;
  if (!clip(dy, 2.0 - y0)) return false;
  return t1 >= t0;
}

function makeAdapter(c) {
  return {
    constants: { FRAME_DT: DT, MAZE_TILE_SIZE: 10, PATH_STEP_SIZE: 0.1, DEATH_PREFILTER_RADIUS: 4 },
    simulateTank: function () { return { samples: c.samples, hitWall: false, dead: false, deathFrame: -1 }; },
    checkDeath: function (tankState, bulletPositions) {
      for (let i = 0; i < bulletPositions.length; i++) if (pointInTank(tankState, bulletPositions[i])) return true;
      return false;
    },
    checkDeathSweep: function (tankState, segments) {
      for (let i = 0; i < segments.length; i++) if (segRect(tankState, segments[i])) return true;
      return false;
    },
    bulletPosAt: function () { return null; },
    getMazeWallEnv: function () { return null; }
  };
}

function runCase(mod, c) {
  const ad = makeAdapter(c);
  const state = { tank: { x: 0, y: 0, rot: 0 }, tGlobal: 0, nowTGlobal: 0 };
  const inputs = { forward: false, back: false, left: false, right: false };
  const threats = c.threat ? [c.threat] : [];
  return mod.scorePath(ad, state, inputs, c.frames, threats, { deathPenalty: 9, lanePenaltyRatio: 0 });
}
function summarize(r) {
  if (!r) return 'null';
  return 'dead=' + r.dead + ' df=' + r.deathFrame + ' pfs=' + JSON.stringify(r.perFrameScores) + ' total=' + r.totalScore;
}
function ok(r, exp) {
  if (!r || r.dead !== exp.dead || r.deathFrame !== exp.df || r.perFrameScores.length !== exp.pfsLen) return false;
  if (exp.dead) return Math.abs(r.totalScore - exp.total) < 1e-9;
  return true;   // 存活帧的总分由遮蔽几何决定，不硬编码；靠 PRE/POST 逐值一致来钉
}
function sameResult(a, b) {
  return !!a && !!b && a.dead === b.dead && a.deathFrame === b.deathFrame &&
    JSON.stringify(a.perFrameScores) === JSON.stringify(b.perFrameScores) &&
    Math.abs(a.totalScore - b.totalScore) < 1e-9;
}

function threatAt(trackPts, laser) {
  return { id: 'b0', track: mkTrack(trackPts), trackFrameDt: DT, anchorOffset: 0, speed: 9,
           path: mkTrack([trackPts[0], trackPts[trackPts.length - 1]]), sweep: !!laser };
}

/* 期望：POST 必须全部满足；PRE 在 fd0 两例必须不满足 */
const CASES = [
  { name: 'contact_start_overlap', samples: mkSamples([[0, 0], [3, 0], [6, 0]]),
    threat: threatAt([[0, 0], [50, 0], [50, 0]], false), frames: 2,
    expPOST: { dead: true, df: 0, pfsLen: 1, total: -9 }, preMustFail: true },
  { name: 'contact_hit_frame1', samples: mkSamples([[0, 0], [0, 0], [0, 0]]),
    threat: threatAt([[20, 0], [0, 0], [0, 0]], false), frames: 2,
    expPOST: { dead: true, df: 1, pfsLen: 1, total: -9 }, preMustFail: false },
  { name: 'alive_far', samples: mkSamples([[0, 0], [0, 0], [0, 0]]),
    threat: threatAt([[50, 0], [50, 0], [50, 0]], false), frames: 2,
    expPOST: { dead: false, df: -1, pfsLen: 2, total: 0 }, preMustFail: false },
  { name: 'laser_start_overlap', samples: mkSamples([[0, 0], [3, 0], [6, 0]]),
    threat: threatAt([[0, 0], [50, 0], [50, 0]], true), frames: 2,
    expPOST: { dead: true, df: 0, pfsLen: 1, total: -9 }, preMustFail: true },
  { name: 'laser_cross_frame1', samples: mkSamples([[0, 0], [0, 0], [0, 0]]),
    threat: threatAt([[-20, 0], [20, 0], [20, 0]], true), frames: 2,
    expPOST: { dead: true, df: 1, pfsLen: 1, total: -9 }, preMustFail: false }
];

try { (function main() {
  console.log('=== 指纹 ===');
  const preMd5 = md5(PRE_PATH), postMd5 = md5(POST_PATH);
  console.log('  PRE  ' + PRE_PATH + '  md5=' + preMd5);
  console.log('  POST ' + POST_PATH + '  md5=' + postMd5);
  check('PRE 快照 md5 = 记录值 ' + PRE_MD5_EXPECT, preMd5 === PRE_MD5_EXPECT, preMd5);
  check('POST 当前 md5 = 落盘记录值 ' + POST_MD5_EXPECT, postMd5 === POST_MD5_EXPECT, postMd5);
  const postSrc = fs.readFileSync(POST_PATH, 'utf8');
  const preSrc = fs.readFileSync(PRE_PATH, 'utf8');
  check('POST 含第 5 处修复标记（fd=0 第 5 sink）', postSrc.indexOf('fd=0 第 5 sink') >= 0, '');
  check('PRE 不含该标记', preSrc.indexOf('fd=0 第 5 sink') < 0, '');

  const POST = loadModule(POST_PATH);
  const PRE = loadModule(PRE_PATH);

  console.log('=== POST（当前产品源码）必须全过 ===');
  let postFail = 0;
  CASES.forEach(function (c) {
    const r = runCase(POST, c);
    const good = ok(r, c.expPOST);
    if (!good) postFail++;
    check('POST ' + c.name, good, summarize(r) + '  expect dead=' + c.expPOST.dead + ' df=' + c.expPOST.df + ' pfsLen=' + c.expPOST.pfsLen);
  });

  console.log('=== PRE（修改前快照）必须在 fd=0 两例 FAIL ===');
  let preFd0Fail = 0;
  CASES.forEach(function (c) {
    const r = runCase(PRE, c);
    const rPost = runCase(POST, c);   // 同一输入重跑 POST，用于逐值比对
    const good = ok(r, c.expPOST);
    if (c.preMustFail) {
      if (!good) preFd0Fail++;
      check('PRE ' + c.name + '（应 FAIL）', !good, summarize(r));
    } else {
      check('PRE ' + c.name + '（应与 POST 逐值一致）', sameResult(r, rPost), summarize(r));
    }
  });
  check('PRE 恰好 2 例 fd=0 失败', preFd0Fail === 2, 'preFd0Fail=' + preFd0Fail);

  console.log('=== fd 不许被改写成 1 ===');
  const rStart = runCase(POST, CASES[0]);
  check('POST contact_start_overlap → deathFrame===0（不是 1）', rStart.deathFrame === 0, 'df=' + rStart.deathFrame);

  console.log('=== 接线断言（树确实直接调用 scorePath）===');
  const treeSrc = fs.readFileSync(path.join(ROOT, 'game_core', 'js', 'vantage_tree.js'), 'utf8');
  const callers = (treeSrc.match(/VantageScoring\.scorePath\(/g) || []).length;
  check('vantage_tree.js 直接调用 VantageScoring.scorePath 的次数 >= 4', callers >= 4, 'count=' + callers);

  console.log('\n' + (FAILS ? 'SCOREPATH-FD0 GUARD FAILED (' + FAILS + '/' + CHECKS + ')'
                            : 'SCOREPATH-FD0 GUARD PASSED (' + CHECKS + '/' + CHECKS + ')'));
  process.exitCode = FAILS ? 1 : 0;
})(); } catch (e) { console.error('FATAL', (e && e.stack) || e); process.exitCode = 1; }
