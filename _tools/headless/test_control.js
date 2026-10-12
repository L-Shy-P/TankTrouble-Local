'use strict';
/* 验证「车能开、炮能打」。
 * 约束：至少 2 个玩家才开局，而 Laika 会主动来杀 tank_a（实测 2~5 秒内得手），
 * 所以：① 每项测试都短；② 整体跑完约 100 帧；③ 不完整就重开一局重试。 */
const { Match } = require('./match');
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

async function attempt(n) {
  const m = new Match();
  const R = { attempt: n };
  try {
    await m.open({ aiCount: 1 });

    // 自适应等回合开始：倒计时期间 setInputState 会被游戏直接丢弃，
    // 所以一边给前进信号一边看动不动，动了才说明真的能开。
    await m.clearControl();
    let started = false;
    for (let i = 0; i < 30; i++) {
      const p0 = await m.myTank();
      if (!p0) break;
      await m.setControl({ fwd: true });
      await m.pump(8, { yieldMs: 4 });
      const p1 = await m.myTank();
      if (p1 && dist(p0, p1) > 0.5) { started = true; break; }
    }
    await m.clearControl();
    R.warmupStarted = started;
    if (!started) return Object.assign(R, { died: '预热期' });

    // --- 开火（最快，先做）---
    await m.clearControl();
    const f0 = await m.projectileCount();
    const wk0 = (await m.snapshot()).weapons.find((w) => w.owner === m.tankId) || {};
    await m.setControl({ fire: true });
    await m.pump(18, { yieldMs: 4 });
    const f1 = await m.projectileCount();
    const wk1 = (await m.snapshot()).weapons.find((w) => w.owner === m.tankId) || {};
    await m.clearControl();
    R.fire = { proj: [f0, f1], fired: [wk0.fired, wk1.fired], ok: f1 > f0 || wk1.fired > wk0.fired };

    // --- 前进 ---
    const a0 = await m.myTank();
    if (!a0) return Object.assign(R, { died: '开火后' });
    await m.setControl({ fwd: true });
    await m.pump(35, { yieldMs: 4 });
    const a1 = await m.myTank();
    await m.clearControl();
    R.forward = { moved: a1 ? +dist(a0, a1).toFixed(2) : null, ok: !!(a1 && dist(a0, a1) > 2) };

    // --- 转向 ---
    const b0 = await m.myTank();
    if (!b0) return Object.assign(R, { died: '前进后' });
    await m.setControl({ left: true });
    await m.pump(22, { yieldMs: 4 });
    const b1 = await m.myTank();
    await m.clearControl();
    const c0 = (await m.myTank()) || b1;
    if (!c0) return Object.assign(R, { died: '左转后' });
    await m.setControl({ right: true });
    await m.pump(22, { yieldMs: 4 });
    const c1 = await m.myTank();
    await m.clearControl();
    const l = b1 ? +(b1.rot - b0.rot).toFixed(3) : null;
    const r = c1 ? +(c1.rot - c0.rot).toFixed(3) : null;
    R.turn = { left: l, right: r, ok: Math.abs(l || 0) > 0.15 && Math.abs(r || 0) > 0.15 && l * r < 0 };

    R.vtErrors = (await m.stats()).errors;
    R.allOk = !!(R.fire.ok && R.forward.ok && R.turn.ok);
    return R;
  } finally { await m.close(); }
}

(async () => {
  for (let i = 1; i <= 3; i++) {
    const R = await attempt(i);
    console.log('\n--- \u7b2c ' + i + ' \u6b21 ---');
    console.log('\u5f00\u706b:  \u5f39\u6570 ' + JSON.stringify(R.fire && R.fire.proj) + '  fired ' + JSON.stringify(R.fire && R.fire.fired) + '   ' + (R.fire && R.fire.ok ? 'OK' : 'X'));
    if (R.forward) console.log('\u524d\u8fdb:  \u8d70\u4e86 ' + R.forward.moved + ' \u683c   ' + (R.forward.ok ? 'OK' : 'X'));
    if (R.turn) console.log('\u8f6c\u5411:  \u5de6\u0394=' + R.turn.left + '  \u53f3\u0394=' + R.turn.right + '   ' + (R.turn.ok ? 'OK' : 'X'));
    if (R.died) console.log('(tank_a \u5728' + R.died + '\u9635\u4ea1\uff0c\u672c\u8f6e\u4e0d\u5b8c\u6574)');
    if (R.vtErrors && R.vtErrors.length) console.log('vtErrors:', R.vtErrors.slice(0, 2));
    if (R.allOk) { console.log('\n*** \u56db\u9879\u5168\u901a \u2014\u2014 \u8f66\u80fd\u5f00\u3001\u70ae\u80fd\u6253 ***'); process.exit(0); }
    console.log('\u672c\u8f6e\u4e0d\u5b8c\u6574\uff0c\u91cd\u5f00\u4e00\u5c40\u91cd\u8bd5\u2026');
  }
  console.log('\n\u4e09\u6b21\u90fd\u6ca1\u6d4b\u5168\uff08\u5927\u6982\u7387\u662f Laika \u6740\u592a\u5feb\uff0c\u4e0d\u662f\u63a7\u5236\u574f\u4e86\uff09');
  process.exitCode = 1;
})();
