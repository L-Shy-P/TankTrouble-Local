#!/usr/bin/env node
// 外接 AI 回归：确认 Hybrid（别人游戏的模型）在我们仓库里能原样加载、逐位复现。
// 只读 game_core/external_ai/hybrid/ 的副本，不碰参考工程原件。
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const dir = path.resolve(__dirname, '..', 'external_ai', 'hybrid');

(async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'hybrid.json'), 'utf8'));
  const bytes = fs.readFileSync(path.join(dir, 'hybrid.bin'));
  const weights = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const fixture = JSON.parse(fs.readFileSync(path.join(dir, 'hybrid-parity.json'), 'utf8'));

  // hybrid.js 是 ES module（export class），从 CJS 里动态 import。
  const mod = await import(require('url').pathToFileURL(path.join(dir, 'hybrid.js')).href);
  const policy = new mod.HybridPolicy(manifest, weights);

  assert.strictEqual(manifest.schema, 24, '模型的 schema 必须是 24（观测/动作契约）');
  assert.strictEqual(manifest.observation, 1028, '观测维度必须是 1028');
  assert.strictEqual(manifest.actions, 18, '动作数必须是 18');
  assert.strictEqual(weights.length, manifest.floats,
    '权重长度必须等于清单里的 floats（' + weights.length + ' vs ' + manifest.floats + '）');

  const obs = Float32Array.from(fixture.obs);
  const mask = fixture.mask;
  const dodge = Float32Array.from(fixture.dodge);
  const logits = policy.logits(obs, mask, dodge);
  let maxErr = 0;
  for (let i = 0; i < logits.length; i++) maxErr = Math.max(maxErr, Math.abs(logits[i] - fixture.logits[i]));
  assert.ok(maxErr < 2e-5, 'PyTorch↔JS 的 logits 最大误差必须 < 2e-5，实测 ' + maxErr);
  const action = policy.act(obs, mask, dodge);
  assert.strictEqual(action, fixture.action, 'argmax 动作必须与对拍样本一致');

  // 顺带量一下单次前向的成本（将来每帧要跑一次）。
  const t0 = process.hrtime.bigint();
  const N = 50;
  for (let i = 0; i < N; i++) policy.logits(obs, mask, dodge);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;

  console.log('diff_external_hybrid PASS: action=' + action +
    ' maxLogitErr=' + maxErr.toExponential(2) +
    ' 单次前向=' + ms.toFixed(2) + 'ms');
})().catch(function (e) {
  console.error('diff_external_hybrid FAIL: ' + (e && e.message));
  process.exit(1);
});
