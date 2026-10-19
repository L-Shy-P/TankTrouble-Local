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
             // ⭐ 2026-10-19：树自己的契约就是「拒绝该射击帧（B 帧内重试）」
             //   （`agentFireSelfHitCheck` 与 `picks[#] 不在路线上` 都会让 agentSeam 带着 reason 重新要一包）。
             //   ⇙ 重试时**只丢射击帧**，`picks[0]`（= B 的选路）一个字不动 ⇙ 合法的路线被接受、
             //   违法的那一帧不开火（而不是让整个 B 决策作废 ⇙ 坦克退化成静止）。
             decide: function (ctx, retry) {
               var b = (tag === 'B' ? G.bundleB : G.bundleA);
               if (!b) return null;
               if (retry && retry.reason && /(自杀|不在路线上|越界)/.test(String(retry.reason))
                   && b.picks && b.picks.length > 1) {
                 G.fireDropN = (G.fireDropN || 0) + 1;
                 return { picks: [b.picks[0]], memory: {} };
               }
               return b;
             } };
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

  // ==========================================================================
  // ⭐⭐⭐ 2026-10-19 根因修复（本代理）：「B 决策被拒 ⟹ 坦克退化成静止」
  // --------------------------------------------------------------------------
  // 实测（修前，150 帧 1v1，探针 `_tools/perf/treefix_probe.js --tag=before2`）：
  //   · `G.mapNoTokN = 150/150`、`G.mapApplied = 0/150`
  //     ⟹ **行号→uid 映射从未生效**：旧代码在 `G.step` 顶部读 `nTok`，而 `var nTok`
  //       是本函数后半段才赋值的（var 提升）⟹ 那一刻永远是 `undefined`。
  //   · 于是 `picks[0]` 直接用了**原始行号**；行号 0..N-1 与节点 uid（单调递增）大量重合
  //     ⟹ `pickFound = 144/150` —— **96% 的帧里"被接受"的目标是个和网络选择无关的节点**
  //     （不是报错，是**静默改选**，比报错更坏）。
  //   · 又因为父代理的射击帧是照 `commitNode` 造的，而这个"蒙对"的目标几乎不在
  //     root→commitNode 的链上 ⟹ `checkBundleSemantics` 逐条命中
  //     **`B | picks[#] 不在路线上` = 303 次** ⟹ `giveUpB = 133/150`（89%）
  //     ⟹ `_agentRoute = null` ⟹ `getDesiredOperation()` 退回 `树:<commitNode 的 op>`
  //     ⟹ 主人看到的「树:静止」/「树:后左」等。
  // --------------------------------------------------------------------------
  // 本修复两条（都在【采集侧】，⛔ 一个字都没改树的判定，也⛔ 没改选）：
  //   ① `picks` 的构造**挪到观测编码之后**（`buildBundle()` 由 `G.step` 末尾调用）
  //      ⟹ 拿到本帧真正的 `nTok` ⟹ `uid = nTok[row][0]`（`NODE_FIELDS[0]='uid'`）。
  //   ② 射击帧：按树自己的游标口径算出**本帧执行帧**，只在那一帧（±1）上插
  //      （路线用**真树的 .parent/.children**求，L 用 `agentExecLenOf()` 同口径。
  //        v1 写成「整条路线每跳 [0,L) 全覆盖」实测被 `0帧自杀(炮口贴墙)` 拒了 210 次。）
  //   ③ 若那一帧真的炮口贴墙，树会拒掉这一包；桥接层按树自己的契约
  //      「拒绝该射击帧（B 帧内重试）」**只丢射击帧、保留 picks[0]**。
  // ==========================================================================
  /** 树侧 `agentExecLenOf()` 的只读复制（口径必须一致，否则 back 会越界）。 */
  function execLenOf(n) {
    if (!n) return 0;
    if (typeof n.validFrames === 'number' && n.validFrames > 0) return n.validFrames | 0;
    if (!n.fullDead) {
      var ev = (typeof VantageTree !== 'undefined' && typeof VantageTree.EVAL_FRAMES === 'number') ? VantageTree.EVAL_FRAMES : 75;
      return Math.max(1, Math.round(ev));
    }
    return (typeof n.fullDeathFrame === 'number' && n.fullDeathFrame >= 2) ? (n.fullDeathFrame - 1) : 0;
  }

  /**
   * 在【真树】里求 root→uid 的链（用真的 `.parent`/`.children`，不用观测的 parentIdx）。
   * 为什么：树每帧会重根/抛缩（collapse/rebase），观测 token 的 parentIdx 只代表【编码那一刻】；
   * 而 `checkBundleSemantics` 用的是 `agentRoutePathOf()`（从 `tree.root` 顺 `.parent` 上溯）。
   * 返回 [root, …, uid]（含两端）；root 本身 / 不在 root 下 ⇙ null。
   */
  function routeChainOf(tree, uid) {
    if (!tree || !tree.root || uid === null || uid === undefined) return null;
    var root = tree.root;
    if (root.id === uid) return null;              // 目标 = root ⇙ 树侧 `agentRoutePathOf` 返回 null
    var stack = [[root, [root]]], guard = 0;
    while (stack.length && guard++ < 40000) {
      var it = stack.pop(), n = it[0], ch = it[1];
      if (n.id === uid) return ch;
      var kids = n.children || [];
      for (var i = kids.length - 1; i >= 0; i--) {
        if (!kids[i]) continue;
        stack.push([kids[i], ch.concat([kids[i]])]);
      }
    }
    return null;
  }

  /**
   * 造本帧 bundle。`row` = 上一帧策略给的【观测行号】；
   * `tokIn` = **策略当时看到的那份**观测（`G.prevTok`）。
   * ⛔ 不能用本帧的 nTok：树每帧都可能长/缩，行号在两帧之间不稳定
   *   （实测：用本帧 nTok 时 `rowOutOfRange = 121/150`、`mapFallback = 122/150`）。
   * ⛔ 只做三件事：① 行号→uid；② 剪枝兜底（目标已不在活动树 ⟹ commitNode）；
   *    ③ 把「本帧要开火」翻译成一个**合法**的射击帧。
   * ⛔ **绝不改选**：目标永远是策略选的那一行对应的 uid（只有在它已经不存在/不可达时才兜底）。
   */
  function buildBundle(row, tokIn) {
    var tr = (typeof VantageTree !== 'undefined' && VantageTree.getTree) ? VantageTree.getTree() : null;
    var N = tokIn ? tokIn.length : 0;
    if (row === null || row === undefined || !(row >= 0)) return null;
    row = row | 0;
    var uid = row, mapped = false;
    if (N > 0 && tokIn[row] && typeof tokIn[row][0] === 'number') {
      uid = tokIn[row][0] | 0;                          // ★ NODE_FIELDS[0] = 'uid'
      mapped = true;
      G.mapApplied = (G.mapApplied || 0) + 1;
    } else if (N > 0) {
      G.rowOutOfRange = (G.rowOutOfRange || 0) + 1;     // 行号越界（树这帧变小了）
    } else {
      G.mapNoTokN = (G.mapNoTokN || 0) + 1;             // 本帧没有观测（树还没建/已重置）
    }

    // ---- 目标必须在【活动树】里并且能从 root 走到 ----
    //   `routeChainOf` 与树侧 `agentRoutePathOf()` 同口径（从 tree.root 顺 .parent 上溯）。
    //   为什么不能用观测 token 的 parentIdx 当路线：树每帧重根/坍缩/rebase，
    //   观测只代表【编码那一刻】的父子关系，而校验用的是【decision 那一刻】的真树。
    var inTree = false;
    try { if (tr && tr.walk) tr.walk(function (nd) { if (nd && nd.id === uid) inTree = true; }); } catch (eW) { }
    var rc = inTree ? routeChainOf(tr, uid) : null;
    if (inTree && !rc) G.routeUnreachable = (G.routeUnreachable || 0) + 1;   // 在树里但链断（目标=新根等）
    if (!inTree) G.pickNotFound = (G.pickNotFound || 0) + 1;
    if (!rc) {
      // 剪枝兜底（父代理做法，保留）：commitNode（一定在 root 下）→ root
      var cn = tr && tr.commitNode ? tr.commitNode : null;
      var rootN = tr && tr.root ? tr.root : null;
      if (cn && typeof cn.id === 'number') { uid = cn.id | 0; G.mapFallbackTo = 'commitNode'; }
      else if (rootN && typeof rootN.id === 'number') { uid = rootN.id | 0; G.mapFallbackTo = 'root'; }
      G.mapFallback = (G.mapFallback || 0) + 1;
      rc = routeChainOf(tr, uid);
    }
    if (rc) G.pickFound = (G.pickFound || 0) + 1;
    G.lastRowToUid = { row: row, uid: uid, mapped: mapped };
    G.lastChainLen = rc ? rc.length : 0;

    var picks = [{ nodeId: uid, back: 0 }];       // picks[0] = 路线目标（A 相位 = 生长位置）

    // ----------------------------------------------------------------------
    // 射击帧（只在 G.fire 为真的帧才发）
    //   历史两代都错，实测都是 B 被拒 ⟹ 坦克静止：
    //     · 父代：照 commitNode 整段 [0,L) ⟹ 与选中目标的路线无关
    //       ⟹ `picks[#] 不在路线上` 303 次（实测 before2）⟹ giveUpB 133/150
    //     · 本代 v1：整条路线每跳 [0,L) ⟹ 只要路线上任一帧「炮口贴墙」就整包被拒
    //       ⟹ `0帧自杀(炮口贴墙)` 210 次（实测 after2）
    //   ✅ 现在：按树自己的游标口径**精确算出本帧执行帧**，只在那一帧（±1）上插射击帧。
    //     口径照抄 `agentExecEnsure()`：新目标 ⟹ 游标 = commitNode 在新路线上的**尾帧**；
    //     commitNode 不在新路线上 ⟹ 0；路线**不含 root**；跑完 ⟹ 末帧。
    //     `back = L - (frame - hopStart) - 1`（`agentPickExecFrame` 的逆运算），必在 [0,L)。
    //   ⚠️ 若该帧本身「炮口贴墙」，树会拒绝 ⟹ 桥接层按树自己的契约
    //      「拒绝该射击帧（B 帧内重试）」只丢掉射击帧、**保留 picks[0]**（见 G.mk）。
    // ----------------------------------------------------------------------
    // ⭐ 2026-10-19 诊断：路线/游标/执行跳 **无论开不开火都算**，
    //   否则看不到「目标 op」与「真正执行的那一跳 op」的差异。
    {
      var added = 0, wantFrame = -1, wantHop = null, wantStart = 0;
      try {
        if (rc && rc.length > 1) {
          G.dbgTargetOp = (rc[rc.length - 1] && rc[rc.length - 1].opName) || '(?)';
          G.dbgTargetId = rc[rc.length - 1] ? rc[rc.length - 1].id : null;
          var hops = [], k;
          for (k = 1; k < rc.length; k++) hops.push({ id: rc[k].id | 0, L: Math.max(1, Math.min(512, execLenOf(rc[k]))) });
          var totalF = 0;
          for (k = 0; k < hops.length; k++) totalF += hops[k].L;
          if (hops.length && totalF > 0) {
            var startFrame = 0;
            var cmtId = (tr && tr.commitNode && typeof tr.commitNode.id === 'number') ? (tr.commitNode.id | 0) : null;
            if (cmtId !== null) {
              var acc = 0, found = false;
              for (k = 0; k < hops.length; k++) {
                acc += hops[k].L;
                if (hops[k].id === cmtId) { startFrame = acc; found = true; break; }
              }
              if (!found) startFrame = 0;              // commitNode 不在该路线上 ⟹ 从路线起点开始
            }
            wantFrame = (startFrame >= totalF) ? (totalF - 1) : startFrame;
            G.dbgHopsN = hops.length;
            G.dbgTotalF = totalF;
            G.dbgStartFrame = startFrame;
            var s2 = 0;
            for (k = 0; k < hops.length; k++) {
              if (wantFrame < s2 + hops[k].L) { wantHop = hops[k]; wantStart = s2; break; }
              s2 += hops[k].L;
            }
            if (wantHop) {
              G.dbgHopId = wantHop.id; G.dbgHopL = wantHop.L; G.dbgHopStart = wantStart;
              try { var _hn = null; tr.walk(function (nd) { if (nd && nd.id === wantHop.id) _hn = nd; });
                    G.dbgHopOp = _hn ? (_hn.opName || '(?)') : '(missing)'; } catch (eHO) { }
              var back = wantHop.L - (wantFrame - wantStart) - 1;
              if (back < 0) back = 0;
              if (back > wantHop.L - 1) back = wantHop.L - 1;
              // ±1 容错：同一目标连续两帧时树侧游标会 +1 滑动一格
              G.dbgBack = back;
              if (G.fire) {
                var seenB = {}, cands = [back - 1, back, back + 1];
                for (var ci = 0; ci < cands.length; ci++) {
                  var bb = cands[ci];
                  if (bb < 0 || bb > wantHop.L - 1) continue;
                  if (seenB[bb]) continue;
                  seenB[bb] = 1;
                  picks.push({ nodeId: wantHop.id, back: bb });
                  added++;
                }
              }
            }
          }
        }
      } catch (eFR) { G.fireErr = String((eFR && eFR.message) || eFR); }
      G.fireFrame = wantFrame; G.fireAdded = added;
      if (G.fire && !added) G.firePicksEmpty = (G.firePicksEmpty || 0) + 1;   // 诊断：想开火但没造出合法射击帧
      if (G.fire) G.firePicksN = (G.firePicksN || 0) + added;
    }
    return { picks: picks, memory: {} };
  }

  G.buildBundle = buildBundle;      // 只读调试钩子（探针可手动重放）

  G.step = function (nodeId) {
    var gc = GameManager.getGameController();
    // ① 决策回填**延迟**到观测编码之后（见上方 buildBundle 的注释①）：
    //    这里只记下"本帧要喂给树的行号"，真正的 picks 在 out.segs 造好之后构造。
    //    ⛔ 旧的实现在这里读 `nTok`，而 `var nTok` 是后面才赋值的（var 提升）⟹ 读到 undefined。
    var _pendRow = (nodeId !== null && nodeId !== undefined && nodeId >= 0) ? (nodeId | 0) : null;
    G.pendRow = _pendRow;
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
        // ⭐ 2026-10-19：这种帧也要把 bundle 造出来（无 nTok ⟹ 旧行为兼容），
        //   否则 A/B 会拿到 null ⟹ `重试超限(no-output)`。
        G.bundleA = buildBundle(_pendRow, G.prevTok || null);
        G.bundleB = G.bundleA;
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
      // ⭐⭐⭐ 2026-10-19 根因修复①：**在这里**才能拿到本帧真的 nTok
      //   （旧代码在函数开头读，var 提升 ⟹ 永远 undefined ⟹ 行号→uid 从未生效）。
      //   bundle 只会在接下来的 pump(1) 里被树消费 ⟹ 移到这里造不改变交付时机。
      G.bundleA = buildBundle(_pendRow, G.prevTok || null);   // 行号属于**上一帧上行的那份观测**
      G.bundleB = G.bundleA;
      G.prevTok = nTok;                      // ⭐ 下一帧要用它把策略的行号译回 uid
      out.picks0 = (G.bundleA && G.bundleA.picks && G.bundleA.picks.length) ? G.bundleA.picks[0].nodeId : null;
      out.picksN = (G.bundleA && G.bundleA.picks) ? G.bundleA.picks.length : 0;
      return JSON.stringify(out);
    } catch (e) {
      out.err = String((e && e.stack) || e);
      return JSON.stringify(out);
    }
  };

  window.__probe = G;
  return 'installed';
})()
