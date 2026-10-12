// 临时诊断 4：长走廊对照 —— 未打补丁 vs 页面 Date 虚拟化
const { Match } = require('./match');

const HOOK_WORLD = `(() => {
  window.__worldDt = [];
  var gc = GameManager.getGameController();
  var w = gc && gc.getB2DWorld && gc.getB2DWorld();
  if (!w || w.__hooked) return 'no/already';
  var orig = w.Step;
  w.Step = function (dt, vi, pi) { (window.__worldDt = window.__worldDt || []).push(+dt.toFixed(6)); return orig.call(w, dt, vi, pi); };
  w.__hooked = true; return 'hooked';
})()`;

const PATCH_DATE = `(() => {
  if (window.__datePatched) return 'already';
  var RD = Date, st = window.__vt;
  function VDate() {
    if (!(this instanceof VDate)) return new RD(st.epoch + st.t).toString();
    if (arguments.length === 0) return new RD(st.epoch + st.t);
    return Reflect.construct(RD, arguments);
  }
  VDate.prototype = RD.prototype;
  VDate.now = function () { return st.epoch + st.t; };
  VDate.parse = RD.parse; VDate.UTC = RD.UTC;
  window.Date = VDate; window.__datePatched = true; return 'patched';
})()`;

(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 0, vantCount: 1 });
    await m.clearControl();
    let started = false;
    for (let i = 0; i < 30; i++) {
      const a = await m.myTank(); if (!a) break;
      await m.setControl({ fwd: true }); await m.pump(8, { yieldMs: 4 });
      const b = await m.myTank();
      if (b && Math.hypot(b.x - a.x, b.y - a.y) > 0.5) { started = true; break; }
    }
    await m.clearControl();
    console.log('回合开始:', started, await m.eval(HOOK_WORLD));

    const mz = await m.maze();
    const rows = {};
    for (const r of mz.reachable) (rows[r.y] = rows[r.y] || []).push(r.x);
    let best = null;
    for (const y of Object.keys(rows)) {
      const xs = rows[y].sort((a, b) => a - b); let run = [xs[0]];
      for (let i = 1; i <= xs.length; i++) {
        if (i < xs.length && xs[i] === xs[i - 1] + 1) run.push(xs[i]);
        else { if (!best || run.length > best.run.length) best = { y: +y, run: run.slice() }; run = [xs[i]]; }
      }
    }
    const x0 = best.run[0] * 10 + 5, y0 = best.y * 10 + 5, ROT = Math.PI / 2;
    console.log(`走廊 y=${best.y} x=${best.run[0]}..${best.run[best.run.length-1]}（可用 ${(best.run.length-1)*10} 单位）起点=(${x0},${y0})`);

    async function resetPose() {
      await m.clearControl();
      await m.teleport('tank_a', x0, y0, ROT);
      await m.pump(4, { yieldMs: 5 });
      await m.eval('window.__worldDt.length = 0');
    }
    async function run(label, frames, ctrl, pumpOpts) {
      const before = await m.myTank();
      const lu0 = await m.eval('(()=>+GameManager.getGameController().lastUpdate)()');
      const t0 = Date.now();
      await m.setControl(ctrl);
      await m.pump(frames, pumpOpts);
      await m.clearControl();
      const realMs = Date.now() - t0;
      const lu1 = await m.eval('(()=>+GameManager.getGameController().lastUpdate)()');
      const after = await m.myTank();
      const wd = await m.eval('window.__worldDt');
      const sum = wd.reduce((a, b) => a + b, 0);
      const d = Math.hypot(after.x - before.x, after.y - before.y);
      console.log(`${label}: 位移=${d.toFixed(3)} Δrot=${(after.rot - before.rot).toFixed(4)} ` +
        `pos(${before.x},${before.y})->(${after.x.toFixed(1)},${after.y.toFixed(1)}) ` +
        `| Σworld.Step(dt)=${sum.toFixed(4)}s (期望virtual ${(frames / 60).toFixed(4)}s) ` +
        `| gc.lastUpdate Δ=${(lu1 - lu0)}ms | CDP真实=${realMs}ms`);
    }

    console.log('\n--- A. 未打补丁（new Date()=真实时间；tight 循环里每帧只走 ~真实渲染耗时）---');
    await resetPose();
    await run('60帧 前进 tight(单次evaluate)      ', 60, { fwd: 1 }, { yieldMs: 0 });
    await resetPose();
    await run('60帧 前进 slow(每帧evaluate+sleep8)', 60, { fwd: 1 }, { yieldMs: 8 });
    await resetPose();
    await run('30帧 左转 tight(单次evaluate)      ', 30, { left: 1 }, { yieldMs: 0 });

    console.log('\n--- B. 页面内把 Date 构造函数也虚拟化 ---');
    console.log(await m.eval(PATCH_DATE));
    await resetPose();
    await run('60帧 前进 tight(单次evaluate)      ', 60, { fwd: 1 }, { yieldMs: 0 });
    await resetPose();
    await run('60帧 前进 slow(每帧evaluate+sleep8)', 60, { fwd: 1 }, { yieldMs: 8 });
    await resetPose();
    await run('30帧 左转 tight(单次evaluate)      ', 30, { left: 1 }, { yieldMs: 0 });
    console.log('\n理论值: 60帧前进=' + (15.95).toFixed(2) + ' 单位; 30帧左转=' + (5.0 * 0.5).toFixed(3) + ' rad');
  } catch (e) { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; }
  finally { await m.close(); }
})();
