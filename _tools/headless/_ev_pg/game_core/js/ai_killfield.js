/**
 * 外接 AI · Killfield 的大脑与管理器（把 Killfield 当成一辆独立坦克接进对局）
 * ---------------------------------------------------------------------------
 * 接法与 Hybrid 完全一致（主人 2026-09-08 指定的"在添加坦克那里加按钮"）：
 *   大厅：Users.addLobbyAIUser('killfield_N', 'killfield') → 大厅多一辆车 →
 *         开局 attachAIManagerDirect() 认出 killfield_ 前缀 → 造 KillfieldAIManager。
 *   每帧：AIs.update(dt) → manager.update(dt) → brain.update(dt) →
 *         gameController.setInputState(InputState.withState(...))。
 *
 * 大脑本体是 ES module（external_ai/killfield/brain.js），由 index.html 的
 * module 脚本挂到 window.KillfieldBrain；这里只负责适配游戏侧的接口。
 */
(function (global) {
    'use strict';

    var KillfieldAIManager = {
        create: function (aiId, config, gameController) {
            var m = Object.create(KillfieldAIManager.proto);
            m.aiId = aiId;
            m.gameController = gameController;
            m.brain = null;
            m.adapter = null;
            m.storedStates = { forward: false, back: false, left: false, right: false, fire: false };
            return m;
        },
        proto: {
            getAIId: function () { return this.aiId; },
            getGameId: function () { return this.gameController.getId(); },

            _ensureBrain: function () {
                if (this.brain) return true;
                if (typeof global.KillfieldBrain === 'undefined' ||
                    !global.KillfieldBrain.createKillfieldBrain) {
                    return false;
                }
                // 轨迹用我们现成的适配器批量模拟（Rust 优先、JS 兜底）
                try {
                    if (!this.adapter && typeof global.VantageSandbox !== 'undefined' &&
                        global.VantageSandbox.createAdapter) {
                        this.adapter = global.VantageSandbox.createAdapter(this.gameController, this.aiId);
                    }
                } catch (eAd) { this.adapter = null; }
                this.brain = global.KillfieldBrain.createKillfieldBrain(
                    this.gameController, this.aiId, { adapter: this.adapter });
                return true;
            },

            update: function (deltaTime) {
                try {
                    if (!this._ensureBrain()) {
                        this._submit(false, false, false, false, false);
                        return;
                    }
                    var out = this.brain.update((deltaTime || 20) / 1000);
                    this._submit(out.forward, out.back, out.left, out.right, out.fire);
                } catch (err) {
                    console.error('[Killfield] AIManager update 异常：', err);
                    this._submit(false, false, false, false, false);
                }
            },

            _submit: function (forward, back, left, right, fire) {
                if (!global.InputState) return;
                var s = global.InputState.withState(this.aiId, !!forward, !!back, !!left, !!right, !!fire);
                // 每帧无条件提交（照 VantageAIManager：边沿触发会撞上 rc 的静默丢弃）
                this.gameController.setInputState(s);
                this.storedStates.forward = s.getForward();
                this.storedStates.back = s.getBack();
                this.storedStates.left = s.getLeft();
                this.storedStates.right = s.getRight();
                this.storedStates.fire = s.getFire();
            },

            reset: function () {
                this.storedStates = { forward: false, back: false, left: false, right: false, fire: false };
                if (this.brain && this.brain.reset) this.brain.reset();
            },
            shutdown: function () {}
        }
    };

    global.KillfieldAIManager = KillfieldAIManager;
    console.log('[Killfield] 外接 AI 管理器已加载（粗版：密度场走位 + 风险躲弹 + 瞄准开火；MPC 待下一步）');
})(typeof window !== 'undefined' ? window : this);
