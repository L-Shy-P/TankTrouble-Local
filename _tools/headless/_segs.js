/**
 * 观测 → segs 共享模块（`2026-10-17`，父代理指派）
 * ==========================================================================
 * 目的：把「观测 ⟹ segs（段清单 + 每段 rows×width + 补零规则）」**只写一份**，
 *       评测（`_tools/eval/run_scenes_30.js`）与采集/面板都从这import，
 *       避免第三次出现"一边改了另一边没改 ⟹ 评分作废"。
 *
 * ⚠️ 现状（务必看台账）：
 *   · 评测侧已接入本模块（`run_scenes_30.js` require 本文件）；
 *   · **采集侧（`_collect_tmp.js`）与页面桥（`inject_fire.js` / `vantage_agent_panel.js`）还没接入** ——
 *     那两处仍各有一份造包逻辑（本轮边界不让动），⟹ 由 `_tools/eval/preflight_parity.js` 的
 *     "采集路径参照实现"逐位对拍兜底。
 *
 * 口径（与服务端 `policy_server_graph.py` 的 mk() 槽位一致）：
 *   node   : (N, 10)   行数=N（真实节点数，不补零）
 *   opp    : (8, 15)   按 oppTok 每 15 维切行，不足补零；>8 个对手显式计数（⛔ 不静默丢）
 *   bullet : (64, 7)   M 行真实子弹 + 补零到 64；**M=0 时发一行零**（⛔ 不能发 []）
 *   item   : (8, 6)    每行 = 该索引道具 3 维 + 地雷 3 维（同 `_collect_tmp.js:13-24`）
 *   global : (1, 38)
 *   mem    : (4, 256)  仅当传入时附带（`mem_on=0` 不发，服务端恒零）
 */
'use strict';

const SPEC = {
  node:   { width: 10, slots: null },   // slots=null ⟹ 行数=真实行数
  opp:    { width: 15, slots: 8 },
  bullet: { width: 7,  slots: 64 },
  item:   { width: 6,  slots: 8 },
  global: { width: 38, slots: 1 },
  mem:    { width: 256, slots: 4 }
};
const SEG_ORDER = ['node', 'opp', 'bullet', 'item', 'global'];

function isNum(v) { return typeof v === 'number' && isFinite(v); }

/**
 * 任意形状 → 行×宽 的数字矩阵：
 *   · "a,b,c" 或 "a,b;c,d" 字符串（注入端实测会给逗号字符串）
 *   · 行数组 / 扁平数字数组
 *   · 非有限数字一律按 0 处理（与服务端 `+v || 0` 同口径）
 */
function toRows(x, w) {
  const rows = [];
  if (x === null || x === undefined) return rows;
  if (typeof x === 'string') {
    const parts = x.indexOf(';') >= 0 ? x.split(';') : [x];
    for (const s of parts) {
      if (!s) continue;
      rows.push(s.split(',').map((t) => (isNum(+t) ? +t : 0)));
    }
    return rows;
  }
  if (typeof x.length !== 'number' || !x.length) return rows;
  if (typeof x[0] === 'string') {
    for (const s of x) rows.push(String(s).split(',').map((t) => (isNum(+t) ? +t : 0)));
    return rows;
  }
  if (Array.isArray(x[0])) {
    for (const r of x) rows.push(Array.prototype.map.call(r, (t) => (isNum(+(t)) ? +(t) : 0)));
    return rows;
  }
  for (let i = 0; i + w <= x.length; i += w) rows.push(Array.prototype.slice.call(x, i, i + w).map((t) => (isNum(+t) ? +t : 0)));
  if (!rows.length) rows.push(Array.prototype.map.call(x, (t) => (isNum(+t) ? +t : 0)));
  return rows;
}

function zeroRow(w) { return new Array(w).fill(0); }

/** 行数裁剪/补零到 slots（slots=null ⟹ 不补）；`atLeastOne` ⟹ 空时给一行零 */
function padRows(rows, slots, w, atLeastOne) {
  const out = [];
  for (const r of (rows || [])) {
    if (slots !== null && out.length >= slots) break;
    const o = [];
    for (let j = 0; j < w; j++) o.push(isNum(r && r[j]) ? r[j] : 0);
    out.push(o);
  }
  if (!out.length && atLeastOne) out.push(zeroRow(w));
  if (slots !== null) while (out.length < slots) out.push(zeroRow(w));
  return out;
}

/** item 段：8 行 × (道具 3 维 + 地雷 3 维) */
function buildItemRows(itemIn, colIn, mineIn) {
  if (Array.isArray(itemIn) && itemIn.length && Array.isArray(itemIn[0])) return padRows(toRows(itemIn, 6), SPEC.item.slots, SPEC.item.width, false);
  const col = toRows(colIn, 3), mine = toRows(mineIn, 3);
  const out = [];
  for (let k = 0; k < SPEC.item.slots; k++) {
    const c = col[k] || [], m = mine[k] || [];
    out.push([c[0] || 0, c[1] || 0, c[2] || 0, m[0] || 0, m[1] || 0, m[2] || 0]);
  }
  return out;
}

/**
 * @param {object} obs 观测（两种形态都吃）：
 *   { n|node, opp(扁平 oppTok 或 [扁平]), b|bullet, item 或 col/mine, g|global, mem?, oppOver? }
 * @returns {{segs:object, stats:object}}
 */
function buildSegs(obs) {
  obs = obs || {};
  const nRows = toRows(obs.n !== undefined ? obs.n : obs.node, SPEC.node.width);
  let oppSrc = obs.opp;
  if (Array.isArray(oppSrc) && oppSrc.length === 1 && Array.isArray(oppSrc[0])) oppSrc = oppSrc[0];   // 页面给 [oppTok]
  const oppFlat = Array.isArray(oppSrc) ? oppSrc : [];
  const oppBlocks = Math.floor(oppFlat.length / SPEC.opp.width);
  const oppRows = [];
  for (let k = 0; k < oppBlocks; k++) oppRows.push(oppFlat.slice(k * SPEC.opp.width, (k + 1) * SPEC.opp.width));
  const oppSeg = padRows(oppRows, SPEC.opp.slots, SPEC.opp.width, false);
  const bulletRaw = toRows(obs.b !== undefined ? obs.b : obs.bullet, SPEC.bullet.width);
  const bulletSeg = padRows(bulletRaw, SPEC.bullet.slots, SPEC.bullet.width, true);   // ⭐ 空 ⟹ 一行零
  const itemSeg = buildItemRows(obs.item, obs.col, obs.mine);
  const gIn = obs.g !== undefined ? obs.g : obs.global;
  const gRows = toRows(gIn, SPEC.global.width);
  const gRow = [];
  for (let j = 0; j < SPEC.global.width; j++) gRow.push(isNum(gRows[0] && gRows[0][j]) ? gRows[0][j] : 0);
  const segs = { node: nRows, opp: oppSeg, bullet: bulletSeg, item: itemSeg, global: [gRow] };
  let memRows = null;
  if (obs.mem) { memRows = padRows(toRows(obs.mem, SPEC.mem.width), SPEC.mem.slots, SPEC.mem.width, false); segs.mem = memRows; }
  return {
    segs: segs,
    stats: {
      N: nRows.length, oppBlocks: oppBlocks, oppOver: oppBlocks > SPEC.opp.slots ? oppBlocks - SPEC.opp.slots : 0,
      bulletReal: bulletRaw.length, bulletSent: bulletSeg.length, memSent: memRows ? memRows.length : 0,
      keys: Object.keys(segs)
    }
  };
}

/** 段清单/行数/宽度校验（⛔ 只报，不改） */
function validateSegs(segs) {
  const errors = [];
  if (!segs || typeof segs !== 'object') return { ok: false, errors: ['segs 不是对象'] };
  const keys = Object.keys(segs);
  for (const k of keys) if (!SPEC[k]) errors.push('未知段: ' + k);
  for (const k of SEG_ORDER) if (!segs[k]) errors.push('缺段: ' + k);
  for (const k of keys) {
    if (!SPEC[k] || !segs[k]) continue;
    const rows = segs[k], w = SPEC[k].width;
    if (!Array.isArray(rows)) { errors.push(k + ' 不是数组'); continue; }
    if (SPEC[k].slots !== null && rows.length !== SPEC[k].slots) errors.push(k + ' 行数=' + rows.length + '，期望 ' + SPEC[k].slots);
    for (let i = 0; i < rows.length; i++) {
      if (!Array.isArray(rows[i]) || rows[i].length !== w) { errors.push(k + '[' + i + '] 宽度=' + (Array.isArray(rows[i]) ? rows[i].length : '非数组') + '，期望 ' + w); break; }
      for (let j = 0; j < rows[i].length; j++) if (!isNum(rows[i][j])) { errors.push(k + '[' + i + '][' + j + '] 非有限数字'); break; }
    }
  }
  return { ok: errors.length === 0, errors: errors };
}

/** 逐位比较两套 segs（段清单 / 行数 / 宽度 / 每个元素 ⟹ "补零位置"也一致） */
function diffSegs(a, b, opts) {
  const eps = (opts && opts.eps) || 1e-6;
  const diffs = [];
  const ka = Object.keys(a || {}).sort(), kb = Object.keys(b || {}).sort();
  if (JSON.stringify(ka) !== JSON.stringify(kb)) diffs.push('段清单不同: ' + JSON.stringify(ka) + ' vs ' + JSON.stringify(kb));
  for (const k of ka) {
    if (!b || !b[k]) continue;
    const ra = a[k], rb = b[k];
    if (!Array.isArray(ra) || !Array.isArray(rb)) { diffs.push(k + ' 不是数组'); continue; }
    if (ra.length !== rb.length) { diffs.push(k + ' 行数 ' + ra.length + ' vs ' + rb.length); continue; }
    for (let i = 0; i < ra.length; i++) {
      if (!Array.isArray(ra[i]) || !Array.isArray(rb[i])) { diffs.push(k + '[' + i + '] 非行数组'); continue; }
      if (ra[i].length !== rb[i].length) { diffs.push(k + '[' + i + '] 宽度 ' + ra[i].length + ' vs ' + rb[i].length); continue; }
      for (let j = 0; j < ra[i].length; j++) {
        const x = ra[i][j], y = rb[i][j];
        if (!isNum(x) || !isNum(y) || Math.abs(x - y) > eps) {
          diffs.push(k + '[' + i + '][' + j + '] ' + x + ' vs ' + y);
          if (diffs.length > 12) return diffs;
        }
      }
    }
  }
  return diffs;
}

module.exports = { SPEC, SEG_ORDER, buildSegs, validateSegs, diffSegs, toRows, padRows };
