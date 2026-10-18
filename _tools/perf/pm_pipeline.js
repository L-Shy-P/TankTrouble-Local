/**
 * pm_pipeline.js —— 【同步流水】整帧基准：pump(1) / step 编码 / 服务端往返 / 每帧合计 / 实际帧/秒
 * ==========================================================================
 * 干什么（与 `_tools/eval/run_scenes_30.js` 的同步路径**同序**）：
 *     每帧： pump(1) → `window.__g1.step(nodeId)`（浏览器内编码 + JSON.stringify）→ 服务端 ask → 下一帧
 *   · 页内计时：包一层 `VantageObserve.encode` 与 `window.__g1.step`，用 `performance.now()` 打分（⛔ 不改游戏代码）
 *   · Node 计时：hrtime，包 CDP 往返 / Node 侧 JSON.parse+buildSegs / 服务端 ask
 *   · 丢帧：本脚本是**同步等待**语义（ask 回来才泵下一帧）⟹ 丢帧恒 0（会显式断言并打印）
 *
 * 用法：
 *   node _tools/perf/pm_pipeline.js --players 8 --frames 60 --tag before
 *   node _tools/perf/pm_pipeline.js --players 8 --frames 60 --tag after --env VT_FAST_TENSOR=1 --env VT_FAST_MEM=1
 *   node _tools/perf/pm_pipeline.js --players 8 --frames 60 --tag before --norender   # 对照：关渲染的 pump
 *
 * 产物：D:/vt_run/perf/pipeline_<tag>.json（含每帧原始数组 + 中位数汇总 + 最大 N 的那份真实载荷，供 pm_bench 复用）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Match } = require('../headless/match');
const SEGS = require('../headless/_segs.js');
const { makeAsk } = require('../headless/_policy_client.js');

const REPO = path.resolve(__dirname, '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const flag = (n) => process.argv.includes('--' + n);
const OUT = arg('out', 'D:/vt_run/perf');
const TAG = arg('tag', 'run');
const PLAYERS = Number(arg('players', 2));
const FRAMES = Number(arg('frames', 60));
const WARMFRAMES = Number(arg('warmframes', 20));
const CKPT = arg('ckpt', process.env.VT_CKPT || 'D:/vt_run/cyc_1/ckpt/model_latest.pt');
const NORENDER = flag('norender');
// ⭐ 配对 A/B：帧号偶数走 base(_fast='')、奇数走 ALL(_fast=第 2 个参数)，同一浏览器会话同一批机器状态下轮转采样
const FASTALT = arg('fastalt', null);   // 形如 'mem,echo,json,tensor,argmax,sync,zero,memg'
const DUMP = flag('dump') || true;
const EXTRA_ENV = {};
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--env') { const kv = process.argv[i + 1] || ''; const j = kv.indexOf('='); if (j > 0) EXTRA_ENV[kv.slice(0, j)] = kv.slice(j + 1); }
}
const SRC = fs.readFileSync(path.join(__dirname, '..', 'headless', '_g1_inject.js'), 'utf8');

const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const med = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const pctl = (a, p) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.max(0, Math.round((p / 100) * (b.length - 1))))]; };
const r2 = (x) => (x === null || x === undefined) ? null : Math.round(x * 100) / 100;

function lcgSeq(seed, n) { let s = (seed >>> 0) || 1; const a = new Array(n); for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; a[i] = s / 4294967296; } return a; }

function startSrv() {
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', VT_CKPT: CKPT, VT_PROBE_MS: '1' }, EXTRA_ENV);
  const proc = spawn('py', ['-3.13', '_tools/training/policy_server_graph.py'], { cwd: REPO, env });
  proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
  const boot = [];
  proc.stderr.on('data', (d) => String(d).split('\n').forEach((l) => { if (l.trim()) { if (boot.length < 400) boot.push(l); if (l.indexOf('CKPT_LOADED') >= 0 || l.indexOf('ERR') >= 0 || l.indexOf('MISMATCH') >= 0) console.error('SRV ' + l); } }));
  // ⭐ makeAsk 会把诊断行也当 JSON 塞进队列 ⟹ 这里只放行 JSON 行（见 pm_bench.js 同款注释）
  const PT = require('stream').PassThrough;
  const pt = new PT(); pt.setEncoding('utf8');
  let rbuf = '';
  let resolveBoot = null;
  const bootReady = new Promise((r) => { resolveBoot = r; });
  proc.stdout.on('data', (d) => {
    rbuf += d; let i;
    while ((i = rbuf.indexOf('\n')) >= 0) {
      const line = rbuf.slice(0, i); rbuf = rbuf.slice(i + 1);
      if (!line.trim()) continue;
      if (line.trim().charAt(0) === '{') pt.write(line + '\n');
      else { boot.push(line); if (line.indexOf('WARMUP_SAMPLE') >= 0) resolveBoot(boot); }
    }
  });
  const _bt = setTimeout(() => resolveBoot(boot.concat(['BOOT_TIMEOUT'])), 240000); if (_bt.unref) _bt.unref();
  const ask = makeAsk({ stdin: proc.stdin, stdout: pt });
  return { proc, ask, boot, ready: bootReady };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = startSrv();
  const m = new Match();
  const pump = [], stepCdp = [], build = [], askMs = [], total = [], pageStep = [], pageEnc = [], payloadBytes = [], nodeCounts = [], srvInside = [];
  const arms = [];
  let maxPay = null, maxN = -1, frames = 0, nodeId = 0, dropFrames = 0, errs = 0, askErr = 0;
  const fingerprints = [];
  try {
    await srv.ready;
    if (srv.boot.indexOf('BOOT_TIMEOUT') >= 0) throw new Error('策略服务端开机超时；stderr 尾部=' + JSON.stringify(srv.boot.slice(-3)));
    await m.open({ players: PLAYERS, storm: false, control: false, rngSeq: lcgSeq(4242 + PLAYERS, 150000) });
    if (NORENDER) await m.setNoRender(true);
    await m.eval(SRC);
    await m.eval('window.__g1.subscribe()');
    await m.eval('window.__g1.setup()');
    await m.eval('window.__g1.setFire(1)');
    const meta = JSON.parse(await m.eval('JSON.stringify(window.__g1.meta())'));
    const inRound = (meta.states && meta.states.IN_ROUND) || 'in round';
    // ⭐ 页内计时钩子（只读：包一层，不改任何逻辑）
    // ⚠️ 页内 `performance.now()` / `Date.now()` / `new Date()` 全被 `_tools/headless/clock.js` 虚拟化（实测恒 0）⟹
    //    页内计时必须用**没被接管**的真钟：实测可用的是 `new Event().timeStamp`（浏览器内部单调钟）
    //    与 `performance.mark/measure`（两者在同一轮实测里对同一段 2e6 次循环分别给出 5.2ms / 6.8ms，虚拟钟给 0）。
    await m.eval(`(() => {
      window.__pmT = { enc: [], step: [], clock: 'event.timeStamp' };
      function rnow() { return new Event('__pm').timeStamp; }
      var O = window.VantageObserve, e0 = O.encode;
      O.encode = function () { var t = rnow(); var r = e0.apply(O, arguments); window.__pmT.enc.push(rnow() - t); return r; };
      var s0 = window.__g1.step;
      window.__g1.step = function () { var t = rnow(); var r = s0.apply(window.__g1, arguments); window.__pmT.step.push(rnow() - t); return r; };
      return 1;
    })()`);

    for (let f = 0; f < WARMFRAMES + FRAMES; f++) {
      if (f === WARMFRAMES) { pump.length = 0; stepCdp.length = 0; build.length = 0; askMs.length = 0; total.length = 0; pageStep.length = 0; pageEnc.length = 0; payloadBytes.length = 0; nodeCounts.length = 0; srvInside.length = 0; await m.eval('window.__pmT.enc=[];window.__pmT.step=[]'); }
      const t0 = nowMs();
      await m.pump(1, { yieldMs: 0 });
      const t1 = nowMs();
      const o = JSON.parse(await m.eval('window.__g1.step(' + nodeId + ')'));
      const t2 = nowMs();
      if (o.err) { console.error('STEP_ERR ' + o.err); errs++; break; }
      if (f > 5 && o.state && o.state !== inRound) { console.error('ROUND_END at warm+f=' + f); break; }
      let t3 = t2, t4 = t2, pay = null;
      if (o.N >= 1) {
        const built = SEGS.buildSegs({ n: o.segs.node, opp: (o.segs.opp && o.segs.opp[0]) || [], b: o.segs.bullet, item: o.segs.item, g: (o.segs.global && o.segs.global[0]) || [] });
        const vio = SEGS.validateSegs(built.segs);
        if (!vio.ok) { console.error('SEGS_INVALID ' + vio.errors.slice(0, 3).join('; ')); errs++; break; }
        t3 = nowMs();
        const payload = { N: o.N, seed: 900000 + (f % 1000), mem_on: 0, segs: built.segs };
        if (FASTALT) payload._fast = (f % 2 === 1) ? FASTALT : '';
        const body = JSON.stringify(payload) + '\n';
        const pb = Buffer.byteLength(body);
        const j = await srv.ask(payload);
        t4 = nowMs();
        if (!j || j.err || typeof j.nodeId !== 'number') { askErr++; if (askErr <= 3) console.error('ASK_BAD ' + JSON.stringify(j && (j.err || j)).slice(0, 300)); }
        else { nodeId = j.nodeId; if (fingerprints.length < 3) fingerprints.push([j.nodeId, r2(j.lp), r2(j.v), j.fire]); }
        if (j && j._pm && typeof j._pm.total === 'number') srvInside.push(j._pm.total);
        if (f >= WARMFRAMES) {
          pump.push(t1 - t0); stepCdp.push(t2 - t1); build.push(t3 - t2); askMs.push(t4 - t3);
          payloadBytes.push(pb); nodeCounts.push(o.N); if (FASTALT) arms.push(f % 2 === 1 ? 'ALL' : 'base');
          if (pb >= 0 && o.N > maxN) { maxN = o.N; maxPay = { payload, bytes: pb, meta: { players: PLAYERS, N: o.N, frame: f, segRows: o.segRows } }; }
        }
      }
      total.push(t4 - t0);
      frames++;
    }
    // 页内时间
    const pt2 = JSON.parse(await m.eval('JSON.stringify(window.__pmT)'));
    pageEnc.push(...pt2.enc); pageStep.push(...pt2.step);
    await m.close();
    const dropByDesign = 0;
    const agg = {
      tag: TAG, env: EXTRA_ENV, players: PLAYERS, frames: total.length, warmFrames: WARMFRAMES,
      norender: NORENDER, ckpt: CKPT,
      pump_ms: { med: r2(med(pump)), p90: r2(pctl(pump, 90)) },
      step_cdp_ms: { med: r2(med(stepCdp)), p90: r2(pctl(stepCdp, 90)) },
      step_page_ms: { med: r2(med(pageStep)), p90: r2(pctl(pageStep, 90)) },
      encode_page_ms: { med: r2(med(pageEnc)), p90: r2(pctl(pageEnc, 90)) },
      node_build_ms: { med: r2(med(build)), p90: r2(pctl(build, 90)) },
      ask_rtt_ms: { med: r2(med(askMs)), p90: r2(pctl(askMs, 90)), min: r2(Math.min(...askMs)) },
      srv_inside_ms: { med: r2(med(srvInside)), p90: r2(pctl(srvInside, 90)), n: srvInside.length },
      frame_total_ms: { med: r2(med(total)), p90: r2(pctl(total, 90)) },   // total 已在 warm 边界清过 ⟹ 只含计时帧
      payloadBytes: { med: r2(med(payloadBytes)), max: payloadBytes.length ? Math.max(...payloadBytes) : null },
      nodeN: { med: r2(med(nodeCounts)), max: nodeCounts.length ? Math.max(...nodeCounts) : null },
      fps_derived: r2(1000 / med(total)),
      dropFrames: dropByDesign, frames_requested: FRAMES, frames_completed: total.length, stepErrs: errs, askErrs: askErr,
      fingerprint: fingerprints,
      paired: FASTALT ? (function () {
        const out = {};
        for (const a of ['base', 'ALL']) {
          const idx = arms.map((v, i) => (v === a ? i : -1)).filter((i) => i >= 0);
          const pick = (arr) => idx.map((i) => arr[i]).filter((x) => typeof x === 'number');
          const A = pick(askMs), S = pick(srvInside), P = pick(pump), T = pick(total);
          out[a] = { n: idx.length, pump: r2(med(P)), ask: r2(med(A)), srv: r2(med(S)), trans: r2(med(A) - med(S)), frame_total: r2(med(T)), fps: r2(1000 / med(T)) };
        }
        return out;
      })() : null
    };
    const f1 = path.join(OUT, 'pipeline_' + TAG + '.json');
    fs.writeFileSync(f1, JSON.stringify({ agg, raw: { pump, stepCdp, build, askMs, total, payloadBytes, nodeCounts } }, null, 1));
    if (maxPay) fs.writeFileSync(path.join(OUT, 'payload_p' + PLAYERS + '_N' + maxN + '.json'), JSON.stringify(maxPay));
    console.log(JSON.stringify(agg, null, 2));
    console.log('WROTE ' + f1 + (maxPay ? ('  + payload_p' + PLAYERS + '_N' + maxN + '.json (' + maxPay.bytes + ' bytes)') : ''));
  } catch (e) {
    console.error('FAILED ' + ((e && e.stack) || e));
    process.exitCode = 1;
    try { await m.close(); } catch (e2) {}
  } finally {
    try { srv.proc.stdin.end(); } catch (e) {}
    await new Promise((r) => { const t = setTimeout(() => { try { srv.proc.kill(); } catch (e) {} r(); }, 3000); srv.proc.on('exit', () => { clearTimeout(t); r(); }); });
  }
})();
