#!/usr/bin/env node
// v138 回归：录制器不许把自己的证据弄丢了（纯取证，零行为改变）
// ---------------------------------------------------------------------------
// 背景：拿 vantage_record_1790509445005.json 做死因分析时，segSnaps / scanTraces
// 导出**全是 0 条**——而它们正是"树当时看没看见、有没有更安全候选可选"的唯一证据。
// 两个自伤：
//   ① recBegin('auto-death') 会 `_rec.segSnaps = []`：死亡瞬间清空候选快照，
//      而死亡后树被冻结、再不产生新快照 → 导出必然为空；
//   ② scanTraces 挂在 tree._scanTraces，死亡后 reset() 换新树 → 导出读到空数组。
// 本文件钉住这两条，并钉住"每帧 9 候选 fd + 时间锚"这条新取证字段。
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const assert = require('assert');
const root = path.resolve(__dirname, '..');

const Constants = {
    BULLET: { RADIUS: { m: 0.25 }, OFFSET: { m: 2.5 } },
    TANK: { WIDTH: { m: 3 }, HEIGHT: { m: 4 } },
    MAZE_TILE_SIZE: { m: 10 }, PIXELS_PER_METER: 20
};
const sb = {
    console, performance, Math, JSON, Array, Object, String, Number,
    isFinite, parseInt, parseFloat, Infinity, NaN, Date, Constants
};
sb.global = sb;
sb.VantageSandbox = {
    fusedEnabled: () => false,
    OPERATIONS: Array.from({ length: 9 }, (_, i) => ({ name: 'op' + i, inputs: { forward: i === 1 } }))
};
const ctx = vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(root, 'js', 'vantage_scoring.js'), 'utf8'), ctx, { filename: 's.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'js', 'vantage_tree.js'), 'utf8'), ctx, { filename: 't.js' });
const VT = sb.VantageTree;
const tSrc = fs.readFileSync(path.join(root, 'js', 'vantage_tree.js'), 'utf8');

// ===========================================================================
// ① scanTraces 必须跨 reset 存活（行为验证）
// ===========================================================================
{
    const ST = VT._scanTrace;
    assert(ST && typeof ST.record === 'function', '缺少 _scanTrace.record 调试钩子');

    const fakeTree = { diag: {}, stats: {}, nodeCount: 0 };
    const node = { id: 7, opName: 'op3', plannedFrames: 3, segmentFrames: 3, fullDeathFrame: 6 };
    const frames = [];
    for (let k = 0; k < 4; k++) frames.push({ k: k, x: k, y: k, bs: [] });
    ST.record(fakeTree, node, 2, frames, 'scan');

    const before = VT.exportRecord();
    assert(before.scanTraces && before.scanTraces.length >= 1,
        '① exportRecord 应当带出权威扫描轨迹，实际 ' + (before.scanTraces && before.scanTraces.length));

    // 死亡后 reset() 会换掉 _tree —— 轨迹不得跟着消失
    if (typeof VT.reset === 'function') { try { VT.reset(); } catch (eR) {} }
    const after = VT.exportRecord();
    assert(after.scanTraces && after.scanTraces.length >= 1,
        '① reset() 之后 scanTraces 不得丢失（v137 及以前：挂在 tree 上 → 换树即空）');
    assert.strictEqual(after.scanTraces[after.scanTraces.length - 1].scanDeath, 2,
        '① 轨迹内容应保留 scanDeath');
}

// ===========================================================================
// ② 自动抓取不得清空死亡前的候选快照（源码钉死 + 字段钉死）
// ===========================================================================
{
    assert(/var savedSnaps = _rec\.segSnaps\.slice\(-160\);[\s\S]{0,120}?_rec\.segSnaps = savedSnaps;/.test(tSrc),
        '② recNoteDeath 必须先存后复 segSnaps（不得让 recBegin 清掉死亡前的快照）');
    // recBegin 的清空必须发生在"存"之后 —— 顺序靠上面的正则位置保证
    const iSave = tSrc.indexOf('var savedSnaps = _rec.segSnaps.slice(-160);');
    const iBegin = tSrc.indexOf("recBegin('auto-death');", iSave);
    const iRestore = tSrc.indexOf('_rec.segSnaps = savedSnaps;', iSave);
    assert(iSave > 0 && iBegin > iSave && iRestore > iBegin,
        '② 顺序必须是：存 → recBegin → 复，实际 ' + [iSave, iBegin, iRestore].join(','));
}

// ===========================================================================
// ③ 每帧必须记 9 候选各自的 fd + 时间锚（换算绝对预测死期用）
// ===========================================================================
{
    assert(/candFd: \(function \(\)/.test(tSrc), '③ recFrame 必须记 candFd');
    assert(/rootAbsT: tree \? Math\.round/.test(tSrc), '③ recFrame 必须记 rootAbsT');
    assert(/rolloutStartT: node \? Math\.round/.test(tSrc), '③ recFrame 必须记 rolloutStartT');
    // candFd 每项必须能换算出绝对预测死期：需要 fd / seg / rStartT
    const iCand = tSrc.indexOf('candFd: (function');
    const candBlock = tSrc.slice(iCand, tSrc.indexOf('rootAbsT: tree', iCand));
    for (const f of ['fd:', 'seg:', 'plan:', 'rStartT:', 'chosen:']) {
        assert(candBlock.indexOf(f) >= 0, '③ candFd 每项缺 ' + f);
    }
}

// ===========================================================================
// ④ 模块级轨迹环必须有上限（不留内存尾巴）
// ===========================================================================
{
    assert(/var MAX_SCAN_TRACES = \d+;/.test(tSrc), '④ 必须有 MAX_SCAN_TRACES 上限');
    const sbSrc = fs.readFileSync(path.join(root, 'js', 'vantage_sandbox.js'), 'utf8');
    for (const f of ['getLastFusedBatchSummary','getFusedBatchAuditHistory','placements','contacts','deathFrames','_lastFusedBatchSummary','purpose','MAX_FUSED_AUDIT_HISTORY','geometry','proximity','sensor','minGap']) assert(sbSrc.indexOf(f)>=0, '④ 融合审计缺字段 '+f);
    assert(/_scanTraceRing\.length > MAX_SCAN_TRACES/.test(tSrc), '④ 轨迹环必须按上限裁剪');
}

console.log('diff_record_forensics PASS (v138 录制器取证不丢失 + 9 候选 fd/时间锚)');
