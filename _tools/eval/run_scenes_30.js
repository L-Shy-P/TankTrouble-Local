/**
 * run_scenes_30.js —— 固定 30 场景评测跑局器（G2 / 子代理 2026-10-17）
 * ==========================================================================
 * 干什么：
 *   · 读 `D:/vt_run/eval/scenes_30.json`（定稿 md5 f6d1d3b247cf122f1d1e2781ba3ad81c）
 *   · 每场景一局：`players` / `storm` / `crates` 按清单；我方 1 辆 vantage_1，其余 laikaX_i
 *   · 每帧经 `_tools/headless/_g1_inject.js` 读观测 → 问策略服务端（VT_CKPT）→ 回填动作 → 泵帧
 *   · 输出【每场景恰好一行 JSON】，字段照 `evaluate_30.py` 的 RUN_CONTRACT：
 *       {"scene_id","ok","win":1|0|null,"result","frames","players","mapW","mapH","storm","crates_on","err"}
 *     ⟹ 直接 `py -3.13 _tools/eval/evaluate_30.py --ingest <结果.jsonl>`
 *
 * 用法：
 *   node _tools/eval/run_scenes_30.js --all [--only p4_storm] [--cap 3600] [--out D:/vt_run/eval]
 *   node _tools/eval/run_scenes_30.js --scene '<场景JSON>'     # 单场景（给 evaluate_30.py --runner-cmd 用）
 *
 * 纪律：
 *   · ⛔ 不静默失败：场景异常写进该行 err、stderr 打 traceback；失败仍输出一行（win=null）
 *   · ⛔ 不停在随机权重上：必须 VT_CKPT 且服务端 stderr 出现 CKPT_LOADED，否则直接退出
 *   · ⛔ 不 DEVNULL stderr：服务端 stderr 逐行转发
 *   · 产出全写 D:/vt_run/（TMP/TEMP/VT_TMP_DIR 都指过去）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ⚠️ 纪律 2c：pyserver.js 的日志走 os.tmpdir()（= C:）⟹ 显式指到 D:
try {
  fs.mkdirSync('D:/vt_run/tmp', { recursive: true });
  process.env.TMP = 'D:/vt_run/tmp';
  process.env.TEMP = 'D:/vt_run/tmp';
  process.env.VT_TMP_DIR = 'D:/vt_run';
} catch (e) {}

const { Match } = require('../headless/match');
// ⭐ 2026-10-17：观测→segs 共享模块（评测/采集/面板应共用；本轮只接了评测侧）
const SEGS = require('../headless/_segs.js');

const REPO = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'headless', '_g1_inject.js'), 'utf8');
const DEF_SCENES = 'D:/vt_run/eval/scenes_30.json';
const DEF_OUT = 'D:/vt_run/eval';
const DEF_CKPT_SEARCH = ['D:/vt_run/cyc_1/ckpt/model_latest.pt', 'D:/vt_run/ckpt/model_latest.pt', 'D:/vt_run/seed/ckpt/model_latest.pt'];
// ⭐ 2026-10-17（父代理裁定）：评测射击开关**默认 1**（与游戏/采集路径一致）；`--fire 0` 可显式关掉。
//   理由：采集与真游戏都开火，评测不开火 ⟹ 测的是另一个策略 ⟹ 那个数没有代表性。
const FIRE_ON = !!Number(process.env.S30_FIRE || (process.argv.indexOf('--fire') >= 0 ? (process.argv[process.argv.indexOf('--fire') + 1] || 1) : 1));
// ⭐ 2026-10-17（父代理指派）：**可复现** —— 每场给固定 RNG 序列（LCG 生成），经 `m.open({rngSeq})`
//   在页面第一条脚本之前接管 `Math.random`（见 match.js:245-252）⟹ 地图/道具/Laika AI 全部可复现。
//   `--no-fix-rng` 可关（回到旧行为：地图每次随机）。
const RNG_FIX = !(process.argv.indexOf('--no-fix-rng') >= 0);
const RNG_SEQ_LEN = Number(process.env.S30_RNG_LEN || 150000);
function lcgSeq(seed, n) {
  let s = (seed >>> 0) || 1;
  const a = new Array(n);
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; a[i] = s / 4294967296; }
  return a;
}
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('00000000' + h.toString(16)).slice(-8);
}
// ⭐ 2026-10-17（父代理裁定）：**策略采样种子确定性派生** seed = f(scene_id, frameIndex)
//   ⛔ 不用 Date.now()/全局递增/Math.random()；同一 scene + 同一帧 ⟹ 永远同一个 seed ⟹ 采样可复现
const SEED_MODE = 'deterministic';
// ⭐ 2026-10-17：`--repeat k`（每场跑 k 次取中位；k=1 为旧行为）
// ⭐⭐⭐ S30_DUMP（父代理 2026-10-18）：把**评测路径**每帧导出成训练数据。
//   动机：采集器（inject_fire.js）那条路 22000 帧零死亡 ⟹ 训练数据没有 win/lose/kill/death；
//        而评测路径（_g1_inject.js）同场景 302 帧就 victory ⟹ **必须从评测路径采数据**。
const DUMP_DIR = process.env.S30_DUMP || null;
// ⭐ S30_DUMP_MAX：每局只保留【最后 N 帧】（滚动缓冲）。
//   原因：节点 token 表随树增长（N 可达 1000 × 10 维）⟹ 全量导出实测 22 局就 3.5G，直接把磁盘写满。
//   取舍：胜负信号在末帧，GAE 从末帧往回传 ⟹ 保留末段即可（默认 400 帧）。
const DUMP_MAX = Math.max(0, Number(process.env.S30_DUMP_MAX || 400));
// ⭐ A 相请求开关（默认 0=关）：开了会慢且部分帧服务端报错，B 相不受影响
const S30_APHASE = process.env.S30_APHASE === '1';
// ⭐⭐⭐ S30_DUMMY=1【靶场模式】：把**除 Vantage 外的所有 AI 变成静止靶**（主人 2026-10-18 专项训练方案）。
//   用途：大图 + 7 个不动靶 + 毒雾 ⟹ 时间有限，必须尽快清场 ⟹ 逼它学会"移动+瞄准射击"。
//   做法：每帧把非 vantage 的 aiManager 的 storedStates 全置 false（= 一个键都不按）。
const S30_DUMMY = process.env.S30_DUMMY === '1';
const REPEAT_K = Math.max(1, Number(process.env.S30_REPEAT || (process.argv.indexOf('--repeat') >= 0 ? (process.argv[process.argv.indexOf('--repeat') + 1] || 1) : 1)));
// ⭐ 2026-10-17（父代理指派）：请求超时 + 有限重试（【无出处、待实验】的 10s / 2 次）
const ASK_TIMEOUT_MS = Math.max(500, Number(process.env.S30_ASK_MS || 10000));
const ASK_RETRY = Math.max(0, Number(process.env.S30_ASK_RETRY || 2));
function seedFor(sceneId, f) {
  const base = fnv1aHex(String(sceneId));
  return (((Math.imul(base, 1000003) >>> 0) + (f >>> 0)) >>> 0) % 2147483647;
}
function fnv1aHex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

const logErr = (s) => process.stderr.write(String(s) + '\n');
const outLine = (s) => process.stdout.write(String(s) + '\n');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? dflt : process.argv[i + 1];
}
function flag(name) { return process.argv.includes('--' + name); }
function md5file(p) { try { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'); } catch (e) { return null; } }

/* ---------------- 策略服务端客户端（一问一答；stderr 逐行转发） ---------------- */
class Srv {
  constructor(ckpt) {
    this.ckpt = ckpt; this.err = []; this.boot = []; this.buf = ''; this.q = []; this.waiters = []; this.exited = null;
    this.start();
  }
  start() {
    this.exited = null; this.err = []; this.boot = []; this.buf = ''; this.q = []; this.waiters = [];
    this._ready = false; this.ckLine = null;
    this.p = spawn('py', ['-3.13', '_tools/training/policy_server_graph.py'],
      { cwd: REPO, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', VT_CKPT: this.ckpt }) });
    this.p.stdout.setEncoding('utf8');
    this.p.stdout.on('data', (d) => {
      this.buf += d; let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        if (line.trim()) this.boot.push(line);
        if (this.waiters.length) this.waiters.shift()(line); else this.q.push(line);
      }
    });
    this.p.stderr.setEncoding('utf8');
    this.p.stderr.on('data', (d) => {
      String(d).split('\n').forEach((l) => { if (l.trim()) { this.err.push(l); logErr('SRV_STDERR ' + l); } });
    });
    this.p.on('exit', (c) => { this.exited = c; logErr('SRV_EXIT code=' + c); });
  }
  line(ms) {
    if (this.q.length) return Promise.resolve(this.q.shift());
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('等服务端一行超时(' + ms + 'ms)')), ms || 120000);
      this.waiters.push((l) => { clearTimeout(t); res(l); });
    });
  }
  /**
   * ⭐ 2026-10-17（父代理指派）：**带超时 + 有限重试**的请求
   *   · 单次超时 `ASK_TIMEOUT_MS`（默认 10000，【无出处、待实验】）
   *   · 超时/异常最多重试 `ASK_RETRY` 次（默认 2 ⟹ 共 3 次）
   *   · 全失败 ⟹ 抛 `err.code='ask_timeout'`，调用方把该场标 `ok:false` 并**继续下一场**（⛔ 不许整批挂死）
   */
  async askTO(o, stat) {
    if (!this.stat) this.stat = { ok: 0, timeouts: 0, retries: 0, maxMs: 0, fails: 0 };
    const st = stat || this.stat;
    const payload = JSON.stringify(o) + '\n';
    let lastErr = null;
    for (let attempt = 0; attempt <= ASK_RETRY; attempt++) {
      if (attempt > 0) { st.retries++; logErr('ASK_RETRY ' + attempt + '/' + ASK_RETRY + '（服务端可能已死）'); }
      const t0 = Date.now();
      try {
        this.p.stdin.write(payload);
        const line = await this.line(ASK_TIMEOUT_MS);
        const dt = Date.now() - t0;
        if (dt > st.maxMs) st.maxMs = dt;
        st.ok++;
        return JSON.parse(line);
      } catch (e) {
        const dt = Date.now() - t0;
        if (dt > st.maxMs) st.maxMs = dt;
        lastErr = e;
        st.timeouts++;
        logErr('ASK_TIMEOUT attempt=' + (attempt + 1) + '/' + (ASK_RETRY + 1) + ' ms=' + dt + ' err=' + String((e && e.message) || e).slice(0, 120));
      }
    }
    st.fails++;
    const err = new Error('ask 超时/失败（' + (ASK_RETRY + 1) + ' 次都失败）: ' + String((lastErr && lastErr.message) || lastErr).slice(0, 200));
    err.code = 'ask_timeout';
    throw err;
  }
  async bootUntil(mark, maxLines) {
    for (let i = 0; i < (maxLines || 15); i++) {
      const l = await this.line(180000);
      if (l.indexOf(mark) >= 0) return i + 1;
    }
    throw new Error('开机 ' + maxLines + ' 行里没出现 ' + mark);
  }
  async ensureReady() {
    if (this.exited !== null) { logErr('SRV 已退出（code=' + this.exited + '），重启'); this.start(); }
    if (!this._ready) {
      await this.bootUntil('WARMUP_SAMPLE', 15);
      const ck = this.err.concat(this.boot).find((l) => l.indexOf('CKPT_LOADED') >= 0);
      if (!ck) {
        throw new Error('⛔ 策略服务端【没有 CKPT_LOADED】—— 随机权重跑出的胜率无意义；stderr 前几行：' +
          JSON.stringify(this.err.slice(0, 3)));
      }
      this.ckLine = ck; this._ready = true;
    }
  }
  async close() {
    try { this.p.stdin.end(); } catch (e) {}
    await new Promise((r) => { const k = setTimeout(() => { try { this.p.kill(); } catch (e) {} r(); }, 3000); this.p.on('exit', () => { clearTimeout(k); r(); }); });
  }
}

/* ---------------- 单场景 ---------------- */
async function runScene(scene, srv, cap) {
  const dumpFrames = [];      // ⭐ S30_DUMP 缓冲（本场）
  let s30segs = null, s30p = null, s30n = 0, s30pA = null;
  let s30still = 0, s30empty = 0;   // ⭐ 帧级作用域：静止帧 / 空放帧   // ⭐ S30_DUMP：本帧 segs/p + 原始帧计数
  // ⭐⭐⭐ 2026-10-18（父代理派单「补齐 rewards.py 读取但 dump 里没有的奖惩字段」）：
  //   下面这些**全部是帧级作用域**（⛔ 不能用块内 const/let —— 否则 dump 那侧引用不到；
  //   上一轮 `still`/`empty_fire` 正是栽在这里：逐帧 `r` 里只有"终局覆盖"那 1 帧有值）。
  let s30hit = 0;        // 我方子弹命中对手（内核里必然致死；证据见 `_g1_inject.js` 的 deadly 事件注释）
  let s30crate = 0;      // 我方吃到道具（COLLECTIBLE_DESTROYED 且 picker=我方）
  let s30selfhit = 0;    // 我方子弹打自己（= rewards 的 selfkill 数据源）
  let s30shieldhit = 0;  // 我方子弹打【对手护盾】（只反弹、不致死）——诊断项，不是 rewards 的 hit
  let s30spawn = 0, s30kill = 0, s30death = 0, s30oppFire = 0;
  let s30aim = 0, s30aimDeg = null, s30tmin = null, s30tminD = null, s30tminLive = null, s30dbg = null;
  const dFiredBy = {};                       // 每个玩家的 `_bulletsFired`（累计值）上一帧快照
  let tminShot = null, tminDeath = null, mperSticky = null;   // t_min 口径用的粘住值（口径见下面的注释）
  let s30lastOppFirePid = null, dOppFire3 = false, s30spawnTmin = null, mperSrc = null;
  const evTot = { evN: 0, evOver: 0, deadlyAll: 0, deadlyMine: 0, deadlySelf: 0, deadlyOppOnMe: 0,
                  deadlyOppSelf: 0, killEv: 0, pickAll: 0, pickMine: 0, shieldMine: 0 };
  // ⭐ 稠密奖励用的上一帧状态（父代理 2026-10-18：终局 ±3 太稀 ⟹ 需逐帧信号）
  // ⚠️ 2026-10-18：旧的 4 个"上一帧"标量（`dLastFired`/`dLastKill`/`dLastDeath`/`dLastPose`）与 `s30dense`
  //   已被下面的 `dFiredBy`（逐玩家累计开火快照）+ `dPrevAlive`（存活集合）取代，删掉以免有人以为它们还在生效。
  let dPrevAlive = null;   // ⭐ 上一帧 {me, opp} 存活计数（判死用）
  let fireOnFrames = 0;    // ⭐ 策略说"开火"的帧数（验证真的策略驱动）
  let stillFrames = 0, emptyFireFrames = 0;   // ⭐ 静止帧 / 空放帧（验证两个惩罚真的在生效）
  let emptyFireUnknown = 0;   // ⭐ "想开火但 ammoLeft 是 -1（取不到）" 的帧数 —— ⛔ 不当空放，只计数
  let ammoMin = null, ammoMax = null;   // ⭐ ammoLeft（global[15]）的取值范围，用于核"空放=0 是不是真的没有" 
  let dummyN = 0, s30DummyErr = null, dummyPatched = false, vidOfScene = 'vantage_1', vantageDeadAt = null;   // ⭐ 靶场模式：被清成静止靶的对手数
  let growOkFrames = 0;    // ⭐ A 相拿到 grow 决策的帧数（验证 A 数据真的进来了）
  let s30AErr = null;
  const r = {
    scene_id: scene.id, ok: false, win: null, result: 'unknown', frames: 0,
    players: scene.players, mapW: null, mapH: null, storm: !!scene.storm, crates_on: !!scene.crates_on, err: null,
  };
  let m = null, f = 0, nodeId = 0, ended = false;
  let lpTot = 0, lpFin = 0, oob = 0, srvErr = 0, nSamples = 0, stormFrames = 0, cratesMax = 0;
  let oppNativeFrames = 0, oppBlocksSeen = 0, oppMultiFrames = 0, oppOver = 0;   // ⭐ oppMultiFrames=多对手帧数、oppOver=对手数>8 的帧数（显式计数）
  let warnedOpp = false;
  const aliveTrace = [];               // ⭐ 每 60 帧一行：{f,nAlive,alive[]}
  let nAliveMin = null, nAliveMax = 0, aliveTraceErr = null;
  const t0 = Date.now();
  // ⭐ 2026-10-17：本场请求统计（超时/重试/最大耗时）—— 落进结果行
  const askStat = { ok: 0, timeouts: 0, retries: 0, maxMs: 0, fails: 0 };
  try {
    m = new Match();
    // ⭐ 可复现：每场固定 RNG 序列（`--no-fix-rng` 关闭）⟹ 同一 scene 两次跑地图必须一致
    // ⭐ S30_SEED_SALT：给 scene.seed 加盐 ⟹ 同一场景出【全新地图】。
    //   用途：① 生成训练集市多样性（同一场景多盐 = 多个不同地图的对局）
    //        ② 训练/留出集彻底隔离（训练用盐 1000~4000，留出集用 50000）
    const SEED_SALT = Number(process.env.S30_SEED_SALT || 0);
    const mazeSeed = (((Number(scene.seed) || 1) + SEED_SALT) * 100003 + 7) >>> 0;
    const openOpts = { humanIds: [], players: scene.players, storm: !!scene.storm,
                   crates: scene.crates, control: false, epoch: scene.epoch };
    // ⭐⭐⭐ 2026-10-19 主人要"能看训练"：S30_VISIBLE=1 ⟹ 开【有头】浏览器窗口，直接看着它打。
    //   `match.js:226` / `cdp.js:149` 已支持 headless:false。
    //   窗口里你还能点地图（触发 debugTarget 点击寻路）来"干扰"它。
    if (process.env.S30_VISIBLE === '1') openOpts.headless = false;
    if (RNG_FIX) openOpts.rngSeq = lcgSeq(mazeSeed, RNG_SEQ_LEN);
    await m.open(openOpts);
    r.mazeSeed = RNG_FIX ? mazeSeed : null;
    r.rngSeqLen = RNG_FIX ? RNG_SEQ_LEN : 0;
    // ⭐ 策略采样种子：确定性派生（同一 scene 同一帧 ⟹ 同一 seed）；记录前 5 个便于核对
    r.seedMode = SEED_MODE;
    r.seedSample = [0, 1, 2, 3, 4].map((k) => seedFor(scene.id, k));
    const boot = m.bootstrap || {};
    r.ai_ids = boot.aiIds || [];
    r.vantage_id = (boot.vantageIds || [])[0] || null;
    r.storm_flag = boot.stormFlag || null;
    r.storm_spawn = m.stormSpawn || null;
    const maze = await m.maze();
    r.mapW = maze.width; r.mapH = maze.height;
    // ⭐ mazeHash：对迷宫网格做稳定 hash（同一 scene 两次跑必须相同 ⟹ 可复现的硬证据）
    try {
      const sig = await m.eval(`(() => {
        var gc = GameManager.getGameController(); var mz = gc ? gc.getMaze() : null;
        if (!mz) return null;
        var t = null;
        try { t = mz.getTiles ? mz.getTiles() : ((mz.data && mz.data.tiles) || mz.tiles || null); } catch (e) {}
        var s = 'W' + mz.width + 'H' + mz.height + '|';
        if (t && t.length) {
          for (var y = 0; y < t.length; y++) {
            var row = t[y];
            if (row && row.length !== undefined) { for (var x = 0; x < row.length; x++) { var c = row[x]; s += (c && c.type !== undefined) ? c.type : (typeof c === 'number' ? c : '#'); } s += '/'; }
            else s += String(row) + '/';
          }
        } else { s += JSON.stringify(mz.reachable || null) + JSON.stringify(mz.tankPositions || null); }
        return { sig: s, w: mz.width, h: mz.height };
      })()`);
      if (sig && sig.sig) { r.mazeSigLen = sig.sig.length; r.mazeHash = fnv1a(sig.sig); }
    } catch (eMH) { r.mazeHash = null; r.mazeHashErr = String((eMH && eMH.message) || eMH).slice(0, 200); }

    await m.eval(SRC);
    await m.eval('window.__g1.subscribe()');
    await m.eval('window.__g1.setup()');
    // ⭐ 2026-10-17：射击开关（默认 0 = 原口径不变；`--fire 1` 才发 picks[1] 射击帧，用于验"打得多有没有用"）
    await m.eval('window.__g1.setFire(' + (FIRE_ON ? 1 : 0) + ')');
    const meta = JSON.parse(await m.eval('JSON.stringify(window.__g1.meta())'));
    const vid = meta.vid;
    // ⭐ 算 `t_min`（子弹最短飞行帧数）要用的物理常数（由页面 `Constants` 只读导出，⛔ 不在采集侧写死）
    const K = (meta && meta.k) || {};
    r.k = K;
    if (!vid) throw new Error('场上没有 VantageAIManager（meta.vid=null）');
    r.vantage_id = vid;
    const inRound = (meta.states && meta.states.IN_ROUND) || 'in round';

    for (f = 0; f < cap; f++) {
      const o = JSON.parse(await m.eval('window.__g1.step(' + nodeId + ')'));
      if (o.err) { r.step_err = String(o.err).slice(0, 400); break; }
      if (f > 5 && o.state && o.state !== inRound) { ended = true; break; }
      if (o.N >= 1) {
        // ⭐ 【多对手：送全量】（2026-10-17 派单①）：
        //   `vantage_observe.js` 的 oppTok 是【每个对手 15 维】拼起来的（1v1=15，4人=45，8人=105；
        //   OPP_FIELDS=[ox,oy,orot,oFwd,...,oAlive(7),...]），而 `net_v2_fixed` 的 opp 槽是 (8,15)（派单① 已扩口）
        //   ⚠️ 历史：opp 槽还只有 1 行时，多对手会被服务端以"段 opp 超容量"拒绝（实测 8 人局 lp_finite 0/2999）。
        //   => 现在：逐 15 维切成最多 8 行、其余补零、**送全量**（⛔ 不再只取 nearestAlive 1 行）
        //      记 `opp_input/opp_rows_max/opp_over`；>8 个对手 ⟹ 显式计数（⛔ 不静默截断）。
        // ⭐ 2026-10-17（父代理指派）：统一走 `_tools/headless/_segs.js`（⛔ 本文件不再自己展开 opp）
        let segs = null, _segStats = null;

        try {
          const built = SEGS.buildSegs({
            n: o.segs.node,
            opp: (o.segs.opp && o.segs.opp[0]) || [],
            b: o.segs.bullet, item: o.segs.item,
            g: (o.segs.global && o.segs.global[0]) || []
          });
          const vio = SEGS.validateSegs(built.segs);
          if (!vio.ok) { r.step_err = 'segs 形状不合法（⛔ 拒绝发送）: ' + vio.errors.slice(0, 4).join('; '); break; }
          segs = built.segs; _segStats = built.stats; s30segs = segs;
          const nBlocks = _segStats.oppBlocks;
          if (nBlocks > oppBlocksSeen) oppBlocksSeen = nBlocks;
          if (_segStats.oppOver > 0) { oppOver++; if (oppOver <= 3) logErr('⚠️ OPP_OVER[' + scene.id + '] ' + nBlocks + ' 个对手 > 槽位 8（显式计数、不静默截断）'); }
          if (nBlocks > 1) oppMultiFrames++; else oppNativeFrames++;
          if (nBlocks > 1 && !warnedOpp) {
            warnedOpp = true;
            logErr('⭐ OPP_FULL[' + scene.id + '] oppTok=' + (((o.segs.opp && o.segs.opp[0]) || []).length) + '（' + nBlocks + ' 个对手） -> 共享模块 _segs.js 切片 + 补零');
          }
        } catch (eSg) { r.step_err = 'buildSegs 异常: ' + String((eSg && eSg.message) || eSg).slice(0, 300); break; }
        if (false) {   // ⛔ 旧的内联 opp 展开已由 _segs.js 取代（2026-10-17）；保留空壳仅为减少本次 diff，下一轮删掉
          const opp = segs.opp[0];
          const PER = 15;
          {   // ⭐ 无论几个对手都【送满 8 行】（1 个对手 = 1 行真 + 7 行零）
            const SLOTS = 8;                     // ⭐ 与服务端 mk() 的 opp 槽 (B,8,15) 同源
            const nBlocks = Math.floor(opp.length / PER);
            if (nBlocks * PER !== opp.length) throw new Error('oppTok 长度 ' + opp.length + ' 不是 15 的整数倍 —— 拒绝猜块边界');
            if (nBlocks > oppBlocksSeen) oppBlocksSeen = nBlocks;
            if (nBlocks > SLOTS) { oppOver++; if (oppOver <= 3) logErr('⚠️ OPP_OVER[' + scene.id + '] ' + nBlocks + ' 个对手 > 槽位 ' + SLOTS + '（显式计数、不静默截断）'); }
            const eight = [];
            for (let b = 0; b < SLOTS; b++) {
              eight.push(b < nBlocks ? opp.slice(b * PER, (b + 1) * PER) : new Array(PER).fill(0));
            }
            segs = Object.assign({}, segs, { opp: eight });
            if (nBlocks > 1) oppMultiFrames++; else oppNativeFrames++;
            if (nBlocks > 1 && !warnedOpp) {
              warnedOpp = true;
              logErr('⭐ OPP_FULL[' + scene.id + '] oppTok=' + opp.length + '（' + nBlocks + ' 个对手）'
                     + ' -> 送 8 行（全量切片 + 补零）；opp 槽 = (8,15)');
            }
          }
        }
        // ⭐⭐⭐ A 相请求（父代理 2026-10-18）：评测路径原来【只问 B 相】⟹ dump 里没有 act.grow
        //   ⟹ A 网（生长）永远没有梯度（ent_grow 恒 0）。这里补上 A 相：
        //   从节点 token 算 grow_ok（叶子 且 hasGrown=0），带 phase:'A' 问一次。
        let pA = null;
        try {
          const _nk = (segs && segs.node) ? segs.node : null;
          // ⚠️ 默认【关闭】A 相（`S30_APHASE=1` 才开）：
          //   实测开了之后部分帧服务端报 `cannot sample n_sample > prob_dist.size(-1)`
          //   ⟹ 该场一直重试到 cap（12 分钟才跑 1 场）⟹ 采集变慢且脏。B 相数据不受影响。
          if (S30_APHASE && _nk && _nk.length > 1) {
            const _isParent = new Array(_nk.length).fill(0);
            for (let qi = 1; qi < _nk.length; qi++) {
              const _pi = _nk[qi][1] | 0;
              if (_pi > 0 && _pi < _nk.length) _isParent[_pi] = 1;
            }
            const _gok = new Array(_nk.length).fill(0);
            let _cnt = 0;
            for (let qi = 1; qi < _nk.length; qi++) {
              const _hg = _nk[qi][9] | 0;
              if (!_isParent[qi] && !_hg) { _gok[qi] = 1; _cnt++; }
            }
            if (_cnt > 0) {
              pA = await srv.askTO({ N: o.N, seed: seedFor(scene.id, f) + 1, mem_on: 0,
                                      phase: 'A', grow_ok: _gok, segs: segs }, askStat);
              s30pA = pA;
              if (pA && pA.grow) growOkFrames++;
            }
          }
        } catch (eA) { if (!s30AErr) s30AErr = String((eA && eA.message) || eA).slice(0, 160); }
        let p = null;
        try { p = await srv.askTO({ N: o.N, seed: seedFor(scene.id, f), segs: segs }, askStat); lpTot++; }
        catch (eA) {
          r.step_err = 'server: ' + String((eA && eA.message) || eA).slice(0, 300);
          if (eA && eA.code === 'ask_timeout') {
            // ⭐ 该场标 ok:false + reason，**继续跑下一场**（⛔ 不许整批挂死）；并杀掉可能已僵死的服务端
            r.ok = false; r.reason = 'ask_timeout';
            logErr('⛔ ASK_TIMEOUT_SCENE[' + scene.id + '] 该场放弃（ok:false reason=ask_timeout），继续下一场');
            try { srv.p.kill(); } catch (eK) {} srv.start();
          }
          break;
        }
        s30p = p;   // ⭐ S30_DUMP
        if (p) {
          if (p.err) { srvErr++; if (srvErr <= 2) logErr('SRV_ERR[' + scene.id + '] ' + String(p.err).slice(0, 200)); }
          else {
            if (typeof p.lp === 'number' && isFinite(p.lp)) lpFin++;
            if (typeof p.nodeId === 'number') { if (p.nodeId < 0 || p.nodeId >= o.N) oob++; else nodeId = p.nodeId; }
          }
        }
      }
      // ⭐ S30_DUMP：每帧落一条（obs 直接用已过 SEGS.validateSegs 的 segs ⟹ 与服务端同源）
      // ⭐⭐ 父代理 2026-10-18：补 `still` / `empty_fire` 两个信号
      //   ⛔ 之前评测路径的 dump 里【根本没有这两个字段】⟹ rewards.py 的静止惩罚和空放惩罚恒为 0，从未生效。
      //   `still` = 本帧执行的 inputs 全 false（注入器 `o.execStill`）；
      //   `empty_fire` = 想开火但没子弹（act.fire=1 且 global[15]=ammoLeft<=0）。
      //   ⚠️ `_g1_inject.js` 没有 `execStill`；但它导出 `out.sub` = 本帧【真实提交】的 5 个键（mgr.storedStates）⟹ 用它对。
      //   ⛔ 必须写到【帧级作用域】的 s30still/s30empty，不能用块内 const（否则 dump 那侧引用不到 ⟹ `_stillF is not defined`）
      try {
        const _sb = (o && o.sub) || null;
        s30still = (_sb && !(_sb.f || _sb.b || _sb.l || _sb.r)) ? 1 : 0;
      } catch (eSF) { s30still = 0; }
      try {
        const _gg = (s30segs && s30segs.global && s30segs.global[0]) || null;
        const _ammo = _gg ? _gg[15] : null;          // global[15] = ammoLeft
        const _ft = (s30p && s30p.fire) ? 1 : 0;
        // ⚠️ 2026-10-18 修：`ammoLeft` 的 **-1 是"取不到"的哨兵**（`vantage_observe.js` 武器段：
        //   取不到先给 -1，不是 0）⟹ 旧写法 `_ammo <= 0` 会把"取不到"当成"真没子弹"，
        //   凭空多记一次空放（正是 AGENTS.md 里「读不到 ≠ 真的没有」那类坑）。
        //   现在只认 `_ammo === 0`（= 真的空），`-1` 单独计 `emptyFireUnknown`（⛔ 不当空放）。
        s30empty = (_ft && _ammo === 0) ? 1 : 0;
        if (_ft && typeof _ammo === 'number' && _ammo < 0) emptyFireUnknown++;
        if (typeof _ammo === 'number' && _ammo >= 0) {
          if (ammoMin === null || _ammo < ammoMin) ammoMin = _ammo;
          if (ammoMax === null || _ammo > ammoMax) ammoMax = _ammo;
        }
      } catch (eEF) { s30empty = 0; }
      if (s30still) stillFrames++;
      if (s30empty) emptyFireFrames++;
      // ═══════════════════════════════════════════════════════════════════════════════
      // ⭐⭐⭐ 2026-10-18（父代理派单）：**逐帧奖励字段**——全部来自只读遥测，算不出就 null
      //   ① `hit`      : 本帧我方子弹命中对手的次数（`TANK_DEADLY_COLLISION` 且 shooter=我方、victim≠我方）
      //                  ⚠️ 内核里这条事件**必然**紧跟 `killTank` + `destroyProjectile` ⟹ **每次命中都致死**
      //                     ⟹ `hit == kill` ⟹ `rewards` 的 `hit_nonlethal = hit-kill = 0`（结构性的 0，不是没采到）
      //   ② `crate`    : 本帧我方吃到道具（`COLLECTIBLE_DESTROYED` 且 `Pickup.playerId`=我方）——归属由游戏给
      //   ③ `t_min`    : 口径=「从**炮口**到**最近存活对手外壳**的直线距离 ÷ **实测子弹每帧位移**」，向上取整；
      //                  取**最近一次真发射那一帧**算出的值（`rewards._speed_part` 的 `T_kill` 也是从"最近一次真发射"起算，
      //                  两者必须同一起点）。本帧算不了（如对手刚死）⟹ 沿用最近一次实测值；从没测到 ⟹ null。
      //                  `t_min_death` 用同一公式，但起点是**对手炮口**、终点是**我方外壳**（距离对称）。
      //   ④ `aim`      : 最近存活对手是否在**炮口方向 ±20°** 内（0/1）。⚠️ 炮口方向 = `rot − π/2`，**不是** `rot`
      //                  （出处：`game_core/js/7b2ed8ad…js` 坦克速度 `speedX=Math.sin(rot)*speed, speedY=-Math.cos(rot)*speed`
      //                    + `game_core/js/vantage_tree.js:4397` 炮口 `dx=Math.sin(rot), dy=-Math.cos(rot)`）
      //                  ⟹ 旧代码 `atan2(dy,dx)-rot` **恒偏 90°** ⟹ 这就是 `aim` 恒 0 的根因（本轮回测给数字）。
      //   ⑤ `still` / `empty_fire`：修 `2026-10-18` 的"结果行=81/97、dump 只有 1 帧"不一致 —— 见下面 `r` 里逐帧写。
      // ═══════════════════════════════════════════════════════════════════════════════
      s30hit = 0; s30crate = 0; s30selfhit = 0; s30shieldhit = 0;
      s30spawn = 0; s30kill = 0; s30death = 0; s30oppFire = 0;
      s30aim = 0; s30aimDeg = null; s30tminLive = null; s30dbg = null;
      try {
        const _vid2 = o.vid;
        // ── ①+②+④ 事件清点（事件归属由游戏自己给，⛔ 不按格子/位姿猜）──
        const _ev = (o && o.ev) || [];
        evTot.evN += _ev.length;
        let _deathByOther = 0, _deathSelf = 0, _oppDeadByMe = 0, _oppDeadByOther = 0;
        for (let ei = 0; ei < _ev.length; ei++) {
          const e2 = _ev[ei];
          if (e2.k === 'deadly') {
            evTot.deadlyAll++;
            if (e2.shooter === _vid2 && e2.victim !== _vid2) { s30hit++; evTot.deadlyMine++; _oppDeadByMe++; }
            if (e2.shooter === _vid2 && e2.victim === _vid2) { s30selfhit++; evTot.deadlySelf++; _deathSelf++; }
            if (e2.shooter !== _vid2 && e2.victim === _vid2) { evTot.deadlyOppOnMe++; _deathByOther++; }
            if (e2.shooter !== _vid2 && e2.victim !== _vid2) { _oppDeadByOther++; }
            if (e2.shooter !== _vid2 && e2.shooter === e2.victim) { evTot.deadlyOppSelf++; }
          } else if (e2.k === 'pickup') {
            evTot.pickAll++;
            if (e2.picker === _vid2) { s30crate++; evTot.pickMine++; }
          } else if (e2.k === 'shield') {
            if (e2.shooter === _vid2 && e2.shieldOwner !== _vid2) { s30shieldhit++; evTot.shieldMine++; }
          } else if (e2.k === 'kill') {
            if (e2.shooter === _vid2 && e2.victim !== _vid2) evTot.killEv++;
          }
        }
        if (o && typeof o.evOverflow === 'number') evTot.evOver = o.evOverflow;
        // ── ③ 真发射（`_bulletsFired` 是累计值 ⟹ 取差分；我 + 每个对手都取）──
        const _wep = (o && o.wep) || {};
        const _wkeys = Object.keys(_wep);
        for (let wi = 0; wi < _wkeys.length; wi++) {
          const pid3 = _wkeys[wi], w3 = _wep[pid3];
          if (!w3 || typeof w3.fired !== 'number') continue;
          const prev3 = (dFiredBy[pid3] === undefined) ? null : dFiredBy[pid3];
          const inc3 = (prev3 === null) ? 0 : Math.max(0, w3.fired - prev3);
          dFiredBy[pid3] = w3.fired;
          if (pid3 === _vid2) { s30spawn = inc3; }
          else if (inc3 > 0) { s30oppFire += inc3; s30lastOppFirePid = pid3; dOppFire3 = true; }
        }
        const _firstFrame = (dPrevAlive === null);   // 首帧没有"上一帧"可比 ⟹ 不产生发射/击杀差分
        if (_firstFrame) s30spawn = 0;
        // ── 存活集合（⭐ 关键修正：`getActivePlayerIds()` 是**游戏里在场玩家**，死掉的坦克仍在里面、
        //    只是 `gc.getTank(id)` 返回 null ⟹ `o.pl[id] === null`。旧代码用 `Object.keys(o.pl)` 数存活，
        //    ⟹ 8 人靶场里打死了靶子也数不出 `kill`（恒 0）。这里改成**只数位姿非 null 的**。）──
        const _pl = (o && o.pl) || {};
        const _plKeys = Object.keys(_pl);
        const _aliveIds = _plKeys.filter(function (k) { return !!_pl[k]; });
        const _meAlive = (_aliveIds.indexOf(_vid2) >= 0) ? 1 : 0;
        const _oppPoses = _aliveIds.filter(function (k) { return k !== _vid2; }).map(function (k) { return _pl[k]; });
        const _me = _meAlive ? _pl[_vid2] : null;
        if (dPrevAlive !== null) {
          // ⭐ 死因归属（2026-10-18 修 double-count）：
          //   `selfkill`（我方子弹打自己）与 `death`（被他人子弹打死）是**两个互斥的项**，
          //   旧写法在"自爆"那一帧会同时置 1 ⟹ 同一件事实扣 -1.5 + -1.0 = -2.5（虚高）。
          if (_deathByOther > 0) s30death = _deathByOther;
          else if (_deathSelf > 0) s30death = 0;            // ⭐ 自爆：交给 selfkill 项，⛔ 不再记 death
          else if (dPrevAlive.me === 1 && _meAlive === 0) s30death = 1;   // 死因未知（毒雾等）兜底
          // ⭐ `kill` 的归属（2026-10-18 修）：`w_kill` 的语义是「**我方子弹**击杀」。
          //   旧写法只看"对手数量少了"⟹ **对手自爆也算我击杀**（实测 p2_clear_crates_20101 就是这种：
          //   `deadly` 事件是 `shooter=对手 / victim=对手` 的自爆，却被记成我 kill=1、白拿 +1.0）。
          //   现在：有 `deadly` 事件就用事件归属；一个 `deadly` 事件都没有（毒雾/退出）才退回数量差分。
          if (_oppPoses.length < dPrevAlive.opp) {
            if (_oppDeadByMe + _oppDeadByOther > 0) s30kill = _oppDeadByMe;
            else s30kill = dPrevAlive.opp - _oppPoses.length;
          }
        }
        dPrevAlive = { me: _meAlive, opp: _oppPoses.length };
        // ── ④ aim：炮口方向 = rot − π/2（修 90° 偏差）──
        let _near = null, _nearD = Infinity;
        if (_me) {
          for (let qi = 0; qi < _oppPoses.length; qi++) {
            const _q = _oppPoses[qi];
            const dd = (_q.x - _me.x) * (_q.x - _me.x) + (_q.y - _me.y) * (_q.y - _me.y);
            if (dd < _nearD) { _nearD = dd; _near = _q; }
          }
          if (_near) {
            let da = Math.atan2(_near.y - _me.y, _near.x - _me.x) - (_me.rot - Math.PI / 2);
            while (da > Math.PI) da -= 2 * Math.PI;
            while (da <= -Math.PI) da += 2 * Math.PI;
            s30aimDeg = da * 180 / Math.PI;
            s30aim = (Math.abs(s30aimDeg) <= 20) ? 1 : 0;      // 阈值 ±20° 沿用原口径（父代理 2026-10-18 派单）
          }
        }
        // ── ③ t_min 的"米/帧"：**子弹速度(m/s) × 每帧秒数**（都由游戏/时钟自报，⛔ 不写死常数）
        //   主口径来自注入器 `o.mper`（= 我方子弹速度 × `window.__vt.dt`）；
        //   交叉核对值 `o.mperMineDisp`（同一颗子弹相邻帧实测位移）只记进 dbg，不参与取值。
        //   从来测不到（整局我方没有过子弹）⟹ 保持 null ⟹ `t_min` 也是 null（⛔ 不拿常数顶）
        if (o && typeof o.mper === 'number' && o.mper > 0) { mperSticky = o.mper; mperSrc = o.mperFrom || 'speed'; }
        const OFF = (typeof K.bulletOffset === 'number') ? K.bulletOffset : null;
        const BR = (typeof K.bulletRadius === 'number') ? K.bulletRadius : 0;
        const TH = (typeof K.tankHalfH === 'number') ? K.tankHalfH : 0;
        const _tminOf = function (fromPose, toPose, mper) {
          if (!fromPose || !toPose || !(mper > 0) || OFF === null) return null;
          const fx = Math.sin(fromPose.rot), fy = -Math.cos(fromPose.rot);
          const mx = fromPose.x + fx * OFF, my = fromPose.y + fy * OFF;
          const dh = Math.hypot(toPose.x - mx, toPose.y - my) - (TH + BR);   // 到"外壳"的直线距离（米）
          if (!isFinite(dh)) return null;
          return Math.max(1, Math.ceil(Math.max(0, dh) / mper));
        };
        s30tminLive = _tminOf(_me, _near, mperSticky);                    // 本帧几何值（诊断用）
        if (s30spawn > 0) {                                               // 真发射那一帧 ⟹ 定"本发子弹"的 T_min
          const _t = _tminOf(_me, _near, mperSticky);
          if (_t !== null) tminShot = _t;
          s30spawnTmin = _t;
        }
        if (dOppFire3 && _me) {                                            // 对手真发射那一帧 ⟹ 定"这发来袭弹"的 T_min'
          const _op = _pl[s30lastOppFirePid] || null;
          const _t2 = _tminOf(_op, _me, mperSticky);
          if (_t2 !== null) tminDeath = _t2;
        }
        dOppFire3 = false;
        s30tmin = (tminShot !== null) ? tminShot : s30tminLive;
        s30tminD = tminDeath;
        s30dbg = {
          na: _oppPoses.length, me: _meAlive, plN: _plKeys.length, deadSlots: _plKeys.length - _aliveIds.length,
          mper: (typeof mperSticky === 'number') ? +mperSticky.toFixed(4) : null,
          mperSrc: mperSrc,
          mperMineDisp: (o && typeof o.mperMineDisp === 'number') ? +o.mperMineDisp.toFixed(4) : null,
          spdMine: (o && typeof o.spdMine === 'number') ? o.spdMine : null,
          dtMs: (o && typeof o.dtMs === 'number') ? o.dtMs : null,
          mperN: (o && typeof o.mperN === 'number') ? o.mperN : null,
          projN: (o && typeof o.projN === 'number') ? o.projN : null,
          bOff: OFF, tHalf: TH, evN: _ev.length, evOver: (o && o.evOverflow) || 0,
          tminLive: s30tminLive, tminShot: tminShot, tminDeath: tminDeath,
          aimDeg: (s30aimDeg === null) ? null : +s30aimDeg.toFixed(1),
          spawn: s30spawn, oppFire: s30oppFire, hit: s30hit, crate: s30crate, shieldHit: s30shieldhit,
          still: s30still, empty: s30empty
        };
      } catch (eDense) { s30dbg = { err: String((eDense && eDense.message) || eDense).slice(0, 200) }; }
      if (DUMP_DIR && s30segs && o && o.N) {
        const segs = s30segs;
        s30n++;
        const _fire = (s30p && typeof s30p.fire === 'number') ? (s30p.fire ? 1 : 0) : 0;
        dumpFrames.push({
          t: f, N: o.N, obs: segs,
          act: (function () {
            const a = { nodeId: nodeId, fire: _fire, picks: [{ nodeId: nodeId, back: 0 }] };
            // ⭐ A 相动作（生长位置 + 其 logprob）；无 A 相结果时【不写】，由训练侧计数 missing（⛔ 不假造）
            if (s30pA && s30pA.grow && typeof s30pA.grow.grow_nodeId === 'number' && typeof s30pA.grow.lp_grow === 'number') {
              a.grow = { nodeId: s30pA.grow.grow_nodeId, lp_grow: s30pA.grow.lp_grow, back: 0 };
            }
            return a;
          })(),
          lp: (s30p && typeof s30p.lp === 'number' && isFinite(s30p.lp)) ? s30p.lp : null,
          v: (s30p && typeof s30p.v === 'number' && isFinite(s30p.v)) ? s30p.v : null,
          execByPolicy: true, execStill: (o.sub ? (!o.sub.f && !o.sub.b && !o.sub.l && !o.sub.r) : null),
          // ⭐⭐ 逐帧 `r`：`rewards.py` 真正读的就是这里。`null` = 【算不出来】（reward 侧会显式计数并置 0，⛔ 不编常数）
          r: { total: 0, result: 0, survive: 0.01, legal: 0,
               spawn: s30spawn, kill: s30kill, death: s30death,
               hit: s30hit, crate: s30crate, selfkill: s30selfhit, kill_storm: 0, death_storm: 0,
               aim: s30aim, t_min: s30tmin, t_min_death: s30tminD,
               still: s30still, empty_fire: s30empty }, done: false,
          // ⭐ 诊断（不进奖励；用来证明"算出来的数是怎么来的"）
          dbg: s30dbg
        });
        // 滚动裁剪：只保留最后 DUMP_MAX 帧（0=不裁）
        if (DUMP_MAX > 0 && dumpFrames.length > DUMP_MAX * 2) dumpFrames.splice(0, dumpFrames.length - DUMP_MAX);
      }
      if (f % 30 === 0) {
        const ss = await m.stormState();
        nSamples++;
        if (ss && ss.nStorm > 0) stormFrames++;
        if (ss && ss.nCrates > cratesMax) cratesMax = ss.nCrates;
      }
      // ⭐ 2026-10-17 埋点（父代理指派）：每 60 帧记一行存活快照 ⟹ 判 H2（多 bot 僵持）/ H3（我方活着但杀不动）
      if (f % 60 === 0) {
        try {
          const al = await m.eval(`(() => { var gc = GameManager.getGameController(); var t = gc && gc.getTanks ? gc.getTanks() : {}; return Object.keys(t || {}); })()`);
          const arr = Array.isArray(al) ? al : [];
          aliveTrace.push({ f: f, nAlive: arr.length, alive: arr });
          if (nAliveMin === null || arr.length < nAliveMin) nAliveMin = arr.length;
          if (arr.length > nAliveMax) nAliveMax = arr.length;
        } catch (eAT) { if (!aliveTraceErr) aliveTraceErr = String((eAT && eAT.message) || eAT).slice(0, 200); }
      }
      // ⭐⭐⭐ 开火决策改为【策略驱动】(父代理 2026-10-18)：
      //   原来 `setFire(FIRE_ON)` 只在开场设一次 ⟹ 开火是常量、不是策略输出
      //   ⟹ 训练数据里 `act.fire` 永远是同一个值 ⟹ 火头没有任何梯度。
      //   现在每帧把服务端返回的 `p.fire` 写进去 ⟹ 下一帧 `__g1.step()` 拼包时用它。
      if (FIRE_ON && s30p && typeof s30p.fire === 'number') {
        try { await m.eval('window.__g1.setFire(' + (s30p.fire ? 1 : 0) + ')'); } catch (eFS) {}
        if (s30p.fire) fireOnFrames++;
      }
      if (S30_DUMMY && !dummyPatched) {
        // ⭐ **只在开场打一次猴子补丁**：把每个非 vantage 的 AI 的 `update` 换成"什么都不做"。
        //   ⛔ 不能在 pump 之前每帧清零 inputState —— 游戏会在 pump 里跑 ai.update() 再把它覆盖掉（实测靶子仍在动）。
        try {
          const _dn = await m.eval(`(()=>{var ms=(typeof AIs!=='undefined'&&AIs.aiManagers)?AIs.aiManagers:[];var n=0;
            for(var i=0;i<ms.length;i++){var g=ms[i]; if(!g||g.isVantage)continue;
              var ai=g.ai; if(!ai) continue;
              ai.update=function(){ try{ this.inputState=InputState.withState(this.aiId,false,false,false,false,false);}catch(eU){} };
              ai._makeDecisionsAndUpdateGoal=function(){return false;};
              ai.actions=[];
              if(g.storedStates){g.storedStates={forward:false,back:false,left:false,right:false,fire:false};}
              n++;}
            return n;})()`);
          dummyN = _dn; dummyPatched = true;
          try { const _v = await m.eval('window.__g1.vantageId()'); vidOfScene = _v || 'vantage_1'; } catch (eV) { vidOfScene = 'vantage_1'; }
        } catch (eD) { if (!s30DummyErr) s30DummyErr = String((eD && eD.message) || eD).slice(0, 160); }
      }
      if (S30_DUMMY && dummyPatched && vantageDeadAt === null) {
        // ⭐ 靶场：Vantage 一死就结束本场 —— 否则空转几千帧，而滚动缓冲存的是【末帧】⟹ 全是"死后空帧"（selfX=selfY=0）。
        try {
          const _al = JSON.parse(await m.eval(`(()=>{var gc=GameManager.getGameController();var t=gc&&gc.getTanks?gc.getTanks():{};return JSON.stringify(Object.keys(t||{}));})()`));
          if (Array.isArray(_al) && _al.length && _al.indexOf(vidOfScene) < 0) { vantageDeadAt = f; break; }
        } catch (eAD) {}
      }
      await m.pump(1, { yieldMs: 0 });
    }

    // 收尾：ROUND_ENDED 事件 + 分数（VICTORY type=1）
    let re = null;
    try { re = JSON.parse(await m.eval('JSON.stringify(window.__g1.roundEnded || null)')); } catch (eR) {}
    let snap = null;
    try { snap = await m.snapshot(); } catch (eS) {}
    let winner = null;
    if (re && Array.isArray(re.playerIds) && re.playerIds.length === 1) winner = String(re.playerIds[0]);
    if (!winner && snap && Array.isArray(snap.scores)) {
      const vs = snap.scores.filter((s) => s.type === 1 && s.value > 0).map((s) => String(s.playerId));
      if (vs.length === 1) winner = vs[0];
      else if (vs.length > 1) winner = vs.indexOf(vid) >= 0 ? vid : vs[0];
    }
    r.winner = winner;
    r.frames = f;
    r.frames_asked = lpTot;
    r.truncated = !ended;
    // ⭐ 请求统计落盘（父代理要求：每场结果加 askTimeouts / askRetries / askMaxMs）
    r.askOk = askStat.ok; r.askTimeouts = askStat.timeouts; r.askRetries = askStat.retries;
    r.askMaxMs = askStat.maxMs; r.askFails = askStat.fails; r.askTimeoutMs = ASK_TIMEOUT_MS; r.askRetryMax = ASK_RETRY;
    // ⭐ 埋点落盘（父代理 2026-10-17）：存活轨迹 + 回合结束玩家表
    r.alive_trace = aliveTrace;
    r.alive_trace_n = aliveTrace.length;
    r.nAlive_first = aliveTrace.length ? aliveTrace[0].nAlive : null;
    r.nAlive_last = aliveTrace.length ? aliveTrace[aliveTrace.length - 1].nAlive : null;
    r.nAlive_min = nAliveMin;
    r.nAlive_max = nAliveMax;
    r.nAlive_dropped = (aliveTrace.length > 1) ? (aliveTrace.some((e, i) => i > 0 && e.nAlive < aliveTrace[i - 1].nAlive)) : false;
    r.alive_trace_err = aliveTraceErr;
    r.roundEnded = re ? { evt: re.evt || null, playerIds: Array.isArray(re.playerIds) ? re.playerIds : null,
                          scores: Array.isArray(re.scores) ? re.scores : null } : null;
    r.crates_max = cratesMax;
    r.storm_zone_samples = stormFrames + '/' + nSamples;
    r.nodeid_oob = oob;
    r.server_errors = srvErr;
    r.lp_finite = lpFin + '/' + lpTot;
    // ⭐⭐ 防混版（父代理 2026-10-18 两次踩坑后加的保险）：
    //   采集/评测期间若 `game_core` 或注入器被改动，这批数据就混了两代行为 ⟹ 作废。
    //   每场落一次源文件 md5，事后可核。
    try {
      const _crypto2 = require('crypto');
      const _md5of = (p2) => { try { return _crypto2.createHash('md5').update(require('fs').readFileSync(p2)).digest('hex').slice(0, 16); } catch (e) { return null; } };
      r.src_md5 = {
        vantage_tree: _md5of('game_core/js/vantage_tree.js'),
        injector: _md5of('_tools/headless/_g1_inject.js'),
        runner: _md5of('_tools/eval/run_scenes_30.js')
      };
    } catch (eMD5) { r.src_md5 = null; }
    r.fire_on_frames = fireOnFrames;   // ⭐ 策略开火帧数（与 fire 常量对照）
    r.empty_fire_unknown_ammo = emptyFireUnknown;   // ⭐ ammoLeft=-1（取不到）而 fire=1 的帧数（不算空放）
    r.ammo_left_range = [ammoMin, ammoMax];         // ⭐ ammoLeft 的实测范围（证明"空放=0"是不是真没子弹）
    r.grow_ok_frames = growOkFrames;
    r.still_frames = stillFrames; r.empty_fire_frames = emptyFireFrames;
    r.dummy_mode = S30_DUMMY; r.dummy_opponents = dummyN; r.dummy_err = s30DummyErr; r.vantage_dead_at = vantageDeadAt;   // ⭐ A 相 grow 决策帧数（>0 才说明 A 数据进来了）
    r.ask_a_err = s30AErr;
    r.opp_input = (oppMultiFrames > 0) ? ('full(' + oppBlocksSeen + '->8)') : 'native(1->8)';   // ⭐ 全量送 8 行（派单①）：不再 nearestAlive 裁剪
    r.opp_rows_max = oppBlocksSeen;
    r.opp_over = oppOver;
    r.opp_multi_frames = oppMultiFrames;
    r.opp_adapted_frames = 0;   // ⭐ 已停用：不再做 nearestAlive 裁剪（派单①）⟹ 恒 0，保留字段名兼容旧解析
    r.opp_native_frames = oppNativeFrames;
    r.step_err = r.step_err || null;
    if (r.step_err && !ended) {
      r.ok = false; r.result = 'unknown'; r.win = null;
    } else if (!ended) {
      r.ok = true; r.result = 'timeout'; r.win = null;   // 截断：unknown，⛔ 不算负
    } else if (!winner) {
      r.ok = true; r.result = 'dbl_death'; r.win = null;
    } else if (winner === vid) {
      r.ok = true; r.result = 'victory'; r.win = 1;
    } else {
      r.ok = true; r.result = 'defeat'; r.win = 0;
    }
    // ⭐ S30_DUMP：写盘（终局奖励 win=+3 / lose=-1 / 未决=0；最后一帧 done=true）
    if (DUMP_DIR && dumpFrames.length >= 2) {
      try {
        const fsd = require('fs');
        fsd.mkdirSync(DUMP_DIR, { recursive: true });
        // ⭐⭐ 主人 2026-10-18 裁定：「如果它这么喜欢静止是训练出来的，那就反其道而行 ——
        //     超时直接判【双倍失败】，高额惩罚。毒雾能很好地阻止它拖时间。」
        //   ⟹ 超时 = -2.0（= 2 × lose 的 -1.0）；dbl_death（双死）= 0（draw，不奖不罚）。
        const _isTimeout = (r.result === 'timeout');
        const term = (r.win === 1) ? 3.0
                   : (r.win === 0 ? -1.0
                   : (_isTimeout ? -2.0 : 0.0));
        // 终局帧之前若曾裁剪，t 仍严格递增（保留的是尾部连续段）⟹ 合规
        // ⭐ 2026-10-18 修：原来这里**整块替换** `r` ⟹ 除了这最后一帧，其它帧的 `still`/`empty_fire`
        //   /`hit`/`crate`/`t_min`/`aim` 全丢了（结果行 `still_frames=81 / empty_fire_frames=97`，
        //   而 dump 逐帧 `r` 里只有 **1 帧**为 1 —— 就是被这里覆盖的那一帧）。
        //   现在改成 **Object.assign 增量覆盖**：保留该帧已算出的逐帧值，只补终局量。
        const _lastR = dumpFrames[dumpFrames.length - 1].r || {};
        // ⭐ 终局帧的 kill/death 原来是"按胜负反推"（win⇒kill=1 / lose⇒death=1）。
        //   现在事件录里有证据，就先看证据（⛔ 不再用胜负盖住"对手自爆"这种真实情况）：
        //   · `evTot.deadlyMine>0`    ⟹ 我方子弹确实命中过对手 ⟹ kill=1 有据
        //   · `evTot.deadlyOppSelf>0` ⟹ 对手子弹打的是对手自己（自爆）⟹ kill 必须为 0
        //   · `evTot.deadlySelf>0`    ⟹ 我方自爆 ⟹ death 归 selfkill 项，death=0
        const _killByEv = (evTot.deadlyMine > 0) ? 1 : 0;
        const _oppSelfEv = (evTot.deadlyOppSelf > 0) ? 1 : 0;
        const _selfEv = (evTot.deadlySelf > 0) ? 1 : 0;
        let _termKill = 0, _killDerived = 0;
        if (r.win === 1) {
          if (_killByEv) _termKill = 1;
          else if (_oppSelfEv) _termKill = 0;            // 赢是对手自爆：我方没击杀
          else { _termKill = 1; _killDerived = 1; }      // 无事件证据 ⟹ 维持旧口径（显式标 derived）
        }
        let _termDeath = 0, _deathDerived = 0;
        if (r.win === 0) {
          if (_selfEv) _termDeath = 0;                   // 自爆 ⟹ 只记 selfkill
          else if (evTot.deadlyOppOnMe > 0) _termDeath = 1;
          else { _termDeath = 1; _deathDerived = 1; }
        }
        dumpFrames[dumpFrames.length - 1].r = Object.assign({}, _lastR, {
          total: term,
          result: (r.win === 1 ? 1 : (r.win === 0 ? -1 : 0)),
          survive: 0.01, legal: 0,
          win: (r.win === 1 ? 1 : 0), lose: (r.win === 0 ? 1 : 0),
          // ⭐ `draw`：双死局（`result==='dbl_death'`）。`rewards._crate_and_draw_parts` 见到 `draw>0` 就直供，
          //   并且会把 `result` 权重项抑制掉（D4：双死只走 draw，⚠️不 double-count）。
          draw: (r.result === 'dbl_death' ? 1 : 0),
          // ⭐ 父代理 2026-10-18：死亡发生在【最后一帧】⟹ 逐帧 pl 集合变化采不到
          //   ⟹ 终局帧按胜负反推：win=1 ⟹ 我方击杀；win=0 ⟹ 我方死亡。
          //   ⚠️ 局限：赢也可能是对手自爆（无法从现有遥测区分），已在台账标注
          kill: Math.max(_lastR.kill || 0, _termKill),
          death: Math.max(_lastR.death || 0, _termDeath),
          // ⚠️ 契约：`rewards.py` 里 `hit >= kill`（hit 含致命命中），否则它会**主动抛错**。
          //   终局帧的 kill 是从胜负反推的（那一击常常发生在被 break 掉的、没 dump 的那一帧）⟹ 这里把 hit 顶到 kill，
          //   并用 `hit_term_derived` 显式标出来源（⛔ 不是凭空多给一枪）。
          hit: Math.max(_lastR.hit || 0, _termKill),
          hit_term_derived: (_termKill && !(_lastR.hit > 0)) ? 1 : 0,
          kill_term_derived: _killDerived,
          death_term_derived: _deathDerived,
          opp_selfkill_ev: _oppSelfEv,
          selfkill: _lastR.selfkill || 0,
          kill_storm: 0, death_storm: 0,
          still: s30still, empty_fire: s30empty,
          t_min: (_lastR.t_min === undefined ? null : _lastR.t_min),
          t_min_death: (_lastR.t_min_death === undefined ? null : _lastR.t_min_death)
        });
        dumpFrames[dumpFrames.length - 1].done = true;
        // ⭐ 事件总量落进结果行（证明"这些 0 是真测出来的 0"，不是没采）
        r.ev_total = evTot;
        const epObj = {
          ep: (typeof r.ep === 'number' ? r.ep : 1),
          scene: { players: scene.players, mapW: r.mapW, mapH: r.mapH, storm: !!scene.storm,
                   crates: (scene.crates === undefined ? [] : scene.crates) },
          frames: dumpFrames, win: r.win, src_md5: r.src_md5 || null
        };
        fsd.appendFileSync(DUMP_DIR + '/episodes.jsonl', JSON.stringify(epObj) + String.fromCharCode(10));
        r.dump_frames = dumpFrames.length; r.dump_win = r.win; r.dump_raw = s30n;
        logErr('DUMP_OK[' + scene.id + '] frames=' + dumpFrames.length + '/' + s30n + ' win=' + r.win);
      } catch (eD) { r.dump_err = String((eD && eD.message) || eD).slice(0, 200); logErr('DUMP_ERR ' + r.dump_err); }
    }
    // ⭐ 超时场次强制 ok:false + reason（⛔ 不允许被上面的分类覆盖成 ok:true）
    if (r.reason === 'ask_timeout') { r.ok = false; r.result = 'unknown'; r.win = null; }
    if (r.lp_finite && lpTot > 0 && lpFin !== lpTot && r.win !== null) {      r.quality_warn = 'lp 非有限 ' + (lpTot - lpFin) + ' 帧（该帧动作用的是上一帧 nodeId）';
    }
  } catch (e) {
    r.err = String((e && e.stack) || e).slice(0, 1200);
    r.ok = false;
    if (r.result === 'unknown') r.win = null;
    logErr('SCENE_FAIL[' + scene.id + '] ' + (e && e.stack ? e.stack : e));
  } finally {
    try { if (m) await m.close(); } catch (eC) { logErr('CLOSE_ERR[' + scene.id + '] ' + eC); }
  }
  r.wall_sec = +((Date.now() - t0) / 1000).toFixed(1);
  return r;
}

/* ---------------- 主流程 ---------------- */
(async () => {
  const scenesPath = arg('scenes', DEF_SCENES);
  const outDir = arg('out', DEF_OUT);
  const cap2 = Number(arg('cap', process.env.S30_CAP || 3000));
  // ⭐ 2026-10-17（父代理指派，**待实验口径**）：cap 按人数分档 —— 2 人 3000 · 4 人 6000 · 8 人 6000
  //    ⚠️ 这三个数是【无出处、待实验】：只为验证 H1（cap 太紧）；⛔ 不是定稿口径。
  const cap4 = Number(arg('cap4', process.env.S30_CAP4 || 6000));
  const cap8 = Number(arg('cap8', process.env.S30_CAP8 || 6000));
  for (const nmv of [['--cap(2人)', cap2], ['--cap4', cap4], ['--cap8', cap8]]) {
    if (!(nmv[1] >= 3000)) { logErr('⛔ ' + nmv[0] + ' 必须 ≥3000（G1 实测一整局 2844 帧）；收到 ' + nmv[1]); process.exit(2); }
  }
  const capFor = (players) => (Number(players) >= 8 ? cap8 : (Number(players) >= 4 ? cap4 : cap2));
  fs.mkdirSync(outDir, { recursive: true });

  const ckpt = process.env.VT_CKPT || DEF_CKPT_SEARCH.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
  if (!ckpt || !fs.existsSync(ckpt)) {
    logErr('⛔ 找不到策略 ckpt：请设 VT_CKPT=<model_latest.pt>。默认候选 ' + JSON.stringify(DEF_CKPT_SEARCH));
    process.exit(2);
  }
  const ckptMd5 = md5file(ckpt);
  logErr('SCENES ' + scenesPath + ' md5=' + md5file(scenesPath));
  logErr('CKPT ' + ckpt + ' md5=' + ckptMd5);

  // ⭐ 2026-10-17（父代理指派）：开跑前**强制**口径校验（黄金样例对拍）——
  //    任一断言不过 ⟹ 退出码非 0 ⟹ 这里直接退出，⛔ 不跑局、不报分。
  {
    const { spawnSync } = require('child_process');
    const pfPath = path.join(__dirname, 'preflight_parity.js');
    logErr('PREFLIGHT ' + pfPath);
    const pf = spawnSync(process.execPath, [pfPath], {
      cwd: REPO, encoding: 'utf8', env: Object.assign({}, process.env, { VT_CKPT: ckpt })
    });
    if (pf.stdout) process.stderr.write(pf.stdout);
    if (pf.stderr) process.stderr.write(pf.stderr);
    if (pf.status !== 0) {
      logErr('⛔ 口径校验未通过（preflight_parity 退出码 ' + pf.status + '）⟹ 拒绝开跑（⛔ 不跑局、不报分）');
      process.exit(3);
    }
    logErr('PREFLIGHT_OK（段清单 / 每段 rows×width / 补零位置 / 服务端 nodeId·fire·lp 全一致）');
  }

  const list = JSON.parse(fs.readFileSync(scenesPath, 'utf8'));
  let scenes = list.scenes;
  const only = arg('only', null);
  if (only) scenes = scenes.filter((s) => s.id.indexOf(only) >= 0);
  // ⭐ 2026-10-17：`--ids a,b,c` 只跑指定 scene_id（⛔ 不静默丢：给了不存在的 id 直接报错）
  const idsArg = arg('ids', null);
  if (idsArg) {
    const want = String(idsArg).split(',').map((s) => s.trim()).filter(Boolean);
    const have = new Set(list.scenes.map((s) => s.id));
    const bad = want.filter((w) => !have.has(w));
    if (bad.length) { logErr('⛔ --ids 里有不存在的场景：' + bad.join(',') ); process.exit(2); }
    scenes = scenes.filter((s) => want.indexOf(s.id) >= 0);
    logErr('IDS want=' + want.length + ' matched=' + scenes.length);
  }
  if (arg('scene', null)) scenes = [JSON.parse(arg('scene', null))];
  if (!scenes.length) { logErr('⛔ 没有要跑的场景（--only 过滤太狠？）'); process.exit(2); }

  const oneShot = !!arg('scene', null);
  const ts = Math.floor(Date.now() / 1000);
  let resultsPath = path.join(outDir, 'results_' + (oneShot ? 'one' : '30') + '_' + ts + '.jsonl');
  // ⭐ 2026-10-17 断点续跑（父代理指派）：
  //   `--resume <results.jsonl>` ⟹ 只跳过 ok:true 的场景（ok:false 会重跑），结果追加回同一个文件；
  //   并用 ckpt_md5 拦"混权重"（⛔ 静默混权重会让分数失真）。
  const resumePath = arg('resume', null);
  let resumedLines = 0;
  if (resumePath) {
    if (!fs.existsSync(resumePath)) { logErr('⛔ --resume 文件不存在: ' + resumePath); process.exit(2); }
    const lines = fs.readFileSync(resumePath, 'utf8').split('\n').filter(Boolean);
    const doneIds = {};
    const md5s = {};
    for (const ln of lines) {
      let e;
      try { e = JSON.parse(ln); } catch (err) { logErr('⛔ --resume 里有坏行（拒绝猜）: ' + String(ln).slice(0, 140)); process.exit(2); }
      if (!e || !e.scene_id) { logErr('⛔ --resume 有一行缺 scene_id（拒绝猜）: ' + String(ln).slice(0, 140)); process.exit(2); }
      if (e.ckpt_md5) md5s[e.ckpt_md5] = (md5s[e.ckpt_md5] || 0) + 1;
      if (e.ok === true) doneIds[e.scene_id] = true;      // ⭐ timeout 也算"完成"，不重跑
    }
    const foreign = Object.keys(md5s).filter((m) => m !== ckptMd5);
    if (foreign.length && !flag('allow-ckpt-mix')) {
      logErr('⛔ --resume 的 ckpt_md5 与当前不一致：文件里=' + foreign.join(',') + ' 当前=' + ckptMd5 +
             ' ⟹ 拒绝混权重（确要混用请显式加 --allow-ckpt-mix）');
      process.exit(2);
    }
    resultsPath = resumePath;
    resumedLines = lines.length;
    const before = scenes.length;
    scenes = scenes.filter((s) => !doneIds[s.id]);
    logErr('RESUME ' + resumePath + ' lines=' + resumedLines + ' done=' + Object.keys(doneIds).length +
           ' ⟹ skip=' + (before - scenes.length) + ' run=' + scenes.length);
    if (!scenes.length) {
      logErr('RESUME_ALL_DONE 没有待跑场景（文件: ' + resultsPath + '）');
      process.exit(0);
    }
  }
  // ⭐ 每场【同步追加 + fsync】⟹ 进程被杀也不会丢已完成场次（原来 WriteStream 会攒）
  const fd = fs.openSync(resultsPath, 'a');
  const writeRow = (r) => {
    fs.writeSync(fd, JSON.stringify(r) + '\n');
    try { fs.fsyncSync(fd); } catch (eFs) {}
  };
  logErr('RUN scenes=' + scenes.length + ' cap(2/4/8人)=' + cap2 + '/' + cap4 + '/' + cap8 +
         ' 【cap 分档=无出处、待实验；--cap/--cap4/--cap8 可覆盖】 fire=' + (FIRE_ON ? 1 : 0) +
         ' seedMode=' + SEED_MODE + (scenes.length ? (' seedSample=' + JSON.stringify([0, 1, 2, 3, 4].map((k) => seedFor(scenes[0].id, k)))) : '') +
         ' rngFix=' + (RNG_FIX ? ('on(len=' + RNG_SEQ_LEN + ')') : 'off') + ' -> ' + resultsPath);

  let srv = null;
  try {
    srv = new Srv(ckpt);
    await srv.ensureReady();
    logErr('SRV_READY ' + (srv.ckLine || ''));
  } catch (e) {
    logErr('⛔ 策略服务端没起来：' + ((e && e.stack) || e));
    if (oneShot) { outLine(JSON.stringify({ scene_id: scenes[0].id, ok: false, win: null, result: 'unknown', frames: 0, players: scenes[0].players, mapW: null, mapH: null, storm: !!scenes[0].storm, crates_on: !!scenes[0].crates_on, err: 'strategy server not ready: ' + String((e && e.message) || e) })); }
    try { if (srv) await srv.close(); } catch (e2) {}
    process.exit(1);
  }

  let nOk = 0, nErr = 0;
  const winList = [];
  try {
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      let r;
      try {
        await srv.ensureReady();
        const capUsed = capFor(scene.players);
        r = await runScene(scene, srv, capUsed);
        r.cap = capUsed;   // ⭐ 记下本场实际用的 cap（分档可追溯）
        // ⭐ 2026-10-17（父代理裁定 ③）：`--repeat k` 每场跑 k 次，取**中位数**作该场成绩
        //   （因为即使地图固定 + seed 确定性，`frames` 仍可能差几十帧；k 次取中位把残余抖动平均掉，代价机时 ×k）
        if (REPEAT_K > 1) {
          const runs = [r];
          for (let k = 2; k <= REPEAT_K; k++) {
            logErr('REPEAT ' + (k + '/' + REPEAT_K) + ' ' + scene.id);
            try { runs.push(await runScene(scene, srv, capUsed)); } catch (eR) { logErr('REPEAT_ERR ' + scene.id + ': ' + String((eR && eR.message) || eR).slice(0, 200)); }
          }
          const winsArr = runs.map((x) => (x.win === 1 ? 1 : (x.win === 0 ? 0 : null)));
          const decided = winsArr.filter((v) => v !== null);
          const sumW = decided.reduce((a, b) => a + b, 0);
          const majWin = decided.length ? (sumW * 2 > decided.length ? 1 : (sumW * 2 < decided.length ? 0 : null)) : null;
          const fr = runs.map((x) => x.frames).filter((v) => typeof v === 'number').sort((a, b) => a - b);
          const medFrames = fr.length ? fr[Math.floor((fr.length - 1) / 2)] : r.frames;
          const medRun = runs.find((x) => x.frames === medFrames) || r;
          r = Object.assign({}, medRun, {
            repeatK: REPEAT_K, repeatWins: winsArr, repeatFrames: runs.map((x) => x.frames),
            win: majWin, result: medRun.result, frames: medFrames,
            mazeHashes: Array.from(new Set(runs.map((x) => x.mazeHash))),
            repeatAllSame4: runs.every((x) => x.mazeHash === runs[0].mazeHash && x.frames === runs[0].frames && x.result === runs[0].result && x.winner === runs[0].winner)
          });
          logErr('REPEAT_SUM ' + scene.id + ' wins=' + JSON.stringify(winsArr) + ' frames=' + JSON.stringify(runs.map((x) => x.frames)) + ' allSame4=' + r.repeatAllSame4);
        }
      } catch (e) {
        r = { scene_id: scene.id, ok: false, win: null, result: 'unknown', frames: 0, players: scene.players,
              mapW: null, mapH: null, storm: !!scene.storm, crates_on: !!scene.crates_on, err: String((e && e.stack) || e).slice(0, 1200) };
      }
      r.ckpt = ckpt; r.ckpt_md5 = ckptMd5;
      writeRow(r);
      outLine(JSON.stringify(r));
      if (r.ok) nOk++; else nErr++;
      winList.push(r.win);
      logErr('PROGRESS ' + (i + 1) + '/' + scenes.length + ' ' + scene.id + ' win=' + r.win + ' result=' + r.result +
             ' frames=' + r.frames + ' map=' + r.mapW + 'x' + r.mapH + ' wall=' + r.wall_sec + 's' +
             (r.err ? ' err=' + String(r.err).split('\n')[0].slice(0, 160) : ''));
    }
  } finally {
    try { fs.closeSync(fd); } catch (eC) {}
    try { await srv.close(); } catch (e) {}
  }
  logErr('SUMMARY scenes=' + scenes.length + ' ok=' + nOk + ' err=' + nErr + ' win=' +
         JSON.stringify(winList) + ' results=' + resultsPath);
  if (nErr) process.exitCode = 1;
})().catch((e) => { logErr('FATAL ' + ((e && e.stack) || e)); process.exit(1); });
