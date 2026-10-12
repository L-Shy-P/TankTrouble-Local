/* 虚拟时钟 —— 在所有页面脚本之前注入。
 *
 * 目的：让游戏以「虚拟时间 + 手动泵帧」的方式跑。
 *   - 页面自己以为时间在正常流逝（performance.now / Date.now / rAF 都被接管）
 *   - 实际上时间由外部 __vtStep(n) 控制，跑多快都不影响游戏内的时间
 *   - 因此它是【确定性的】：同样 N 帧，每次结果一致（跟机器快慢无关）
 *
 * 关键：这【不修改任何游戏代码】，游戏逻辑一行没动。
 */
(() => {
  'use strict';
  if (window.__vt) return;

  const DT = 1000 / 60;               // 每帧 16.667ms 虚拟时间 = 游戏内 60fps
  const state = {
    t: 0,                             // 虚拟时间（毫秒）
    dt: DT,
    epoch: Date.now(),                // Date.now 的绝对基准
    queue: [],                        // 本帧待执行的 rAF 回调
    errors: [],
    steps: 0,
    maxErrors: 50,
    // ---- 虚拟 timer（setTimeout / setInterval）----
    timers: new Map(),                // id -> {id, fn, args, due, delay, interval, seq}
    timerT: 0,                        // timer 专用虚拟时钟：资产阶段也照走（否则 0ms 的 loader timer 发不出去）
    timerSeq: 0,
    frozen: false,                    // true = 逻辑时钟 state.t 冻结（只给"确定性启动"用）
    releaseSteps: null,               // Menu 出现、解冻时的 steps（供 Node 侧补齐帧数）
    timerId: 1,
    timerFires: 0,
    timerDropped: 0,                  // 撞到单步上限、留到下一步的次数
  };
  window.__vt = state;

  // ---- 接管 rAF（句柄改成唯一 id，cancelAnimationFrame 才真的能取消）----
  let rafSeq = 0;
  const raf = (cb) => {
    if (typeof cb !== 'function') return 0;
    const id = ++rafSeq;
    state.queue.push({ id, cb });
    return id;
  };
  const caf = (id) => {
    for (let i = 0; i < state.queue.length; i++) {
      if (state.queue[i] && state.queue[i].id === id) { state.queue.splice(i, 1); return; }
    }
  };

  window.requestAnimationFrame = raf;
  window.cancelAnimationFrame = caf;
  window.webkitRequestAnimationFrame = raf;
  window.webkitCancelAnimationFrame = caf;

  // ---- 接管时钟 ----
  // performance.now 在 prototype 上，实例上 defineProperty 不一定吃得到，两边都试
  const nowFn = () => state.t;
  try { Object.defineProperty(window.performance, 'now', { value: nowFn, writable: true, configurable: true }); } catch (e) {}
  try { Performance.prototype.now = nowFn; } catch (e) {}
  try { Date.now = () => state.epoch + state.t; } catch (e) {}

  // ★ 关键：只接管 Date.now 是不够的！
  //   游戏主循环 GameController.update() 用的是 `new Date()`，不是 `Date.now()`：
  //     update:function(){ var time=new Date(); var deltaTime=(time-this.lastUpdate)/1000; ... }
  //   `new Date()` 走的是真实墙钟。于是物理 dt = 两帧之间【真实耗时】：
  //     · 逐帧 CDP 往返 + sleep(n) 时 → dt≈n ms，坦克会动（速度由真实时间决定，不确定）
  //     · 一次 Runtime.evaluate 里连跑 __vtStep(n) → 帧间真实耗时≈0 → dt≈0 → 坦克不动
  //   把 Date 构造函数也接到虚拟时钟上，new Date() 与 Date.now() 完全一致。
  const RealDate = Date;
  function VirtualDate() {
    if (!(this instanceof VirtualDate)) {
      // Date() 直接调用（不带 new）的语义：返回当前时间字符串
      return new RealDate(state.epoch + state.t).toString();
    }
    if (arguments.length === 0) return new RealDate(state.epoch + state.t);
    return Reflect.construct(RealDate, arguments);
  }
  VirtualDate.prototype = RealDate.prototype;
  VirtualDate.now = () => state.epoch + state.t;
  VirtualDate.parse = RealDate.parse;
  VirtualDate.UTC = RealDate.UTC;
  try { window.Date = VirtualDate; } catch (e) {}

  // 有些库靠 document.hidden / visibilityState 决定要不要跳过帧
  try { Object.defineProperty(document, 'hidden', { get: () => false, configurable: true }); } catch (e) {}
  try { Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true }); } catch (e) {}

  // ============================================================
  // ★ 接管 setTimeout / setInterval —— 真实 timer 必须进虚拟时钟
  //
  //   为什么【必须】接管：rAF/Date/performance 都在虚拟时间里走，只有 timer 还在
  //   真实时间上跑。于是同一份游戏状态，在「真机快/慢」「资产加载多泵了几帧」下，
  //   50ms 的补丁循环 / AI 同步 / 调试钩子会落在【不同的虚拟帧】上，改到记录
  //   覆盖不到的隐藏状态 ⟹ "新录一局再回放"不可复现（f=339 / 1200 帧 10 FAIL）。
  //
  //   语义：setTimeout(fn, ms) 的到期时刻 = 当前虚拟时间 + ms，只在 __vtStep
  //   推进虚拟时间、跨过到期时刻时触发；setInterval 同理按 due 递增重复。
  //   每步（一帧）触发上限 STEP_TIMER_CAP，防止 setTimeout(0) 自递归把一帧卡死；
  //   没跑完的留到下一步。
  //
  //   ⚠️ 资产加载依赖 loader 里的 `setTimeout(fn.send, 0)`（Phaser 打包代码）
  //   —— 它现在也走虚拟队列，所以 match.js 在资产阶段仍然是
  //   「泵 1 帧 → 让出真实时间 8ms」的节奏（match.js:194-195 / 248-256）：
  //   每泵一帧就会把 0ms 的 timer 放出去，真实 XHR 在让出的 8ms 里完成。
  //   这**不是**把 I/O 冻住，只是把逻辑 timer 的相位定死。
  // ============================================================
  const RealSetTimeout = window.setTimeout;
  const RealClearTimeout = window.clearTimeout;
  const RealSetInterval = window.setInterval;
  const RealClearInterval = window.clearInterval;
  const STEP_TIMER_CAP = 500;

  function scheduleTimer(fn, delay, interval, args) {
    if (typeof fn !== 'function') return 0;          // 字符串形式（eval）不支持：无调用方
    let ms = Number(delay);
    if (!isFinite(ms) || ms < 0) ms = 0;
    const id = state.timerId++;
    state.timers.set(id, {
      id, fn, args: args || [], due: state.timerT + ms, delay: ms,
      interval: !!interval, seq: state.timerSeq++,
    });
    return id;
  }
  function clearTimer(id) { state.timers.delete(id); }

  window.setTimeout = function (fn, delay) {
    return scheduleTimer(fn, delay, false, Array.prototype.slice.call(arguments, 2));
  };
  window.setInterval = function (fn, delay) {
    return scheduleTimer(fn, delay, true, Array.prototype.slice.call(arguments, 2));
  };
  window.clearTimeout = clearTimer;
  window.clearInterval = clearTimer;
  // 有些库只认 window.setTimeout === setTimeout 或读这两个名字
  try { window.setImmediate = window.setTimeout; window.clearImmediate = clearTimer; } catch (e) {}

  /** 跑所有 due <= 当前虚拟时间的 timer；排在每帧 rAF 之前（更贴近真实任务序） */
  function runDueTimers() {
    let fired = 0;
    for (;;) {
      if (fired >= STEP_TIMER_CAP) { state.timerDropped += state.timers.size ? 1 : 0; break; }
      let best = null;
      for (const tm of state.timers.values()) {
        if (tm.due <= state.timerT + 1e-9 &&
            (!best || tm.due < best.due || (tm.due === best.due && tm.seq < best.seq))) best = tm;
      }
      if (!best) break;
      if (best.interval) {
        // 间隔不能是 0：否则 due 永远追不上，会在一帧里死循环
        best.due = best.due + Math.max(best.delay, 1);
      } else {
        state.timers.delete(best.id);
      }
      fired++; state.timerFires++;
      try { best.fn.apply(null, best.args); }
      catch (e) { if (state.errors.length < state.maxErrors) state.errors.push('timer: ' + String((e && e.stack) || e)); }
    }
  }

  /**
   * ★ 资产阶段的确定性启动（2026-10-11，实测归因的修法）
   *
   * 问题：Phaser 的 rAF 回调时间戳 = 我们传进去的 state.t，而游戏时间/物理 delta
   * 就是由它累加的。资产加载由真实 I/O 决定，Menu 在第 16/18/21 帧创建都发生过；
   * 于是 Menu 里创建的粒子/发射器/tween 的"出生时刻"每次不同，它们的计数器下一帧
   * 消耗 Math.random 的时机就错开 ⟹ 录制/回放的随机数消费按帧错位。
   * （实测：调用【顺序】完全一样，只有 431 次调用的 steps 差了 2~3 帧。）
   *
   * 修法：
   *   · __vtFreeze(true)  ⟹ 资产阶段 state.t 不前进（rAF 时间戳恒定）
   *     ⟹ Phaser 游戏时间/物理 delta 全程为 0 ⟹ Menu 对象出生时刻恒定
   *   · timerT 照常按帧前进 ⟹ loader 的 setTimeout(send,0)、当机重试、
   *     Device.whenReady 轮询都照常发，真实 I/O 不被冻死
   *   · Menu 出现的那一帧 __vtRelease()：state.t 从冻结值继续走，所有挂起 timer
   *     的 due 减掉 timerT ⟹ 剩余延迟变成"从 Menu 起算"，跨运行一致
   */
  window.__vtFreeze = (on) => {
    state.frozen = !!on;
    return { frozen: state.frozen, t: state.t, timerT: state.timerT, steps: state.steps };
  };

  /** 把 timer 基准挪到"现在"：挂起 timer 的剩余延迟保留，后续 timer 从 0 起算 */
  window.__vtRebaseTimers = () => {
    const off = state.timerT;
    for (const tm of state.timers.values()) tm.due -= off;
    state.timerT = 0;
    state.releaseSteps = state.steps;
    window.__vtReleased = true;
    return { off, pending: state.timers.size, t: state.t, timerT: state.timerT, steps: state.steps };
  };

  window.__vtRelease = () => {
    state.frozen = false;
    return window.__vtRebaseTimers();
  };

  /**
   * 在页面内精确盯「Menu 状态首次出现的那一帧」（rAF 之后）并解冻。
   * 为什么不能在 Node 侧每 3 帧查一次（pumpUntilState）——那已经晚了几帧，
   * Menu create() 已经带着不同 age 了。
   */
  window.__vtWatchMenuRelease = () => {
    if (window.__vtMenuWatchInstalled) return 'already';
    window.__vtMenuWatchInstalled = true;
    window.__vtAfter.push(() => {
      if (window.__vtReleased) return;
      try {
        const g = window.GameManager && window.GameManager.getGame && window.GameManager.getGame();
        if (g && g.state && g.state.current === 'Menu') {
          window.__vtMenuReleaseInfo = window.__vtRelease();
        }
      } catch (e) {}
    });
    return 'installed';
  };

  /** 不冻结时钟的版本：只在 Menu 那一帧把 timer 基准挪到现在（保留剩余延迟） */
  window.__vtWatchMenuRebase = () => {
    if (window.__vtMenuWatchInstalled) return 'already';
    window.__vtMenuWatchInstalled = true;
    window.__vtAfter.push(() => {
      if (window.__vtReleased) return;
      try {
        const g = window.GameManager && window.GameManager.getGame && window.GameManager.getGame();
        if (g && g.state && g.state.current === 'Menu') {
          window.__vtMenuReleaseInfo = window.__vtRebaseTimers();
        }
      } catch (e) {}
    });
    return 'installed';
  };

  // ============================================================
  // ★ 随机数：记录 / 回放（不改变任何调用方的逻辑）
  //
  //   为什么不做"种子化"：主人 2026-10-07 定案——
  //     「种子化最好不要改变地图生成逻辑，否则那就更麻烦了。」
  //   地图生成里 Math.random() 散落各处（_createRandomMaze 直接调、
  //   对称迷宫还会把块生成跑两次），想改成可播种就得动生成器本体。
  //
  //   这里换成"记录取值序列"：只替换 Math.random 的【来源】，不动调用方。
  //   · record：跑一遍真实对局，把每次返回值按顺序记下来
  //   · play  ：按同一条序列吐回去 → 地图、出生点、弹道散布逐位复现
  //   序列用尽时返回常数 0（绝不再引入新的真实随机），并计数以便发现发散。
  // ============================================================
  const RealRandom = Math.random;
  const rng = {
    mode: 'off', seq: [], idx: 0, max: 2000000, overflow: 0,
    // ★ 按【调用点】分流（2026-10-11）：
    //   只按全局顺序记录/回放时，外观层（爆炸碎片、getPlayerDetails 的异步回调、音效挑选）
    //   与物理层共用一条流。外观回调是同步还是走 mock RPC 的异步，会让消费发生的
    //   【帧/顺序】变化 ⟹ 物理消费者拿到别的值 ⟹ 死亡差 1 帧。
    //   按调用栈哈希分流后，每个调用点拿自己那条记录，外观层再多再少都不影响物理层。
    sites: null,            // record: {siteKey: [v...]}    play: 同一形状
    siteState: null,        // play: {siteKey: {i}}
    siteOverflow: 0,        // 回放时某个调用点序列用尽
    calls: 0,               // Math.random 总调用次数（= rn 哨兵）
    traceOn: false, trace: [],
    debugFirst: false, firstRec: null, firstPlay: null, debugStacks: false, siteStacks: null,
  };
  function fnv1aStr(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }
  function siteKey() {
    try {
      const st = new Error().stack;
      if (!st) return 0;
      // 去掉 "Error" 和包装函数自己那两行，只留调用方
      const lines = st.split(String.fromCharCode(10));
      // ⚠️ 必须丢掉 3 行：Error / siteKey / Math.random。
      //   包装函数在 record 分支和 play 分支的行号不同（实测 305 vs 287），
      //   只丢 2 行会让 key 在 record/play 之间永远对不上（实测 siteOverflow=全部）。
      const key = fnv1aStr(lines.slice(3).join(String.fromCharCode(10)));
      if (rng.debugStacks && rng.mode === 'record') {
        if (!rng.siteStacks) rng.siteStacks = {};
        if (!rng.siteStacks[key]) rng.siteStacks[key] = lines.slice(2, 6).join(' <- ');
      }
      if (rng.debugFirst) {
        const first = rng.mode === 'play' ? 'firstPlay' : 'firstRec';
        if (!rng[first]) rng[first] = { key, head: lines.slice(0, 4) };
      }
      return key;
    } catch (e) { return 0; }
  }

  Math.random = function () {
    const mode = rng.mode;
    if (mode === 'play') {
      rng.calls++;
      if (rng.sites) {
        const k = siteKey();
        let st = rng.siteState[k];
        if (!st) st = rng.siteState[k] = { i: 0, miss: 0 };
        const arr = rng.sites[k];
        if (arr && st.i < arr.length) { const v = arr[st.i++]; if (rng.traceOn) rng.trace.push([rng.calls, k, v, window.__vt.steps]); return v; }
        rng.siteOverflow++; st.miss++;
        if (rng.idx < rng.seq.length) return rng.seq[rng.idx++];   // 兜底：老式全局序列
        rng.overflow++;
        return 0;
      }
      if (rng.idx < rng.seq.length) return rng.seq[rng.idx++];
      rng.overflow++;
      return 0;
    }
    const v = RealRandom.call(Math);
    if (mode === 'record') {
      rng.calls++;
      if (rng.sites) {
        const k = siteKey();
        const arr = rng.sites[k] || (rng.sites[k] = []);
        arr.push(v);
        if (rng.traceOn) rng.trace.push([rng.calls, k, v, window.__vt.steps]);
      }
      if (rng.seq.length < rng.max) rng.seq.push(v);
    }
    return v;
  };

  window.__vtRng = {
    debugFirst(on) { rng.debugFirst = !!on; return rng.debugFirst; },
    debugStacks(on) { rng.debugStacks = !!on; return rng.debugStacks; },
    trace(on) { rng.traceOn = !!on; if (on) rng.trace = []; return rng.traceOn; },
    dumpTrace(from, n) { return rng.trace.slice(from, from + n); },
    traceLen() { return rng.trace.length; },
    record(max) {
      rng.seq = []; rng.idx = 0; rng.overflow = 0; rng.calls = 0;
      rng.sites = {}; rng.siteState = null; rng.siteOverflow = 0;
      if (max) rng.max = max | 0;
      rng.mode = 'record';
      return 'recording';
    },
    /** 老式：只记全局顺序（没有调用点分流） */
    recordFlat(max) {
      rng.seq = []; rng.idx = 0; rng.overflow = 0; rng.calls = 0;
      rng.sites = null; rng.siteState = null; rng.siteOverflow = 0;
      if (max) rng.max = max | 0;
      rng.mode = 'record';
      return 'recording-flat';
    },
    stop() { rng.mode = 'off'; return rng.seq.length; },
    /** 用一条扁平序列复现（老录制 / 兼容路径） */
    play(seq, startAt) {
      rng.seq = (seq || []).slice();
      rng.idx = Math.max(0, Math.min(startAt | 0, rng.seq.length));
      rng.overflow = 0; rng.calls = 0;
      rng.sites = null; rng.siteState = null; rng.siteOverflow = 0;
      rng.mode = 'play';
      return rng.seq.length;
    },
    /** ★ 按调用点分流回放：sites={siteKey:[v...]}；flatSeq 仅作兜底 */
    playSites(sites, flatSeq) {
      rng.sites = sites || {};
      rng.siteState = {};
      rng.seq = (flatSeq || []).slice();
      rng.idx = 0; rng.overflow = 0; rng.calls = 0; rng.siteOverflow = 0;
      rng.mode = 'play';
      return Object.keys(rng.sites).length;
    },
    dump() { return rng.seq; },
    dumpSites() { return rng.sites; },
    /** 每个调用点已消费的条数（record=记录条数，play=消费条数） */
    useCounts() {
      const out = {};
      if (rng.mode === 'record' && rng.sites) {
        for (const k in rng.sites) out[k] = rng.sites[k].length;
      } else if (rng.mode === 'play' && rng.siteState) {
        for (const k in rng.siteState) out[k] = rng.siteState[k].i;
      }
      return out;
    },
    stacks() { return rng.siteStacks || null; },
    state() {
      return {
        mode: rng.mode, len: rng.seq.length, idx: rng.idx, overflow: rng.overflow,
        calls: rng.calls, siteCount: rng.sites ? Object.keys(rng.sites).length : 0,
        siteOverflow: rng.siteOverflow,
        firstRec: rng.firstRec, firstPlay: rng.firstPlay,
      };
    },
  };

  // ---- 外部驱动接口 ----
  // 每帧「推进前」要跑的回调。游戏用来喂输入（setInputState 每帧一次）。
  window.__vtBefore = [];
  // 每帧「推进后」要跑的回调。游戏用来采样观测。
  window.__vtAfter = [];

  // 跑 n 帧；返回虚拟时间
  window.__vtStep = (n) => {
    n = n | 0;
    for (let i = 0; i < n; i++) {
      // 先喂输入，再让游戏跑这一帧
      const pre = window.__vtBefore;
      for (let p = 0; p < pre.length; p++) {
        try { pre[p](); }
        catch (e) { if (state.errors.length < state.maxErrors) state.errors.push('before: ' + String((e && e.stack) || e)); }
      }

      // ★ 冻结模式：state.t 不前进（rAF 时间戳恒定 → Phaser delta=0），
      //   但 timerT 照走，资产加载用的 0ms timer / 轮询还能发出去。
      if (!state.frozen) state.t += state.dt;
      state.timerT += state.dt;

      // ★ timer 在 rAF 之前跑：真实浏览器里 setTimeout 这类宏任务在下一帧 rAF 之前执行
      runDueTimers();

      const q = state.queue;
      state.queue = [];
      for (let j = 0; j < q.length; j++) {
        try { q[j].cb(state.t); }
        catch (e) {
          if (state.errors.length < state.maxErrors) state.errors.push(String((e && e.stack) || e));
        }
      }

      const post = window.__vtAfter;
      for (let a = 0; a < post.length; a++) {
        try { post[a](); }
        catch (e) { if (state.errors.length < state.maxErrors) state.errors.push('after: ' + String((e && e.stack) || e)); }
      }
      state.steps++;
    }
    return state.t;
  };

  // 一次性装好「开坦克」的钩子：每帧把 __vtCtrl 喂给 tank_a
  window.__vtCtrl = { fwd: false, back: false, left: false, right: false, fire: false };
  window.__vtTankId = 'tank_a';
  window.__vtInstallControl = (tankId) => {
    if (tankId) window.__vtTankId = tankId;
    if (window.__vtControlInstalled) return 'already';
    window.__vtControlInstalled = true;
    window.__vtBefore.push(() => {
      const gm = window.GameManager;
      if (!gm || !gm.getGameController) return;
      const gc = gm.getGameController();
      if (!gc || !gc.getTank || !gc.setInputState) return;
      const id = window.__vtTankId;
      if (!gc.getTank(id)) return;
      const c = window.__vtCtrl;
      gc.setInputState({
        getPlayerId: () => id,
        getForward: () => !!c.fwd,
        getBack: () => !!c.back,
        getLeft: () => !!c.left,
        getRight: () => !!c.right,
        getFire: () => !!c.fire,
      });
    });
    return 'installed';
  };

  window.__vtStats = () => ({
    t: state.t,
    steps: state.steps,
    pending: state.queue.length,
    errors: state.errors.slice(0, 10),
    errorCount: state.errors.length,
    epoch: state.epoch,
    timersPending: state.timers.size,
    timerFires: state.timerFires,
    timerDropped: state.timerDropped,
    timerT: state.timerT,
    frozen: state.frozen,
    released: !!window.__vtReleased,
    releaseSteps: state.releaseSteps,
  });

  // ★ 把 Date.now 的绝对基准钉死成录制时的那一个（回放时由 header 传入）。
  //   为什么需要：Phaser 用 `(Date.now()*Math.random()).toString()` 给 game.rnd 播种
  //   （game_core/js/75c76f1d382639f5dc22fe467491448c.js:287788），
  //   `getRandomActiveTheme()` 又用 `new Date()` 的月/日筛主题
  //   （game_core/js/54518faa8d672020d7af8ed7c353bc1b.js:35636）。
  //   epoch 不同 ⟹ 第二个 RNG 的种子不同、主题候选集不同 ⟹ 回放必然漂。
  window.__vtSetEpoch = (e) => {
    if (typeof e === 'number' && isFinite(e)) state.epoch = e;
    return state.epoch;
  };

  // timer 诊断（探针用）
  window.__vtTimerState = () => {
    const byDelay = {};
    for (const tm of state.timers.values()) {
      const k = (tm.interval ? 'interval:' : 'timeout:') + tm.delay;
      byDelay[k] = (byDelay[k] || 0) + 1;
    }
    return { pending: state.timers.size, fires: state.timerFires, dropped: state.timerDropped, byDelay };
  };

  /** 清掉当前所有挂起 timer（headless 确定性模式的"启动清理"）：页面加载期排下的
   *  补丁循环/调试钩子，其调度顺序与真实 I/O 有关；建局后重来一遍最干净。
   *  注意：只管【挂起】的，之后游戏自己排的 timer 照常走。 */
  window.__vtClearTimers = () => {
    const n = state.timers.size;
    state.timers.clear();
    state.clearedTimers = (state.clearedTimers || 0) + n;
    return n;
  };

  window.__vtReset = () => {
    state.t = 0; state.queue = []; state.errors = []; state.steps = 0;
    state.timers.clear(); state.timerFires = 0; state.timerDropped = 0; state.timerT = 0; state.frozen = false;
  };
})();
