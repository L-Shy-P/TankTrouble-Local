#!/usr/bin/env node
// v102 regression: panel red-mark semantics (only dangerous values), the
// killfield weight slider range (0~400%, default 100%) and the empty-field
// switch wiring. Runs the REAL vantage_testbench.js against a minimal fake DOM.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const jsDir = path.join(root, 'js');

// ---------------- minimal fake DOM ----------------
function makeClassList(el) {
  const set = new Set();
  return {
    add: c => set.add(c),
    remove: c => set.delete(c),
    contains: c => set.has(c),
    _set: set
  };
}
let elementSeq = 0;
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    parentNode: null,
    style: { cssText: '', setProperty: function () {} },
    dataset: {},
    id: '',
    value: '',
    checked: false,
    textContent: '',
    _handlers: {},
    _seq: ++elementSeq,
    set innerHTML(v) {
      const self = this;
      self._html = String(v);
      // 迷你解析：只为每个 data-act / id 造一个占位子元素，让 querySelector 能找到。
      self.children.length = 0;
      const html = self._html;
      const acts = html.match(/data-act="[^"]+"/g) || [];
      const ids = html.match(/id="[^"]+"/g) || [];
      const seen = new Set();
      acts.forEach(function (a) {
        const name = a.slice(10, -1);   // 剥掉 'data-act="' 和结尾的 '"'
        if (seen.has('act:' + name)) return;
        seen.add('act:' + name);
        // 取包含该 data-act 的那个标签，按浏览器行为把 min/max/step/value/type
        // 复制到占位元素上，这样测试读到的就是真实属性。
        const at = html.indexOf(a);
        const lt = html.lastIndexOf('<', at);
        const gt = html.indexOf('>', at);
        const tag = (lt >= 0 && gt > lt) ? html.slice(lt, gt) : '';
        if (name === 'exp-killfieldWeight') {
        }
        const typeMatch = tag.match(/type="([^"]+)"/);
        const c = makeEl(typeMatch ? typeMatch[1] : 'div');
        c.dataset.act = name;
        ['min', 'max', 'step', 'value', 'id'].forEach(function (attr) {
          const m = tag.match(new RegExp(attr + '="([^"]*)"'));
          if (m) c[attr] = m[1];
        });
        c.checked = /checked/.test(tag);
        c.parentNode = self;
        self.children.push(c);
      });
      ids.forEach(function (a) {
        const name = a.slice(4, -1);
        if (seen.has('id:' + name)) return;
        seen.add('id:' + name);
        const c = makeEl('div');
        c.id = name;
        c.parentNode = self;
        self.children.push(c);
      });
    },
    get innerHTML() { return this._html || ''; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    insertBefore(c) { return this.appendChild(c); },
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k]; },
    removeAttribute(k) { delete this[k]; },
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 360, bottom: 400, width: 360, height: 400 }; },
    getContext() {
      if (!this._ctx2d) {
        const noop = function () {};
        this._ctx2d = new Proxy({}, {
          get: (t, k) => {
            if (k in t) return t[k];
            if (k === 'measureText') return () => ({ width: 10 });
            if (k === 'canvas') return this;
            return noop;
          },
          set: (t, k, v) => { t[k] = v; return true; }
        });
      }
      return this._ctx2d;
    },
    get width() { return this._w || 300; },
    set width(v) { this._w = v; },
    get height() { return this._h || 150; },
    set height(v) { this._h = v; },
    querySelector(sel) { return queryIn(this, sel); },
    querySelectorAll(sel) { return queryAllIn(this, sel); },
    classList: null,
    focus() {},
    blur() {}
  };
  el.classList = makeClassList(el);
  return el;
}
function walk(el, fn) {
  if (!el) return;
  fn(el);
  const kids = el.children || [];
  for (let i = 0; i < kids.length; i++) walk(kids[i], fn);
}
function parseSimple(sel) {
  // supports  [data-act="x"]  #id  and bare tags
  let m = sel.match(/^\[data-act="([^"]+)"\]$/);
  if (m) return el => el.dataset && el.dataset.act === m[1];
  m = sel.match(/^span\[id="([^"]+)"\]$/) || sel.match(/^#([\w-]+)$/);
  if (m) return el => el.id === m[1];
  m = sel.match(/^([a-zA-Z][\w-]*)$/);
  if (m) return el => el.tagName === m[1].toUpperCase();
  m = sel.match(/^\[id="([^"]+)"\]$/);
  if (m) return el => el.id === m[1];
  return () => false;
}
function makeStubEl() {
  // 面板会给一些只在真实浏览器里存在的元素挂事件（关闭按钮、跟随勾选框等）。
  // 这里返回一个“什么都不做但不会炸”的桩，保证冒烟测试能跑完整套面板代码。
  const stub = makeEl('div');
  stub.value = '0';
  stub.checked = false;
  stub.style = { cssText: '', setProperty: function () {} };
  return stub;
}
function queryIn(el, sel) {
  // 支持 "A B"（后代选择器）——面板里用了 '#vt-exp-rows [data-act=...]' 这种写法。
  const parts = String(sel).trim().split(/\s+/);
  if (parts.length > 1) {
    let scope = el;
    for (const part of parts) {
      const next = scope ? queryIn(scope, part) : null;
      if (!next) { scope = null; break; }
      scope = next;
    }
    if (scope) return scope;
  }
  const test = parseSimple(parts[parts.length - 1]);
  let found = null;
  walk(el, n => { if (!found && n !== el && test(n)) found = n; });
  // 面板会给真实浏览器里才有的子元素挂事件（select/close 按钮/跟随勾选框…）。
  // 找不到时返回“每个父元素 + 选择器”各一份的稳定桩，避免同一父元素两次
  // querySelector 拿到两个不同对象而让代码误判。
  if (!found && el && (/\[data-tv=|\[data-act=/.test(sel) || /^(select|option|canvas|input)$/.test(sel))) {
    el.__stubs = el.__stubs || {};
    if (!el.__stubs[sel]) {
      const stub = makeStubEl();
      if (sel === 'select') stub.tagName = 'SELECT';
      if (sel === 'canvas') stub.tagName = 'CANVAS';
      stub.parentNode = el;
      el.__stubs[sel] = stub;
    }
    found = el.__stubs[sel];
  }
  return found;
}
function queryAllIn(el, sel) {
  const test = parseSimple(sel);
  const out = [];
  walk(el, n => { if (n !== el && test(n)) out.push(n); });
  return out;
}

const head = makeEl('head');
const body = makeEl('body');
const byId = {};
function ensureId(id) { return byId[id] || (byId[id] = makeEl('div')); }
const documentStub = {
  head, body,
  documentElement: makeEl('html'),
  createElement: tag => makeEl(tag),
  getElementById: id => byId[id] || null,
  querySelector: sel => queryIn(body, sel),
  querySelectorAll: sel => queryAllIn(body, sel),
  addEventListener() {},
  removeEventListener() {}
};

// ---------------- fake globals the testbench touches ----------------
const listeners = {};
const windowStub = {
  innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1,
  _handlers: {},
  addEventListener: function (t, fn) {
    (this._handlers[t] = this._handlers[t] || []).push(fn);
    (listeners[t] = listeners[t] || []).push(fn);
  },
  removeEventListener() {},
  setTimeout: function (fn) { return setTimeout(fn, 0); },
  clearTimeout: function (id) { return clearTimeout(id); },
  requestAnimationFrame: function (fn) { return setTimeout(fn, 16); },
  location: { href: 'http://localhost/' },
  document: null,
  VantageTree: null,
  VantageSandbox: null,
  fire: function (t, ev) {
    (this._handlers[t] || []).forEach(function (fn) { fn(ev); });
  }
};

const killfieldCalls = [];
const noopTreeApi = {};
['setLaneEnabled','setSpringRopeEnabled','setRustMinimalEnabled','setGrowWithoutThreatsEnabled',
 'setDeathDurationRatio','setGrowLayersPerTick','setMaxNodes','setNodeCapEnabled','setHorizonCapEnabled',
 'setHorizonSec','setPruneCompensateLayers','setPruneCompensateFrames','notePruneLoss',
 'setRefineBeyondLimits','setContinuousRefine','setRetreatNodes','setRetreatFrames',
 'setWarmupMaxNodes','setTargetMixEnabled','setTargetMixRatio','setMoveTarget','clearMoveTarget',
 'getMoveTarget','reset','noteDeath','invalidateStaleNodes','pruneExpiredReserves','getBulletTracks'].forEach(function (k) {
  noopTreeApi[k] = function () { return null; };
});
const treeStub = Object.assign({}, noopTreeApi, {
  FRAME_DT: 0.02,
  getTree: () => null,
  dumpDiagnostics: () => ({}),
  setEvalFrames(v) { killfieldCalls.push(['setEvalFrames', v]); return v; },
  setKillfieldEnabled(v) { killfieldCalls.push(['setKillfieldEnabled', v]); return v; },
  setKillfieldWeight(v) { killfieldCalls.push(['setKillfieldWeight', v]); return v; },
  setEmptyFieldSafety(v) { killfieldCalls.push(['setEmptyFieldSafety', v]); return v; },
  setScoreOnlyPlanned(v) { return v; },
  setDeepSelectEnabled(v) { return v; },
  setLiveProjectilesNow() {}, setCurrentTile() {}
});
const sandboxStub = {
  OPERATIONS: Array.from({ length: 9 }, (_, i) => ({
    name: 'op' + i,
    inputs: { forward: i === 1, back: i === 2, left: i === 3, right: i === 4 }
  })),
  fusedEnabled: () => false,
  setRustPhysicsEnabled() {}
};

const loggedConsole = Object.create(console);
loggedConsole.error = function () {
  const args = Array.prototype.slice.call(arguments);
  console.error.apply(console, args);
  args.forEach(function (a) {
    if (a && a.stack) console.error('[stack]', a.stack);
  });
};
const sandbox = {
  console: loggedConsole,
  window: windowStub,
  document: documentStub,
  navigator: { userAgent: 'node' },
  performance: { now: () => Date.now() },
  Math, JSON, Object, Array, String, Number, Boolean, isFinite, parseInt, parseFloat,
  Infinity, NaN, Date, Set, Map, Promise,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: windowStub.requestAnimationFrame,
  Constants: {
    AI: {}, MAZE_TILE_SIZE: { m: 10 },
    BULLET: { RADIUS: { m: 0.25 }, OFFSET: { m: 2.5 } },
    TANK: { WIDTH: { m: 3 }, HEIGHT: { m: 4 } },
    WEAPON_TYPES: {}, SCORE_TYPES: {}, GAME_MODES: {}
  },
  VantageTree: treeStub,
  VantageSandbox: sandboxStub,
  VantageScoring: { scorePaths: () => [] },
  TankTrouble: {},
  // state.current 必须是 'Game'，这样按键才生效；getCurrentState 故意返回 null，
  // 让树图走“没有 Phaser 上下文”的降级路径，冒烟测试不必模拟整个 Phaser。
  GameManager: {
    getGame: () => ({
      state: { current: 'Game', getCurrentState: () => null }
    })
  },
  Phaser: { Math: { Between: () => 0 } },
  module: undefined
};
sandbox.global = sandbox;
sandbox.self = sandbox;
windowStub.document = documentStub;
windowStub.VantageTree = treeStub;
windowStub.VantageSandbox = sandboxStub;

const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(fs.readFileSync(path.join(jsDir, 'vantage_testbench.js'), 'utf8'), ctx, { filename: 'vantage_testbench.js' });
} catch (e) {
  console.error('[load]', e && e.stack);
  throw e;
}
const TB = sandbox.VantageTestbench || sandbox.VantageBench || windowStub.VantageTestbench;

function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); }

// The panel is built lazily; poke the public API to force it.
assert(TB && typeof TB === 'object', 'VantageTestbench global must exist, got ' + typeof TB);
const api = TB;
assert(typeof api.toggleTreeView === 'function', 'toggleTreeView API must exist');
// 走真实的按键路径打开面板（T 键）。
windowStub.fire('keydown', {
  key: 'T', code: 'KeyT', keyCode: 84,
  preventDefault: function () {}, shiftKey: false,
  target: { tagName: 'BODY' }
});

const exp = api.getState ? api.getState().exp : null;
assert(exp, 'state.exp must be readable, keys=' + (api.getState ? JSON.stringify(Object.keys(api.getState())) : 'none'));
assert(Math.abs(exp.killfieldWeight - 1.0) < 1e-9, 'killfieldWeight default must be 1.0 (=100%), got ' + exp.killfieldWeight);
assert(exp.killfieldEnabled === true, 'killfieldEnabled must default ON');
assert(exp.emptyFieldSafety === false, 'emptyFieldSafety must default OFF');

const panelEl = byId['vt-bench-panel'];
const wSlider = queryIn(body, '[data-act="exp-killfieldWeight"]') || (panelEl && queryIn(panelEl, '[data-act="exp-killfieldWeight"]'));
assert(wSlider, 'killfield weight slider must exist');
assert(String(wSlider.max) === '400', 'killfield weight slider max must be 400, got ' + wSlider.max);
assert(Number(wSlider.value) === 100, 'killfield weight slider value must be 100, got ' + wSlider.value);

// ---------------- v102: 显红只标真正危险/不建议的取值 ----------------
const st = api.getState();
function findById(id) {
  const direct = byId[id];
  if (direct) return direct;
  let found = null;
  walk(documentStub.documentElement, n => { if (!found && n && n.id === id) found = n; });
  if (!found) walk(body, n => { if (!found && n && n.id === id) found = n; });
  return found;
}
function el(act) {
  const panel = findById('vt-bench-panel');
  assert(panel, 'panel element #vt-bench-panel must be in the fake DOM');
  const e = queryIn(panel, '[data-act="' + act + '"]');
  assert(e, 'control ' + act + ' must exist');
  return e;
}
function risky(act) { return el(act).classList.contains('vt-risk'); }

// 默认（作者预设）下：不该有任何一个控件是红的。
['exp-scoreShort', 'exp-deepSelect', 'exp-nodeath', 'exp-rustMinimal', 'exp-rustPhysics',
 'exp-horizonCap', 'exp-growWithoutThreats', 'exp-targetMix', 'exp-killfield',
 'exp-continuousRefine', 'exp-refineBeyond', 'exp-growLayers', 'exp-maxNodes',
 // v102：这三项默认值（遮蔽开 / k=1 / 动作成本=0）不是危险值，不能红。
 'exp-occlusion', 'exp-safeFilterK', 'exp-actionCost'].forEach(function (act) {
  assert(!risky(act), act + ' must NOT be red at default preset');
});

// 探索参数偏离默认：不红（这正是主人纠正的点）。
st.exp.continuousRefine = true;
st.exp.refineBeyond = false;
st.exp.horizonSec = 15;
st.exp.maxNodes = 3000;
st.exp.growLayers = 6;
st.exp.pruneCompensateLayers = 5;
st.exp.retreatNodes = 32;
st.exp.killfieldWeight = 4;
st.exp.killfieldEnabled = false;
st.exp.emptyFieldSafety = true;
st.exp.targetMixRatio = 3;
api.toggleTreeView ? null : null;
// 触发面板内部状态同步 + 同步显红
// 通过公开 API 触发一次重新渲染：切换面板两下（T 键路径）
windowStub.fire('keydown', { key: 'T', code: 'KeyT', keyCode: 84, preventDefault: function () {}, shiftKey: false, target: { tagName: 'BODY' } });
windowStub.fire('keydown', { key: 'T', code: 'KeyT', keyCode: 84, preventDefault: function () {}, shiftKey: false, target: { tagName: 'BODY' } });
['exp-killfield', 'exp-continuousRefine', 'exp-refineBeyond', 'exp-growLayers',
 'exp-maxNodes', 'exp-frames'].forEach(function (act) {
  assert(!risky(act), act + ' is an exploratory knob and must NOT be red, got red');
});

// 危险取值：必须红，而且红在控件本体上。
st.exp.scoreOnlyPlanned = true;
st.exp.deepSelect = true;
st.exp.noDeath = false;
st.exp.rustMinimal = true;
st.exp.rustPhysics = false;
st.exp.horizonCap = false;
st.exp.growWithoutThreats = false;
st.exp.targetMix = false;
st.exp.evalFrames = 10;
windowStub.fire('keydown', { key: 'T', code: 'KeyT', keyCode: 84, preventDefault: function () {}, shiftKey: false, target: { tagName: 'BODY' } });
windowStub.fire('keydown', { key: 'T', code: 'KeyT', keyCode: 84, preventDefault: function () {}, shiftKey: false, target: { tagName: 'BODY' } });
['exp-scoreShort', 'exp-deepSelect', 'exp-nodeath', 'exp-rustMinimal', 'exp-rustPhysics',
 'exp-horizonCap', 'exp-growWithoutThreats', 'exp-targetMix', 'exp-frames'].forEach(function (act) {
  assert(risky(act), act + ' must be red when set to a dangerous value');
});

// v102：三项"还没接完"的开关——改成非默认值必须和别的危险开关一样显红
// （主人的要求：这些属于不建议动的默认设置，动了要红色提示、对照清楚）。
st.exp.safeFilterK = 1; st.exp.actionCost = 0; st.exp.occlusion = true;
windowStub.fire('keydown', { key: 'T', code: 'KeyT', keyCode: 84, preventDefault: function () {}, shiftKey: false, target: { tagName: 'BODY' } });
windowStub.fire('keydown', { key: 'T', code: 'KeyT', keyCode: 84, preventDefault: function () {}, shiftKey: false, target: { tagName: 'BODY' } });
assert(!risky('exp-safeFilterK'), 'k=1 (默认) 不该红');
assert(!risky('exp-actionCost'), '动作成本=0 (默认) 不该红');
assert(!risky('exp-occlusion'), '遮蔽开 (默认) 不该红');

st.exp.safeFilterK = 0.4;
windowStub.fire('keydown', { key: 'T', code: 'KeyT', keyCode: 84, preventDefault: function () {}, shiftKey: false, target: { tagName: 'BODY' } });
windowStub.fire('keydown', { key: 'T', code: 'KeyT', keyCode: 84, preventDefault: function () {}, shiftKey: false, target: { tagName: 'BODY' } });
assert(risky('exp-safeFilterK'), 'k=0.4 必须显红（会退回 JS 路径且口径混合）');
st.exp.safeFilterK = 1;
windowStub.fire('keydown', { key: 'T', code: 'KeyT', keyCode: 84, preventDefault: function () {}, shiftKey: false, target: { tagName: 'BODY' } });
windowStub.fire('keydown', { key: 'T', code: 'KeyT', keyCode: 84, preventDefault: function () {}, shiftKey: false, target: { tagName: 'BODY' } });
assert(!risky('exp-safeFilterK'), 'k 回到 1 之后必须不红');

st.exp.actionCost = 3;
windowStub.fire('keydown', { key: 'T', code: 'KeyT', keyCode: 84, preventDefault: function () {}, shiftKey: false, target: { tagName: 'BODY' } });
windowStub.fire('keydown', { key: 'T', code: 'KeyT', keyCode: 84, preventDefault: function () {}, shiftKey: false, target: { tagName: 'BODY' } });
assert(risky('exp-actionCost'), '动作成本>0 必须显红（未实现且拖慢）');
st.exp.actionCost = 0;

st.exp.occlusion = false;
windowStub.fire('keydown', { key: 'T', code: 'KeyT', keyCode: 84, preventDefault: function () {}, shiftKey: false, target: { tagName: 'BODY' } });
windowStub.fire('keydown', { key: 'T', code: 'KeyT', keyCode: 84, preventDefault: function () {}, shiftKey: false, target: { tagName: 'BODY' } });
assert(risky('exp-occlusion'), '关掉遮蔽评分必须显红（AI 不会躲 + 拖慢）');
st.exp.occlusion = true;

// 杀戮场相关：主人明确要求暂时不标红。
['exp-killfield', 'exp-emptyFieldSafety', 'exp-killfieldWeight'].forEach(function (act) {
  assert(!risky(act), act + ' must not be red (killfield family is exploratory for now)');
});

// v104：懒惰倾向滑块（只影响空场安全感知）
const lazySlider = queryIn(findById('vt-bench-panel'), '[data-act="exp-emptyFieldLaziness"]');
assert(lazySlider, 'laziness slider must exist');
assert(String(lazySlider.max) === '100', 'laziness slider max must be 100, got ' + lazySlider.max);
assert(Number(lazySlider.value) === 0, 'laziness slider default must be 0, got ' + lazySlider.value);
assert(Math.abs(st.exp.emptyFieldLaziness) < 1e-9, 'laziness state default must be 0');
assert(!risky('exp-emptyFieldLaziness'), 'laziness is an exploratory knob and must not be red');

console.log('diff_panel_risk PASS (panel builds; killfield weight 0~400% default 100%; laziness slider default 0; red = dangerous values only; v102: k/actionCost/occlusion red when off-default)');
