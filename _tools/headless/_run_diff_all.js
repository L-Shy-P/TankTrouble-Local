'use strict';
/* 跑全量 game_core/rust/diff_*.js，输出 PASS/FAIL/SKIP(MSVC) 统计。 */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const DIR = path.join(__dirname, '..', '..', 'game_core', 'rust');
const files = fs.readdirSync(DIR).filter((f) => /^diff_.*\.js$/.test(f)).sort();
const res = [];
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  const out = ((r.stdout || '') + (r.stderr || ''));
  const ms = Date.now() - t0;
  const msvc = /MSVC|link\.exe|linker/i.test(out) && /failed|error/i.test(out);
  const ok = r.status === 0 && !/\bFAIL\b/i.test(out);
  const kind = msvc ? 'SKIP-MSVC' : (ok ? 'PASS' : 'FAIL');
  res.push({ f: f, kind: kind, ms: ms, status: r.status });
  console.log(kind.padEnd(10) + f.padEnd(44) + (ms + 'ms').padStart(10) + (kind === 'FAIL' ? '  status=' + r.status : ''));
  if (kind === 'FAIL') console.log('   >> ' + out.split('\n').filter((l) => /fail|error|assert/i.test(l)).slice(0, 4).join('\n   >> ').slice(0, 500));
}
const n = (k) => res.filter((x) => x.kind === k).length;
console.log('SUMMARY ' + JSON.stringify({ total: res.length, pass: n('PASS'), fail: n('FAIL'), skip: n('SKIP-MSVC') }));
console.log('FAILS=' + JSON.stringify(res.filter((x) => x.kind === 'FAIL').map((x) => x.f)));
process.exitCode = n('FAIL') ? 1 : 0;
