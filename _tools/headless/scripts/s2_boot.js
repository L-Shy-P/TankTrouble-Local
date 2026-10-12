(() => {
  const out = {};
  const ph = GameManager.getGame();
  out.state = ph.state.current;

  const L = ph.load;
  out.loader = {
    isLoading: L.isLoading,
    hasLoaded: L.hasLoaded,
    progress: L.progress,
    totalQueuedFiles: L.totalQueuedFiles,
    totalLoadedFiles: L.totalLoadedFiles,
    totalFailedFiles: L.totalFailedFiles,
    filesQueued: L._filesQueued,
    filesTotal: L._filesTotal,
    _withSyncPoint: L._withSyncPoint,
    syncPoints: L._syncPoints,
    pendingFiles: (L._pendingFileQueue || []).length,
    queueSize: (L._queue || []).length,
    state: L.state,
  };

  // 缓存里已有哪些 key
  try {
    const k = Object.keys(ph.cache._cache || {});
    out.cacheGroups = k;
    out.cacheImageKeys = Object.keys((ph.cache._cache || {}).image || {}).slice(0, 20);
    out.cacheImageCount = Object.keys((ph.cache._cache || {}).image || {}).length;
  } catch (e) { out.cacheErr = String(e); }

  // 当前状态对象自己暴露了什么方法
  const st = ph.state.getCurrentState();
  out.stateMethods = st ? Object.keys(st).filter((k2) => typeof st[k2] === 'function') : null;
  out.stateHasPreload = !!(st && typeof st.preload === 'function');
  out.stateHasCreate = !!(st && typeof st.create === 'function');

  // 时钟
  out.timestep = {
    now: ph.time.now,
    time: ph.time.time,
    frames: ph.time.frames,
    fps: ph.time.fps,
    lastTime: ph.time.lastTime,
    elapsed: ph.time.elapsed,
    desiredFps: ph.time.desiredFps,
    timeScale: ph.time.timeScale,
    paused: ph.time.paused,
  };
  out.loopRunning = ph.isRunning;
  out.rafQueued = (window.__vt.queue || []).length;

  // 按键查：Phaser 认为 preload 阶段卡住了吗
  out.stateManager = {
    _created: ph.state._created,
    _pendingState: ph.state._pendingState,
    current: ph.state.current,
    onCreateCallback: !!ph.state.onCreateCallback,
    onUpdateCallback: !!ph.state.onUpdateCallback,
  };
  return out;
})()
