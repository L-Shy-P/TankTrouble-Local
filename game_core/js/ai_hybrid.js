/**
 * 外接 AI · Hybrid 的大脑与管理器（把 Hybrid 当成一辆独立坦克接进对局）
 * ---------------------------------------------------------------------------
 * 接法（照 Vantage 的既有形状，主人 2026-09-08 指定）：
 *   大厅：Users.addLobbyAIUser('hybrid_N', 'hybrid') → 大厅面板多一辆车 →
 *         开局时 attachAIManagerDirect() 认出 hybrid_ 前缀 → 造 HybridAIManager。
 *   每帧：AIs.update(dt) → manager.update(dt) → this.ai.update(dt) →
 *         gameController.setInputState(inputState)。
 *   契约：AI 需要 create(aiId, config, gameController) / update(dt) /
 *         getInputState() / reset() / shutdown()；
 *         manager 需要 create(...) / getAIId() / getGameId() / update(dt) / reset() / shutdown()。
 *
 * 依赖：VantageExternalHybrid（game_core/js/external_ai_hybrid.js，观测构造 + 动作映射）
 *       HybridPolicy（game_core/external_ai/hybrid/hybrid.js，纯 JS 推理）
 *       hybrid.json / hybrid.bin（同目录资源）
 *
 * P1 现状（见 docs/Vantage躲弹实现/外接AI接入方案-Hybrid.md）：
 *   · 观测：地图 7 通道 / 自身 12 / 对手 12 / 子弹槽 10×10 / 阶段 / 动作历史 / 闲置；
 *     射线、导航、瞄准、威胁汇总、dodge 九项先留 0（P2/P3 补齐，dodge 由 this.dodgeProvider 预留）。
 *   · 注意"左右手镜像"：我们的世界 y 朝下，必须在构造观测时镜像到他们的坐标系
 *     （已封装在 VantageExternalHybrid.buildObservation 内部）。
 */
(function (global) {
    'use strict';

    var MODEL_DIR = 'external_ai/hybrid/';

    /** 极简工具：把游戏里的对象安全地读成数值。 */
    function num(v, dflt) { return (typeof v === 'number' && isFinite(v)) ? v : (dflt || 0); }

    function tankState(tank) {
        if (!tank) return null;
        var x = 0, y = 0, rot = 0, vx = 0, vy = 0;
        try { x = num(tank.getX(), 0); } catch (e1) {}
        try { y = num(tank.getY(), 0); } catch (e2) {}
        try { rot = num(tank.getRotation(), 0); } catch (e3) {}
        try {
            var body = tank.getB2DBody ? tank.getB2DBody() : null;
            if (body && body.GetLinearVelocity) {
                var lv = body.GetLinearVelocity();
                vx = num(lv.x, 0); vy = num(lv.y, 0);
            }
        } catch (e4) {}
        return { x: x, y: y, rot: rot, vx: vx, vy: vy };
    }

    function mazeSnapshot(maze) {
        if (!maze) return null;
        var w = 0, h = 0;
        try { w = num(maze.getWidth(), 0) | 0; } catch (e1) {}
        try { h = num(maze.getHeight(), 0) | 0; } catch (e2) {}
        return {
            w: w, h: h,
            walkable: function (x, y) {
                try { return !!maze.isPositionInsideMaze({ x: x, y: y }); } catch (e3) { return false; }
            }
        };
    }

    /** 子弹快照（我们的 Projectile：getPlayerId/getX/getY/getSpeedX/getSpeedY/bounces/getTimeAlive）。 */
    function bulletSnapshot(list, selfId, myPrev, oppPrev) {
        var out = [];
        for (var id in list) {
            if (!list.hasOwnProperty(id)) continue;
            var p = list[id];
            if (!p) continue;
            var dead = false;
            try { dead = !!(p.done && p.done()); } catch (eD) {}
            if (dead) continue;
            var owner = null;
            try { owner = (typeof p.getPlayerId === 'function') ? p.getPlayerId() : p.playerId; } catch (eO) {}
            var bounced = false;
            try { bounced = !!(p.bounces && p.bounces.length > 0); } catch (eB) {}
            var lifeFrac = 1;
            try {
                var life = num(p.lifetime, 0), alive = num(p.getTimeAlive ? p.getTimeAlive() : p.timeAlive, 0);
                if (life > 0) lifeFrac = Math.max(0, Math.min(1, 1 - alive / life));
            } catch (eL) {}
            out.push({
                id: id,
                x: num(p.getX ? p.getX() : p.x, 0),
                y: num(p.getY ? p.getY() : p.y, 0),
                vx: num(p.getSpeedX ? p.getSpeedX() : p.speedX, 0),
                vy: num(p.getSpeedY ? p.getSpeedY() : p.speedY, 0),
                mine: (owner !== null && owner === selfId),
                bounced: bounced,
                lifeFrac: lifeFrac
            });
        }
        return out;
    }

    // =========================================================================
    // HybridAI：一帧的流程 = 读状态 → 构造观测 → 推理 → 写输入
    // =========================================================================
    var HybridAI = {
        create: function (aiId, config, gameController) {
            var self = Object.create(HybridAI.proto);
            self.aiId = aiId;
            self.config = config;
            self.gameController = gameController;
            self.policy = null;
            self.policyLoading = false;
            self.policyError = null;
            self.tickCount = 0;
            self.actionHistory = [];       // 最近三步动作（三元组 [throttle01, turn01, fire]）
            self.movementHistory = [];     // 最近若干移动码（算换手率）
            self.idleStreak = 0;
            self.lastChosen = null;
            self.dodgeProvider = null;     // P3：外部给 9 个先验；为空则传 0
            self.lastObservation = null;
            self.stats = { frames: 0, buildMs: 0, inferMs: 0, actions: {} };
            self.inputState = global.InputState
                ? global.InputState.withState(aiId, false, false, false, false, false)
                : null;
            self._loadPolicy();
            return self;
        },

        proto: {
            /** 懒加载模型（页面里只加载一次；失败不影响游戏，只是这辆车不动）。 */
            _loadPolicy: function () {
                var self = this;
                if (self.policy || self.policyLoading) return;
                if (typeof global.HybridPolicy === 'undefined') {
                    self.policyError = 'HybridPolicy 未加载';
                    return;
                }
                self.policyLoading = true;
                global.HybridPolicy.load(MODEL_DIR + 'hybrid.json', MODEL_DIR + 'hybrid.bin')
                    .then(function (policy) {
                        self.policy = policy;
                        self.policyLoading = false;
                        console.log('[Hybrid] 模型加载完成（schema ' + policy.manifest.schema +
                            ' / 观测 ' + policy.manifest.observation + ' / 动作 ' + policy.manifest.actions + '）');
                    })
                    .catch(function (err) {
                        self.policyLoading = false;
                        self.policyError = String(err && err.message || err);
                        console.warn('[Hybrid] 模型加载失败：', self.policyError);
                    });
            },

            update: function (deltaTime) {
                var self = this;
                var gc = self.gameController;
                try {
                    var tank = gc.getTank(self.aiId);
                    if (!tank) { self._setInputs(false, false, false, false, false); return; }
                    if (!self.policy) { self._loadPolicy(); self._setInputs(false, false, false, false, false); return; }

                    var me = tankState(tank);
                    var oppId = null, opp = null;
                    var tanks = gc.getTanks ? gc.getTanks() : {};
                    for (var pid in tanks) {
                        if (!tanks.hasOwnProperty(pid)) continue;
                        if (String(pid) === String(self.aiId)) continue;
                        oppId = pid; opp = tankState(tanks[pid]); break;
                    }
                    if (!opp) { self._setInputs(false, false, false, false, false); return; }

                    // 转速：用上一帧的朝向差分（他们的观测也是这么读的，不偷看按键）
                    var turn = 0;
                    if (me.rotPrev !== undefined) turn = me.rot - me.rotPrev;
                    self._prevRot = me.rot;

                    var t0 = (global.performance && performance.now) ? performance.now() : Date.now();
                    var built = global.VantageExternalHybrid.buildObservation({
                        maze: mazeSnapshot(gc.getMaze ? gc.getMaze() : null),
                        self: {
                            x: me.x, y: me.y, rot: me.rot, vx: me.vx, vy: me.vy, turn: turn,
                            ammoFrac: self._ammoFrac(tank), canFire: self._canFire(tank),
                            alive: true, hitSomething: false, wallSliding: false
                        },
                        opp: {
                            x: opp.x, y: opp.y, rot: opp.rot, vx: opp.vx, vy: opp.vy, turn: 0,
                            ammoFrac: 1, canFire: true, alive: true, hitSomething: false, wallSliding: false
                        },
                        bullets: bulletSnapshot(gc.getProjectiles ? gc.getProjectiles() : {}, self.aiId),
                        phase: [1, 0, 0, 0], clockFrac: 0,
                        dodge9: self.dodgeProvider ? self.dodgeProvider(self) : null,
                        idleStreak: self.idleStreak,
                        changeRate: self._changeRate(),
                        actions: self.actionHistory
                    });
                    var t1 = (global.performance && performance.now) ? performance.now() : Date.now();
                    var action = self.policy.act(built.values, built.bulletMask,
                        built.values.subarray(global.VantageExternalHybrid.OFFSETS.DODGE,
                            global.VantageExternalHybrid.OFFSETS.DODGE + 9));
                    var t2 = (global.performance && performance.now) ? performance.now() : Date.now();
                    self.lastObservation = built.values;
                    if (built.warnings && built.warnings.length) {
                        self.stats.lastWarnings = built.warnings;
                    }
                    self._applyAction(action);
                    self.stats.frames++;
                    self.stats.buildMs += (t1 - t0);
                    self.stats.inferMs += (t2 - t1);
                    self.stats.lastAction = action;
                } catch (err) {
                    console.warn('[Hybrid] update 异常：', err);
                    self._setInputs(false, false, false, false, false);
                }
            },

            _ammoFrac: function (tank) {
                try {
                    var w = this.gameController.getActiveWeapon ? this.gameController.getActiveWeapon(this.aiId) : null;
                    if (!w) return 1;
                    if (typeof w.getField === 'function') {
                        var left = w.getField('numBullets'), fired = w.getField('bulletsFired');
                        if (typeof left === 'number' && typeof fired === 'number') {
                            var remain = left - fired;
                            return remain <= 0 ? 0 : Math.min(1, remain / Math.max(1, left));
                        }
                    }
                } catch (eA) {}
                return 1;
            },

            _canFire: function (tank) {
                try {
                    if (typeof tank.canFire === 'function') return !!tank.canFire();
                } catch (eC) {}
                return true;
            },

            _changeRate: function () {
                var h = this.movementHistory;
                if (h.length < 2) return 0;
                var changes = 0;
                for (var i = 1; i < h.length; i++) if (h[i] !== h[i - 1]) changes++;
                return changes / (h.length - 1);
            },

            /** 把动作号落成我们的输入，并维护动作历史/闲置/换手率统计。 */
            _applyAction: function (action) {
                var X = global.VantageExternalHybrid;
                var inp = X.actionToInputs(action);
                var throttle01 = inp.throttle / 2;           // 他们的三元组是 0/0.5/1 归一化
                var turn01 = inp.turn / 2;
                this.actionHistory.unshift([throttle01, turn01, inp.fire ? 1 : 0]);
                if (this.actionHistory.length > 3) this.actionHistory.length = 3;
                this.movementHistory.push(inp.movement);
                if (this.movementHistory.length > 25) this.movementHistory.shift();
                // 闲置 = 完全中立移动（throttle 中 + 不转向），开不开火都算
                this.idleStreak = (inp.movement === 4) ? (this.idleStreak + 1) : 0;
                this.lastChosen = inp;
                this._setInputs(inp.forward, inp.back, inp.left, inp.right, inp.fire);
                this.stats.actions[action] = (this.stats.actions[action] || 0) + 1;
            },

            _setInputs: function (forward, back, left, right, fire) {
                if (!global.InputState) return;
                this.inputState = global.InputState.withState(this.aiId,
                    !!forward, !!back, !!left, !!right, !!fire);
            },

            getInputState: function () { return this.inputState; },

            reset: function () {
                this.actionHistory = [];
                this.movementHistory = [];
                this.idleStreak = 0;
                this.lastChosen = null;
                this._setInputs(false, false, false, false, false);
            },

            shutdown: function () {}
        }
    };

    // =========================================================================
    // HybridAIManager：与 VantageAIManager 同形状（每帧无条件提交输入）
    // =========================================================================
    var HybridAIManager = {
        create: function (aiId, config, gameController) {
            var m = Object.create(HybridAIManager.proto);
            m.aiId = aiId;
            m.gameController = gameController;
            m.ai = HybridAI.create(aiId, config, gameController);
            m.storedStates = { forward: false, back: false, left: false, right: false, fire: false };
            return m;
        },
        proto: {
            getAIId: function () { return this.aiId; },
            getGameId: function () { return this.gameController.getId(); },
            update: function (deltaTime) {
                try {
                    this.ai.update(deltaTime);
                    var s = this.ai.getInputState();
                    if (!s) return;
                    // 每帧无条件提交（照 VantageAIManager：边沿触发会撞上 rc 的静默丢弃）
                    this.gameController.setInputState(s);
                    this.storedStates.forward = s.getForward();
                    this.storedStates.back = s.getBack();
                    this.storedStates.left = s.getLeft();
                    this.storedStates.right = s.getRight();
                    this.storedStates.fire = s.getFire();
                } catch (err) {
                    console.error('[Hybrid] AIManager update 异常：', err);
                }
            },
            reset: function () { if (this.ai && this.ai.reset) this.ai.reset(); },
            shutdown: function () { if (this.ai && this.ai.shutdown) this.ai.shutdown(); }
        }
    };

    global.HybridAI = HybridAI;
    global.HybridAIManager = HybridAIManager;
    console.log('[Hybrid] 外接 AI 模块已加载（P1：观测 1028 + 18 动作；道具不参与，射线/导航/瞄准/威胁/dodge 待 P2/P3）');
})(typeof window !== 'undefined' ? window : this);
