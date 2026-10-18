/**
 * pm_flags.js —— 逐项优化矩阵：同一个真实载荷、每种 VT_FAST 组合跑 REPS 次，取【中位数的最小值】
 * 用法：node _tools/perf/pm_flags.js [--reps 3] [--n 100] [--scales 208]
 * 输出：D:/vt_run/perf/flags_<stamp>.json + 控制台表
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const REPS = Number(arg('reps', 3));
const NASK = Number(arg('n', 100));
const SCALES = arg('scales', '208');
const PAYLOAD = arg('payload', 'D:/vt_run/perf/payload_p8_N124.json');
const OUT = arg('out', 'D:/vt_run/perf');
const VARIANTS = [
  ['base', ''],
  ['tensor', 'tensor'],
  ['json', 'json'],
  ['mem+echo', 'mem,echo'],
  ['argmax', 'argmax'],
  ['sync', 'sync'],
  ['ALL', 'mem,echo,json,tensor,argmax,sync']
];
const med = (a) => { const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const r2 = (x) => (x === null || x === undefined) ? null : Math.round(x * 100) / 100;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const rows = [];
for (const [tag, fast] of VARIANTS) {
  const runs = [];
  for (let r = 0; r < REPS; r++) {
    const a = ['_tools/perf/pm_bench.js', '--payload', PAYLOAD, '--n', String(NASK), '--scales', SCALES, '--tag', 'flag_' + tag.replace(/[^a-z0-9]/gi, '_') + '_r' + r];
    if (fast) a.push('--env', 'VT_FAST=' + fast);
    const p = spawnSync('node', a, { cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8', timeout: 300000 });
    const txt = (p.stdout || '');
    const i = txt.indexOf('{'), j = txt.lastIndexOf('}');
    if (i < 0 || j < 0) { console.error('RUN_FAIL ' + tag + ' ' + ((p.stderr || '').slice(-300))); continue; }
    try { runs.push(JSON.parse(txt.slice(i, j + 1))); } catch (e) { console.error('PARSE_FAIL ' + tag); }
  }
  const cases = runs[0] ? runs[0].cases.map((c0, ci) => {
    const pick = (k) => runs.map((r) => r.cases[ci] && r.cases[ci][k]).filter((x) => typeof x === 'number');
    const srvMed = runs.map((r) => r.cases[ci].srv_ms.med);
    const rttMed = runs.map((r) => r.cases[ci].rtt_ms.med);
    const trMed = runs.map((r) => r.cases[ci].transport_ms.med);
    const parts = {};
    for (const k of Object.keys(runs[0].cases[ci].srv_parts_ms_med)) parts[k] = r2(med(runs.map((r) => r.cases[ci].srv_parts_ms_med[k])));
    return {
      label: c0.label, payloadBytes: c0.payloadBytes,
      srv_med_of_runs: r2(med(srvMed)), srv_min: r2(Math.min(...srvMed)),
      rtt_med_of_runs: r2(med(rttMed)), rtt_min: r2(Math.min(...rttMed)),
      trans_med_of_runs: r2(med(trMed)), trans_min: r2(Math.min(...trMed)),
      parts_med: parts,
      respBytes_med: c0.respBytes.med,
      fp0: c0.fingerprint[0], fp_uniq: c0.fingerprint_uniq
    };
  }) : [];
  rows.push({ tag, fast, reps: runs.length, cases });
  for (const c of cases) {
    console.log(`${tag.padEnd(10)} ${c.label} bytes=${c.payloadBytes} | srv ${c.srv_med_of_runs} (min ${c.srv_min}) | rtt ${c.rtt_med_of_runs} (min ${c.rtt_min}) | trans ${c.trans_med_of_runs} | resp=${c.respBytes_med} | fp=${JSON.stringify(c.fp0)}`);
    console.log('           parts ' + JSON.stringify(c.parts_med));
  }
}
fs.writeFileSync(path.join(OUT, 'flags_' + stamp + '.json'), JSON.stringify({ payload: PAYLOAD, reps: REPS, nask: NASK, scales: SCALES, rows }, null, 2));
console.log('WROTE ' + path.join(OUT, 'flags_' + stamp + '.json'));
