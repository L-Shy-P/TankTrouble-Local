'use strict';
/* 读 _probe_multiai_clock.js 产出的 JSONL，用 dumpDiagnostics().liveAnchors 的 delta
 * 算「锚点年龄 Δ 的斜率 = Δdelta / 游戏秒」——验证树秒是否 = 游戏秒。
 *   node _tools/headless/_probe_multiai_slope.js <jsonl> [...]
 * 注意：只在同一锚点代内（delta 单调增）算；delta 回落 = 重锚，切断。
 */
const fs = require('fs');
for (const file of process.argv.slice(2)) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length).map((l) => JSON.parse(l));
  const byId = {};
  for (const r of rows) {
    for (const a of (r.anchors || [])) {
      if (a.id === undefined || a.id === null) continue;
      (byId[a.id] = byId[a.id] || []).push({ f: r.f, t: r.t / 1000, delta: a.delta, has: a.has, len: a.len });
    }
  }
  const runs = [];
  for (const id of Object.keys(byId)) {
    const arr = byId[id];
    let start = 0;
    for (let i = 1; i <= arr.length; i++) {
      const broken = (i === arr.length) || (arr[i].delta < arr[i - 1].delta) || (arr[i].t - arr[i - 1].t > 0.05);
      if (broken) {
        if (i - start >= 20) {
          const a0 = arr[start], a1 = arr[i - 1];
          const dDelta = a1.delta - a0.delta, dT = a1.t - a0.t;
          if (dDelta > 0.2 && dT > 0.2) runs.push({ id: id, n: i - start, dDelta: dDelta, dT: dT, ratio: dDelta / dT });
        }
        start = i;
      }
    }
  }
  runs.sort((a, b) => b.n - a.n);
  const ratios = runs.map((r) => r.ratio);
  const med = ratios.length ? (ratios.slice().sort((a, b) => a - b)[(ratios.length - 1) >> 1]) : null;
  console.log('== ' + file);
  console.log('  锚点代窗口数=' + runs.length + '  ratio(Δdelta/游戏秒) med=' +
    (med === null ? '-' : Math.round(med * 1e6) / 1e6) +
    ' min=' + (ratios.length ? Math.round(Math.min.apply(null, ratios) * 1e6) / 1e6 : '-') +
    ' max=' + (ratios.length ? Math.round(Math.max.apply(null, ratios) * 1e6) / 1e6 : '-'));
  for (const r of runs.slice(0, 3)) {
    console.log('    id=' + r.id + ' 帧数=' + r.n + ' Δdelta=' + (Math.round(r.dDelta * 1e3) / 1e3) +
      's 游戏秒=' + (Math.round(r.dT * 1e3) / 1e3) + ' ratio=' + (Math.round(r.ratio * 1e3) / 1e3));
  }
}
