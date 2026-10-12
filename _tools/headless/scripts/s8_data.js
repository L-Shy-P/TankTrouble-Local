(async () => {
  const ph = GameManager.getGame();
  const L = ph.load;
  const out = {};
  const f0 = L._flightQueue[0];
  out.fileKeys = Object.keys(f0 || {});
  const d = f0 && f0.data;
  out.hasData = !!d;
  if (d) {
    out.src = d.src;
    out.complete = d.complete;
    out.naturalW = d.naturalWidth;
    out.naturalH = d.naturalHeight;
    out.crossOrigin = String(d.crossOrigin);
    out.onloadType = typeof d.onload;
    out.onerrorType = typeof d.onerror;
  }
  try { out.transformUrl = L.transformUrl(f0.url, f0); } catch (e) { out.transformUrl = 'ERR ' + e; }
  out.baseURL = L.baseURL;
  out.path = L.path;
  out.useXDomainRequest = L.useXDomainRequest;

  // 手工照 Phaser 的写法重放一次，看 onload 到底会不会来
  out.replay = await new Promise((res) => {
    const im = new Image();
    im.name = 'replay';
    im.crossOrigin = 'anonymous';
    let fired = '未触发';
    const t = setTimeout(() => res({ result: fired, complete: im.complete, nw: im.naturalWidth, src: im.src }), 2500);
    im.onload = () => { fired = 'onload'; clearTimeout(t); res({ result: fired, complete: im.complete, nw: im.naturalWidth, nH: im.naturalHeight, src: im.src }); };
    im.onerror = () => { fired = 'onerror'; clearTimeout(t); res({ result: fired, complete: im.complete, nw: im.naturalWidth, src: im.src }); };
    im.src = out.transformUrl;
  });

  // 直接问浏览器：这个 URL 的图片能不能解码
  out.decoded = await new Promise((res) => {
    createImageBitmap && fetch(out.transformUrl).then(r => r.blob()).then(b => createImageBitmap(b))
      .then(bm => res(bm.width + 'x' + bm.height)).catch(e => res('ERR ' + e));
  });
  return out;
})()
