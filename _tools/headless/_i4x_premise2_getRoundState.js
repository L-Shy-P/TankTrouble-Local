'use strict';
/* 前提实测 v2：A/B 对拍 —— 唯一差别 = 处理组【每帧多调一次 gc.getRoundState(true)】
 * 与 v1 的区别：自己开 Match（不用 replayEpisode），这样能**读到**钩子真实调用次数（v1 读到的是 CDP 值拷贝，恒 0）。
 * 只写 _tools/headless/_i4x_prof/；不改产品代码。
 */
const fs = require('fs'), path = require('path');
const { Match } = require('./match');
const { recordEpisode, readRecording, compareFrames } = require('./record');
const OUT = path.join(__dirname, '_i4x_prof');
const brief = (c) => ({ ok: c.ok, hidden: c.hiddenMismatch, pose: c.poseMismatch, proj: c.projMismatch,
  rng: c.rngMismatch, op: c.opMismatch, drive: c.driveMismatch, time: c.timeMismatch, state: c.stateMismatch,
  maxPoseDiff: c.maxPoseDiff, ex: (c.examples || []).slice(0, 1) });
const HOOK = `(function () {
  window.__i4xHook = { calls: 0, err: null };
  window.__vtAfter.push(function () {
    try { var gc = GameManager.getGameController(); if (gc) { gc.getRoundState(true); window.__i4xHook.calls++; } }
    catch (e) { window.__i4xHook.err = String((e && e.message) || e); }
  });
  return window.__i4xHook.calls;
})()`;

(async () => {
  const res = { startedAt: new Date().toISOString() };
  try {
    const N = 150;
    const ctlFile = path.join(OUT, 'premise_ctl.jsonl');
    const m0 = new Match();
    const rec = await recordEpisode(m0, { frames: N, ids: ['tank_a', 'tank_b'], out: ctlFile });
    await m0.close();
    const r = readRecording(ctlFile);
    res.ctl = { v: r.header.v, frames: r.frames.length,
      wpnNonEmpty: r.frames.filter((f) => ((f.hs || {}).wpn || []).length).length,
      colNonZero: r.frames.filter((f) => ((f.hs || {}).col || 0) > 0).length };

    const boot = (r.header.init && r.header.init.bootstrap) || {};
    const m = new Match();
    await m.open(Object.assign({}, boot, {
      rng: 'play', rngSeq: r.rng, rngSites: r.rngSites, control: false, bootFrames: 300,
      epoch: (r.header.init && r.header.init.vtEpoch != null) ? r.header.init.vtEpoch : undefined,
      humanIds: boot.humanIds || ['tank_a', 'tank_b'], aiCount: boot.aiCount || 0, vantCount: boot.vantCount || 0,
    }));
    res.hookInstallReturn = await m.eval(HOOK);
    res.hookBefore = await m.eval('window.__i4xHook');
    await m.eval('window.__vtDrive.install()');
    const chunk = 50;
    for (let i = 0; i < r.frames.length; i += chunk) {
      await m.eval(`window.__vtDrive.load(${JSON.stringify(r.frames.slice(i, i + chunk))})`);
    }
    await m.eval(`window.__vtRec.start(${JSON.stringify({ page: 'index.html', bootstrap: boot,
      driven: (r.header.init && r.header.init.driven) || null })})`);
    await m.eval(`window.__vtDrive.start(${r.frames.length})`);
    await m.pump(r.frames.length, { yieldMs: 0 });
    res.hookAfterPump = await m.eval('window.__i4xHook');
    res.drvStop = await m.eval('window.__vtDrive.stop()');
    res.recStats = await m.eval('window.__vtRec.stats()');
    const frames = [];
    for (let i = 0; i < r.frames.length; i += chunk) {
      const c = await m.eval(`window.__vtRec.chunk(${i}, ${chunk})`);
      for (const s of c.records) frames.push(JSON.parse(s));
    }
    await m.close();
    res.trt = { frames: frames.length,
      wpnNonEmpty: frames.filter((f) => ((f.hs || {}).wpn || []).length).length,
      colNonZero: frames.filter((f) => ((f.hs || {}).col || 0) > 0).length };
    res.ab = brief(compareFrames(r.frames, frames, 'ctl vs trt(+每帧 expanded)'));
    res.premise_holds = !!res.ab.ok && (res.hookAfterPump || {}).calls > 0 && !(res.hookAfterPump || {}).err;
  } catch (e) { res.err = String((e && e.stack) || e); }
  fs.writeFileSync(path.join(OUT, '_i4x_premise2.json'), JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res, null, 2));
})().catch((e) => { console.error('FAILED', (e && e.stack) || e); process.exitCode = 1; });
