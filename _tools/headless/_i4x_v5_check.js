'use strict';
/* v5 记录器：三条验证（wpn 决定性守卫 / v5 自洽 / 旧 v4 录制实测状态）+ rot 删除的产出核验
 * 只写 _tools/headless/_i4x_prof/；不碰 _i4_prof/、不改产品代码。
 */
const fs = require('fs'), path = require('path');
const { Match } = require('./match');
const { recordEpisode, replayEpisode, readRecording, compareFrames } = require('./record');
const OUT = path.join(__dirname, '_i4x_prof');
const brief = (c) => ({ ok: c.ok, hidden: c.hiddenMismatch, hiddenObs: c.hiddenObsMismatch,
  pose: c.poseMismatch, proj: c.projMismatch, rng: c.rngMismatch, op: c.opMismatch,
  drive: c.driveMismatch, time: c.timeMismatch, state: c.stateMismatch,
  maxPoseDiff: c.maxPoseDiff, ex: (c.examples || []).slice(0, 2) });
const clone = (x) => JSON.parse(JSON.stringify(x));

(async () => {
  const res = { startedAt: new Date().toISOString() };
  try {
    const recFile = path.join(OUT, 'v5_rec.jsonl'), repFile = path.join(OUT, 'v5_rep.jsonl');
    const m = new Match();
    const rec = await recordEpisode(m, { frames: 150, ids: ['tank_a', 'tank_b'], out: recFile });
    await m.close();
    const r = readRecording(recFile);
    res.headerV = r.header.v;
    res.frames = r.frames.length;
    const withProj = r.frames.filter((f) => (f.projs || []).length);
    res.rotKeyPresent = withProj.some((f) => f.projs.some((p) => Object.prototype.hasOwnProperty.call(p, 'rot')));
    res.projsSample = withProj.length ? withProj[0].projs[0] : null;
    res.wpnSample = (r.frames[0].hs || {}).wpn;
    res.wpnN = (r.frames[0].hs || {}).wpnN;
    await replayEpisode(r, { out: repFile });
    const r2 = readRecording(repFile);
    res.replayHeaderV = r2.header.v;
    res.baseline_v5 = brief(compareFrames(r.frames, r2.frames, 'v5 rec vs replay'));
    // ★ 必须挑【hs.wpn 非空】的帧（expanded round state 才有 weaponStates；短录制里只有前若干帧有）
    const half = r.frames.findIndex((f, i) => i > 5 && ((f.hs || {}).wpn || []).length);
    res.mutatedFrame = r.frames[half].f;
    const mutWpn = clone(r.frames), mutN = clone(r.frames);
    const hsW = mutWpn[half].hs;
    if (hsW.wpn && hsW.wpn.length) hsW.wpn[0][2] = String(hsW.wpn[0][2]).replace(/=(\d+)/, (s, d) => '=' + (Number(d) + 1));
    mutN[half].hs.wpnN = (mutN[half].hs.wpnN || 0) + 1;
    res.mut_example = { wpn_row_before: r.frames[half].hs.wpn[0], wpn_row_after: mutWpn[half].hs.wpn[0],
                        wpnN_before: r.frames[half].hs.wpnN, wpnN_after: mutN[half].hs.wpnN };
    res.guard_mutate_wpn = brief(compareFrames(mutWpn, r2.frames, 'mutate hs.wpn'));
    res.guard_mutate_wpnN = brief(compareFrames(mutN, r2.frames, 'mutate hs.wpnN'));
    const v4 = readRecording(path.join(OUT, 'v4_sample.jsonl'));
    res.v4 = { headerV: v4.header.v, frames: v4.frames.length, wpnSample: (v4.frames[0].hs || {}).wpn,
               wpnN_present: Object.prototype.hasOwnProperty.call(v4.frames[0].hs || {}, 'wpnN'),
               projsSample: (v4.frames.find((f) => (f.projs || []).length) || {}).projs };
    const repV4 = path.join(OUT, 'v4_replayed_by_v5.jsonl');
    await replayEpisode(v4, { out: repV4 });
    const rv4 = readRecording(repV4);
    res.v4_replay_ok = true;
    res.v4_vs_v5replay = brief(compareFrames(v4.frames, rv4.frames, 'v4 rec vs v5 replay'));
  } catch (e) { res.err = String((e && e.stack) || e); }
  fs.writeFileSync(path.join(OUT, '_i4x_v5_check.json'), JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res, null, 2));
})().catch((e) => { console.error('FAILED', (e && e.stack) || e); process.exitCode = 1; });
