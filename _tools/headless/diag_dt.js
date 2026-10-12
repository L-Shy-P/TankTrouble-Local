// 临时诊断：验证「坦克移动依赖 new Date() 真实时间」假设
const { Match } = require('./match');

const DT_HOOK = `(() => {
  var gc = GameManager.getGameController();
  window.__dts = [];
  if (!gc || gc.__dtHooked) return 'already';
  gc.__dtHooked = true;
  var rc = gc.roundController;
  var orig = (rc && rc.update) ? rc.update : null;
  if (orig) {
    rc.update = function (dt) { window.__dts.push(+dt.toFixed(6)); return orig.apply(rc, arguments); };
  }
  return orig ? 'hooked-roundcontroller' : 'no rc.update';
})()`;

const PATCH_DATE = `(() => {
  var RD = Date, st = window.__vt;
  function VDate() {
    if (arguments.length === 0) return new RD(st.epoch + st.t);
    return new RD(arguments[0], arguments[1], arguments[2], arguments[3], arguments[4], arguments[5], arguments[6]);
  }
  VDate.prototype = RD.prototype;
  VDate.now = function () { return st.epoch + st.t; };
  VDate.parse = RD.parse; VDate.UTC = RD.UTC;
  window.Date = VDate;
  return 'patched';
})()`;

const TANK = `(() => { var gc=GameManager.getGameController(); var t=gc&&gc.getTank('tank_a');
  return t ? {x:+t.getX().toFixed(3), y:+t.getY().toFixed(3), rot:+t.getRotation().toFixed(5)} : null; })()`;

const LASTUPDATE = `(() => { var gc=GameManager.getGameController(); return +gc.lastUpdate; })()`;

(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a'], aiCount: 0, vantCount: 1 });
    // 自适应预热，确保回合开始
    await m.clearControl();
    let started = false;
    for (let i = 0; i < 30; i++) {
      const a = await m.myTank(); if (!a) break;
      await m.setControl({ fwd: true }); await m.pump(8, { yieldMs: 4 });
      const b = await m.myTank();
      if (b && Math.hypot(b.x - a.x, b.y - a.y) > 0.5) { started = true; break; }
    }
    await m.clearControl();
    console.log('回合开始:', started);
    const mz = await m.maze();
    const cand = mz.reachable.map((r) => ({ x: r.x * 10 + 5, y: r.y * 10 + 5 }));
    const A = cand[0];
    console.log('传送点:', JSON.stringify(A));

    async function resetPose() {
      await m.teleport('tank_a', A.x, A.y, 0);
      await m.pump(4, { yieldMs: 5 });
    }

    async function run(label, pumpOpts) {
      await m.clearControl();
      await m.pump(3, { yieldMs: 4 });
      await m.eval('window.__dts = []');
      const before = await m.myTank();
      const lu0 = await m.eval(LASTUPDATE);
      const t0 = Date.now();
      const o = { fwd: 1 };
      await m.setControl(o);
      await m.pump(20, pumpOpts);
      const t1 = Date.now();
      await m.clearControl();
      const after = await m.myTank();
      const lu1 = await m.eval(LASTUPDATE);
      const dts = await m.eval('window.__dts');
      const realMs = t1 - t0;
      const d = Math.hypot(after.x - before.x, after.y - before.y);
      console.log(`${label}: 位移=${d.toFixed(3)} Δrot=${(after.rot - before.rot).toFixed(4)} ` +
        `pos(${before.x},${before.y})->(${after.x},${after.y}) ` +
        `| roundController.update 次数=${dts.length} Σdt=${dts.reduce((a, b) => a + b, 0).toFixed(3)}s ` +
        `first3=${JSON.stringify(dts.slice(0, 3))} ` +
        `| gc.lastUpdate Δ=${(lu1 - lu0)}ms | CDP真实耗时=${realMs}ms`);
      return d;
    }

    console.log('\n--- 阶段1: 未打补丁（new Date() 仍是真实时间）---');
    await resetPose();
    await run('tight  __vtStep(20) 一次 evaluate', { yieldMs: 0 });
    await resetPose();
    await run('slow   每帧一次 evaluate + sleep(8)', { yieldMs: 8 });
    await resetPose();
    await run('slow2  每帧一次 evaluate + sleep(4)', { yieldMs: 4 });

    console.log('\n--- 阶段2: 页面内把 Date 构造函数也虚拟化 ---');
    console.log(await m.eval(PATCH_DATE));
    await resetPose();
    await run('tight  __vtStep(20) 一次 evaluate', { yieldMs: 0 });
    await resetPose();
    await run('slow   每帧一次 evaluate + sleep(8)', { yieldMs: 8 });

    // 看看慢速与快速的 dt 分别是什么
    const dtFast = await m.eval(`(()=>{ window.__dts=[]; return 1; })()`);
    void dtFast;
    console.log('\n时钟:', JSON.stringify(await m.stats()));
  } catch (e) { console.error('FAILED:', (e && e.stack) || e); process.exitCode = 1; }
  finally { await m.close(); }
})();
