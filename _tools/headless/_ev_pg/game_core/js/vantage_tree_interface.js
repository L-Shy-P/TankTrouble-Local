/**
 * Vantage 树 · 智能体接口
 * ==========================================================================
 * 目的：把树里的**判断**与**操作**拆成可替换的接口，让
 *   ① 纯算法模式   —— 现有机制一点不变（默认）
 *   ② 神经网络智能体
 *   ③ 果蝇大脑智能体
 * 三者互换。
 *
 * ⚠️ 本文件只【定义接口】，不改任何现有行为。
 *    树侧的接线是下一步（B2），届时默认仍走纯算法模式。
 *
 * 设计口径（主人 2026-10-02 定案）：
 *   · 智能体直接给两件事：「在哪长节点、长几个」和「选哪条路」
 *     —— 不是"打分让算法找最高分"（那会让越深的路线分越高）
 *   · 回退不是独立操作 —— 被"想在哪长就在哪长"吸收
 *   · 只有两条不变量不可让步：不在真死节点上生长、有非真死时不选真死
 */
(function (global) {
    'use strict';

    // ============================================================
    // ① 两条不变量（唯一不可让步的部分）
    // ============================================================
    /**
     * 真死 = 执行一步就会死（完整 75 帧模拟里死亡帧 ≤ 1）。
     * 与树内既有的判定口径一致（v153：死亡帧 = 碰撞帧 = "能走几步"）。
     */
    function isTrueDead(node) {
        return !!node && typeof node.fullDeathFrame === 'number' &&
               node.fullDeathFrame >= 0 && node.fullDeathFrame <= 1;
    }

    var Invariants = {
        isTrueDead: isTrueDead,

        /** 不变量一：禁止在真死的节点上生长。 */
        canGrowAt: function (node) {
            if (!node) return false;
            if (node.invalid) return false;
            return !isTrueDead(node);
        },

        /**
         * 不变量二：有非真死候选时，不选真死路线。
         *
         * ⚠️ 本函数【不替智能体改选】—— 主人 2026-10-02 定案：
         *    "不要取'第一个'非真死的，那是遗漏的问题，非真死依旧由智能体选择。"
         *
         *    改选依据必须来自智能体，不能由接口凭空给一个"第一个"。
         *    所以本函数只【报告】，不做替换：
         *      调用方拿到 ok=false 后 → 记录违规（供惩罚） + 用兜底逻辑保证树能继续跑。
         *
         *    最终形态是"采样前屏蔽"：让智能体根本选不到真死候选。
         *    本函数是兜底，不是主路径。
         *
         * @returns {{ok:boolean, reason?:string, hasAlive?:boolean}}
         */
        checkSelect: function (chosen, candidates) {
            if (!chosen) return { ok: false, reason: 'no-choice' };
            if (!isTrueDead(chosen)) return { ok: true };
            var hasAlive = false;
            for (var i = 0; i < (candidates || []).length; i++) {
                var c = candidates[i];
                if (!c || c === chosen || c.invalid || c.exhausted) continue;
                if (!isTrueDead(c)) { hasAlive = true; break; }
            }
            if (!hasAlive) return { ok: true, reason: 'all-true-dead' };  // 全真死，不干预
            return { ok: false, reason: 'picked-true-dead', hasAlive: true };
        },

        /** @deprecated 已废弃——它会替智能体改选。保留仅为兼容，内部改为只报告。 */
        enforceSelect: function (chosen, candidates) {
            var r = Invariants.checkSelect(chosen, candidates);
            return r.ok ? chosen : chosen;   // 一律原样返回，不再替换
        }
    };

    // ============================================================
    // ② 智能体接口契约
    // ============================================================
    /**
     * 智能体只需实现一个方法：
     *
     *   agent.decide(ctx) → {
     *       growAt:    [nodeId, ...]   在哪些节点上生长（**不限于叶节点**）
     *       growTimes: number          本帧长几次（缺省 1）
     *       select:    nodeId          选哪条路（**直接给，不是打分**）
     *   }
     *
     *   返回 null / undefined 的字段 = 该字段交给树按纯算法模式处理。
     *   整个返回 null = 完全交回纯算法模式。
     *
     * ctx 由树侧构造（智能体只读，禁止写入）：
     *   {
     *     nodes:    [{id, parentId, opName, segmentFrames, tEndSec,
     *                 fullDeathFrame, invalid, exhausted, samples, …}],
     *     root:     nodeId,
     *     commit:   nodeId,          当前正在执行的节点
     *     tank:     {x, y, rot, vx, vy},
     *     bullets:  [{x, y, vx, vy}],
     *     maze:     {w, h},
     *     time:     number,
     *     slow:     bool,            是否处于性能熔断
     *     memory:   {nodeId: any}    智能体上一帧挂的私有数据，原样还给它
     *   }
     *
     * ⚠️ 关于"打分"的界限（主人 2026-10-02 指出）：
     *   ❌ 算法沿路径累加分数再取最大 —— 越深累积越多，必然偏向深路线
     *   ✅ 智能体内部对【当帧候选】打分并自己取最大 —— 每个候选独立评估，不跨深度累积
     *   所以打分可以存在，但只能存在于智能体内部，作用域是"当前这一批候选"。
     */
    function validateDecision(d) {
        if (!d) return null;
        var out = {};
        if (Array.isArray(d.growAt)) out.growAt = d.growAt;
        if (typeof d.growTimes === 'number' && d.growTimes > 0) {
            out.growTimes = Math.min(8, Math.floor(d.growTimes));
        }
        if (d.select !== undefined && d.select !== null) out.select = d.select;
        if (d.memory && typeof d.memory === 'object') out.memory = d.memory;
        return out;
    }

    /**
     * ★ 逐项校验一包完整输出（格式层；语义层由树侧做，因为它才知道节点集合）
     *
     * 主人 2026-10-02 定案：智能体每帧输出【一套完整结果】（记忆/生长/选路…），
     * 有非法项就在本帧重新让它输出，直到每项都拿到且合法。
     *
     * @returns {{ok:boolean, illegal:string[], reason:string, clean:object}}
     */
    function validateBundle(d) {
        if (!d || typeof d !== 'object') {
            return { ok: false, illegal: ['<整包>'], reason: 'no-output', clean: {} };
        }
        var illegal = [], clean = {};
        // 记忆：不透明，任何对象都收（树不解释内容）
        if (d.memory && typeof d.memory === 'object') clean.memory = d.memory;
        // 生长：必须是节点编号数组
        if (d.growAt !== undefined) {
            if (Array.isArray(d.growAt)) clean.growAt = d.growAt;
            else illegal.push('生长');
        }
        // 选路：单个节点编号
        if (d.select !== undefined && d.select !== null) clean.select = d.select;
        return { ok: illegal.length === 0, illegal: illegal,
                 reason: illegal.length ? ('格式非法: ' + illegal.join('/')) : '', clean: clean };
    }

    // ============================================================
    // ③ 可拆卸模块注册表
    // ============================================================
    /**
     * 现有机制全部作为【可拆卸模块】保留。
     * 默认【全部装载】= 纯算法模式，行为与改造前完全一致。
     * 智能体模式可以整组卸下，也可以只卸一部分让它接管。
     *
     * 每个模块的形状：
     *   { name, enabled: bool, hooks: { … } }
     *   hooks 里放该机制自己的函数，树只按名字调用，不关心内部实现。
     */
    var MODULE_SLOTS = [
        'scoring',        // 评分（含杀戮场 / 目标混合 / 车道压分…）
        'selection',      // 选路（取最高分 + 子树最优递归折算）
        'retreat',        // 回退
        'compensation',   // 补偿（剪枝补偿 / 回退补偿 / 生长加成）
        'growth',         // 生长（叶优先、固定层数）
        'seglen'          // 段长
    ];

    var Modules = {
        _mods: {},
        slots: MODULE_SLOTS.slice(),

        /** 装载/替换一个模块。默认 enabled = true。 */
        install: function (slot, mod) {
            if (MODULE_SLOTS.indexOf(slot) < 0) {
                throw new Error('[TreeModules] 未知插槽: ' + slot);
            }
            var prev = this._mods[slot] || null;
            this._mods[slot] = {
                name: (mod && mod.name) || slot,
                enabled: (mod && mod.enabled !== undefined) ? !!mod.enabled : true,
                hooks: (mod && mod.hooks) || {},
                prev: prev
            };
            return this._mods[slot];
        },

        uninstall: function (slot) {
            var m = this._mods[slot];
            this._mods[slot] = m && m.prev ? m.prev : null;
        },

        /** 取模块的可调用钩子；未装载或已禁用 → 返回 null（树据此回退到内置逻辑）。 */
        hook: function (slot, name) {
            var m = this._mods[slot];
            if (!m || !m.enabled) return null;
            var fn = m.hooks[name];
            return (typeof fn === 'function') ? fn : null;
        },

        isLoaded: function (slot) {
            var m = this._mods[slot];
            return !!(m && m.enabled);
        },

        /** 一键切换：纯算法模式（全开）/ 智能体模式（全关）。 */
        setAllEnabled: function (on) {
            for (var i = 0; i < MODULE_SLOTS.length; i++) {
                var m = this._mods[MODULE_SLOTS[i]];
                if (m) m.enabled = !!on;
            }
        },

        snapshot: function () {
            var out = {};
            for (var i = 0; i < MODULE_SLOTS.length; i++) {
                var m = this._mods[MODULE_SLOTS[i]];
                out[MODULE_SLOTS[i]] = m ? { name: m.name, enabled: m.enabled } : null;
            }
            return out;
        }
    };

    // ============================================================
    // ④ 果蝇适配器（骨架）
    // ============================================================
    /**
     * 三段结构（中间冻结）：
     *   物理状态 ──编码器(可学)──→ 注入电流 ──冻结LIF──→ 82个发放率 ──读出头(可学)──→ 树操作
     *
     * 难点：82 个连续通道 ↔ 动态数量的树节点，映射不固定，
     *       所以必须有【解释规则】把 82 维翻译成「在哪长」「选哪条路」。
     *       编码器与读出头都属于"接法"，都要学；中间的连接组冻结。
     */
    function FlyAgent(opts) {
        opts = opts || {};
        this.name = 'fly';
        this.worker = null;          // vantage_fly_worker.js 的实例
        this.encoder = opts.encoder || null;   // 物理状态 → 注入电流（可学）
        this.decoder = opts.decoder || null;   // 82 维 → 树操作（可学）
        this._rates = null;          // 最近一帧的 82 个发放率
    }
    FlyAgent.prototype.isReady = function () {
        return !!(this.worker && this._rates && this.encoder && this.decoder);
    };
    FlyAgent.prototype.decide = function (ctx) {
        if (!this.isReady()) return null;      // 未就绪 → 交回纯算法模式
        var currents = this.encoder(ctx);       // ① 编码
        this._rates = this.worker.step(currents);  // ② 冻结 LIF
        return validateDecision(this.decoder(this._rates, ctx));  // ③ 解译
    };

    // ============================================================
    // ⑤ 神经网络适配器（骨架）
    // ============================================================
    /**
     * 节点集合（变长）→ 定长张量 ──策略头──→ 树操作
     * 与既有外接 AI 的观测构造是同一套思路（见《外接AI接入方案-Hybrid》）。
     */
    function NNAgent(opts) {
        opts = opts || {};
        this.name = 'nn';
        this.encode = opts.encode || null;   // ctx → Float32Array
        this.policy = opts.policy || null;   // Float32Array → 决策对象
        this.features = null;
    }
    NNAgent.prototype.isReady = function () {
        return !!(this.encode && this.policy);
    };
    NNAgent.prototype.decide = function (ctx) {
        if (!this.isReady()) return null;
        this.features = this.encode(ctx);
        return validateDecision(this.policy(this.features, ctx));
    };

    // ============================================================
    // ⑥ 规则智能体（把现有逻辑包进来 —— 零回归基线）
    // ============================================================
    /**
     * 它不"决策"，只是把树现有的内置逻辑原样透传，
     * 用来验证接口接线本身没有引入任何行为变化。
     */
    function RuleAgent() { this.name = 'rule'; }
    RuleAgent.prototype.isReady = function () { return true; };
    RuleAgent.prototype.decide = function (ctx) {
        return null;    // null = 全部交回树的内置逻辑（等价于改造前）
    };

    // ============================================================
    // ⑦ 智能体注册表
    // ============================================================
    var Agents = {
        _cur: new RuleAgent(),
        _all: {},
        register: function (a) { if (a && a.name) this._all[a.name] = a; return a; },
        use: function (name) {
            var a = (name === 'rule') ? new RuleAgent() : this._all[name];
            if (!a) { console.warn('[TreeAgent] 未注册的智能体，回退规则版:', name); a = new RuleAgent(); }
            this._cur = a;
            return a;
        },
        current: function () { return this._cur; }
    };
    Agents.register(new RuleAgent());

    // ============================================================
    global.VantageTreeInterface = {
        VERSION: '1.0.0-interface',
        Invariants: Invariants,
        Modules: Modules,
        Agents: Agents,
        validateDecision: validateDecision,
        validateBundle: validateBundle,
        FlyAgent: FlyAgent,
        NNAgent: NNAgent,
        RuleAgent: RuleAgent,
        isTrueDead: isTrueDead
    };

    console.log('[TreeInterface] 智能体接口已定义（v' +
        global.VantageTreeInterface.VERSION + '）—— 仅定义，未接线，行为不变');
})(typeof window !== 'undefined' ? window : this);
