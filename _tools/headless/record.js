'use strict';
/* 录制基座（阶段0 的 0-2 / 0-3）—— 逐帧 opName/位姿 + 初始条件 + 分片导出 + 回放驱动
 * ============================================================================
 *
 *   node _tools/headless/record.js --frames 400 --out <file.jsonl>
 *   node _tools/headless/verify_record.js --in <file.jsonl> --runs 2     ← 0-e 对拍
 *
 * 依据（都是文档里写死的，不是我发明的）：
 *   · `collect.js:42` 原注释：「在页面里算统计，只传小结果（原始记录 400 条 = 30MB，
 *     CDP 传不动）」⟹ **页面内累积 + 分片导出**，不许一次 Runtime.evaluate 返回整局。
 *   · `clock.js:95-113` 的 `__vtRng.record/stop/play/dump` 全仓没有调用方（0-a）
 *     ⟹ 在**文档创建时**注入的脚本里就 record()/play(seq)，保证地图生成+出生散布也在序列里。
 *   · 逐帧双方 opName 含 fire（0-b）：数据源是**游戏自己的 roundState.tankStates**
 *     （forward/back/left/right/fireDown + x/y/rotation），不是我方的控制变量
 *     —— 这样对手（Laika）的操作也会被记下来。
 *   · 初始条件（0-c）：地图（Maze.data.tiles 全量瓦片）/ 主题 / 玩家列表 / 初始位姿 / 回合设置。
 *   · 容器 = 单文件 JSONL，页面把每条记录先 JSON.stringify 成**字符串**，Node 原样写盘
 *     ⟹ 文件与页面持有的记录**逐字节相同**；页面的 frames.fnv 与 Node 对写出的 frame 行
 *        算的哈希相等（用 recHash/`fnvStep` 同一算法）= 「一条不丢」的证据。
 *
 * 【推断】（文档没写、我按工程需要定的，报告里已列出等确认）：
 *   1. 帧记录字段名与容器格式（header/frame/rng/meta 四类行、v=1）；
 *   2. 录制时用什么策略驱动 = 确定性脚本模式（scriptedPlan），只为"可证伪"；
 *   3. 分片大小（帧 100 条/片、随机序列 5000 个/片）；
 *   4. 回放时对**所有被记录的车**都注入记录里的按键（否则两个写入者会打架）。
 */
const fs = require('fs');
const path = require('path');
const { PAGE_SRC, VERSION } = require('./record_page');

const FRAME_CHUNK = 100;
const RNG_CHUNK = 5000;
/**
 * ★ 确定性启动帧（2026-10-11）
 *  资产加载让「到 Menu 用了几帧」在 19~22 之间抖动；虚拟时间进录制时差 3 帧 = 50ms，
 *  50ms 粒度的真实/虚拟 timer 相位随之错开。到 Menu 后把总帧数补齐到这个固定值，
 *  让 record 与 replay 从同一虚拟时刻开始（代价：约 280 帧空转，yieldMs=0，几乎不耗时）。
 *  300 远大于实测 19~22，且远小于 pumpUntilState 的 900 上限。
 */
const BOOT_FRAMES = 300;

/** FNV-1a：与页面内 fnv1a 同一算法 */
function fnvStep(h, str) {
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}
const FNV0 = 0x811c9dc5;

/** 确定性脚本策略：只为"可证伪"（文档没规定录制时用什么策略驱动）【推断】 */
const PATTERN_A = [1, 1, 1, 5, 5, 0, 6, 6, 4, 4, 2, 2, 7, 7, 0, 0];
const PATTERN_B = [2, 2, 7, 3, 3, 0, 1, 1, 5, 5, 0, 8, 8, 6, 0, 0];

function opBits(op) {
  return {
    fwd: op === 1 || op === 5 || op === 6,
    back: op === 2 || op === 7 || op === 8,
    left: op === 3 || op === 5 || op === 7,
    right: op === 4 || op === 6 || op === 8,
  };
}

function scriptedPlan(frames, ids) {
  const plan = [];
  for (let i = 0; i < frames; i++) {
    const tanks = ids.map((id, k) => {
      const pat = k === 0 ? PATTERN_A : PATTERN_B;
      const op = pat[i % pat.length];
      const fire = (i % 41) === 5 || (i % 67) === 30;
      return Object.assign({ id }, opBits(op), { fire });
    });
    plan.push({ f: i, tanks });
  }
  return plan;
}

async function pushPlan(m, plan, chunk = 50) {
  await m.eval('window.__vtDrive.install()');
  for (let i = 0; i < plan.length; i += chunk) {
    await m.eval(`window.__vtDrive.load(${JSON.stringify(plan.slice(i, i + chunk))})`);
  }
  return plan.length;
}

/** 分片导出帧（页面内累积 → 一小片一小片取，绝不一局整取） */
async function exportFrames(m, fd, state, opts = {}) {
  const chunk = opts.chunk || FRAME_CHUNK;
  let got = 0;
  for (;;) {
    const c = await m.eval(`window.__vtRec.chunk(${state.from}, ${chunk})`);
    const recs = c.records || [];
    for (let i = 0; i < recs.length; i++) {
      if (state.wrote > 0) state.hash = fnvStep(state.hash, '\n');
      fs.writeSync(fd, recs[i] + '\n');
      state.hash = fnvStep(state.hash, recs[i]);
      state.wrote++;
    }
    state.from += recs.length;
    state.chunks = (state.chunks || 0) + 1;
    got += recs.length;
    if (recs.length < chunk) break;
  }
  return got;
}

/** 分片导出随机序列；同时导出「按调用点分流」的 sites（2026-10-11） */
async function exportRng(m, fd) {
  const st = await m.eval('window.__vtRng.state()');
  if (!st || (!st.len && !st.siteCount)) return { len: 0, overflow: st ? st.overflow : null, sites: 0 };
  const seq = [];
  for (let from = 0; from < st.len; from += RNG_CHUNK) {
    const part = await m.eval(`window.__vtRng.dump().slice(${from}, ${from + RNG_CHUNK})`);
    for (let i = 0; i < part.length; i++) seq.push(part[i]);
  }
  // sites 分片取（key 列表 → 每片 100 个 key），避免一次 CDP 传太大
  let sites = null;
  if (st.siteCount) {
    const keys = await m.eval('Object.keys(window.__vtRng.dumpSites())');
    sites = {};
    const KEY_CHUNK = 100;
    for (let from = 0; from < keys.length; from += KEY_CHUNK) {
      const part = await m.eval(`(() => {
        var all = window.__vtRng.dumpSites(), ks = ${JSON.stringify(keys.slice(from, from + KEY_CHUNK))}, out = {};
        for (var i = 0; i < ks.length; i++) out[ks[i]] = all[ks[i]];
        return out;
      })()`);
      Object.assign(sites, part);
    }
  }
  fs.writeSync(fd, JSON.stringify({
    k: 'rng', len: seq.length, overflow: st.overflow, calls: st.calls,
    siteCount: st.siteCount, seq, sites,
  }) + '\n');
  return { len: seq.length, overflow: st.overflow, sites: sites ? Object.keys(sites).length : 0 };
}

/**
 * 录一局：打开对局 → 驱动脚本 → 逐帧记 → 分片落盘。
 * @param {Match} m  已建好但【未 open】的 Match
 * @param {object} opts { out, frames, ids, open, verbose, chunk, pumpChunk }
 */
async function recordEpisode(m, opts = {}) {
  const frames = opts.frames || 400;
  const out = opts.out || path.join(__dirname, 'prof', 'episode.jsonl');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const t0 = Date.now();
  const boot = Object.assign({
    humanIds: opts.ids || ['tank_a', 'tank_b'],
    aiCount: 0,
    vantCount: 0,
  }, opts.open || {});
  await m.open(Object.assign({}, boot, { control: false, rng: opts.rng || 'record', verbose: !!opts.verbose,
    epoch: opts.epoch, bootFrames: opts.bootFrames || BOOT_FRAMES,
    freezeUntilMenu: !!opts.freezeUntilMenu, rebaseAtMenu: opts.rebaseAtMenu !== false,
    clearBootTimers: !!opts.clearBootTimers }));
  const rngAtStart = await m.eval('window.__vtRng.state()');

  const ids = opts.ids || ['tank_a', 'tank_b'];
  const plan = opts.plan || scriptedPlan(frames, ids);
  await pushPlan(m, plan, opts.planChunk || 50);
  await m.eval(`window.__vtDrive.start(${plan.length})`);
  await m.eval(`window.__vtRec.start(${JSON.stringify({ page: opts.page || 'index.html', bootstrap: boot, driven: ids })})`);

  const fd = fs.openSync(out, 'w');
  const state = { from: 0, wrote: 0, hash: FNV0, chunks: 0 };
  fs.writeSync(fd, (await m.eval('window.__vtRec.header()')) + '\n');

  const pumpChunk = opts.pumpChunk || 50;
  for (let done = 0; done < frames; done += pumpChunk) {
    await m.pump(Math.min(pumpChunk, frames - done), { yieldMs: 0 });
    await exportFrames(m, fd, state, opts);
  }

  const recStop = await m.eval('window.__vtRec.stop()');
  const drvStop = await m.eval('window.__vtDrive.stop()');
  const pageStats = await m.eval('window.__vtRec.stats()');
  await exportFrames(m, fd, state, opts);                    // 收尾：确保一帧不落
  const rngInfo = await exportRng(m, fd);
  const meta = {
    k: 'meta', frames: state.wrote, pageFrames: pageStats.n, fnv: state.hash, pageFnv: pageStats.fnv,
    recErr: recStop.err, drive: drvStop,
    rngLen: rngInfo.len, rngSites: rngInfo.sites, rngOverflow: rngInfo.overflow, rngAtStart: rngAtStart,
    wallMs: Date.now() - t0, vt: await m.eval('({t: window.__vt.t, steps: window.__vt.steps})'),
  };
  fs.writeSync(fd, JSON.stringify(meta) + '\n');
  fs.closeSync(fd);
  return { file: out, frames: state.wrote, chunks: state.chunks, fnv: state.hash, pageFnv: pageStats.fnv,
           framesMatch: state.wrote === pageStats.n && state.hash === pageStats.fnv,
           drive: drvStop, rng: rngInfo, meta };
}

/** 读回 JSONL 容器；帧号必须从 0 连续递增（丢一条就报错） */
function readRecording(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
  const rec = { file, header: null, frames: [], rng: null, rngSites: null, meta: null, rngOverflow: null };
  for (let i = 0; i < lines.length; i++) {
    const o = JSON.parse(lines[i]);
    if (o.k === 'header') rec.header = o;
    else if (o.k === 'frame') {
      if (o.f !== rec.frames.length) {
        throw new Error(`录制文件帧号不连续：第 ${rec.frames.length} 条是 f=${o.f}（${file}）`);
      }
      rec.frames.push(o);
    } else if (o.k === 'rng') { rec.rng = o.seq; rec.rngOverflow = o.overflow; rec.rngSites = o.sites || null; }
    else if (o.k === 'meta') rec.meta = o;
  }
  if (!rec.header) throw new Error('录制文件缺 header 行: ' + file);
  return rec;
}

/** 回放一局：同一份录制 → 逐帧注入按键 → 逐帧再采样（并可选分片落盘） */
async function replayEpisode(rec, opts = {}) {
  if ((!rec.rng || !rec.rng.length) && !rec.rngSites) {
    throw new Error('这份录制没有随机序列（rng 行），无法回放：录制时必须用 rng:record（Match.open 默认）');
  }
  const { Match } = require('./match');
  const boot = (rec.header.init && rec.header.init.bootstrap) || {};
  // ★ ②：回放要钉住录制时的绝对时钟（epoch）——game.rnd 种子 + 主题筛选都吃 Date
  const vtEpoch = (rec.header.init && rec.header.init.vtEpoch !== undefined) ? rec.header.init.vtEpoch : null;
  const m = new Match();
  const out = opts.out || null;
  const frames = rec.frames;
  const t0 = Date.now();
  try {
    await m.open(Object.assign({}, boot, {
      rng: 'play', rngSeq: rec.rng, rngSites: rec.rngSites, control: false, verbose: !!opts.verbose,
      bootFrames: opts.bootFrames || BOOT_FRAMES,
      freezeUntilMenu: !!opts.freezeUntilMenu, rebaseAtMenu: opts.rebaseAtMenu !== false,
      clearBootTimers: !!opts.clearBootTimers,
      epoch: (vtEpoch !== null) ? vtEpoch : undefined,
      humanIds: boot.humanIds || ['tank_a', 'tank_b'], aiCount: boot.aiCount || 0,
      vantCount: boot.vantCount || 0,
    }));

    // ★ ② 硬校验：回放出来的第一张地图主题必须 == 录制 header 里的主题。
    //   为什么用「锁 epoch + 断言」而不是「把 header 主题当参数传进去」：
    //   ① getRandomActiveTheme() 的选取本身要消费【恰好 1 次】Math.random
    //      （game_core/js/54518faa8d672020d7af8ed7c353bc1b.js:35636），
    //      直接传显式主题会少消费一次 ⟹ 后面整条随机序列全体错位；
    //   ② 一局有多个回合，每个回合都会重新选主题，header 里只有第 1 回合的主题。
    //   锁 epoch 后 new Date() 与录制时逐帧相同 ⟹ 每回合主题都与录制一致；
    //   逐帧 hs.th 哨兵再做硬对拍。本断言只负责"跨月/跨主题窗口"这类失效被响亮抓住。
    const themeCheck = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var mz = gc ? gc.getMaze() : null;
      return mz ? { theme: (mz.getTheme ? mz.getTheme() : null), w: mz.width, h: mz.height } : null;
    })()`);
    const headerMaze = (rec.header.init && rec.header.init.maze) || null;
    if (headerMaze && themeCheck && themeCheck.theme !== headerMaze.theme) {
      throw new Error('回放主题与录制 header 不一致：header theme=' + headerMaze.theme +
        ' 实际 theme=' + themeCheck.theme + '（② 跨月/主题窗口校验失败）');
    }

    const initPose = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var ids = __vtArr(gc.getActivePlayerIds()), out = [];
      for (var i = 0; i < ids.length; i++) {
        var t = gc.getTank(ids[i]);
        if (t) out.push({ id: ids[i], x: t.getX(), y: t.getY(), rot: t.getRotation() });
      }
      out.sort(function (a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });
      return out;
    })()`);

    // 分片把计划喂进页面（与导出同理：不许一次塞整局）
    const planChunk = opts.planChunk || 50;
    await m.eval('window.__vtDrive.install()');
    for (let i = 0; i < frames.length; i += planChunk) {
      await m.eval(`window.__vtDrive.load(${JSON.stringify(frames.slice(i, i + planChunk))})`);
    }
    await m.eval(`window.__vtRec.start(${JSON.stringify({
      page: (rec.header.init && rec.header.init.page) || 'index.html',
      bootstrap: boot, driven: (rec.header.init && rec.header.init.driven) || null,
    })})`);
    await m.eval(`window.__vtDrive.start(${frames.length})`);

    let fd = null;
    const state = { from: 0, wrote: 0, hash: FNV0, chunks: 0 };
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fd = fs.openSync(out, 'w');
      fs.writeSync(fd, (await m.eval('window.__vtRec.header()')) + '\n');
    }

    const pumpChunk = opts.pumpChunk || 50;
    for (let done = 0; done < frames.length; done += pumpChunk) {
      await m.pump(Math.min(pumpChunk, frames.length - done), { yieldMs: 0 });
      if (fd) await exportFrames(m, fd, state, opts);
    }
    const drvStop = await m.eval('window.__vtDrive.stop()');
    const pageStats = await m.eval('window.__vtRec.stats()');
    if (fd) {
      await exportFrames(m, fd, state, opts);
      fs.writeSync(fd, JSON.stringify(Object.assign({ k: 'meta' }, pageStats, { pageFnv: pageStats.fnv, replay: true, drive: drvStop })) + '\n');
      fs.closeSync(fd);
    }
    const rngState = await m.eval('window.__vtRng.state()');
    return { initPose, themeCheck, drive: drvStop, pageStats, rngState, file: out, wallMs: Date.now() - t0,
             chunks: state.chunks,
             framesMatch: state.wrote === pageStats.n && state.hash === pageStats.fnv };
  } finally { await m.close(); }
}

/** 两遍录制逐帧对拍：opName(含 fire) + 坦克位姿 + 子弹位姿 */
function compareFrames(A, B, label) {
  const out = { label, framesA: A.length, framesB: B.length, ok: true,
                opMismatch: 0, poseMismatch: 0, projMismatch: 0, stateMismatch: 0,
                rngMismatch: 0, rngBootOffset: 0, rngOffsetFrames: 0, rngOffsetExamples: [],
                timeMismatch: 0, hiddenMismatch: 0, hiddenObsMismatch: 0, driveMismatch: 0,
                maxPoseDiff: 0, maxTimeDiff: 0, examples: [], obsExamples: [] };
  const N = Math.min(A.length, B.length);
  // ★ 2026-10-12 boot 阶段 RNG flaky：把「恒定偏移」和「局内漂移」分开。
  //   record 与 replay 是两个页面实例；录制起点之前（boot/资产/页面初始化）有些
  //   真实事件驱动的 Math.random 消费者（DOM/资产时序相关），两边的调用次数可能
  //   整局恒定差 1（实测 A=4420/B=4419 从帧 0 起 1200 帧，siteOverflow=0、
  //   其余 10 个计数器全 0）。
  //   这不是局内漂移：per-site 分流下每个调用点拿自己的序列，游戏状态逐帧相同。
  //   真正要抓的是「差值在录制过程中发生变化」——那才是真回归。
  //   零录制格式改动：只改对拍语义；旧录制同样适用。
  let rnBaseDiff = null, rnConst = true;
  for (let i = 0; i < N; i++) {
    const a = A[i], b = B[i];
    if (typeof a.rn !== 'number' || typeof b.rn !== 'number') continue;
    const d = a.rn - b.rn;
    if (rnBaseDiff === null) rnBaseDiff = d;
    else if (d !== rnBaseDiff) { rnConst = false; break; }
  }
  const bootOffset = (rnConst && rnBaseDiff !== null && rnBaseDiff !== 0) ? rnBaseDiff : 0;
  out.rngBootOffset = bootOffset;
  const ex = (s) => { if (out.examples.length < 5) out.examples.push(s); };
  const exObs = (s) => { if (out.obsExamples.length < 5) out.obsExamples.push(s); };
  // ★ 决定性部分：v4 起 hs 已只含决定性字段；老录制（v≤3）的 hs 里混着观测性字段，
  //   比对前按白名单剔除，避免旧文件继续产生"仅 hidden"的假 FAIL。
  const LEGACY_OBS_KEYS = ['q', 'pg', 'tf', 'lu'];
  const detOf = (frame) => {
    if (!frame || frame.hs === undefined) return undefined;
    if (frame.hx !== undefined) return frame.hs;       // v4：已经是拆好的
    const o = {};
    for (const k in frame.hs) if (LEGACY_OBS_KEYS.indexOf(k) < 0) o[k] = frame.hs[k];
    return o;
  };
  for (let i = 0; i < N; i++) {
    const a = A[i], b = B[i];
    const ta = {}, tb = {};
    (a.tanks || []).forEach((t) => { ta[t.id] = t; });
    (b.tanks || []).forEach((t) => { tb[t.id] = t; });
    const ids = Array.from(new Set(Object.keys(ta).concat(Object.keys(tb)))).sort();
    for (const id of ids) {
      const x = ta[id], y = tb[id];
      if (!x || !y) { out.opMismatch++; out.poseMismatch++; out.ok = false;
        ex(`帧${i} ${id}: 一边缺席 (A=${!!x} B=${!!y})`); continue; }
      if (x.op !== y.op || x.opName !== y.opName || x.fire !== y.fire ||
          x.action !== y.action || x.fwd !== y.fwd || x.back !== y.back ||
          x.left !== y.left || x.right !== y.right) {
        out.opMismatch++; out.ok = false;
        ex(`帧${i} ${id}: op A=${x.opName}/fire=${x.fire}/act=${x.action} B=${y.opName}/fire=${y.fire}/act=${y.action}`);
      }
      const d = Math.max(Math.abs(x.x - y.x), Math.abs(x.y - y.y), Math.abs(x.rot - y.rot));
      if (d > out.maxPoseDiff) out.maxPoseDiff = d;
      if (d !== 0) {
        out.poseMismatch++; out.ok = false;
        ex(`帧${i} ${id}: 位姿 A=(${x.x},${x.y},${x.rot}) B=(${y.x},${y.y},${y.rot})`);
      }
    }
    if (a.st !== b.st) {
      out.stateMismatch++; out.ok = false;
      ex(`帧${i}: 回合状态 A=${a.st} B=${b.st}`);
    }
    const dt = Math.abs((a.t || 0) - (b.t || 0));
    if (dt > out.maxTimeDiff) out.maxTimeDiff = dt;
    if (dt > 1e-6) {
      out.timeMismatch++; out.ok = false;
      ex('帧' + i + ': 相对虚拟时间 A=' + a.t + ' B=' + b.t);
    }
    if (a.rn !== b.rn) {
      const bothNum = (typeof a.rn === 'number' && typeof b.rn === 'number');
      if (bootOffset !== 0 && bothNum) {
        // 恒定偏移 = 录制起点之前的 boot 差异：记信息，不判 FAIL
        out.rngOffsetFrames++;
        if (out.rngOffsetExamples.length < 3) {
          out.rngOffsetExamples.push(`帧${i}: A=${a.rn} B=${b.rn}（恒定差 ${bootOffset}，判为 boot 偏移）`);
        }
      } else {
        // 局内漂移（差值变化 / 一侧缺失）= 真回归，硬 FAIL
        out.rngMismatch++; out.ok = false;
        ex(`帧${i}: 随机数消费计数 A=${a.rn} B=${b.rn}`);
      }
    }
    // ★ 本帧实际施加的输入（v3）：这是"录制的事实"，必须逐帧一致；
    //   ⚠️ 两边都有 drive 才比：v≤2 的旧录制没这个字段，按 OR 会比出 200 条
    //      "undefined vs [...]" 假 FAIL（实测 prof/detfix/verify_legacy_v2.log）。
    if (a.drive !== undefined && b.drive !== undefined) {
      const da = JSON.stringify(a.drive), db = JSON.stringify(b.drive);
      if (da !== db) {
        out.driveMismatch++; out.ok = false;
        ex(`帧${i}: 实际输入 A=${String(da).slice(0, 140)} B=${String(db).slice(0, 140)}`);
      }
    }
    // ★ 决定性隐藏哨兵（hs）：不一致 = 硬 FAIL。v1 没有 hs；两边都有才比
    //   （单边有 = 旧录制无法验证隐藏状态，跳过而不是判死）。
    const ha = detOf(a), hb = detOf(b);
    if (ha !== undefined && hb !== undefined) {
      const sa = JSON.stringify(ha), sb = JSON.stringify(hb);
      if (sa !== sb) {
        out.hiddenMismatch++; out.ok = false;
        ex(`帧${i}: 决定性隐藏状态 A=${String(sa).slice(0, 170)} B=${String(sb).slice(0, 170)}`);
      }
    }
    // ☆ 观测性/环境相关（hx）：不一致 = 信息项，【绝不】参与 PASS/FAIL
    //   ⚠️ 两边都有 hx 才比：旧录制（v≤3）只有 hs，没有 hx；若按 OR 比，
    //      旧录制 vs 新回放会逐帧报 "undefined vs {...}" 的假信息项（1200 条噪声）。
    if (a.hx !== undefined && b.hx !== undefined) {
      const xa = JSON.stringify(a.hx), xb = JSON.stringify(b.hx);
      if (xa !== xb) {
        out.hiddenObsMismatch++;
        exObs(`帧${i}: 观测性(仅信息) A=${String(xa).slice(0, 170)} B=${String(xb).slice(0, 170)}`);
      }
    }
    const pa = JSON.stringify(a.projs || []), pb = JSON.stringify(b.projs || []);
    if (pa !== pb) {
      out.projMismatch++; out.ok = false;
      ex(`帧${i}: 子弹 A=${pa.slice(0, 120)} B=${pb.slice(0, 120)}`);
    }
  }
  if (A.length !== B.length) { out.ok = false; ex(`帧数不同: A=${A.length} B=${B.length}`); }
  return out;
}

module.exports = {
  VERSION, PAGE_SRC, FRAME_CHUNK, RNG_CHUNK,
  fnvStep, FNV0, scriptedPlan, opBits, pushPlan,
  exportFrames, exportRng, recordEpisode, readRecording, replayEpisode, compareFrames,
};

// ---------------- CLI：录一局 ----------------
if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const num = (name, d) => { const i = argv.indexOf('--' + name); return i < 0 ? d : Number(argv[i + 1]); };
    const str = (name, d) => { const i = argv.indexOf('--' + name); return i < 0 ? d : argv[i + 1]; };
    const flag = (name) => argv.includes('--' + name);
    const frames = num('frames', 400);
    const ids = (str('ids', 'tank_a,tank_b')).split(',');
    const out = str('out', path.join(__dirname, 'prof', 'episode.jsonl'));
    const { Match } = require('./match');
    const m = new Match();
    try {
      const r = await recordEpisode(m, {
        frames, ids, out, verbose: flag('verbose'),
        open: { humanIds: ids, aiCount: num('ai', 0), vantCount: 0 },
      });
      console.log(JSON.stringify({
        ok: r.framesMatch, file: r.file, frames: r.frames, chunks: r.chunks, hash: r.fnv, pageHash: r.pageFnv,
        drive: r.drive, rngLen: r.rng.len, rngOverflow: r.rng.overflow,
        wallMs: r.meta.wallMs, vt: r.meta.vt,
      }, null, 2));
      if (!r.framesMatch) { console.error('帧数/哈希不一致：导出丢记录'); process.exitCode = 1; }
      if (r.rng.overflow) { console.error('rng overflow =', r.rng.overflow); process.exitCode = 1; }
      if (r.meta.recErr) { console.error('页面录制器报错:', r.meta.recErr); process.exitCode = 1; }
      if (r.drive.errs) { console.error('驱动注入报错 errs =', r.drive.errs); process.exitCode = 1; }
    } catch (e) {
      console.error('FAILED:', (e && e.stack) || e);
      process.exitCode = 1;
    } finally { await m.close(); }
  })();
}
