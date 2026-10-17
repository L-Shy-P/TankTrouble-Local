'use strict';
/* 探针：boot 阶段 Math.random 的「按调用点」消费次数，在多次独立开页之间是否稳定？
 * 目的：证明/证伪 flaky off-by-one 是 boot 阶段真实事件（DOM/资产）驱动的调用次数差异。
 *   node _tools/headless/_probe_boot_variance.js --runs 12
 */
const fs = require('fs');
const path = require('path');
const cdp = require('./cdp');
const realLaunch = cdp.launch;
let seq = 0;
const BASE = 18600 + (process.pid % 30) * 30;
cdp.launch = function (opts) {
  const o = Object.assign({}, opts || {});
  if (!o.port) o.port = BASE + (seq++) % 30;
  return realLaunch(o).then((b) => {
    const origSend = b.send.bind(b);
    b.send = function (method, params, sessionId) {
      if (method === 'Page.addScriptToEvaluateOnNewDocument' && params && params.source) {
        // 必须在页面脚本之前打开 stack 采集，否则 boot 期的栈拿不到
        params = Object.assign({}, params, { source: params.source + ';window.__vtRng.debugStacks(true);' });
      }
      return origSend(method, params, sessionId);
    };
    return b;
  });
};
const { Match } = require('./match');

const argv = process.argv.slice(2);
const num = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : Number(argv[i + 1]); };
const RUNS = num('runs', 12);

(async () => {
  const runs = [];
  let stacks = null;
  for (let i = 1; i <= RUNS; i++) {
    const m = new Match();
    const r = { i };
    try {
      await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, control: false });
      const st = await m.eval('window.__vtRng.state()');
      r.calls = st.calls; r.siteCount = st.siteCount;
      r.counts = await m.eval('window.__vtRng.useCounts()');
      if (!stacks) stacks = await m.eval('window.__vtRng.stacks()');
    } catch (e) { r.err = String((e && e.message) || e).slice(0, 180); }
    finally { await m.close(); }
    runs.push(r);
    process.stdout.write(JSON.stringify({ i: r.i, calls: r.calls, siteCount: r.siteCount, err: r.err }) + '\n');
  }
  const keys = new Set();
  for (const r of runs) if (r.counts) for (const k in r.counts) keys.add(k);
  const varying = [];
  for (const k of keys) {
    const vals = runs.filter((r) => r.counts).map((r) => r.counts[k] || 0);
    const uniq = Array.from(new Set(vals));
    if (uniq.length > 1) varying.push({ key: k, vals, stack: (stacks && stacks[k]) || null });
  }
  const callVals = runs.filter((r) => r.calls !== undefined).map((r) => r.calls);
  const outFile = path.join(__dirname, 'prof', 'detfix', 'bootvariance_report.json');
  fs.writeFileSync(outFile, JSON.stringify({
    runs: RUNS, callValues: callVals, callUnique: Array.from(new Set(callVals)).sort((a, b) => a - b),
    varyingSites: varying.length, varying: varying.slice(0, 12),
  }, null, 1));
  console.log('SUMMARY ' + JSON.stringify({
    runs: RUNS, callUnique: Array.from(new Set(callVals)).sort((a, b) => a - b),
    varyingSites: varying.length,
    varying: varying.slice(0, 6).map((v) => ({ key: v.key, vals: v.vals, stack: (v.stack || '').split(' <- ').slice(0, 3).join(' <- ').slice(0, 300) })),
  }));
})().catch((e) => { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; });
