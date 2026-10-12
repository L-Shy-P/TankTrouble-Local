'use strict';
/* 「hs.col 在道具确实存在时是否为 0」直测：放 1 个真 crate，逐帧同时看
 *   ① 模型真值 Object.keys(model.collectibles).length
 *   ② 非 expanded 视图 gc.getRoundState() 的 collectibleStates 长度
 *   ③ expanded  视图 gc.getRoundState(true) 的 collectibleStates 长度
 * 只写 _tools/headless/_i4x_prof/；不改产品代码。
 */
const fs = require('fs'), path = require('path');
const { Match } = require('./match');
const OUT = path.join(__dirname, '_i4x_prof');
const SAMPLE = `(() => {
  var gc = GameManager.getGameController();
  var m = gc.roundController.model;
  var d1 = gc.getRoundState();      var a = (d1 && d1.data) ? d1.data : d1;
  var d2 = gc.getRoundState(true);  var b = (d2 && d2.data) ? d2.data : d2;
  return { modelCol: Object.keys(m.collectibles || {}).length,
           nonExp: (a.collectibleStates || []).length,
           exp: (b.collectibleStates || []).length,
           wpnNonExp: (a.weaponStates || []).length, wpnExp: (b.weaponStates || []).length };
})()`;
(async () => {
  const res = { startedAt: new Date().toISOString(), frames: [] };
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    await m.clearControl();
    res.spawn = await m.eval(`(() => {
      var gc = GameManager.getGameController(); var mz = gc.getMaze();
      var p = mz.getRandomUnusedPosition(gc.getRoundState(true), 3);
      if (!p) return { err: 'no pos' };
      var st = CollectibleState.withState(IdGenerator.instance.gen('c'), Constants.COLLECTIBLE_TYPES.GOLD, p.x, p.y, 0);
      gc.roundController.setCollectibleState(st);
      res_ = { id: st.getId(), x: p.x, y: p.y };
      window.__colProbe = { id: st.getId() };
      return res_;
    })()`);
    for (let i = 0; i < 12; i++) { res.frames.push(Object.assign({ f: i }, await m.eval(SAMPLE))); await m.pump(1, { yieldMs: 0 }); }
    await m.pump(60, { yieldMs: 0 });
    for (let i = 0; i < 6; i++) { res.frames.push(Object.assign({ f: '60+' + i }, await m.eval(SAMPLE))); await m.pump(1, { yieldMs: 0 }); }
  } catch (e) { res.err = String((e && e.stack) || e); } finally { try { await m.close(); } catch (e) {} }
  fs.writeFileSync(path.join(OUT, '_i4x_col_probe.json'), JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res, null, 2));
})().catch((e) => { console.error('FAILED', (e && e.stack) || e); process.exitCode = 1; });
