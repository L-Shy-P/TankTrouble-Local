'use strict';
/* 「hs 有值帧占比」固定协议测量：150 / 300 / 1200 帧各录一局，数 hs.wpn 非空、hs.col>0 的帧
 * 用法: node _tools/headless/_i4x_ratio.js --tag before|after
 * 只写 _tools/headless/_i4x_prof/；不改产品代码。
 */
const fs = require('fs'), path = require('path');
const { Match } = require('./match');
const { recordEpisode, readRecording } = require('./record');
const OUT = path.join(__dirname, '_i4x_prof');
const argv = process.argv.slice(2);
const TAG = (argv[argv.indexOf('--tag') + 1]) || 'x';

(async () => {
  const res = { tag: TAG, startedAt: new Date().toISOString(), runs: {} };
  for (const N of [150, 300, 1200]) {
    try {
      const f = path.join(OUT, `ratio_${TAG}_${N}.jsonl`);
      const m = new Match();
      await m.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
      await m.clearControl();
      // ★ 放一个【真 crate】（GOLD，离坦克 3 格以上，不会被捡）⟹ collectibleStates 非空，
      //   这样才能区分「col=0 是因为没道具」还是「因为取到的不是 expanded 视图」。
      const crate = await m.eval(`(() => {
        var gc = GameManager.getGameController(); var mz = gc.getMaze();
        var p = mz.getRandomUnusedPosition(gc.getRoundState(true), 3);
        if (!p) return { err: 'no pos' };
        var st = CollectibleState.withState(IdGenerator.instance.gen('c'), Constants.COLLECTIBLE_TYPES.GOLD, p.x, p.y, 0);
        gc.roundController.setCollectibleState(st);
        return { id: st.getId(), x: p.x, y: p.y };
      })()`);
      const crateId = crate && crate.id;
      const rec = await recordEpisode(m, { frames: N, ids: ['tank_a', 'tank_b'], out: f });
      await m.close();
      const r = readRecording(f);
      const fr = r.frames;
      const wpnNE = fr.filter((x) => ((x.hs || {}).wpn || []).length).length;
      const colNZ = fr.filter((x) => (((x.hs || {}).col) || 0) > 0).length;
      const wpnRows = fr.map((x) => ((x.hs || {}).wpn || []).length);
      res.runs[N] = { v: r.header.v, crate: crateId, frames: fr.length, wpnNonEmpty: wpnNE, wpnEmpty: fr.length - wpnNE,
        colNonZero: colNZ, colZero: fr.length - colNZ, wpnMaxRows: Math.max.apply(null, wpnRows),
        wpnN: (fr[0].hs || {}).wpnN, file: path.basename(f) };
    } catch (e) { res.runs[N] = { err: String((e && e.message) || e) }; }
  }
  fs.writeFileSync(path.join(OUT, `_i4x_ratio_${TAG}.json`), JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res, null, 2));
})().catch((e) => { console.error('FAILED', (e && e.stack) || e); process.exitCode = 1; });
