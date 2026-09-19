#!/usr/bin/env node
// v119 回归：生长补偿（剪枝补偿 + 回退补偿）
// ---------------------------------------------------------------------------
// 主人定的口径：两类补偿都**默认开**、各给"每帧多长 1 层、持续 10 帧"，
// 高危场景里连续回退/剪枝时补偿要**叠加**（旧实现是覆盖，叠不上去），
// 叠加份数上限 10 → 每帧最多 1(基础) + 10 = 11 层节点。
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const treeSrc = fs.readFileSync(path.join(root, 'js', 'vantage_tree.js'), 'utf8');

const Constants = {BULLET: {RADIUS: {m: 0.25}, OFFSET: {m: 2.5}}, TANK: {WIDTH: {m: 3}, HEIGHT: {m: 4}}, MAZE_TILE_SIZE: {m: 10}, PIXELS_PER_METER: 20};
const sb = {console, performance, Math, JSON, Array, Object, String, Number, isFinite, parseInt, parseFloat, Infinity, NaN, Date, Constants};
sb.global = sb;
sb.VantageSandbox = {fusedEnabled: () => false, OPERATIONS: Array.from({length: 9}, (_, i) => ({name: 'op' + i, inputs: {forward: i === 1}}))};
const ctx = vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(root, 'js', 'vantage_scoring.js'), 'utf8'), ctx, {filename: 's.js'});
vm.runInContext(treeSrc, ctx, {filename: 't.js'});

const C = ctx.VantageTree._growBoost;
assert(C && typeof C.boostLayersOf === 'function', '缺少 _growBoost 调试钩子');
const FRAMES = 10;
const BASE = 1;

// ---- 1) 默认值：两类补偿默认开、层数 1、持续 10 帧（源码级钉死，防止被误改回去）----
const defs = [
    ['剪枝补偿层数默认 1', /var _pruneCompensateLayers = 1;/],
    ['剪枝补偿帧数默认 10', /var _pruneCompensateFrames = 10;/],
    ['回退补偿层数默认 1', /var _retreatCompensateLayers = 1;/],
    ['回退补偿帧数默认 10', /var _retreatCompensateFrames = 10;/],
    ['TREE_DEFAULTS 剪枝补偿层数 1', /pruneCompensateLayers: 1,/],
    ['TREE_DEFAULTS 剪枝补偿帧数 10', /pruneCompensateFrames: 10,/],
    ['TREE_DEFAULTS 回退补偿层数 1', /retreatCompensateLayers: 1,/],
    ['TREE_DEFAULTS 回退补偿帧数 10', /retreatCompensateFrames: 10,/],
    ['回退路径挂了补偿', /noteRetreatCompensation\(tree, 'leaf='/]
];
for (const [name, re] of defs) assert(re.test(treeSrc), '默认值/接线不符：' + name);

// ---- 2) 每帧上限 = 1(基础) + 10(补偿) = 11 层 ----
assert.strictEqual(C.layersCap(), 11, '每帧层数上限应为 11（基础 1 + 补偿 10）');
assert.strictEqual(C.maxStacks(), 10, '补偿最多叠 10 份');

// ---- 3) 单份补偿：1 层、持续 10 帧 ----
let t = C.makeTestTree();
assert.strictEqual(C.boostLayersOf(t), 0, '新树不该有补偿');
assert.strictEqual(C.notePruneOn(t, 1, FRAMES), 1, '剪枝补偿应返回 1 层');
assert.strictEqual(C.boostLayersOf(t), BASE, '一份 1 层补偿 → 多长 1 层');
for (let i = 0; i < FRAMES - 1; i++) C.consumeTickOn(t);
assert.strictEqual(C.boostLayersOf(t), BASE, '第 9 帧仍在补偿期内（应还有 1 层）');
C.consumeTickOn(t);
assert.strictEqual(C.boostLayersOf(t), 0, '第 10 帧后补偿应清零');
assert.strictEqual(C.stacksOf(t).length, 0, '清零后不该残留补偿栈');

// ---- 4) 叠加：连续三次事件应叠成 3 层（旧实现只会覆盖成 1 层）----
t = C.makeTestTree();
for (let i = 0; i < 3; i++) C.notePruneOn(t, 1, FRAMES);
assert.strictEqual(C.boostLayersOf(t), 3, '三次 1 层补偿应叠成 3 层');

// ---- 5) 上限：叠到 10 层封顶（≥11 份也只给 10），且总层数 = 11 ----
t = C.makeTestTree();
for (let i = 0; i < 15; i++) C.notePruneOn(t, 1, FRAMES);
assert.strictEqual(C.boostLayersOf(t), 10, '叠加份数上限 10 层');
assert.strictEqual(C.stacksOf(t).length, 10, '补偿栈最多 10 份');
assert.strictEqual(BASE + C.boostLayersOf(t), C.layersCap(), '基础 + 补偿 = 每帧 11 层');

// ---- 6) 回退补偿：走 tree.cfg 的默认口径，与剪枝补偿同款 ----
t = C.makeTestTree();
t.cfg = {retreatCompensateLayers: 1, retreatCompensateFrames: 10};
assert.strictEqual(C.noteRetreatOn(t, 'n1'), 1, '回退补偿应给 1 层');
assert.strictEqual(C.boostLayersOf(t), 1, '回退补偿应生效');
// 关掉（层数 0）时不该产生任何补偿
t = C.makeTestTree();
t.cfg = {retreatCompensateLayers: 0, retreatCompensateFrames: 10};
assert.strictEqual(C.noteRetreatOn(t, 'n2'), 0, '层数 0 = 关闭，不该补偿');
assert.strictEqual(C.boostLayersOf(t), 0, '关闭时补偿应为 0');

// ---- 7) 切片/危险路径不允许出现"叠不满"的旧字段 ----
assert.strictEqual(treeSrc.indexOf('tree._growBoost ='), -1, '旧的单份 _growBoost 字段应已全部换成栈');

// ---- 8) v119 接线：融合世界不许再静默丢弹；树侧要传"现在"锚点 ----
const sbSrc = fs.readFileSync(path.join(root, 'js', 'vantage_sandbox.js'), 'utf8');
assert(sbSrc.indexOf('getFusedDropStats') >= 0, '沙箱应暴露融合世界丢弹统计');
assert(/noThreat: 0,/.test(sbSrc) && /approxPlaced: 0,/.test(sbSrc), '沙箱应有近似摆放/无威胁条目计数');
// 旧的静默丢弃写法（!placed 后直接 SetActive(false) 就 continue）必须已不存在
assert(!/if \(!placed\) \{\s*slot\.body\.SetActive\(false\);\s*slot\.lastRound = -1;\s*continue;/.test(sbSrc),
    '静默丢弹的老写法必须已删除（铁律：静默跳过的路径不可接受）');
assert(sbSrc.indexOf('fusedDropLog(') >= 0, '丢弹必须有响亮日志出口');
assert(/nowTGlobal/.test(sbSrc), '沙箱应使用 nowTGlobal 把真实弹位姿前推到节点起点');
assert(treeSrc.indexOf('nowTGlobal: nowTGlobalOf(tree)') >= 0, '树侧融合调用应带 nowTGlobal');
assert(treeSrc.indexOf('var scanThreats = unionThreats(tree.threats, pending);') >= 0,
    'scanNodeDeath 必须把 pending 并进扫描威胁表（原来 pending 是死参数）');
assert(treeSrc.indexOf('function nowTGlobalOf(tree)') >= 0 && treeSrc.indexOf('function unionThreats(a, b)') >= 0,
    '缺少 nowTGlobalOf / unionThreats 助手');

// ---- 10) v121 轨迹环：记录/裁剪/上限/字段 ----
const ST = ctx.VantageTree._scanTrace;
assert(ST && typeof ST.record === 'function', '缺少 _scanTrace 调试钩子');
const fakeTree = {diag: {}, stats: {}, nodeCount: 0};
const node = {id: 7, opName: 'op3', plannedFrames: 3, segmentFrames: 3, fullDeathFrame: 6};
const frames = Array.from({length: 40}, (_, i) => ({k: i, x: i * 0.1, y: 0, bs: [{id: 'b1', x: i, y: i}]}));
ST.record(fakeTree, node, 6, frames);
let ring = ST.ring(fakeTree);
assert.strictEqual(ring.length, 1, '应记录一条轨迹');
assert.strictEqual(ring[0].frames.length, 25, '每条轨迹最多留 25 帧');
assert.strictEqual(ring[0].scanDeath, 6, 'scanDeath 应被记录');
assert.strictEqual(ring[0].nodeId, 7, 'nodeId 应被记录');
assert.strictEqual(ring[0].op, 'op3', 'op 应被记录');
assert.strictEqual(ring[0].frames[1].bs[0].id, 'b1', '子弹条目应带 id（对拍用）');
for (let i = 0; i < 20; i++) ST.record(fakeTree, node, i, frames);
assert.strictEqual(ST.ring(fakeTree).length, 12, '轨迹环最多留 12 条');

// ---- 11) v122 时间基准取证接线 ----
const TR3 = fs.readFileSync(path.join(root, 'js', 'vantage_tree.js'), 'utf8');
assert(TR3.indexOf('bulletErr: (tree && tree.diag') >= 0, '逐帧记录必须带 bulletErr（轨迹 vs 真实弹位误差）');
assert(TR3.indexOf('bulletErrId') >= 0, '逐帧记录必须带出误差最大的弹 id');
assert(TR3.indexOf('abs0: Math.round((rT + (th.anchorOffset || 0))') >= 0, '逐帧记录必须带每弹锚点 abs0');
assert(TR3.indexOf("recordScanTrace(tree, null, null, rollTrace, 'rollout')") >= 0,
    '九候选打分那条 rollout 路径也必须采轨迹（这才是产出 fd 的地方）');
assert(TR3.indexOf('var rollTrace = _rec.on ? [] : null') >= 0, 'rollout 轨迹只在开录时采（常态零开销）');
assert(TR3.indexOf('d.lastBulletErrorId = worstId;') >= 0, '诊断里要存下误差最大的弹 id');
const SB3 = fs.readFileSync(path.join(root, 'js', 'vantage_sandbox.js'), 'utf8');
assert(SB3.indexOf("slot.srcInfo = { src: 'real'") >= 0, '沙箱要记录摆位来源=real');
assert(SB3.indexOf("src: (th.track && th.track.length) ? 'track' : 'path'") >= 0, '沙箱要记录 track/path 摆位基准');
assert(SB3.indexOf('off: si.off') >= 0 && SB3.indexOf('idx: si.idx') >= 0, '轨迹帧要带 anchorOffset 与 track 下标');
assert(fs.readFileSync(path.join(root, 'rust', 'trace_diff.py'), 'utf8').indexOf('bulletErr') >= 0,
    '对拍脚本要能读 bulletErr');

console.log('PASS：两类补偿默认开(1层/10帧) ＋ 连续事件叠加(3份=3层) ＋ 上限10份=每帧11层 ＋ 10帧后清零 ＋ 关闭时为零');
