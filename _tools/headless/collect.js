'use strict';
/* 采集真实树的输入分布（阶段0 的"同源数据"）
 *
 *   node _tools/headless/collect.js [--max 1500] [--every 8] [--frames 12000]
 *
 * 为什么必须用真实树：子代理证明合成树的标签只是输入位取反，
 * 且真实树是「9叉 + 兄弟共享段长 + invalid/exhausted 整枝传播」，
 * 合成树的分布和它对不上 —— 训出来接真实树就废。
 */
const fs = require('fs');
const path = require('path');
const { Match } = require('./match');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i < 0 ? d : Number(process.argv[i + 1]); }

(async () => {
  const MAX = arg('max', 1500);
  const EVERY = arg('every', 8);
  const FRAMES = arg('frames', 12000);
  const OUT = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : path.join(__dirname, 'real_trees.json');

  const t0 = Date.now();
  const T = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const m = new Match();
  try {
    // ★ 必须有对手开枪，否则树里永远不会出现真死节点（实测 aiCount:0 时真死率 = 0）
    await m.open({ humanIds: ['tank_a'], aiCount: arg('ai', 1), vantCount: 1 });
    console.log(`[${T()}] 开局:`, JSON.stringify(m.bootstrap));

    await m.eval(`window.__vtCollect = { buf: [], max: ${MAX}, every: ${EVERY}, tick: 0 }`);

    const CHUNK = 500;
    for (let done = 0; done < FRAMES; done += CHUNK) {
      await m.pump(Math.min(CHUNK, FRAMES - done), { yieldMs: 0 });
    }
    const st = await m.eval(`(() => { var c = window.__vtCollect;
      return { tick: c.tick, n: c.buf.length, iface: JSON.parse(JSON.stringify(window.__vantageIface||{})) }; })()`);
    console.log(`[${T()}] 采集: tick=${st.tick} 记录=${st.n} iface.collected=${st.iface.collected} collectErr=${st.iface.collectErr || 'none'}`);

    // ---- 在页面里算统计，只传小结果（原始记录 400 条 = 30MB，CDP 传不动）----
    const stat = await m.eval(`(() => {
      var recs = window.__vtCollect.buf, out = {};
      var nc = [], dp = [], kd = [], sg = [], td = [], te = [], dr = [], ir = [], er = [];
      for (var i = 0; i < recs.length; i++) {
        var ns = recs[i].nodes, byId = {};
        for (var a = 0; a < ns.length; a++) byId[ns[a].id] = ns[a];
        nc.push(ns.length);
        var dead = 0, inv = 0, exh = 0;
        var kidCount = {};
        for (var b = 0; b < ns.length; b++) {
          var m = ns[b];
          if (m.invalid) inv++;
          if (m.exhausted) exh++;
          if (m.fullDeathFrame !== null && m.fullDeathFrame !== undefined &&
              m.fullDeathFrame >= 0 && m.fullDeathFrame <= 1) dead++;
          var p = m.parentId, d = 0, g = 0;
          while (p !== null && p !== undefined && p !== -1 && byId[p] && g++ < 999) { d++; p = byId[p].parentId; }
          dp.push(d); sg.push(m.segmentFrames || 0);
          if (m.tEndSec !== null && m.tEndSec !== undefined) te.push(m.tEndSec);
          if (m.fullDeathFrame !== null && m.fullDeathFrame !== undefined) td.push(m.fullDeathFrame);
          var pk = m.parentId; if (pk !== null && pk !== -1) kidCount[pk] = (kidCount[pk] || 0) + 1;
        }
        for (var kk in kidCount) kd.push(kidCount[kk]);
        dr.push(dead / Math.max(1, ns.length));
        ir.push(inv / Math.max(1, ns.length));
        er.push(exh / Math.max(1, ns.length));
      }
      function q(a, pp) { var b = a.slice().sort(function (x, y) { return x - y; });
        return b.length ? b[Math.min(b.length - 1, Math.floor(b.length * pp))] : null; }
      function mn(a) { return a.length ? a.reduce(function (x, y) { return y < x ? y : x; }, Infinity) : null; }
      function mx(a) { return a.length ? a.reduce(function (x, y) { return y > x ? y : x; }, -Infinity) : null; }
      function mn_(a) { return { p50: q(a, .5), p95: q(a, .95), p99: q(a, .99), max: mx(a), min: mn(a), n: a.length }; }
      out.记录数 = recs.length;
      out.节点数 = mn_(nc);
      out.深度 = mn_(dp);
      out.子节点数 = mn_(kd);
      out.段长 = mn_(sg);
      out.tEndSec = mn_(te);
      out.fullDeathFrame = mn_(td);
      out.真死帧取值 = (function () { var u = {}; for (var z = 0; z < td.length; z++) { var v = td[z]; u[v] = (u[v] || 0) + 1; }
        var ks = Object.keys(u).sort(function (a2, b2) { return u[b2] - u[a2]; }); return ks.slice(0, 8).map(function (k) { return [+k, u[k]]; }); })();
      out.真死节点占比 = mn_(dr);
      out.invalid占比 = mn_(ir);
      out.exhausted占比 = mn_(er);
      return out;
    })()`);
    console.log('');
    console.log('===== 真实树分布（带对手）=====');
    console.log(JSON.stringify(stat, null, 1));
    if (!process.argv.includes('--no-dump')) {
      // 只存前 60 条原始记录（够做 golden vector 对拍）
      const small = await m.eval('window.__vtCollect.buf.slice(0, 60)');
      fs.writeFileSync(OUT, JSON.stringify(small));
      console.log('写入 60 条原始记录 -> ' + OUT + ' (' + (fs.statSync(OUT).size / 1048576).toFixed(1) + ' MB)');
    }
  } catch (e) {
    console.error('FAILED:', (e && e.stack) || e);
    process.exitCode = 1;
  } finally { await m.close(); }
})();
