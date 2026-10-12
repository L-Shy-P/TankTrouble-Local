'use strict';
/* 配对实测（同一帧内对照）：录 N 帧，同时每帧记
 *   ① 模型真值 Object.keys(model.weapons / collectibles).length
 *   ② 非 expanded 视图 gc.getRoundState()  的 weaponStates / collectibleStates 长度（= v5 记录器看到的东西）
 *   ③ expanded  视图 gc.getRoundState(true) 的同上（= v6 记录器看到的东西）
 * 然后与录制帧里的 hs.wpn / hs.col 逐帧对照。
 * 用法: node _tools/headless/_i4x_pair.js --frames 300 [--crate 1]
 * 只写 _tools/headless/_i4x_prof/；不改产品代码。
 */
const fs = require('fs'), path = require('path');
const { Match } = require('./match');
const { recordEpisode, readRecording } = require('./record');
const OUT = path.join(__dirname, '_i4x_prof');
const argv = process.argv.slice(2);
const num = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : Number(argv[i + 1]); };
const N = num('frames', 300), WITH_CRATE = argv.includes('--crate'), WITH_CLEAR = argv.includes('--clear');
const HOOK = `(function () {
  window.__i4xPair = [];
  window.__vtAfter.push(function () {
    try {
      var gc = GameManager.getGameController(); if (!gc) return;
      var m = gc.roundController.model;
      // ★ 采样前清 model 缓存（否则 getRoundState(true) 会返回【同一帧里更早建好的、可能已过期的】expanded 缓存）
      if ('cachedRoundState' in m) m.cachedRoundState = null;
      var d1 = gc.getRoundState();     var a = (d1 && d1.data) ? d1.data : d1;
      if ('cachedRoundState' in m) m.cachedRoundState = null;
      var d2 = gc.roundController.getRoundState(true); var b = (d2 && d2.data) ? d2.data : d2;
      var n = window.__i4xPair.length;
      if (window.__i4xClearAt != null && n === window.__i4xClearAt) {
        gc.clearExpandedRoundStateBits(); window.__i4xClearedAt = n;   // ★ 用 GameController 那个：它同时清 playerAdded（在线客户端就是这么做的）
      }
      window.__i4xPair.push({ mv: Object.keys(m.weapons||{}).length,
        mc: Object.keys(m.collectibles||{}).length, mt: Object.keys(m.tanks||{}).length,
        nonExp: (a.weaponStates||[]).length, exp: (b.weaponStates||[]).length,
        nonExpC: (a.collectibleStates||[]).length, expC: (b.collectibleStates||[]).length,
        st: gc.getState() });
    } catch (e) { window.__i4xPair.push({ err: String((e && e.message) || e) }); }
  });
  return 1;
})()`;
const SPAWN = `(() => {
  var gc = GameManager.getGameController(); var mz = gc.getMaze();
  var p = mz.getRandomUnusedPosition(gc.getRoundState(true), 3); if (!p) return {err:'no pos'};
  var st = CollectibleState.withState(IdGenerator.instance.gen('c'), Constants.COLLECTIBLE_TYPES.GOLD, p.x, p.y, 0);
  gc.roundController.setCollectibleState(st); return { id: st.getId(), x: p.x, y: p.y }; })()`;
let SETUP = false;
const origOpen = Match.prototype.open;
Match.prototype.open = async function (opts) {
  const r = await origOpen.call(this, opts);
  if (SETUP) {
    await this.eval(HOOK);
    if (WITH_CLEAR) await this.eval('window.__i4xClearAt = 20;');
    if (WITH_CRATE) this.__spawn = await this.eval(SPAWN);
  }
  return r;
};
(async () => {
  const res = { startedAt: new Date().toISOString(), frames: N, crate: WITH_CRATE };
  try {
    SETUP = true;
    const m = new Match();
    const f = path.join(OUT, `pair_${N}${WITH_CRATE ? '_crate' : ''}.jsonl`);
    await recordEpisode(m, { frames: N, ids: ['tank_a', 'tank_b'], out: f });
    res.pair = await m.eval('window.__i4xPair');
    res.spawn = m.__spawn || null;
    res.clearedAt = await m.eval('window.__i4xClearedAt != null ? window.__i4xClearedAt : null');
    res.file = path.basename(f);
    await m.close();
    SETUP = false;
    const r = readRecording(f);
    const P = res.pair || [], F = r.frames;
    res.v = r.header.v;
    res.n = Math.min(P.length, F.length);
    let blindW = 0, blindWexp = 0, actW = 0, blindC = 0, actC = 0, cov = 0;
    const examples = [];
    for (let i = 0; i < res.n; i++) {
      const p = P[i], hs = (F[i].hs) || {};
      const wpnN = (hs.wpn || []).length, colN = hs.col || 0;
      if ((p.nonExp > 0) === (wpnN > 0)) cov++;
      if (p.mv > 0) { actW++; if (wpnN === 0) { blindW++; if (examples.length < 3) examples.push({ f: i, modelWeapons: p.mv, nonExp: p.nonExp, exp: p.exp, recWpn: wpnN, recSt: F[i].st, st: p.st }); } }
      if (p.mv > 0 && p.exp === 0) blindWexp++;
      if (p.mc > 0) { actC++; if (colN === 0) blindC++; }
    }
    let firstBlind = null;
    for (let i = 0; i < res.n; i++) { const p = P[i]; const wpnN = ((F[i].hs || {}).wpn || []).length; if (p.mv > 0 && p.nonExp === 0 && firstBlind === null) firstBlind = { f: i, modelWeapons: p.mv, nonExp: p.nonExp, exp: p.exp, recWpn: wpnN, st: p.st }; }
    res.firstBlindNonExp = firstBlind;
    res.stats = { pairSamples: P.length, recFrames: F.length, framesWithWeaponsInModel: actW,
      blindWpn_v5style_nonExp: blindW, blindWpn_expanded0: blindWexp,
      framesWithCrateInModel: actC, blindCol: blindC, recWpnEqualsNonExp: cov };
    res.examples = examples;
  } catch (e) { res.err = String((e && e.stack) || e); }
  fs.writeFileSync(path.join(OUT, `_i4x_pair_${N}${WITH_CRATE ? '_crate' : ''}.json`), JSON.stringify(res, null, 2));
  console.log(JSON.stringify({ stats: res.stats, examples: res.examples, err: res.err, v: res.v }, null, 2));
})().catch((e) => { console.error('FAILED', (e && e.stack) || e); process.exitCode = 1; });
