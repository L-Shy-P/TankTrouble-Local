#!/usr/bin/env node
// v139 回归（v163 更新）：帧步长校准是跨局状态，reset() 必须清掉
// ---------------------------------------------------------------------------
// 主人实测：「游戏疑似出现过运行越久 AI 越笨的情况」+「刚开机更聪明」。
// 根因链（v139 当时）：
//   calibrateFrameDt 把模块级 FRAME_DT 从 0.02 调到实测值；reset() 从来没清过它；
//   一旦 FRAME_DT 离开 0.02，旧护栏停用 Rust 快路，整树退回 JS 慢路 → 变笨。
// v163 校准器重写后：FRAME_DT 会被直接校准到真实帧长（0.001~0.1），
//   跨局残留会让新一局开局就带着上一局的步长 → **照样必须清**。
//   v163 还新增了样本串/样本键/诊断计数三个跨帧状态，reset() 必须一起清。
// v163b（量化修正）：校准主样本改成 performance.now() 自分差，新增基准/样本来源/交叉校验
//   四个跨帧状态 —— 同样必须清，否则换局后第一帧的自分差会跨到上一局的时刻上。
// 这正是铁律「新增跨帧状态必须在 reset() 清掉」（同 v108 清 _stuckOps）。
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const tSrc = fs.readFileSync(path.join(root, 'js', 'vantage_tree.js'), 'utf8');
const sSrc = fs.readFileSync(path.join(root, 'js', 'vantage_sandbox.js'), 'utf8');

// ① reset() 必须把校准相关跨局状态全部清掉
for (const [name, re] of [
    ['FRAME_DT 归 0.02', /\n\s*FRAME_DT = 0\.02;/],
    ['_frameDtMeasured 归 0', /_frameDtMeasured = 0;/],
    ['_frameDtRun 清零', /_frameDtRun\.length = 0;/],
    ['_frameDtSampleKey 归 null', /_frameDtSampleKey = null;/],
    ['_frameDtLastPerfMs 归 null', /_frameDtLastPerfMs = null;/],
    ['_frameDtCrossMiss 归 0', /_frameDtCrossMiss = 0;/],
    ['_frameDtCrossMaxMs 归 0', /_frameDtCrossMaxMs = 0;/],
    ['_frameDtCrossWarned 归 false', /_frameDtCrossWarned = false;/],
    ['_speedCap 归 0', /_speedCap = 0;/],
    ['同步沙箱帧步长', /VantageSandbox\.setFrameDtSec\(FRAME_DT\)/]
]) {
    assert(re.test(tSrc), '(1) reset() must clear ' + name);
}

// ② 这些清理必须发生在 reset() 函数体内（而不是别处）
const iReset = tSrc.indexOf('function reset() {');
assert(iReset > 0, '(2) reset() not found');
const iSnapshot = tSrc.indexOf('function getLastResetSnapshot', iReset);
const body = tSrc.slice(iReset, iSnapshot > iReset ? iSnapshot : iReset + 6000);
for (const sym of ['FRAME_DT = 0.02', '_frameDtMeasured = 0', '_frameDtRun.length = 0',
                   '_frameDtSampleKey = null', '_frameDtLastPerfMs = null', '_frameDtCrossMiss = 0',
                   '_speedCap = 0', 'syncFrameDtToSandbox(_lastAdapter)']) {
    assert(body.indexOf(sym) >= 0, '(2) reset() body missing ' + sym);
}

// ③ Rust 快路护栏必须存在且接在三个入口上（否则清了也白清）
assert(sSrc.indexOf('function rustFrameDtCompatible()') >= 0, '(3) rustFrameDtCompatible guard missing');
const entries = ['simulateRustBatch', 'simulateTankBatchScored', 'rescoreTankSamples'];
for (const e of entries) {
    const i = sSrc.indexOf('function ' + e) >= 0
        ? sSrc.indexOf('function ' + e) : sSrc.indexOf(e + ': function');
    assert(i >= 0, '(3) entry ' + e + ' not found');
    assert(sSrc.slice(i, i + 900).indexOf('rustFrameDtCompatible()') >= 0,
        '(3) ' + e + ' missing frame-dt guard');
}

console.log('diff_tree_reset_calib PASS (v139 跨局帧步长校准泄漏已清，Rust 护栏仍生效)');
