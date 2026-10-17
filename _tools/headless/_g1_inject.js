/**
 * G1 探针（页面侧）—— 让「Vantage 打 Laika」跑通一整局
 * ==========================================================================
 * 结构照抄 `inject_sarl2.js`（已是"起对局 + 每帧读观测 + 喂回决策"的完整循环），
 * 只改三类事：
 *   ① 适配器绑到【真正的 Vantage 玩家 id】（不再是写死的 'tank_a'）
 *   ② 观测按【完整 segs】上行（node / opp / global），并报出真实行数与各段宽度
 *      ⚠️ bullet 段：`VantageObserve` 的 BULLET_DIM=7，而网络槽位是 6 ⟹ 本探针【不发】
 *         （发了会被服务端的"段超容量"显式拒绝 —— 见 policy_server_graph.py 的 shape 检查）
 *   ③ 每帧回报【双方位姿 + 弹丸按归属计数 + 武器开火数 + 对局状态】—— G1 四条判据的原始证据
 *
 * 契约（与 inject_sarl2 一致）：`window.__g1.step(nodeId)` 一次 eval 完成
 *   「读观测 + 写决策（上一帧策略给的 nodeId）」，返回一行 JSON 字符串。
 */
(function () {
  var G = window.__g1 = { n: 0, bundleA: null, bundleB: null, ad: null, adId: null, err: null, fire: 0 };
  /** 是否附射击帧（默认关；开=车也会开火） */
  G.setFire = function (v) { G.fire = v ? 1 : 0; return G.fire; };

  G.mk = function (tag) {
    return { name: 'g1bridge' + tag, isReady: function () { return true; },
             decide: function () { return (tag === 'B' ? G.bundleB : G.bundleA) || null; } };
  };

  /** 场上 Vantage 玩家的 id（由 AIManager 自己报，不靠我们猜） */
  G.vantageId = function () {
    try {
      var ms = (typeof AIs !== 'undefined' && AIs.aiManagers) ? AIs.aiManagers : [];
      for (var i = 0; i < ms.length; i++) {
        var m = ms[i];
        if (m && m.isVantage) {
          if (typeof m.getAIId === 'function') return m.getAIId();
          return m.aiId || null;
        }
      }
    } catch (e) { }
    return null;
  };

  G.setup = function () {
    var A = VantageTreeInterface.Agents;
    A.register(G.mk('A'), 'A'); A.register(G.mk('B'), 'B');
    A.use('g1bridgeA', 'A'); A.use('g1bridgeB', 'B');
    return 'ok';
  };

  /** 订阅回合事件：把 TANK_KILLED 等记下来（胜负的直接证据） */
  G.kills = [];
  G.subscribe = function () {
    var gc = GameManager.getGameController();
    var RE = (typeof RoundModel !== 'undefined' && RoundModel._EVENTS) ? RoundModel._EVENTS : {};
    var nameOf = {};
    for (var k in RE) nameOf[RE[k]] = k;
    gc.addRoundEventListener(function (self, id, evt, data) {
      try {
        if (evt === RE.TANK_KILLED) {
          G.kills.push({ n: G.n, evt: nameOf[evt] || String(evt),
            killer: (data && data.getKillerPlayerId) ? data.getKillerPlayerId() : null,
            victim: (data && data.getVictimPlayerId) ? data.getVictimPlayerId() : null });
        } else if (evt === RE.ROUND_ENDED) {
          var pids = null;
          try { pids = (data && data.getPlayerIds) ? __vtArr(data.getPlayerIds()) : null; } catch (eP) { }
          if (pids) pids = pids.map(function (x) { return String(x); });
          G.roundEnded = { n: G.n, evt: nameOf[evt] || String(evt), playerIds: pids,
            scores: __vtArr(gc.getScores()).map(function (s) {
              return { playerId: String(s.playerId), type: s.type, value: s.value }; }) };
        }
      } catch (e) { }
    }, null);
    return 'subscribed';
  };

  /** 开局元信息：状态名表 / 玩家 / 地图 / 面板档位 / 依赖是否在 */
  G.meta = function () {
    var out = { vid: G.vantageId() };
    try { out.states = (typeof GameModel !== 'undefined' && GameModel._STATES) ? GameModel._STATES : null; }
    catch (e) { out.statesErr = String((e && e.message) || e); }
    try { out.players = __vtArr(GameManager.getGameController().getActivePlayerIds()); } catch (e) { }
    try {
      var mz = GameManager.getGameController().getMaze();
      out.maze = mz ? { w: mz.width, h: mz.height } : null;
    } catch (e) { }
    try { out.tb = VantageTestbench.getState().aiControl; } catch (e) { out.tbErr = String((e && e.message) || e); }
    try {
      out.has = { sandbox: typeof VantageSandbox !== 'undefined', observe: typeof VantageObserve !== 'undefined',
                  tree: typeof VantageTree !== 'undefined' && typeof VantageTree.getTree === 'function',
                  treeIface: typeof VantageTreeInterface !== 'undefined' };
      out.treeNull = (typeof VantageTree !== 'undefined' && VantageTree.getTree) ? (VantageTree.getTree() ? false : true) : 'n/a';
    } catch (e) { }
    return out;
  };

  function tankPose(gc, id) {
    try {
      var t = gc.getTank(id);
      if (!t) return null;
      return { x: +(+t.getX()).toFixed(3), y: +(+t.getY()).toFixed(3), rot: +(+t.getRotation()).toFixed(5),
               fire: (typeof t.getIsActive === 'function') ? !!t.getIsActive() : null };
    } catch (e) { return null; }
  }

  function fnv1a(arr, h) {
    for (var i = 0; i < arr.length; i++) { h ^= (arr[i] | 0); h = (h * 16777619) >>> 0; }
    return h;
  }
  function fnv2(arr, h) {
    for (var i = 0; i < arr.length; i++) {
      var row = arr[i];
      for (var j = 0; j < row.length; j++) { h ^= (row[j] | 0); h = (h * 16777619) >>> 0; }
    }
    return h;
  }

  G.step = function (nodeId) {
    var gc = GameManager.getGameController();
    // ① 决策回填：上一帧策略给的 nodeId（A=生长位置 / B=路线目标，契约同 inject_sarl2）
    if (nodeId !== null && nodeId !== undefined && nodeId >= 0) {
      var picks = [{ nodeId: nodeId, back: 0 }];              // picks[0] = 路线目标（A 相位=生长位置）
      if (G.fire) {
        // picks[1..] = 射击帧。树按 `path[i].id === pick.nodeId` 定位执行帧 ⟹ 必须给【路线上真实存在的节点 id】。
        // 给【根】节点 + back 超大（被钳到 L-1）⟹ 执行帧 = 0 = 路线首帧。
        var rt = null; try { var _t = VantageTree.getTree(); rt = _t && _t.root ? _t.root.id : null; } catch (eR) { }
        if (rt !== null && rt !== undefined) picks.push({ nodeId: rt, back: 1e9 });
      }
      G.bundleA = { picks: picks, memory: {} };
      G.bundleB = G.bundleA;
    }
    G.n++;
    var out = { f: G.n, r: null, err: null };
    try {
      var vid = G.vantageId();
      if (!vid) { out.err = 'no-vantage-manager'; return JSON.stringify(out); }
      out.vid = vid;
      var players = __vtArr(gc.getActivePlayerIds());
      out.players = players;
      out.kills = G.kills.slice();
      out.state = gc.getState();
      out.roundId = gc.getRoundId();

      // ② 我方坦克（adapter 缓存：同 id 复用）
      if (!G.ad || G.adId !== vid) { G.ad = VantageSandbox.createAdapter(gc, vid); G.adId = vid; }
      var e = VantageObserve.encode({ adapter: G.ad, tree: VantageTree.getTree(),
                                      horizonSec: 10, K_death: 1, frameDt: 1 / 60 });

      var nTok = (e.nodes && e.nodes.tokens) || [];
      var gArr = (e.global && e.global.globalTok) || [];
      var oppArr = (e.global && e.global.oppTok) || [];
      var bulArr = (e.bullets && e.bullets.tokens) || [];
      out.N = nTok.length;
      out.dims = { NODE_DIM: e.nodes ? e.nodes.dim : null, globalTok: gArr.length, oppTok: oppArr.length,
                   bulletRows: bulArr.length, bulletW: bulArr.length ? bulArr[0].length : null,
                   nNodeRows: nTok.length, nodeW: nTok.length ? nTok[0].length : null,
                   nodeStat: (e.nodes && e.nodes.stat) ? e.nodes.stat : null,
                   bulletStat: (e.bullets && e.bullets.stat) ? e.bullets.stat : null };
      if (e.nodes && e.nodes.err) out.nodeEncErr = e.nodes.err;
      if (!nTok.length || !gArr.length) {
        // 树还没建（回合创建前）⟹ 不做假动作，显式标记
        out.r = { nRows: 0 };
        return JSON.stringify(out);
      }
      // ③ 哈希：对【实际上行的那三段的每个数】做 FNV-1a（变了就说明载荷真的变了）
      var h = 2166136261 >>> 0;
      h = fnv2(nTok, h); h = fnv1a(gArr, h); h = fnv1a(oppArr, h);

      // ④ 双方位姿 + 弹丸归属 + 武器开火数（G1 判据的原始证据）
      var pl = {}, projBy = {}, wep = {};
      for (var i = 0; i < players.length; i++) pl[players[i]] = tankPose(gc, players[i]);
      var d = __vtData(gc.getRoundState()) || {};
      var ps = d.projectileStates || [];
      for (var k = 0; k < ps.length; k++) { var o = String(ps[k].playerId); projBy[o] = (projBy[o] || 0) + 1; }
      var wss = d.weaponStates || [];
      for (var w = 0; w < wss.length; w++) {
        var f = {}; try { f = JSON.parse(wss[w].fieldsJSON || '{}'); } catch (eW) { }
        wep[String(wss[w].playerId)] = { type: wss[w].type,
          fired: (f._bulletsFired === undefined ? null : f._bulletsFired),
          num: (f._numBullets === undefined ? null : f._numBullets) };
      }
      out.pl = pl; out.projBy = projBy; out.projN = ps.length; out.wep = wep;
      // ⑤-b 树/输入侧证据：
      //   · sub    = VantageAIManager【每帧无条件提交】给 setInputState 的那 5 个键（真实提交物）
      //   · tv     = 树的提交节点（commitNode）与进度
      try {
        var mgr = null, ms2 = AIs.aiManagers || [];
        for (var q = 0; q < ms2.length; q++) if (ms2[q] && ms2[q].isVantage) { mgr = ms2[q]; break; }
        if (mgr && mgr.storedStates) out.sub = { f: !!mgr.storedStates.forward, b: !!mgr.storedStates.back,
          l: !!mgr.storedStates.left, r: !!mgr.storedStates.right, fire: !!mgr.storedStates.fire };
        var tv = VantageTree.getTree();
        if (tv) {
          var cn = tv.commitNode;
          out.tv = { nodeCount: tv.nodeCount, commitId: cn ? cn.id : null,
            commitFrame: tv.commitFrame, commitProgress: +(+tv.commitProgress).toFixed(3),
            depth: tv.commitPath ? tv.commitPath.length : null,
            commitIsRoot: cn ? (cn.parent === null || cn.parent === undefined) : null };
        } else out.tv = null;
      } catch (eT) { out.treeErr = String((eT && eT.message) || eT); }
      try {
        var IS = window.__vantageIface;
        if (IS) out.iface = { calls: IS.calls, callsA: IS.callsA, callsB: IS.callsB, rejected: IS.rejected,
          giveUpA: IS.giveUpA, giveUpB: IS.giveUpB, skipped: IS.skipped, collected: IS.collected };
      } catch (eI) { }
      out.h = h >>> 0;
      out.r = { nRows: nTok.length, tok: 1 };
      // ⑤ 交给 Node 的载荷：node(T 行×10) / opp(1 行×15) / global(1 行×38)
      out.segs = { node: nTok, opp: [oppArr], global: [gArr] };
      out.payloadN = nTok.length;
      return JSON.stringify(out);
    } catch (e) {
      out.err = String((e && e.stack) || e);
      return JSON.stringify(out);
    }
  };

  window.__probe = G;
  return 'installed';
})()
