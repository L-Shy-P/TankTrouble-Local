(() => {
  const ph = GameManager.getGame();
  const out = {};
  const dump = () => ({
    state: ph.state.current,
    loopFrames: ph.loop ? ph.loop.frames : 'nil',
    loopNow: ph.loop ? ph.loop.now : 'nil',
    loopLast: ph.loop ? ph.loop.lastTime : 'nil',
    loopDelta: ph.loop ? ph.loop.delta : 'nil',
    loopElapsed: ph.loop ? ph.loop.elapsed : 'nil',
    loopTicks: ph.loop ? ph.loop.ticks : 'nil',
    loopRunning: ph.loop ? ph.loop.running : 'nil',
    loopPause: ph.loop ? ph.loop._pauseTime : 'nil',
    timePaused: ph.time ? ph.time.paused : 'nil',
    timeNow: ph.time ? ph.time.now : 'nil',
    timeFrames: ph.time ? ph.time.frames : 'nil',
    timeElapsed: ph.time ? ph.time.elapsed : 'nil',
    timeDelta: ph.time ? ph.time.delta : 'nil',
    desiredFps: ph.loop ? ph.loop.desiredFps : 'nil',
    timeScale: ph.loop ? ph.loop.timeScale : 'nil',
    imgCache: Object.keys((ph.cache._cache || {}).image || {}).length,
    loadIsLoading: ph.load.isLoading,
    vtT: window.__vt.t,
  });

  out.before = dump();

  // 挂计数器：看 game.update / state.update 到底被调了几次
  let gameUpdateCalls = 0, stateUpdateCalls = 0;
  const ogu = ph.update, osu = ph.state.update;
  ph.update = function (t) { gameUpdateCalls++; return ogu.apply(this, arguments); };
  ph.state.update = function () { stateUpdateCalls++; return osu.apply(this, arguments); };

  // 真实时间跑 1 秒（60 帧虚拟），看计数器
  window.__vtStep(60);
  out.afterSteps60 = dump();
  out.gameUpdateCalls = gameUpdateCalls;
  out.stateUpdateCalls = stateUpdateCalls;
  out.vtErrors = window.__vt.errors.slice(0, 5);

  // 摘掉钩子
  ph.update = ogu; ph.state.update = osu;

  // 手动硬推：绕过一切，直接调 game.update
  try {
    for (let i = 0; i < 5; i++) ph.update(Math.floor(window.__vt.t) + (i + 1) * 17);
    out.afterManualUpdate = dump();
  } catch (e) { out.manualUpdateErr = String(e && e.stack || e).slice(0, 400); }

  out.vtStats = window.__vtStats();
  return out;
})()
