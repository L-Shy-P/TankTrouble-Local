'use strict';
/**
 * 配对评测比较工具（`2026-10-17` 父代理指派）
 * ==========================================================================
 * 为什么：同一份代码跑两遍 30 场，未决率能差 10pp（33.3% vs 23.3%）⟹ **单跑不能下结论**。
 *         只有【同一批 scene_id、同一 seed、只换一个变量】的配对实验才能谈差异。
 *
 * 用法：
 *   node _tools/eval/paired_compare.js A.jsonl B.jsonl [C.jsonl ...] [--min-pairs 8] [--json out.json]
 *
 * 会做：
 *   ① 配对闸门：按 scene_id 内连接；`seed/players/mapW/mapH/storm/crates_on/ckpt_md5/cap` 必须一致，
 *      不一致整行剔除并计数；保留 < --min-pairs（默认 8）⟹ 打印 `⛔ 样本不足，不出结论` 并 **退出 1**。
 *   ② 配对统计：每个指标给 discordant 三分类（A独赢/B独赢/同）+ **McNemar 精确检验 p**（小样本用精确法）
 *      + 差值**中位数与 IQR**（不用均值±std）。
 *   ③ 一句话结论：p<0.05 ⟹ "有统计显著差异（方向：X 更好）"；否则 ⟹ "无显著差异，不能下结论"。
 *
 * ⛔ 不做什么：不能消除"场景只有 30 个 / 每档只有 10 个"这个样本量上限；不能替你做随机化；
 *             配对只控制"场景差异"，**不控制同一场景内的 RNG 波动**（真要控就得多重复取中位）。
 */
'use strict';

const fs = require('fs');

const argv = process.argv.slice(2);
const files = [];
let minPairs = 8, jsonOut = null, ignoreFields = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--min-pairs') { minPairs = Number(argv[++i]); continue; }
  if (a === '--json') { jsonOut = argv[++i]; continue; }
  if (a === '--ignore') { ignoreFields = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean); continue; }
  if (a.startsWith('--')) { console.error('⛔ 未知参数 ' + a); process.exit(2); }
  files.push(a);
}
if (files.length < 2) { console.error('用法: node paired_compare.js A.jsonl B.jsonl [C.jsonl ...] [--min-pairs 8] [--json out.json]'); process.exit(2); }

function load(p) {
  const rows = [];
  for (const ln of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    rows.push(JSON.parse(ln));
  }
  return rows;
}
const isNum = (v) => typeof v === 'number' && isFinite(v);
const isUnk = (r) => r.win !== 1 && r.win !== 0;

/* ---------- McNemar 精确检验（双侧） ---------- */
function logC(n, k) { let s = 0; for (let i = 0; i < k; i++) s += Math.log(n - i) - Math.log(i + 1); return s; }
function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const m = Math.min(b, c);
  let tail = 0;
  for (let k = 0; k <= m; k++) tail += Math.exp(logC(n, k) + n * Math.log(0.5));
  return Math.min(1, 2 * tail);
}

/* ---------- 分位数（线性插值，与 numpy 默认一致） ---------- */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function medianIQR(diffs) {
  if (!diffs.length) return { n: 0, median: null, q1: null, q3: null, iqr: null };
  const s = diffs.slice().sort((a, b) => a - b);
  const med = quantile(s, 0.5), q1 = quantile(s, 0.25), q3 = quantile(s, 0.75);
  return { n: diffs.length, median: med, q1: q1, q3: q3, iqr: q3 - q1 };
}
const f1 = (v) => (v === null || v === undefined) ? '–' : (Math.round(v * 10) / 10).toString();

/* ---------- 一致性字段：必须两边相同才能配对 ---------- */
const CONSIST_KEYS = ['seed', 'players', 'mapW', 'mapH', 'storm', 'crates_on', 'ckpt_md5', 'cap'].filter((k) => ignoreFields.indexOf(k) < 0);

function pairUp(A, B) {
  const idxB = new Map(B.map((r) => [r.scene_id, r]));
  const pairs = [], dropped = {}, missing = [];
  const droppedDetail = [];
  for (const a of A) {
    const b = idxB.get(a.scene_id);
    if (!b) { missing.push(a.scene_id); continue; }
    let bad = null;
    for (const k of CONSIST_KEYS) {
      if (!(k in a) || !(k in b)) continue;
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) { bad = k; break; }
    }
    if (bad) { dropped[bad] = (dropped[bad] || 0) + 1; droppedDetail.push({ scene_id: a.scene_id, field: bad, A: a[bad], B: b[bad] }); continue; }
    pairs.push({ id: a.scene_id, A: a, B: b });
  }
  return { pairs, dropped, droppedDetail, missing };
}

/* ---------- 单个二值指标 ---------- */
function binaryMetric(pairs, name, betterFn) {
  let aOnly = 0, bOnly = 0, tie = 0;
  for (const p of pairs) {
    const a = betterFn(p.A), b = betterFn(p.B);
    if (a === null || b === null) continue;
    if (a === b) tie++; else if (a === 1) aOnly++; else bOnly++;
  }
  const p = mcnemarExact(aOnly, bOnly);
  return { name: name, type: 'binary', n: aOnly + bOnly + tie, aOnly: aOnly, bOnly: bOnly, tie: tie, p: p };
}

/* ---------- 单个数值指标 ---------- */
function numericMetric(pairs, name, getFn) {
  const diffs = [];
  let aUp = 0, bUp = 0, tie = 0;
  for (const p of pairs) {
    const x = getFn(p.A), y = getFn(p.B);
    if (!isNum(x) || !isNum(y)) continue;
    const d = x - y;
    diffs.push(d);
    if (d > 0) aUp++; else if (d < 0) bUp++; else tie++;
  }
  const st = medianIQR(diffs);
  const p = mcnemarExact(aUp, bUp);
  return { name: name, type: 'numeric', n: diffs.length, aUp: aUp, bUp: bUp, tie: tie, p: p, diff: st };
}

function decideP(p) { return p < 0.05 ? 'SIG' : 'NS'; }
function directionWord(m) {
  if (m.type === 'binary') return m.aOnly > m.bOnly ? '前者更好' : (m.bOnly > m.aOnly ? '后者更好' : '方向不明');
  return m.diff.median > 0 ? '前者数值更大' : (m.diff.median < 0 ? '后者数值更大' : '方向不明');
}

const allOut = [];
for (let i = 0; i < files.length; i++) {
  for (let j = i + 1; j < files.length; j++) {
    const A = load(files[i]), B = load(files[j]);
    const { pairs, dropped, droppedDetail, missing } = pairUp(A, B);
    const nameA = files[i].split(/[\\/]/).pop(), nameB = files[j].split(/[\\/]/).pop();
    console.log('\n================ 配对比较 ' + nameA + '  vs  ' + nameB + ' ================');
    console.log('A 行数=' + A.length + ' · B 行数=' + B.length + ' · 配对后 n=' + pairs.length +
                ' · 缺对(只一边有)=' + missing.length + ' · 因不一致剔除=' + JSON.stringify(dropped));
    if (droppedDetail.length) for (const d of droppedDetail.slice(0, 5)) console.log('   ✘ 剔除 ' + d.scene_id + '（' + d.field + ': ' + JSON.stringify(d.A) + ' vs ' + JSON.stringify(d.B) + '）');
    if (missing.length) console.log('   ℹ️ 只在一边出现的场景: ' + missing.slice(0, 5).join(', ') + (missing.length > 5 ? ' …' : ''));
    if (!('seed' in (A[0] || {}))) console.log('   ⚠️ 结果里没有 `seed` 字段（本工具无法证明同 seed；建议 runner 落 seed）');

    const rec = { A: files[i], B: files[j], n_pairs: pairs.length, dropped: dropped, missing: missing.length, metrics: [] };
    if (pairs.length < minPairs) {
      console.log('\n⛔ 样本不足，不出结论：配对后只有 n=' + pairs.length + ' < min-pairs=' + minPairs);
      allOut.push(rec);
      continue;
    }

    const metrics = [
      binaryMetric(pairs, '未决（越少越好）', (r) => (isUnk(r) ? 0 : 1)),                    // 1=已分胜负（更好）
      binaryMetric(pairs, '胜（win=1）', (r) => (r.win === 1 ? 1 : 0)),
      numericMetric(pairs, 'frames', (r) => r.frames),
      numericMetric(pairs, 'nAlive@末帧', (r) => r.nAlive_last),
      numericMetric(pairs, 'shots/fireSubmits（若有）', (r) => (isNum(r.shots) ? r.shots : (isNum(r.fireSubmits) ? r.fireSubmits : null))),
    ];
    rec.metrics = metrics;

    console.log('\n| 指标 | 配对 n | A 独优 | B 独优 | 同 | p (McNemar 精确) | 差值中位数 [IQR] | 判定 |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const m of metrics) {
      const diffTxt = m.type === 'numeric' ? (f1(m.diff.median) + ' [' + f1(m.diff.q1) + ', ' + f1(m.diff.q3) + ']') : '–';
      const verdict = (m.type === 'numeric' && m.n === 0) ? '数据缺失' : (decideP(m.p) === 'SIG' ? ('显著（' + directionWord(m) + '）') : '无显著差异');
      const aO = (m.aOnly !== undefined) ? m.aOnly : m.aUp;
      const bO = (m.bOnly !== undefined) ? m.bOnly : m.bUp;
      console.log('| ' + m.name + ' | ' + m.n + ' | ' + aO + ' | ' + bO + ' | ' + m.tie + ' | ' + (m.p === null ? '–' : (m.p < 0.0001 ? '<0.0001' : m.p.toFixed(4))) + ' | ' + diffTxt + ' | ' + verdict + ' |');
    }

    const sig = metrics.filter((m) => m.n > 0 && decideP(m.p) === 'SIG');
    console.log('\n⭐ 结论：' + (sig.length
      ? ('有统计显著差异 ⟹ ' + sig.map((m) => m.name + '（' + directionWord(m) + '）').join('；'))
      : '无显著差异，不能下结论（p≥0.05，配对 n=' + pairs.length + '）'));
    rec.conclusion = sig.length ? ('SIG: ' + sig.map((m) => m.name + ' ' + directionWord(m)).join('; ')) : 'NS';
    allOut.push(rec);
  }
}

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify(allOut, null, 2), 'utf8');
  console.log('\nWROTE ' + jsonOut);
}
const anyShort = allOut.some((r) => r.n_pairs < minPairs);
process.exitCode = anyShort ? 1 : 0;
