'use strict';
/* 阶段1-1b 探针（施工子代理自用；只读 game_core，只在页面内做只读包装，不改文件）
 *
 *   node _tools/headless/_probe_p11b_pnow.js [--frames 90] [--out prof/_p11b_pnow.jsonl]
 *
 * 目的：在【树 tick 发生的那个时刻】记录三个时钟读数，回答两个问题：
 *   ① 树 tick 相对于 gc.update() 的先后顺序（决定 gc.lastUpdate 差分是"帧间隔"还是"帧内耗时"）
 *   ② performance.now() 自分差 vs gc.lastUpdate 墙钟差分，各自测出什么数
 *
 * 包装是只读的：把 VantageTree.tick / gc.update 用原函数包一层，只记录时间，不改变任何参数/返回值。
 */
const fs = require('fs');
const path = require('path');
const { Match } = require('./match');

(async () => {
  const argv = process.argv.slice(2);
  const str = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
  const frames = parseInt(str('frames', '90'), 10);
  const outFile = str('out', path.join(__dirname, 'prof', '_p11b_pnow.jsonl'));

  const m = new Match();
  await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 1, rng: 'record' });
  await m.eval('(() => { var st = VantageTestbench.getState(); st.aiControl.enabled = true; st.aiControl.tree = true; return 1; })()');

  const hook = await m.eval(`(() => {
    window.__p11b = { events: [], tickPatched: false, gcPatch: null, pnowType: typeof performance.now };
    var orig = VantageTree.tick;
    VantageTree.tick = function(ai, dt) {
      var gc = ai && ai.gameController;
      var lu = gc ? gc.lastUpdate : null;
      window.__p11b.events.push({
        k: 'tick', p: performance.now(), dn: Date.now(),
        lu: (lu && typeof lu.getTime === 'function') ? lu.getTime() : lu,
        luIsDate: !!(lu && typeof lu.getTime === 'function'),
        t: window.__vt.t, dt: dt
      });
      return orig.apply(this, arguments);
    };
    window.__p11b.tickPatched = (VantageTree.tick !== orig);
    try {
      var gc = GameManager.getGameController();
      var o2 = gc.update;
      gc.update = function() {
        window.__p11b.events.push({ k: 'upd_in', p: performance.now(), dn: Date.now() });
        var r = o2.apply(this, arguments);
        window.__p11b.events.push({ k: 'upd_out', p: performance.now(), dn: Date.now() });
        return r;
      };
      window.__p11b.gcPatch = (gc.update !== o2) ? 'instance-ok' : 'shadow-failed';
    } catch (e) { window.__p11b.gcPatch = 'err:' + e; }
    return 'gcPatch=' + window.__p11b.gcPatch + ' tickPatched=' + window.__p11b.tickPatched +
      ' pnow=' + window.__p11b.pnowType;
  })()`);
  console.log('hook: ' + hook);

  for (let i = 0; i < frames; i++) await m.pump(1);

  const data = await m.eval('window.__p11b');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, data.events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  // 逐 tick 分析
  const ticks = data.events.filter((e) => e.k === 'tick');
  const rows = [];
  for (let i = 1; i < ticks.length; i++) {
    const a = ticks[i - 1], b = ticks[i];
    rows.push({
      i: i,
      dPerfMs: +(b.p - a.p).toFixed(4),
      dWallMs: +(b.dn - b.lu).toFixed(4),          // 老口径：now − lastUpdate
      dLuMs: +(b.lu - a.lu).toFixed(4),            // lastUpdate 自身差分
      dTickWallMs: +(b.dn - a.dn).toFixed(4),
      luIsDate: b.luIsDate,
      t: b.t,
    });
  }
  fs.writeFileSync(outFile.replace(/\.jsonl$/, '_analysis.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const fmt = (x) => (x === null || x === undefined) ? '-' : x;
  const dPerf = rows.map((r) => r.dPerfMs).filter((v) => v > 0);
  const dWall = rows.map((r) => r.dWallMs).filter((v) => v > 0);
  const dLu = rows.map((r) => r.dLuMs);
  const med = (arr) => { const s = arr.slice().sort((x, y) => x - y); const n = s.length; return n ? ((n % 2) ? s[n >> 1] : (s[(n >> 1) - 1] + s[n >> 1]) / 2) : null; };
  console.log('ticks=' + ticks.length + ' upd_in=' + data.events.filter((e) => e.k === 'upd_in').length);
  console.log('dPerf(ms) 中位=' + fmt(med(dPerf)) + ' 范围=[' + fmt(Math.min.apply(null, dPerf)) + ',' + fmt(Math.max.apply(null, dPerf)) + ']');
  console.log('dWall(ms) 中位=' + fmt(med(dWall)) + ' 范围=[' + fmt(Math.min.apply(null, dWall)) + ',' + fmt(Math.max.apply(null, dWall)) + ']');
  console.log('dLu(ms)  中位=' + fmt(med(dLu)) + ' 范围=[' + fmt(Math.min.apply(null, dLu)) + ',' + fmt(Math.max.apply(null, dLu)) + ']（含 0 = 同一帧两次 tick）');
  console.log('dTickWall(ms) 中位=' + fmt(med(rows.map((r) => r.dTickWallMs))));
  console.log('前 12 tick 事件序（看 tick 在 upd_in/upd_out 之间还是之前）:');
  console.log('  ' + data.events.slice(0, 12).map((e) => e.k + '@' + e.p.toFixed(3)).join(' '));
  console.log('→ ' + outFile);

  // 读树自报的校准诊断（exportRecord().meta）：样本来源 / 墙钟对照 / 交叉校验偏差
  const meta = await m.eval(`(() => {
    try {
      var er = VantageTree.exportRecord();
      if (!er || !er.meta) return { err: 'no meta' };
      var m = er.meta;
      return { frameDt: m.frameDt, frameDtMeasured: m.frameDtMeasured, frameDtLastAdv: m.frameDtLastAdv,
               frameDtSwitches: m.frameDtSwitches, frameDtSampleSrc: m.frameDtSampleSrc,
               frameDtWallLast: m.frameDtWallLast, frameDtCrossMiss: m.frameDtCrossMiss,
               frameDtCrossMaxMs: m.frameDtCrossMaxMs };
    } catch (e) { return { err: String(e) }; }
  })()`);
  console.log('exportRecord().meta = ' + JSON.stringify(meta));

  // 反面校验：把 performance.now 故意弄歪（×1.5）→ 交叉校验必须能看出来（否则它就是死代码）
  if (argv.indexOf('--spoof-perf') >= 0) {
    await m.eval(`(() => {
      window.__p11bWarns = [];
      var ow = console.warn;
      console.warn = function () { window.__p11bWarns.push(Array.prototype.slice.call(arguments).join(' ')); return ow.apply(console, arguments); };
      var orig = performance.now.bind(performance);
      performance.now = function () { return orig() * 1.5; };
      return 'spoofed';
    })()`);
    for (let i = 0; i < 20; i++) await m.pump(1);
    const meta2 = await m.eval(`(() => {
      var er = VantageTree.exportRecord(); var m = er.meta;
      return { frameDt: m.frameDt, frameDtSampleSrc: m.frameDtSampleSrc, frameDtWallLast: m.frameDtWallLast,
               frameDtCrossMiss: m.frameDtCrossMiss, frameDtCrossMaxMs: m.frameDtCrossMaxMs,
               warns: (window.__p11bWarns || []).length, warnFirst: (window.__p11bWarns || [])[0] || null };
    })()`);
    console.log('【反面校验 performance.now×1.5】meta = ' + JSON.stringify(meta2));
  }

  await m.close();
})().catch((e) => { console.error('PROBE FAILED: ' + ((e && e.stack) || e)); process.exitCode = 1; });
