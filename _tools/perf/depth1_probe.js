'use strict';
/**
 * 只读小探针：证明「观测行号 → 树的第一跳(opIndex)」的对应关系
 * ---------------------------------------------------------------------
 * 目的：回答「为什么无子弹时策略总选到静止分支？」
 *   假设：`collectAgentNodes()` 用 LIFO 栈 DFS（children 0..n-1 入栈、弹出即逆序）
 *         ⟹ 列表**尾部** = **第一个孩子(opIndex 0 = 静止)** 的子树
 *         ⟹ 策略若偏好尾部行号，它的目标就永远落在「静止」分支。
 *
 * 用法：node _tools/perf/depth1_probe.js [--muteOpp=1] [--noFire=1] [--frames=40]
 * ⛔ 只读：不写任何数据。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
process.chdir(ROOT);
const { spawn } = require('child_process');
const { Match } = require(ROOT + '/_tools/headless/match.js');
const { makeAsk } = require(ROOT + '/_tools/headless/_policy_client.js');

const argv = {};
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)=(.*)$/.exec(a); if (m) argv[m[1]] = m[2]; }
const FRAMES = Number(argv.frames || 40);
const MUTE = argv.muteOpp === '1', NOFIRE = argv.noFire === '1';
const SRC = fs.readFileSync(ROOT + '/_tools/headless/_g1_inject.js', 'utf8');
const CKPT = argv.ckpt || process.env.VT_CKPT || 'D:/vt_run/t12/ckpt/last.pt';

// 页面侧：给每一行观测算出「它到根的第一跳是哪个操作」
const ROWMAP = `(() => {
  var t = VantageTree.getTree(); if (!t) return JSON.stringify({err:'no-tree'});
  var e = VantageObserve.encode({ adapter: window.__g1.ad, tree: t, horizonSec: 10, K_death: 1, frameDt: 1/60 });
  var tok = (e.nodes && e.nodes.tokens) || [];
  // 真树里每个节点 → 它到根路径上的【第一跳】节点
  var parent = {}, opname = {}, kids = {};
  t.walk(function (n) { if (!n) return; parent[n.id] = (n.parent && n.parent.id !== undefined) ? n.parent.id : null;
    opname[n.id] = n.opName || '(?)'; });
  var rootId = t.root ? t.root.id : null;
  function firstHop(id) {
    var cur = id, guard = 0, prev = null;
    while (cur !== null && cur !== undefined && cur !== rootId && guard++ < 500) { prev = cur; cur = parent[cur]; }
    return (cur === rootId) ? { id: prev, op: opname[prev] } : null;
  }
  var rows = [];
  for (var i = 0; i < tok.length; i++) { var fh = firstHop(tok[i][0]); rows.push({ row: i, uid: tok[i][0], d: tok[i][3], fhOp: fh ? fh.op : '(root)' }); }
  // 每个第一跳 op 在列表里占哪些行（首/末行）
  var byOp = {};
  for (var j = 0; j < rows.length; j++) { var k = rows[j].fhOp; if (!byOp[k]) byOp[k] = { n: 0, first: j, last: j }; byOp[k].n++; byOp[k].last = j; }
  return JSON.stringify({ N: rows.length, nodeCount: t.nodeCount, byOp: byOp,
    head: rows.slice(0, 3), tail: rows.slice(-3) });
})()`;

(async () => {
  const srv = spawn('py', ['-3.13', '_tools/training/policy_server_graph.py'],
    { env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', VT_CKPT: CKPT }) });
  await new Promise((r) => { const h = (d) => { if (String(d).indexOf('WARMUP_SAMPLE') < 0) return; srv.stdout.off('data', h); r(); }; srv.stdout.on('data', h); });
  const ask = makeAsk(srv);
  const m = new Match(); await m.open({ humanIds: [], aiCount: 1, vantCount: 1, control: false });
  await m.eval(SRC); await m.eval('window.__g1.setup()');
  if (MUTE) {
    const nm = await m.eval(`(function(){var ms=AIs.aiManagers||[];var n=0;for(var i=0;i<ms.length;i++){var g=ms[i];if(!g||g.isVantage)continue;var ai=g.ai;if(!ai)continue;
      ai.update=function(){try{this.inputState=InputState.withState(this.aiId,false,false,false,false,false);}catch(e){}};
      ai._makeDecisionsExceptGoal=undefined;ai._makeDecisionsAndUpdateGoal=function(){return false;};ai.actions=[];n++;}return n;})()`);
    console.log('muteOpp 打哑 AI 数 =', nm);
  }
  await m.pump(30, { yieldMs: 0 });
  await m.eval('window.__g1.setFire(' + (NOFIRE ? 0 : 1) + ')');
  let nodeId = 0;
  const picked = [];
  for (let f = 0; f < FRAMES; f++) {
    const o = JSON.parse(await m.eval('window.__g1.step(' + nodeId + ')'));
    await m.pump(1, { yieldMs: 0 });
    if (f === FRAMES - 1 || f === 0) {
      const rm = JSON.parse(await m.eval(ROWMAP));
      console.log(`--- frame ${f}: N=${rm.N} nodeCount=${rm.nodeCount}`);
      console.log('    行号→第一跳 op 的分段:', JSON.stringify(rm.byOp));
      console.log('    头 3 行:', JSON.stringify(rm.head), ' 尾 3 行:', JSON.stringify(rm.tail));
    }
    const N = (o.N || 0) | 0;
    if (N > 0 && o.segs) {
      const segs = { node: o.segs.node, opp: o.segs.opp, bullet: o.segs.bullet, item: o.segs.item, global: o.segs.global };
      const p = await ask({ N: N, seed: 9000 + f, mem_on: 0, segs });
      if (p && !p.err && typeof p.nodeId === 'number' && p.nodeId >= 0 && p.nodeId < N) {
        nodeId = p.nodeId;
        if (f > FRAMES - 21) picked.push({ row: nodeId, N: N, rel: +(nodeId / N).toFixed(2), fire: p.fire });
      }
      await m.eval('window.__g1.setFire(' + (!NOFIRE && p && p.fire === 1 ? 1 : 0) + ')');
    }
  }
  console.log('最后 20 帧策略选的行号:', JSON.stringify(picked));
  // 这些行号的第一跳 op
  const rm2 = JSON.parse(await m.eval(ROWMAP));
  const seg = rm2.byOp;
  const opOf = (row) => { for (const k in seg) if (row >= seg[k].first && row <= seg[k].last) return k; return '?'; };
  console.log('这些行号的第一跳 op:', JSON.stringify(picked.map((p) => ({ row: p.row, rel: p.rel, fhOp: opOf(p.row) }))));
  await m.close(); srv.kill(); process.exit(0);
})().catch((e) => { console.log('FATAL ' + ((e && e.stack) || e)); process.exit(1); });
