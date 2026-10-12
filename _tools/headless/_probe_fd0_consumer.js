#!/usr/bin/env node
/* ============================================================================
 * 1-2③ 收尾 ①：fd=0 消费层独立反例
 *   A) JS VantageScoring.scorePaths 收到 batch {dead:true, deathFrame:0}
 *      → 必须 dead=true / deathFrame 仍为 0（⛔ 不得改写成 1）/ 只记一次 deathPenalty
 *   B) Rust vt_score_paths（经 bridge.scorePaths，部署 wasm）激光首帧命中
 *      → deathFrame=0、perFrameScores=[-deathPenalty]、frameCount=1
 *   C) 负例：{dead:false, deathFrame:-1} 不得被误判成死
 * ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const JS = (p) => path.join(root, p);
const PEN = 10;

function loadSandbox() {
  const sandbox = { console: console };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(JS('game_core/js/f1a5ef972c273fb89a098cb50b0f22e7.js'), 'utf8'), ctx, { filename: 'box2d.js' });
  function makeClass() {
    const C = {};
    C.classFields = function (o) { for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) C[k] = o[k]; return C; };
    C.classMethods = function (o) { for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) C[k] = o[k]; return C; };
    C.methods = function () { return C; };
    C.fields = function () { return C; };
    C.name = function () { return C; };
    return C;
  }
  sandbox.Classy = { newClass: makeClass };
  const bundle = fs.readFileSync(JS('game_core/js/b714588dc4621fe104113111ba90b1a7.js'), 'utf8').split(/\r?\n/);
  for (const name of ['mod_pagespeed_QSIkKJ9Ibg', 'mod_pagespeed__SHLt6ORr2']) {
    const line = bundle.find((l) => l.indexOf('var ' + name) >= 0);
    vm.runInContext(line, ctx, { filename: name });
    vm.runInContext(sandbox[name], ctx, { filename: name + '-eval' });
  }
  vm.runInContext(fs.readFileSync(JS('game_core/js/ai_tactics.js'), 'utf8'), ctx, { filename: 'ai_tactics.js' });
  vm.runInContext(fs.readFileSync(JS('game_core/js/vantage_sandbox.js'), 'utf8'), ctx, { filename: 'vantage_sandbox.js' });
  vm.runInContext(fs.readFileSync(JS('game_core/js/vantage_scoring.js'), 'utf8'), ctx, { filename: 'vantage_scoring.js' });
  sandbox._ctx = ctx;
  return sandbox;
}

function cfg() {
  return { deathPenalty: PEN, stuckPenalty: 4, stuckDistEps: 0.05, stuckRotEps: 0.05,
           lanePenaltyRatio: 0, springRopeEnabled: false, occlusionEnabled: true };
}

function main() {
  const sandbox = loadSandbox();
  const Scoring = sandbox.VantageScoring;
  let fails = 0;
  console.log('=== 1-2③ fd=0 消费层反例 ===');

  function jsConsumer(batch, label, wantDead, wantFd) {
    const fakeAdapter = {
      constants: { FRAME_DT: 0.02 },
      simulateTankBatch: function () { return batch; },
      bulletPosAt: function () { return null; },
    };
    const out = Scoring.scorePaths(fakeAdapter, { tank: { x: 5, y: 5, rot: 0 }, tGlobal: 0 },
      [{ inputs: { forward: false, back: false, left: false, right: false } }], 3, [], cfg());
    const r = out && out[0];
    const ok = !!r && r.dead === wantDead && r.deathFrame === wantFd &&
      (wantDead ? (r.perFrameScores.length === 1 && Math.abs(r.perFrameScores[0] + PEN) < 1e-12 &&
                   Math.abs(r.totalScore + PEN) < 1e-12 && r.frameCount === 1)
                : (r.deathFrame === -1));
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label +
      '  dead=' + (r && r.dead) + ' fd=' + (r && r.deathFrame) +
      ' pfs=' + JSON.stringify(r && r.perFrameScores) + ' total=' + (r && r.totalScore));
    if (!ok) fails++;
    return r;
  }

  const samples = [];
  for (let i = 0; i < 4; i++) samples.push({ t: i * 0.02, x: 5, y: 5, rot: 0 });
  const fd0 = jsConsumer([{ dead: true, deathFrame: 0, samples: samples, perFrameScores: [], totalScore: 0, frameCount: 0 }],
    'A. JS scorePaths 消费 fd=0（不得改写成 1）', true, 0);
  if (fd0 && fd0.deathFrame === 1) console.log('        ↳ 发现被改写成 1！');
  jsConsumer([{ dead: false, deathFrame: -1, samples: samples, perFrameScores: [0, 0, 0], totalScore: 0, frameCount: 3 }],
    'C. JS scorePaths 负例（fd=-1 仍是活）', false, -1);

  // B) Rust vt_score_paths：激光首帧命中
  sandbox.WebAssembly = WebAssembly;
  sandbox.fetch = async function () {
    const bytes = fs.readFileSync(JS('game_core/js/wasm/vantage_core.wasm'));
    return { ok: true, arrayBuffer: async function () {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } };
  };
  vm.runInContext(fs.readFileSync(JS('game_core/js/vantage_rust_bridge.js'), 'utf8'), sandbox._ctx, { filename: 'vantage_rust_bridge.js' });
  const bridge = sandbox.VantageRustBridge;
  return bridge.init('js/wasm/vantage_core.wasm').then(function (init) {
    if (!init.ok) { console.log('  FAIL B. bridge init: ' + init.error); fails++; }
    else {
      const r = bridge.scorePaths({
        cacheId: 1, startPose: { x: 5, y: 5, rot: 0 }, startT: 0,
        ops: [{ speed: 0, rotationSpeed: 0 }], frames: 3, walls: [],
        bullets: [{ x: 1, y: 5, vx: 180, vy: 0, radius: 0, lifeLeft: 0.8, active: true, isLaser: true }],
        threats: [], cfg: cfg(),
      });
      const rr = r && r.ok && r.results && r.results[0];
      const ok = !!rr && rr.deathFrame === 0 && rr.perFrameScores.length === 1 &&
        Math.abs(rr.perFrameScores[0] + PEN) < 1e-12 && rr.frameCount === 1 &&
        Math.abs(rr.totalScore + PEN) < 1e-12;
      console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  B. Rust vt_score_paths 激光首帧 fd=0' +
        '  ok=' + (r && r.ok) + ' fd=' + (rr && rr.deathFrame) +
        ' pfs=' + JSON.stringify(rr && rr.perFrameScores) + ' total=' + (rr && rr.totalScore) +
        ' fc=' + (rr && rr.frameCount) + (r && !r.ok ? ' err=' + r.error : ''));
      if (!ok) fails++;
    }
    console.log('\n' + (fails ? 'FD0 CONSUMER PROBE FAILED (' + fails + ')' : 'FD0 CONSUMER PROBE PASSED'));
    process.exitCode = fails ? 1 : 0;
  });
}

try { main(); } catch (e) { console.error('FATAL', (e && e.stack) || e); process.exitCode = 1; }
