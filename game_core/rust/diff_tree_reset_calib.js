#!/usr/bin/env node
// v139 回归：帧步长校准是跨局状态，reset() 必须清掉
// ---------------------------------------------------------------------------
// 主人实测：「游戏疑似出现过运行越久 AI 越笨的情况」+「刚开机更聪明」。
// 根因链：
//   calibrateFrameDt 把模块级 FRAME_DT 从 0.02 调到实测值（0.015~0.020）；
//   reset() 从来没清过它、_frameDtMeasured、_lastGameClock；
//   一旦 FRAME_DT 离开 0.02，v137 的 rustFrameDtCompatible 护栏就停用 Rust 快路
//   （Rust 核心 rollout.rs/rescore.rs 写死 0.02），整树退回 JS 慢路；
//   每 tick 能长的层更少 → AI 明显变笨；开机时 FRAME_DT 恰好 = 0.02 → 显得聪明。
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
    ['_lastGameClock 归 null', /_lastGameClock = null;/],
    ['_lastGameClockId 归 null', /_lastGameClockId = null;/],
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
for (const sym of ['FRAME_DT = 0.02', '_frameDtMeasured = 0', '_lastGameClock = null',
                   '_lastGameClockId = null', '_speedCap = 0']) {
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
