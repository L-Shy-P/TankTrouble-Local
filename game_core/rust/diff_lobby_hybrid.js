#!/usr/bin/env node
// 外接 AI · 接线回归：Hybrid 作为「独立坦克」进大厅 → 开局造 HybridAIManager → 每帧提交输入。
//   · 用 stub 的 InputState/GameController/策略跑通 HybridAI/HybridAIManager 的一帧；
//   · 再对 local_patch.js / index.html 做"接线点"静态断言（防止以后被误删）。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.resolve(__dirname, '..');

function fail(msg) { throw new Error(msg); }

// ---------------------------------------------------------------- 环境 stub
const sandbox = { console, Math, Date, JSON, Object, Array, Number, String, isFinite, Infinity, NaN, Float32Array, Promise, setTimeout };
sandbox.global = sandbox;
sandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
sandbox.InputState = {
  withState: function (aiId, forward, back, left, right, fire) {
    return {
      aiId: aiId, forward: !!forward, back: !!back, left: !!left, right: !!right, fire: !!fire,
      getForward: function () { return this.forward; },
      getBack: function () { return this.back; },
      getLeft: function () { return this.left; },
      getRight: function () { return this.right; },
      getFire: function () { return this.fire; }
    };
  }
};
const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js', 'external_ai_hybrid.js'), 'utf8'), ctx, { filename: 'external_ai_hybrid.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'js', 'ai_hybrid.js'), 'utf8'), ctx, { filename: 'ai_hybrid.js' });
const X = sandbox.VantageExternalHybrid;
assert(X, '观测构造器必须挂在 global 上');
assert(sandbox.HybridAI && sandbox.HybridAIManager, 'HybridAI / HybridAIManager 必须挂在 global 上');

// ---------------------------------------------------------------- 假对局
const MAZE_W = 12, MAZE_H = 10, TILE = 10;
const maze = {
  getWidth: () => MAZE_W, getHeight: () => MAZE_H,
  isPositionInsideMaze: (t) => t && t.x > 0 && t.y > 0 && t.x < MAZE_W - 1 && t.y < MAZE_H - 1
};
function mkTank(x, y, rot) {
  return { getX: () => x, getY: () => y, getRotation: () => rot, getB2DBody: () => null };
}
const meTank = mkTank(5 * TILE + 5, 5 * TILE + 5, 0);
const oppTank = mkTank(8 * TILE + 5, 3 * TILE + 5, 1.2);
const submitted = [];
let applied = null;
const gameController = {
  getId: () => 'game-1',
  getTank: (id) => (String(id) === 'hybrid_1' ? meTank : undefined),
  getTanks: () => ({ 'p_human': oppTank, 'hybrid_1': meTank }),
  getMaze: () => maze,
  getProjectiles: () => ({}),
  getActiveWeapon: () => null,
  setInputState: (s) => { submitted.push(s); applied = s; }
};

// 假策略：永远选 16（前右）。真实模型已在 diff_external_hybrid(_obs) 里验过。
const fakePolicy = {
  manifest: { schema: 24, observation: 1028, actions: 18 },
  act: (obs, mask, dodge) => 16
};
let loadCalled = 0;
sandbox.HybridPolicy = {
  load: function (manifestUrl, weightsUrl) {
    loadCalled++;
    assert(String(manifestUrl).indexOf('external_ai/hybrid/hybrid.json') >= 0,
      '模型清单必须走我们拷贝的副本目录，实际 ' + manifestUrl);
    assert(String(weightsUrl).indexOf('external_ai/hybrid/hybrid.bin') >= 0,
      '权重必须走我们拷贝的副本目录，实际 ' + weightsUrl);
    return Promise.resolve(fakePolicy);
  }
};

// ---------------------------------------------------------------- ① 管理器一帧
const manager = sandbox.HybridAIManager.create('hybrid_1', { isHybrid: true }, gameController);
assert.strictEqual(manager.getAIId(), 'hybrid_1', 'getAIId');
assert.strictEqual(manager.getGameId(), 'game-1', 'getGameId');
assert(loadCalled === 1, '创建 manager 时应当发起一次模型加载，实际 ' + loadCalled);
manager.ai.policy = fakePolicy;          // 跳过异步加载（上面已断言加载被触发过）

manager.update(20);
assert.strictEqual(submitted.length, 1, '每帧必须无条件提交一次输入');
assert.strictEqual(applied.forward, true, '动作 16 应当前进');
assert.strictEqual(applied.right, true, '动作 16 应当右转');
assert.strictEqual(applied.left, false, '动作 16 不该左转');
assert.strictEqual(applied.back, false, '动作 16 不该后退');
assert.strictEqual(applied.fire, false, '动作 16 不该开火');
assert(manager.ai.lastObservation && manager.ai.lastObservation.length === 1028,
  '每帧必须构造出 1028 维观测，实际 ' + (manager.ai.lastObservation && manager.ai.lastObservation.length));
assert.strictEqual(manager.ai.stats.frames, 1, '帧计数');
assert(manager.ai.stats.buildMs >= 0 && manager.ai.stats.inferMs >= 0, '耗时统计要存在');

// ---------------------------------------------------------------- ② 18 个动作 → 输入
const expect = {
  0: [false, true, true, false, false], 1: [false, true, true, false, true],
  2: [false, true, false, false, false], 3: [false, true, false, false, true],
  4: [false, true, false, true, false], 5: [false, true, false, true, true],
  6: [false, false, true, false, false], 7: [false, false, true, false, true],
  8: [false, false, false, false, false], 9: [false, false, false, false, true],
  10: [false, false, false, true, false], 11: [false, false, false, true, true],
  12: [true, false, true, false, false], 13: [true, false, true, false, true],
  14: [true, false, false, false, false], 15: [true, false, false, false, true],
  16: [true, false, false, true, false], 17: [true, false, false, true, true]
};
Object.keys(expect).forEach(function (a) {
  const inp = X.actionToInputs(Number(a));
  const e = expect[a];
  assert.strictEqual(inp.forward, e[0], 'action ' + a + ' forward');
  assert.strictEqual(inp.back, e[1], 'action ' + a + ' back');
  assert.strictEqual(inp.left, e[2], 'action ' + a + ' left');
  assert.strictEqual(inp.right, e[3], 'action ' + a + ' right');
  assert.strictEqual(inp.fire, e[4], 'action ' + a + ' fire');
});

// 闲置/换手率统计：连续"静止"动作应累加 idleStreak，换动作后清零
manager.ai.reset();
for (let i = 0; i < 5; i++) manager.ai._applyAction(8);   // 静止
assert.strictEqual(manager.ai.idleStreak, 5, '连续静止应当累加 idleStreak，实际 ' + manager.ai.idleStreak);
manager.ai._applyAction(14);                              // 前
assert.strictEqual(manager.ai.idleStreak, 0, '一动起来就该清零');
assert(manager.ai._changeRate() > 0, '换手率应当大于 0');
assert.strictEqual(manager.ai.actionHistory.length, 3, '动作历史最多保留三步');

// ---------------------------------------------------------------- ③ 接线点静态断言
const patch = fs.readFileSync(path.join(root, 'js', 'local_patch.js'), 'utf8');
[
  ["function addLobbyHybridPlayer()", '大厅里要有"添加 Hybrid"的实现'],
  ["function createLobbyHybridId()", 'Hybrid 的实例 id 生成'],
  ["function makeLobbyHybridPlayerDetails(", 'Hybrid 的显示名/外观详情'],
  ["'hybrid_template'", 'Hybrid 的外观模板'],
  ["Users.addLobbyAIUser(aiId, 'hybrid')", '按第三种身份注册进大厅'],
  ["isHybrid: isVantage === 'hybrid'", '大厅记录要区分 Hybrid'],
  ["aiId.indexOf('hybrid_') === 0", '造管理器时要认出 hybrid_ 前缀'],
  ["HybridAIManager.create(aiId, cfg, gameController)", '开局要把 Hybrid 接到管理器'],
  ["box.addUserHybrid", '"添加 Hybrid"按钮'],
  ["lobbyAIInfo.isHybrid", '大厅面板要显示 Hybrid 的名字'],
  ["AIs.ais[instanceId].isHybrid = true;", '注册实例时要标记 isHybrid']
].forEach(function (pair) {
  assert(patch.indexOf(pair[0]) >= 0, 'local_patch.js 缺少接线点：' + pair[1] + '（找 ' + pair[0] + '）');
});

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
['js/external_ai_hybrid.js', 'js/ai_hybrid.js', './external_ai/hybrid/hybrid.js'].forEach(function (needle) {
  assert(html.indexOf(needle) >= 0, 'index.html 必须加载 ' + needle);
});

console.log('diff_lobby_hybrid PASS：Hybrid 可作独立坦克（大厅注册 + 开局管理器 + 每帧提交输入 + 18 动作映射 + 观测 1028）');
