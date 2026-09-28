#!/usr/bin/env node
// v139 回归：refineBeyondLimits 细化长段**不许把父节点的死亡结论伪造为绿节点**
// ---------------------------------------------------------------------------
// 主人实测（vantage_record_1790571239645.json）："都已经死了，结果红节点延伸出
// 几个绿的"。定位到 splitLongSegmentLeaf：把长叶切成前缀叶时无条件写
//     newNode.status='alive'; newNode.fullDeathFrame=-1; rolloutDeathFrame=-1;
// 于是带 fd 的节点被切短后，前缀被涂成绿（fd=-1），挂在同一父层。
// 那不是新的物理模拟结论，只是把旧 rolloutSamples 切片，不能伪造存活。
//
// 三条语义：
//   ① 父 fd 落在前缀**之后** → 前缀继承父 fd（不是 -1），status 仍 alive；
//   ② 父 fd 落在前缀**之内** → 前缀截短到 safeFramesForDeath，status=dead；
//   ③ 父本来就是绿（fd=-1）→ 前缀照旧绿（原行为不变）。
//
// 场景构造沿用 diff_tree_refine_split.js 的成功路径：
//   叶子 tEndSec 超出 horizonSec=8 → 不可正常生长 → refine split 才被触发。
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const assert = require('assert');
const root = path.resolve(__dirname, '..');

const Constants = {BULLET:{RADIUS:{m:0.25},OFFSET:{m:2.5}},TANK:{WIDTH:{m:3},HEIGHT:{m:4}},BULLET_TURRET:{WIDTH:{m:0.7},HEIGHT:{m:1.4},OFFSET_X:{m:0},OFFSET_Y:{m:-2}},LASER_TURRET:{ANTENNA_WIDTH:{m:0.1},ANTENNA_HEIGHT:{m:1.4},ANTENNA_OFFSET_X:{m:0},ANTENNA_OFFSET_Y:{m:-2},DISH_WIDTH:{m:2},DISH_HEIGHT:{m:0.5},DISH_OFFSET_X:{m:0},DISH_OFFSET_Y:{m:-1.85}},DOUBLE_BARREL_TURRET:{WIDTH:{m:1.6},HEIGHT:{m:1.1},OFFSET_X:{m:0},OFFSET_Y:{m:-1.75}},SHOTGUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MISSILE_TURRET:{WIDTH:{m:0.3},CENTER_HEIGHT:{m:1.4},SIDE_HEIGHT:{m:0.4},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},GATLING_GUN_TURRET:{WIDTH:{m:1.4},HEIGHT:{m:1.35},OFFSET_X:{m:0},OFFSET_Y:{m:-1.95}},MAZE_TILE_SIZE:{m:10}};
const sandbox = {console,performance,Math,JSON,Array,Object,String,Number,isFinite,parseInt,parseFloat,Infinity,NaN,Date,Constants};
sandbox.global = sandbox;
sandbox.VantageSandbox = {
    fusedEnabled: () => true,
    OPERATIONS: Array.from({ length: 9 }, (_, i) => ({
        name: 'op' + i, inputs: { forward: i === 1, back: i === 2, left: i === 3, right: i === 4 }
    }))
};
const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js', 'vantage_scoring.js'), 'utf8'), ctx, { filename: 's.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'js', 'vantage_tree.js'), 'utf8'), ctx, { filename: 't.js' });
const VT = sandbox.VantageTree;

const adapter = {
    constants: { FRAME_DT: 0.02 },
    simulateTankBatch: function (state, ops, frames) {
        return ops.map(() => ({
            samples: Array.from({ length: frames + 1 }, (_, k) => ({
                x: state.x + k * 0.01, y: state.y, rot: state.rot
            })),
            hitWall: false, dead: false, deathFrame: -1
        }));
    }
};

function run(fd, segFrames) {
    VT.setGrowWithoutThreatsEnabled(true);
    VT.setRefineBeyondLimits(true);
    const tree = VT.createTree({ x: 0, y: 0, rot: 0 });
    tree.rootAbsT = 0;
    tree.root.simState = { tank: { x: 0, y: 0, rot: 0 }, tGlobal: 0 };
    tree.root.tEndSec = 0;
    tree.threats = [];
    tree._hasOffsetThreats = false;
    tree._pendingThreats = [];

    const leaf = VT.createTreeNode(tree.root,
        { forward: true, back: false, left: false, right: false },
        { tank: { x: 0, y: 0, rot: 0 }, tGlobal: 8.1 });
    leaf.status = 'alive';          // 软死但段内不死 -> 不触发 pickGrowLeaf 的 retreat 分支
    leaf.fullDeathFrame = fd;
    leaf.rolloutDeathFrame = fd;
    leaf.fullDead = fd >= 0;
    leaf.rolloutSamples = Array.from({ length: segFrames + 6 }, (_, k) => ({ x: k * 0.1, y: 0, rot: 0 }));
    leaf.perFrameScores = Array(segFrames).fill(1);
    leaf.plannedFrames = segFrames;
    leaf.segmentFrames = segFrames;
    leaf.rolloutStartT = 8.1;
    leaf.tEndSec = 8.3;             // 超出 horizonSec=8 -> 不可正常生长
    leaf.deathAuthority = 'fused';
    VT.attachChild(tree, tree.root, leaf);

    VT.growStep(tree, adapter, []);
    const kid = tree.root.children.find(c => c !== leaf && c._refineSplit === false);
    return { tree: tree, leaf: leaf, kid: kid };
}

// === (1) 父 fd=13，splitAt=5 -> 死亡在前缀之后 -> 前缀必须继承 fd=13 ===
{
    const r = run(13, 10);
    assert(r.kid, '(1) refine split should create a prefix node');
    assert.strictEqual(r.kid.fullDeathFrame, 13,
        '(1) prefix must inherit fd=13, got ' + r.kid.fullDeathFrame +
        ' (-1 would be the "red node extends green children" bug)');
    assert.strictEqual(r.kid.rolloutDeathFrame, 13, '(1) rolloutDeathFrame must inherit');
    assert.strictEqual(r.kid.status, 'alive', '(1) death beyond prefix -> prefix alive');
    assert.strictEqual(r.kid.fullDead, true, '(1) fullDead must inherit');
    assert.strictEqual(r.kid.segmentFrames, 5, '(1) prefix not shortened, expect splitAt=5');
}

// === (2) 父 fd=3，splitAt=5 -> 死亡落在前缀之内 -> 截短 + dead ===
{
    const r = run(3, 10);
    assert(r.kid, '(2) refine split should create a prefix node');
    assert.strictEqual(r.kid.fullDeathFrame, 3, '(2) prefix must inherit fd=3, got ' + r.kid.fullDeathFrame);
    assert.strictEqual(r.kid.status, 'dead', '(2) fd=3 inside prefix -> dead, got ' + r.kid.status);
    // safeFramesForDeath(fd=3, planned=5) = min(2, max(1, floor(1.5)=1), 5) = 1
    assert.strictEqual(r.kid.segmentFrames, 1,
        '(2) shorten to safe frame 1, got ' + r.kid.segmentFrames);
}

// === (3) 父 fd=-1 -> 前缀照旧绿 ===
{
    const r = run(-1, 10);
    assert(r.kid, '(3) refine split should create a prefix node');
    assert.strictEqual(r.kid.fullDeathFrame, -1, '(3) green parent keeps green prefix');
    assert.strictEqual(r.kid.status, 'alive', '(3) green parent prefix alive');
    assert.strictEqual(r.kid.segmentFrames, 5, '(3) prefix = splitAt=5');
}

// === (4) 铁律：fd<=1（真死）节点绝不许有子节点 ===
// 注：绿子挂在**软死（fd=2..75）**父节点下是 v83 的设计，也正是主人定的口径
//     （"只要还有任何操作能活 >=2 帧，就该建新节点、评估 9 个操作"）。
//     所以不变量只锁真死节点，不锁软死节点。
{
    for (const fd of [-1, 0, 1, 2, 3, 4, 6, 8, 13, 20]) {
        const r = run(fd, 10);
        const stack = [r.tree.root];
        while (stack.length) {
            const n = stack.pop();
            const nfd = (typeof n.fullDeathFrame === 'number') ? n.fullDeathFrame : -1;
            if (nfd >= 0 && nfd <= 1) {
                assert.strictEqual((n.children || []).length, 0,
                    '(4) terminal-dead node (fd=' + nfd + ') must have no children, n' + n.id);
            }
            for (const c of (n.children || [])) stack.push(c);
        }
    }
}

// === (5) 软死父节点下允许绿子（记录在案的合法语义，防止后人当 bug 改掉）===
{
    const r = run(3, 10);
    const kid = r.kid;
    assert(kid, '(5) prefix node should exist');
    // 前缀继承 fd=3 后，从安全末帧继续展开的 9 个子候选里出现 fd=-1 是合法的：
    // 换个操作可能躲开子弹。这里只确认"允许"，不强制数量。
    const anyGreen = (kid.children || []).some(c => c.fullDeathFrame === -1);
    const anyActive = (kid.children || []).length > 0;
    assert(anyActive, '(5) soft-dead prefix is allowed to grow children');
    console.log('  (5) soft-dead prefix children=' + kid.children.length +
        ' green=' + (anyGreen ? 'yes' : 'no') + ' (both legal)');
}

console.log('diff_tree_refine_split_death_inherit PASS (v139 refine inherits death frame, no fake green)');
