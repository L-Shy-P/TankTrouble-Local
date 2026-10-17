#!/usr/bin/env node
'use strict';
/* ============================================================================
 * 阶段 2 · A1/A2 —— **默认页配置（DEFAULT_EXP）下闸门真的生效**（testbench v104 / tree v179）
 *
 * 上一轮 `_probe_p2_gate_full.js` 证明了"显式打开 nodeCap/refine 后闸门机制是对的"，
 * 但当时抓到默认页被 vantage_testbench.js 的 DEFAULT_EXP 覆盖（500/false/8/true）。
 * 本轮修了 DEFAULT_EXP（1000/1000/true/10/false）之后，本探针**不覆盖这 5 个默认值**，
 * 直接走真实默认路径：
 *   ① 断言活树默认 = maxNodes 1000 / warmup 1000 / nodeCap true / horizonSec 10 / refine false
 *   ② 加速器 growLayersPerTick=6（**非** A1/A2 的 5 个默认值，只为更快顶到 1000）→ 泵到树满
 *   ③ 树满后：1 帧采样 60 点，所有"仍满"间隔 tickOk 必须 0；skipped 增长；恒等式成立
 *   ④ 反向（证明"改的那个值就是开关"）：
 *      R1 只把 nodeCap 改回 false ⟹ 闸门休眠（skipped 冻结、树越过 1000）
 *      R2 只把 refineBeyond 改回 true ⟹ 同样休眠
 *      R3 把数量改回旧值 500（cap=true/refine=false）⟹ 闸门立刻在 500 触发（skipped 增长、A 停）
 *   ⑤ 恢复新默认（保持页面干净）
 *
 * 用法：node _tools/headless/_probe_p2_default_exp_gate.js
 * 退出码：0=PASS，1=FAIL
 * ============================================================================ */
const { Match } = require('./match');

const SNAP = `(() => {
  var d = (typeof VantageTree !== 'undefined') ? VantageTree.dumpDiagnostics() : null;
  var s = (d && d.stats) || {};
  var st = window.__vantageIface || {};
  var t = (typeof VantageTree !== 'undefined') ? VantageTree.getTree() : null;
  return {
    treeVer: (typeof VantageTree !== 'undefined') ? VantageTree.VERSION : null,
    tbVer: (typeof VantageTestbench !== 'undefined') ? VantageTestbench.VERSION : null,
    cfgMax: (t && t.cfg) ? t.cfg.maxNodes : null,
    cfgWarmup: (t && t.cfg) ? t.cfg.warmupMaxNodes : null,
    capOn: (t && t.cfg) ? t.cfg.nodeCapEnabled : null,
    cfgHorizon: (t && t.cfg) ? t.cfg.horizonSec : null,
    refine: (t && t.cfg) ? t.cfg.refineBeyondLimits : null,
    gwt: (t && t.cfg) ? t.cfg.growWithoutThreats : null,
    nodeCount: (d && d.shape) ? d.shape.nodeCount : null,
    maxDepth: (d && d.shape) ? d.shape.maxDepth : null,
    tickCalls: st.tickCalls || 0,
    tickOk: st.tickOk || 0,
    tickErr: st.tickErr || 0,
    tickSkippedFull: st.tickSkippedFull || 0,
    agentSkippedFull: s.agentSkippedFull || 0
  };
})()`;

let failures = 0;
function check(ok, msg, extra) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + msg + (extra !== undefined ? '   ' + JSON.stringify(extra) : ''));
  if (!ok) failures++;
}
const isFull = (s, cap) => s.nodeCount + 9 > cap;

async function main() {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 0, vantCount: 1, rng: 'record' });
    await m.pump(3);
    const live = await m.eval(SNAP);

    console.log('== §① 默认页活树配置（不动任何 setter）==');
    check(live.treeVer === 'v179', 'tree VERSION=v179（本轮未改树）', live.treeVer);
    check(live.tbVer === 'v104', 'testbench VERSION=v104（本轮升）', live.tbVer);
    check(live.cfgMax === 1000, '活树 maxNodes=1000（DEFAULT_EXP 生效）', live.cfgMax);
    check(live.cfgWarmup === 1000, '活树 warmupMaxNodes=1000', live.cfgWarmup);
    check(live.capOn === true, '活树 nodeCapEnabled=true（闸门前提）', live.capOn);
    check(live.cfgHorizon === 10, '活树 horizonSec=10（A1 生效）', live.cfgHorizon);
    check(live.refine === false, '活树 refineBeyondLimits=false（不绕闸门）', live.refine);
    check(live.gwt === true, 'growWithoutThreats=true（未动，主人要求）', live.gwt);

    console.log('== §② 泵到默认配置下的树满（maxNodes=1000）==');
    // 加速器：growLayersPerTick=6（**非** A1/A2 的 5 个默认值，只为更快顶到 1000；
    // 默认 growLayers=1 时树在 horizon 10s + commit 坍缩下稳定在 ~300~500，到不了上限）。
    await m.eval(`(VantageTree.setGrowLayersPerTick(6), 1)`);
    let full = null, fullTick = -1, t = 0;
    for (let i = 0; i < 40 && !full; i++) {
      await m.pump(5); t += 5;
      const s = await m.eval(SNAP);
      if (isFull(s, 1000)) { full = s; fullTick = t; }
      if (i % 2 === 1 || full) console.log('    ...tick=' + t + ' nodeCount=' + s.nodeCount + ' tickOk=' + s.tickOk + ' skipped=' + s.tickSkippedFull);
    }
    check(full !== null, '在默认配置下到达树满（nodeCount+9 > 1000）', full && { atTick: fullTick, nodeCount: full.nodeCount, maxDepth: full.maxDepth });

    if (full !== null) {
      console.log('== §③ 树满后：1 帧采样 60 点 ==');
      const series = [];
      for (let i = 0; i < 60; i++) { await m.pump(1); series.push(await m.eval(SNAP)); }
      let frozen = 0, violated = [];
      for (let i = 0; i + 1 < series.length; i++) {
        const s0 = series[i], s1 = series[i + 1];
        if (isFull(s0, 1000) && isFull(s1, 1000)) {
          frozen++;
          if (s1.tickOk !== s0.tickOk) violated.push({ i: i, n0: s0.nodeCount, n1: s1.nodeCount, ok0: s0.tickOk, ok1: s1.tickOk });
        }
      }
      const last = series[series.length - 1];
      check(frozen >= 8, '仍满的 1 帧间隔 ≥8', frozen);
      check(violated.length === 0, '这些间隔内 tickOk 全部冻结（默认配置下 A 不调）', violated.slice(0, 3));
      check(last.nodeCount <= 1009, 'nodeCount ≤ 1000+9（允许略超口径）', last.nodeCount);
      check(last.tickSkippedFull > full.tickSkippedFull, 'tickSkippedFull 增长', { full: full.tickSkippedFull, last: last.tickSkippedFull });
      check(last.agentSkippedFull > full.agentSkippedFull, 'tree.stats.agentSkippedFull 增长', { full: full.agentSkippedFull, last: last.agentSkippedFull });
      check((last.tickOk + last.tickSkippedFull + last.tickErr) === last.tickCalls, '恒等式 tickOk+tickSkippedFull+tickErr==tickCalls', { ok: last.tickOk, skipped: last.tickSkippedFull, err: last.tickErr, calls: last.tickCalls });
      console.log('    [series 末 12 点 nodeCount:tickOk/skipped] ' + series.slice(-12).map((s) => s.nodeCount + ':' + s.tickOk + '/' + s.tickSkippedFull).join(' '));
    }

    console.log('== §④ 反向：逐个证明"改的那个值就是开关" ==');
    // 注意：growWithoutThreats=true 且场上无弹时，warmupMaxNodes 也会成为 cap。
    // 先把 warmup 抬到 3000（探针旋钮），隔离出 nodeCap / refineBeyond 两个布尔开关。
    await m.eval(`(VantageTree.setWarmupMaxNodes(3000), 1)`);
    // R1：只把 nodeCap 改回 false
    const r0 = await m.eval(SNAP);
    await m.eval(`(VantageTree.setNodeCapEnabled(false), 1)`);
    let maxN = r0.nodeCount;
    for (let i = 0; i < 4; i++) { await m.pump(5); const s = await m.eval(SNAP); maxN = Math.max(maxN, s.nodeCount); }
    const r1 = await m.eval(SNAP);
    check(r1.tickSkippedFull === r0.tickSkippedFull, 'R1 nodeCap=false ⟹ tickSkippedFull 冻结（闸门休眠）', { before: r0.tickSkippedFull, after: r1.tickSkippedFull });
    check(r1.tickOk > r0.tickOk, 'R1 A 恢复被调用', { before: r0.tickOk, after: r1.tickOk });
    check(maxN > 1000, 'R1 树越过 1000（无数量闸门）', { before: r0.nodeCount, maxN: maxN });
    // R2：恢复 nodeCap=true，只把 refineBeyond 改回 true
    await m.eval(`(VantageTree.setNodeCapEnabled(true), VantageTree.setRefineBeyondLimits(true), 1)`);
    const r2a = await m.eval(SNAP); let maxN2 = r2a.nodeCount;
    for (let i = 0; i < 4; i++) { await m.pump(5); const s = await m.eval(SNAP); maxN2 = Math.max(maxN2, s.nodeCount); }
    const r2 = await m.eval(SNAP);
    check(r2.tickSkippedFull === r2a.tickSkippedFull, 'R2 refineBeyond=true ⟹ tickSkippedFull 冻结（闸门休眠）', { before: r2a.tickSkippedFull, after: r2.tickSkippedFull });
    check(r2.tickOk > r2a.tickOk, 'R2 A 恢复被调用', { before: r2a.tickOk, after: r2.tickOk });
    check(maxN2 > maxN, 'R2 树继续越过 1000（超限细化绕开闸门）', { r1Max: maxN, r2Max: maxN2 });
    // R3：恢复 refine=false，把数量改回旧值 500 ⟹ 闸门立刻在 500 触发
    await m.eval(`(VantageTree.setRefineBeyondLimits(false), VantageTree.setMaxNodes(500), VantageTree.setWarmupMaxNodes(500), 1)`);
    const r3a = await m.eval(SNAP);
    await m.pump(10);
    const r3b = await m.eval(SNAP);
    check(r3b.tickSkippedFull > r3a.tickSkippedFull, 'R3 数量改回 500 ⟹ 闸门立刻触发（skipped 增长）', { before: r3a.tickSkippedFull, after: r3b.tickSkippedFull });
    check(r3b.tickOk === r3a.tickOk, 'R3 A 被停（tickOk 冻结）', { before: r3a.tickOk, after: r3b.tickOk });

    console.log('== §⑤ 恢复新默认 ==');
    await m.eval(`(VantageTree.setMaxNodes(1000), VantageTree.setWarmupMaxNodes(1000), VantageTree.setNodeCapEnabled(true), VantageTree.setHorizonSec(10), VantageTree.setRefineBeyondLimits(false), VantageTree.setGrowLayersPerTick(1), 1)`);
    await m.pump(1);
    const back = await m.eval(SNAP);
    check(back.cfgMax === 1000 && back.cfgWarmup === 1000 && back.capOn === true && back.cfgHorizon === 10 && back.refine === false, '新默认已恢复', { cfgMax: back.cfgMax, warmup: back.cfgWarmup, capOn: back.capOn, horizon: back.cfgHorizon, refine: back.refine });
  } catch (e) {
    console.error('FATAL', (e && e.stack) || e);
    failures++;
  } finally {
    try { await m.close(); } catch (e) {}
  }
  console.log(failures === 0 ? '\nP2-DEFAULT-EXP-GATE PROBE PASSED' : '\nP2-DEFAULT-EXP-GATE PROBE FAILED (' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
}
main();
