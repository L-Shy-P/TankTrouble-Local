'use strict';
/* 探针：同一份录制的 N 次回放，boot 阶段（到 IN_ROUND 为止）的
 * 「按调用点 Math.random 消费次数」是否稳定？
 * 地图/RNG 完全相同 ⟹ 任何按调用点的次数差异都是【真实事件/DOM 时序】造成的，
 * 也就是 flaky off-by-one 的机制。
 *   node _tools/headless/_probe_replay_boot_variance.js --runs 10 --frames 300
 */
const fs = require('fs');
const path = require('path');
const cdp = require('./cdp');
const realLaunch = cdp.launch;
let seq = 0;
const BASE = 18700 + (process.pid % 30) * 30;
cdp.launch = function (opts) {
  const o = Object.assign({}, opts || {});
  if (!o.port) o.port = BASE + (seq++) % 30;
  return realLaunch(o).then((b) => {
    const origSend = b.send.bind(b);
    b.send = function (method, params, sessionId) {
      if (method === 'Page.addScriptToEvaluateOnNewDocument' && params && params.source) {
        params = Object.assign({}, params, { source: params.source + ';window.__vtRng.debugStacks(true);' });
      }
      return origSend(method, params, sessionId);
    };
    return b;
  });
};
const { Match } = require('./match');
const { recordEpisode, readRecording } = require('./record');

const argv = process.argv.slice(2);
const num = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : Number(argv[i + 1]); };
const RUNS = num('runs', 10), FRAMES = num('frames', 300);
const DIR = path.join(__dirname, 'prof', 'detfix');

(async () => {
  // 1) 先录一局（地图/RNG 固定下来）
  const recFile = path.join(DIR, `bootvar_rec_${FRAMES}.jsonl`);
  const m0 = new Match();
  await recordEpisode(m0, { frames: FRAMES, ids: ['tank_a', 'tank_b'], out: recFile });
  await m0.close();
  const rec = readRecording(recFile);
  const boot = (rec.header.init && rec.header.init.bootstrap) || {};
  const epoch = rec.header.init ? rec.header.init.vtEpoch : undefined;

  // 2) 同一录制回放 N 次，每次只到 open()（IN_ROUND），采集 boot 期消费次数
  const runs = [];
  let stacks = null;
  for (let i = 1; i <= RUNS; i++) {
    const m = new Match();
    const r = { i };
    try {
      await m.open(Object.assign({}, boot, {
        rng: 'play', rngSeq: rec.rng, rngSites: rec.rngSites, control: false,
        bootFrames: 300, epoch: epoch,
        humanIds: boot.humanIds || ['tank_a', 'tank_b'], aiCount: boot.aiCount || 0, vantCount: boot.vantCount || 0,
      }));
      const st = await m.eval('window.__vtRng.state()');
      r.calls = st.calls; r.siteCount = st.siteCount; r.siteOverflow = st.siteOverflow;
      r.counts = await m.eval('window.__vtRng.useCounts()');
      if (!stacks) {
        // play 模式不记栈；单独开一个 record 模式的短 boot 抓栈（key 与时钟一致）
        const ms = new Match();
        try {
          await ms.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, control: false });
          stacks = await ms.eval('window.__vtRng.stacks()');
        } catch (e) {} finally { await ms.close(); }
      }
    } catch (e) { r.err = String((e && e.message) || e).slice(0, 180); }
    finally { await m.close(); }
    runs.push(r);
    process.stdout.write(JSON.stringify({ i: r.i, calls: r.calls, siteCount: r.siteCount, siteOverflow: r.siteOverflow, err: r.err }) + '\n');
  }

  const keys = new Set();
  for (const r of runs) if (r.counts) for (const k in r.counts) keys.add(k);
  const varying = [];
  for (const k of keys) {
    const vals = runs.filter((r) => r.counts).map((r) => r.counts[k] || 0);
    const uniq = Array.from(new Set(vals));
    if (uniq.length > 1) varying.push({ key: k, vals, recLen: (rec.rngSites && rec.rngSites[k]) ? rec.rngSites[k].length : 0, stack: (stacks && stacks[k]) || null });
  }
  const callVals = runs.filter((r) => r.calls !== undefined).map((r) => r.calls);
  const out = {
    recordFile: recFile, runs: RUNS, frames: FRAMES,
    recRngLen: rec.rng ? rec.rng.length : 0, recSiteCount: rec.rngSites ? Object.keys(rec.rngSites).length : 0,
    replayCalls: callVals, replayCallUnique: Array.from(new Set(callVals)).sort((a, b) => a - b),
    varyingSites: varying.length, varying: varying.slice(0, 15),
  };
  const outFile = path.join(DIR, 'replay_bootvariance_report.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  console.log('SUMMARY ' + JSON.stringify({
    replayCalls: out.replayCalls, replayCallUnique: out.replayCallUnique, varyingSites: out.varyingSites,
    varying: varying.slice(0, 8).map((v) => ({ k: v.key, vals: v.vals, recLen: v.recLen, stack: (v.stack || '').split(' <- ').slice(1, 4).join(' <- ').slice(0, 320) })),
  }));
})().catch((e) => { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; });
