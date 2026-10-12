#!/usr/bin/env node
'use strict';
/* ============================================================================
 * 1-3 收尾：vantage_tree.js `mergeIncrementalRescoreDeath` 的 fd=0 sink 差分守卫
 * （落盘后不再修改）
 *
 * 做法：不做手抄 mutant —— 直接从**两份真实产品源码**里用括号配对抽出同一个函数体：
 *   PRE  = _backup/i3_tree_fd0_20261012_1245/vantage_tree.js   （修改前快照，md5 3e3136e1…）
 *   POST = game_core/js/vantage_tree.js                        （当前）
 * 然后喂同一组 (c, r)：
 *   · POST 必须全过（修后必 PASS）
 *   · PRE  必须在 fd=0 那几例上 FAIL（修前必 FAIL，签名= dead:false / df:-1 或 df 变大）
 * 另附两条“接线”断言：函数确实被 applyLayerResults 调用；rescoreTankSamples 确实产出 fd=0。
 *
 * 用法：node _tools/headless/_i3_tree_merge_fd0_guard.js [preTreePath]
 * 退出码：0=PASS，1=FAIL。
 * ============================================================================ */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const POST_TREE = path.join(ROOT, 'game_core', 'js', 'vantage_tree.js');
const PRE_TREE = process.argv[2] || path.join(ROOT, '_backup', 'i3_tree_fd0_20261012_1245', 'vantage_tree.js');

let FAILS = 0, CHECKS = 0;
function check(name, cond, detail) {
  CHECKS++;
  if (!cond) FAILS++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}
function md5(p) { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'); }

/* 从源码里抽出 `function mergeIncrementalRescoreDeath(c, r) { ... }`（括号配对，跳过注释/字符串） */
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  let i = src.indexOf('{', start), depth = 0, inS = null, inLine = false, inBlock = false;
  for (; i < src.length; i++) {
    const ch = src[i], nx = src[i + 1];
    if (inLine) { if (ch === '\n') inLine = false; continue; }
    if (inBlock) { if (ch === '*' && nx === '/') { inBlock = false; i++; } continue; }
    if (inS) { if (ch === String.fromCharCode(92)) { i++; continue; } if (ch === inS) inS = null; continue; }
    if (ch === '/' && nx === '/') { inLine = true; i++; continue; }
    if (ch === '/' && nx === '*') { inBlock = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inS = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unterminated function: ' + name);
}
function loadFn(treePath) {
  const src = fs.readFileSync(treePath, 'utf8');
  return { src, fn: new Function('return (' + extractFn(src, 'mergeIncrementalRescoreDeath') + ')')() };
}

const C_ALIVE = { fullDeathFrame: -1, perFrameScores: [10, 10, 10] };
const C_D0    = { fullDeathFrame: 0,  perFrameScores: [-9] };
const C_D5    = { fullDeathFrame: 5,  perFrameScores: [1, 1, 1, 1, -9] };
const R_ALIVE = { deathFrame: -1, perFrameScores: [2, 2, 2], samples: ['alive'] };
const R_D0    = { deathFrame: 0,  perFrameScores: [-9], samples: ['d0'] };
const R_D3    = { deathFrame: 3,  perFrameScores: [1, 1, -9], samples: ['d3'] };

/* 期望：{name, c, r, dead, df, pfsLen, pfsSource:'r'|'c', preShouldFail:bool} */
const CASES = [
  ['oldAlive+newD0 → 取 0',        C_ALIVE, R_D0,    true,  0, 1, 'r', true],
  ['oldD5+newD0 → 取更早 0',       C_D5,    R_D0,    true,  0, 1, 'r', true],
  ['oldD0+newAlive → 保住 0',      C_D0,    R_ALIVE, true,  0, 1, 'c', true],
  ['oldD0+newD3 → 保住更早 0',     C_D0,    R_D3,    true,  0, 1, 'c', true],
  ['oldAlive+newD3 → 取 3',        C_ALIVE, R_D3,    true,  3, 3, 'r', false],
  ['oldD5+newD3 → 取更早 3',       C_D5,    R_D3,    true,  3, 3, 'r', false],
  ['oldD5+newD7 → keep 5',         C_D5,    { deathFrame: 7, perFrameScores: [1,1,1,1,1,1,-9], samples: ['d7'] }, true, 5, 5, 'c', false],
  ['alive+alive → 活',             C_ALIVE, R_ALIVE, false, -1, 3, 'r', false],
  ['oldD5+newAlive → old 胜',      C_D5,    R_ALIVE, true,  5, 5, 'c', false],
];

function runCase(fn, cs) {
  const out = fn(cs[1].fullFrameless || cs[1], cs[2]);
  if (!out) return { nullOut: true };
  return { dead: out.dead, df: out.deathFrame, pfs: out.perFrameScores,
           pfsLen: out.perFrameScores ? out.perFrameScores.length : -1 };
}
function evalCase(res, cs) {
  const [, c, r, expDead, expDf, expLen, expSrc, ] = cs;
  if (!res || res.nullOut) return { ok: false, why: 'null' };
  const srcOk = expSrc === 'r'
    ? JSON.stringify(res.pfs) === JSON.stringify(r.perFrameScores)
    : JSON.stringify(res.pfs) === JSON.stringify(c.perFrameScores);
  return { ok: res.dead === expDead && res.df === expDf && res.pfsLen === expLen && srcOk,
           why: 'dead=' + res.dead + ' df=' + res.df + ' len=' + res.pfsLen + ' pfs=' + JSON.stringify(res.pfs) };
}

(function main() {
  console.log('=== 指纹 ===');
  console.log('  PRE  ' + PRE_TREE + '  md5=' + md5(PRE_TREE));
  console.log('  POST ' + POST_TREE + '  md5=' + md5(POST_TREE));

  const pre = loadFn(PRE_TREE), post = loadFn(POST_TREE);

  console.log('=== 修后（当前产品源码）必须全过 ===');
  let postFail = 0;
  CASES.forEach(cs => {
    const r = evalCase(runCase(post.fn, cs), cs);
    if (!r.ok) postFail++;
    check('POST ' + cs[0], r.ok, r.why + '  expect dead=' + cs[3] + ' df=' + cs[4] + ' pfsSrc=' + cs[6]);
  });
  check('POST 汇总', postFail === 0, postFail + ' 例失败');

  console.log('=== 修前（备份快照）必须在那 4 个 fd=0 例上 FAIL ===');
  let preFailSeen = 0;
  CASES.forEach(cs => {
    const r = evalCase(runCase(pre.fn, cs), cs);
    if (!r.ok) preFailSeen++;
    if (cs[7]) {
      check('PRE  ' + cs[0] + '（应 FAIL）', !r.ok, r.why);
    } else {
      check('PRE  ' + cs[0] + '（应 PASS）', r.ok, r.why);
    }
  });
  check('PRE 至少 4 例必 FAIL，且只有它们 FAIL', preFailSeen === 4,
    'preFailSeen=' + preFailSeen);

  console.log('=== fd 不许被改写成 1 ===');
  const r0 = runCase(post.fn, CASES[0]);
  check('POST newD0 → deathFrame 仍为 0', r0 && r0.df === 0, 'df=' + (r0 && r0.df));

  console.log('=== 接线断言（函数确实在死亡合并路径上）===');
  const postSrc = post.src;
  check('applyLayerResults 调用 mergeIncrementalRescoreDeath(c, r)',
    /mergeIncrementalRescoreDeath\s*\(\s*c\s*,\s*r\s*\)/.test(postSrc), '');
  const sandboxSrc = fs.readFileSync(path.join(ROOT, 'game_core', 'js', 'vantage_sandbox.js'), 'utf8');
  check('rescoreTankSamples 产出 fd=0（dead: rn.deathFrame >= 0）',
    /dead:\s*rn\.deathFrame\s*>=\s*0/.test(sandboxSrc), '');

  console.log('\n' + (FAILS ? 'TREE-MERGE GUARD FAILED (' + FAILS + '/' + CHECKS + ')'
                             : 'TREE-MERGE GUARD PASSED (' + CHECKS + '/' + CHECKS + ')'));
  process.exitCode = FAILS ? 1 : 0;
})();
