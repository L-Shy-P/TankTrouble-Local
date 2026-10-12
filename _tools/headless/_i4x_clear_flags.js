'use strict';
/* 「清掉 sticky 标志」时两条取数路径的对照（同一帧内、清前/清后各采一次）
 *   old = gc.getRoundState()                        ← v5 记录器用的路径
 *   new = gc.roundController.getRoundState(true)    ← 真正【强制 expanded】的路径
 * 只写 _tools/headless/_i4x_prof/；不改产品代码。
 */
const fs = require('fs'), path = require('path');
const { Match } = require('./match');
const OUT = path.join(__dirname, '_i4x_prof');
const S = `(() => {
  var gc = GameManager.getGameController(); var m = gc.roundController.model;
  var a = gc.getRoundState(); a = (a && a.data) ? a.data : a;
  var b = gc.roundController.getRoundState(true); b = (b && b.data) ? b.data : b;
  return { mv: Object.keys(m.weapons||{}).length, mc: Object.keys(m.collectibles||{}).length,
           old: (a.weaponStates||[]).length, oldC: (a.collectibleStates||[]).length,
           new: (b.weaponStates||[]).length, newC: (b.collectibleStates||[]).length,
           initialSent: !!gc.roundController.initialRoundStateSent, st: gc.getState() };
})()`;
(async () => {
  const res = { startedAt: new Date().toISOString() };
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    await m.clearControl();
    await m.pump(10, { yieldMs: 0 });
    res.beforeClear = await m.eval(S);
    res.clearCall = await m.eval('(() => { var gc=GameManager.getGameController(); gc.clearExpandedRoundStateBits(); return { sent: !!gc.roundController.initialRoundStateSent }; })()');
    res.afterClearSameFrame = await m.eval(S);
    res.nextFrames = [];
    for (let i = 0; i < 6; i++) { await m.pump(1, { yieldMs: 0 }); res.nextFrames.push(await m.eval(S)); }
    await m.pump(30, { yieldMs: 0 });
    res.after30 = await m.eval(S);
  } catch (e) { res.err = String((e && e.stack) || e); } finally { try { await m.close(); } catch (e) {} }
  fs.writeFileSync(path.join(OUT, '_i4x_clear_flags.json'), JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res, null, 2));
})().catch((e) => { console.error('FAILED', (e && e.stack) || e); process.exitCode = 1; });
