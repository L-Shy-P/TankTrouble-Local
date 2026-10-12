(async () => {
  const ph = GameManager.getGame();
  const trace = [];
  const t0 = Date.now();
  let broke = false;

  for (let i = 0; i < 500; i++) {
    window.__vtStep(1);                      // 推进 1 帧虚拟时间
    await new Promise((r) => setTimeout(r, 8)); // 让出 8ms 真实时间给 I/O

    const st = ph.state.current;
    const imgs = Object.keys((ph.cache._cache || {}).image || {}).length;
    if (i % 40 === 0 || st !== 'Boot') {
      trace.push({ i, state: st, imgs, ms: Date.now() - t0 });
    }
    if (st !== 'Boot' && st !== '') { broke = true; break; }
    if (i > 60 && imgs > 2) { /* 图片进来了 */ }
  }

  return {
    trace: trace.slice(0, 24),
    brokeOutOfBoot: broke,
    finalState: ph.state.current,
    imgCache: Object.keys((ph.cache._cache || {}).image || {}),
    virtualT: window.__vt.t,
    realMs: Date.now() - t0,
    vtErrors: window.__vt.errors.slice(0, 3),
  };
})()
