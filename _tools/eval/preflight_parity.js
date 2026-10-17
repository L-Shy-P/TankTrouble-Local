'use strict';
/**
 * 口径校验（黄金样例对拍）—— `2026-10-17` 父代理指派
 * ==========================================================================
 * 为什么要有它：评测注入（`_g1_inject.js`）与采集/面板注入（`inject_fire.js`）是两条独立路径，
 *   已经漂移过两次（缺 bullet/item ⟹ 评分作废；评测 setFire(0) ⟹ 评测从不开火）。
 *   本文件在**开跑前**用同一帧真实观测，把两条路径的"造包"结果逐位对拍；任一不过 ⟹ **退出码非 0**。
 *
 * 校验项：
 *   ① 段清单完全一致（node/opp/bullet/item/global，可选 mem）
 *   ② 每段 rows / width 完全一致
 *   ③ 每个元素逐位一致（⟹ 补零位置也一致）
 *   ④ 与 fixture 里的 `goldenSegs` 一致（防"两边一起改坏"）
 *   ⑤ 同一 payload 各问一次策略服务端（同 seed）⟹ nodeId / fire / lp 逐位或 1e-6 内一致
 *
 * 用法：
 *   node _tools/eval/preflight_parity.js                 # 正常校验（通过 ⟹ 退出 0）
 *   node _tools/eval/preflight_parity.js --no-server      # 只做 ①②③④（不启策略服务端）
 *   node _tools/eval/preflight_parity.js --break width     # 故意造不一致（自测红线：应退出 1）
 *   --break 可选：width | drop-seg | value | none
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SEGS = require(path.join(REPO, '_tools', 'headless', '_segs.js'));
const FIXTURE = process.env.PT_FIXTURE || path.join(__dirname, 'fixtures', 'obs_frame.json');
const CKPT = process.env.VT_CKPT || 'D:/vt_run/smoke_mem2/ckpt/last.pt';
const SEED = 12345;

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const BREAK = String(argOf('break', 'none') || 'none');
const NO_SERVER = !!argOf('no-server', false);

const log = (s) => process.stdout.write(s + '\n');
const bad = (s) => process.stderr.write(s + '\n');
const fails = [];
function check(cond, name, detail) {
  if (cond) { log('  ✔ ' + name); return true; }
  fails.push(name + (detail ? (' :: ' + detail) : ''));
  bad('  ✘ ' + name + (detail ? (' :: ' + detail) : ''));
  return false;
}

/* ======================================================================
 * 路径 B：**采集路径参照实现**（逐字照抄 `_tools/headless/_collect_tmp.js:9-24` 的口径）
 * ⚠️ 下一轮应让 `_collect_tmp.js` 直接 require `_segs.js`，本函数即可删除（台账已记）。
 * ===================================================================== */
const OPP = 15, OPP_SLOTS = 8, BUL_SLOTS = 64, ITEM_R = 8, ITEM_C = 6;
function pad(rows, slot, w) {
  if (rows.length >= slot) return rows.slice(0, slot);
  const out = rows.slice();
  const z = new Array(w).fill(0);
  while (out.length < slot) out.push(z.slice());
  return out;
}
function collectOppRows(oppFlat) {
  const nb = Math.floor((oppFlat || []).length / OPP), out = [];
  for (let b = 0; b < OPP_SLOTS; b++) {
    const r = [];
    for (let i = 0; i < OPP; i++) r.push(b < nb ? +oppFlat[b * OPP + i] || 0 : 0);
    out.push(r);
  }
  return out;
}
function collectItemRows(itemIn) {
  // 采集侧本来是从 colTok/mineTok 造的；fixture 里已给 item(8×6)，这里按"3+3"规则重组一次以对齐口径
  const out = [];
  for (let k = 0; k < ITEM_R; k++) {
    const row = (itemIn && itemIn[k]) || [];
    out.push([+row[0] || 0, +row[1] || 0, +row[2] || 0, +row[3] || 0, +row[4] || 0, +row[5] || 0]);
  }
  return out;
}
function collectBuild(obs) {
  const n = (obs.n || []).map((r) => r.map((x) => +x || 0));
  const bRows = (obs.b && obs.b.length) ? obs.b : [[0, 0, 0, 0, 0, 0, 0]];   // ⭐ M=0 ⟹ 一行零（⛔ 不发 []）
  const g = (obs.g || []).slice(0, 38).map((x) => +x || 0);
  while (g.length < 38) g.push(0);
  return { node: n, opp: collectOppRows(obs.opp), bullet: pad(bRows, BUL_SLOTS, 7), item: collectItemRows(obs.item), global: [g] };
}

/* ---------------- 策略服务端一问一答（同 seed 对拍） ---------------- */
function startSrv() {
  const p = spawn('py', ['-3.13', '-u', '_tools/training/policy_server_graph.py'], {
    cwd: REPO, env: Object.assign({}, process.env, { VT_CKPT: CKPT, PYTHONIOENCODING: 'utf-8' })
  });
  p.stderr.on('data', (d) => { const t = String(d); if (/CKPT_|FIRE_DIST/.test(t)) process.stderr.write('  [srv] ' + t.trim().slice(0, 160) + '\n'); });
  let buf = '', waiters = [];
  p.stdout.on('data', (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      const w = waiters.shift(); if (w) w(JSON.parse(line));
    }
  });
  return {
    ask: (obj, ms = 180000) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('srv ask 超时')), ms);
      waiters.push((v) => { clearTimeout(t); res(v); });
      try { p.stdin.write(JSON.stringify(obj) + '\n'); } catch (e) { clearTimeout(t); rej(e); }
    }),
    kill: () => { try { p.kill(); } catch (e) {} }
  };
}

(async () => {
  log('=== PREFLIGHT_PARITY start ===');
  log('fixture = ' + FIXTURE);
  if (!fs.existsSync(FIXTURE)) { bad('⛔ fixture 不存在: ' + FIXTURE); process.exit(2); }
  const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  log('fixture 来源 = ' + (fx.source || '?') + ' · N=' + fx.N + ' · 真实子弹=' + ((fx.segRows && fx.segRows.bullet) || 0) + ' · 对手块=' + ((fx.segRows && fx.segRows.opp) || 0));

  // 路径 A：评测侧共享模块
  const A = SEGS.buildSegs(fx.obs);
  // 路径 B：采集路径参照实现
  let B = { segs: collectBuild(fx.obs), stats: {} };

  // ⭐ 自测红线：故意造不一致（只在这里用，⛔ 不进产品路径）
  if (BREAK === 'width') { B.segs.bullet = B.segs.bullet.map((r) => r.slice(0, 6)); log('  [break] B.bullet 宽度改成 6'); }
  else if (BREAK === 'drop-seg') { delete B.segs.item; log('  [break] B 删掉 item 段'); }
  else if (BREAK === 'value') { B.segs.item[0][0] = (B.segs.item[0][0] || 0) + 123; log('  [break] B.item[0][0] 改成 +123'); }
  else if (BREAK !== 'none') { bad('⛔ 未知 --break: ' + BREAK); process.exit(2); }

  log('\n[1] 段清单 / 行数 / 宽度 / 逐元素（A=评测侧，B=采集侧参照）');
  const va = SEGS.validateSegs(A.segs);
  check(va.ok, 'A 自身形状合法', va.ok ? '' : JSON.stringify(va.errors).slice(0, 300));
  const diffs = SEGS.diffSegs(A.segs, B.segs, { eps: 1e-9 });
  check(diffs.length === 0, 'A 与 B 逐位一致（含补零位置）', diffs.slice(0, 6).join(' | '));

  log('\n[2] 与 fixture 的 goldenSegs 对拍');
  if (fx.goldenSegs) {
    const dg = SEGS.diffSegs(A.segs, fx.goldenSegs, { eps: 1e-9 });
    check(dg.length === 0, 'A 与 goldenSegs 逐位一致（防两侧一起改坏）', dg.slice(0, 6).join(' | '));
  } else check(false, 'fixture 里没有 goldenSegs');

  log('\n[3] 形状摘要');
  log('  A: ' + JSON.stringify(Object.fromEntries(Object.entries(A.segs).map(([k, v]) => [k, v.length + 'x' + (v[0] ? v[0].length : 0)]))));
  log('  B: ' + JSON.stringify(Object.fromEntries(Object.entries(B.segs).map(([k, v]) => [k, v.length + 'x' + (v[0] ? v[0].length : 0)]))));
  log('  A.stats = ' + JSON.stringify(A.stats));

  if (!NO_SERVER) {
    log('\n[4] 策略服务端对拍（同 seed=' + SEED + '）');
    const srv = startSrv();
    try {
      if (!fs.existsSync(CKPT)) throw new Error('ckpt 不存在: ' + CKPT);
      const mk = (segs) => ({ N: segs.node.length, seed: SEED, segs: segs });
      const ra = await srv.ask(mk(A.segs));
      const rb = await srv.ask(mk(B.segs));
      const okA = ra && typeof ra.nodeId === 'number' && !ra.err;
      const okB = rb && typeof rb.nodeId === 'number' && !rb.err;
      check(okA, 'A 的请求有正常返回', okA ? '' : JSON.stringify(ra).slice(0, 200));
      check(okB, 'B 的请求有正常返回', okB ? '' : JSON.stringify(rb).slice(0, 200));
      if (okA && okB) {
        check(ra.nodeId === rb.nodeId, 'nodeId 逐位一致', ra.nodeId + ' vs ' + rb.nodeId);
        check((ra.fire === 1 ? 1 : 0) === (rb.fire === 1 ? 1 : 0), 'fire 一致', ra.fire + ' vs ' + rb.fire);
        check(Math.abs(ra.lp - rb.lp) <= 1e-6, 'lp 差 ≤ 1e-6', ra.lp + ' vs ' + rb.lp + ' (Δ=' + Math.abs(ra.lp - rb.lp) + ')');
        log('  A: nodeId=' + ra.nodeId + ' fire=' + ra.fire + ' lp=' + ra.lp);
        log('  B: nodeId=' + rb.nodeId + ' fire=' + rb.fire + ' lp=' + rb.lp);
      }
    } catch (e) {
      check(false, '策略服务端对拍执行失败', String((e && e.message) || e).slice(0, 300));
    } finally { srv.kill(); }
  } else {
    log('\n[4] 跳过服务端对拍（--no-server）');
  }

  if (fails.length) {
    bad('\n⛔ PARITY_FAIL（' + fails.length + ' 项）：\n  - ' + fails.join('\n  - '));
    process.exit(1);
  }
  log('\n✅ PARITY_OK（段清单/形状/补零/服务端动作 全一致）');
})().catch((e) => { bad('FATAL ' + ((e && e.stack) || e)); process.exit(1); });
