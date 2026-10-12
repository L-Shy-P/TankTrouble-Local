'use strict';
/* 阶段0-1 验收探针：修好之后的 teleport 行为
 *
 *   node _tools/headless/_probe_phase0_fix.js
 *
 * 验两件事：
 *   ① 倒计时内 teleport 会【响亮报错】（不是静默把 x/y/rot 丢掉）
 *   ② 倒计时后 teleport 的 x/y/rot 逐字段读回一致
 */
const { Match } = require('./match');

const read = `(() => {
  var gc = GameManager.getGameController();
  var out = { state: gc ? gc.getState() : null, tanks: {} };
  var ids = __vtArr(gc.getActivePlayerIds());
  for (var i = 0; i < ids.length; i++) {
    var t = gc.getTank(ids[i]);
    if (t) out.tanks[ids[i]] = { x: t.getX(), y: t.getY(), rot: t.getRotation() };
  }
  return out;
})()`;

(async () => {
  const m = new Match();
  try {
    // control:false —— 这局不需要开坦克；waitRound:false —— 故意停在倒计时里
    await m.open({ waitRound: false, control: false, humanIds: ['tank_a'], aiCount: 1 });

    // 泵到「倒计时 + 坦克已生成」
    let st = null, guard = 0;
    for (; guard < 300; guard++) {
      st = await m.eval('(() => { var gc = GameManager.getGameController(); return { s: gc.getState(), hasTank: !!gc.getTank("tank_a") }; })()');
      if (st.s === 'counting down' && st.hasTank) break;
      await m.pump(1, { yieldMs: 0 });
    }
    console.log('准备状态: state=' + st.s + ' tank_a存在=' + st.hasTank + '（泵了 ' + guard + ' 帧）');

    // ---- ① 倒计时内 teleport ----
    const before = await m.eval(read);
    let threw = null;
    try { await m.teleport('tank_a', 55, 25, 1.0); }
    catch (e) { threw = String(e && e.message || e); }
    const after = await m.eval(read);
    const direct = await m.eval(`(() => {
      var gc = GameManager.getGameController();
      var ok = gc.getTank('tank_a');
      var ts = TankState.withState('tank_a', 55, 25, false, false, 1.0, false, false, false, false);
      var ret = gc.setTankState(ts, false);
      return { ret: (ret === undefined ? 'undefined' : ret), gcState: gc.getState(), hasTank: !!ok };
    })()`);
    console.log('① 倒计时内 teleport 抛错: ' + (threw ? 'YES' : 'NO —— 还是静默！'));
    if (threw) console.log('   错误信息 = ' + threw);
    console.log('   前后位姿 before=' + JSON.stringify(before.tanks.tank_a) + ' after=' + JSON.stringify(after.tanks.tank_a));
    console.log('   直调 setTankState 真实返回值 = ' + JSON.stringify(direct));

    // ---- ② waitForRound 之后再 teleport ----
    const wait = await m.waitForRound();
    console.log('waitForRound: 泵 ' + wait.frames + ' 帧 → ' + wait.inRound + '；轨迹=' + wait.log.join(' | '));
    const want = { x: 55, y: 25, rot: 1.0 };
    const ret2 = await m.teleport('tank_a', want.x, want.y, want.rot);
    const got = (await m.eval(read)).tanks.tank_a;
    const same = got && got.x === want.x && got.y === want.y && got.rot === want.rot;
    console.log('② IN_ROUND 后 teleport 返回值 = ' + String(ret2) +
      '（undefined = 游戏 API 成功路径没有 return）');
    console.log('   读回 ' + JSON.stringify(got) + ' vs 期望 ' + JSON.stringify(want) +
      ' → 逐字段一致: ' + (same ? 'YES' : 'NO'));
    if (!same) process.exitCode = 1;
    if (!threw) process.exitCode = 1;
    console.log('lastTeleport = ' + JSON.stringify(m.lastTeleport));
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
