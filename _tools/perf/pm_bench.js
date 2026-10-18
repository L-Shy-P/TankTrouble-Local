/**
 * pm_bench.js —— 【同步一问一答】往返基准（服务端内部 / transport / payload 字节 三项拆分）
 * ==========================================================================
 * 干什么：
 *   · 用 `_tools/headless/_policy_client.js` 的 `makeAsk`（与评测/采集同一条客户端代码）
 *   · 拿一份**真实观测载荷**（pm_capture.js 抓的 json），按固定 seed 连问 N 次
 *   · 每次同时记录：往返 ms（hrtime）、`_pm.total`（服务端自报内部 ms）、payload 字节、回包字节
 *   · 输出中位数/分位；`tsv` 落盘供画/核对
 *
 * 用法：
 *   node _tools/perf/pm_bench.js --payload D:/vt_run/perf/payload_p8_N208.json --n 100 --tag before
 *   node _tools/perf/pm_bench.js --payload ... --n 100 --tag fast --env VT_FAST_TENSOR=1
 *   node _tools/perf/pm_bench.js --payload ... --n 60 --scales 64,256,512,1008   # 载荷字节 vs 延迟
 *
 * 口径（诚实三条）：
 *   1. `_pm` 只在服务端 `VT_PROBE_MS=1` 时才有；没有 `_pm` 时本脚本让该项为 null（⛔ 不拿往返冒充内部）
 *   2. transport = 往返 − 服务端内部；**含** Node 侧 JSON.stringify/parse 与管道读写、**不含**浏览器
 *   3. 固定 seed ⟹ 同载荷同结果；`fingerprint` 用来证明"优化前后语义没变"
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeAsk } = require('../headless/_policy_client.js');

const REPO = path.resolve(__dirname, '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const flag = (n) => process.argv.includes('--' + n);
const OUT = arg('out', 'D:/vt_run/perf');
const TAG = arg('tag', 'run');
const N = Math.max(1, Number(arg('n', 100)));
const WARM = Math.max(0, Number(arg('warm', 10)));
const CKPT = arg('ckpt', process.env.VT_CKPT || 'D:/vt_run/cyc_1/ckpt/model_latest.pt');
const SCALES = arg('scales', null);
const PAYLOAD_FILE = arg('payload', null);
const EXTRA_ENV = {};
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--env') { const kv = process.argv[i + 1] || ''; const j = kv.indexOf('='); if (j > 0) EXTRA_ENV[kv.slice(0, j)] = kv.slice(j + 1); }
}
const errLines = [];
function logErr(s) { errLines.push(String(s)); process.stderr.write(String(s) + '\n'); }
const median = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const pct = (a, p) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.max(0, Math.round((p / 100) * (b.length - 1))))]; };
const r2 = (x) => (x === null || x === undefined) ? null : Math.round(x * 100) / 100;

function startSrv() {
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', VT_CKPT: CKPT, VT_PROBE_MS: '1' }, EXTRA_ENV);
  const proc = spawn('py', ['-3.13', '_tools/training/policy_server_graph.py'], { cwd: REPO, env });
  proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => String(d).split('\n').forEach((l) => { if (l.trim()) logErr('SRV ' + l); }));
  // ⭐ 关键：makeAsk 会把【任何一行】当 JSON 解析、解析失败的东西也塞进队列 ⟹ 队列永不排空 ⟹ 计时全变 0。
  //   所以给它一个【只喂 JSON 行】的假流：诊断行（DEV/WARMUP_…）在这里就被拦下，一个都不进队列。
  const PT = require('stream').PassThrough;
  const pt = new PT(); pt.setEncoding('utf8');
  let rbuf = '';
  const bootLines = [];
  let resolveBoot = null;
  const bootReady = new Promise((r) => { resolveBoot = r; });
  proc.stdout.on('data', (d) => {
    rbuf += d; let i;
    while ((i = rbuf.indexOf('\n')) >= 0) {
      const line = rbuf.slice(0, i); rbuf = rbuf.slice(i + 1);
      if (!line.trim()) continue;
      if (line.trim().charAt(0) === '{') { pt.write(line + '\n'); }
      else { bootLines.push(line); if (line.indexOf('WARMUP_SAMPLE') >= 0) resolveBoot(bootLines); }
    }
  });
  const _bt = setTimeout(() => resolveBoot(bootLines.concat(['TIMEOUT'])), 180000); if (_bt.unref) _bt.unref();
  const ask = makeAsk({ stdin: proc.stdin, stdout: pt });
  return { proc, ask, boot: bootLines, ready: bootReady };
}
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;   // ms，微秒精度

function mkPayload(base, nRows) {
  // 按行数缩放 node 段（其余段原样）——**只为测「字节数 vs 延迟」**，语义上是一份不同观测
  const p = JSON.parse(JSON.stringify(base));
  const src = p.segs.node;
  const rows = [];
  for (let i = 0; i < nRows; i++) rows.push(src[i % src.length].slice());
  rows[0][1] = -1;
  for (let i = 1; i < nRows; i++) rows[i][1] = (i - 1) % 64;   // 造一份自洽的 parentIdx（不会越界）
  p.segs.node = rows;
  p.N = nRows;
  return p;
}

(async () => {
  if (!PAYLOAD_FILE) throw new Error('缺 --payload');
  fs.mkdirSync(OUT, { recursive: true });
  const cap = JSON.parse(fs.readFileSync(PAYLOAD_FILE, 'utf8'));
  const base = cap.payload;
  const srv = startSrv();
  const result = { tag: TAG, ckpt: CKPT, env: EXTRA_ENV, payloadFile: PAYLOAD_FILE, n: N, warm: WARM, cases: [] };
  try {
    await srv.ready;
    const cases = [];
    if (SCALES) for (const s of String(SCALES).split(',')) cases.push({ label: 'N=' + s, nRows: Number(s) });
    else cases.push({ label: 'N=' + base.N, nRows: base.N });

    for (const c of cases) {
      const payload = mkPayload(base, c.nRows);
      const body = JSON.stringify(payload) + '\n';
      const payloadBytes = Buffer.byteLength(body);
      const rtt = [], srvMs = [], trans = [], respBytes = [], parts = {};
      const fps = [];
      let errs = 0;
      for (let k = 0; k < WARM; k++) await srv.ask(payload);
      for (let k = 0; k < N; k++) {
        const t0 = now();
        const j = await srv.ask(payload);
        const dt = now() - t0;
        rtt.push(dt);
        if (j && j.err) { errs++; if (errs <= 2) logErr('ASK_ERR ' + j.err); continue; }
        const pm = j && j._pm;
        if (pm && typeof pm.total === 'number') { srvMs.push(pm.total); trans.push(dt - pm.total); }
        if (pm && typeof pm.out_bytes === 'number') respBytes.push(pm.out_bytes);
        if (pm) for (const kk of Object.keys(pm)) if (typeof pm[kk] === 'number' && kk !== 'out_bytes') (parts[kk] = parts[kk] || []).push(pm[kk]);
        fps.push([j.nodeId, r2(j.lp), r2(j.v), j.fire, r2(j.lp_fire), j.payload, j.mode]);
      }
      const agg = {};
      for (const kk of Object.keys(parts)) agg[kk] = r2(median(parts[kk]));
      result.cases.push({
        label: c.label, nRows: c.nRows, payloadBytes, errs,
        rtt_ms: { med: r2(median(rtt)), p10: r2(pct(rtt, 10)), p90: r2(pct(rtt, 90)), min: r2(Math.min(...rtt)), max: r2(Math.max(...rtt)) },
        srv_ms: { med: r2(median(srvMs)), p10: r2(pct(srvMs, 10)), p90: r2(pct(srvMs, 90)) },
        transport_ms: { med: r2(median(trans)), p10: r2(pct(trans, 10)), p90: r2(pct(trans, 90)) },
        respBytes: { med: r2(median(respBytes)), min: respBytes.length ? Math.min(...respBytes) : null },
        srv_parts_ms_med: agg,
        fingerprint: fps.slice(0, 5),
        fingerprint_uniq: Array.from(new Set(fps.map((x) => JSON.stringify(x)))).length
      });
    }
    const f = path.join(OUT, `bench_${TAG}.json`);
    fs.writeFileSync(f, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    console.log('WROTE ' + f);
  } catch (e) {
    console.error('FAILED', (e && e.stack) || e);
    process.exitCode = 1;
  } finally {
    try { srv.proc.stdin.end(); } catch (e) {}
    await new Promise((r) => { const t = setTimeout(() => { try { srv.proc.kill(); } catch (e) {} r(); }, 3000); srv.proc.on('exit', () => { clearTimeout(t); r(); }); });
  }
})();
