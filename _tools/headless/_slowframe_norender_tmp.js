'use strict';
/**
 * 「不呈现」开关的配对实测探针 —— 计时口径与 _slowframe_tmp.js 完全一致：
 *   一帧 = eval(观测+写回上一帧决策) → ask(子进程服务端前向) → pump(1)(游戏推进)
 * 差别只有两点：
 *   ① 每段都报【中位/均值/min/max】（不只报 total）；
 *   ② 在同一个会话里【开/关/开】交替测四个相位（A 关 → B canvas-only → C 全开 → D 还原），
 *      这样"开关前后"在同一批次、同一会话、同一帧数下比较（口径不混）。
 *
 * 用法：
 *   node _tools/headless/_slowframe_norender_tmp.js            # 默认 N=120
 *   NFRAMES=120 node _tools/headless/_slowframe_norender_tmp.js
 */
const fs = require('fs'); const { spawn, execSync } = require('child_process'); const { Match } = require('./match');
const SRC = fs.readFileSync(__dirname + '/inject_sarl2.js', 'utf8');
function ask(srv, o) { return new Promise(r => { srv.stdin.write(JSON.stringify(o) + '\n'); srv.stdout.once('data', d => { try { r(JSON.parse(String(d).trim())) } catch (e) { r({ lp: null, v: null }) } }); }); }
function stat(a) { const s = a.slice().sort((x, y) => x - y); const n = s.length; if (!n) return { median: NaN, min: NaN, max: NaN, mean: NaN }; return { median: s[Math.floor(n / 2)], min: s[0], max: s[n - 1], mean: s.reduce((p, q) => p + q, 0) / n }; }
function load(tag) { let c = 'n/a', h = 'n/a'; try { c = String(execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Processor).LoadPercentage"', { encoding: 'utf8' })).trim(); } catch (e) { } try { const o = execSync('tasklist', { encoding: 'utf8' }); h = String((o.match(/python\.exe|chrome\.exe|node\.exe/gi) || []).length); } catch (e) { } console.log('LOAD ' + tag + ' cpu_percent=' + c + ' heavy_proc_hits=' + h); }
function fmt(a) { const s = stat(a); return 'med=' + s.median.toFixed(2) + ' mean=' + s.mean.toFixed(2) + ' min=' + s.min.toFixed(2) + ' max=' + s.max.toFixed(2); }
(async () => {
  const U = process.env.USE_GRAPH || '1';
  const N_FULL = Number(process.env.NFRAMES || 120); let N = N_FULL;
  const srv = spawn('py', ['-3.13', '_tools/training/policy_server_graph.py'], { env: { ...process.env, PYTHONIOENCODING: 'utf-8', USE_GRAPH: U } });
  await new Promise(r => setTimeout(r, 3000));
  await new Promise(r => { const h = (d) => { const s = String(d); console.log('SRV_HEADER ' + s.trim().slice(0, 80)); if (s.includes('WARMUP_SAMPLE')) { srv.stdout.off('data', h); r(); } }; srv.stdout.on('data', h); });
  const m = new Match(); await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 1 });
  await m.clearControl(); try { await m.installControl('tank_a') } catch (e) { }
  await m.eval(SRC); await m.eval('window.__probe.setup()');
  await m.pump(30, { yieldMs: 0 });
  console.log('INIT_OK USE_GRAPH=' + U + ' N=' + N + ' PROBE=_slowframe_norender_tmp');
  load('after_init');

  // 调用点审计：证明 renderer.render 恰好每帧一次（即"置空它只可能少画"）
  await m.setNoRender(false);   // 先把页面侧源码装上（默认关，"already-off"）
  await m.eval('window.__vtRenderAuditStart()');
  await m.pump(5, { yieldMs: 0 });
  const aud = await m.eval('JSON.stringify(window.__vtRenderAuditStop())');
  console.log('RENDER_AUDIT ' + String(aud).slice(0, 300));

  let nodeId = 0; const phases = [];
  async function run(label) {
    const rows = [];
    for (let i = 0; i < N; i++) {
      const w0 = process.hrtime.bigint();
      const o = JSON.parse(await m.eval('window.__b.step(' + nodeId + ')'));
      let b = process.hrtime.bigint(); const te = Number(b - w0) / 1e6;
      const p = await ask(srv, { h: o.h, g: o.g, n: o.n });
      let c = process.hrtime.bigint(); const ta = Number(c - b) / 1e6;
      if (typeof p.nodeId === 'number') nodeId = p.nodeId;
      let d = process.hrtime.bigint(); const tw = Number(d - c) / 1e6;   // ④写回：决策随响应回传，无额外往返
      let e = process.hrtime.bigint(); const td = Number(e - d) / 1e6;   // ⑤落盘：内存累积，无 I/O
      await m.pump(1, { yieldMs: 0 });
      let f = process.hrtime.bigint(); const tp = Number(f - e) / 1e6;
      rows.push({ f: i, total: Number(f - w0) / 1e6, eval: te, ask: ta, pump: tp, write: tw, disk: td, lp: p.lp, h: o.h, alive: o.alive, dots: o.dots, nLen: (o.n || []).length });
    }
    const fin = rows.filter(r => typeof r.lp === 'number' && isFinite(r.lp)).length;
    const lpU = new Set(rows.map(r => String(r.lp))).size;
    const hU = new Set(rows.map(r => String(r.h))).size;
    const st = await m.stats();
    const tank = await m.myTank();
    const pj = await m.projectileCount();
    const state = await m.eval('(()=>{try{return GameManager.getGameController().getState()}catch(e){return "err"}})()');
    console.log('PHASE ' + label + ' | total ' + fmt(rows.map(r => r.total)));
    console.log('PHASE ' + label + ' | seg eval ' + fmt(rows.map(r => r.eval)) + ' | ask ' + fmt(rows.map(r => r.ask)) +
      ' | pump ' + fmt(rows.map(r => r.pump)) + ' | writeback ' + fmt(rows.map(r => r.write)) + ' | persist ' + fmt(rows.map(r => r.disk)));
    console.log('PHASE ' + label + ' | LP_FINITE=' + fin + '/' + N + ' lp_unique=' + lpU + ' obsHash_unique=' + hU + '/' + N +
      ' dots_last=' + rows[N - 1].dots + ' alive_last=' + rows[N - 1].alive + ' nLen_last=' + rows[N - 1].nLen);
    console.log('PHASE ' + label + ' | witness tank=' + JSON.stringify(tank) + ' projectiles=' + pj + ' gcState=' + JSON.stringify(state) +
      ' clockSteps=' + st.steps + ' clockErrors=' + JSON.stringify(st.errors));
    console.log('PHASE ' + label + ' | FIRST5 total=' + rows.slice(0, 5).map(r => r.total.toFixed(1)).join(',') +
      ' eval=' + rows.slice(0, 5).map(r => r.eval.toFixed(2)).join(','));
    phases.push({ label, rows, fin });
  }

  const ORDER = (process.env.ORDER || 'A_off,B_canvas,C_full,D_off2').split(',');
  const PLAN = { A_off: [false], B_canvas: [true, 'canvas'], C_full: [true, 'full'], D_off2: [false] };
  console.log('ORDER ' + ORDER.join(','));
  const INTER = Number(process.env.INTER || 0);
  if (INTER > 0) {
    const K = Number(process.env.K || 6), M = Number(process.env.M || 20);
    N = M;
    console.log('INTERLEAVE K=' + K + ' M=' + M + ' arms=' + ORDER.join(','));
    for (let k = 0; k < K; k++) for (const lab of ORDER) {
      const info = await m.setNoRender(PLAN[lab][0], PLAN[lab][1]);
      if (info.err) throw new Error('toggle 失败 ' + lab + ' ' + JSON.stringify(info));
      await run(lab + '#k' + k);
    }
  } else
  for (const lab of ORDER) { console.log('NORE_' + lab + ' ' + JSON.stringify(await m.setNoRender(PLAN[lab][0], PLAN[lab][1]))); await run(lab); }

  const rowsOf = (lab, key) => [].concat(...phases.filter(p => p.label.indexOf(lab) === 0).map(p => p.rows.map(r => r[key])));
  const by = (lab, key) => { const r = rowsOf(lab, key); return r.length ? stat(r).median : null; };
  const num = (x) => (x === null || x === undefined || !isFinite(x)) ? 'n/a' : x.toFixed(2);
  for (const lab of Object.keys(PLAN)) if (rowsOf(lab, 'total').length) console.log('POOLED ' + lab + ' n=' + rowsOf(lab, 'total').length + ' total ' + fmt(rowsOf(lab, 'total')) + ' | eval ' + fmt(rowsOf(lab, 'eval')) + ' | ask ' + fmt(rowsOf(lab, 'ask')) + ' | pump ' + fmt(rowsOf(lab, 'pump')));
  const A = by('A_off', 'total'), C = by('C_full', 'total');
  const PAIRED = phases.map(p => ({ label: p.label, n: p.rows.length, lp_finite: p.fin, total: stat(p.rows.map(r => r.total)).median, pump: stat(p.rows.map(r => r.pump)).median, eval: stat(p.rows.map(r => r.eval)).median, ask: stat(p.rows.map(r => r.ask)).median }));
  console.log('PAIRED_JSON ' + JSON.stringify(PAIRED));
  console.log('SUMMARY pump A_off=' + num(by('A_off', 'pump')) +
    ' B_canvas=' + num(by('B_canvas', 'pump')) +
    ' C_full=' + num(by('C_full', 'pump')) +
    ' D_off2=' + num(by('D_off2', 'pump')));
  console.log('SUMMARY total A_off=' + num(A) + ' -> C_full=' + num(C) + ' delta=' + (A && C ? (100 * (C - A) / A).toFixed(1) + '%' : 'n/a（有臂没跑）'));
  await m.setNoRender(false);
  await m.close(); srv.kill();
})().catch(e => { console.log('PROBE_FATAL ' + String((e && e.stack) || e)); process.exit(1); });
