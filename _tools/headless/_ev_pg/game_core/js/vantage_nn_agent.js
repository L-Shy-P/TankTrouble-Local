/**
 * Vantage · NN 智能体（把编码器 + 网络 + 接口接起来）
 * ==========================================================================
 * 实现树侧接口约定的 decide()：
 *     agent.decide(ctx) → { growAt: [...], select: <节点编号> }
 *
 * 第一版**只做选路**（B 的一半）：
 *     · 从 ctx 里取出当前决策点的 9 个候选
 *     · 编码成 120 维
 *     · 网络出 9 个 logits → **只在合法候选里取最大**
 *     · 返回选中的那个节点编号
 *
 * ⚠️ 采样前屏蔽：非法候选在 argmax 之前就被排除，
 *    所以**这个智能体在结构上不可能输出非法动作**。
 *
 * 依赖：vantage_nn.js（推理）、vantage_nn_obs.js（编码）
 */
(function (global) {
    'use strict';

    function VantageNNAgent(opts) {
        opts = opts || {};
        this.name = 'nn';
        this.nn = opts.nn || null;
        this.obs = opts.obs || global.VantageNNObs || null;
        this.weightsUrl = opts.weightsUrl || null;
        this.pickStats = { calls: 0, picked: 0, noLegal: 0, notReady: 0 };
        this._lastPick = null;
    }

    VantageNNAgent.prototype.isReady = function () {
        return !!(this.nn && this.nn.loaded && this.obs);
    };

    /** 异步装载权重。 */
    VantageNNAgent.prototype.load = function (url) {
        var self = this;
        var nn = this.nn || (global.VantageNN ? global.VantageNN.create() : null);
        if (!nn) return Promise.reject(new Error('vantage_nn.js 未加载'));
        this.nn = nn;
        return nn.loadFrom(url || this.weightsUrl).then(function () { return self; });
    };

    /**
     * 从 ctx 里抽出"当前决策点的 9 个候选"。
     *
     * 接口约定 ctx.nodes 是节点快照（含 id / parentId / 位姿 / 死亡帧等），
     * ctx.commit 是当前提交点的编号。
     * 候选 = commit 的 9 个子节点（按 OPERATIONS 顺序，缺的留空）。
     */
    VantageNNAgent.prototype.collectCandidates = function (ctx) {
        var ops = (ctx.ops && ctx.ops.length) ? ctx.ops : null;
        var out = new Array(ops ? ops.length : 9);
        if (!ctx || !ctx.nodes) return out;
        var byParent = {};
        for (var i = 0; i < ctx.nodes.length; i++) {
            var n = ctx.nodes[i];
            if (n.parentId === undefined || n.parentId === null) continue;
            (byParent[n.parentId] || (byParent[n.parentId] = [])).push(n);
        }
        var kids = byParent[ctx.commit] || [];
        // 按 opName / 下标对到 9 个槽位
        for (i = 0; i < kids.length; i++) {
            var k = kids[i];
            var idx = (typeof k.opIndex === 'number') ? k.opIndex
                : (ops ? ops.findIndex(function (o) { return o && o.name === k.opName; }) : i);
            if (idx >= 0 && idx < out.length) out[idx] = k;
        }
        return out;
    };

    /**
     * 生成"期望位移方向"。
     * 第一版：朝对手方向（ctx.tank + ctx.bullets 里没有对手信息时退化为 0 度）。
     * ⚠️ 待定：正式版应由更高层给（比如 A 的布局意图）。
     */
    VantageNNAgent.prototype.wantDir = function (ctx) {
        if (ctx && ctx.wantDir) return ctx.wantDir;
        if (ctx && ctx.foe) {
            var dx = (ctx.foe.x - ctx.tank.x), dy = (ctx.foe.y - ctx.tank.y);
            var L = Math.sqrt(dx * dx + dy * dy) || 1e-6;
            return { x: dx / L, y: dy / L };
        }
        return { x: 1, y: 0 };
    };

    VantageNNAgent.prototype.decide = function (ctx) {
        if (!this.isReady()) { this.pickStats.notReady++; return null; }
        this.pickStats.calls++;

        var cands = this.collectCandidates(ctx);
        var mask = this.obs.legalMask(cands);
        var anyLegal = mask.indexOf(1) >= 0;

        // 用候选结果喂编码器（字段名对齐 vantage_nn_obs 的约定）
        var enc = [];
        for (var i = 0; i < cands.length; i++) {
            var c = cands[i];
            if (!c) { enc.push(null); continue; }
            enc.push({
                startX: c.startX, startY: c.startY,
                endX: c.endX, endY: c.endY,
                plannedFrames: c.plannedFrames,
                fullDeathFrame: c.fullDeathFrame,
                invalid: c.invalid, exhausted: c.exhausted
            });
        }
        var obs = this.obs.encode({
            candidates: enc,
            wantDir: this.wantDir(ctx),
            mapSize: (ctx && ctx.mapSize) || 10,
            nodeCount: (ctx.nodes || []).length,
            segTime: (ctx && ctx.segTime) || 0
        });

        var pick = this.nn.pickOp(obs, mask);
        this._lastPick = pick;

        if (pick < 0 || !anyLegal) {
            this.pickStats.noLegal++;
            return { growAt: [] };          // 无合法候选 → 不干预，交给兜底
        }
        this.pickStats.picked++;
        var node = cands[pick];
        return {
            growAt: [],
            select: node ? node.id : ctx.commit,
            _pickIndex: pick,
            _logits: null
        };
    };

    global.VantageNNAgent = {
        create: function (o) { return new VantageNNAgent(o); },
        VantageNNAgent: VantageNNAgent
    };
    if (typeof module === 'object' && module.exports) module.exports = global.VantageNNAgent;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this));
