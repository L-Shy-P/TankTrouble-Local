'use strict';
/**
 * 「不呈现」开关 —— 页面侧实现（driver 侧入口见 match.js: Match.setNoRender / open({noRender:true})）
 *
 * 目标：**只关绘制**，不碰物理/逻辑。
 *   · canvas 隐藏（style.display='none'）+ 设成 1×1（去掉合成/framebuffer 开销）
 *   · mode='full' 时再把 renderer.render / renderer.postRender 置空（跳过整棵显示树遍历与绘制）
 *   · 全部【运行时替换】、可还原（restore 后逐字恢复原函数与 canvas 尺寸）
 *   · 任何一步失败 → err 字段带诊断信息返回，**不静默降级**（跨进程入口 match.js 会抛错）
 *
 * 只读自检：__vtNoRenderInfo() 返回 canvas 尺寸/display、render 是否已被置空。
 * 调用点审计：__vtRenderAuditStart/Stop() 把 render 包一层「计数 + 原函数照调」，用来证明
 *   "render 恰好每帧调用一次、且只在渲染相位"（即"置空它只可能少画、不可能改逻辑"）。
 */
const PAGE_SRC = `(function () {
  if (window.__vtSetNoRender) return 'already';
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function game() { return (window.GameManager && window.GameManager.getGame) ? window.GameManager.getGame() : null; }
  var st = { on: false, mode: null, orig: null, audit: null };
  window.__vtNoRenderState = st;

  window.__vtNoRenderInfo = function () {
    var out = { on: st.on, mode: st.mode, err: null, canvas: null, renderer: null, renderType: null };
    try {
      var g = game();
      if (!g) { out.err = 'GameManager.getGame() 返回空'; return out; }
      var r = g.renderer;
      out.renderType = g.renderType;
      out.renderer = r ? {
        type: r.type, renderIsOwn: hasOwn(r, 'render'),
        renderSrc: String(r.render).slice(0, 48),
        renderNoop: String(r.render).indexOf('__vt_noop') >= 0,
        postRenderNoop: String(r.postRender).indexOf('__vt_noop') >= 0
      } : { err: 'g.renderer 为空' };
      out.canvas = g.canvas ? {
        w: g.canvas.width, h: g.canvas.height,
        display: (g.canvas.style ? g.canvas.style.display : null)
      } : null;
    } catch (e) { out.err = String((e && e.stack) || e); }
    return out;
  };

  function __vt_noop() {}
  function rawRevert(g) {
    var r = g.renderer, o = st.orig;
    if (!o) return;
    if (o.renderOwn) r.render = o.render; else delete r.render;
    if (o.postOwn) r.postRender = o.postRender; else delete r.postRender;
    if (o.canvas) {
      if (o.canvas.style) o.canvas.style.display = o.display;
      o.canvas.width = o.w; o.canvas.height = o.h;
    }
    st.on = false; st.mode = null; st.orig = null;
    // ⚠️ 不调 g.scale.refresh()：实测它会让 Phaser 在后续帧里把 canvas 重新写回 940×705，
    //    把「1×1」偷偷改回去（静默失效）。这里只逐字还原 canvas 属性，ScaleManager 的内部账本从未被我们改过。
  }

  window.__vtSetNoRender = function (on, mode) {
    on = !!on; mode = mode || 'full';
    var out = { ok: false, on: on, mode: mode, changed: false, note: null, err: null, info: null };
    try {
      var g = game();
      if (!g) { out.err = 'GameManager.getGame() 返回空 ⟹ 拒绝（不静默降级）'; return out; }
      var r = g.renderer;
      if (!r || typeof r.render !== 'function') { out.err = 'renderer.render 不是函数 ⟹ 拒绝（不静默降级）'; return out; }
      if (on) {
        if (st.on && st.mode === mode) { out.note = 'already'; out.ok = true; out.info = window.__vtNoRenderInfo(); return out; }
        if (st.on) rawRevert(g);                       // 换档：先还原再加
        var c = g.canvas;
        st.orig = {
          render: r.render, renderOwn: hasOwn(r, 'render'),
          postRender: r.postRender, postOwn: hasOwn(r, 'postRender'),
          canvas: c || null, w: c ? c.width : null, h: c ? c.height : null,
          display: (c && c.style) ? c.style.display : null
        };
        if (c && mode !== 'noop') { if (c.style) c.style.display = 'none'; c.width = 1; c.height = 1; }
        if (mode === 'full' || mode === 'noop') { r.render = __vt_noop; r.postRender = __vt_noop; }
        else if (mode !== 'canvas') { out.err = '未知 mode=' + mode + '（只认 full/canvas/noop）'; return out; }
        st.on = true; st.mode = mode; out.changed = true;
      } else {
        if (!st.on) { out.note = 'already-off'; out.ok = true; out.info = window.__vtNoRenderInfo(); return out; }
        rawRevert(g);
        out.changed = true;
      }
      out.ok = true; out.info = window.__vtNoRenderInfo();
    } catch (e) { out.err = String((e && e.stack) || e); }
    return out;
  };

  window.__vtRenderAuditStart = function () {
    var g = game(); var r = g && g.renderer;
    if (!r || typeof r.render !== 'function') return { err: 'renderer.render 不是函数' };
    st.audit = { calls: [], orig: r.render, own: hasOwn(r, 'render') };
    r.render = function () {
      st.audit.calls.push({ steps: (window.__vt ? window.__vt.steps : null), upd: g.updatesThisFrame, t: (window.__vt ? window.__vt.t : null) });
      return st.audit.orig.apply(this, arguments);
    };
    return { ok: true };
  };
  window.__vtRenderAuditStop = function () {
    if (!st.audit) return { err: 'audit 未开始' };
    var g = game(); var r = g && g.renderer;
    if (st.audit.own) r.render = st.audit.orig; else delete r.render;
    var calls = st.audit.calls; st.audit = null;
    return { n: calls.length, calls: calls };
  };

  // 帧级配对：隔一次调用真渲染一次（不动 canvas），把"渲染真跑"与"渲染跳过"放在相邻帧比较
  window.__vtRenderAltStart = function () {
    var g = game(); var r = g && g.renderer;
    if (!r || typeof r.render !== 'function') return { err: 'renderer.render 不是函数' };
    if (st.alt) return { err: 'alt 已在跑' };
    st.alt = { orig: r.render, own: hasOwn(r, 'render'), n: 0, log: [] };
    r.render = function () {
      st.alt.n++;
      var real = (st.alt.n % 2) === 1;
      st.alt.log.push({ n: st.alt.n, real: real, steps: (window.__vt ? window.__vt.steps : null) });
      if (real) return st.alt.orig.apply(this, arguments);
    };
    return { ok: true };
  };
  window.__vtRenderAltStop = function () {
    if (!st.alt) return { err: 'alt 未开始' };
    var g = game(); var r = g && g.renderer;
    if (st.alt.own) r.render = st.alt.orig; else delete r.render;
    var out = { n: st.alt.n, real: 0, log: st.alt.log }; st.alt = null;
    for (var i = 0; i < out.log.length; i++) if (out.log[i].real) out.real++;
    return out;
  };

  return 'installed';
})()`;

module.exports = { PAGE_SRC };
