(() => {
  const ph = GameManager.getGame();
  const L = ph.load;
  const out = {};
  out.hasUpdateFn = typeof L.update === 'function';
  out.isLoading = L.isLoading;
  out.imgCacheBefore = Object.keys((ph.cache._cache || {}).image || {});

  let updateCalls = 0, progressCalls = 0;
  const ou = L.update;
  L.update = function () { updateCalls++; return ou.apply(this, arguments); };
  if (typeof L.updateProgress === 'function') {
    const op = L.updateProgress;
    L.updateProgress = function () { progressCalls++; return op.apply(this, arguments); };
  }

  // 把所有可能的队列都列出来
  const queueProps = {};
  for (const k in L) {
    if (Array.isArray(L[k]) || (L[k] && typeof L[k] === 'object' && k.indexOf('queue') >= 0)) {
      queueProps[k] = Array.isArray(L[k]) ? L[k].length : 'obj';
    }
  }
  out.queueProps = queueProps;

  window.__vtStep(90);

  out.updateCalls = updateCalls;
  out.progressCalls = progressCalls;
  out.after = {
    state: ph.state.current,
    isLoading: L.isLoading,
    hasLoaded: L.hasLoaded,
    progress: L.progress,
    imgCache: Object.keys((ph.cache._cache || {}).image || {}),
    totalLoadedFiles: L.totalLoadedFiles,
  };
  out.vtErrors = window.__vt.errors.slice(0, 3);

  // 再试一次：手动把 loader 推完，看能不能过 Boot
  try {
    if (L.isLoading && typeof L.loadComplete === 'function') {
      L.loadComplete();
      out.forcedLoadComplete = 'called';
    }
  } catch (e) { out.forceErr = String(e); }
  window.__vtStep(30);
  out.afterForce = { state: ph.state.current, imgCache: Object.keys((ph.cache._cache || {}).image || {}) };
  return out;
})()
