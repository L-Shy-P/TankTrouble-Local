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
    // ⭐⭐ 缓存优先：用上一帧 step() 里取到的「已执行」agentFrame（本帧 decide 时执行还未发生）
    var _cd = window.__b.cachedDz;
    if (_cd && _cd.ok) { window.__b.agentFrameFromCache = (window.__b.agentFrameFromCache || 0) + 1;
      var _fr = _cd.agentFrame, _tot = 0, _curc = null, _Lc = 0, _ic;
      for (_ic = 0; _ic < p.length; _ic++) { _Lc = Math.max(1, window.__b.execLenOf(p[_ic])); if (_fr < _tot + _Lc) { _curc = p[_ic]; break; } _tot += _Lc; }
      if (!_curc) { _curc = p[p.length - 1]; _Lc = Math.max(1, window.__b.execLenOf(_curc)); _tot = Math.max(0, _tot - _Lc); _fr = _tot + _Lc - 1; }
      var _relc = Math.max(0, Math.min(_Lc - 1, _fr - _tot));
      window.__b.lastFireDbg = { agentFrame: _cd.agentFrame, src: 'cache', nodeId: _curc.id, L: _Lc, rel: _relc };
      return { id: _curc.id, L: _Lc, start: _tot, rel: _relc, onPath: 'cache' }; }
    if (dz && typeof dz.agentFrame === 'number') window.__b.agentFrameFromDz = (window.__b.agentFrameFromDz || 0) + 1;
    if (!dz || typeof dz.agentFrame !== 'number') {
      window.__b.agentFrameMissing = (window.__b.agentFrameMissing || 0) + 1;
      // ⭐⭐⭐ 根因修复（父代理 2026-10-18）：拿不到 agentFrame 时，**必须用 commitNode+commitFrame 算游标**。
      //   为什么原来的"回退该节点末帧(back=0)"是错的（实测 hits 恒 0 的根因）：
      //     · `agentExecEnsure` 新目标时把游标置为 **commitNode 段起点 + 段内已过帧**（vantage_tree.js:8691-8705）
      //       ⟹ 游标停在 **commitNode 那一段**，不是目标节点那一段；
      //     · 原回退把射击帧挂在 **path 末节点（=目标）** 且 rel=L-1（段末帧）
      //       ⟹ `agentPickExecFrame` 算出的 execFrame 落在**目标段**、且是段末
      //       ⟹ 与游标（commitNode 段、段内早期）**永远对不上** ⟹ 一枪打不着。
      //   正解：挂到 **commitNode** 上、rel=commitFrame ⟹ execFrame = start(cmt)+commitFrame = **游标当帧**。
      //   （随后走"全帧枚举"分支，把该节点 [0,L) 全给出，因此即使游标再走几帧也命中。）
      window.__b.fireFallbackUsed = (window.__b.fireFallbackUsed || 0) + 1;
      var _ft = null; try { _ft = VantageTree.getTree(); } catch (eFT) { _ft = null; }
      var _cmt = _ft && _ft.commitNode;
      var _cf = (_ft && typeof _ft.commitFrame === 'number') ? _ft.commitFrame : -1;
      if (_cmt && _cf >= 0) {
        var _Lc = Math.max(1, window.__b.execLenOf(_cmt));
        var _relc2 = Math.max(0, Math.min(_Lc - 1, _cf));
        var _st = 0, _ci = -1, _qi;
        for (_qi = 0; _qi < p.length; _qi++) { if (p[_qi].id === _cmt.id) { _ci = _qi; break; } _st += Math.max(1, window.__b.execLenOf(p[_qi])); }
        if (_ci < 0) { _st = 0; }   // commitNode 不在该路线（B 给了另一支）⟹ 段起点按 0 计（仍指向 cmt 自己的段）
        window.__b.fireErr = 'ok: cursor from commitNode+commitFrame';
        window.__b.lastFireDbg = { agentFrame: null, src: 'commitFrame', nodeId: _cmt.id, L: _Lc, rel: _relc2, commitFrame: _cf, commitInPath: _ci >= 0 };
        return { id: _cmt.id, L: _Lc, start: _st, rel: _relc2, onPath: 'commit' };
      }
      // 真拿不到树/commitNode 时才退到旧行为（并单独计数，便于区分）
      window.__b.fireErr = 'picks[1]: 拿不到 agentFrame 且无 commitNode ⇒ 回退末节点';
      var _last = p[p.length - 1]; var _L = Math.max(1, window.__b.execLenOf(_last));
      window.__b.lastFireDbg = { agentFrame: null, nodeId: _last.id, L: _L, rel: _L - 1, fallback: true };
      return { id: _last.id, L: _L, start: 0, rel: _L - 1, onPath: 'fallbackLast' };
    }
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
  // ⭐⭐⭐ 瞄准闸门（父代理 2026-10-18 实验，`VT_AIM_GATE=<度>`）：
  //   动机 = 实测"开了 5 枪、弹药 5→2、但 bulletsSpawned 全打空、hits 恒 0" ⟹ 瓶颈不是能不能开枪，而是【朝哪开】。
  //   判据 = 最近【存活】对手相对车头方向的角度 ≤ gate 度才允许开火；超了就不发 picks[1]（并计数 aimBlocked）。
  //   ⚠️ 默认 0 = 关闭（行为不变）。selfRot 约定若反了，闸门会全拦 ⟹ 表现为 bulletsSpawned=0，届时翻符号重试。
  window.__b.aimGateDeg = 0;
  window.__b.setFireRoot = function (v) { window.__b.fireRoot = (+v ? 1 : 0); return window.__b.fireRoot; };
  window.__b.setFireSingle = function (v) { window.__b.fireSingle = (+v ? 1 : 0); return window.__b.fireSingle; };
  window.__b.setAimGate = function (d) { window.__b.aimGateDeg = (+d || 0); return window.__b.aimGateDeg; };
  window.__b.aimOk = function () {
    var g = window.__b.aimGateDeg | 0;
    if (!g) return true;
    try {
      var G = window.__b.lastG, O = window.__b.lastOpp || [];
      if (!G) return true;
      var sx = +G[6], sy = +G[7], sr = +G[8];
      if (!isFinite(sx) || !isFinite(sy) || (sx === 0 && sy === 0)) return true;   // 自车状态缺失 ⟹ 不拦
      var best = null, bestA = null;
      for (var i = 0; i < O.length; i++) {
        var r = O[i]; if (!r) continue;
        if (+r[7] !== 1) continue;                       // oAlive
        var dx = (+r[0]) - sx, dy = (+r[1]) - sy;
        var d2 = dx * dx + dy * dy;
        if (best === null || d2 < best) { best = d2; bestA = Math.atan2(dy, dx); }
      }
      if (best === null) return true;                    // 没有对手 ⟹ 不拦
      var da = bestA - sr;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      var deg = Math.abs(da) * 180 / Math.PI;
      window.__b.aimLastDeg = deg;
      if (deg <= g) { window.__b.aimPassN = (window.__b.aimPassN || 0) + 1; return true; }
      window.__b.aimBlocked = (window.__b.aimBlocked || 0) + 1;
      return false;
    } catch (eAG) { window.__b.aimErr = String((eAG && eAG.message) || eAG); return true; }
  };
  window.__b.setHoldTarget = function (n) { window.__b.holdTargetN = (+n || 0); return window.__b.holdTargetN; };
  window.__b.setFireBack = function (m) { window.__b.fireBack = (m === 'now') ? 'now' : 'zero'; window.__b.fireBackSet++; return window.__b.fireBack; };  window.__b.setFire = function (f) { window.__b.wantFire = !!f; return window.__b.wantFire ? 1 : 0; };
  window.__b.stats = function () {
    var IS = window.__vantageIface || {};
    return { aCalls: window.__b.aCalls||0, aNotGrowable: window.__b.aNotGrowable||0, aTreeFull: window.__b.aTreeFull||0, growRejectMissing: window.__b.growRejectMissing||0, growRejectNotGrowable: window.__b.growRejectNotGrowable||0, growStillValid: window.__b.growStillValid||0, growChkErr: window.__b.growChkErr||null, aCanGrowErr: window.__b.aCanGrowErr||null, aGrow: window.__b.aGrow||0, aGrowServer: window.__b.aGrowServer||0, aServerReject: window.__b.aServerReject||0, growOkCount: window.__b.growOkCount||0, fireEmptyFallback: window.__b.fireEmptyFallback||0, aNotLeaf: window.__b.aNotLeaf||0, aNoSlots: window.__b.aNoSlots||0, aErr: window.__b.aErr||null, lastGrow: window.__b.lastGrow||null, nodeCount: (function(){try{var t=VantageTree.getTree();return t?t.nodeCount:null}catch(e){return null}})(),
             fireSubmits: window.__b.fireSubmits, fireNoCursor: window.__b.fireNoCursor, fireFallbackUsed: window.__b.fireFallbackUsed || 0, fireHackApplied: window.__b.fireHackApplied || 0, bTargetSrc: window.__b.bTargetSrc || null, bNoTargetAll: window.__b.bNoTargetAll || 0, fireHackErr: window.__b.fireHackErr || null, pathFallback: window.__b.pathFallback || 0, fireMasked: window.__b.fireMasked || 0, aimGateDeg: (window.__b.aimGateDeg||0), aimBlocked: (window.__b.aimBlocked||0), aimPassN: (window.__b.aimPassN||0), aimLastDeg: (window.__b.aimLastDeg===undefined?null:window.__b.aimLastDeg), aimErr: (window.__b.aimErr||null), holdTargetN: (window.__b.holdTargetN||0), holdReused: (window.__b.holdReused||0), holdAccepted: (window.__b.holdAccepted||0), aSkipEnoughLeaves: window.__b.aSkipEnoughLeaves || 0, aSkipNotThisFrame: window.__b.aSkipNotThisFrame || 0, aNoTree: window.__b.aNoTree || 0, aNoSlots: window.__b.aNoSlots || 0, aBadTarget: window.__b.aBadTarget || 0, aGrowTurns: window.__b.aGrowTurns || 0, agentFrameFromCache: window.__b.agentFrameFromCache || 0, agentFrameFromDz: window.__b.agentFrameFromDz || 0, agentFrameMissing: window.__b.agentFrameMissing || 0, bResendAfterA: window.__b.bResendAfterA || 0, bResendOk: window.__b.bResendOk || 0,
             curLStats: (function(){ var a = window.__b.curLs || []; if (!a.length) return null; var b = a.slice().sort(function(x,y){return x-y;}); return {min:b[0], med:b[Math.floor(b.length/2)], max:b[b.length-1], n:b.length}; })(), fireSkippedRetry: window.__b.fireSkippedRetry || 0, emptyBlocked: window.__b.emptyBlocked || 0, gAmmo: window.__b.gAmmo, gQueue: window.__b.gQueue, deathSubErr: window.__b.deathSubErr || null, pulseBlocked: window.__b.pulseBlocked || 0, pulseBlock: (window.__b.pulseBlock || 0), fbSum: window.__b.fbSum||0, fbN: window.__b.fbN||0, fb1: window.__b.fb1||0, fb24: window.__b.fb24||0, fb5: window.__b.fb5||0, pulseHeldFrames: (window.__b.pulseHeldFrames || 0), pulseBlockedByPrev: window.__b.pulseBlockedByPrev || 0, pulseBlockedBySelfFire: window.__b.pulseBlockedBySelfFire || 0, selfFire: window.__b.gSelfFire || 0,
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
      // ⭐⭐⭐ A 每帧成功 ⇒ vantage_tree.js:4583 每帧清空 _agentRoute ⇒ agentFrame 永远 undefined ⇒ 射击废掉
      //    ⇒ 【只有可生长叶子不够时才调 A】picks:[] 走"本帧不生长"，不清 _agentRoute
      // ⭐ 已删除旧的「叶子数阈值型」闸门（它排在时间闸门之前，每帧都跳过 ⇒ aGrowTurns 恒 0）
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
          window.__b.forceBResend = true;
          window.__b.growFact = { nodeId: _uid, result: 'pending', reason: 'serverPick' };
          window.__b.pendingGrowCheck = { uid: _uid, depth: null };   // ⭐ 服务端路径也必须设（否则复查不跑 ⇒ 永远 pending）
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
      window.__b.pendingGrowCheck = { uid: n.id, depth: (w.path ? w.path.length : null) };
      if (!window.__b.growFact) window.__b.growFact = { nodeId: n.id, result: 'pending', reason: 'submitted' };   // ⭐ 首帧就有事实可传   // ⭐ 下一帧复查这个 uid 还在不在/能不能长
      window.__b.aGrow = (window.__b.aGrow || 0) + 1;
      window.__b.forceBResend = true;
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
      // ⭐⭐⭐ 游标兜底：pathNodes 为空时用【目标节点自身】（射击帧只需 {nodeId, back}，不需要整条路径）
      if (n && (!pathNodes || !pathNodes.length)) { pathNodes = [n]; window.__b.pathFallback = (window.__b.pathFallback || 0) + 1; }
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
      // ⭐⭐ 权威版 2026-10-07：【连续帧 = 按住】是设计要求；pulse 默认**只记录不拦截**（VT_PULSE_BLOCK=1 才拦）
      var _prevSub = (window.__b.lastFrameSubmitted === true);
      var _blkPrev = (window.__b.pulseBlock === 1) && _prevSub;
      var _blkSF = (window.__b.selfFire === true);
      // ⭐⭐ 空射抑制（主人听到了空射音效）：`ammoLeft`=globalTok[15]、`queueLen`=globalTok[35]，两者都没子弹就不扣扳机
      var _ammo = (typeof window.__b.gAmmo === 'number') ? window.__b.gAmmo : null;
      var _queue = (typeof window.__b.gQueue === 'number') ? window.__b.gQueue : null;
      var _blkEmpty = (_ammo !== null && _ammo <= 0 && !(_queue > 0));
      if (window.__b.fireMode === 'mask' && window.__b.wantFire) { window.__b.fireMasked = (window.__b.fireMasked || 0) + 1; }   // ⭐ VT_FIRE_MODE=mask：射击维临时屏蔽
      // ⭐⭐ VT_FIRE_HACK（仅实验）：_agentRoute 为空时游戏走 commitNode.inputs ⇒ 直接置 fire
      if (window.__b.fireHack && window.__b.wantFire) { try { var _th = VantageTree.getTree(); if (_th && _th.commitNode && _th.commitNode.inputs) { _th.commitNode.inputs.fire = true; window.__b.fireHackApplied = (window.__b.fireHackApplied || 0) + 1; } } catch (eFH) { window.__b.fireHackErr = String((eFH && eFH.message) || eFH); } }
      if (window.__b.fireMode !== 'mask' && window.__b.wantFire && _att === 0 && !(_blkPrev || _blkSF || _blkEmpty) && window.__b.aimOk()) {
        // ⭐ 射击帧 = picks[1..]（出处 `交接-现状说明-2026-10-09.md:52`：(节点ID, 相对时间) 表示射击帧）
        //    nodeId = 【当前路线游标所在节点】（必须在路线上；`vantage_tree.js:4283 agentExecEnsure` 的游标起点）
        //    back   = L−1−rel ⟹ `agentPickExecFrame`（:4336）`e = start+(L−back)−1 = start+rel` = **当帧**
        //    （父代理 2026-10-17 裁定 (a)：用 L−1−rel；`VT_FIRE_BACK=zero` 保留 back=0 作对照）
        var cbf = (window.__b.fireBack === 'now') ? window.__b.cursorByFrame(tree, pathNodes) : null;   // ⭐ 精确：游戏游标帧
        var cur = cbf || window.__b.cursor(tree, pathNodes);
        try { if (cur && typeof cur.L === 'number') { window.__b.curLs = window.__b.curLs || []; if (window.__b.curLs.length < 4000) window.__b.curLs.push(cur.L); } } catch (eCL) { }                                           // 兜底：commitNode 口径
        if (cur) {
          // ⭐⭐⭐ 假设验证（VT_FIRE_FIRST=1）：只发「段首帧」back=L-1（当前游标 `_agentExecFrame` 每帧从 0 起 ⇒ 真正执行的就是首帧）
          if (false && window.__b.fireFirst) {   // ⭐ 假设已被实测否定（7.2%），停用
            var _Lf = cur.L | 0;
            picks.push({ nodeId: cur.id, back: _Lf - 1 });
            window.__b.fireSubmits++;
            window.__b.fbSum = (window.__b.fbSum || 0) + 1; window.__b.fbN = (window.__b.fbN || 0) + 1; window.__b.fb1 = (window.__b.fb1 || 0) + 1;
            window.__b.fireSubmittedThisFrame = true;
            window.__b.lastFirePick = { nodeId: cur.id, backs: [_Lf - 1], L: _Lf, mode: 'firstFrame' };
            window.__b.lastBuilt = picks; window.__b.lastTargetId = n.id; window.__b.lastPickNodeId = n.id; window.__b.lastHadFire = (picks.length > 1); window.__b.lastHadFireN = picks.length;
            return { picks: picks, memory: {} };
          }
          // ⭐⭐ 权威版 :1020-1050：「帧级插入，只要合法就没有上限……连续两帧 = 按住」
          //    ⇒ 直接问【节点自己】的段长 L，把段内全部合法帧都作为射击帧（不问游标）
          var _Ln = null;
          try { if (cur && typeof cur.L === 'number' && cur.L > 0) _Ln = cur.L | 0; } catch (eL1) { }
          if (!_Ln) { try { var _nL = (window.__b.nodeRows && window.__b.nodeRows[window.__b.lastPickRow]) ? null : null; } catch (eL2) { } }
          if (_Ln && _Ln > 0) {   // ⭐⭐ 全帧枚举对【所有路径】生效（包括回退路径）：不管下一帧执行第几帧都能命中
            // ⚠️ 隔帧枚举已【撤回】（2026-10-18 实测：opBFire 243→5、bulletsSpawned 7→5，反而更差）⟹ 恢复全帧枚举。
            // ⭐⭐⭐ 单帧开火（父代理 2026-10-18，`VT_FIRE_SINGLE=1`）：
            //   实测根因 —— **全帧枚举 = 把整段都设成 fire = 一直按住扳机**，
            //   而 `BulletWeapon._triggerPulled` 是【锁存】的 ⟹ 一直按住只出 **1 发**。
            //   而评测侧（`_g1_inject.js:159`）只发 `{nodeId:root, back:1e9}` ⟹ execFrame=0 ⟹
            //   **只在游标回 0 的帧 fire=true** ⟹ 天然"按一帧、松一帧" ⟹ 子弹多、能打死人。
            //   ⟹ 这里改成**只发当前游标那一帧**，让 fire 随游标推进自然交替。
            // ⭐⭐⭐ 复刻评测写法（`VT_FIRE_ROOT=1`）：`{nodeId: root.id, back: 1e9}` ⟹ back 被 clamp 成 L-1
            //   ⟹ execFrame = start(root)+0 = 0 ⟹ 只在"游标回 0"的帧 fire=true ⟹ 天然按/松交替。
            //   这是【唯一还没试过】的组合，而评测用它 302 帧就打死人。
            if (window.__b.fireRoot) {
              var _rt2 = null; try { var _tt = VantageTree.getTree(); _rt2 = _tt && _tt.root ? _tt.root.id : null; } catch (eFR) { }
              if (_rt2 !== null) {
                picks.push({ nodeId: _rt2, back: 1e9 });
                window.__b.fireSubmits++;
                window.__b.fireSubmittedThisFrame = true;
                window.__b.lastFirePick = { nodeId: _rt2, backs: [1e9], mode: 'rootHugeBack' };
                window.__b.lastBuilt = picks; window.__b.lastTargetId = n.id; window.__b.lastPickNodeId = n.id;
                return { picks: picks, memory: {} };
              }
            }
            var _all = [];
            if (window.__b.fireSingle) {
              var _relS = (typeof cur.rel === 'number') ? cur.rel : 0;
              _all.push({ back: _Ln - 1 - _relS, frame: _relS });
            } else {
              for (var _b = 0; _b < _Ln; _b++) _all.push({ back: _b, frame: _Ln - 1 - _b });
            }
            window.__b.fireAllFrames = _Ln;
            for (var _bi2 = 0; _bi2 < _all.length; _bi2++) picks.push({ nodeId: cur.id, back: _all[_bi2].back });
            window.__b.fireSubmits++;
            window.__b.fbSum = (window.__b.fbSum || 0) + _all.length; window.__b.fbN = (window.__b.fbN || 0) + 1;
            if (_all.length === 1) window.__b.fb1 = (window.__b.fb1 || 0) + 1; else if (_all.length <= 4) window.__b.fb24 = (window.__b.fb24 || 0) + 1; else window.__b.fb5 = (window.__b.fb5 || 0) + 1;
            window.__b.fireSubmittedThisFrame = true;
            window.__b.lastFirePick = { nodeId: cur.id, backs: _all.map(function (x) { return x.back; }), L: _Ln, mode: 'allFrames' };
            window.__b.lastBuilt = picks; window.__b.lastTargetId = n.id; window.__b.lastPickNodeId = n.id;
            return { picks: picks, memory: {} };
          }
          var frs = [];
          if (cbf) { frs.push(cbf.rel); frs.push(cbf.rel + 1); frs.push(cbf.rel - 1); }
          frs.push(0); if (typeof cur.rel === 'number') { frs.push(cur.rel); frs.push(cur.rel + 1); frs.push(cur.rel - 1); }
          if (!cbf) { frs.push(1); frs.push(Math.floor(cur.L / 2)); frs.push(cur.L - 2); frs.push(cur.L - 1); }   // ⭐ 无游标时的锚点候选（恢复冗余兜底）   // ⭐ 候选执行帧：精确帧/±1（同目标游标逐帧+1）/新路线帧0/tNow 估值
          var bl = [];
          for (var fi = 0; fi < frs.length; fi++) {
            var f2 = Math.max(0, Math.min(cur.L - 1, (frs[fi] | 0) + (window.__b.fireBias | 0)));
            var bk = Math.max(0, Math.min(cur.L - 1, cur.L - 1 - f2));
            var dup = false; for (var di = 0; di < bl.length; di++) if (bl[di].back === bk) dup = true;
            if (!dup) bl.push({ back: bk, frame: f2 });
          }   // ⭐ 单帧精确对齐（cursorByFrame 已算出 rel）
          // ⭐⭐ 射击帧由【服务端 head_fire 采样】给出 ⇒ 直接用，桥不再枚举（回退：服务端没给就用自己的 bl）
          // ⭐⭐ 两级门（父代理批准）：服务端 fire_frames 优先；若策略要开火但采样出空 ⇒ 回退桥候选帧并计数
          if (Array.isArray(window.__b.fireFramesFromServer) && window.__b.fireFramesFromServer.length) {
            // ⭐⭐ 合并独立（不覆盖）：服务端选的帧优先，但保留桥的 rel/±1/0 冗余兜底
            // ⭐⭐ 服务端只做【过滤】，**桥的候选集为准**（⏔t 合并 ⇒ 上一帧回来的列表会滚雪球到 72 条）
            var _keep = {}; for (var _i2 = 0; _i2 < window.__b.fireFramesFromServer.length; _i2++) _keep[window.__b.fireFramesFromServer[_i2].back | 0] = 1;
            var _filt = []; for (var _j2 = 0; _j2 < bl.length; _j2++) if (_keep[bl[_j2].back]) _filt.push(bl[_j2]);
            if (_filt.length) bl = _filt; else { window.__b.fireEmptyFallback = (window.__b.fireEmptyFallback || 0) + 1; }
          }
          for (var bi = 0; bi < bl.length; bi++) picks.push({ nodeId: cur.id, back: bl[bi].back });   // ⭐ picks[1..] = 若干射击帧（帧0 / 游标帧 / 游标帧+1）
          // ⭐ `fireBias` 只用于"rel 是否差 1 帧"的标定测量（默认 0，由 `VT_FIRE_REL_BIAS` 设）
          // （射击帧已在上面按 bl 全部 push；此处不再单独 push）
          window.__b.fireSubmits++;
          { var _nb = picks.length - 1; if (_nb > 0) { window.__b.fbSum = (window.__b.fbSum || 0) + _nb; window.__b.fbN = (window.__b.fbN || 0) + 1;
              if (_nb === 1) window.__b.fb1 = (window.__b.fb1 || 0) + 1; else if (_nb <= 4) window.__b.fb24 = (window.__b.fb24 || 0) + 1; else window.__b.fb5 = (window.__b.fb5 || 0) + 1; } }   // ⭐ 真实拼包条数
          window.__b.fireSubmittedThisFrame = true;   // ⭐ 本帧真提交了射击帧 ⇒ 下一帧要松扳机
          window.__b.lastFirePick = { nodeId: cur.id, backs: bl.map(function (x) { return x.back; }), frames: bl.map(function (x) { return x.frame; }), L: cur.L, rel: cur.rel, mode: window.__b.fireBack, onPath: cur.onPath, dbg: window.__b.lastFireDbg || null };
        } else { window.__b.fireNoCursor++; }
      } else if (window.__b.wantFire && _att === 0 && (_blkPrev || _blkSF)) {   // ⭐ 脉冲拦下（松扳机帧）
        window.__b.pulseBlocked = (window.__b.pulseBlocked || 0) + 1;
        if (_blkPrev) window.__b.pulseBlockedByPrev = (window.__b.pulseBlockedByPrev || 0) + 1;
        if (_prevSub && window.__b.pulseBlock === 1) window.__b.pulseHeldFrames = (window.__b.pulseHeldFrames || 0) + 1;
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
        try { window.__b.lastPhaseSeen = (ctx && ctx.phase) || (info && info.phase) || null; } catch (ePh) {} var ph = null; try { ph = (ctx && ctx.phase) || (info && info.phase) || null; window.__b.lastPhase = ph; } catch (e) {} if (ph === 'A') { window.__b.aCalls = (window.__b.aCalls || 0) + 1; if (window.__b.forceBResend) { window.__b.forceBResend = false; window.__b.bResendAfterA = (window.__b.bResendAfterA || 0) + 1; } return window.__b.buildA(); }
        var _bdec = window.__b.build();
        // ⭐⭐ B 相合法保底：永远给一个目标（picks[0].nodeId + select），⏔t 回空 picks
        try {
          var _nb = (_bdec && _bdec.picks && _bdec.picks.length) ? (_bdec.picks[0].nodeId | 0) : null;
          var _src = _nb !== null ? 'normal' : null;
          var _tr3 = VantageTree.getTree();
          if (_nb === null && typeof window.__b.lastGoodTarget === 'number') { _nb = window.__b.lastGoodTarget; _src = 'lastGood'; }
          if (_nb === null && _tr3 && _tr3.commitNode) { _nb = _tr3.commitNode.id; _src = 'commitNode'; }
          if (_nb === null && _tr3 && _tr3.root) { var _q3 = [_tr3.root]; while (_q3.length) { var _c3 = _q3.shift(); if (_c3 && _c3 !== _tr3.root) { _nb = _c3.id; _src = 'anyLeaf'; break; } var _k3 = _c3.children || []; for (var _z3 = 0; _z3 < _k3.length; _z3++) _q3.push(_k3[_z3]); } }
          if (_nb === null) { window.__b.bNoTargetAll = (window.__b.bNoTargetAll || 0) + 1; window.__b.bTargetSrc = window.__b.bTargetSrc || {}; window.__b.bTargetSrc.none = (window.__b.bTargetSrc.none || 0) + 1; return _bdec || { picks: [], memory: {} }; }
          window.__b.bTargetSrc = window.__b.bTargetSrc || {}; window.__b.bTargetSrc[_src] = (window.__b.bTargetSrc[_src] || 0) + 1;
          if (_src !== 'normal') { window.__b.lastGoodTarget = _nb; }
          var _p2 = (_bdec && _bdec.picks && _bdec.picks.length) ? _bdec.picks : [{ nodeId: _nb, back: 0 }];
          return { picks: _p2, select: _nb, memory: (_bdec && _bdec.memory) || {} };
        } catch (eBT) { window.__b.bTargetErr = String((eBT && eBT.message) || eBT); return _bdec || { picks: [], memory: {} }; }
      } };   // ⭐ 父代理裁定 (b)：A 相 return null ⟹ 不清空 _agentRoute/_agentFirePicks（依据 vantage_tree.js:4580-4585）
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
    window.__b.lastG = gArr; window.__b.lastOpp = (e.global && Array.isArray(e.global.oppTok)) ? e.global.oppTok : [];   // ⭐ 供瞄准闸门用
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
    // ⭐⭐⭐ 目标保持（父代理 2026-10-18 实验，`VT_HOLD_TARGET=N` 帧）：
    //   动机 = 实测 `targetChangedFrames` 高达 85% ⟹ 目标每帧变 ⟹ `agentExecEnsure` 每帧把游标
    //   重置回 commitNode 段起点 ⟹ ① 射击帧的 execFrame 依赖"到目标的路径起点"，目标一换即作废
    //   （实测 subFireFrames 37/1472 = 2.5%）② 观感"一抽一抽"（nodeId 逐帧变化率 91.4%）。
    //   而 `agentExecEnsure` 本来就有一条「同目标 ⟹ 游标 +1 逐帧推进」分支 ⟹ **设计期待 B 常重复同一目标**。
    //   ⚠️ 这是【实验开关】，默认 0 = 关闭，行为与之前完全一致。
    var _freshSlots = slots;          // ⭐ A 相仍用【未保持】的新鲜目标（否则 A 永远走同一条叶路径 ⟹ 长不动，实测 nodeDelta 722→3）
    var _holdN = (window.__b.holdTargetN | 0);
    if (_holdN > 0) {
      window.__b.holdLeft = (window.__b.holdLeft | 0) - 1;
      if (window.__b.heldSlots && window.__b.holdLeft > 0) {
        slots = window.__b.heldSlots;                       // 沿用上一次目标
        window.__b.holdReused = (window.__b.holdReused || 0) + 1;
      } else {
        window.__b.heldSlots = slots; window.__b.holdLeft = _holdN;
        window.__b.holdAccepted = (window.__b.holdAccepted || 0) + 1;
      }
    }
    window.__b.lastPickRow = (typeof nodeId === 'number') ? nodeId : null;   // ⭐ 只读暴露：动作行号
    // ⭐⭐ 只读复查（父代理要求）：上一帧 A 报的 uid 在这一帧
    //    还在不在树里 / 还能不能长 ⇒ 把 growAt=0 拆成两类
    if (window.__b.pendingGrowCheck) {
      var _gc0 = window.__b.pendingGrowCheck; window.__b.pendingGrowCheck = null;
      try {
        var _tr = VantageTree.getTree(); var _f = null;
        (function rec(nd, dep) { if (!nd || _f || dep > 60) return; if (nd.id === _gc0.uid) { _f = nd; return; } var ks = nd.children || []; for (var q = 0; q < ks.length; q++) { rec(ks[q], dep + 1); if (_f) return; } })(_tr && _tr.root, 0);
        if (!_f) { window.__b.growRejectMissing = (window.__b.growRejectMissing || 0) + 1;
          window.__b.growFact = { nodeId: _gc0.uid, result: 'reject', reason: 'missing' }; }
        // ⭐ 事实直传：成功/被拒 均记成事实（供 plan 段传给 B）
        else {
          var _ok = true;
          try { _ok = !(typeof VantageTreeInterface !== 'undefined' && VantageTreeInterface.Invariants) ? true : !!VantageTreeInterface.Invariants.canGrowAt(_f); } catch (eOk) { _ok = true; }
          if (!_ok) { window.__b.growRejectNotGrowable = (window.__b.growRejectNotGrowable || 0) + 1;
            window.__b.growFact = { nodeId: _gc0.uid, result: 'reject', reason: 'notGrowable' }; }
          else { window.__b.growStillValid = (window.__b.growStillValid || 0) + 1;
            window.__b.growFact = { nodeId: _gc0.uid, result: 'ok', reason: 'grew' }; }
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
    window.__b.pendingSlots = _freshSlots;   // ⭐ 给 A 用的是新鲜目标；B 用（可能被保持的）slots
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
      cur: (function () { try { var t = VantageTree.getTree(); return window.__b.cursor(t, window.__b.walk(t, window.__b.pendingSlots).path); } catch (e) { return null; } })(), probeDz: (function () { if (!window.__b.probeDzOn) return null; if ((window.__b.probeDzN || 0) >= 3) return null;
  try { var _dz = VantageTree.getDesiredOperation(); if (!_dz) return null; window.__b.probeDzN = (window.__b.probeDzN || 0) + 1;
    var _t = VantageTree.getTree(); var _lpn = window.__b.lastPickNodeId; var _lpNode = null;
    (function rc(nd, dep) { if (!nd || _lpNode || dep > 60) return; if (nd.id === _lpn) { _lpNode = nd; return; } var ks = nd.children || []; for (var q = 0; q < ks.length; q++) { rc(ks[q], dep + 1); if (_lpNode) return; } })(_t && _t.root, 0);
    var _eq = function (x, y) { try { return JSON.stringify(x) === JSON.stringify(y); } catch (e) { return 'ERR'; } };
    return { dz_keys: Object.keys(_dz), dz_inputs: _dz.inputs, dz_agentFrame: (typeof _dz.agentFrame === 'number' ? _dz.agentFrame : 'undefined'), dz_opName: _dz.opName || null,
      dz_agentRoute: _dz.agentRoute ? String(JSON.stringify(_dz.agentRoute)).slice(0, 120) : null,
      tree_agentRoute_stats: (_t && _t.stats ? _t.stats.agentRouteId : null), tree_agentFireFrames_stats: (_t && _t.stats ? _t.stats.agentFireFrames : null),
      commitNode_id: (_t && _t.commitNode) ? _t.commitNode.id : null, commitNode_inputs: (_t && _t.commitNode) ? _t.commitNode.inputs : null,
      lastPickNodeId: _lpn, lastPick_inputs: _lpNode ? _lpNode.inputs : null,
      EQ_dz_vs_lastPick: _eq(_dz.inputs, _lpNode && _lpNode.inputs), EQ_dz_vs_commitNode: _eq(_dz.inputs, _t && _t.commitNode && _t.commitNode.inputs),
      agentModeCurrentB: (function () { try { var b = window.VantageTreeInterface && VantageTreeInterface.Agents && VantageTreeInterface.Agents.current && VantageTreeInterface.Agents.current('B'); return b ? (b.name || 'noName') : 'noB'; } catch (e) { return 'ERR:' + e.message; } })(),
      agents_current_all: (function () { try { return (VantageTreeInterface.Agents.current() || {}).name || null; } catch (e) { return 'ERR'; } })() };
  } catch (ePD) { return { err: String((ePD && ePD.message) || ePD) }; } })(),
matchDbg: (function () { if (!window.__b.probeMatchDbgOn) return null; window.__b.mdN = (window.__b.mdN || 0) + 1; if ((window.__b.mdN % 5) !== 0) return null;   // ⭐ 只在「策略要开火」的帧采
  try { var IS = window.__vantageIface || {}; var dec = IS.lastDecision;
    var _t = VantageTree.getTree();
    return { acceptedLen: (dec && dec.picks) ? dec.picks.length : null,
             acceptedFirst3: (dec && dec.picks) ? dec.picks.slice(0, 3).map(function (p) { return [p.nodeId, p.back]; }) : null,
             builtLen: (window.__b.lastBuilt || []).length,
             agentFirePicksLen_stats: _fpLen, agentRouteId_stats: _rid,
             giveUpB: IS.giveUpB || 0, callsB: IS.callsB || 0, callsA: IS.callsA || 0, skipped: IS.skipped || '' };
  } catch (e) { return { err: String((e && e.message) || e) }; } })(),
             probeGate: (function () { if (!window.__b.probeGateOn) return null; window.__b.pgN = (window.__b.pgN || 0) + 1; if (window.__b.pgN % 40 !== 0) return null;
  try { var t = VantageTree.getTree(); var pth = window.__b.walk(t, window.__b.pendingSlots || []); var cur = window.__b.cursorByFrame ? window.__b.cursorByFrame(t, window.__b.pathOf ? window.__b.pathOf(pth) : []) : null;
    return { wantFire: !!window.__b.wantFire, att: window.__b.attCount || 0, blockedPrev: (window.__b.pulseBlock === 1 && window.__b.lastFrameSubmitted === true),
             selfFire: window.__b.selfFire === true, curNull: !cur, curL: cur ? cur.L : null, fireSubmittedLast: !!window.__b.lastHadFire };
  } catch (e) { return { err: String((e && e.message) || e) }; } })(),
             probeMatch: (function () { if (!window.__b.probeMatchOn) return null; try {
  window.__b.pmTick = (window.__b.pmTick || 0) + 1; if (window.__b.pmTick % 5 !== 0) return null;
  var _d = VantageTree.getDesiredOperation(); if (!_d || _d.agentRoute === null || _d.agentRoute === undefined) return { skip: 'noAgentRoute', opName: _d && _d.opName };
  var _t = VantageTree.getTree(); var _fp = [];   // ⭐ 包装对象没有 _agentFirePicks（必须读 stats）
  var _fpLen = (_t && _t.stats && typeof _t.stats.agentFireFrames === "number") ? _t.stats.agentFireFrames : -1;
  var _rid = (_t && _t.stats) ? _t.stats.agentRouteId : null;
  var _ids = []; for (var _i = 0; _i < _fp.length; _i++) { var _nid = _fp[_i] && _fp[_i].nodeId; if (_ids.indexOf(_nid) < 0) _ids.push(_nid); }
  var _has = false; for (var _j = 0; _j < _fp.length; _j++) if (_fp[_j] && _fp[_j].nodeId === _d.agentRoute) _has = true;
  var _lp = window.__b.lastBuilt || [];
  return { agentFrame: _d.agentFrame, agentRoute: _d.agentRoute, firePicks_len: _fp.length, firePicks_unique_ids: _ids.slice(0, 5),
    firePicks_hasRouteTarget: _has, lastPick_n0: _lp[0] ? _lp[0].nodeId : null, lastPick_n1: _lp[1] ? _lp[1].nodeId : null,
    lastHadFireN: window.__b.lastHadFireN || 0, lastPick_sameNode: !!(_lp[0] && _lp[1] && _lp[0].nodeId === _lp[1].nodeId), lastPick_routeEqTarget: !!(_d.agentRoute !== null && _lp[0] && _lp[0].nodeId === _d.agentRoute) };
} catch (ePM) { return { err: String((ePM && ePM.message) || ePM) }; } })(),
             execStill: (function () { try { var _d = VantageTree.getDesiredOperation(); if (!_d || !_d.inputs) return null; var _i = _d.inputs;
               return !(_i.forward || _i.back || _i.left || _i.right); } catch (e) { return null; } })(),
             execByPolicy: (function () { try { var _d = VantageTree.getDesiredOperation(); return !!(_d && typeof _d.agentFrame === 'number'); } catch (e) { return null; } })(),
             plan: (function () { try { var _g = window.__b.growFact; if (!_g) return null; var _pi = VantageObserve.encodePlan({ leafId: _g.nodeId, stale: (_g.result === 'ok' ? 0 : 1), fires: [] }, 8); return _pi.token; } catch (eP) { window.__b.planErr = String((eP && eP.message) || eP); return null; } })(),
             growFact: (window.__b.growFact || null), stats: st, growOk: (window.__b.growOk||null), growOkCount: (window.__b.growOkCount||0), subFire: subFire, opName: opName, wep: wep, aim: aimNow, aimDeg: aimDeg,   // ⭐ wep 必须在（上一版被后续补丁覆盖丢了 ⇒ shots 测成 0）
      ammo: window.__b.gAmmo, queueLen: window.__b.gQueue, kills: (function(){ var q = window.__b.kills || []; window.__b.kills = []; return q; })(),   // ⭐ 奖惩 v2：本帧前新增的 TANK_KILLED 事件（取完清空） wep: wep, desiredFrame: desiredFrame, desiredFire: desiredFire, desiredErr: desiredErr, wantFire: window.__b.wantFire ? 1 : 0,
      b: bSrc, nSlots: slots ? slots.length : -1, nBul: bSrc.length, bDim: (e.bullets && e.bullets.dim) || null,
      opp: (gl.oppTok || null), col: (gl.colTok || null), mine: (gl.mineTok || null) });   // ⭐ 敌人/道具信息（在 global 里）
  };
  window.__probe = window.__b;
  return 'installed';
})()
