'use strict';
/* 阶段1-1 探针：Rust/JS 批量样本的时间戳是否统一走 _frameDtSec（不再写死 0.02）
 *
 *   node _tools/headless/_probe_p1_1_tstamp.js --tag before|after
 *
 * 做法：开一局 vantage_1 vs Laika，切树模式跑 60 帧（让融合世界/子弹就绪），
 *       然后把沙箱步长显式设成 0.04，直接调 adapter.simulateTankBatch(10 帧)：
 *         · Rust 快路成功 → samples[i].t 必须是 i*0.04
 *         · Rust 不可用回退 JS 融合 → 也必须是 i*0.04（两边同源）
 *       另打印 VantageSandbox.getFrameDtSec() 与 rustPhysics 标记，证明走的是哪条路。
 */
const path = require('path');
const { Match } = require('./match');

(async () => {
  const argv = process.argv.slice(2);
  const str = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
  const tag = str('tag', 'x');
  const m = new Match();
  await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 1, rng: 'record' });
  await m.eval('(() => { var st = VantageTestbench.getState(); st.aiControl.enabled = true; st.aiControl.tree = true; return 1; })()');
  await m.pump(60);

  const out = await m.eval(`(async () => {
    var o = {};
    try {
      var gc = GameManager.getGameController();
      o.rustReadyBefore = !!(window.VantageRustBridge && VantageRustBridge._ready);
      o.initResult = null;
      if (!o.rustReadyBefore && window.VantageRustBridge) {
        try { o.initResult = await VantageRustBridge.init(); } catch (eI) { o.initResult = String(eI); }
      }
      o.rustReadyAfter = !!(window.VantageRustBridge && VantageRustBridge._ready);
      VantageSandbox.setFrameDtSec(0.04);            // 假装校准到了 40ms/帧
      o.frameDtAfterSet = VantageSandbox.getFrameDtSec();
      var ad = VantageSandbox.createAdapter(gc, 'vantage_1');
      o.adapterDt = ad.getFrameDtSec ? ad.getFrameDtSec() : null;
      var tank = gc.getTank('vantage_1');
      if (!tank) { o.err = 'vantage_1 不在场'; return o; }
      var state = { x: tank.getX(), y: tank.getY(), rot: tank.getRotation() };
      var batch = null;
      try {
        batch = ad.simulateTankBatch(state, ad.operations, 10, { startPose: state });
      } catch (eB) { o.batchErr = String(eB); }
      o.batchLen = batch ? batch.length : null;
      var row = batch && batch[0];
      if (row) {
        o.rustPhysics = !!row.rustPhysics;
        o.sampleCount = row.samples ? row.samples.length : null;
        o.t1 = (row.samples && row.samples[1]) ? row.samples[1].t : null;
        o.t5 = (row.samples && row.samples[5]) ? row.samples[5].t : null;
        o.t10 = (row.samples && row.samples[10]) ? row.samples[10].t : null;
      }
    } catch (e) { o.err = String(e); }
    return o;
  })()`);

  const t1 = out.t1, t5 = out.t5, t10 = out.t10;
  const ok = (t1 === 0.04 && t5 === 0.2 && t10 === 0.4);
  console.log('tag=' + tag + ' ' + JSON.stringify(out));
  console.log('判定[样本时间戳 = i*0.04]: ' + (ok ? 'PASS' : 'FAIL') +
    '  (t1=' + t1 + ' t5=' + t5 + ' t10=' + t10 + ', 旧版写死 0.02 时会是 0.02/0.1/0.2)');
  if (!ok) process.exitCode = 1;
  await m.close();
})().catch((e) => { console.error('PROBE FAILED: ' + ((e && e.stack) || e)); process.exitCode = 1; });
