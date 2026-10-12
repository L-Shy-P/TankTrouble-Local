'use strict';
/* 页面内录制/回放源码（由 match.js 在【所有页面脚本之前】注入）
 * 说明见 record.js 头部。这里只放浏览器里跑的代码。
 */
const VERSION = 4;   // v4: hs 拆成 hs(决定性,硬FAIL)+hx(观测性,仅信息); v3: drive; v2: hs/boot/vtEpoch/sites

const PAGE_SRC = `
(() => {
  'use strict';
  if (window.__vtRec) return;

  var VERSION = ${VERSION};
  // 与 game_core/js/vantage_sandbox.js:584 的 OPERATIONS 同名同序（9 种操作）
  var OP_NAMES = ['静止', '前', '后', '左', '右', '前左', '前右', '后左', '后右'];

  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }
  var NL = String.fromCharCode(10);
  /** 随机数【消费计数】：record 模式看 len（已记录条数），play 模式看 idx（已吐回条数） */
  function rngCount() {
    try {
      var s = window.__vtRng.state();
      if (s.calls !== undefined && s.calls !== null) return s.calls;   // ★ 总调用次数（分流模式也算得准）
      return (s.mode === 'play') ? s.idx : s.len;
    } catch (e) { return null; }
  }   // 换行符（这里不用转义写法：外层是模板字符串，转义会被提前解掉）
  function recHash() { return fnv1a(rec.frames.join(NL)); }
  function data(x) { return (x && x.data) ? x.data : x; }
  function gcNow() { try { return window.GameManager.getGameController(); } catch (e) { return null; } }
  function arr(x) {
    if (!x) return [];
    if (Array.isArray(x)) return x;
    if (typeof x.toArray === 'function') { try { return x.toArray(); } catch (e) {} }
    if (typeof x.values === 'function') { try { return [].slice.call(x.values()); } catch (e) {} }
    var out = [], ks = Object.keys(x);
    for (var i = 0; i < ks.length; i++) { var v = x[ks[i]]; if (v && typeof v === 'object') out.push(v); }
    return out;
  }
  function copy(x) { try { return JSON.parse(JSON.stringify(x)); } catch (e) { return null; } }

  /**
   * ★ 读「真模型」而不是 RoundModel 的缓存（2026-10-11 实测坑）：
   *   RoundModel.getRoundState() 会把结果缓存进 cachedRoundState，而 _removeDestroyed()
   *   删坦克时【不清缓存】⟹ 同一帧读到的 roundState 可能还带着已经删掉的坦克/武器。
   *   实测：record 读到"已清理"，replay 读到"旧的带死坦克状态"，rn 完全相同却 FAIL。
   *   这里在采样前把缓存清掉（只是让 getRoundState 重建，不改模型数据），
   *   采样反映的是模型真值。
   */
  function freshRoundData() {
    var gc = gcNow(); if (!gc) return null;
    try {
      var rc = gc.roundController;
      if (rc && rc.model && ('cachedRoundState' in rc.model)) rc.model.cachedRoundState = null;
    } catch (e) {}
    return data(gc.getRoundState());
  }

  /** 四个按键 → 0..8 槽位（顺序 = sandbox OPERATIONS；与 rollout_worker 的 __vtAct 一致） */
  function opIndex(t) {
    var f = !!t.forward, b = !!t.back, l = !!t.left, r = !!t.right;
    if (f && l && !r) return 5;
    if (f && r && !l) return 6;
    if (b && l && !r) return 7;
    if (b && r && !l) return 8;
    if (f) return 1;
    if (b) return 2;
    if (l) return 3;
    if (r) return 4;
    return 0;
  }

  /** 逐帧坦克记录：数据源 = 游戏自己的 roundState.tankStates（含对手 AI） */
  function readTanks(d) {
    var gc = gcNow(); if (!gc) return [];
    d = d || freshRoundData() || {};
    var tss = arr(d.tankStates);
    var out = [];
    for (var i = 0; i < tss.length; i++) {
      var t = tss[i];
      var id = t.playerId;
      var op = opIndex(t);
      out.push({
        id: id,
        alive: !!gc.getTank(id),
        x: t.x, y: t.y, rot: t.rotation,
        fwd: !!t.forward, back: !!t.back, left: !!t.left, right: !!t.right,
        fire: !!t.fireDown,
        op: op, opName: OP_NAMES[op], action: op + (t.fireDown ? 9 : 0)
      });
    }
    out.sort(function (a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });
    return out;
  }

  function readProjectiles(d) {
    var gc = gcNow(); if (!gc) return [];
    d = d || freshRoundData() || {};
    var ps = arr(d.projectileStates);
    var out = [];
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      out.push({ id: p.id, owner: p.playerId, x: p.x, y: p.y, rot: p.rotation, type: p.type });
    }
    out.sort(function (a, b) { return String(a.id) < String(b.id) ? -1 : (String(a.id) > String(b.id) ? 1 : 0); });
    return out;
  }

  function makeFrame(f) {
    var gc = gcNow();
    var d = freshRoundData() || {};   // 一帧只重建一次，三个读取器共用
    var hState = hiddenState(d);      // 一次采样，拆成决定性/观测性两份（别采样两次）
    return {
      k: 'frame', f: f,
      t: Math.round((window.__vt.t - rec.t0) * 1000) / 1000,   // 相对虚拟时间(ms, 3位小数); 绝对量随资产加载帧数漂移，且浮点累加末位不稳
      rn: rngCount(),                // 随机数消费计数（对齐诊断：两遍回放应当逐帧相同）
      st: gc ? gc.getState() : null,
      tanks: readTanks(d),
      projs: readProjectiles(d),
      drive: (window.__vtDrive && window.__vtDrive.lastApplied) ? window.__vtDrive.lastApplied : null,   // ★ 本帧实际施加的输入
      hs: hState.det,                // ★ 决定性隐藏哨兵：不一致 = 硬 FAIL
      hx: hState.obs                 // ☆ 观测性/环境相关：不一致 = 信息项，不参与 PASS/FAIL
    };
  }

  // ==================== ★ 隐藏状态哨兵（2026-10-11） ====================
  // 为什么加：1200 帧 12 次里有 2 次「rn 全程相同但回合相位不同」——可见字段全同、
  // 隐藏状态不同。这里把「帧记录没覆盖、但会影响后续物理/相位」的东西逐帧记下来：
  //   · Box2D body 数 + 位置/线速/角速 的量化哈希（接触/速度分歧在这里现形）
  //   · Phaser game.rnd 的种子状态（第二个 RNG，__vtRng 完全没接管它）
  //   · QualityManager（它的 quality 决定爆炸碎片数 15/7，直接改变 Math.random 消费量）
  //   · AIs.aiManagers、武器状态、道具数、回合 ID
  function mix32(h, x) {
    h = (h ^ (x & 0xffff)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
    h = (h ^ ((x >>> 16) & 0xffff)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
    return h >>> 0;
  }
  function bodySentinel() {
    var gc = gcNow(); if (!gc || !gc.getB2DWorld) return null;
    var w = null; try { w = gc.getB2DWorld(); } catch (e) { return null; }
    if (!w || !w.GetBodyList) return null;
    var h = 0x811c9dc5, n = 0;
    try {
      var b = w.GetBodyList(), guard = 0;
      while (b && guard++ < 5000) {
        n++;
        var p = (b.GetPosition ? b.GetPosition() : (b.m_xf ? b.m_xf.position : null));
        var v = (b.GetLinearVelocity ? b.GetLinearVelocity() : b.m_linearVelocity);
        var av = (b.GetAngularVelocity ? b.GetAngularVelocity() : b.m_angularVelocity);
        if (p) { h = mix32(h, Math.round(p.x * 1000)); h = mix32(h, Math.round(p.y * 1000)); }
        if (v) { h = mix32(h, Math.round(v.x * 1000)); h = mix32(h, Math.round(v.y * 1000)); }
        if (typeof av === 'number') h = mix32(h, Math.round(av * 1000));
        // sweep：上一帧 transform / localCenter（接触求解的 warm start 会读它）
        var sw = b.m_sweep;
        if (sw) {
          if (sw.c) { h = mix32(h, Math.round(sw.c.x * 1000)); h = mix32(h, Math.round(sw.c.y * 1000)); }
          if (sw.c0) { h = mix32(h, Math.round(sw.c0.x * 1000)); h = mix32(h, Math.round(sw.c0.y * 1000)); }
          if (typeof sw.a === 'number') h = mix32(h, Math.round(sw.a * 1000));
          if (typeof sw.a0 === 'number') h = mix32(h, Math.round(sw.a0 * 1000));
        }
        b = (b.GetNext ? b.GetNext() : b.m_next);
      }
      // 接触流形 / 冲量（warm starting）
      var c = w.m_contactList, cn = 0;
      while (c && cn < 500) {
        cn++;
        var man = c.m_manifold;
        if (man) {
          h = mix32(h, man.m_pointCount | 0);
          if (man.m_normal) { h = mix32(h, Math.round(man.m_normal.x * 1000)); h = mix32(h, Math.round(man.m_normal.y * 1000)); }
          var pts = man.m_points || [];
          for (var qi = 0; qi < pts.length; qi++) {
            h = mix32(h, Math.round((pts[qi].normalImpulse || 0) * 1000));
            h = mix32(h, Math.round((pts[qi].tangentImpulse || 0) * 1000));
          }
        }
        c = c.m_next;
      }
      h = mix32(h, cn); h = mix32(h, w.m_contactCount | 0);
    } catch (e) { return { n: -1, h: -1, err: String((e && e.message) || e) }; }
    return { n: n, h: h >>> 0, c: (w.m_contactCount | 0) };
  }
  // ★ 观测性字段白名单（2026-10-12）：这些【不是游戏逻辑】，只反映"这一次跑的环境/循环状态"。
  //   q  = QualityManager.avgFps/numFpsSamples：真实帧率均值/采样数（环境相关）
  //   pg = Phaser _deltaTime/updatesThisFrame/time.now/elapsed：主循环累加器（与启动时机有关）
  //   tf = __vtStats().timerFires：本 harness 的 timer 累计触发数（与 boot 期调度有关）
  //   lu = gc.lastUpdate：墙钟 Date（观测量，不是游戏状态）
  //   其余全部进 hs（决定性）：rc/th/wpn/col/rnd/ai/b2d/raw/err 及未来新增字段默认决定性。
  var OBSERVATIONAL_KEYS = { q: 1, pg: 1, tf: 1, lu: 1 };

  function hiddenState(d0) {
    var out = {};
    var d = d0 || freshRoundData() || {};
    try {
      var gc = gcNow();
      out.rc = gc ? gc.getRoundId() : null;
      var mz = gc ? gc.getMaze() : null;
      out.th = (mz && mz.getTheme) ? mz.getTheme() : null;
      var ws = arr(d.weaponStates), wout = [];
      for (var i = 0; i < Math.min(ws.length, 16); i++) {
        var w = ws[i], f = {};
        try { f = JSON.parse(w.fieldsJSON || '{}'); } catch (e) {}
        wout.push([w.playerId, w.type, f._numBullets, f._bulletsFired,
                   f._timeAlive == null ? null : +(+f._timeAlive).toFixed(4)]);
      }
      out.wpn = wout;
      out.col = (arr(d.collectibleStates) || []).length;
    } catch (e) { out.err = String((e && e.message) || e); }
    try {
      var g = (window.GameManager && GameManager.getGame) ? GameManager.getGame() : null;
      out.rnd = (g && g.rnd) ? [+g.rnd.s0, +g.rnd.s1, +g.rnd.s2, g.rnd.c] : null;
    } catch (e) { out.rnd = 'ERR'; }
    try {
      out.q = (typeof QualityManager !== 'undefined')
        ? { q: QualityManager.quality, fps: +((QualityManager.avgFps || 0)).toFixed(3), n: QualityManager.numFpsSamples }
        : null;
    } catch (e) { out.q = 'ERR'; }
    try { out.ai = (typeof AIs !== 'undefined' && AIs.aiManagers) ? AIs.aiManagers.length : null; } catch (e) { out.ai = 'ERR'; }
    out.b2d = bodySentinel();
    // Phaser 固定步长累加器（诊断"同一帧两个 run 里跑了几次 physics/update"）
    try {
      var g2 = (window.GameManager && GameManager.getGame) ? GameManager.getGame() : null;
      out.pg = g2 ? {
        d: +((g2._deltaTime || 0)).toFixed(4), u: g2.updatesThisFrame,
        now: (g2.time ? g2.time.now : null), el: (g2.time ? +((g2.time.elapsed || 0)).toFixed(4) : null),
        ms: (g2.time ? g2.time.elapsedMS : null)
      } : null;
    } catch (e) { out.pg = 'ERR'; }
    out.lu = gc ? gc.lastUpdate : null;
    // 疑点A（timer 相位）哨兵：累计 timer 触发次数。若某个 timer 回调落在相邻帧，
    // 本字段会在分歧帧先对不上（record/replay 现在都用同一套虚拟 timer 引擎）。
    try { out.tf = window.__vtStats ? window.__vtStats().timerFires : null; } catch (e) { out.tf = 'ERR'; }
    // 模型真值（绕过缓存）：用来区分"模型不同"和"缓存取样不同"
    try {
      var m = (gc && gc.roundController) ? gc.roundController.model : null;
      out.raw = m ? {
        tanks: Object.keys(m.tanks || {}).length, projs: Object.keys(m.projectiles || {}).length,
        weapons: Object.keys(m.weapons || {}).length, destroyed: (m.destroyedPlayerIds || []).length
      } : null;
    } catch (e) { out.raw = 'ERR'; }
    // ★ 2026-10-12 拆分：决定性字段 → hs（硬 FAIL）；观测性/环境相关 → hx（仅供参考）
    //   为什么必须拆：下面这些字段含墙钟/真实帧率/Phaser 循环累加器/调试计数，
    //   同一份代码反复跑本来就可能不同（实测 20 次里 1 次「仅 hidden 不一致」，
    //   其余 7 项全 0），天天被当成回归噪声。
    var det = {}, obs = {};
    for (var kk in out) {
      if (OBSERVATIONAL_KEYS[kk]) obs[kk] = out[kk]; else det[kk] = out[kk];
    }
    return { det: det, obs: obs };
  }

  /** 0-c 初始条件：地图 / 主题 / 玩家列表 / 初始位姿 / 回合设置 */
  function buildInit(opts) {
    opts = opts || {};
    var gc = gcNow();
    var out = {
      v: VERSION,
      page: opts.page || null,
      bootstrap: opts.bootstrap || null,
      driven: opts.driven || null,
      vt: { t: window.__vt.t, steps: window.__vt.steps },
      // ★ 确定性启动：固定启动帧数 + 注入时的绝对时钟基准（回放要钉住同一个 epoch，
      //   否则 Phaser game.rnd 的种子 (Date.now()*Math.random()) 每次都变）
      boot: window.__vtBoot || null,
      vtEpoch: window.__vt.epoch,
      constsNote: 'vt.t 是绝对虚拟时间；帧记录里的 t 是相对录制起点的差值',
      rng: window.__vtRng ? window.__vtRng.state() : null
    };
    out.gcState = gc ? gc.getState() : null;
    out.mode = (typeof Constants !== 'undefined' && Constants.getMode) ? Constants.getMode() : null;
    out.gameMode = gc ? gc.getMode() : null;
    out.roundId = gc ? gc.getRoundId() : null;
    out.players = gc ? arr(gc.getActivePlayerIds()) : [];
    out.flags = gc ? {
      ranked: gc.getRanked(), symmetric: gc.getSymmetric(),
      storm: gc.getStorm(), premium: gc.getPremium()
    } : null;
    try {
      out.consts = {
        COUNTDOWN_DURATION: Constants.COUNTDOWN_DURATION,
        COUNTDOWN_START_VALUE: Constants.COUNTDOWN_START_VALUE,
        BETWEEN_ROUNDS_DURATION: Constants.BETWEEN_ROUNDS_DURATION,
        CELEBRATION_DURATION: Constants.CELEBRATION_DURATION,
        MAX_DELTA_TIME: Constants.MAX_DELTA_TIME,
        MAZE_TILE_SIZE: Constants.MAZE_TILE_SIZE && Constants.MAZE_TILE_SIZE.m,
        THEMES: copy(Constants.MAZE_THEMES)
      };
    } catch (e) { out.consts = 'ERR:' + String((e && e.message) || e); }
    var mz = gc ? gc.getMaze() : null;
    if (mz) {
      out.maze = {
        width: mz.width, height: mz.height,
        tileSize: (typeof Constants !== 'undefined' && Constants.MAZE_TILE_SIZE) ? Constants.MAZE_TILE_SIZE.m : null,
        theme: (mz.getTheme ? mz.getTheme() : null),
        tiles: copy(mz.data && mz.data.tiles),
        tankPositions: copy(mz.getTankPositions ? mz.getTankPositions() : [])
      };
    } else { out.maze = null; }
    out.tanks = readTanks();    // 录制起点（IN_ROUND 第一帧之前）的位姿
    return out;
  }

  // ---------------- 录制 ----------------
  var rec = { on: false, f: 0, frames: [], init: null, err: null, t0: 0, s0: 0 };

  function recTick() {
    if (!rec.on) return;
    try { rec.frames.push(JSON.stringify(makeFrame(rec.f))); rec.f++; }
    catch (e) { rec.err = String((e && e.stack) || e); rec.on = false; }
  }

  window.__vtRec = {
    version: VERSION,
    start: function (opts) {
      if (!window.__vtRecInstalled) {
        window.__vtRecInstalled = true;
        window.__vtAfter.push(recTick);
      }
      rec.frames = []; rec.f = 0; rec.err = null; rec.on = true;
      rec.t0 = window.__vt.t; rec.s0 = window.__vt.steps;
      rec.init = buildInit(opts);
      return { started: true, init: rec.init };
    },
    stop: function () { rec.on = false; return { frames: rec.f, err: rec.err }; },
    header: function () { return JSON.stringify({ k: 'header', v: VERSION, init: rec.init }); },
    chunk: function (from, n) {
      return { from: from, n: n, total: rec.frames.length, records: rec.frames.slice(from, from + n) };
    },
    hash: function () { return { count: rec.frames.length, fnv: recHash() }; },
    stats: function () {
      return { on: rec.on, f: rec.f, n: rec.frames.length, err: rec.err, fnv: recHash() };
    }
  };

  // ---------------- 回放驱动：每帧把记录里的按键喂回游戏 ----------------
  // 注入点 = clock.js 里驱动 tank_a 用的同一条路：gc.setInputState({...})
  var drv = { on: false, f: 0, plan: [], total: 0, applied: 0, skipped: 0, errs: 0, missing: {}, lastApplied: [] };

  function boolFn(v) { return function () { return !!v; }; }

  function driveTick() {
    if (!drv.on) return;
    // ★ 2026-10-11 根因修复：记录【本帧实际施加的输入】。
    //   旧做法是回放时从"该帧采样到的坦克状态"反推输入；但坦克可能在这一帧内死亡：
    //   帧首它还活着（输入被应用，可能开火/移动），帧尾采样已经看不到它
    //   ⟹ 这一帧的输入从未进录制 ⟹ 回放漏掉这次开火/移动 ⟹ 子弹数/接触集合差 1 帧。
    //   实测证据：world step 509（录制帧 87）脚本给 tank_b 的 fire=true，
    //   record 打出 b-a0b7-13 后 tank_b 死亡；录制帧里 tank_b 已缺席，回放就不开火。
    var applied = [];
    var fr = drv.plan[drv.f];
    if (fr) {
      var gc = gcNow();
      if (gc) {
        for (var i = 0; i < fr.length; i++) {
          var t = fr[i];
          var tank = null;
          try { tank = gc.getTank(t.id); } catch (e) {}
          if (!tank) {
            drv.skipped++;
            drv.missing[t.id] = (drv.missing[t.id] || 0) + 1;
            continue;
          }
          try {
            var id = t.id;
            gc.setInputState({
              getPlayerId: function () { return id; },
              getForward: boolFn(t.fwd), getBack: boolFn(t.back),
              getLeft: boolFn(t.left), getRight: boolFn(t.right), getFire: boolFn(t.fire)
            });
            drv.applied++;
            applied.push({ id: id, fwd: !!t.fwd, back: !!t.back, left: !!t.left, right: !!t.right, fire: !!t.fire });
          } catch (e) { drv.errs++; }
        }
      }
    }
    drv.lastApplied = applied;
    if (window.__vtDrive) window.__vtDrive.lastApplied = applied;   // makeFrame 从这里读
    drv.f++;
  }

  window.__vtDrive = {
    install: function () {
      if (window.__vtDriveInstalled) return 'already';
      window.__vtDriveInstalled = true;
      window.__vtBefore.push(driveTick);
      return 'installed';
    },
    load: function (frames) {
      frames = frames || [];
      for (var i = 0; i < frames.length; i++) {
        var fr = frames[i];
        // ★ v3：优先用录下来的"实际施加输入"；老录制（v≤2）没有 drive，退回 tanks
        drv.plan[fr.f] = fr.drive || fr.tanks;
      }
      return drv.plan.length;
    },
    start: function (total) {
      drv.total = total | 0; drv.f = 0; drv.on = true;
      drv.applied = 0; drv.skipped = 0; drv.errs = 0; drv.missing = {};
      drv.lastApplied = [];
      if (window.__vtDrive) window.__vtDrive.lastApplied = [];
      return 'driving';
    },
    stop: function () { drv.on = false; return window.__vtDrive.state(); },
    state: function () {
      return { on: drv.on, f: drv.f, total: drv.total, applied: drv.applied,
               skipped: drv.skipped, errs: drv.errs, missing: drv.missing, loaded: drv.plan.length };
    }
  };
})();
`;

module.exports = { PAGE_SRC, VERSION };
