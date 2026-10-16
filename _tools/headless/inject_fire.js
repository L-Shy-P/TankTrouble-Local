(function () {
  window.__b = { n: 0, bundleA: null, bundleB: null };
  window.__b.mk = function (tag) {
    return { name: 'nnbridge' + tag, isReady: function () { return true; },
      decide: function () { return (tag === 'B' ? window.__b.bundleB : window.__b.bundleA) || null; } };
  };
  window.__b.setup = function () {
    var A = VantageTreeInterface.Agents;
    A.register(window.__b.mk('A'), 'A'); A.register(window.__b.mk('B'), 'B');
    A.use('nnbridgeA', 'A'); A.use('nnbridgeB', 'B');
    return 'ok';
  };
  // ⭐ "路线上的第一个节点" = 沿 parentIdx 上溯到 parent<=0 的那个节点
  window.__b.firstHopUid = function (nSrc, targetUid) {
    if (!nSrc || !nSrc.length) return null;
    var idx = -1;
    for (var i = 0; i < nSrc.length; i++) { if ((nSrc[i][0] | 0) === targetUid) { idx = i; break; } }
    if (idx < 0) return null;
    var guard = 0;
    while (idx > 0 && guard++ < 2000) {
      var p = (nSrc[idx][1] | 0);
      if (p <= 0) { var L = Math.max(1, Math.round(+nSrc[idx][5] || 1)); return { uid: (nSrc[idx][0] | 0), L: L }; }
      idx = p;
    }
    return null;
  };
  // ⭐ 一次 eval：读观测 + 写决策。fire=1 时附一个"射击帧"pick（契约见 vantage_tree.js:4418-4455）
  window.__b.step = function (nodeId, fire) {
    var gc = GameManager.getGameController();
    var ad = VantageSandbox.createAdapter(gc, 'tank_a');
    var e = VantageObserve.encode({ adapter: ad, tree: VantageTree.getTree(), horizonSec: 10, K_death: 1, frameDt: 1 / 60 });
    var h = 2166136261 >>> 0;
    function mix(arr) { for (var i = 0; i < arr.length; i++) { h ^= (arr[i] | 0); h = (h * 16777619) >>> 0; } }
    try { mix(e.global.globalTok); mix(e.global.oppTok || []); } catch (err) { }
    try { var nd = e.node.nodeTok || []; mix(nd); } catch (err) { }
    try { var bl = e.bullet.bulletTok || []; mix(bl); } catch (err) { }
    var d = (typeof ad.getDeathsCount === 'function') ? ad.getDeathsCount() : 0;
    var gArr = (e.global && Array.isArray(e.global.globalTok)) ? e.global.globalTok : null;
    var nSrc = (e.nodes && Array.isArray(e.nodes.tokens)) ? e.nodes.tokens : null;
    if (!gArr || !nSrc) return JSON.stringify({ h: h >>> 0, err: 'token 段字段名不符(拒绝静默传 null)', topKeys: Object.keys(e),
      gKeys: e.global ? Object.keys(e.global) : null, nKeys: e.node ? Object.keys(e.node) : null });
    // ⭐ picks：picks[0]=路线目标；picks[1..]=射击帧（必须在路线上、back∈[0,L)）。
    //   游标语义（vantage_tree.js:4281）：目标每帧变 ⟹ 游标恒 0 ⟹ 射击帧必须落在"路线第一个节点"上，
    //   back 给 999（会被 clamp 到 L-1）⟹ 执行帧 = start + 0 = 0 ⟹ 当帧开火。
    var _picks = [{ nodeId: nodeId, back: 0 }];
    var _hop = null;
    if (+fire) {
      _hop = window.__b.firstHopUid(nSrc, nodeId);
      if (_hop) _picks.push({ nodeId: _hop.uid, back: Math.max(0, _hop.L - 1) });   // ⭐ L 取自节点 token 第6字段（NODE_FIELDS 的 'L'）
    }
    window.__b.bundleA = { picks: _picks, memory: {} };
    window.__b.bundleB = window.__b.bundleA;
    window.__b.n++;
    var n = nSrc.slice(0, 64);
    return JSON.stringify({ h: h >>> 0, alive: d === 0, dots: e.dims.total, g: gArr, n: n, hop: _hop, np: _picks.length });
  };
  window.__probe = window.__b;
  return 'installed';
})()
