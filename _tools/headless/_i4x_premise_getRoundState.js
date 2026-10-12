'use strict';
/* 前提实测：`gc.getRoundState(true)`（expanded 视图）有没有副作用？
 *   A. 同一帧：调它之前 / 之后，`rn`(随机数消费游标) / `rc` / 模型真值计数 / 弹药字段 是否变化
 *   B. A/B 对拍：同一 RNG 带 + 同输入，唯一差别 = 处理组每帧多调一次 getRoundState(true)
 *      （走官方 replayEpisode；用 monkey-patch Match.prototype.open 注入每帧钩子）
 * 只写 _tools/headless/_i4x_prof/；不改产品代码。
 */
const fs = require('fs'), path = require('path');
const { Match } = require('./match');
const { recordEpisode, replayEpisode, readRecording, compareFrames } = require('./record');
const OUT = path.join(__dirname, '_i4x_prof');
const HOOK_STATS = [];
const brief = (c) => ({ ok: c.ok, hidden: c.hiddenMismatch, hiddenObs: c.hiddenObsMismatch, pose: c.poseMismatch,
  proj: c.projMismatch, rng: c.rngMismatch, op: c.opMismatch, drive: c.driveMismatch, time: c.timeMismatch,
  state: c.stateMismatch, maxPoseDiff: c.maxPoseDiff, ex: (c.examples || []).slice(0, 2) });

const SAMPLE = `(() => {
  var gc = GameManager.getGameController(); if (!gc) return { err: 'no gc' };
  var st = (window.__vtRng && window.__vtRng.state) ? window.__vtRng.state() : null;
  var m = (gc.roundController && gc.roundController.model) ? gc.roundController.model : null;
  var d = (function(){ var rs = gc.getRoundState(); return (rs && rs.data) ? rs.data : rs; })() || {};
  var ws = d.weaponStates || [];
  function fields(w){ try { return JSON.parse(w.fieldsJSON || '{}'); } catch (e) { return {}; } }
  return { rn: st ? (st.mode === 'record' ? st.len : st.idx) : null, rnCalls: st ? st.calls : null,
           rc: gc.getRoundId(), state: gc.getState(),
           raw: m ? { tanks: Object.keys(m.tanks||{}).length, projs: Object.keys(m.projectiles||{}).length,
                      weapons: Object.keys(m.weapons||{}).length, traps: Object.keys(m.traps||{}).length,
                      collectibles: Object.keys(m.collectibles||{}).length } : null,
           wpnKeys: ws.map(function(w){ return [w.playerId, w.type, Object.keys(fields(w)).sort().join('|')]; }),
           wpnN: ws.length, colN: (d.collectibleStates||[]).length, projN: (d.projectileStates||[]).length };
})()`;

const CALL_EXPANDED = `(() => { var gc = GameManager.getGameController(); var r = null; for (var i = 0; i < 3; i++) r = gc.getRoundState(true); return !!(r && r.data); })()`;

const HOOK_SRC = `(function () {
  window.__i4xHook = { calls: 0, err: null };
  window.__vtAfter.push(function () {
    try { var gc = GameManager.getGameController(); if (gc) { gc.getRoundState(true); window.__i4xHook.calls++; } }
    catch (e) { window.__i4xHook.err = String(e && e.message || e); }
  });
  return window.__i4xHook;
})()`;

(async () => {
  const res = { startedAt: new Date().toISOString() };
  let origOpen = Match.prototype.open, hookOn = false;
  Match.prototype.open = async function (opts) {
    const r = await origOpen.call(this, opts);
    if (hookOn) { HOOK_STATS.push(await this.eval(HOOK_SRC)); }
    return r;
  };
  try {
    /* ---- Part 1：同一帧 before/after ---- */
    const m0 = new Match();
    await m0.open({ humanIds: ['tank_a', 'tank_b'], aiCount: 0, vantCount: 0 });
    await m0.clearControl();
    await m0.eval(`window.__i4xw = {};`);   // 先打一发，让场上/武器状态有内容
    await m0.setControl({ fire: true }); await m0.pump(3, { yieldMs: 0 }); await m0.setControl({ fire: false });
    await m0.pump(12, { yieldMs: 0 });
    res.sameFrame = {};
    res.sameFrame.before = await m0.eval(SAMPLE);
    res.sameFrame.called = await m0.eval(CALL_EXPANDED);
    res.sameFrame.after = await m0.eval(SAMPLE);
    res.sameFrame.identical = JSON.stringify(res.sameFrame.before) === JSON.stringify(res.sameFrame.after);
    res.sameFrame.diff = res.sameFrame.identical ? null : {
      before: res.sameFrame.before, after: res.sameFrame.after };
    // 再推 5 帧：看后续是否正常（对照 Part 2 的逐帧对拍）
    res.sameFrame.after5 = await (async () => { await m0.pump(5, { yieldMs: 0 }); return m0.eval(SAMPLE); })();
    await m0.close();

    /* ---- Part 2：A/B 对拍（唯一差别 = 处理组每帧多调一次 getRoundState(true)）---- */
    const recFile = path.join(OUT, 'premise_ctl.jsonl'), repFile = path.join(OUT, 'premise_trt.jsonl');
    const m = new Match();
    const rec = await recordEpisode(m, { frames: 150, ids: ['tank_a', 'tank_b'], out: recFile });
    await m.close();
    const r = readRecording(recFile);
    res.ctl = { frames: r.frames.length, v: r.header.v, wpnNonEmpty: r.frames.filter((f) => ((f.hs||{}).wpn||[]).length).length,
                colNonZero: r.frames.filter((f) => ((f.hs||{}).col||0) > 0).length };
    hookOn = true;
    await replayEpisode(r, { out: repFile });
    hookOn = false;
    const r2 = readRecording(repFile);
    res.hook = HOOK_STATS;
    res.ab = brief(compareFrames(r.frames, r2.frames, 'ctl vs trt(+每帧 getRoundState(true))'));
    res.trt = { frames: r2.frames.length, v: r2.header.v, wpnNonEmpty: r2.frames.filter((f) => ((f.hs||{}).wpn||[]).length).length,
                colNonZero: r2.frames.filter((f) => ((f.hs||{}).col||0) > 0).length };
    res.premise_holds = !!res.ab.ok && res.sameFrame.identical === true;
  } catch (e) { res.err = String((e && e.stack) || e); }
  fs.writeFileSync(path.join(OUT, '_i4x_premise.json'), JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res, null, 2));
})().catch((e) => { console.error('FAILED', (e && e.stack) || e); process.exitCode = 1; });

