/**
 * pm_panel2.js —— 【实机/面板路径】同步闸门 A/B（页内驱动版）
 * ==========================================================================
 * 为什么不用 pm_panel.js 的 Node 侧轮询：每帧要 poll 好几次 `inflight`，而每次 poll 是一次 CDP 往返
 *   （机器忙时实测 10~20ms）⟹ "同步"的耗时会被 CDP 轮询本身污染（实测同一份代码 168ms/帧 vs 30ms/帧）。
 *   本脚本把**整个驱动循环放进页面里跑**（一次 eval），等回包用 `MessageChannel`（真 macrotask，
 *   不受 clock.js 的虚拟 setTimeout 影响），页内计时用 `new Event().timeStamp`（真单调钟）。
 *
 * 量什么：
 *   · frame_ms   = 一次 `__vtStep(1)` 的页内真实成本（物理+渲染；被冻帧时只跑管线）
 *   · rtt_ms     = 一次 /vt_policy 的浏览器 fetch 往返（含 HTTP + python 桥 + 服务端推理）
 *   · sync 模式串行每帧 = frame + rtt ⟹ 由它推 FPS
 *   · async 模式的决策覆盖率（served/ticks）与 60fps 下的理论丢帧率
 * 用法：node _tools/perf/pm_panel2.js --players 2 --frames 100 --mode sync --tag A
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Match } = require('../headless/match');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const OUT = arg('out', 'D:/vt_run/perf');
const TAG = arg('tag', 'panel2');
const PLAYERS = Number(arg('players', 2));
const FRAMES = Number(arg('frames', 100));
const MODE = arg('mode', 'sync');
const MEM = arg('mem', null);
const PACE = Number(arg('pace', 16.7));   // async 基线的帧间隔（模拟真实 60fps 节奏）
const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const med = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const pctl = (a, p) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.round((p / 100) * (b.length - 1)))]; };
const r2 = (x) => (x === null || x === undefined) ? null : Math.round(x * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function lcgSeq(seed, n) { let s = (seed >>> 0) || 1; const a = new Array(n); for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; a[i] = s / 4294967296; } return a; }

const INSTALL = `(() => {
  window.__pmP = { rtt: [], bytes: [] };
  function rnow() { return new Event('__p2').timeStamp; }
  var f0 = window.fetch;
  window.fetch = function (u, o) {
    var url = String(u && u.url ? u.url : u);
    if (url.indexOf('/vt_policy') < 0) return f0.apply(window, arguments);
    var t = rnow();
    try { if (o && o.body) window.__pmP.bytes.push(String(o.body).length); } catch (eB) {}
    return f0.apply(window, arguments).then(function (r) { window.__pmP.rtt.push(rnow() - t); return r; },
                                            function (e) { window.__pmP.rtt.push(-1); throw e; });
  };
  window.__pmTick = function () { return new Promise(function (res) { var c = new MessageChannel(); c.port1.onmessage = function () { c.port1.close && c.port1.close(); res(); }; c.port2.postMessage(0); }); };
  return 1;
})()`;

const DRIVER = (frames, mode, maxWaitMs) => `(async () => {
  var T = { frame: [], total: [], stalls: 0, ctx: [] };
  function rnow() { return new Event('__p2d').timeStamp; }
  for (var i = 0; i < ${frames}; i++) {
    var t0 = rnow();
    window.__vtStep(1);
    var f1 = rnow();
    T.frame.push(f1 - t0);
    if ('${mode}' === 'sync') {
      var w0 = rnow();
      while (window.VantageAgentPanel.getState().inflight && (rnow() - w0) < ${maxWaitMs}) { await window.__pmTick(); }
      if ((rnow() - w0) >= ${maxWaitMs}) T.stalls += 1;
    } else {
      var p0 = rnow();
      while (rnow() - p0 < ${PACE}) { await window.__pmTick(); }
    }
    T.total.push(rnow() - t0);
  }
  var S = window.VantageAgentPanel.getState();
  return JSON.stringify({ T: T, rtt: window.__pmP.rtt, bytes: window.__pmP.bytes,
    st: { ticks: S.ticks, served: S.served, servedTotal: S.servedTotal, skipInflight: S.skipInflight,
          overlapInflight: S.overlapInflight, pauses: S.pauses, resumes: S.resumes, watchdogResumes: S.watchdogResumes,
          resumeMiss: S.resumeMiss, pauseMode: S.pauseMode, pauseErr: S.pauseErr, errCount: S.errCount, lastErr: S.lastErr,
          deltaReset: S.deltaReset, lat: (S.lat || []).slice(-300) } });
})()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const m = new Match();
  try {
    await m.open({ players: PLAYERS, storm: false, control: false, rngSeq: lcgSeq(777 + PLAYERS, 150000) });
    await m.pump(40);
    await m.eval(INSTALL);
    if (MEM !== null) await m.eval('(function(){ var S = window.VantageAgentPanel.getState(); S.mem = ' + (String(MEM) === '1') + '; window.__vtConfig.mem = S.mem; return S.mem; })()');
    await m.eval('window.__vtConfig.sync = ' + (MODE === 'sync') + '; 1');
    await m.eval('window.VantageAgentPanel.activateNN(); 1');
    let on = false;
    for (let k = 0; k < 80; k++) {
      await m.pump(2); await sleep(100);
      const s = JSON.parse(await m.eval('JSON.stringify(window.VantageAgentPanel.status())'));
      if (s.on) { on = true; break; }
    }
    if (!on) throw new Error('activateNN 后 S.on 仍 false');
    // 预热到 served>=5（第一次请求会撞上策略进程开机）
    let warmed = 0;
    for (let k = 0; k < 500; k++) {
      await m.pump(2); await sleep(25);
      const s = JSON.parse(await m.eval('JSON.stringify(window.VantageAgentPanel.status())'));
      if (s.served >= 5) { warmed = s.served; break; }
    }
    if (!warmed) throw new Error('预热失败；state=' + await m.eval(`(function(){ var S=window.VantageAgentPanel.getState(); var g=GameManager.getGame(); return JSON.stringify({on:S.on,ticks:S.ticks,served:S.served,servedTotal:S.servedTotal,inflight:S.inflight,skip:S.skipInflight,paused:S.paused,err:S.errCount,lastErr:S.lastErr,gpaused:g?g.paused:null,seq:S.seq}); })()`));
    await m.eval('window.__pmP.rtt=[]; window.__pmP.bytes=[]; 1');
    await m.eval(`(function(){ var S=window.VantageAgentPanel.getState(); S.ticks=0;S.served=0;S.servedTotal=0;S.skipInflight=0;S.overlapInflight=0;S.pauses=0;S.resumes=0;S.watchdogResumes=0;S.resumeMiss=0;S.lat=[];S.errCount=0;S.deltaReset=0; return 1; })()`);
    const t0 = nowMs();
    const raw = JSON.parse(await m.eval(DRIVER(FRAMES, MODE, 5000), { awaitPromise: true }));
    const wall = nowMs() - t0;
    const T = raw.T, st = raw.st;
    const rtt = (raw.rtt || []).filter((x) => x >= 0);
    const pb = raw.bytes || [];
    const agg = {
      tag: TAG, mode: MODE, players: PLAYERS, frames: FRAMES, mem: MEM,
      wall_ms: r2(wall), wall_fps: r2(1000 * FRAMES / wall),
      frame_ms: { med: r2(med(T.frame)), p90: r2(pctl(T.frame, 90)) },
      frame_total_ms: { med: r2(med(T.total)), p90: r2(pctl(T.total, 90)) },
      policy_rtt_ms: { med: r2(med(rtt)), p90: r2(pctl(rtt, 90)), n: rtt.length },
      srvLat_ms: { med: r2(med(st.lat || [])), n: (st.lat || []).length },
      serial_frame_ms: r2((med(T.frame) || 0) + (med(rtt) || 0)),
      fps_serial: r2(1000 / ((med(T.frame) || 0) + (med(rtt) || 0))),
      payloadBytes: { med: r2(med(pb)), max: pb.length ? Math.max(...pb) : null },
      ticks: st.ticks, servedTotal: st.servedTotal, dropped: st.skipInflight, overlap: st.overlapInflight,
      coverage_pct: st.ticks ? r2(100 * st.servedTotal / st.ticks) : null,
      sync_gate: { pauses: st.pauses, resumes: st.resumes, watchdog: st.watchdogResumes, resumeMiss: st.resumeMiss, mode: st.pauseMode, err: st.pauseErr, deltaReset: st.deltaReset },
      stalls: T.stalls, errCount: st.errCount, lastErr: st.lastErr, pageErrors: (m.pageErrors || []).slice(0, 3)
    };
    fs.writeFileSync(path.join(OUT, 'panel2_' + TAG + '.json'), JSON.stringify({ agg, raw }, null, 1));
    console.log(JSON.stringify(agg, null, 2));
    await m.close();
  } catch (e) {
    console.error('FAILED ' + ((e && e.stack) || e));
    process.exitCode = 1;
    try { await m.close(); } catch (e2) {}
  }
})();
