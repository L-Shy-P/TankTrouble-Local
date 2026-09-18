#!/usr/bin/env node
// Killfield 接线回归：管理器每帧把大脑输出提交给游戏 + local_patch/index 的接线点齐全。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const root = path.resolve(__dirname, '..');

// ---- 环境 stub ----
const sandbox = { console, Math, Date, JSON, Object, Array, Number, String, isFinite, Infinity, NaN, Promise, setTimeout };
sandbox.global = sandbox;
sandbox.InputState = {
    withState: function (aiId, forward, back, left, right, fire) {
        return {
            aiId, forward: !!forward, back: !!back, left: !!left, right: !!right, fire: !!fire,
            getForward() { return this.forward; }, getBack() { return this.back; },
            getLeft() { return this.left; }, getRight() { return this.right; }, getFire() { return this.fire; }
        };
    }
};
sandbox.VantageSandbox = { createAdapter: function (gc, id) { sandbox._adapterCreated = { gc, id }; return { fake: 'adapter' }; } };
let brainUpdates = 0, brainOpt = null;
sandbox.KillfieldBrain = {
    createKillfieldBrain: function (gc, myId, opt) {
        brainOpt = opt;
        return {
            update: function () { brainUpdates++; return { forward: true, back: false, left: false, right: true, fire: true, movement: 8 }; },
            reset: function () { brainUpdates = -999; }
        };
    }
};
const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js', 'ai_killfield.js'), 'utf8'), ctx, { filename: 'ai_killfield.js' });
const M = sandbox.KillfieldAIManager;
assert(M && M.create, 'KillfieldAIManager 必须挂到 global');

// ---- 假 gameController ----
const submitted = [];
const gc = {
    getId: () => 'game-kf',
    setInputState: (s) => submitted.push(s)
};

const m = M.create('killfield_1', { isKillfield: true }, gc);
assert.strictEqual(m.getAIId(), 'killfield_1', 'getAIId');
assert.strictEqual(m.getGameId(), 'game-kf', 'getGameId');

m.update(20);
assert.strictEqual(brainUpdates, 1, '每帧应当驱动大脑一次');
assert.strictEqual(submitted.length, 1, '每帧必须无条件提交一次输入');
assert.strictEqual(submitted[0].getForward(), true, '提交的输入要来自大脑（前进）');
assert.strictEqual(submitted[0].getRight(), true, '提交的输入要来自大脑（右转）');
assert.strictEqual(submitted[0].getFire(), true, '提交的输入要来自大脑（开火）');
assert(sandbox._adapterCreated && sandbox._adapterCreated.id === 'killfield_1',
    '应当用我们的适配器给大脑做轨迹模拟');
assert(brainOpt && brainOpt.adapter, '适配器要传给大脑');

m.reset();
assert.strictEqual(brainUpdates, -999, 'reset 应当透传到大脑');

// 大脑模块还没加载时（module 脚本未就绪）不该抛异常，只是这帧不动
const sandbox2 = Object.assign({}, sandbox);
sandbox2.global = sandbox2;
delete sandbox2.KillfieldBrain;
const ctx2 = vm.createContext(sandbox2);
vm.runInContext(fs.readFileSync(path.join(root, 'js', 'ai_killfield.js'), 'utf8'), ctx2, { filename: 'ai_killfield.js' });
const submitted2 = [];
const m2 = sandbox2.KillfieldAIManager.create('killfield_2', {}, { getId: () => 'g2', setInputState: (s) => submitted2.push(s) });
m2.update(20);
assert.strictEqual(submitted2.length, 1, '大脑未就绪时也要提交一次（全 0 输入，不抛异常）');
assert.strictEqual(submitted2[0].getForward(), false, '未就绪时应当是空输入');

// ---- 接线点静态断言 ----
const patch = fs.readFileSync(path.join(root, 'js', 'local_patch.js'), 'utf8');
[
    ["function addLobbyKillfieldPlayer()", '大厅添加函数'],
    ["function createLobbyKillfieldId()", 'id 生成'],
    ["function makeLobbyKillfieldPlayerDetails(", '显示名/外观'],
    ["'killfield_template'", '外观模板'],
    ["Users.addLobbyAIUser(aiId, 'killfield')", '第三种身份注册'],
    ["isKillfield: isVantage === 'killfield'", '大厅记录区分'],
    ["aiId.indexOf('killfield_') === 0", '管理器分流'],
    ["KillfieldAIManager.create(aiId, cfg, gameController)", '开局接管'],
    ["box.addUserKillfield", 'Add Killfield 按钮'],
    ["lobbyAIInfo.isKillfield", '大厅面板显示名'],
    ["AIs.ais[instanceId].isKillfield = true;", '实例标记']
].forEach(function (p) {
    assert(patch.indexOf(p[0]) >= 0, 'local_patch.js 缺少接线点：' + p[1] + '（找 ' + p[0] + '）');
});
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
['js/ai_killfield.js', 'external_ai/killfield/brain.js', 'window.KillfieldBrain'].forEach(function (needle) {
    assert(html.indexOf(needle) >= 0, 'index.html 必须加载 ' + needle);
});

console.log('diff_lobby_killfield PASS：Killfield 可作独立坦克（大厅按钮 + 开局管理器 + 每帧提交输入 + 大脑未就绪时安全降级）');
