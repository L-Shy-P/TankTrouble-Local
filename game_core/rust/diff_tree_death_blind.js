#!/usr/bin/env node
// v137 回归：「树显示完全安全但 AI 死了」的四个漏判点
// ---------------------------------------------------------------------------
// 主人实测：把角度遮蔽评分关掉（只用杀戮场）后，出现"树里全绿、却当场被打死"。
// 按主人点的四类排查（时间错位 / 真死粗筛 / 物理引擎错位 / 子弹状态陈旧）
// 逐条对账，抓到四个互相独立的"死亡权威失明"点。这个文件把四条全部钉住。
//
// 为什么关掉遮蔽才暴露：遮蔽分是死权之外的第二张安全网（子弹 3.05m 内给低分、
// 把 AI 推开），死权漏判时它在兜底；关掉后 9 个操作的存活帧都是满分 (2π)²，
// 唯一知道子弹在哪的就是死亡帧，漏判直接裸露成绿节点死亡。
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

const VS = sb.VantageScoring;
const VT = sb.VantageTree;
const C = VT._coarse;

// ===========================================================================
// ① 时间错位：轨迹下标必须按**这条轨迹自带的 trackFrameDt**，不是全局 FRAME_DT
// ===========================================================================
// 构造一条帧长 0.04s 的轨迹（track[i].x = i*10，位置差异大到能一眼看出下标）。
// 查询 q=0.2s：按 trackFrameDt=0.04 → idx=5 → x=50；
// 旧代码按全局 FRAME_DT=0.02 → idx=10 → x=100（读成快一倍的弹道）。
{
    const track = [];
    for (let i = 0; i <= 30; i++) track.push({ x: i * 10, y: 0, alive: true });
    const th = { id: 'dt1', speed: 250, anchorOffset: 0, track, trackFrameDt: 0.04 };

    // —— 评分侧（VantageScoring.threatBulletPos）——
    const adapter = { constants: { FRAME_DT: 0.02 }, bulletPosAt: () => null };
    const p = VS.threatBulletPos(adapter, th, 0.2);
    assert(p, '① 评分侧应当查到弹位');
    assert.strictEqual(Math.round(p.x), 50,
        '① 评分侧下标必须按 trackFrameDt=0.04 算（q=0.2 → idx=5 → x=50），实际 x=' + p.x +
        '（=按全局 FRAME_DT 读成快一倍的弹道，正是"时间错位"）');

    // —— 树侧（threatCurrentPoint）——
    C.setNow(0.2, 0);
    const pc = C.threatCurrentPoint(th);
    assert(pc, '① 树侧应当查到子弹当前位置');
    assert.strictEqual(Math.round(pc.x), 50,
        '① 树侧 threatCurrentPoint 必须按 trackFrameDt 算，实际 x=' + pc.x);
}

// ===========================================================================
// ② 真死粗筛假阴：粗盒不许被 alive 标志截断，也不许坐标被抹掉
// ===========================================================================
{
    // 轨迹中段 alive=false：旧代码 `if (p.alive === false) break` 直接把盒子截断，
    // 后半段弹道根本不进时空粗筛 → bulletCannotReach 误判"打不到" → 跳过死亡重扫。
    const track = [
        { x: 0, y: 0, alive: true },
        { x: 50, y: 0, alive: true },
        { x: 100, y: 0, alive: false },
        { x: 200, y: 0, alive: false },
        { x: 300, y: 0, alive: true }
    ];
    const th = { id: 'alive1', speed: 10, anchorOffset: 0, track, trackFrameDt: 0.02 };
    const box = C.threatCoarseBox(th, 0);
    assert.strictEqual(Math.round(box.maxX), 300,
        '② 粗盒必须覆盖整条轨迹（含 alive=false 段），实际 maxX=' + box.maxX +
        '（=被 alive 标志截断，后半段弹道不进粗筛）');
    // 粗盒只许假阳不许假阴：minX/maxX 必须覆盖所有点
    assert(box.minX <= 0 && box.maxX >= 300, '② 粗盒范围必须覆盖全部轨迹点');

    // 评分侧：alive=false 不该抹掉一个真实弹位（否则评分/死权看到的弹不是同一颗）
    const adapter = { constants: { FRAME_DT: 0.02 }, bulletPosAt: () => null };
    const p2 = VS.threatBulletPos(adapter, th, 0.02 * 2);
    assert(p2, '② alive=false 的轨迹点仍应给出弹位（坐标永远有效）');
    assert.strictEqual(Math.round(p2.x), 100, '② alive=false 不该抹掉弹位，实际 x=' + p2.x);
}

// ===========================================================================
// ③ 子弹状态陈旧：摆弹阶段不许因 lifeLeft<=0 把整颗弹关掉
// ===========================================================================
// 这颗弹"现在还活着，但到这个未来节点已经/即将到期"。旧写法
//     slot.active = initialSpeed > 0 && lifeLeft > 0
// 会把它在**仍然存活的那几帧**里从融合世界整颗抹掉 → 死权失明 → fd=-1 绿节点。
{
    const sbSrc = fs.readFileSync(path.join(root, 'js', 'vantage_sandbox.js'), 'utf8');

    // 主分支（placed）的 active 判定必须只看速度
    assert(/slot\.active = slot\.initialSpeed > 0;[\s\S]{0,80}?if \(!slot\.active\)/.test(sbSrc),
        '③ simulateFusedBatch 摆弹后 active 必须只看 initialSpeed（不得再 && lifeLeft>0）');
    assert(!/slot\.active = slot\.initialSpeed > 0 && slot\.lifeLeft > 0;/.test(sbSrc),
        '③ 旧写法 `active = speed>0 && lifeLeft>0` 必须已删除');

    // Rust 两个同源副本
    const rollSrc = fs.readFileSync(path.join(root, 'rust', 'vantage_core', 'src', 'rollout.rs'), 'utf8');
    assert(/let slot_active = initial_speed > 0\.0;/.test(rollSrc),
        '③ rollout.rs 的 slot_active 必须只看 initial_speed');
    assert(!/slot_active = initial_speed > 0\.0 && life_left > 0\.0/.test(rollSrc),
        '③ rollout.rs 旧写法必须已删除');

    const reSrc = fs.readFileSync(path.join(root, 'rust', 'vantage_core', 'src', 'rescore.rs'), 'utf8');
    assert(/let active = initial_speed > 0\.0;/.test(reSrc),
        '③ rescore.rs 验证世界的 active 必须只看 initial_speed');
    assert(!/let active = initial_speed > 0\.0 && life_left > 0\.0;/.test(reSrc),
        '③ rescore.rs 旧写法必须已删除');

    // 逐帧到期退场的机制必须还在（active 只是不再"提前整颗关掉"）
    assert(/bs\.lifeLeft -= FRAME;/.test(sbSrc), '③ 逐帧 lifeLeft 递减退场必须保留');
    assert(/slot\.life_left -= FRAME_DT;/.test(rollSrc), '③ rollout.rs 逐帧 life_left 递减必须保留');
}

// ===========================================================================
// ④ 物理引擎错位：Rust 写死 0.02、JS 校准后不一致时不许走 Rust 快路
// ===========================================================================
{
    const sbSrc = fs.readFileSync(path.join(root, 'js', 'vantage_sandbox.js'), 'utf8');
    assert(sbSrc.indexOf('function rustFrameDtCompatible()') >= 0,
        '④ 必须有 rustFrameDtCompatible 护栏');
    assert(/if \(!rustFrameDtCompatible\(\)\) return null;/.test(sbSrc),
        '④ Rust 快路入口必须有帧步长护栏');

    // 三个 Rust 入口都要挂到护栏
    const entries = ['simulateRustBatch', 'simulateTankBatchScored', 'rescoreTankSamples'];
    for (const e of entries) {
        const i = sbSrc.indexOf('function ' + e) >= 0 ? sbSrc.indexOf('function ' + e) : sbSrc.indexOf(e + ': function');
        assert(i >= 0, '④ 找不到 Rust 入口 ' + e);
        const seg = sbSrc.slice(i, i + 900);
        assert(seg.indexOf('rustFrameDtCompatible()') >= 0, '④ ' + e + ' 必须挂帧步长护栏');
    }

    // Rust 核心确实写死 0.02（护栏存在的前提）
    const rollSrc = fs.readFileSync(path.join(root, 'rust', 'vantage_core', 'src', 'rollout.rs'), 'utf8');
    const reSrc = fs.readFileSync(path.join(root, 'rust', 'vantage_core', 'src', 'rescore.rs'), 'utf8');
    assert(/pub const FRAME_DT: f64 = 0\.02;/.test(rollSrc), '④ rollout.rs 的 FRAME_DT 应是写死的 0.02');
    assert(/pub const RESCORE_DT: f64 = 0\.02;/.test(reSrc), '④ rescore.rs 的 RESCORE_DT 应是写死的 0.02');
}

// ===========================================================================
// ⑤ 统一入口：trackDtOf 是唯一取轨迹帧长的地方，别再散写 FRAME_DT
// ===========================================================================
{
    const tSrc = fs.readFileSync(path.join(root, 'js', 'vantage_tree.js'), 'utf8');
    assert(tSrc.indexOf('function trackDtOf(th)') >= 0, '⑤ 缺少 trackDtOf 统一入口');
    // 这四处曾散写 FRAME_DT，必须改成 trackDtOf
    for (const [name, re] of [
        ['threatCurrentPoint 下标', /Math\.round\(elapsed \/ trackDtOf\(th\)\)/],
        ['threatCoarseBox 时间窗', /box\.t1 = box\.t0 \+ th\.track\.length \* trackDtOf\(th\)/],
        ['nodeWindowSig 时间窗', /t1 = t0 \+ th\.track\.length \* trackDtOf\(th\)/]
    ]) {
        assert(re.test(tSrc), '⑤ ' + name + ' 必须用 trackDtOf');
    }
    const sSrc = fs.readFileSync(path.join(root, 'js', 'vantage_scoring.js'), 'utf8');
    assert(/th\.trackFrameDt && th\.trackFrameDt > 0\) \? th\.trackFrameDt/.test(sSrc),
        '⑤ VantageScoring.threatBulletPos 必须优先用 trackFrameDt');
}

console.log('diff_tree_death_blind PASS (v137 四个死权失明点 + trackDtOf 收敛)');
