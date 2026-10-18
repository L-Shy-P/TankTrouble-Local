/**
 * pm_panel.js —— 【实机/面板路径】同步闸门 A/B：改前(丢帧 async) vs 改后(冻帧 sync)
 * ==========================================================================
 * 为什么单独一条：`run_scenes_30.js` / `pm_pipeline.js` 走的是 **Node↔Python 直连管道**，
 *   而实机面板走 **浏览器 fetch → game_core/server.py(HTTP) → 子进程管道 → Python**，多两跳 ⟹ 必须单独量。
 *
 * 量什么（每条都实测，页内真钟用 `new Event().timeStamp`，因为 `performance.now()` 被 headless 虚拟钟接管）：
 *   · 页内单帧成本（`__vtStep(1)`：物理 + 渲染）
 *   · 面板一次 /vt_policy 往返（浏览器 fetch 起止）
 *   · 决策覆盖率 = served / ticks（async 版会丢帧 ⟹ <100%）
 *   · 串行每帧成本 = 单帧成本 + 往返  ⟹ 能否 ≤16.7ms
 *
 * 用法：node _tools/perf/pm_panel.js --players 2 --frames 120 --tag sync_on
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Match } = require('../headless/match');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const OUT = arg('out', 'D:/vt_run/perf');
const TAG = arg('tag', 'panel');
const PLAYERS = Number(arg('players', 2));
const FRAMES = Number(arg('frames', 120));
const MODE = arg('mode', 'sync');         // sync | async
const PACEMS = Number(arg('pace', 16.7)); // async 模式：模拟真实 60fps 的帧间隔
const MEM = arg('mem', null);             // null=保持面板默认；0/1=强制记忆开关
const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const med = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const pctl = (a, p) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.round((p / 100) * (b.length - 1)))]; };
const r2 = (x) => (x === null || x === undefined) ? null : Math.round(x * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function lcgSeq(seed, n) { let s = (seed >>> 0) || 1; const a = new Array(n); for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; a[i] = s / 4294967296; } return a; }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const m = new Match();
  const frameMs = [], rttInPage = [], totals = [];
  let st0 = null, st1 = null, errs = [];
  try {
    await m.open({ players: PLAYERS, storm: false, control: false, rngSeq: lcgSeq(777 + PLAYERS, 150000) });
    await m.pump(40);
    const hasPanel = await m.eval('!!(window.VantageAgentPanel && window.VantageAgentPanel.status)');
    if (!hasPanel) throw new Error('页面上没有 VantageAgentPanel（game_core/index.html:681 未加载？）');
    // ⭐ 页内真钟 + /vt_policy 往返计时（包一层 fetch，只读）
    await m.eval(`(() => {
      window.__pmP = { rtt: [], frame: [], bytes: [], clock: 'event.timeStamp' };
      function rnow() { return new Event('__pmp').timeStamp; }
      var f0 = window.fetch;
      window.fetch = function (u, o) {
        var url = String(u && u.url ? u.url : u);
        if (url.indexOf('/vt_policy') < 0) return f0.apply(window, arguments);
        var t = rnow();
        try { if (o && o.body) window.__pmP.bytes.push(String(o.body).length); } catch (eB) {}
        return f0.apply(window, arguments).then(function (r) { window.__pmP.rtt.push(rnow() - t); return r; },
                                                function (e) { window.__pmP.rtt.push(-1); throw e; });
      };
      return 1;
    })()`);
    if (MEM !== null) await m.eval('(function(){ var S = window.VantageAgentPanel.getState(); S.mem = ' + (String(MEM) === '1') + '; window.__vtConfig.mem = S.mem; return S.mem; })()');
    if (MODE === 'async') await m.eval('window.__vtConfig.sync = false; 1');
    else await m.eval('window.__vtConfig.sync = true; 1');
    // 激活神经网络
    await m.eval('window.VantageAgentPanel.activateNN(); 1');
    let on = false;
    for (let k = 0; k < 60; k++) {
      await m.pump(2);
      const s = JSON.parse(await m.eval('JSON.stringify(window.VantageAgentPanel.status())'));
      if (s.on) { on = true; break; }
      await sleep(120);
    }
    if (!on) throw new Error('activateNN 后 S.on 仍为 false；status=' + JSON.stringify(await m.eval('JSON.stringify(window.VantageAgentPanel.status())')));
    // ⭐ 预热：第一次请求会撞上策略进程开机（加载权重 ~3-4s）⟹ 先跑到 served>=5 再开始计时
    let warmed = 0;
    for (let k = 0; k < 400; k++) {
      await m.pump(2);
      await sleep(30);
      const s2 = JSON.parse(await m.eval('JSON.stringify(window.VantageAgentPanel.status())'));
      if (s2.served >= 5) { warmed = s2.served; break; }
    }
    if (!warmed) throw new Error('预热失败：served 一直不到 5；status=' + JSON.stringify(await m.eval('JSON.stringify(window.VantageAgentPanel.status())')));
    await m.eval('window.__pmP.rtt=[]; window.__pmP.frame=[]; window.__pmP.bytes=[]; 1');
    // 预热后清零计数（否则 coverage 里混进预热帧）
    await m.eval(`(function(){ var S = window.VantageAgentPanel.getState();
        S.ticks = 0; S.served = 0; S.servedTotal = 0; S.skipInflight = 0; S.overlapInflight = 0;
        S.pauses = 0; S.resumes = 0; S.watchdogResumes = 0; S.resumeMiss = 0; S.lat = []; S.syncRtt = []; S.errCount = 0; return 1; })()`);
    st0 = null;
    for (let f = 0; f < FRAMES; f++) {
      const t0 = nowMs();
      // 页内单帧成本（真钟）
      const fm = await m.eval(`(() => { var a = new Event('__f').timeStamp; window.__vtStep(1); return new Event('__f').timeStamp - a; })()`);
      if (typeof fm === 'number') frameMs.push(fm);
      if (MODE === 'async') {
        await sleep(PACEMS);                      // 模拟 60fps 节奏：游戏不等人，策略在飞就跳过
      } else {
        // ⭐ 同步：世界等策略 —— 驱动侧在回包落地前不泵下一帧（与面板 loop.sleep 的语义一致）
        let waited = 0;
        while (waited < 5000) {
          const inf = await m.eval('window.VantageAgentPanel.getState().inflight');
          if (!inf) break;
          await sleep(1); waited += 1;
        }
      }
      totals.push(nowMs() - t0);
    }
    const p = JSON.parse(await m.eval('JSON.stringify(window.__pmP)'));
    rttInPage.push(...(p.rtt || []).filter((x) => x >= 0));
    const pb = (p.bytes || []);
    st1 = JSON.parse(await m.eval(`(function(){ var S = window.VantageAgentPanel.getState();
      return JSON.stringify({ ticks: S.ticks, served: S.served, servedTotal: S.servedTotal, skipInflight: S.skipInflight,
        overlapInflight: S.overlapInflight, pauses: S.pauses, resumes: S.resumes, watchdogResumes: S.watchdogResumes,
        resumeMiss: S.resumeMiss, pauseMode: S.pauseMode, pauseErr: S.pauseErr, errCount: S.errCount, lastErr: S.lastErr,
        lat: (S.lat || []).slice(-200), syncRtt: (S.syncRtt || []).slice(-200) }); })()`));
    const agg = {
      tag: TAG, mode: MODE, players: PLAYERS, frames: FRAMES, paceMs: MODE === 'async' ? PACEMS : null,
      page_frame_ms: { med: r2(med(frameMs)), p90: r2(pctl(frameMs, 90)) },          // 页内物理+渲染单帧
      payloadBytes: { med: r2(med(pb)), max: pb.length ? Math.max(...pb) : null },
      policy_rtt_ms: { med: r2(med(rttInPage)), p90: r2(pctl(rttInPage, 90)), n: rttInPage.length },  // 浏览器 fetch 往返（含 HTTP + python 桥 + 服务端）
      driver_frame_ms: { med: r2(med(totals)), p90: r2(pctl(totals, 90)) },          // 驱动侧每帧（含 CDP 往返，比真实多 ~1ms）
      serial_frame_ms: r2((med(frameMs) || 0) + (med(rttInPage) || 0)),               // 真游戏每帧串行预算 = 单帧 + 往返
      fps_serial_derived: r2(1000 / ((med(frameMs) || 0) + (med(rttInPage) || 0))),
      ticks: st1.ticks, served: st1.served, servedTotal: st1.servedTotal,
      decisions_dropped: st1.skipInflight, overlapInflight: st1.overlapInflight,
      coverage_pct: st1.ticks ? r2(100 * st1.servedTotal / st1.ticks) : null,
      sync_gate: { paused: st1.pauses, resumed: st1.resumes, watchdog: st1.watchdogResumes, resumeMiss: st1.resumeMiss, pauseMode: st1.pauseMode, pauseErr: st1.pauseErr },
      srvLat_ms: { med: r2(med(st1.lat || [])), n: (st1.lat || []).length },
      errCount: st1.errCount, lastErr: st1.lastErr, pageErrors: (m.pageErrors || []).slice(0, 3)
    };
    fs.writeFileSync(path.join(OUT, 'panel_' + TAG + '.json'), JSON.stringify({ agg, raw: { frameMs, rttInPage, totals } }, null, 1));
    console.log(JSON.stringify(agg, null, 2));
    await m.close();
  } catch (e) {
    console.error('FAILED ' + ((e && e.stack) || e));
    process.exitCode = 1;
    try { await m.close(); } catch (e2) {}
  }
})();
