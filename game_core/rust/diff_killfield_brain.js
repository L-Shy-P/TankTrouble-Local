#!/usr/bin/env node
// Killfield 粗版大脑回归：见弹会躲、对准会开火、没威胁会走位、卡墙会脱困。
// 用假适配器 + 假 gameController，脱离页面也能验行为。
'use strict';
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');
const dir = path.resolve(__dirname, '..', 'external_ai', 'killfield');
const TILE = 10, DT = 0.02;
const SPEED = 20;          // 米/秒
const TANK_SPEED = 4;      // 米/秒
const TURN_RATE = 1.6;     // 弧度/秒

// ---- 假适配器：按 (油门, 转向) 做运动学模拟，返回 9 条轨迹 ----
function makeFakeAdapter() {
    return {
        simulateTankBatch: function (state, ops, frames) {
            return ops.map(function (op) {
                var throttle = op.throttle, turn = op.turn;
                var rot = state.rot, x = state.x, y = state.y;
                var samples = [{ x: x, y: y, rot: rot }];
                for (var k = 1; k <= frames; k++) {
                    rot += (turn - 1) * TURN_RATE * DT;
                    var v = (throttle - 1) * TANK_SPEED * DT;
                    x += Math.sin(rot) * v;
                    y += -Math.cos(rot) * v;
                    samples.push({ x: x, y: y, rot: rot });
                }
                return { samples: samples, dead: false, deathFrame: -1, totalScore: 0 };
            });
        }
    };
}

function makeGc(state) {
    var tanks = {
        'me': {
            getX: function () { return state.me.x; },
            getY: function () { return state.me.y; },
            getRotation: function () { return state.me.rot; },
            getB2DBody: function () { return null; }
        },
        'foe': {
            getX: function () { return state.enemy.x; },
            getY: function () { return state.enemy.y; },
            getRotation: function () { return state.enemy.rot; },
            getB2DBody: function () { return null; }
        }
    };
    return {
        getTank: function (id) { return tanks[id]; },
        getTanks: function () { return tanks; },
        getMaze: function () {
            return {
                getWidth: function () { return 12; },
                getHeight: function () { return 10; },
                isPositionInsideMaze: function (t) {
                    return t && t.x > 0 && t.y > 0 && t.x < 11 && t.y < 9;
                }
            };
        },
        getProjectiles: function () { return state.projectiles || {}; }
    };
}

function makeBullet(x, y, vx, vy) {
    return {
        getX: () => x, getY: () => y,
        getSpeedX: () => vx, getSpeedY: () => vy,
        getPlayerId: () => 'foe',
        bounces: [], lifetime: 3, timeAlive: 0,
        done: () => false
    };
}

async function main() {
    const { createKillfieldBrain } = await import(pathToFileURL(path.join(dir, 'brain.js')).href);

    // ---------- ① 见弹就躲：子弹从正前方 8 米处朝我飞来 ----------
    {
        // 我朝上（rot=0 → 朝向 (0,-1)）；子弹在我前方 8 米，朝下（+y）飞向我
        const state = {
            me: { x: 55, y: 55, rot: 0 },
            enemy: { x: 95, y: 55, rot: 0 },
            projectiles: { p1: makeBullet(55, 47, 0, SPEED) }
        };
        const gc = makeGc(state);
        const brain = createKillfieldBrain(gc, 'me', { adapter: makeFakeAdapter(), tileM: TILE });
        let picked = new Set();
        for (let i = 0; i < 12; i++) picked.add(brain.update(DT).movement);
        // 前进档（6/7/8 = 往子弹里冲）不该是唯一选择；而且必须出现过非前进的选择
        const fwdOps = [6, 7, 8];
        const hasNonForward = Array.from(picked).some((m) => fwdOps.indexOf(m) < 0);
        assert(hasNonForward, '子弹正朝我飞来时必须选过"不往前冲"的走法，实际只选了 ' + Array.from(picked).join(','));
    }

    // ---------- ② 对准就开火：我和敌人在同一行，我正好朝它 ----------
    {
        const state = {
            me: { x: 55, y: 55, rot: Math.PI / 2 },      // 朝向 +x
            enemy: { x: 95, y: 55, rot: 0 },
            projectiles: {}
        };
        const gc = makeGc(state);
        const brain = createKillfieldBrain(gc, 'me', { adapter: makeFakeAdapter(), tileM: TILE });
        const a = brain.update(DT);
        assert.strictEqual(a.fire, true, '对准敌人时应当开火（本帧按下的键：' + JSON.stringify(a) + '）');
        assert(brain.stats.fires >= 1, '开火计数应当增加');
        // 冷却：紧接着的下一帧不该连发
        assert.strictEqual(brain.update(DT).fire, false, '开火应当有冷却，不能每帧连发');
    }

    // ---------- ③ 没威胁时会走位（不是一直静止） ----------
    {
        const state = {
            me: { x: 55, y: 55, rot: Math.PI / 2 },
            enemy: { x: 95, y: 55, rot: 0 },
            projectiles: {}
        };
        const gc = makeGc(state);
        const brain = createKillfieldBrain(gc, 'me', { adapter: makeFakeAdapter(), tileM: TILE });
        const moves = [];
        for (let i = 0; i < 8; i++) moves.push(brain.update(DT).movement);
        assert(moves.some((m) => m !== 4), '没威胁时也该动（去更好的射击位），实际全是静止');
    }

    // ---------- ④ 卡墙脱困：位置一直不动，几帧后应当强制转向 ----------
    {
        const state = {
            me: { x: 55, y: 55, rot: Math.PI / 2 },
            enemy: { x: 95, y: 55, rot: 0 },
            projectiles: {}
        };
        const gc = makeGc(state);           // 坦克位置永远不变
        const brain = createKillfieldBrain(gc, 'me', { adapter: makeFakeAdapter(), tileM: TILE });
        const seen = [];
        for (let i = 0; i < 12; i++) seen.push(brain.update(DT).movement);
        // 卡住满 6 帧的那一帧会强制选"前右"（之后计数清零，所以不是每帧都强制）
        assert(seen.indexOf(8) >= 0, '连续卡住之后应当强制选"前右"脱困，实际选择 ' + seen.join(','));
    }

    // ---------- ⑤ 预算与统计：逆杀戮场每帧最多建 1 格 ----------
    {
        const state = {
            me: { x: 55, y: 55, rot: 0 },
            enemy: { x: 95, y: 55, rot: 0 },
            projectiles: {}
        };
        const gc = makeGc(state);
        const brain = createKillfieldBrain(gc, 'me', { adapter: makeFakeAdapter(), tileM: TILE });
        for (let i = 0; i < 10; i++) brain.update(DT);
        assert(brain.stats.fieldBuilds <= 10, '每帧最多建 1 格：10 帧最多 10 次，实际 ' + brain.stats.fieldBuilds);
        assert(brain.stats.fieldBuilds >= 1, '至少建过一次密度场');
        assert.strictEqual(brain.stats.frames, 10, '帧计数');
        assert(brain.getField(), '密度场应当挂着');
    }

    console.log('diff_killfield_brain PASS：见弹会躲（换过走法）＋对准会开火（带冷却）＋没威胁会走位＋卡墙会脱困＋密度场按帧预算建');
}

main().catch(function (e) { console.error('diff_killfield_brain FAIL: ' + (e && e.stack || e)); process.exit(1); });
