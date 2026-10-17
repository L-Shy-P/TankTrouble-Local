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
const REPEAT_K = Math.max(1, Number(process.env.S30_REPEAT || (process.argv.indexOf('--repeat') >= 0 ? (process.argv[process.argv.indexOf('--repeat') + 1] || 1) : 1)));
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
  async ask(o) { this.p.stdin.write(JSON.stringify(o) + '\n'); return JSON.parse(await this.line(30000)); }
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
  try {
    m = new Match();
    // ⭐ 可复现：每场固定 RNG 序列（`--no-fix-rng` 关闭）⟹ 同一 scene 两次跑地图必须一致
    const mazeSeed = ((Number(scene.seed) || 1) * 100003 + 7) >>> 0;
    const openOpts = { humanIds: [], players: scene.players, storm: !!scene.storm,
                   crates: scene.crates, control: false, epoch: scene.epoch };
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
          segs = built.segs; _segStats = built.stats;
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
        let p = null;
        try { p = await srv.ask({ N: o.N, seed: seedFor(scene.id, f), segs: segs }); lpTot++; }
        catch (eA) { r.step_err = 'server: ' + String((eA && eA.message) || eA).slice(0, 300); break; }
        if (p) {
          if (p.err) { srvErr++; if (srvErr <= 2) logErr('SRV_ERR[' + scene.id + '] ' + String(p.err).slice(0, 200)); }
          else {
            if (typeof p.lp === 'number' && isFinite(p.lp)) lpFin++;
            if (typeof p.nodeId === 'number') { if (p.nodeId < 0 || p.nodeId >= o.N) oob++; else nodeId = p.nodeId; }
          }
        }
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
    if (r.lp_finite && lpTot > 0 && lpFin !== lpTot && r.win !== null) {
      r.quality_warn = 'lp 非有限 ' + (lpTot - lpFin) + ' 帧（该帧动作用的是上一帧 nodeId）';
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
