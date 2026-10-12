(async () => {
  const out = {};
  const URL_ = 'assets/images/lobby/waiting.png';
  const load = (cors) => new Promise((res) => {
    const im = new Image();
    if (cors) im.crossOrigin = 'anonymous';
    const t = setTimeout(() => res('超时3秒'), 3000);
    im.onload = () => { clearTimeout(t); res('OK ' + im.width + 'x' + im.height); };
    im.onerror = (e) => { clearTimeout(t); res('onerror'); };
    im.src = URL_;
  });
  out.无cors = await load(false);
  out.有cors = await load(true);

  try {
    const r = await fetch(URL_);
    out.fetch = r.status + ' ' + r.headers.get('content-type') + ' AccessControl=' + r.headers.get('access-control-allow-origin');
  } catch (e) { out.fetch = 'ERR ' + e; }

  out.origin = location.origin;
  out.href = location.href;
  return out;
})()
