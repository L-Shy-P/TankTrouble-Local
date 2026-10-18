/**
 * G1 探针（页面侧）—— 让「Vantage 打 Laika」跑通一整局
 * ==========================================================================
 * 结构照抄 `inject_sarl2.js`（已是"起对局 + 每帧读观测 + 喂回决策"的完整循环），
 * 只改三类事：
 *   ① 适配器绑到【真正的 Vantage 玩家 id】（不再是写死的 'tank_a'）
 *   ② 观测按【完整 segs】上行（node / opp / bullet / item / global），并报出真实行数与各段宽度
 *      ⭐ 2026-10-17 审计修复（父代理最高优先）：此前只发 node/opp/global ⟹ **bullet/item 全零**
 *         ⟹ AI 在评测里看不见子弹 ⟹ `run_scenes_30` 的所有胜率一律不可信。
 *         现按采集器 `_collect_tmp.js:9-24` 的口径补齐：
 *           · bullet: (M,7)，M 为 0 时**发一行零**（⛔ 不能发 []，服务端要求二维）
 *           · item  : (8,6) = 该索引道具 3 维 + 地雷 3 维
 *           · opp   : 本文件只报 `oppBlocks/oppOver`；8 行展开由 `run_scenes_30.js:160-176` 做
 *                     （⚠️ 若这里就展开成 8 行，那边会拿 `segs.opp[0]` 再切一次 ⟹ 多对手被丢，属回归）
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

  // ==========================================================================
  // ⭐ 2026-10-18（奖励字段补齐）：**逐帧事件录**（只读导出，不改游戏逻辑）
  //   为什么必须走事件而不是"按格子猜"：`rewards.py` 要的 `hit`/`crate` 都有**游戏自己给出的归属**，
  //   比"我方格子里的道具消失了"这种推断准得多。四种事件（出处：`game_core/js/82e43ebf…js`
  //   的 RoundModel 事件分发 switch）：
  //     · `deadly` = `TANK_DEADLY_COLLISION`：坦克↔子弹接触。⚠️内核里它【必然】紧接着
  //                  `killTank(...)` + `destroyProjectile(...)`（同一个 case 分支、无 if）
  //                  ⟹ 这是"我方子弹命中对手"的**唯一真信号**，且**每次命中都致死**。
  //     · `pickup` = `COLLECTIBLE_DESTROYED`：道具被吃掉。`Pickup` 只带 `playerId/collectibleId`
  //                  ⟹ 归属由游戏自己给，不用按格子推。
  //     · `shield` = `PROJECTILE_SHIELD_COLLISION`：子弹打护盾（只反弹、不致死）。
  //     · `kill`   = `TANK_KILLED`（原有）。
  //   帧号 `n` 的口径：`G.n` 在 `G.step()` 开头自增，`pump(1)` 期间派发的事件带着"刚自增完"的 `n`
  //   ⟹ 采集侧取 `n <= G.n-1` 的事件，正好是【产生本帧状态】的那一次世界步。
  // ==========================================================================
  G.ev = []; G.evOut = 0; G.evOverflow = 0; G.evMax = 20000;
  function pushEv(o) { if (G.ev.length - G.evOut < G.evMax) { G.ev.push(o); } else { G.evOverflow++; } }
  function drainEv(upto) {
    var out = [];
    while (G.evOut < G.ev.length && G.ev[G.evOut].n <= upto) { out.push(G.ev[G.evOut]); G.evOut++; }
    if (G.evOut > 2048) { G.ev = G.ev.slice(G.evOut); G.evOut = 0; }   // 防无界增长（每帧都抽干，不会丢）
    return out;
  }
  G.drainEv = drainEv;
  function sid(x) { return (x === null || x === undefined) ? null : String(x); }

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
          pushEv({ n: G.n, k: 'kill',
            shooter: sid(data && data.getKillerPlayerId ? data.getKillerPlayerId() : null),
            victim: sid(data && data.getVictimPlayerId ? data.getVictimPlayerId() : null) });
        } else if (evt === RE.TANK_DEADLY_COLLISION) {
          pushEv({ n: G.n, k: 'deadly',
            victim: sid(data && data.tankA && typeof data.tankA.getPlayerId === 'function' ? data.tankA.getPlayerId() : null),
            shooter: sid(data && data.projectile && typeof data.projectile.getPlayerId === 'function' ? data.projectile.getPlayerId() : null),
            proj: sid(data && data.projectile && typeof data.projectile.getId === 'function' ? data.projectile.getId() : null),
            ptype: (data && data.projectile && typeof data.projectile.getType === 'function') ? data.projectile.getType() : null });
        } else if (evt === RE.COLLECTIBLE_DESTROYED) {
          var cid = sid(data && typeof data.getCollectibleId === 'function' ? data.getCollectibleId() : null);
          var ctp = null, cx = null, cy = null;
          try {
            var col = (cid && gc.getCollectible) ? gc.getCollectible(cid) : null;
            if (col) {
              if (typeof col.getType === 'function') ctp = col.getType();
              if (typeof col.getX === 'function') cx = col.getX();
              if (typeof col.getY === 'function') cy = col.getY();
            }
          } catch (eC) { }
          pushEv({ n: G.n, k: 'pickup',
            picker: sid(data && typeof data.getPlayerId === 'function' ? data.getPlayerId() : null),
            col: cid, ctype: ctp, x: cx, y: cy });
        } else if (evt === RE.PROJECTILE_SHIELD_COLLISION) {
          pushEv({ n: G.n, k: 'shield',
            shooter: sid(data && data.projectile && typeof data.projectile.getPlayerId === 'function' ? data.projectile.getPlayerId() : null),
            shieldOwner: sid(data && data.shieldA && typeof data.shieldA.getPlayerId === 'function' ? data.shieldA.getPlayerId() : null),
            proj: sid(data && data.projectile && typeof data.projectile.getId === 'function' ? data.projectile.getId() : null) });
        } else if (evt === RE.PROJECTILE_DESTROYED || evt === RE.PROJECTILE_TIMEOUT) {
          // 子弹"被销毁（击杀那一发）"/"正常超时" —— 只做客数交叉核对
          pushEv({ n: G.n, k: (evt === RE.PROJECTILE_TIMEOUT) ? 'ptimeout' : 'pdestroy', proj: sid(data) });
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
  // ⭐ 2026-10-18：把"算 `t_min`（子弹最短飞行帧数）要用的物理常数"一次报出来（⛔ 不写死在采集侧）
  //   出处：`game_core/js/b714588dc4621fe104113111ba90b1a7.js` `Constants.classFields({... BULLET:{RADIUS:{px:5,m:5/20},SPEED:{px:360,m:18},OFFSET:{px:50,m:2.5}} ... TANK:{HEIGHT:{px:80,m:4}} ...})`
  try {
    var C = (typeof Constants !== 'undefined') ? Constants : null;
    out.k = C ? {
      bulletSpeed: (C.BULLET && C.BULLET.SPEED) ? C.BULLET.SPEED.m : null,      // 米/秒
      bulletOffset: (C.BULLET && C.BULLET.OFFSET) ? C.BULLET.OFFSET.m : null,  // 炮口离坦克中心（米）
      bulletRadius: (C.BULLET && C.BULLET.RADIUS) ? C.BULLET.RADIUS.m : null,
      tankHalfH: (C.TANK && C.TANK.HEIGHT) ? (C.TANK.HEIGHT.m / 2) : null,     // 坦克半高（米）
      tileM: (C.MAZE_TILE_SIZE && C.MAZE_TILE_SIZE.m) ? C.MAZE_TILE_SIZE.m : null
    } : null;
  } catch (eK) { out.kErr = String((eK && eK.message) || eK); }
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

  // ============================================================
  // ⭐ 2026-10-17 审计修复：段构造（口径照抄 `_collect_tmp.js:9-24` 的 oppRows/itemRows/pad）
  //   bullet: (M,7)，M=0 时发一行零（⛔ 不能发 []，服务端要求二维）
  //   item  : (8,6) = 该索引道具 3 维 + 地雷 3 维
  //   mem   : `mem_on=0` 不发（服务端恒零）；`mem_on=1` 发上一帧 `mem_echo`（4×256）
  // ============================================================
  var BULLET_SLOTS = 64, BULLET_W = 7, OPP_W = 15, OPP_SLOTS = 8, ITEM_ROWS = 8, ITEM_W = 6;
  G.memOn = 0; G.lastMemEcho = null;
  G.setMem = function (v) { G.memOn = v ? 1 : 0; return G.memOn; };
  G.setMemEcho = function (rows) { G.lastMemEcho = rows || null; return G.lastMemEcho ? G.lastMemEcho.length : 0; };

  function zeroRow(w) { var r = []; for (var i = 0; i < w; i++) r.push(0); return r; }
  function padRows(rows, slots, w, atLeastOne) {
    var out = [];
    for (var i = 0; i < (rows || []).length && out.length < slots; i++) {
      var r = rows[i] || [], o = [];
      for (var j = 0; j < w; j++) o.push((typeof r[j] === 'number' && isFinite(r[j])) ? r[j] : (+r[j] || 0));
      out.push(o);
    }
    if (!out.length && atLeastOne) out.push(zeroRow(w));
    while (out.length < slots) out.push(zeroRow(w));
    return out;
  }
  function buildItemRows(colTok, mineTok) {
    var out = [];
    for (var k = 0; k < ITEM_ROWS; k++) {
      var c = (colTok || []).slice(k * 3, k * 3 + 3), m = (mineTok || []).slice(k * 3, k * 3 + 3);
      out.push([+c[0] || 0, +c[1] || 0, +c[2] || 0, +m[0] || 0, +m[1] || 0, +m[2] || 0]);
    }
    return out;
  }

  G.step = function (nodeId) {
    var gc = GameManager.getGameController();
    // ① 决策回填：上一帧策略给的 nodeId（A=生长位置 / B=路线目标，契约同 inject_sarl2）
    if (nodeId !== null && nodeId !== undefined && nodeId >= 0) {
      // ⭐⭐⭐ 2026-10-18 根因修复（本代理）：**行号 → uid 映射**。
      //   服务端返回的 `nodeId` 是【观测节点 token 的行号】，而 `VantageTree.findNodeById` 找的是【节点的 uid】。
      //   两者不相等 ⟹ 每帧 `B:重试超限(picks[0] 节点编号不存在)` ⟹ 树的 `_agentRoute` 永远是 null
      //   ⟹ `getDesiredOperation()` 恒返回「树:静止」⟹ 坦克不动、不开枪、打不死靶（实测 giveUpB=145/120 帧）。
      //   ✅ 正解同 `inject_fire.js:264`：uid = 节点 token 第 0 位（NODE_FIELDS[0]='uid'）。
      //   ⚠️ 训练侧的 `act.nodeId` 仍记【行号】（策略分布要按行索引），只有喂给树的才换成 uid。
      var _row = nodeId | 0;
      var _uid = _row;
      try {
        if (nTok && nTok[_row] && typeof nTok[_row][0] === 'number') _uid = nTok[_row][0] | 0;
      } catch (eMap) { G.mapErr = String((eMap && eMap.message) || eMap); }
      // ⭐⭐⭐ 2026-10-18（本代理）：**剪枝兜底** —— 树每帧会重根/剪枝，上帧的节点这帧可能已经不存在。
      //   面板侧同样的处理（`vantage_agent_panel.js:644-650`：nSlots 无效 ⟹ prevNodeId=0 复用 slot 路径）。
      //   ⛔ 不做兜底 ⟹ 每帧 `B:重试超限(picks[0] 节点编号不存在)` ⟹ 树永远静止（实测 giveUpB=225/200 帧）。
      //   ✅ 做法：uid 在树里找不到 ⟹ 退回 **当前 commitNode**（它一定存在），再不行退回根。
      try {
        var _tr0 = (typeof VantageTree !== 'undefined' && VantageTree.getTree) ? VantageTree.getTree() : null;
        var _found = false;
        if (_tr0 && _tr0.walk) { try { _tr0.walk(function (nd) { if (nd && nd.id === _uid) { _found = true; } }); } catch (eW2) {} }
        if (!_found) {
          var _cn = _tr0 && _tr0.commitNode ? _tr0.commitNode : null;
          if (_cn && typeof _cn.id === 'number') { _uid = _cn.id | 0; G.mapFallback = (G.mapFallback || 0) + 1; G.mapFallbackTo = 'commitNode'; }
          else if (_tr0 && _tr0.root && typeof _tr0.root.id === 'number') { _uid = _tr0.root.id | 0; G.mapFallback = (G.mapFallback || 0) + 1; G.mapFallbackTo = 'root'; }
        }
      } catch (eFb) { G.mapFallbackErr = String((eFb && eFb.message) || eFb); }
      G.lastRowToUid = { row: _row, uid: _uid };
      var picks = [{ nodeId: _uid, back: 0 }];              // picks[0] = 路线目标（A 相位=生长位置）—— ✅ 用 uid
      if (G.fire) {
        // ⭐⭐⭐ 父代理 2026-10-18 根因修复：原实现只发 `{nodeId: root, back: 1e9}`
        //   ⟹ `agentPickExecFrame` 把 back 钳到 L-1 ⟹ execFrame = start(root)+0 = **0**
        //   ⟹ 只有"游标恰好=0"时命中 ⟹ **实测 50 局 ammoLeft 恒 5 ⟹ 一枪未放**（60~70% 的胜率全是熬到对手自爆）。
        //   正解：射击帧要覆盖【commitNode 这一整段】——`agentExecEnsure` 新目标时把游标置为
        //        commitNode 段起点 + 段内已过帧 ⟹ 游标必在 commitNode 段内 ⟹ 覆盖该段 [0,L) 必命中。
        try {
          var _t = VantageTree.getTree();
          var _cmt = _t && _t.commitNode ? _t.commitNode : null;
          if (_cmt && typeof _cmt.id === 'number' && _cmt.id >= 0) {
            var _L = 1;
            if (typeof _cmt.segmentFrames === 'number' && _cmt.segmentFrames > 0) _L = _cmt.segmentFrames | 0;
            else if (typeof _cmt.tEndSec === 'number' && typeof _cmt.tStartSec === 'number')
              _L = Math.max(1, Math.round((_cmt.tEndSec - _cmt.tStartSec) / 0.02));
            for (var _b = 0; _b < _L; _b++) picks.push({ nodeId: _cmt.id, back: _b });
            G.firePicksN = (G.firePicksN || 0) + _L; G.fireCommitId = _cmt.id; G.fireCommitL = _L;
          }
        } catch (eR) { G.fireErr = String((eR && eR.message) || eR); }
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
      var colArr = (e.global && e.global.colTok) || [];
      var mineArr = (e.global && e.global.mineTok) || [];
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
      var itemSeg = buildItemRows(colArr, mineArr);
      var bulletSeg = padRows(bulArr, BULLET_SLOTS, BULLET_W, true);
      var oppBlocks = Math.floor(oppArr.length / OPP_W);
      if (oppBlocks * OPP_W !== oppArr.length) out.oppErr = 'oppTok 长度 ' + oppArr.length + ' 不是 ' + OPP_W + ' 的整数倍（拒绝猜块边界）';
      if (oppBlocks > OPP_SLOTS) { G.oppOver = (G.oppOver || 0) + 1; out.oppOver = G.oppOver; }
      out.oppBlocks = oppBlocks;

      // ⭐ 哈希：对【实际上行的全部段】的每个数做 FNV-1a（变了就说明载荷真的变了）
      var h = 2166136261 >>> 0;
      h = fnv2(nTok, h); h = fnv1a(gArr, h); h = fnv1a(oppArr, h);
      h = fnv2(bulletSeg, h); h = fnv2(itemSeg, h);

      // ④ 双方位姿 + 弹丸归属 + 武器开火数（G1 判据的原始证据）
      var pl = {}, projBy = {}, wep = {};
      for (var i = 0; i < players.length; i++) pl[players[i]] = tankPose(gc, players[i]);
      var d = __vtData(gc.getRoundState()) || {};
      var ps = d.projectileStates || [];
      for (var k = 0; k < ps.length; k++) { var o = String(ps[k].playerId); projBy[o] = (projBy[o] || 0) + 1; }
      // ⭐ 2026-10-18：**子弹每帧走多少米（`mper`）**——`t_min`（最短飞行帧数）的口径要用它。
      //   主口径 `mperSpeed` = **我当前这颗子弹的速度(m/s) × 每帧秒数**：
      //     · 速度：`projectileStates[].speedX/speedY`（游戏自己给，米/秒，实测 BULLET=18.0）
      //     · 每帧秒数：页面虚拟时钟自报的 `window.__vt.dt`（`_tools/headless/clock.js:14` `const DT = 1000/60`）
      //       ⟹ 18 × (16.667/1000) = 0.3000 米/帧
      //   交叉核对 `mperMineDisp` = 同一颗子弹相邻两帧的位移（实测 0.2999，见报告）——只做核对，不参与取值。
      //   ⚠️ 不同武器速度差很多（BULLET 18 / LASER 180 / SHOTGUN 30~35）⟹ 优先用【我方】子弹的速度；
      //      我方这帧没子弹时才退到"场上任意子弹"（并在 `mperFrom` 里标明来源）。
      var prevProj = G.lastProj || {};
      var projNow = {}, nShared = 0;
      var mperDispAll = null, mperMineDisp = null, spdMine = null, spdAny = null;
      for (var pk = 0; pk < ps.length; pk++) {
        var pj = ps[pk];
        if (!pj || typeof pj.x !== 'number' || typeof pj.y !== 'number') continue;
        var pidS = String(pj.id);
        var bMine = (String(pj.playerId) === String(vid));
        projNow[pidS] = [pj.x, pj.y];
        var spd = Math.sqrt((pj.speedX || 0) * (pj.speedX || 0) + (pj.speedY || 0) * (pj.speedY || 0));
        if (isFinite(spd) && spd > 0) {
          if (spdAny === null || spd > spdAny) spdAny = spd;
          if (bMine && (spdMine === null || spd > spdMine)) spdMine = spd;
        }
        var pv = prevProj[pidS] || null;
        if (pv) {
          var dm = Math.sqrt((pj.x - pv[0]) * (pj.x - pv[0]) + (pj.y - pv[1]) * (pj.y - pv[1]));
          if (isFinite(dm)) {
            nShared++;
            if (mperDispAll === null || dm > mperDispAll) mperDispAll = dm;
            if (bMine && (mperMineDisp === null || dm > mperMineDisp)) mperMineDisp = dm;
          }
        }
      }
      var dtMs = null;
      try { if (window.__vt && typeof window.__vt.dt === 'number' && window.__vt.dt > 0) dtMs = window.__vt.dt; } catch (eDT) { }
      if (dtMs === null) {
        try { var _g2 = GameManager.getGame(); if (_g2 && _g2.time && typeof _g2.time.physicsElapsedMS === 'number') dtMs = _g2.time.physicsElapsedMS; } catch (eDT2) { }
      }
      var mperSpeed = null, mperFrom = null;
      if (dtMs !== null && dtMs > 0) {
        if (spdMine !== null) { mperSpeed = spdMine * dtMs / 1000; mperFrom = 'mine:speed'; }
        else if (spdAny !== null) { mperSpeed = spdAny * dtMs / 1000; mperFrom = 'any:speed'; }
      }
      G.lastProj = projNow;
      var wss = d.weaponStates || [];
      for (var w = 0; w < wss.length; w++) {
        var f = {}; try { f = JSON.parse(wss[w].fieldsJSON || '{}'); } catch (eW) { }
        wep[String(wss[w].playerId)] = { type: wss[w].type,
          fired: (f._bulletsFired === undefined ? null : f._bulletsFired),
          num: (f._numBullets === undefined ? null : f._numBullets) };
      }
      out.pl = pl; out.projBy = projBy; out.projN = ps.length; out.wep = wep;
      out.mper = mperSpeed; out.mperFrom = mperFrom; out.mperN = nShared;   // 米/帧（主口径：子弹速度×每帧秒数）
      out.mperMineDisp = mperMineDisp;                                       // 米/帧（交叉核对：我方子弹相邻帧位移）
      out.mperDispAll = mperDispAll;                                         // 米/帧（交叉核对：场上任意子弹位移）
      out.dtMs = dtMs; out.spdMine = spdMine; out.spdAny = spdAny;
      // ⭐ 逐帧事件（只读）：本帧状态由 `pump` 里 `G.n-1` 那一步产生，故取 `n <= G.n-1`
      out.ev = drainEv(G.n - 1);
      out.evOverflow = G.evOverflow;
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
      // ⑤ 交给 Node 的载荷：node(T×10) / opp(1 行 flat，由 run_scenes_30 展成 8 行) / bullet(64×7) / item(8×6) / global(1×38)
      //   ⭐ bullet 行数 = 场上真实子弹数（M=0 时是 1 行零）；`segRows` 把真实行数报给 Node 侧做验收
      out.segs = { node: nTok, opp: [oppArr], bullet: bulletSeg, item: itemSeg, global: [gArr] };
      out.segRows = { node: nTok.length, opp: oppBlocks, oppSentRows: 1, bullet: (bulArr || []).length, bulletSentRows: bulletSeg.length,
                      item: ITEM_ROWS, global: 1 };
      out.segDims = { node: nTok.length ? nTok[0].length : null, opp: OPP_W, bullet: BULLET_W, item: ITEM_W, global: gArr.length };
      out.bulletSample = (bulArr || []).slice(0, 2);      // ⭐ 硬证据：bullet 段真的承载了子弹（不是全零）
      out.itemNonZero = itemSeg.reduce(function (n, r) { for (var i = 0; i < r.length; i++) if (r[i]) n++; return n; }, 0);
      if (G.memOn && G.lastMemEcho) { out.segs.mem = G.lastMemEcho; out.memSent = G.lastMemEcho.length; }   // mem_on=1 才发
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
