'use strict';
/**
 * 机制探针：「渲染到底值多少 ms/帧？」
 * ------------------------------------------------------------------
 * 背景：顺序测（_slowframe_norender_tmp.js）两次显示 pump 5.45→2.42（-55%），
 *       但第三次的 full 相位没降、交替测（INTER=1）几乎无差 ⟹ 收益不稳定、需要定机制。
 *
 * 本探针用三个互相印证的口径（同一会话内，先把"帧成本"与"渲染成本"拆开）：
 *   ① CDP 往返本底：m.eval('1') 的中位耗时（后面批量测要扣掉它）
 *   ② 批量真渲染：连续调 renderer.render(stage) 30 次，Node 侧计时 → 单次渲染成本
 *      · 分别测：canvas 940×705 可见 / canvas 1×1 隐藏
 *   ③ 帧级配对（最强）：把 renderer.render 包一层"隔一次真渲染一次"（不动 canvas），
 *      相邻帧只差"渲染真跑/跳过" ⟹ 不受机器负载/回合状态漂移影响
 *      · 在 canvas 可见、canvas 隐藏两种状态下各跑一遍
 *   ④ 长块 ABAB：normal / canvas / noopOnly / full 各 60 帧，看端到端是否稳定
 *
 * 口径说明：页面内 performance.now/Date 已被虚拟时钟接管（clock.js），**页面内无法计时**，
 *          所以全部由 Node 侧 hrtime 计时。
 */
const { Match } = require('./match');
const HR = () => process.hrtime.bigint();
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;
function st(a) { const s = a.slice().sort((x, y) => x - y); return { med: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1], mean: s.reduce((p, q) => p + q, 0) / s.length }; }
(async () => {
  const m = new Match();
  await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 1 });
  await m.clearControl(); await m.pump(30, { yieldMs: 0 });
  await m.setNoRender(false);                       // 装页面侧源码
  console.log('INIT_OK');

  const ov = []; for (let i = 0; i < 25; i++) { const t = HR(); await m.eval('1'); ov.push(ms(t)); }
  const base = st(ov).med;
  console.log('① CDP_EVAL_OVERHEAD med=' + base.toFixed(3) + ' min=' + st(ov).min.toFixed(3) + ' max=' + st(ov).max.toFixed(3));

  const NR = 30;
  async function batchRender(tag) {
    const expr = '(function(){var g=GameManager.getGame();for(var i=0;i<' + NR + ';i++){g.renderer.render(g.stage);}return 1;})()';
    const a = []; for (let k = 0; k < 3; k++) { const t = HR(); await m.eval(expr); a.push(ms(t)); }
    const s = st(a);
    console.log('② BATCH_RENDER ' + tag + ' n=' + NR + ' batch med=' + s.med.toFixed(2) + ' min=' + s.min.toFixed(2) + ' max=' + s.max.toFixed(2) +
      ' -> per_render=' + ((s.med - base) / NR).toFixed(3) + ' ms');
  }
  console.log('SET ' + JSON.stringify(await m.setNoRender(false)));
  await batchRender('A_normal_940x705_visible');
  console.log('SET ' + JSON.stringify(await m.setNoRender(true, 'canvas')));
  await batchRender('B_canvas_1x1_hidden');
  console.log('SET ' + JSON.stringify(await m.setNoRender(true, 'noop')));
  await batchRender('C_noop_940x705_visible(render=noop ⟹ 只测空函数往返)');
  console.log('SET ' + JSON.stringify(await m.setNoRender(false)));
  await batchRender('D_normal_again');

  async function altPair(tag, K) {
    const r0 = await m.eval('JSON.stringify(window.__vtRenderAltStart())');
    if (String(r0).indexOf('"ok":true') < 0) throw new Error('altStart 失败: ' + r0);
    const per = [];
    for (let i = 0; i < K; i++) { const t = HR(); await m.pump(1, { yieldMs: 0 }); per.push(ms(t)); }
    const log = JSON.parse(await m.eval('JSON.stringify(window.__vtRenderAltStop())'));
    const real = [], skip = [];
    for (let i = 0; i < per.length; i++) { const e = log.log[i]; if (!e) continue; (e.real ? real : skip).push(per[i]); }
    const a = st(real), b = st(skip);
    console.log('③ ALT_PAIR ' + tag + ' renderCalls=' + log.n + '/' + K + ' | 真渲染 med=' + a.med.toFixed(2) + ' min=' + a.min.toFixed(2) + ' max=' + a.max.toFixed(2) +
      ' | 跳过 med=' + b.med.toFixed(2) + ' min=' + b.min.toFixed(2) + ' max=' + b.max.toFixed(2) + ' | delta_med=' + (a.med - b.med).toFixed(2));
  }
  console.log('SET ' + JSON.stringify(await m.setNoRender(false)));
  await altPair('canvas_940x705_visible', 120);
  console.log('SET ' + JSON.stringify(await m.setNoRender(true, 'canvas')));
  await altPair('canvas_1x1_hidden', 120);
  console.log('SET ' + JSON.stringify(await m.setNoRender(false)));

  async function blk(tag, mode, K) {
    if (mode === null) await m.setNoRender(false); else await m.setNoRender(true, mode);
    const i0 = JSON.parse(await m.eval('JSON.stringify(window.__vtNoRenderInfo())'));
    const a = [];
    for (let i = 0; i < K; i++) { const t = HR(); await m.pump(1, { yieldMs: 0 }); a.push(ms(t)); }
    const s = st(a);
    const info = JSON.parse(await m.eval('JSON.stringify(window.__vtNoRenderInfo())'));
    console.log('④ BLK ' + tag + ' n=' + K + ' pump med=' + s.med.toFixed(2) + ' mean=' + s.mean.toFixed(2) + ' min=' + s.min.toFixed(2) + ' max=' + s.max.toFixed(2) +
      ' | canvas_start=' + JSON.stringify(i0.canvas) + ' canvas_end=' + JSON.stringify(info.canvas) + ' renderNoop=' + info.renderer.renderNoop);
    return s.med;
  }
  await blk('1_normal', null, 60);
  await blk('2_canvas1x1', 'canvas', 60);
  await blk('3_normal', null, 60);
  await blk('4_canvas1x1', 'canvas', 60);
  await blk('5_noopOnly_visible', 'noop', 60);
  await blk('6_full', 'full', 60);
  await blk('7_normal', null, 60);
  await blk('8_full', 'full', 60);
  // ⑤ canvas 状态配对：normal ↔ canvas(1×1 隐藏) 交替 P 组 × B 帧（块内取中位，再看块间中位）
  {
    const P = Number(process.env.PAIRS || 6), B = Number(process.env.BLKN || 30);
    const nm = [], cm = [];
    for (let k = 0; k < P; k++) { nm.push(await blk('⑤normal#' + k, null, B)); cm.push(await blk('⑤canvas#' + k, 'canvas', B)); }
    const sn = st(nm), sc = st(cm);
    console.log('⑤ PAIRED normal  blockMeds=[' + nm.map(x => x.toFixed(2)).join(',') + '] med=' + sn.med.toFixed(2));
    console.log('⑤ PAIRED canvas1x1 blockMeds=[' + cm.map(x => x.toFixed(2)).join(',') + '] med=' + sc.med.toFixed(2) + '  delta_canvas_minus_normal=' + (sc.med - sn.med).toFixed(2) + ' ms');
  }
  await m.setNoRender(false);
  console.log('ERRSTATS ' + JSON.stringify(await m.stats()));
  await m.close();
})().catch(e => { console.log('PROBE_FATAL ' + String((e && e.stack) || e)); process.exit(1); });
