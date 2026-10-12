'use strict';
/* 微探针：teleport 的 rotation 到底什么时候会丢？
 * 顶墙实验里 3 次 teleport 有 2 次 rot 没生效（变成同一个值 4.08162），1 次生效（π）。
 * 这里：设完立刻读（0 帧）→ 判定"没设上"还是"设上了又被重置"。
 */
const { Match } = require('./match');

(async () => {
  const m = new Match();
  try {
    await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    await m.clearControl();
    const ROT = `(() => { var t = GameManager.getGameController().getTank('tank_a');
      return t ? { rot: +t.getRotation().toFixed(5), x: +t.getX().toFixed(2), y: +t.getY().toFixed(2) } : null; })()`;

    for (const want of [1.0, 2.5, -1.5708, Math.PI / 2]) {
      await m.teleport('tank_a', 55, 45, want);
      const r0 = await m.eval(ROT);              // 0 帧：设完立刻读
      await m.pump(8, { yieldMs: 2 });
      const r8 = await m.eval(ROT);              // 8 帧后再读
      console.log(`want=${want.toFixed(5)}  立即读=${r0.rot}  8帧后=${r8.rot}  ${r0.rot === +want.toFixed(5) ? '设上了' : '✗ 没设上'}${r8.rot !== r0.rot ? ' 且8帧后变了' : ''}`);
    }
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
