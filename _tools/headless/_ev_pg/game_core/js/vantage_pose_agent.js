/* Vantage 位姿目标智能体（走树）—— 2026-10-07
 * ================================================================
 * 这是【真正接进树】的智能体：注册到 VantageTreeInterface.Agents，
 * 由树的 agentSeam 每帧调用 decide(ctx)，返回 {select} 让树执行。
 *
 * 第一阶段先用「位姿相似度」直接算分（规则版），把【树 → 智能体 → 执行】
 * 这条链路跑通；之后把打分段换成神经网络即可。
 *
 * 目标位姿由外部写入：window.__vtPoseTarget = {x, y, rot}
 */
(function () {
  'use strict';
  if (typeof VantageTreeInterface === 'undefined') {
    console.warn('[PoseAgent] VantageTreeInterface 没加载，跳过');
    return;
  }
  if (window.__vtPoseAgentInstalled) return;
  window.__vtPoseAgentInstalled = true;

  var SIM_P = 6.0, SIM_A = 0.45;

  function wrapPi(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  function PoseTargetAgent() {
    this.name = 'pose';
  }

  PoseTargetAgent.prototype.isReady = function () {
    return !!window.__vtPoseTarget;
  };

  PoseTargetAgent.prototype.decide = function (ctx) {
    var T = window.__vtPoseTarget;
    if (!T || !ctx || !ctx.nodes || !ctx.nodes.length) return null;

    var stats = window.__vtPoseStats || (window.__vtPoseStats = {
      calls: 0, scored: 0, lastBest: null, lastSim: -1
    });
    stats.calls++;

    // 只考虑【根的直接子节点】—— checkBundleSemantics 要求 select 在
    // commitNode.children 里，选深层节点会被判非法。
    var rootId = ctx.root;
    var cands = [];
    for (var i = 0; i < ctx.nodes.length; i++) {
      var n = ctx.nodes[i];
      if (n.parentId !== rootId) continue;                  // 不是根的子节点
      if (n.invalid || n.exhausted) continue;
      if (n.x === null || n.x === undefined) continue;      // 没有终点位姿
      if (n.fullDeathFrame >= 0 && n.fullDeathFrame <= 1) continue;   // 真死
      cands.push(n);
    }
    if (!cands.length) return null;

    var best = null, bestSim = -1;
    for (var k = 0; k < cands.length; k++) {
      var c = cands[k];
      var dPos = Math.sqrt((c.x - T.x) * (c.x - T.x) + (c.y - T.y) * (c.y - T.y));
      var dAng = Math.abs(wrapPi((c.rot || 0) - T.rot));
      var sim = Math.exp(-dPos / SIM_P - dAng / SIM_A);
      if (sim > bestSim) { bestSim = sim; best = c; }
    }
    stats.scored++;
    stats.lastSim = bestSim;
    stats.lastBest = best ? { id: best.id, op: best.opName, x: best.x, y: best.y, sim: bestSim } : null;

    return best ? { select: best.id } : null;
  };

  var inst = new PoseTargetAgent();
  VantageTreeInterface.Agents.register(inst);
  window.__vtPoseAgent = inst;
  console.log('[PoseAgent] 已注册（走树）。切到它：VantageTreeInterface.Agents.use("pose")');
})();
