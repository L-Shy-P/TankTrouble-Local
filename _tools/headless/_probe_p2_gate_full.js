#!/usr/bin/env node
'use strict';
/* ============================================================================
 * 阶段 2 A2 验收：**"树满 ⟹ 不再调用 A" 真的生效**（v179）
 *
 * 背景（本轮实测发现，必须记录）：
 *   `game_core/index.html:541` 加载 `vantage_testbench.js`，其 DEFAULT_EXP
 *   （:201 / :2174-2175）在页面加载时把活树覆盖成
 *   maxNodes=500 / nodeCap=false / horizonSec=8 / refineBeyond=true
 *   ⟹ **出厂默认页里，数量/时间闸门是无效的**（v179 的两处改动被面板默认值盖掉）。
 *   本探针先记录这个覆盖，再显式把实验开关拨到"闸门生效"，
 *   单独证明 **闸门机制本身** 是对的 —— 面板默认值要不要跟着改，是另一个待批问题。
 *
 * 判据：
 *   ① 产品默认值：VERSION=v179 / TREE_DEFAULTS.maxNodes=1000 / horizonSec=10.0
 *   ② 活树默认：被 testbench 覆盖（500 / nodeCap=false / horizon=8 / refine=true）
 *   ③ 控制组：maxNodes=3000、nodeCap=true、refine=false → tickOk 增长
 *   ④ 实验组：maxNodes=100 → 树满后 **每个"仍满"的采样间隔 tickOk 必须为 0**；
 *      tickSkippedFull 增长；nodeCount ≤ 100；恒等式 tickOk+tickSkippedFull==tickCalls
 *   ⑤ 反向验证：抬回 1000 → tickOk 恢复增长、nodeCount 越过 100
 *
 * 用法：node _tools/headless/_probe_p2_gate_full.js
 * 退出码：0=PASS，1=FAIL
 * ============================================================================ */
const { Match } = require('./match');

const SNAP = `(() => {
  var d = (typeof VantageTree !== 'undefined') ? VantageTree.dumpDiagnostics() : null;
  var s = (d && d.stats) || {};
  var st = window.__vantageIface || {};
  var t = (typeof VantageTree !== 'undefined') ? VantageTree.getTree() : null;
  return {
    ver: (typeof VantageTree !== 'undefined') ? VantageTree.VERSION : null,
    defMax: (typeof VantageTree !== 'undefined') ? VantageTree.TREE_DEFAULTS.maxNodes : null,
    defHorizon: (typeof VantageTree !== 'undefined') ? VantageTree.TREE_DEFAULTS.horizonSec : null,
    cfgMax: (t && t.cfg) ? t.cfg.maxNodes : null,
    cfgHorizon: (t && t.cfg) ? t.cfg.horizonSec : null,
    capOn: (t && t.cfg) ? t.cfg.nodeCapEnabled : null,
    refine: (t && t.cfg) ? t.cfg.refineBeyondLimits : null,
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

    console.log('== §① 产品默认值（模块常量）==');
    const defs = await m.eval(`({ver:VantageTree.VERSION,maxNodes:VantageTree.TREE_DEFAULTS.maxNodes,horizonSec:VantageTree.TREE_DEFAULTS.horizonSec})`);
    check(defs.ver === 'v179', 'VERSION=v179', defs.ver);
    check(defs.maxNodes === 1000, 'TREE_DEFAULTS.maxNodes=1000', defs.maxNodes);
    check(defs.horizonSec === 10.0, 'TREE_DEFAULTS.horizonSec=10.0', defs.horizonSec);

    await m.pump(2);   // 让活树出现
    const live0 = await m.eval(SNAP);
    console.log('== §② 活树默认（被 vantage_testbench.js 覆盖）==');
    check(live0.cfgMax === 500, '活树 cfg.maxNodes=500（面板覆盖，非产品默认 1000）', live0.cfgMax);
    check(live0.capOn === false, '活树 nodeCapEnabled=false（面板覆盖）', live0.capOn);
    check(live0.refine === true, '活树 refineBeyondLimits=true（面板覆盖）', live0.refine);
    check(live0.cfgHorizon === 8, '活树 horizonSec=8（面板覆盖，非产品默认 10）', live0.cfgHorizon);

    console.log('== §③ 控制组：显式开闸门（cap=true, refine=false），maxNodes=3000 ==');
    await m.eval(`(VantageTree.setWarmupMaxNodes(3000), VantageTree.setMaxNodes(3000), VantageTree.setGrowWithoutThreatsEnabled(true), VantageTree.setNodeCapEnabled(true), VantageTree.setRefineBeyondLimits(false), 1)`);
    await m.pump(2);
    const a0 = await m.eval(SNAP);
    await m.pump(2);
    const a1 = await m.eval(SNAP);
    check(a1.tickOk - a0.tickOk > 0, 'tickOk 增长（seam 被调用）', { a0: a0.tickOk, a1: a1.tickOk });
    check(a1.nodeCount > a0.nodeCount && a1.nodeCount < 100, 'nodeCount 增长且仍 <100（给实验组留空间）', { a0: a0.nodeCount, a1: a1.nodeCount });
    check(a1.cfgMax === 3000 && a1.capOn === true && a1.refine === false, 'cfg.maxNodes=3000 / cap=true / refine=false', { cfgMax: a1.cfgMax, capOn: a1.capOn, refine: a1.refine });

    console.log('== §④ 实验组：maxNodes=100，泵到树满 ==');
    await m.eval(`(VantageTree.setMaxNodes(100), 1)`);
    const series = [];
    for (let i = 0; i < 80; i++) {
      await m.pump(1);   // 1 帧采样：能看见"commit 把 nodeCount 降到 91 → 再长回 100"的锯齿
      series.push(await m.eval(SNAP));
    }
    let fullIdx = series.findIndex((s) => isFull(s, 100));
    check(fullIdx >= 0, '出现"树满"（nodeCount+9 > 100）', fullIdx >= 0 ? { idx: fullIdx, nodeCount: series[fullIdx].nodeCount, maxDepth: series[fullIdx].maxDepth } : null);
    if (fullIdx >= 0) {
      const afterFull = series.slice(fullIdx);
      const last = afterFull[afterFull.length - 1];
      let frozenIntervals = 0, violated = [];
      for (let i = 0; i + 1 < afterFull.length; i++) {
        const s0 = afterFull[i], s1 = afterFull[i + 1];
        // 只统计"起点满、终点也仍满"的间隔；中间若发生 commit 把树降到 91（s1 不满）则排除
        if (isFull(s0, 100) && isFull(s1, 100)) {
          frozenIntervals++;
          if (s1.tickOk !== s0.tickOk) violated.push({ i: i, n0: s0.nodeCount, n1: s1.nodeCount, ok0: s0.tickOk, ok1: s1.tickOk });
        }
      }
      check(frozenIntervals >= 10, '树满且未坍缩的采样间隔 ≥10', frozenIntervals);
      check(violated.length === 0, '这些间隔内 tickOk 全部冻结（A 不被调用）', violated.slice(0, 3));
      check(last.nodeCount <= 100, 'nodeCount ≤ 100（"允许略超"口径下实测恰好停在 100）', last.nodeCount);
      check(last.tickSkippedFull > series[fullIdx].tickSkippedFull, 'tickSkippedFull 增长（闸门命中计数）', { full: series[fullIdx].tickSkippedFull, last: last.tickSkippedFull });
      check(last.agentSkippedFull > series[fullIdx].agentSkippedFull, 'tree.stats.agentSkippedFull 增长（dumpDiagnostics 可见）', { full: series[fullIdx].agentSkippedFull, last: last.agentSkippedFull });
      check(last.tickOk + last.tickSkippedFull + last.tickErr === last.tickCalls, '恒等式 tickOk+tickSkippedFull+tickErr == tickCalls（每个 tick 要么调用要么被闸门跳过）', { ok: last.tickOk, skipped: last.tickSkippedFull, err: last.tickErr, calls: last.tickCalls });
      // 打印"树满/冻结"区间摘要，供报告引用
      const tail = afterFull.filter((s, i) => i % 3 === 0 || i === afterFull.length - 1)
        .map((s) => s.nodeCount + ':' + s.tickOk + '/' + s.tickSkippedFull).join(' ');
      console.log('    [series nodeCount:tickOk/tickSkippedFull] ' + tail);
    }

    console.log('== §⑤ 反向验证：maxNodes 抬回 1000 ==');
    await m.eval(`(VantageTree.setMaxNodes(1000), 1)`);
    const b0 = await m.eval(SNAP);
    await m.pump(20);
    const b1 = await m.eval(SNAP);
    check(b1.tickOk > b0.tickOk, 'tickOk 恢复增长（冻结确由闸门造成）', { b0: b0.tickOk, b1: b1.tickOk });
    check(b1.nodeCount > 100, 'nodeCount 越过 100（树恢复生长）', { b0: b0.nodeCount, b1: b1.nodeCount });
    check(b1.cfgMax === 1000, 'cfg.maxNodes=1000', b1.cfgMax);
  } catch (e) {
    console.error('FATAL', (e && e.stack) || e);
    failures++;
  } finally {
    try { await m.close(); } catch (e) {}
  }
  console.log(failures === 0 ? '\nP2-GATE-FULL PROBE PASSED' : '\nP2-GATE-FULL PROBE FAILED (' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
}
main();
