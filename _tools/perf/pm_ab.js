/**
 * pm_ab.js —— 【配对 A/B】逐项优化的诚实前后对比（同一服务端进程、轮转采样）
 * ==========================================================================
 * 为什么不用"两次独立跑再比中位数"：实测同一份代码连跑两次 srv=2.88 / 3.43 ms（GPU 降频 + 系统噪声 ±20%）。
 * ⟹ 本脚本把各开关组合【在同一进程里轮转】（载荷里带 `_fast` 字段，服务端逐请求覆盖开关），
 *    同一时刻的机器状态对所有变体相同，差的才是开关本身。
 *
 * 用法：node _tools/perf/pm_ab.js --payload D:/vt_run/perf/payload_p8_N124.json --n 100 --scales 208
 * 输出：控制台表 + D:/vt_run/perf/ab_<stamp>.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeAsk } = require('../headless/_policy_client.js');

const REPO = path.resolve(__dirname, '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const OUT = arg('out', 'D:/vt_run/perf');
const NASK = Number(arg('n', 100));
const WARM = Number(arg('warm', 10));
const SCALES = String(arg('scales', '208')).split(',');
const CKPT = arg('ckpt', process.env.VT_CKPT || 'D:/vt_run/cyc_1/ckpt/model_latest.pt');
const PAYLOAD_FILE = arg('payload', 'D:/vt_run/perf/payload_p8_N124.json');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const VARIANTS = [
  ['base', ''],
  ['tensor', 'tensor'],
  ['json', 'json'],
  ['mem+echo', 'mem,echo'],
  ['zero', 'zero'],
  ['memg', 'mem,echo,memg'],
  ['ALL', 'mem,echo,json,tensor,argmax,sync,zero,memg']
];

const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const med = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const pctl = (a, p) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.max(0, Math.round((p / 100) * (b.length - 1))))]; };
const r2 = (x) => (x === null || x === undefined) ? null : Math.round(x * 100) / 100;

function startSrv() {
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', VT_CKPT: CKPT, VT_PROBE_MS: '1' });
  const proc = spawn('py', ['-3.13', '_tools/training/policy_server_graph.py'], { cwd: REPO, env });
  proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
  const boot = [];
  proc.stderr.on('data', (d) => String(d).split('\n').forEach((l) => { if (l.trim()) boot.push(l); }));
  const PT = require('stream').PassThrough;
  const pt = new PT(); pt.setEncoding('utf8');
  let rbuf = '', resolveBoot = null;
  const ready = new Promise((r) => { resolveBoot = r; });
  proc.stdout.on('data', (d) => {
    rbuf += d; let i;
    while ((i = rbuf.indexOf('\n')) >= 0) {
      const line = rbuf.slice(0, i); rbuf = rbuf.slice(i + 1);
      if (!line.trim()) continue;
      if (line.trim().charAt(0) === '{') pt.write(line + '\n');
      else { boot.push(line); if (line.indexOf('WARMUP_SAMPLE') >= 0) resolveBoot(boot); }
    }
  });
  const t = setTimeout(() => resolveBoot(boot.concat(['TIMEOUT'])), 120000); if (t.unref) t.unref();
  return { proc, ask: makeAsk({ stdin: proc.stdin, stdout: pt }), boot, ready };
}

function mkPayload(base, nRows) {
  const p = JSON.parse(JSON.stringify(base));
  const src = p.segs.node, rows = [];
  for (let i = 0; i < nRows; i++) rows.push(src[i % src.length].slice());
  rows[0][1] = -1;
  for (let i = 1; i < nRows; i++) rows[i][1] = (i - 1) % 64;
  p.segs.node = rows; p.N = nRows;
  return p;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cap = JSON.parse(fs.readFileSync(PAYLOAD_FILE, 'utf8'));
  const srv = startSrv();
  const out = { stamp: STAMP, payload: PAYLOAD_FILE, nask: NASK, warm: WARM, ckpt: CKPT, cases: [] };
  try {
    await srv.ready;
    for (const sN of SCALES) {
      const base = mkPayload(cap.payload, Number(sN));
      const prodBytes = Buffer.byteLength(JSON.stringify(base) + '\n');
      const rec = {};
      for (const [tag] of VARIANTS) rec[tag] = { rtt: [], srv: [], tr: [], resp: [], fp: [], err: 0 };
      for (let k = 0; k < WARM; k++) for (const [tag, f] of VARIANTS) await srv.ask(Object.assign({}, base, { _fast: f }));
      // ⚠️ 逐项分辨率：本机 GPU 降频会让同一份代码的中位数在 ±1ms 内漂 ⟹ 小于 1ms 的差按"无显著收益"处理
      for (let k = 0; k < NASK; k++) {
        const order = (k % 2 === 1) ? VARIANTS.slice().reverse() : VARIANTS;
        for (const [tag, f] of order) {
          const pay = Object.assign({}, base, { _fast: f });
          const t0 = nowMs();
          const j = await srv.ask(pay);
          const dt = nowMs() - t0;
          const R = rec[tag];
          if (!j || j.err || typeof j.nodeId !== 'number') { R.err++; continue; }
          R.rtt.push(dt);
          if (j._pm && typeof j._pm.total === 'number') { R.srv.push(j._pm.total); R.tr.push(dt - j._pm.total); if (typeof j._pm.out_bytes === 'number') R.resp.push(j._pm.out_bytes); }
          R.fp.push([j.nodeId, r2(j.lp), r2(j.v), j.fire, j.payload, j.mode]);
        }
      }
      const res = [];
      for (const [tag] of VARIANTS) {
        const R = rec[tag];
        const uniq = Array.from(new Set(R.fp.map((x) => JSON.stringify(x))));
        res.push({ tag, errs: R.err,
          rtt_ms: { med: r2(med(R.rtt)), p90: r2(pctl(R.rtt, 90)) },
          srv_ms: { med: r2(med(R.srv)), p90: r2(pctl(R.srv, 90)) },
          trans_ms: { med: r2(med(R.tr)), p90: r2(pctl(R.tr, 90)) },
          respBytes: { med: r2(med(R.resp)) },
          fingerprint_uniq: uniq.length, fingerprint: uniq.slice(0, 2) });
      }
      const c = { scale: 'N=' + sN, prodPayloadBytes: prodBytes, variants: res };
      out.cases.push(c);
      console.log('=== ' + c.scale + '  生产载荷 ' + prodBytes + ' B ===');
      const b = res.find((x) => x.tag === 'base');
      for (const x of res) {
        const dRtt = (b.rtt_ms.med !== null && x.rtt_ms.med !== null) ? r2(x.rtt_ms.med - b.rtt_ms.med) : null;
        const dSrv = (b.srv_ms.med !== null && x.srv_ms.med !== null) ? r2(x.srv_ms.med - b.srv_ms.med) : null;
        console.log(`  ${x.tag.padEnd(9)} rtt ${String(x.rtt_ms.med).padStart(6)} (p90 ${String(x.rtt_ms.p90).padStart(6)}) Δ${String(dRtt).padStart(7)} | srv ${String(x.srv_ms.med).padStart(6)} Δ${String(dSrv).padStart(7)} | trans ${String(x.trans_ms.med).padStart(5)} | resp ${String(x.respBytes.med).padStart(6)} | fp_uniq ${x.fingerprint_uniq} ${JSON.stringify(x.fingerprint[0] || null)}`);
      }
    }
    fs.writeFileSync(path.join(OUT, 'ab_' + STAMP + '.json'), JSON.stringify(out, null, 2));
    console.log('WROTE ' + path.join(OUT, 'ab_' + STAMP + '.json'));
  } catch (e) {
    console.error('FAILED ' + ((e && e.stack) || e));
    process.exitCode = 1;
  } finally {
    try { srv.proc.stdin.end(); } catch (e) {}
    await new Promise((r) => { const t = setTimeout(() => { try { srv.proc.kill(); } catch (e) {} r(); }, 2000); srv.proc.on('exit', () => { clearTimeout(t); r(); }); });
  }
})();
