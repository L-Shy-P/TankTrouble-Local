(() => {
  const ph = GameManager.getGame();
  const P = { imageCalls: [], startCalls: 0, queueAtStart: null, imageCreated: [], errors: [] };

  // 打点 load.image
  const L = ph.load;
  const oi = L.image;
  L.image = function (key, url) { P.imageCalls.push(String(key) + ' <= ' + String(url)); return oi.apply(this, arguments); };
  const os = L.start;
  L.start = function () { P.startCalls++; P.queueAtStart = (this._queue || []).length; return os.apply(this, arguments); };
  const olc = L.loadComplete;
  if (olc) L.loadComplete = function () { P.loadCompleteCalled = (P.loadCompleteCalled || 0) + 1; return olc.apply(this, arguments); };

  // 打点 Image 构造，看有没有真的去下图片
  const OImg = window.Image;
  window.Image = function () { const im = new OImg(); P.imageCreated.push('new'); return im; };

  // 从头跑一次 Boot
  try { ph.state.start('Boot', true, false); } catch (e) { P.startErr = String(e); }
  window.__vtStep(120);

  window.Image = OImg;

  P.after = {
    state: ph.state.current,
    loadIsLoading: L.isLoading,
    loadHasLoaded: L.hasLoaded,
    queueLen: (L._queue || []).length,
    pendingLen: (L._pendingFileQueue || []).length,
    imgCache: Object.keys((ph.cache._cache || {}).image || {}),
    stateCreated: ph.state._created,
    onUpdate: !!ph.state.onUpdateCallback,
  };
  P.vtErrors = window.__vt.errors.slice(0, 3);
  return P;
})()
