'use strict';
/* 阶段1/2/3 需要的底座：
   ① 无 AI 的双人局能不能开（保证回合存在，但没有对手）
   ② setTankState 能不能直接传送坦克（这样就不用重开回合） */
const { Match } = require('./match');

(async () => {
  const m = new Match();
  const T = (id) => `(() => { var gc=GameManager.getGameController(); var t=gc&&gc.getTank(${JSON.stringify(id)});
      if(!t) return null; return {x:+t.getX().toFixed(2), y:+t.getY().toFixed(2), rot:+t.getRotation().toFixed(4)}; })()`;

  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0 });
    await m.pump(150, { yieldMs: 6 });
    const s0 = await m.snapshot();
    console.log('无 AI 双人局:', JSON.stringify({ stage: s0.stage, players: s0.players, tanks: s0.tanks.map(t => `${t.id}@(${t.x},${t.y})`) }));

    // 传送坦克试试
    const before = await m.eval(T('tank_a'));
    const tele = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var t = gc.getTank('tank_a');
      if (!t) return 'no tank';
      var __TS = (typeof TankState !== 'undefined') ? TankState : null;
      if (!__TS) return 'no TankState global';
      gc.setTankState(__TS.withState('tank_a', 80, 20, false,false, 1.5, false,false,false, false), false);
      return 'sent';
    })()`);
    await m.pump(3, { yieldMs: 5 });
    const after = await m.eval(T('tank_a'));
    console.log('传送:', tele, ' ', JSON.stringify(before), '->', JSON.stringify(after));

    // 坦克被传送后还能不能开
    await m.setControl({ fwd: true });
    await m.pump(40, { yieldMs: 4 });
    const moved = await m.eval(T('tank_a'));
    await m.clearControl();
    const d = after && moved ? Math.hypot(moved.x - after.x, moved.y - after.y).toFixed(2) : '-';
    console.log('传送后前进 40 帧:', JSON.stringify(moved), ' 位移', d);

    const ok = { 无AI双人局: s0.tanks.length === 2 && s0.players.length === 2,
                 传送生效: !!(after && Math.abs(after.x - 80) < 1),
                 传送后能开: Number(d) > 2 };
    console.log('\n判定:', JSON.stringify(ok));
    console.log(Object.values(ok).every(Boolean) ? '*** 阶段1/2/3 底座可用 ***' : '*** 有项未通过 ***');
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
