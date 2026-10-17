(function () {
  window.__b = { n: 0, pendingSlots: null, wantFire: false, lastBuilt: null, buildMisses: 0, buildOK: 0,
                 fireBack: 'now', fireBias: 0, fireSubmits: 0, fireNoCursor: 0, lastFirePick: null, fireBackSet: 0, fireErr: null };
  // ⭐ 决策【当帧】再建包：把"上一帧读到的目标节点"翻译成 root→目标的 slot 序列，
  //    沿【当前树】重走取新鲜节点 id ⟹ 不依赖 id 跨帧稳定（父代理实测：id 会失效、报"节点编号不存在"）
  // ⭐ 当前路线游标（**必须在路线上**，否则界面报 `picks[1] 不在路线上`）：
  //    ⭐⭐ 口径必须与 `vantage_tree.js` 的 `agentExecLenOf`(4271)+`agentExecEnsure`(4283) **逐字一致**：
  //       L   = `validFramesOf(n)` = `validFrames>0 ? validFrames : 0`（⛔ 不是 segmentFrames！）
  //       rel = round((L*FRAME_DT − (tEndSec − tNow))/FRAME_DT)，FRAME_DT = 0.02（`vantage_tree.js:816`）
  //    · 不在（B 换了另一支 ⟹ `agentExecEnsure`:4313 走 startFrame=0）⟹ 路线从 path[0] 起、rel=0
  var VT_FRAME_DT = 0.02;
  window.__b.execLenOf = function (n) {
    var v = (n && typeof n.validFrames === 'number' && n.validFrames > 0) ? n.validFrames : 0;
    if (v > 0) return v;
    if (!n || !n.fullDead) return 75;                    // EVAL_FRAMES 默认（`vantage_tree.js:819`）
    return (n.fullDeathFrame >= 2) ? (n.fullDeathFrame - 1) : 0;
  };
  window.__b.cursor = function (tree, pathNodes) {
    try {
      var p = pathNodes || [];
      var c = tree && tree.commitNode;
      if (c) {
        for (var i = 0; i < p.length; i++) {
          if (p[i] && p[i].id === c.id) {
            var L = window.__b.execLenOf(c);
            if (!(L > 0)) { window.__b.fireErr = 'picks[1]: commitNode 的执行长度 L=0 —— ⛔ 不猜'; return null; }
            // ⛔ 取不到 tNow/tEndSec ⟹ 显式报错（父代理裁定：不许猜 rel）
            if (typeof c.tEndSec !== 'number' || typeof tree.tNow !== 'number') {
              window.__b.fireErr = 'picks[1]: tEndSec/tNow 不可用（' + typeof c.tEndSec + '/' + typeof tree.tNow + '）—— ⛔ 不猜 rel';
              return null;
            }
            var rel = Math.round((L * VT_FRAME_DT - (c.tEndSec - tree.tNow)) / VT_FRAME_DT);
            rel = Math.max(0, Math.min(L - 1, rel));
            return { id: c.id, L: L, rel: rel, onPath: 'commit', progress: tree.commitProgress };
          }
        }
      }
      if (p.length >= 2 && p[1]) {
        var f = p[1];
        var L2 = window.__b.execLenOf(f);
        return { id: f.id, L: L2 > 0 ? L2 : 75, rel: 0, onPath: 'firstHop' };
      }
      return null;
    } catch (e) { return null; }
  };
  window.__b.setFireBack = function (m) { window.__b.fireBack = (m === 'now') ? 'now' : 'zero'; window.__b.fireBackSet++; return window.__b.fireBack; };  window.__b.setFire = function (f) { window.__b.wantFire = !!f; return window.__b.wantFire ? 1 : 0; };
  window.__b.stats = function () {
    var IS = window.__vantageIface || {};
    return { fireSubmits: window.__b.fireSubmits, fireNoCursor: window.__b.fireNoCursor,
             buildOK: window.__b.buildOK, buildMisses: window.__b.buildMisses,
             lastFirePick: window.__b.lastFirePick, fireBack: window.__b.fireBack, fireErr: window.__b.fireErr,
             lastTargetId: (typeof window.__b.lastTargetId === 'number' ? window.__b.lastTargetId : null),
             pickExtras: IS.pickExtras || 0, giveUpB: IS.giveUpB || 0, rejected: IS.rejected || 0,
             skipped: IS.skipped || '' };
  };
  // ⭐ 沿 slots 走一遍当前树 ⟹ {node: 目标节点, path: root→目标 的节点数组, firstHop}
  //    【唯一入口】：build() 与 step() 都走这里（⛔ 不两处各写一份）
  window.__b.walk = function (tree, slots) {
    var n = tree && tree.root, pathNodes = n ? [n] : [], firstHop = null;
    if (!n || !slots) return { node: null, path: pathNodes, firstHop: null };
    for (var i = 0; i < slots.length; i++) {
      var kids = n.children || [], hit = null;
      for (var j = 0; j < kids.length; j++) {
        var c = kids[j]; if (!c) continue;
        var s = (typeof c.opIndex === 'number') ? c.opIndex : -1;
        if (s === slots[i]) { hit = c; break; }
      }
      if (!hit) break;
      if (i === 0) firstHop = hit;
      n = hit; pathNodes.push(hit);
    }
    return { node: n, path: pathNodes, firstHop: firstHop };
  };
  window.__b.build = function () {
    try {
      var tree = VantageTree.getTree();
      if (!tree || !tree.root) { window.__b.why = window.__b.why || {}; window.__b.why.noTree = (window.__b.why.noTree||0)+1; return null; }
      var slots = window.__b.pendingSlots;
      if (!slots || !slots.length) { window.__b.why = window.__b.why || {}; window.__b.why.noSlots = (window.__b.why.noSlots||0)+1; return null; }
      var w = window.__b.walk(tree, slots);
      var n = w.node, pathNodes = w.path;
      // ⭐⭐ 兜底：走不通也必须给一个【合法】包（no-output 是最大掉包源）
      if (!n || n === tree.root) {
        var kk = tree.root.children || [];
        var pick0 = null;
        for (var q = 0; q < kk.length; q++) { if (kk[q]) { pick0 = kk[q]; break; } }
        if (!pick0) { window.__b.why = window.__b.why || {}; window.__b.why.noKids = (window.__b.why.noKids||0)+1; window.__b.buildMisses++; return null; }        // 真的无子节点：无解，计数
        window.__b.buildFallback = (window.__b.buildFallback || 0) + 1;
        if (!firstHop) firstHop = pick0;
        n = pick0;
      }
      var picks = [{ nodeId: n.id, back: 0 }];
      if (window.__b.wantFire) {
        // ⭐ 射击帧 = picks[1..]（出处 `交接-现状说明-2026-10-09.md:52`：(节点ID, 相对时间) 表示射击帧）
        //    nodeId = 【当前路线游标所在节点】（必须在路线上；`vantage_tree.js:4283 agentExecEnsure` 的游标起点）
        //    back   = L−1−rel ⟹ `agentPickExecFrame`（:4336）`e = start+(L−back)−1 = start+rel` = **当帧**
        //    （父代理 2026-10-17 裁定 (a)：用 L−1−rel；`VT_FIRE_BACK=zero` 保留 back=0 作对照）
        var cur = window.__b.cursor(tree, pathNodes);
        if (cur) {
          var back = 0;
          if (window.__b.fireBack === 'now') back = Math.max(0, Math.min(cur.L - 1, cur.L - 1 - cur.rel + (window.__b.fireBias | 0)));
          // ⭐ `fireBias` 只用于"rel 是否差 1 帧"的标定测量（默认 0，由 `VT_FIRE_REL_BIAS` 设）
          picks.push({ nodeId: cur.id, back: back });
          window.__b.fireSubmits++;
          window.__b.lastFirePick = { nodeId: cur.id, back: back, L: cur.L, rel: cur.rel, mode: window.__b.fireBack, onPath: cur.onPath };
        } else { window.__b.fireNoCursor++; }
      }
      window.__b.buildOK++;
      window.__b.lastBuilt = picks;
      window.__b.lastTargetId = n.id;   // ⭐ 诊断：本帧提交的 picks[0] 目标（用于统计"目标是否每帧变"）
      return { picks: picks, memory: {} };
    } catch (e) { window.__b.buildErr = String(e && e.message || e); return null; }
  };
  window.__b.mk = function (tag) {
    return { name: 'nnbridge' + tag, isReady: function () { return true; }, decide: function (ctx, info) { try { window.__b.lastPhase = (ctx && ctx.phase) || (info && info.phase) || null; } catch(e){} return window.__b.build(); } };
  };
  window.__b.setup = function () {
    var A = VantageTreeInterface.Agents;
    A.register(window.__b.mk('A'), 'A'); A.register(window.__b.mk('B'), 'B');
    A.use('nnbridgeA', 'A'); A.use('nnbridgeB', 'B');
    return 'ok';
  };
  // ⭐ step：只读观测 + 记下"意图"（目标节点的 slot 路径 + 是否开火）；真正的包在 decide() 当帧建
  window.__b.step = function (nodeId, fire) {
    var gc = GameManager.getGameController();
    var ad = VantageSandbox.createAdapter(gc, window.__b.tankId || 'vantage_1');   // ⭐ 目标坦克：2 人局里没有 tank_a ⟹ 默认 vantage_1（★ 此前写死 tank_a ⟹ 观测 self 恒 0）
    var e = VantageObserve.encode({ adapter: ad, tree: VantageTree.getTree(), horizonSec: 10, K_death: 1, frameDt: 1 / 60 });
    var h = 2166136261 >>> 0;
    function mix(arr) { for (var i = 0; i < arr.length; i++) { h ^= (arr[i] | 0); h = (h * 16777619) >>> 0; } }
    try { mix(e.global.globalTok); mix(e.global.oppTok || []); } catch (err) { }
    try { mix(e.node.nodeTok || []); } catch (err) { }
    var d = (typeof ad.getDeathsCount === 'function') ? ad.getDeathsCount() : 0;
    var gArr = (e.global && Array.isArray(e.global.globalTok)) ? e.global.globalTok : null;
    var nSrc = (e.nodes && Array.isArray(e.nodes.tokens)) ? e.nodes.tokens : null;
    if (!gArr || !nSrc) return JSON.stringify({ h: h >>> 0, err: 'token 段字段名不符(拒绝静默传 null)', topKeys: Object.keys(e) });
    var bSrc = (e.bullets && Array.isArray(e.bullets.tokens)) ? e.bullets.tokens : [];
    // ⭐ slot 路径：uid -> 沿 parentIdx 上溯 -> 收集 slot（NODE_FIELDS[2]）-> 反转
    // ⭐⭐ nodeId 的口径 = 【节点 token 的行下标】（动作空间就定义在行上），**不是 uid**
    //   此前拿它去比 nSrc[i][0]（uid）⟹ 永远不命中 ⟹ pendingSlots 恒 null ⟹ 桥恒 no-output ⟹ 一直跑规则版
    var idx = -1;
    if (typeof nodeId === 'number' && nodeId >= 0 && nodeId < nSrc.length) idx = nodeId;
    else { for (var i2 = 0; i2 < nSrc.length; i2++) { if ((nSrc[i2][0] | 0) === nodeId) { idx = i2; break; } } }   // 兼容直接给 uid
    var slots = null;
    if (idx >= 0) {
      slots = [];
      var g2 = 0;
      while (idx > 0 && g2++ < 2000) { slots.push(nSrc[idx][2] | 0); var p = (nSrc[idx][1] | 0); if (p <= 0) break; idx = p; }
      slots.reverse();
    }
    window.__b.pendingSlots = slots;
    window.__b.wantFire = !!fire;
    var gl = e.global || {};
    var st = window.__b.stats();
    // ⭐ 游戏侧真值：VantageAIManager 每帧提交的 storedStates.fire（`ai_vantage.js:174`）⟹ 判定"开火键到底有没有按下去"
    var subFire = null, opName = null;   // ⭐ 游戏侧真值：inputState.fire + `ai_vantage.js:106` 的 vantageControlOpName（含 '+fire' = 真开火）
    try {
      var mgr = null, ms = (typeof AIs !== 'undefined' && AIs.aiManagers) || [];
      for (var q = 0; q < ms.length; q++) if (ms[q] && ms[q].isVantage) { mgr = ms[q]; break; }
      if (mgr && mgr.storedStates) subFire = !!mgr.storedStates.fire;
      if (mgr && typeof mgr.vantageControlOpName === 'string') opName = mgr.vantageControlOpName;
    } catch (eS) { }
    return JSON.stringify({ h: h >>> 0, alive: d === 0, dots: e.dims.total, g: gArr, n: nSrc,
      cur: (function () { try { var t = VantageTree.getTree(); return window.__b.cursor(t, window.__b.walk(t, window.__b.pendingSlots).path); } catch (e) { return null; } })(), stats: st, subFire: subFire, opName: opName, wantFire: window.__b.wantFire ? 1 : 0,
      b: bSrc, nSlots: slots ? slots.length : -1, nBul: bSrc.length, bDim: (e.bullets && e.bullets.dim) || null,
      opp: (gl.oppTok || null), col: (gl.colTok || null), mine: (gl.mineTok || null) });   // ⭐ 敌人/道具信息（在 global 里）
  };
  window.__probe = window.__b;
  return 'installed';
})()
