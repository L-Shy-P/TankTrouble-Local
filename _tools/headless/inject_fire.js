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
            return { id: c.id, L: L, rel: rel, start: (function(){var s=0;for(var j=0;j<i;j++)s+=Math.max(1,window.__b.execLenOf(p[j]));return s;})(), onPath: 'commit', progress: tree.commitProgress };
          }
        }
      }
      if (p.length >= 2 && p[1]) {
        var f = p[1];
        var L2 = window.__b.execLenOf(f);
        return { id: f.id, L: L2 > 0 ? L2 : 75, start: 0, rel: 0, onPath: 'firstHop' };
      }
      return null;
    } catch (e) { return null; }
  };
  // ⭐⭐ 用【游戏自己的游标】定 back（父代理 2026-10-17 批准"读同一套游标内部"）：
  //    `getDesiredOperation()` 里的 `agentExecEnsure` 按 `_timeAcc` 缓存 ⟹ 同一 tick 内再调是**只读**，
  //    且返回的 `agentFrame` 就是本 tick 会用到的执行帧号 ⟹ back = start + L − 1 − agentFrame
  //    （目标：`agentPickExecFrame` = start+(L−back)−1 = agentFrame = 当帧）
  //    ⛔ 拿不到 agentFrame ⟹ 显式 fireErr（不猜）
  // ⭐⭐ 多射击帧（D3「若干射击帧」）：目标变了 ⟹ 游标重置到 ~0；目标不变 ⟹ 游标逐帧 +1
  //    ⟹ 同时提交 {帧0, 帧1, relG帧} 的 back，'now' 模式下全部拼进 picks[1..]
  //    ⛔ 拿不到 agentFrame ⟹ 显式 fireErr（仍保留"帧0"这一条，它是无条件合法的）
  window.__b.backList = function (cur) {
    var L = cur.L, out = [], b = window.__b.fireBias | 0;
    var push = function (frame) {
      var f = Math.max(0, Math.min(L - 1, frame | 0));
      var back = Math.max(0, Math.min(L - 1, L - 1 - f + b));
      for (var i = 0; i < out.length; i++) if (out[i].back === back) return;
      out.push({ back: back, frame: f });
    };
    push(0);                                             // 目标变化 ⟹ startFrame≈0
    var dz = null;
    try { dz = VantageTree.getDesiredOperation(); } catch (e) { window.__b.fireErr = 'getDesiredOperation 抛错: ' + String((e && e.message) || e); }
    if (dz && typeof dz.agentFrame === 'number') {
      var relG = dz.agentFrame - (cur.start | 0);
      window.__b.lastFireDbg = { agentFrame: dz.agentFrame, start: cur.start | 0, L: L, relGame: relG, relApprox: cur.rel };
      push(relG); push(relG + 1);                        // 目标不变 ⟹ 游标 = relG（或已 +1）
    } else {
      window.__b.fireErr = 'picks[1]: 拿不到游戏游标 agentFrame（' + (dz ? typeof dz.agentFrame : 'null') + '）—— ⛔ 不猜（只留帧0）';
    }
    return out;
  };
  window.__b.backNow = function (cur) { var l = window.__b.backList(cur); return l.length ? l[0].back : 0; };
  // ⭐⭐ 按【游戏自己的循环】选游标节点（`vantage_tree.js:8590-8596` 逐字复刻）：
  //    frame = getDesiredOperation().agentFrame；沿 path 累加 agentExecLenOf 找到"包含该帧"的节点 cur
  //    ⟹ back = L−1−(frame−total) ⟹ `agentPickExecFrame` = total+(L−back)−1 = frame ✓ 精确对齐
  window.__b.cursorByFrame = function (tree, pathNodes) {
    var p = pathNodes || [];
    if (!p.length) return null;
    var dz = null;
    try { dz = VantageTree.getDesiredOperation(); } catch (e) { window.__b.fireErr = 'getDesiredOperation 抛错: ' + String((e && e.message) || e); return null; }
    if (!dz || typeof dz.agentFrame !== 'number') { window.__b.fireErr = 'picks[1]: 拿不到游戏游标 agentFrame（' + (dz ? typeof dz.agentFrame : 'null') + '）—— ⛔ 不猜'; return null; }
    var frame = dz.agentFrame, total = 0, cur = null, L = 0, i;
    for (i = 0; i < p.length; i++) {
      L = Math.max(1, window.__b.execLenOf(p[i]));
      if (frame < total + L) { cur = p[i]; break; }
      total += L;
    }
    if (!cur) { cur = p[p.length - 1]; L = Math.max(1, window.__b.execLenOf(cur)); total = Math.max(0, total - L); frame = total + L - 1; }  // 路线走完：保持末节点
    var rel = Math.max(0, Math.min(L - 1, frame - total));
    window.__b.lastFireDbg = { agentFrame: dz.agentFrame, nodeIdx: i, nodeId: cur.id, total: total, L: L, rel: rel, desiredFire: !!dz.fire, op: dz.opName || '' };
    return { id: cur.id, L: L, start: total, rel: rel, onPath: 'byFrame' };
  };
  window.__b.readonly = function () { return { lastPick: window.__b.lastPick || null, lastFire: window.__b.lastFire || null, lastRouteLen: (window.__b.lastRouteLen === undefined ? null : window.__b.lastRouteLen) }; };
  window.__b.setFireBack = function (m) { window.__b.fireBack = (m === 'now') ? 'now' : 'zero'; window.__b.fireBackSet++; return window.__b.fireBack; };  window.__b.setFire = function (f) { window.__b.wantFire = !!f; return window.__b.wantFire ? 1 : 0; };
  window.__b.stats = function () {
    var IS = window.__vantageIface || {};
    return { aCalls: window.__b.aCalls||0, aNotGrowable: window.__b.aNotGrowable||0, aTreeFull: window.__b.aTreeFull||0, growRejectMissing: window.__b.growRejectMissing||0, growRejectNotGrowable: window.__b.growRejectNotGrowable||0, growStillValid: window.__b.growStillValid||0, growChkErr: window.__b.growChkErr||null, aCanGrowErr: window.__b.aCanGrowErr||null, aGrow: window.__b.aGrow||0, aGrowServer: window.__b.aGrowServer||0, aServerReject: window.__b.aServerReject||0, growOkCount: window.__b.growOkCount||0, aNotLeaf: window.__b.aNotLeaf||0, aNoSlots: window.__b.aNoSlots||0, aErr: window.__b.aErr||null, lastGrow: window.__b.lastGrow||null, nodeCount: (function(){try{var t=VantageTree.getTree();return t?t.nodeCount:null}catch(e){return null}})(),
             fireSubmits: window.__b.fireSubmits, fireNoCursor: window.__b.fireNoCursor, fireSkippedRetry: window.__b.fireSkippedRetry || 0, emptyBlocked: window.__b.emptyBlocked || 0, gAmmo: window.__b.gAmmo, gQueue: window.__b.gQueue, deathSubErr: window.__b.deathSubErr || null, pulseBlocked: window.__b.pulseBlocked || 0, pulseBlockedByPrev: window.__b.pulseBlockedByPrev || 0, pulseBlockedBySelfFire: window.__b.pulseBlockedBySelfFire || 0, selfFire: window.__b.gSelfFire || 0,
             buildOK: window.__b.buildOK, buildMisses: window.__b.buildMisses,
             lastFirePick: window.__b.lastFirePick, fireBack: window.__b.fireBack, fireErr: window.__b.fireErr,
             lastTargetId: (typeof window.__b.lastTargetId === 'number' ? window.__b.lastTargetId : null),
             pickExtras: IS.pickExtras || 0, giveUpB: IS.giveUpB || 0, giveUpA: IS.giveUpA || 0, aSkips: window.__b.aSkips || 0, lastPhase: window.__b.lastPhase || null, rejected: IS.rejected || 0,
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
  // A 相生长：在当前可行节点里选 1 个叶子生长（契约 vantage_tree.js:4390-4412：picks[0] 且必须是叶）
  window.__b.buildA = function () {
    try {
      var tree = VantageTree.getTree();
      if (!tree || !tree.root) { window.__b.aNoTree = (window.__b.aNoTree || 0) + 1; return null; }
      // ⭐⭐ D11：树满时「不能生长」⇒ **不该叫 A**（吴则只会制造 giveUpA）
      var _cap = (tree.cfg && typeof tree.cfg.maxNodes === 'number') ? tree.cfg.maxNodes : 1000;
      if (typeof tree.nodeCount === 'number' && tree.nodeCount >= _cap) { window.__b.aTreeFull = (window.__b.aTreeFull || 0) + 1; return { picks: [], memory: {} }; }
      var slots = window.__b.pendingSlots;
      if (!slots || !slots.length) { window.__b.aNoSlots = (window.__b.aNoSlots || 0) + 1; return { picks: [], memory: {} }; }
      // ⭐ 优先用【服务端 head_grow 采样的行号】
      var _gr = window.__b.growRow;
      if (typeof _gr === 'number' && window.__b.nodeRows && window.__b.nodeRows[_gr]) {
        var _uid = window.__b.nodeRows[_gr][0] | 0;
        var _tr2 = VantageTree.getTree(); var _node2 = null;
        (function rec2(nd, dep) { if (!nd || _node2 || dep > 60) return; if (nd.id === _uid) { _node2 = nd; return; } var ks2 = nd.children || []; for (var q2 = 0; q2 < ks2.length; q2++) { rec2(ks2[q2], dep + 1); if (_node2) return; } })(_tr2 && _tr2.root, 0);
        if (_node2 && typeof VantageTreeInterface !== 'undefined' && VantageTreeInterface.Invariants && VantageTreeInterface.Invariants.canGrowAt(_node2) && (!_node2.children || !_node2.children.length)) {
          window.__b.aGrowServer = (window.__b.aGrowServer || 0) + 1;
          return { picks: [{ nodeId: _uid, back: 0 }], memory: {} };
        }
        window.__b.aServerReject = (window.__b.aServerReject || 0) + 1;
      }
      var w = window.__b.walk(tree, slots);
      var n = w.node;
      if (!n || n === tree.root) { window.__b.aBadTarget = (window.__b.aBadTarget || 0) + 1; return { picks: [], memory: {} }; }
      if (n.children && n.children.length) { window.__b.aNotLeaf = (window.__b.aNotLeaf || 0) + 1; return { picks: [], memory: {} }; }
      // ⭐ 自查：不满足 canGrowAt 就别报（显式计数）
      try {
        if (typeof VantageTreeInterface !== 'undefined' && VantageTreeInterface.Invariants && !VantageTreeInterface.Invariants.canGrowAt(n)) {
          window.__b.aNotGrowable = (window.__b.aNotGrowable || 0) + 1;
          return { picks: [], memory: {} };
        }
      } catch (eCG) { window.__b.aCanGrowErr = String((eCG && eCG.message) || eCG); }
      window.__b.pendingGrowCheck = { uid: n.id, depth: (w.path ? w.path.length : null) };   // ⭐ 下一帧复查这个 uid 还在不在/能不能长
      window.__b.aGrow = (window.__b.aGrow || 0) + 1;
      window.__b.lastGrow = { nodeId: n.id, depth: (w.path ? w.path.length : null) };
      return { picks: [{ nodeId: n.id, back: 0 }], memory: {} };   // ⭐ 必须带 back：校验里 `targetBack !== null` 会把 undefined 当"越界"整包拒
    } catch (e) { window.__b.aErr = String((e && e.message) || e); return null; }
  };
  window.__b.build = function () {
    try {
      var tree = VantageTree.getTree();
      if (!tree || !tree.root) { window.__b.why = window.__b.why || {}; window.__b.why.noTree = (window.__b.why.noTree||0)+1; return null; }
      var slots = window.__b.pendingSlots;
      if (!slots || !slots.length) { window.__b.why = window.__b.why || {}; window.__b.why.noSlots = (window.__b.why.noSlots||0)+1; return null; }
      var w = window.__b.walk(tree, slots);
      var n = w.node, pathNodes = w.path;
      // ⭐⭐ 路线口径必须与 `agentRoutePathOf`(`vantage_tree.js:4259`) 一致 = 【parent 链】（到 root 为止）
      //    我原来的 slot(opIndex) 走法在"同一父下有重复 opIndex"时会走岔 ⟹ 界面报 `picks[1] 不在路线上`（实测 228 次/轮）
      if (n && n !== tree.root) {
        var ch = [], q2 = n, gd = 0;
        while (q2 && q2 !== tree.root && gd++ < 400) { ch.push(q2); q2 = q2.parent; }
        if (q2 === tree.root) { ch.reverse(); pathNodes = ch; }
        else { window.__b.why = window.__b.why || {}; window.__b.why.staleTarget = (window.__b.why.staleTarget || 0) + 1; }
      }
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
      var _att = (window.__b.fireAttempts = (window.__b.fireAttempts || 0) + 1) - 1;   // 第 0 次才是首次
      var _blkPrev = (window.__b.lastFrameSubmitted === true), _blkSF = (window.__b.selfFire === true);
      // ⭐⭐ 空射抑制（主人听到了空射音效）：`ammoLeft`=globalTok[15]、`queueLen`=globalTok[35]，两者都没子弹就不扣扳机
      var _ammo = (typeof window.__b.gAmmo === 'number') ? window.__b.gAmmo : null;
      var _queue = (typeof window.__b.gQueue === 'number') ? window.__b.gQueue : null;
      var _blkEmpty = (_ammo !== null && _ammo <= 0 && !(_queue > 0));
      if (window.__b.wantFire && _att === 0 && !(_blkPrev || _blkSF || _blkEmpty)) {
        // ⭐ 射击帧 = picks[1..]（出处 `交接-现状说明-2026-10-09.md:52`：(节点ID, 相对时间) 表示射击帧）
        //    nodeId = 【当前路线游标所在节点】（必须在路线上；`vantage_tree.js:4283 agentExecEnsure` 的游标起点）
        //    back   = L−1−rel ⟹ `agentPickExecFrame`（:4336）`e = start+(L−back)−1 = start+rel` = **当帧**
        //    （父代理 2026-10-17 裁定 (a)：用 L−1−rel；`VT_FIRE_BACK=zero` 保留 back=0 作对照）
        var cbf = (window.__b.fireBack === 'now') ? window.__b.cursorByFrame(tree, pathNodes) : null;   // ⭐ 精确：游戏游标帧
        var cur = cbf || window.__b.cursor(tree, pathNodes);                                           // 兜底：commitNode 口径
        if (cur) {
          var frs = []; if (cbf) { frs.push(cbf.rel); frs.push(cbf.rel + 1); frs.push(cbf.rel - 1); } frs.push(0); if (typeof cur.rel === 'number') frs.push(cur.rel);   // ⭐ 候选执行帧：精确帧/±1（同目标游标逐帧+1）/新路线帧0/tNow 估值
          var bl = [];
          for (var fi = 0; fi < frs.length; fi++) {
            var f2 = Math.max(0, Math.min(cur.L - 1, (frs[fi] | 0) + (window.__b.fireBias | 0)));
            var bk = Math.max(0, Math.min(cur.L - 1, cur.L - 1 - f2));
            var dup = false; for (var di = 0; di < bl.length; di++) if (bl[di].back === bk) dup = true;
            if (!dup) bl.push({ back: bk, frame: f2 });
          }   // ⭐ 单帧精确对齐（cursorByFrame 已算出 rel）
          // ⭐⭐ 射击帧由【服务端 head_fire 采样】给出 ⇒ 直接用，桥不再枚举（回退：服务端没给就用自己的 bl）
          if (Array.isArray(window.__b.fireFramesFromServer) && window.__b.fireFramesFromServer.length) {
            bl = window.__b.fireFramesFromServer.map(function (x) { return { back: (x.back | 0), frame: null }; });
          }
          for (var bi = 0; bi < bl.length; bi++) picks.push({ nodeId: cur.id, back: bl[bi].back });   // ⭐ picks[1..] = 若干射击帧（帧0 / 游标帧 / 游标帧+1）
          // ⭐ `fireBias` 只用于"rel 是否差 1 帧"的标定测量（默认 0，由 `VT_FIRE_REL_BIAS` 设）
          // （射击帧已在上面按 bl 全部 push；此处不再单独 push）
          window.__b.fireSubmits++;
          window.__b.fireSubmittedThisFrame = true;   // ⭐ 本帧真提交了射击帧 ⇒ 下一帧要松扳机
          window.__b.lastFirePick = { nodeId: cur.id, backs: bl.map(function (x) { return x.back; }), frames: bl.map(function (x) { return x.frame; }), L: cur.L, rel: cur.rel, mode: window.__b.fireBack, onPath: cur.onPath, dbg: window.__b.lastFireDbg || null };
        } else { window.__b.fireNoCursor++; }
      } else if (window.__b.wantFire && _att === 0 && (_blkPrev || _blkSF)) {   // ⭐ 脉冲拦下（松扳机帧）
        window.__b.pulseBlocked = (window.__b.pulseBlocked || 0) + 1;
        if (_blkPrev) window.__b.pulseBlockedByPrev = (window.__b.pulseBlockedByPrev || 0) + 1;
        if (_blkSF) window.__b.pulseBlockedBySelfFire = (window.__b.pulseBlockedBySelfFire || 0) + 1;
        if (_blkEmpty) { window.__b.emptyBlocked = (window.__b.emptyBlocked || 0) + 1; window.__b.lastEmptyFire = 1; }   // ⭐ 空射被栏（单独计数）
      } else if (window.__b.wantFire && _att > 0) { window.__b.fireSkippedRetry = (window.__b.fireSkippedRetry || 0) + 1;   // ⭐ 重试时只发 picks[0]：`炮口贴墙 picks[1]` 会整包被拒（实测 596/600）
      }
      // ⭐ 只读暴露（面板用）：不改任何行为
      window.__b.lastPick = { row: window.__b.lastPickRow, uid: (n && n.id !== undefined ? n.id : null), depth: pathNodes.length, opName: (n && n.opName) || null };
      window.__b.lastRouteLen = pathNodes.length;
      window.__b.lastFire = { policy: window.__b.wantFire ? 1 : 0, submitted: window.__b.fireSubmittedThisFrame ? 1 : 0,
                              blockedBy: (window.__b.wantFire && _att === 0) ? ((_blkPrev ? 'prev' : null) || (_blkSF ? 'selfFire' : null) || (_blkEmpty ? 'empty' : null) || null) : null };
      window.__b.buildOK++;
      window.__b.lastBuilt = picks;
      window.__b.lastTargetId = n.id;   // ⭐ 诊断：本帧提交的 picks[0] 目标（用于统计"目标是否每帧变"）
      return { picks: picks, memory: {} };
    } catch (e) { window.__b.buildErr = String(e && e.message || e); return null; }
  };
  window.__b.mk = function (tag) {
    return { name: 'nnbridge' + tag, isReady: function () { return true; }, decide: function (ctx, info) {
        // ⭐ 抓 A/B 相的真实拒绝原因（接口在重试时会把 reason 传进来）
        try {
          if (info && info.reason) {
            window.__b.rejReasons = window.__b.rejReasons || {};
            var _k = String((info.phase || (ctx && ctx.phase) || '?')) + ':' + String(info.reason).slice(0, 60);
            window.__b.rejReasons[_k] = (window.__b.rejReasons[_k] || 0) + 1;
          }
        } catch (eRR) {}
        try { window.__b.lastPhaseSeen = (ctx && ctx.phase) || (info && info.phase) || null; } catch (ePh) {} var ph = null; try { ph = (ctx && ctx.phase) || (info && info.phase) || null; window.__b.lastPhase = ph; } catch (e) {} if (ph === 'A') { window.__b.aCalls = (window.__b.aCalls || 0) + 1; return window.__b.buildA(); } return window.__b.build(); } };   // ⭐ 父代理裁定 (b)：A 相 return null ⟹ 不清空 _agentRoute/_agentFirePicks（依据 vantage_tree.js:4580-4585）
  };
  // ⭐⭐ 奖惩 v2（2026-10-17 主人 10 条规格）：订阅 `TANK_KILLED` 事件拿 **killer/victim** 真值
  //    （⏔t 再用“对手 alive 位 1→0”推断：那会把毒雾杀也算成我杀的）
  window.__b.kills = [];
  window.__b.deathSubErr = null;
  window.__b.subscribeDeaths = function () {
    try {
      var gc = GameManager.getGameController();
      // 铁律：回合相关的东西走 `gc.roundController.model`（不是 gc 本身）
      var rm = (gc && gc.roundController) ? gc.roundController.model : null;
      var tgt = (rm && typeof rm.addEventListener === 'function') ? rm : ((gc && typeof gc.addEventListener === 'function') ? gc : null);
      if (!tgt) return (window.__b.deathSubErr = 'no-event-target(rm=' + (rm ? typeof rm.addEventListener : 'null') + ',gc=' + (gc ? typeof gc.addEventListener : 'null') + ')');
      tgt.addEventListener(RoundModel._EVENTS.TANK_KILLED, function (data) {
        try {
          var k = (data && typeof data.getKillerPlayerId === 'function') ? data.getKillerPlayerId() : null;
          var v = (data && typeof data.getVictimPlayerId === 'function') ? data.getVictimPlayerId() : null;
          var t = (data && typeof data.getDeadlyType === 'function') ? data.getDeadlyType() : null;
          window.__b.kills.push({ killer: (k === null || k === undefined) ? null : String(k), victim: (v === null || v === undefined) ? null : String(v), deadlyType: (t === null || t === undefined) ? null : t });
        } catch (e1) { window.__b.deathSubErr = String((e1 && e1.message) || e1); }
      });
      return 'ok';
    } catch (e2) { window.__b.deathSubErr = String((e2 && e2.message) || e2); return 'err'; }
  };
  window.__b.setup = function () {
    var A = VantageTreeInterface.Agents;
    A.register(window.__b.mk('A'), 'A'); A.register(window.__b.mk('B'), 'B');
    A.use('nnbridgeA', 'A'); A.use('nnbridgeB', 'B');
    try { window.__b.subscribeDeaths(); } catch (eSub) { window.__b.deathSubErr = String((eSub && eSub.message) || eSub); }   // ⭐ 奖惩 v2
    return 'ok';
  };
  // ⭐ step：只读观测 + 记下"意图"（目标节点的 slot 路径 + 是否开火）；真正的包在 decide() 当帧建
  window.__b.step = function (nodeId, fire) {
    // ⭐ A 相复查（只读）：上一帧报给 A 的 uid，现在还在不在 / 还能不能长 —— 用来区分 growRejectMissing vs NotGrowable
    try {
      var _pgc = window.__b.pendingGrowCheck;
      if (_pgc) {
        var _t2 = VantageTree.getTree(), _hit = null, _st = (_t2 && _t2.root) ? [_t2.root] : [], _g = 0;
        while (_st.length && _g++ < 6000) {
          var _q = _st.pop(); if (!_q) continue;
          if (_q.id === _pgc.uid) { _hit = _q; break; }
          if (_q.children) for (var _ci = 0; _ci < _q.children.length; _ci++) if (_q.children[_ci]) _st.push(_q.children[_ci]);
        }
        if (!_hit) { window.__b.growGone = (window.__b.growGone || 0) + 1; }
        else {
          window.__b.growStillExists = (window.__b.growStillExists || 0) + 1;
          try {
            if (VantageTreeInterface.Invariants.canGrowAt(_hit)) window.__b.growStillGrowable = (window.__b.growStillGrowable || 0) + 1;
            else window.__b.growExistsNotGrowable = (window.__b.growExistsNotGrowable || 0) + 1;
          } catch (eCG2) { window.__b.growCanGrowErr = String((eCG2 && eCG2.message) || eCG2); }
        }
        window.__b.pendingGrowCheck = null;
      }
    } catch (eChk) { window.__b.growCheckErr = String((eChk && eChk.message) || eChk); }
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
    if (!window.__b.deathSubscribed) { try { if (window.__b.subscribeDeaths() === 'ok') window.__b.deathSubscribed = true; } catch (eS2) { window.__b.deathSubErr = String((eS2 && eS2.message) || eS2); } }
    window.__b.lastPickRow = (typeof nodeId === 'number') ? nodeId : null;   // ⭐ 只读暴露：动作行号
    // ⭐⭐ 只读复查（父代理要求）：上一帧 A 报的 uid 在这一帧
    //    还在不在树里 / 还能不能长 ⇒ 把 growAt=0 拆成两类
    if (window.__b.pendingGrowCheck) {
      var _gc0 = window.__b.pendingGrowCheck; window.__b.pendingGrowCheck = null;
      try {
        var _tr = VantageTree.getTree(); var _f = null;
        (function rec(nd, dep) { if (!nd || _f || dep > 60) return; if (nd.id === _gc0.uid) { _f = nd; return; } var ks = nd.children || []; for (var q = 0; q < ks.length; q++) { rec(ks[q], dep + 1); if (_f) return; } })(_tr && _tr.root, 0);
        if (!_f) window.__b.growRejectMissing = (window.__b.growRejectMissing || 0) + 1;
        else {
          var _ok = true;
          try { _ok = !(typeof VantageTreeInterface !== 'undefined' && VantageTreeInterface.Invariants) ? true : !!VantageTreeInterface.Invariants.canGrowAt(_f); } catch (eOk) { _ok = true; }
          if (!_ok) window.__b.growRejectNotGrowable = (window.__b.growRejectNotGrowable || 0) + 1;
          else window.__b.growStillValid = (window.__b.growStillValid || 0) + 1;
        }
      } catch (eGC) { window.__b.growChkErr = String((eGC && eGC.message) || eGC); }
    }
    // ⭐⭐ grow_ok（A 相可生长掩码）：行 i 是叶 ⇔ 没有任何行的 parentIdx == i（根行 0 除外）
    try {
      // ⭐ 用【树上的真叶子】算（token 的 parentIdx 不一定是行号 ⇒ 用 uid 匹配才准）
      var _leaf = {};
      (function _recL(nd, dep) { if (!nd || dep > 80) return; var ks = nd.children || []; if (!ks.length) _leaf[nd.id | 0] = 1; for (var q = 0; q < ks.length; q++) _recL(ks[q], dep + 1); })(VantageTree.getTree() && VantageTree.getTree().root, 0);
      var _nn = nSrc.length;
      var _ok = new Array(_nn).fill(0); var _cnt = 0;
      for (var _j = 1; _j < _nn; _j++) { if (_leaf[nSrc[_j][0] | 0]) { _ok[_j] = 1; _cnt++; } }
      window.__b.growOk = _ok; window.__b.growOkCount = _cnt; window.__b.nodeRows = nSrc;
    } catch (eGO) { window.__b.growOk = null; window.__b.growOkCount = 0; window.__b.growOkErr = String((eGO && eGO.message) || eGO); }
    window.__b.pendingSlots = slots;
    // ⭐⭐ 脉冲开火（2026-10-17 父代理诊断）：`BulletWeapon.fire()` 的 `_triggerPulled` 是锁存
    //    ⇒ 连续帧都提交 picks[1] = 一直按扳机 = 只出第一发 ⇒ 桥强制"发一帧、松一帧"
    try { window.__b.gSelfFire = (Array.isArray(gArr) && gArr.length > 32) ? (+gArr[32] || 0) : 0; } catch (eSF) { window.__b.gSelfFire = 0; }
    window.__b.selfFire = window.__b.gSelfFire > 0.5;
    window.__b.gAmmo = (Array.isArray(gArr) && gArr.length > 15) ? (+gArr[15] || 0) : null;      // ⭐ 剩余子弹
    window.__b.gQueue = (Array.isArray(gArr) && gArr.length > 35) ? (+gArr[35] || 0) : null;     // ⭐ 排队弹数                                  // 双保险：自己的开火键还按着就不提交
    window.__b.lastFrameSubmitted = (window.__b.fireSubmittedThisFrame === true);      // 上一帧真提交过射击帧？
    window.__b.fireSubmittedThisFrame = false;
    window.__b.fireAttempts = 0;   // ⭐ 每帧复位：decide() 可能被界面重试多次
    window.__b.wantFire = !!fire;
    // ⭐ 只读真值：我方武器的 `_bulletsFired` / `_numBullets`（出处 `_g1_inject.js:171-176` 同一探针）
    var wep = null;
    try {
      var rd = (typeof __vtData === 'function') ? (__vtData(gc.getRoundState()) || {}) : {};
      var wss = rd.weaponStates || [];
      for (var wq = 0; wq < wss.length; wq++) {
        if (String(wss[wq].playerId) !== String(window.__b.tankId || 'vantage_1')) continue;
        var wf = {}; try { wf = JSON.parse(wss[wq].fieldsJSON || '{}'); } catch (eW) { }
        wep = { type: wss[wq].type, fired: (wf._bulletsFired === undefined ? null : wf._bulletsFired), num: (wf._numBullets === undefined ? null : wf._numBullets) };
      }
    } catch (eWep) { wep = { err: String((eWep && eWep.message) || eWep) }; }
    // ⭐⭐ aim（父代理裁定 B-2）：本帧若【刚发射】（_bulletsFired 增加），
    //    取离自车最近的子弹（新射出的那发）的速度方向 vs「我方→最近存活对手」方位角
    //    夹角 ≤ 30° ⇒ aim=1。（离散、非势函数；坐标系与 match.js 速度口径一致：atan2(vy,vx)）
    var aimNow = 0, aimDeg = null;
    try {
      var _wf = (wep && typeof wep.fired === 'number') ? wep.fired : null;
      var _sp = (_wf !== null && typeof window.__b.prevWepFired === 'number' && _wf > window.__b.prevWepFired);
      window.__b.prevWepFired = _wf;
      if (_sp && Array.isArray(bSrc) && bSrc.length) {
        var sx0 = +((gArr && gArr[6]) || 0), sy0 = +((gArr && gArr[7]) || 0);
        var oo = (e.global && e.global.oppTok) || [], bestD = Infinity, tx = null, ty = null;
        for (var q3 = 0; q3 * 15 + 7 < oo.length; q3++) {
          if ((oo[q3*15+7] | 0) <= 0) continue;
          var ox0 = +oo[q3*15], oy0 = +oo[q3*15+1];
          var dd = (ox0-sx0)*(ox0-sx0) + (oy0-sy0)*(oy0-sy0);
          if (dd < bestD) { bestD = dd; tx = ox0; ty = oy0; }
        }
        if (tx !== null) {
          var bi2 = 0, bd2 = Infinity;
          for (var q4 = 0; q4 < bSrc.length; q4++) {
            var bx = +bSrc[q4][0], by = +bSrc[q4][1];
            var d2 = (bx-sx0)*(bx-sx0) + (by-sy0)*(by-sy0);
            if (d2 < bd2) { bd2 = d2; bi2 = q4; }
          }
          var bvx = +bSrc[bi2][2], bvy = +bSrc[bi2][3];
          var aV = Math.atan2(bvy, bvx), aT = Math.atan2(ty-sy0, tx-sx0);
          var df = Math.abs(((aV - aT + Math.PI) % (2*Math.PI)) - Math.PI) * 180 / Math.PI;
          aimDeg = Math.round(df * 10) / 10;
          aimNow = (df <= 30) ? 1 : 0;
        }
      }
    } catch (eAim) { window.__b.aimErr = String((eAim && eAim.message) || eAim); }
    var gl = e.global || {};
    var st = window.__b.stats();
    // ⭐ 游戏侧真值：VantageAIManager 每帧提交的 storedStates.fire（`ai_vantage.js:174`）⟹ 判定"开火键到底有没有按下去"
    var subFire = null, opName = null, desiredFrame = null, desiredFire = null, desiredErr = null;   // ⭐ 游戏侧真值：inputState.fire + `ai_vantage.js:106` 的 vantageControlOpName（含 '+fire' = 真开火）
    try {
      var mgr = null, ms = (typeof AIs !== 'undefined' && AIs.aiManagers) || [];
      for (var q = 0; q < ms.length; q++) if (ms[q] && ms[q].isVantage) { mgr = ms[q]; break; }
      if (mgr && mgr.storedStates) subFire = !!mgr.storedStates.fire;
      if (mgr && typeof mgr.vantageControlOpName === 'string') opName = mgr.vantageControlOpName;
      // ⭐⭐ 只读真值（父代理批准）：游戏自己的 `getDesiredOperation()` 直接给出 `agentFrame`+`fire`
      //    `agentExecEnsure` 按 `_timeAcc` 缓存 ⟹ 同一 tick 内再调一次是**只读**的（不推进游标）
      try {
        var dz = VantageTree.getDesiredOperation();
        if (dz) { desiredFrame = (typeof dz.agentFrame === 'number' ? dz.agentFrame : null); desiredFire = !!dz.fire; if (typeof dz.opName === 'string') opName = dz.opName; }
      } catch (eDz) { desiredErr = String((eDz && eDz.message) || eDz); }
    } catch (eS) { }
    return JSON.stringify({ h: h >>> 0, alive: d === 0, dots: e.dims.total, g: gArr, n: nSrc,
      cur: (function () { try { var t = VantageTree.getTree(); return window.__b.cursor(t, window.__b.walk(t, window.__b.pendingSlots).path); } catch (e) { return null; } })(), stats: st, growOk: (window.__b.growOk||null), growOkCount: (window.__b.growOkCount||0), subFire: subFire, opName: opName, wep: wep, aim: aimNow, aimDeg: aimDeg,   // ⭐ wep 必须在（上一版被后续补丁覆盖丢了 ⇒ shots 测成 0）
      ammo: window.__b.gAmmo, queueLen: window.__b.gQueue, kills: (function(){ var q = window.__b.kills || []; window.__b.kills = []; return q; })(),   // ⭐ 奖惩 v2：本帧前新增的 TANK_KILLED 事件（取完清空） wep: wep, desiredFrame: desiredFrame, desiredFire: desiredFire, desiredErr: desiredErr, wantFire: window.__b.wantFire ? 1 : 0,
      b: bSrc, nSlots: slots ? slots.length : -1, nBul: bSrc.length, bDim: (e.bullets && e.bullets.dim) || null,
      opp: (gl.oppTok || null), col: (gl.colTok || null), mine: (gl.mineTok || null) });   // ⭐ 敌人/道具信息（在 global 里）
  };
  window.__probe = window.__b;
  return 'installed';
})()
