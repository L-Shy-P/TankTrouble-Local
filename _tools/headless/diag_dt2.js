// 临时诊断 2：在长直走廊里测位移/转角，并直接记录 Box2D world.Step(dt)
const { Match } = require('./match');

const HOOK_WORLD = `(() => {
  var gc = GameManager.getGameController();
  var w = gc && gc.getB2DWorld && gc.getB2DWorld();
  if (!w) return 'no world';
  if (w.__hooked) return 'already';
  var desc = Object.getOwnPropertyDescriptor(w, 'Step');
  var orig = w.Step;
  try {
    w.Step = function (dt, vi, pi) { window.__worldDt.push(+dt.toFixed(6)); return orig.call(w, dt, vi, pi); };
    w.__hooked = true;
    return 'hooked:' + JSON.stringify({writable: desc && desc.writable, same: w.Step === orig});
  } catch (e) { return 'ERR ' + e; }
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
  window.Date = VDate; window.__datePatched = true;
  return 'patched';
})()`;

const TANK = `(() => { var gc=GameManager.getGameController(); var t=gc&&gc.getTank('tank_a');
  return t ? {x:+t.getX().toFixed(3), y:+t.getY().toFixed(3), rot:+t.getRotation().toFixed(5)} : null; })()`;

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

    // 找一条水平长走廊（连续可达格 >= 6）
    const mz = await m.maze();
    const rows = {};
    for (const r of mz.reachable) rows[r.y] = (rows[r.y] || []); 
    for (const r of mz.reachable) rows[r.y].push(r.x);
    let best = null;
    for (const y of Object.keys(rows)) {
      const xs = rows[y].sort((a, b) => a - b);
      let run = [xs[0]];
      for (let i = 1; i <= xs.length; i++) {
        if (i < xs.length && xs[i] === xs[i - 1] + 1) run.push(xs[i]);
        else { if (!best || run.length > best.run.length) best = { y: +y, run: run.slice() }; run = [xs[i]]; }
      }
    }
    console.log('最长水平走廊: y=' + best.y + ' xs=' + JSON.stringify(best.run));
    const x0 = best.run[0] * 10 + 5, y0 = best.y * 10 + 5;
    const rot = Math.PI / 2;  // forward = (sin r, -cos r) = (1, 0) → +x
    const reach = (best.run.length - 1) * 10; // 走廊剩余长度

    async function resetPose() {
      await m.clearControl();
      await m.teleport('tank_a', x0, y0, rot);
      await m.pump(4, { yieldMs: 5 });
      await m.eval('window.__worldDt = []');
    }
    async function run(label, frames, ctrl, pumpOpts) {
      const before = await m.myTank();
      const t0 = Date.now();
      await m.setControl(ctrl);
      await m.pump(frames, pumpOpts);
      await m.clearControl();
      const realMs = Date.now() - t0;
      const after = await m.myTank();
      const wd = await m.eval('window.__worldDt');
      const sum = wd.reduce((a, b) => a + b, 0);
      const d = Math.hypot(after.x - before.x, after.y - before.y);
      console.log(`${label}: frames=${frames} 位移=${d.toFixed(3)} Δrot=${(after.rot - before.rot).toFixed(4)} ` +
        `pos(${before.x},${before.y})->(${after.x},${after.y}) | world.Step 次数=${wd.length} Σdt=${sum.toFixed(4)}s ` +
        `期望virtual=${(frames / 60).toFixed(4)}s | CDP真实=${realMs}ms`);
      return d;
    }

    console.log('\n--- 未打补丁 ---');
    await resetPose();
    await run('20帧 前进 tight(一次evaluate)', 20, { fwd: 1 }, { yieldMs: 0 });
    await resetPose();
    await run('20帧 前进 slow(每帧+sleep8)   ', 20, { fwd: 1 }, { yieldMs: 8 });
    await resetPose();
    await run('20帧 左转 tight(一次evaluate)', 20, { left: 1 }, { yieldMs: 0 });
    await resetPose();
    await run('60帧 前进 tight(一次evaluate)', 60, { fwd: 1 }, { yieldMs: 0 });

    console.log('\n--- 页面内 Date 构造函数虚拟化后 ---');
    console.log(await m.eval(PATCH_DATE));
    await resetPose();
    await run('20帧 前进 tight(一次evaluate)', 20, { fwd: 1 }, { yieldMs: 0 });
    await resetPose();
    await run('20帧 前进 slow(每帧+sleep8)   ', 20, { fwd: 1 }, { yieldMs: 8 });
    await resetPose();
    await run('20帧 左转 tight(一次evaluate)', 20, { left: 1 }, { yieldMs: 0 });
    await resetPose();
    await run('60帧 前进 tight(一次evaluate)', 60, { fwd: 1 }, { yieldMs: 0 });
    await resetPose();
    await run('60帧 左转 tight(一次evaluate)', 60, { left: 1 }, { yieldMs: 0 });
    console.log('走廊剩余长度 ≈', reach, '（60帧全速应走', (60/60*15.95).toFixed(2), '）');
    console.log('\n时钟:', JSON.stringify(await m.stats()));
  } catch (e) { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; }
  finally { await m.close(); }
})();
