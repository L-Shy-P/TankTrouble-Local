// 临时诊断 3：安全 hook world.Step，探明状态
const { Match } = require('./match');

const HOOK_WORLD = `(() => {
  window.__worldDt = [];
  var gc = GameManager.getGameController();
  var w = gc && gc.getB2DWorld && gc.getB2DWorld();
  if (!w) return 'no world';
  if (w.__hooked) return 'already';
  var orig = w.Step;
  w.Step = function (dt, vi, pi) {
    (window.__worldDt = window.__worldDt || []).push(+dt.toFixed(6));
    return orig.call(w, dt, vi, pi);
  };
  w.__hooked = true;
  return 'hooked';
})()`;

const PROBE = `(() => {
  var gc = GameManager.getGameController();
  var t = gc && gc.getTank('tank_a');
  var rc = gc && gc.roundController;
  var w = gc && gc.getB2DWorld();
  var rm = rc && rc.model;
  return {
    tank: t ? {x:t.getX(), y:t.getY(), rot:t.getRotation(), locked:t.getLocked(), fwd:t.getForward(), back:t.getBack(), left:t.getLeft(), right:t.getRight()} : null,
    started: !!(rm && rm.getStarted && rm.getStarted()), maze: !!(rm && rm.getMaze && rm.getMaze()),
    gcState: gc.getGameState(), ctrl: window.__vtCtrl, vtT: window.__vt.t,
    dts: (window.__worldDt||[]).length,
    stepSrc: w ? String(w.Step).slice(0, 120) : null,
    sameWorld: w === (gc.getB2DWorld()),
  };
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
    console.log('warmup started:', started);
    console.log('probe after warmup:', JSON.stringify(await m.eval(PROBE), null, 1));
    console.log('hook:', await m.eval(HOOK_WORLD));
    const mz = await m.maze();
    const cand = mz.reachable.map((r) => ({ x: r.x * 10 + 5, y: r.y * 10 + 5 }));
    await m.eval(`window.__clearDts = function(){ window.__worldDt.length = 0; return 1; }`);
    const A = cand[0];
    await m.teleport('tank_a', A.x, A.y, 0);
    await m.pump(4, { yieldMs: 5 });
    console.log('probe after teleport:', JSON.stringify(await m.eval(PROBE), null, 1));
    await m.eval('window.__clearDts()');
    await m.setControl({ fwd: 1 });
    await m.pump(20, { yieldMs: 8 });
    await m.clearControl();
    console.log('probe after slow fwd:', JSON.stringify(await m.eval(PROBE), null, 1));
    console.log('world dts:', JSON.stringify(await m.eval('window.__worldDt')));
    console.log('lastUpdate delta check:', await m.eval(`(()=>{var gc=GameManager.getGameController();return +gc.lastUpdate;})()`));
  } catch (e) { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; }
  finally { await m.close(); }
})();
