'use strict';
/**
 * 无头对局环境 —— Vantage 的训练/评测底座
 * =====================================================
 *
 * 它跑的是【真实的 game_core】，不是另写的简化版：
 *   · 真 Box2D 世界（GameController.getB2DWorld()）
 *   · 真子弹、真武器、真道具、真迷宫
 *   · 真 Laika AI（AIs.addAIManager）
 * 唯一的区别是【不画画面】+ 【时间由我们控制】。
 *
 * 时间控制 = 虚拟时钟：
 *   页面里的 requestAnimationFrame / performance.now / Date.now 被接管，
 *   只有我们调 __vtStep(n) 时才推进，每帧固定 16.667ms。
 *   → 确定性（同样帧数结果一致，和机器快慢无关）
 *   → 可加速（物理不依赖真实时间，想跑多快跑多快）
 *
 * ⚠️ 唯一的坑（踩过）：虚拟时钟会把真实 I/O 一起冻住。
 *    资产加载阶段必须【推进几帧 → 让出真实时间】交错进行，
 *    否则图片永远下不完，游戏永远卡在 Boot。
 *    资源就位后才可以全速空转。
 */

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./cdp');
const { startPyServer } = require('./pyserver');

const CLOCK_SRC = fs.readFileSync(path.join(__dirname, 'clock.js'), 'utf8');

/** 页面内录制/回放源码（阶段0-2/0-3）：随 clock.js 一起在【所有页面脚本之前】注入 */
const { PAGE_SRC: REC_SRC } = require('./record_page');
const { PAGE_SRC: NORE_SRC } = require('./norender_page');   // ★ 「不呈现」开关（默认关，见 setNoRender）

/** 把 Classy 的集合/对象统一成数组，别管它是啥 */
const PAGE_HELPERS = `
window.__vtArr = function (x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (typeof x.toArray === 'function') { try { return x.toArray(); } catch (e) {} }
  if (typeof x.values === 'function') { try { return [...x.values()]; } catch (e) {} }
  if (typeof x.entries === 'function') { try { return [...x.entries()].map(function(kv){return kv[1];}); } catch (e) {} }
  if (typeof x === 'object') {
    var out = [], ks = Object.keys(x);
    for (var i = 0; i < ks.length; i++) { var v = x[ks[i]]; if (v && typeof v === 'object') out.push(v); }
    return out;
  }
  return [];
};
window.__vtData = function (x) { return (x && x.data) ? x.data : x; };
`;

/**
 * 跳过登录/大厅，直接照 UILobbyState._createLocalGame 造一局本地对局。
 * humanIds / aiCount 可配：aiCount=0 → 空场（测控制、课程学习第一阶段）；
 * aiCount=2 → Laika + Dimitri（server.py 的 _mock_rpc 提供两个 AI）。
 */
const bootstrapSrc = (o = {}) => `(() => {
  var out = {};
  try {
    var ph = GameManager.getGame();
    if (ph.state.current === 'Game') { return { already: true, warn: '页面已经在 Game 状态，本次没有新建对局（bootstrap 直接返回）' }; }
    var totalPlayers = ${(o.players === undefined || o.players === null) ? 'null' : Number(o.players)};
    var humans = ${JSON.stringify(o.humanIds || ((o.players === undefined || o.players === null) ? ['tank_a'] : []))};
    var aiCount = ${Number(o.aiCount === undefined ? 1 : o.aiCount)};
    var vantCount = ${Number(o.vantCount === undefined ? ((o.players === undefined || o.players === null) ? 0 : 1) : o.vantCount)};
    // ★ G2（场景参数）：
    //   · totalPlayers 给了 ⟹ 【总坦克数】= players，我方 1 辆 vantage_1 + 其余 laikaX_i；
    //     maxActivePlayerCount 必须给到 players（CLIENT.MAX_PLAYERS 只有 3，是"每条连接"上限，
    //     不是每局上限；每局上限常量是 GAME.MAX_ACTIVE_PLAYERS=8）。
    //   · crates = null/true ⟹ BOOT_CAMP.DEFAULT_AVAILABLE_CRATES；false ⟹ []；数组 ⟹ 原样。
    //   · ⛔ 建图尺寸不由我们指定：仍由 BootCampGameMode.getMaze(activePlayerIds) 按原版公式决定。
    var crates = ${JSON.stringify(o.crates === undefined ? null : o.crates)};
    var crateTypes = (crates === null || crates === true)
      ? Constants.GAME_MODE_INFO[Constants.GAME_MODES.BOOT_CAMP].DEFAULT_AVAILABLE_CRATES
      : crates;
    var maxActive = Constants.CLIENT.MAX_PLAYERS;
    if (totalPlayers !== null) {
      if (!(totalPlayers >= 2 && totalPlayers <= 8)) { out.err = 'players 必须在 2~8（收到 ' + totalPlayers + '）'; return out; }
      if (humans.length + vantCount > totalPlayers) { out.err = 'players=' + totalPlayers + ' 装不下 humanIds=' + humans.length + ' + vantCount=' + vantCount; return out; }
      aiCount = totalPlayers - humans.length - vantCount;
      maxActive = Math.max(totalPlayers, Constants.CLIENT.MAX_PLAYERS);
    }
    if (!Array.isArray(crateTypes)) { out.err = 'crates 必须是数组或 true/false/null（收到 ' + JSON.stringify(crates) + '）'; return out; }
    Constants.setMode(Constants.MODE_CLIENT_LOCAL);
    var ttGame = GameController.create(
      BootCampGameMode.create(), false, false, false,
      maxActive,
      crateTypes,
      false, Constants.MAZE_THEMES.RANDOM);
    out.gameId = ttGame.getId();
    out.humanIds = humans;
    for (var i = 0; i < humans.length; i++) ttGame.addPlayer(humans[i]);
    out.aiIds = [];
    if (aiCount > 0 && !AIs.isReady()) out.aiWarn = 'aiCount=' + aiCount + ' 但 AIs.isReady()=false，一个 AI 都没加上';
    if (AIs.isReady()) {
      var used = {};
      // ★ G2 多 Laika 实例：⛔ 不能用 laika_ 前缀 —— local_patch.js:1106-1112 把 laika_*
      //   折回 6148530（加 7 个只得 1 个）。改用 laikaX_i，并逐 id 在 AIs.ais 里放一份
      //   Laika（6148530）的 config 副本（照 local_patch 的 cloneLaikaConfig 做法）。
      var tplLaika = null;
      if (totalPlayers !== null) {
        tplLaika = (AIs.ais && AIs.ais['6148530']) || (AIs.getAI && AIs.getAI('6148530'));
        if (!tplLaika) out.aiErr = 'Laika 模板 6148530 的 config 不存在；AIs.ais keys=' + Object.keys(AIs.ais || {}).join(',');
      }
      for (var k = 0; k < aiCount; k++) {
        var aiId = null;
        if (totalPlayers !== null) {
          if (!tplLaika) break;
          aiId = 'laikaX_' + (k + 1);
          var cfgL = {};
          for (var ckL in tplLaika) { if (Object.prototype.hasOwnProperty.call(tplLaika, ckL)) cfgL[ckL] = tplLaika[ckL]; }
          cfgL.name = 'Laika';
          AIs.ais[aiId] = cfgL;
        } else {
          aiId = AIs.getAvailableAIId(ttGame.getId());
        }
        if (aiId && !used[aiId]) {
          used[aiId] = 1;
          var addOk = false;
          try { addOk = AIs.addAIManager(ttGame, aiId); }
          catch (eAdd) { out.aiErr = 'AIs.addAIManager 抛异常 ' + aiId + ': ' + String((eAdd && eAdd.message) || eAdd); }
          if (addOk === false) out.aiErr = 'AIs.addAIManager 返回 false: ' + aiId;
          if (addOk !== false) {
            var plOk = false;
            try { plOk = ttGame.addPlayer(aiId); }
            catch (ePl) { out.aiErr = 'ttGame.addPlayer 抛异常 ' + aiId + ': ' + String((ePl && ePl.message) || ePl); }
            if (plOk === false) out.aiErr = 'ttGame.addPlayer 返回 false: ' + aiId;
            if (plOk !== false) out.aiIds.push(aiId);
          }
        }
      }
    }
    out.vantageIds = [];
    for (var v = 0; v < vantCount; v++) {
      var vid = 'vantage_' + (v + 1);
      try {
        AIs.addAIManager(ttGame, vid);   // aiId 以 vantage_ 开头 → local_patch 分流到 VantageAIManager
        ttGame.addPlayer(vid);
        out.vantageIds.push(vid);
      } catch (eV) { out.vantageErr = String(eV && eV.message || eV); }
    }
    if (aiCount > 0 && out.aiIds.length === 0 && !out.aiWarn) {
      out.aiWarn = 'aiCount=' + aiCount + ' 但 getAvailableAIId 没给出任何可用 AI（会变成空场）';
    }
    if (vantCount > 0 && out.vantageIds.length === 0 && !out.vantageErr) out.vantageErr = 'vantCount=' + vantCount + ' 但一个 vantage_ 玩家都没加上（会变成空场）';
    if (${o.storm === true ? 'true' : 'false'}) {
      // 任务指定的钩子（gc.storm / gameMode.setStorm）。⚠️ 对 BOOT_CAMP 只是"置位"：
      // BootCampGameMode.update 全文没有 storm 生成路径（只有 ClassicGameMode.update 会
      // setZoneState(StormZone...)）。真正的毒雾区由 Match.open() 在 IN_ROUND 后注入。
      ttGame.storm = true;
      if (ttGame.gameMode && typeof ttGame.gameMode.setStorm === 'function') ttGame.gameMode.setStorm(true);
    }
    out.stormFlag = { gcStorm: !!ttGame.storm, modeStorm: !!(ttGame.gameMode && ttGame.gameMode.storm) };
    out.maxActivePlayerCount = maxActive;
    out.crateTypes = crateTypes.slice();
    GameManager.setGameController(ttGame);
    ph.state.start('Game', true, false, ttGame);
    out.started = true;
  } catch (e) { out.err = String((e && e.stack) || e); }
  return out;
})()`;

/** 紧凑局面快照 —— 只取数字，不碰 Classy 的 __class 元数据 */
const SNAPSHOT = `(() => {
  var ph = GameManager.getGame();
  var gc = GameManager.getGameController();
  if (!gc) return { stage: ph.state.current, noController: true };
  var raw = gc.getRoundState();
  var d = __vtData(raw) || {};
  var tanks = (d.tankStates || []).map(function (t) {
    return { id: t.playerId, x: t.x, y: t.y, rot: +(+t.rotation).toFixed(4),
             fwd: !!t.forward, back: !!t.back, left: !!t.left, right: !!t.right,
             fire: !!t.fireDown, locked: !!t.locked };
  });
  // ⚠️ 这里【故意不取 rot】：projectileStates 的序列化 schema（bundle 886d0eb6…）只有
  //   {id, playerId, type, x, y, speedX, speedY} —— **没有 rotation**。
  //   旧版写 rot: +(+p.rotation).toFixed(4) 读的是不存在的键 ⟹ 恒为 NaN
  //   （过 CDP 的 JSON 会变成 null，谁再 +rot 强转就成 0 —— 看着像正经数值的垃圾值）。
  //   要朝向自己用速度算（两套约定别混，见
  //   docs/Vantage躲弹实现/02-实现/进展记录/日期校正与match-NaN-2026-10-12.md §二）：
  //     · 速度方向（与 x/y 同一坐标系、y 向下）：Math.atan2(speedY, speedX)
  //     · 与 tankStates[].rotation 同约定（forward = (sin r, -cos r)）：Math.atan2(speedX, -speedY)
  var projs = (d.projectileStates || []).map(function (p) {
    return { id: p.id, owner: p.playerId, x: p.x, y: p.y, type: p.type };
  });
  var ws = (d.weaponStates || []).map(function (w) {
    var f = {}; try { f = JSON.parse(w.fieldsJSON || '{}'); } catch (e) {}
    return { id: w.id, owner: w.playerId, type: w.type, bullets: f._numBullets,
             pulled: !!f._triggerPulled, fired: f._bulletsFired, alive: +(+f._timeAlive).toFixed(3) };
  });
  var picks = (d.collectibleStates || []).length;
  return {
    stage: ph.state.current,
    roundStateMissing: !raw,
    players: __vtArr(gc.getActivePlayerIds()),
    roundId: gc.getRoundId(),
    roundState: gc.getGameState ? gc.getGameState() : null,
    tanks: tanks, projectiles: projs, weapons: ws, collectibles: picks,
    scores: __vtArr(gc.getScores()).map(function (s) {
      return { playerId: s.playerId, type: s.type, value: s.value };
    }),
    virtualT: window.__vt.t,
  };
})()`;

class Match {
  constructor() {
    this.srv = null; this.browser = null; this.sessionId = null; this.targetId = null;
    this.console = []; this.pageErrors = [];
  }

  /**
   * 开页面并一路推进到能在跑的真实对局。
   *
   * opts:
   *   rng      : 'record'（默认，录 Math.random 序列）| 'play' | 'off'
   *   rngSeq   : 数组 ⟹ 等价 rng:'play'，在【文档创建时】就接上（保证地图一致）
   *   control  : false ⟹ 不装 __vtCtrl 单车钩子（回放走 __vtDrive 多车注入）
   *   waitRound: false ⟹ 不自动等 IN_ROUND（探针用：要看倒计时内的行为）
   */
  async open(opts = {}) {
    const page = opts.page || 'index.html';
    const verbose = !!opts.verbose;
    this.srv = await startPyServer({});
    this.browser = await launch({});
    const np = await this.browser.newPage('about:blank');
    this.sessionId = np.sessionId; this.targetId = np.targetId;
    const sid = this.sessionId, b = this.browser;

    b.on('Runtime.consoleAPICalled', (p) => {
      if (!verbose) return;
      const txt = (p.args || []).map((a) => (a.value !== undefined ? a.value : (a.description || a.type))).join(' ');
      this.console.push(`[${p.type}] ${txt}`.slice(0, 400));
      if (this.console.length > 400) this.console.splice(0, 200);
    }, sid);
    b.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      this.pageErrors.push(String((d.exception && d.exception.description) || d.text).slice(0, 600));
    }, sid);

    // ★ 随机数接管必须和页面脚本【同时】生效：
    //   record 时从文档第一条脚本起记；play 时从第一条脚本起回放。
    //   否则地图生成已经用掉随机数 ⟹ 回放出来的地图和录制时不是同一张（0-a）。
    const rngMode = (opts.rngSites || opts.rngSeq) ? 'play' : (opts.rng || 'record');
    const rngPrelude = opts.rngSites
      ? `;window.__vtRng.playSites(${JSON.stringify(opts.rngSites)}, ${JSON.stringify(opts.rngSeq || [])});`
      : (rngMode === 'play'
        ? `;window.__vtRng.play(${JSON.stringify(opts.rngSeq || [])});`
        : (rngMode === 'record' ? ';window.__vtRng.record();'
          : (rngMode === 'flat' ? ';window.__vtRng.recordFlat();' : '')));
    // ★ 绝对时钟基准也要在【第一条页面脚本之前】钉死：
    //   Phaser 用 (Date.now()*Math.random()) 播种 game.rnd，
    //   getRandomActiveTheme() 用 new Date() 的月/日筛主题。
    const epochPrelude = (opts.epoch !== undefined && opts.epoch !== null && isFinite(Number(opts.epoch)))
      ? `;window.__vtSetEpoch(${Number(opts.epoch)});` : '';
    const prelude = rngPrelude + ';window.__vtRng.debugFirst(true);' + epochPrelude;
    this.rngMode = rngMode;

    await b.send('Page.enable', {}, sid);
    await b.send('Runtime.enable', {}, sid);
    await b.send('Page.addScriptToEvaluateOnNewDocument',
      { source: CLOCK_SRC + PAGE_HELPERS + REC_SRC + prelude }, sid);

    const t0 = Date.now();
    const loaded = b.waitFor('Page.loadEventFired', 90000, sid);
    await b.send('Page.navigate', { url: `${this.srv.origin}/${page}` }, sid);
    await loaded;
    this.loadMs = Date.now() - t0;

    // ★ 确定性启动（2026-10-11）：
    //   资产阶段真实 I/O 快慢会让 Menu 在第 16/18/21 帧创建 ⟹ 它内部排的 timer 全部错相。
    //   · rebaseAtMenu（默认）：Menu 那一帧把 timer 基准挪到当下（保留剩余延迟）。
    //   · freezeUntilMenu：资产阶段冻结 state.t（Phaser delta=0）。⚠️ 实测会把 Phaser
    //     的固定步长循环卡死（Game.update 靠 time.elapsed 累加 updateLogic），默认关。
    if (opts.freezeUntilMenu) {
      await this.eval('window.__vtFreeze(true)');
      await this.eval('window.__vtWatchMenuRelease()');
    } else if (opts.rebaseAtMenu) {
      await this.eval('window.__vtWatchMenuRebase()');
    }

    // 资产阶段：必须交错让出真实时间
    const menu = await this.pumpUntilState('Menu', (Number(process.env.VT_MENU_FRAMES) || 900), opts.assetYieldMs || 8, opts);
    this.menuFrames = menu.frames;
    const releaseSteps = await this.eval('window.__vt.releaseSteps == null ? null : window.__vt.releaseSteps');
    this.bootPadded = 0;
    if (opts.freezeUntilMenu) {
      // 冻结模式：t 在解冻前不动 ⟹ 固定「解冻后」的帧数
      if (releaseSteps == null) await this.eval('window.__vtRelease()');
      const relSteps = (releaseSteps == null) ? await this.eval('window.__vt.steps') : releaseSteps;
      this.postRelease = menu.frames - relSteps;
      if (opts.bootFrames && this.postRelease < opts.bootFrames) {
        this.bootPadded = opts.bootFrames - this.postRelease;
        await this.pump(this.bootPadded, { yieldMs: 0 });
      }
      this.bootFrames = this.postRelease + this.bootPadded;
      this.releaseSteps = relSteps;
    } else {
      // 普通/rebase 模式：t 一直在走 ⟹ 把【总帧数】补齐到固定值
      this.postRelease = null;
      if (opts.bootFrames && menu.frames < opts.bootFrames) {
        this.bootPadded = opts.bootFrames - menu.frames;
        await this.pump(this.bootPadded, { yieldMs: 0 });
      }
      this.bootFrames = menu.frames + this.bootPadded;
      this.releaseSteps = releaseSteps;
    }
    const bootT = await this.eval('window.__vt.t');
    const epochNow = await this.eval('window.__vt.epoch');
    const menuRelease = await this.eval('window.__vtMenuReleaseInfo || null');
    await this.eval('window.__vtBoot = ' + JSON.stringify({
      menuFrames: menu.frames, releaseSteps: this.releaseSteps, postRelease: this.postRelease,
      bootFrames: this.bootFrames, padded: this.bootPadded,
      assetYieldMs: opts.assetYieldMs || 8, bootT: bootT, epoch: epochNow, menuRelease: menuRelease,
    }));
    const boot = await this.eval(bootstrapSrc(opts));
    if (boot && boot.err) throw new Error('引导本地对局失败: ' + boot.err);
    if (boot && boot.aiWarn) throw new Error('引导本地对局: ' + boot.aiWarn);
    if (boot && boot.aiErr) throw new Error('引导本地对局（多 Laika 实例）: ' + boot.aiErr);
    if (boot && boot.vantageErr) throw new Error('引导本地对局: ' + boot.vantageErr);
    this.bootstrap = boot;

    // ★ Phaser 固定步长累加器残差（2026-10-11 实测）：
    //   Game.update 用 `_deltaTime += time.elapsed` 累加、再按 b=16.667ms 决定本帧跑几次
    //   updateLogic。资产阶段 Menu 在第 16/18 帧创建，会让残差漂成 16 vs 17ms；
    //   之后某一帧就会多跑/少跑一次物理 ⟹ 子弹命中/坦克死亡差 1 帧，rn 也跟着错位。
    //   在【建局那一刻】清零残差，让 record/replay 从同一相位开始。
    this.loopAccumBefore = await this.eval(`(() => {
      var g = GameManager.getGame();
      if (!g) return null;
      var before = { d: g._deltaTime, u: g.updatesThisFrame, now: g.time ? g.time.now : null };
      g._deltaTime = 0; g.updatesThisFrame = 0;
      return before;
    })()`);
    // ★ 再钉一次 timer 基准：页面加载期排下的 50ms 补丁循环 / AI 同步，其绝对到期时刻
    //   跟"页面开了几帧"绑定；t=0 时刻的 timer 相位会随 Menu 创建帧漂 1~3 帧。
    //   在【建局这一刻】（此时绝对虚拟时间已被 bootFrames 钉死）重定基准，
    //   让整局期间每个 timer 的剩余延迟都从同一个时刻起算。
    this.timerRebase = await this.eval('window.__vtRebaseTimers()');
    if (opts.clearBootTimers) this.bootTimersCleared = await this.eval('window.__vtClearTimers()');

    await this.pumpUntilState('Game', 600, opts.assetYieldMs || 8, opts);
    this.tankId = opts.tankId || 'tank_a';
    // ★ 0-1：倒计时阶段的 setTankState 会静默 return false ⟹ 先等到 IN_ROUND 再返回
    if (opts.waitRound !== false) await this.waitForRound(opts);
    // ★ G2 毒雾：任务指定的钩子（gc.storm / gameMode.setStorm）在 bootstrap 里已置位，
    //   但 BOOT_CAMP 的 update 没有 storm 生成路径（只有 ClassicGameMode.update 会
    //   setZoneState(StormZone...)，且要等 60s）⟹ 这里照【游戏自己的那一句】注入 STORM 区
    //   （StormZone.createInitialZoneState(id, maze.getStormExpansionSequence(), maze.getTileBounds())）。
    //   ⛔ 不改建图逻辑、⛔ 不碰 DEATHMATCH；注入失败【抛错】，不静默降级。
    if (opts.storm) {
      this.stormSpawn = await this.spawnStorm();
      if (!this.stormSpawn || this.stormSpawn.err) throw new Error('毒雾注入失败: ' + JSON.stringify(this.stormSpawn));
      this.stormFlag = boot.stormFlag || null;
    }
    // ★ 「不呈现」开关（默认关）：opts.noRender===true 或环境变量 VT_NO_RENDER=1 才开（见 setNoRender）
    if (opts.noRender === true || process.env.VT_NO_RENDER === '1') this.noRenderBoot = await this.setNoRender(true);
    // 装好开坦克的钩子（默认开 tank_a）。waitRound:false 时默认不装（那时坦克可能还没生成）
    if (opts.control === true || (opts.control !== false && opts.waitRound !== false)) {
      await this.installControl(this.tankId);
    }
    return this;
  }

  /**
   * 泵帧直到 GameController 报 IN_ROUND。
   *
   * ⚠️ 根因（设计审查与补全建议 §六，探针实测）：
   *   `GameController.setTankState` 开头有守卫
   *   `if (model.getState()!=GameModel._STATES.IN_ROUND) { log.warn(...); return false; }`
   *   ⟹ 倒计时阶段调它会被【整个丢弃】（x/y/rot 全不生效），只在 log 里 warn 一句。
   *   所以 open() 默认等 IN_ROUND；等不到就【响亮抛错】，不静默返回。
   */
  async waitForRound(opts = {}) {
    const maxFrames = opts.roundMaxFrames || 1200;
    const yieldMs = opts.roundYieldMs !== undefined ? opts.roundYieldMs : 0;
    const inRound = await this.eval(
      "(() => { try { return (typeof GameModel !== 'undefined' && GameModel._STATES) ? GameModel._STATES.IN_ROUND : 'in round'; } catch (e) { return 'in round'; } })()");
    let done = 0, cur = null, last = null;
    const log = [];
    while (done < maxFrames) {
      cur = await this.eval("(() => { var gc = GameManager.getGameController(); return gc ? gc.getState() : null; })()");
      if (cur === inRound) break;
      if (cur !== last) { log.push(done + '帧→' + cur); last = cur; }
      await this.pump(1, { yieldMs });
      done++;
    }
    if (cur !== inRound) {
      throw new Error('waitForRound 超时：泵了 ' + done + ' 帧仍未进入 IN_ROUND(' + inRound +
        ')，最后状态=' + cur + '；轨迹=' + log.join('|'));
    }
    this.roundWait = { frames: done, inRound: inRound, log: log };
    return this.roundWait;
  }

  /**
   * 注入毒雾区（照 ClassicGameMode.update 的那一句）并**当场验证**场上真有 STORM 区。
   * 返回 { gcStorm, modeStorm, zonesBefore, zonesAfter, nStorm, zoneId } 或 { err }。
   */
  async spawnStorm() {
    return this.eval(`(() => {
      var gc = GameManager.getGameController();
      var out = { gcStorm: gc ? !!gc.storm : null, modeStorm: (gc && gc.gameMode) ? !!gc.gameMode.storm : null };
      if (!gc || !gc.roundController) { out.err = 'no roundController'; return out; }
      var mz = gc.roundController.getMaze();
      if (!mz) { out.err = 'no maze'; return out; }
      if (typeof StormZone === 'undefined' || !StormZone.createInitialZoneState) { out.err = 'StormZone 不可用'; return out; }
      var zones0 = __vtArr(gc.getZones ? gc.getZones() : []);
      out.zonesBefore = zones0.length;
      var st = null;
      try { st = StormZone.createInitialZoneState(IdGenerator.instance.gen('sz'), mz.getStormExpansionSequence(), mz.getTileBounds()); }
      catch (eC) { out.err = 'createInitialZoneState 抛异常: ' + String((eC && eC.message) || eC); return out; }
      try { gc.roundController.setZoneState(st); }
      catch (eS) { out.err = 'setZoneState 抛异常: ' + String((eS && eS.message) || eS); return out; }
      var zones = __vtArr(gc.getZones ? gc.getZones() : []);
      var nStorm = 0;
      for (var i = 0; i < zones.length; i++) {
        try { if (zones[i] && zones[i].getType && zones[i].getType() === Constants.ZONE_TYPES.STORM) nStorm++; } catch (eT) {}
      }
      out.zonesAfter = zones.length; out.nStorm = nStorm;
      out.zoneId = (st && st.getId) ? st.getId() : null;
      if (nStorm < 1) out.err = '注入后场上没有 STORM 区（zones=' + zones.length + '）';
      return out;
    })()`);
  }

  /** 便宜的毒雾/道具计数（跑局器每隔若干帧采样一次用） */
  async stormState() {
    return this.eval(`(() => {
      var gc = GameManager.getGameController();
      if (!gc) return { nStorm: 0, nZones: 0, nCrates: 0, gcStorm: null, modeStorm: null };
      var zs = (gc.getZones) ? __vtArr(gc.getZones()) : [];
      var n = 0;
      for (var i = 0; i < zs.length; i++) {
        try { if (zs[i] && zs[i].getType && zs[i].getType() === Constants.ZONE_TYPES.STORM) n++; } catch (e) {}
      }
      var cs = (gc.getCollectibles) ? __vtArr(gc.getCollectibles()) : [];
      return { nStorm: n, nZones: zs.length, nCrates: cs.length, gcStorm: !!gc.storm,
               modeStorm: gc.gameMode ? !!gc.gameMode.storm : null };
    })()`);
  }

  /** 泵 n 帧；yieldMs>0 时每帧让出真实时间（I/O 用） */
  async pump(n, opts = {}) {
    const y = opts.yieldMs || 0;
    const chunk = opts.chunk || (y > 0 ? 1 : n);
    let done = 0;
    while (done < n) {
      const k = Math.min(chunk, n - done);
      await this.browser.evaluate(`window.__vtStep(${k})`, this.sessionId);
      done += k;
      if (y > 0) await sleep(y);
    }
    return done;
  }

  /** 全速泵帧（纯物理，不需要真实时间） */
  async fast(n, opts = {}) { return this.pump(n, { chunk: opts.chunk || 30, yieldMs: 0 }); }

  /**
   * 泵帧直到 Phaser 状态 == target。
   * ⚠️ 静默失效自查：旧版超时后【默默返回】，调用方看不出没到目标 ⟹ 改成抛错。
   *    （opts.throwOnTimeout === false 可显式关掉）
   */
  async pumpUntilState(target, maxFrames = 900, yieldMs = 8, opts = {}) {
    let done = 0, cur = null, last = null;
    const log = [];
    while (done < maxFrames) {
      await this.pump(1, { yieldMs });
      done++;
      if (done % 3 === 0 || done < 5) {
        cur = await this.eval("(()=>{try{return GameManager.getGame().state.current}catch(e){return '?'}})()");
        if (cur !== last) { log.push(`${done}帧→${cur}`); last = cur; }
        if (cur === target) break;
      }
    }
    if (cur !== target) {
      cur = await this.eval("(()=>{try{return GameManager.getGame().state.current}catch(e){return '?'}})()");
      if (cur !== last) log.push(done + '帧→' + cur);
    }
    this.lastStateLog = log;
    if (cur !== target && opts.throwOnTimeout !== false) {
      throw new Error('pumpUntilState 超时：' + maxFrames + ' 帧内没到状态 ' + target +
        '，最后状态=' + cur + '；轨迹=' + log.join('|'));
    }
    return { frames: done, state: cur, log };
  }

  eval(expr, opts = {}) { return this.browser.evaluate(expr, this.sessionId, opts); }
  async snapshot() { return this.eval(SNAPSHOT); }
  async stats() { return this.eval('window.__vtStats()'); }

  // ---------- 开坦克 ----------
  /**
   * 装好「每帧喂输入」的钩子（默认只有一辆车 tank_a）。
   * ⚠️ 静默失效自查：旧版坦克 id 写错也返回 'installed'，之后每帧被钩子静默跳过
   *    ⟹ 现在先确认坦克在场上，否则抛错（waitRound:false 时请传 {requireTank:false}）。
   */
  async installControl(tankId, opts = {}) {
    const id = tankId ? JSON.stringify(tankId) : 'null';
    if (opts.requireTank !== false && tankId) {
      const exists = await this.eval(
        '(() => { try { var gc = GameManager.getGameController(); return !!(gc && gc.getTank(' + id + ')); } catch (e) { return false; } })()');
      if (!exists) {
        throw new Error('installControl: 场上没有坦克 ' + tankId +
          '（id 写错的话输入会静默失效）。若确实要在回合前安装，请传 {requireTank:false}');
      }
    }
    const r = await this.eval('window.__vtInstallControl(' + id + ')');
    if (r !== 'installed' && r !== 'already') throw new Error('installControl 返回异常: ' + JSON.stringify(r));
    return r;
  }

  /** 设定当前操控。只传要改的键：fwd / back / left / right / fire */
  async setControl(c) {
    const patch = {};
    for (const k of ['fwd', 'back', 'left', 'right', 'fire']) {
      if (c[k] !== undefined) patch[k] = !!c[k];
    }
    const r = await this.eval(`(() => {
      if (!window.__vtCtrl) throw new Error('__vtCtrl 不存在（clock.js 没注入？）');
      Object.assign(window.__vtCtrl, ${JSON.stringify(patch)});
      var exists = null;
      try { var gc = GameManager.getGameController(); exists = !!(gc && gc.getTank(window.__vtTankId)); } catch (e) {}
      return { ctrl: Object.assign({}, window.__vtCtrl), tank: window.__vtTankId, tankExists: exists };
    })()`);
    if (r.tankExists === false) {
      throw new Error('setControl: 受控坦克 ' + r.tank + ' 不在场上 —— 这样写下去输入会静默失效');
    }
    return r.ctrl;
  }

  /** 全清（松手） */
  async clearControl() {
    return this.eval(`(() => {
      var c = window.__vtCtrl;
      if (!c) throw new Error('__vtCtrl 不存在（clock.js 没注入？）');
      c.fwd = c.back = c.left = c.right = c.fire = false;
      return Object.assign({}, c);
    })()`);
  }

  async getControl() { return this.eval('Object.assign({}, window.__vtCtrl)'); }

  /**
   * 「不呈现」开关（默认关）—— 只关绘制、不碰物理/逻辑；可运行时开/关、可还原。
   *   enabled=true : canvas 隐藏 + 1×1，mode='full'(默认) 再把 renderer.render/postRender 置空
   *   enabled=false: 逐字还原（原函数按 own/prototype 归属还原，canvas 尺寸/display 还原）
   *   mode         : 'full'(默认) | 'canvas'（只做 canvas、不置空 render，用于拆分收益来源）
   * 返回页面侧自检对象（canvas 尺寸/display、render 是否已置空 Noop）；失败【抛错】、不静默降级。
   */
  async setNoRender(enabled, mode) {
    await this.eval(NORE_SRC);
    const r = await this.eval(`window.__vtSetNoRender(${enabled ? 'true' : 'false'}, ${JSON.stringify(mode || 'full')})`);
    const o = (typeof r === 'string') ? JSON.parse(r) : r;
    if (!o || o.err) throw new Error('setNoRender 失败: ' + JSON.stringify(o));
    return o;
  }

  /**
   * 直接把坦克传送到位姿 —— 训练阶段 1/2/3 的核心。
   * 不用重开回合（实测重开一回合要 94 秒游戏时间 + 25 秒空档）。
   * 注意：坐标必须是合法格心（每格 10 单位），传到墙里会被 verifyAndCorrectTankState 推开。
   *
   * ⚠️ 0-1（血的教训）：setTankState 在【回合开始前】会静默 return false，
   *    整个 teleport 被丢弃（x/y/rot 全不生效）。所以这里：
   *      ① 返回 setTankState 的【真实返回值】（成功路径是 undefined —— 游戏 API 没写 return）；
   *      ② 返回 false ⟹ 响亮抛错（带游戏状态）；
   *      ③ 再逐字段读回 getTank() 的 x/y/rot，不一致也抛错（opts.verify === false 可关）。
   */
  async teleport(tankId, x, y, rotation = 0, opts = {}) {
    const verify = opts.verify !== false;
    const id = JSON.stringify(tankId);
    const r = await this.eval(`(() => {
      var gc = GameManager.getGameController();
      var out = { gcState: gc ? gc.getState() : null, ret: null, hasRet: false };
      if (!gc) { out.err = 'no GameController'; return out; }
      var t0 = gc.getTank(${id});
      if (!t0) { out.err = 'no tank ' + ${id}; return out; }
      out.before = { x: t0.getX(), y: t0.getY(), rot: t0.getRotation() };
      var ts = TankState.withState(${id}, ${Number(x)}, ${Number(y)},
        false, false, ${Number(rotation)}, false, false, false, false);
      var ret = gc.setTankState(ts, false);
      out.hasRet = (ret !== undefined);
      out.ret = out.hasRet ? ret : null;
      out.gcStateAfter = gc.getState();
      var t1 = gc.getTank(${id});
      out.after = t1 ? { x: t1.getX(), y: t1.getY(), rot: t1.getRotation() } : null;
      return out;
    })()`);
    this.lastTeleport = r;
    if (r.err) throw new Error('teleport 失败：' + r.err + '（tank=' + tankId + '）');
    if (r.ret === false) {
      throw new Error('teleport 被 setTankState 拒绝：游戏状态=' + r.gcState +
        '（非 IN_ROUND 或玩家未激活时它会 return false）。' +
        '先 await match.waitForRound()（open() 默认已经等过）');
    }
    if (verify) {
      const a = r.after, bad = [];
      if (!a) bad.push('坦克读不到了');
      else {
        if (a.x !== Number(x)) bad.push('x 期望 ' + Number(x) + ' 读回 ' + a.x);
        if (a.y !== Number(y)) bad.push('y 期望 ' + Number(y) + ' 读回 ' + a.y);
        if (a.rot !== Number(rotation)) bad.push('rot 期望 ' + Number(rotation) + ' 读回 ' + a.rot);
      }
      if (bad.length) {
        throw new Error('teleport 后读回不一致（落墙里被纠正？）：' + bad.join('；') +
          '；before=' + JSON.stringify(r.before) + ' after=' + JSON.stringify(a));
      }
    }
    return r.hasRet ? r.ret : undefined;
  }

  /** 迷宫信息：尺寸 + 可达格位 + 出生点（阶段1「随机给可达位姿」的数据源） */
  async maze() {
    const r = await this.eval(`(() => {
      var gc = GameManager.getGameController();
      var mz = gc ? gc.getMaze() : null;
      if (!mz) return { err: 'no maze（回合还没初始化？）' };
      var cp = function (x) { try { return JSON.parse(JSON.stringify(x || [])); } catch (e) { return []; } };
      return { width: mz.width, height: mz.height,
               reachable: cp(mz.reachable), tankPositions: cp(mz.tankPositions),
               spawns: cp(mz.tankSpawnPositions), crates: cp(mz.crateSpawnPositions) };
    })()`);
    if (r.err) throw new Error('maze(): ' + r.err);
    return r;
  }

  /**
   * 结束当前回合。
   * ⚠️ 静默失效自查：游戏 endRound 在非 IN_ROUND 时只 log.error ⟹ 旧版返回 'ok' 骗人。
   */
  async endRound(victoryAward) {
    const r = await this.eval(`(() => {
      var gc = GameManager.getGameController();
      if (!gc || !gc.endRound) return { err: 'no GameController.endRound' };
      var inRound = (typeof GameModel !== 'undefined' && GameModel._STATES) ? GameModel._STATES.IN_ROUND : 'in round';
      var before = gc.getState();
      if (before !== inRound) return { refused: true, before: before, inRound: inRound };
      gc.endRound(${victoryAward ? 'true' : 'false'});
      return { before: before, after: gc.getState() };
    })()`);
    if (r.err) throw new Error('endRound: ' + r.err);
    if (r.refused) throw new Error('endRound 被游戏拒绝：当前状态=' + r.before + '（只有 ' + r.inRound + ' 受理）');
    if (r.after === r.before) throw new Error('endRound 调用后状态没变（还是 ' + r.after + '）—— 可能被静默丢弃');
    return r;
  }

  /** 我方坦克即时状态（比 snapshot 便宜很多） */
  async myTank() {
    return this.eval(`(() => {
      var gc = GameManager.getGameController();
      var t = gc && gc.getTank(window.__vtTankId);
      if (!t) return null;
      return { id: window.__vtTankId, x: +t.getX().toFixed(3), y: +t.getY().toFixed(3),
               rot: +t.getRotation().toFixed(5) };
    })()`);
  }

  /** 场上弹丸数（便宜） */
  async projectileCount() {
    return this.eval(`(() => {
      var gc = GameManager.getGameController();
      var d = __vtData(gc.getRoundState()) || {};
      return (d.projectileStates || []).length;
    })()`);
  }

  /** 抓一张真实截图（调试用，默认不在训练循环里用） */
  async screenshot(file) {
    const r = await this.browser.send('Page.captureScreenshot', { format: 'png' }, this.sessionId);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  async close() {
    try { if (this.targetId) await this.browser.closePage(this.targetId); } catch (e) {}
    try { await this.browser.close(); } catch (e) {}
    try { await this.srv.close(); } catch (e) {}
  }
}

module.exports = { Match };

// ---------------- CLI ----------------
if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const num = (name, d) => { const i = argv.indexOf('--' + name); return i < 0 ? d : Number(argv[i + 1]); };
    const flag = (name) => argv.includes('--' + name);

    const frames = num('frames', 600);
    const m = new Match();
    try {
      const t0 = Date.now();
      // G2 场景参数（向后兼容：不给 --players 就是老行为：1 辆 tank_a + 1 个原生 Laika）
      const players = (() => { const i = argv.indexOf('--players'); return i < 0 ? undefined : Number(argv[i + 1]); })();
      const storm = flag('storm');
      const crates = flag('no-crates') ? [] : undefined;
      await m.open({ verbose: flag('verbose'), players, storm, crates, control: players === undefined });
      const openMs = Date.now() - t0;
      const s0 = await m.snapshot();
      const t1 = Date.now();
      await m.fast(frames);
      const simMs = Date.now() - t1;
      const s1 = await m.snapshot();
      if (flag('shot')) await m.screenshot(path.join(__dirname, 'shot.png'));

      const brief = (s) => ({
        stage: s.stage, scores: s.scores,
        tanks: s.tanks.map((t) => `${t.id}@(${t.x},${t.y})`),
        projs: s.projectiles.length, weapons: s.weapons.map((w) => `${w.owner}:${w.fired}/${w.bullets}`),
      });
      console.log(JSON.stringify({
        ok: true,
        openMs,
        simulatedFrames: frames,
        simMs,
        framesPerSec: +(frames / (simMs / 1000)).toFixed(0),
        bootstrap: m.bootstrap,
        stateLog: m.lastStateLog,
        before: brief(s0),
        after: brief(s1),
        virtualT: s1.virtualT,
        vtStats: await m.stats(),
        pageErrors: m.pageErrors.slice(0, 3),
      }, null, 2));
    } catch (e) {
      console.error('FAILED:', (e && e.stack) || e);
      process.exitCode = 1;
    } finally { await m.close(); }
  })();
}
