const { Match } = require('./match');
(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a','tank_b'], aiCount: 0 });
    await m.pump(150, { yieldMs: 6 });

    const info = await m.eval(`(() => {
      var mz = GameManager.getGameController().getMaze();
      var d = __vtData(mz) || mz;
      return { width: mz.width, height: mz.height,
               tankPositions: (mz.tankPositions||[]).slice(0,8),
               tankPosCount: (mz.tankPositions||[]).length,
               reachableCount: (mz.reachable||[]).length,
               distancesType: typeof mz.distances };
    })()`);
    console.log('迷宫:', JSON.stringify(info).slice(0,600));

    const pos = info.tankPositions;
    if (!pos.length) { console.log('没有 tankPositions'); return; }

    // 挑两个不同的合法位姿
    const A = pos[0], B = pos[pos.length - 1] || pos[1];
    const tele = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var p = ${JSON.stringify(A)};
      gc.setTankState(TankState.withState('tank_a', p.x, p.y, false,false, 0, false,false,false, false), false);
      return 'ok';
    })()`);
    await m.pump(4, { yieldMs: 6 });
    const at = await m.myTank();
    console.log('传送', tele, '目标', JSON.stringify(A), '实际', JSON.stringify(at));

    await m.setControl({ fwd: true });
    await m.pump(40, { yieldMs: 4 });
    const at2 = await m.myTank();
    await m.clearControl();
    const d = at && at2 ? Math.hypot(at2.x-at.x, at2.y-at.y) : -1;
    console.log('传送后前进 40 帧:', JSON.stringify(at2), '位移', d.toFixed(2));

    // 再传一次（验证可反复传送 = 不用重开回合）
    const tele2 = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var p = ${JSON.stringify(B)};
      gc.setTankState(TankState.withState('tank_a', p.x, p.y, false,false, 0, false,false,false, false), false);
      return 'ok';
    })()`);
    await m.pump(4, { yieldMs: 6 });
    const at3 = await m.myTank();
    console.log('二次传送', tele2, '目标', JSON.stringify(B), '实际', JSON.stringify(at3));
    console.log('\n判定:', JSON.stringify({
      传送准: at && Math.abs(at.x-A.x)<0.5 && Math.abs(at.y-A.y)<0.5,
      传送后能开: d > 2,
      可反复传送: at3 && Math.abs(at3.x-B.x)<0.5 && Math.abs(at3.y-B.y)<0.5,
    }));
  } catch (e) { console.error('FAILED:', (e && e.message) || e); }
  finally { await m.close(); }
})();
