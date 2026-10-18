/**
 * Vantage · 神经网络推理（纯 JS，无依赖）
 * ==========================================================================
 * 加载 Python 训练导出的权重，做前向推理。
 *
 * 第一版只做【B 的选路头】——瞄准任务：
 *   输入：120 维观测（全局 48 + 候选 9×8）
 *   输出：9 个 logits → 在【合法候选】里取最大
 *
 * ⚠️ 关键：**只在合法候选里取最大**（采样前屏蔽）。
 *    这是主人定的"能直接做到让智能体不输出非法最好"。
 *    所以这个头在结构上不可能输出非法动作。
 *
 * 用法：
 *   var nn = VantageNN.create();          // 异步加载权重
 *   nn.ready(cfg => { ... });
 *   var pick = nn.pickOp(obs120, legalMask9);
 */
(function (global) {
    'use strict';

    function relu(x) { return x > 0 ? x : 0; }

    /**
     * 单层全连接：y = W·x + b
     * 权重按【行优先】存成平面数组，shape = [out, in]
     */
    function linear(flat, bias, x, outN, inN, act) {
        var y = new Float32Array(outN);
        for (var o = 0; o < outN; o++) {
            var s = bias ? bias[o] : 0, base = o * inN;
            for (var i = 0; i < inN; i++) s += flat[base + i] * x[i];
            y[o] = act === 'relu' ? relu(s) : s;
        }
        return y;
    }

    function VantageNN() {
        this.loaded = false;
        this.obsDim = 0;
        this.ops = 0;
        this.h = 0;
        this.W = {};          // { t0, b0, t1, b1, w, b }
        this._a0 = null; this._a1 = null;
    }

    /** 从 JSON 对象装载（已在内存里的权重）。 */
    VantageNN.prototype.load = function (json) {
        if (!json || json.format !== 'vantage-nn-aim-v1') {
            throw new Error('权重格式不匹配: ' + (json && json.format));
        }
        this.obsDim = json.obsDim;
        this.ops = json.ops;
        var ws = json.weights;
        this.h = ws.b0.length;
        var W = this.W;
        ['t0', 't1', 'w'].forEach(function (n) {
            W[n] = new Float32Array(ws[n]);
        });
        ['b0', 'b1', 'b'].forEach(function (n) {
            W[n] = new Float32Array(ws[n]);
        });
        this._a0 = new Float32Array(this.h);
        this._a1 = new Float32Array(this.h);
        this.loaded = true;
        return this;
    };

    /** 前向：120 维观测 → 9 个 logits。 */
    VantageNN.prototype.forward = function (x) {
        if (!this.loaded) throw new Error('权重未加载');
        if (x.length !== this.obsDim) throw new Error('观测维度不符: ' + x.length + ' != ' + this.obsDim);
        var W = this.W;
        this._a0 = linear(W.t0, W.b0, x, this.h, this.obsDim, 'relu');
        this._a1 = linear(W.t1, W.b1, this._a0, this.h, this.h, 'relu');
        return linear(W.w, W.b, this._a1, this.ops, this.h, 'none');
    };

    /**
     * 选路：在【合法候选】里取最大 logits。
     * @param {Float32Array|Array} x     120 维观测
     * @param {Array<number>} legalMask  9 个 0/1，1 = 合法
     * @returns {number} 选中的操作下标；全不合法时返回 −1
     */
    VantageNN.prototype.pickOp = function (x, legalMask) {
        var logits = this.forward(x);
        var best = -1, bestV = -Infinity, any = false;
        for (var i = 0; i < this.ops; i++) {
            if (legalMask && !legalMask[i]) continue;
            any = true;
            if (logits[i] > bestV) { bestV = logits[i]; best = i; }
        }
        return any ? best : -1;          // 全不合法 → −1，交给兜底
    };

    /** 异步：从 URL 加载权重 JSON。 */
    VantageNN.prototype.loadFrom = function (url) {
        var self = this;
        return fetch(url).then(function (r) {
            if (!r.ok) throw new Error('权重 HTTP ' + r.status);
            return r.json();
        }).then(function (j) { return self.load(j); });
    };

    global.VantageNN = {
        create: function () { return new VantageNN(); },
        VantageNN: VantageNN,
        /** 供离线测试：直接算一层，便于和 Python 对拍 */
        _linear: linear
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = global.VantageNN;
    }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this));
