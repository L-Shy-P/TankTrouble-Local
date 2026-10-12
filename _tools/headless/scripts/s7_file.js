(() => {
  const ph = GameManager.getGame();
  const L = ph.load;
  const pick = (f) => {
    if (!f) return null;
    const im = f.image;
    return {
      type: f.type, key: f.key, url: f.url, path: f.path,
      loading: f.loading, loaded: f.loaded, error: f.error,
      syncPoint: f.syncPoint,
      requestUrl: f.requestUrl,
      hasImage: !!im,
      imgSrc: im ? im.src : null,
      imgComplete: im ? im.complete : null,
      imgNaturalW: im ? im.naturalWidth : null,
      imgNaturalH: im ? im.naturalHeight : null,
      onloadType: im ? typeof im.onload : null,
      onerrorType: im ? typeof im.onerror : null,
      crossOrigin: im ? String(im.crossOrigin) : null,
    };
  };
  const out = {
    fileList: L._fileList.map(pick),
    flightQueue: L._flightQueue.map(pick),
    processingHead: L._processingHead,
    isLoading: L.isLoading,
    totalFileCount: L._totalFileCount,
    loadedFileCount: L._loadedFileCount,
    maxParallel: L.maxParallelDownloads,
    baseURL: L.baseURL,
    path: L.path,
    crossOrigin: String(L.crossOrigin),
  };
  // 这些 Image 是不是真的在飞？直接给它们补一个回调看看
  const im0 = L._flightQueue[0] && L._flightQueue[0].image;
  if (im0) {
    out.imgObserved = {
      completeNow: im0.complete,
      naturalNow: im0.naturalWidth,
      // 重新造一个同样 src 的图，对比
    };
    const t = new Image();
    t.src = im0.src;
    out.imgObserved.freshComplete = t.complete;
    out.imgObserved.freshNatural = t.naturalWidth;
  }
  return out;
})()
