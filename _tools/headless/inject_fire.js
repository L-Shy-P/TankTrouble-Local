(function () {
  window.__b = { n: 0, pendingSlots: null, wantFire: false, lastBuilt: null, buildMisses: 0, buildOK: 0 };
  // ⭐ 决策【当帧】再建包：把"上一帧读到的目标节点"翻译成 root→目标的 slot 序列，
  //    沿【当前树】重走取新鲜节点 id ⟹ 不依赖 id 跨帧稳定（父代理实测：id 会失效、报"节点编号不存在"）
  window.__b.build = function () {
    try {
      var tree = VantageTree.getTree();
      if (!tree || !tree.root) return null;
      var slots = window.__b.pendingSlots;
      if (!slots || !slots.length) return null;
      var n = tree.root, firstHop = null, i = 0;
      for (; i < slots.length; i++) {
        var kids = n.children || [], hit = null;
        for (var j = 0; j < kids.length; j++) {
          var c = kids[j]; if (!c) continue;
          var s = (typeof c.opIndex === 'number') ? c.opIndex : -1;
          if (s === slots[i]) { hit = c; break; }
        }
        if (!hit) break;
        if (i === 0) firstHop = hit;
        n = hit;
      }
      if (!n || n === tree.root) { window.__b.buildMisses++; return null; }
      var picks = [{ nodeId: n.id, back: 0 }];
      if (window.__b.wantFire && firstHop && firstHop !== tree.root) {
        var L = (typeof firstHop.validFrames === 'number' && firstHop.validFrames > 0) ? firstHop.validFrames : 75;
        picks.push({ nodeId: firstHop.id, back: Math.max(0, L - 1) });   // ⭐ 路线首节点 + back=L-1 ⟹ 当帧开火
      }
      window.__b.buildOK++;
      window.__b.lastBuilt = picks;
      return { picks: picks, memory: {} };
    } catch (e) { window.__b.buildErr = String(e && e.message || e); return null; }
  };
  window.__b.mk = function (tag) {
    return { name: 'nnbridge' + tag, isReady: function () { return true; }, decide: function () { return window.__b.build(); } };
  };
  window.__b.setup = function () {
    var A = VantageTreeInterface.Agents;
    A.register(window.__b.mk('A'), 'A'); A.register(window.__b.mk('B'), 'B');
    A.use('nnbridgeA', 'A'); A.use('nnbridgeB', 'B');
    return 'ok';
  };
  // ⭐ step：只读观测 + 记下"意图"（目标节点的 slot 路径 + 是否开火）；真正的包在 decide() 当帧建
  window.__b.step = function (nodeId, fire) {
    var gc = GameManager.getGameController();
    var ad = VantageSandbox.createAdapter(gc, 'tank_a');
    var e = VantageObserve.encode({ adapter: ad, tree: VantageTree.getTree(), horizonSec: 10, K_death: 1, frameDt: 1 / 60 });
    var h = 2166136261 >>> 0;
    function mix(arr) { for (var i = 0; i < arr.length; i++) { h ^= (arr[i] | 0); h = (h * 16777619) >>> 0; } }
    try { mix(e.global.globalTok); mix(e.global.oppTok || []); } catch (err) { }
    try { mix(e.node.nodeTok || []); } catch (err) { }
    var d = (typeof ad.getDeathsCount === 'function') ? ad.getDeathsCount() : 0;
    var gArr = (e.global && Array.isArray(e.global.globalTok)) ? e.global.globalTok : null;
    var nSrc = (e.nodes && Array.isArray(e.nodes.tokens)) ? e.nodes.tokens : null;
    if (!gArr || !nSrc) return JSON.stringify({ h: h >>> 0, err: 'token 段字段名不符(拒绝静默传 null)', topKeys: Object.keys(e) });
    var bSrc = (e.bullets && Array.isArray(e.bullets.tokens)) ? e.bullets.tokens : [];
    // ⭐ slot 路径：uid -> 沿 parentIdx 上溯 -> 收集 slot（NODE_FIELDS[2]）-> 反转
    var idx = -1;
    for (var i2 = 0; i2 < nSrc.length; i2++) { if ((nSrc[i2][0] | 0) === nodeId) { idx = i2; break; } }
    var slots = null;
    if (idx >= 0) {
      slots = [];
      var g2 = 0;
      while (idx > 0 && g2++ < 2000) { slots.push(nSrc[idx][2] | 0); var p = (nSrc[idx][1] | 0); if (p <= 0) break; idx = p; }
      slots.reverse();
    }
    window.__b.pendingSlots = slots;
    window.__b.wantFire = !!fire;
    return JSON.stringify({ h: h >>> 0, alive: d === 0, dots: e.dims.total, g: gArr, n: nSrc,
      b: bSrc, nSlots: slots ? slots.length : -1, nBul: bSrc.length, bDim: (e.bullets && e.bullets.dim) || null });
  };
  window.__probe = window.__b;
  return 'installed';
})()
