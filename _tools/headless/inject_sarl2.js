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
  // 一次 eval：读观测（带真实树、哈希【整载荷】）+ 写决策（上一帧策略给的 nodeId）
  window.__b.step = function (nodeId) {
    var gc = GameManager.getGameController();
    var ad = VantageSandbox.createAdapter(gc, 'tank_a');
    var e = VantageObserve.encode({ adapter: ad, tree: VantageTree.getTree(), horizonSec: 10, K_death: 1, frameDt: 1 / 60 });
    var h = 2166136261 >>> 0;
    function mix(arr) { for (var i = 0; i < arr.length; i++) { h ^= (arr[i] | 0); h = (h * 16777619) >>> 0; } }
    try { mix(e.global.globalTok); mix(e.global.oppTok || []); } catch (err) { }
    try { var nd = e.node.nodeTok || []; mix(nd); } catch (err) { }
    try { var bl = e.bullet.bulletTok || []; mix(bl); } catch (err) { }
    var d = (typeof ad.getDeathsCount === 'function') ? ad.getDeathsCount() : 0;
    window.__b.bundleA = { picks: [{ nodeId: nodeId, back: 0 }], memory: {} };
    window.__b.bundleB = window.__b.bundleA;
    window.__b.n++;
    var gArr = (e.global && Array.isArray(e.global.globalTok)) ? e.global.globalTok : null;
    var nSrc = (e.nodes && Array.isArray(e.nodes.tokens)) ? e.nodes.tokens : null;   // ⭐ 单复数已核：e.nodes.tokens（实跑 len=253）
    if (!gArr || !nSrc) return JSON.stringify({ h: h >>> 0, err: 'token 段字段名不符(拒绝静默传 null)', topKeys: Object.keys(e), gKeys: e.global ? Object.keys(e.global) : null, nKeys: e.node ? Object.keys(e.node) : null });
    var n = nSrc.slice(0, 64);   // ⭐ nSrc 是 (nRows,10) 二维：一行 = 一个节点、10 个数 = NODE_FIELDS；⛔ 别再按"一维/12"切
    return JSON.stringify({ h: h >>> 0, alive: d === 0, dots: e.dims.total, g: gArr, n: n });
  };
  window.__probe = window.__b;
  return 'installed';
})()
