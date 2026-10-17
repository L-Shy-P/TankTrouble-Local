'use strict';
/* 全量 diff_*.js 的**两口径对账**（父要求）：退出码 + 输出正则。
 *
 * 定义（与 _run_diff_all.js 的正则保持一致：/\bFAIL\b/i）：
 *   exitBad  = status !== 0
 *   regexBad = 输出含 /\bFAIL\b/i（注意：故意打印"修前必 FAIL/不算 FAIL"的负例说明也会命中）
 *   真 FAIL  = exitBad ∩ regexBad      ← 交集为空 == 真 FAIL 0
 *
 * 输出每行 JSON；末尾 SUMMARY + REAL_FAILS。退出码：交集非空 → 1，否则 0。
 * 用法：node _tools/headless/_diff_two_way_audit.js
 */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const DIR = path.join(__dirname, '..', '..', 'game_core', 'rust');
const files = fs.readdirSync(DIR).filter((f) => /^diff_.*\.js$/.test(f)).sort();
const rows = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  const out = ((r.stdout || '') + (r.stderr || ''));
  const exitBad = r.status !== 0;
  const regexFail = /\bFAIL\b/i.test(out);
  const msvc = /MSVC|link\.exe|linker/i.test(out) && /failed|error/i.test(out);
  const lastLine = out.split('\n').map((l) => l.trim()).filter(Boolean).slice(-1)[0] || '';
  rows.push({ f: f, status: r.status, exitBad: exitBad, regexFail: regexFail, msvc: msvc, last: lastLine.slice(0, 160) });
  console.log(JSON.stringify(rows[rows.length - 1]));
}
const exitBad = rows.filter((x) => x.exitBad).map((x) => x.f);
const regexBad = rows.filter((x) => x.regexFail).map((x) => x.f);
const both = rows.filter((x) => x.exitBad && x.regexFail).map((x) => x.f);
const skip = rows.filter((x) => x.msvc && x.exitBad && x.regexFail).map((x) => x.f);
console.log('SUMMARY ' + JSON.stringify({ total: rows.length, exitBad: exitBad.length, regexBad: regexBad.length, both: both.length }));
console.log('EXIT_BAD=' + JSON.stringify(exitBad));
console.log('REGEX_BAD=' + JSON.stringify(regexBad));
console.log('SKIP_MSVC=' + JSON.stringify(skip));
console.log('REAL_FAILS=' + JSON.stringify(both));
process.exitCode = both.length ? 1 : 0;
