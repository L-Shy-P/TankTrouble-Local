/**
 * Vantage · 观测编码器（树状态 → 神经网络张量）
 * ==========================================================================
 * 把"当前决策点的 9 个候选"编成 120 维张量，供 vantage_nn.js 推理。
 *
 * 编码口径必须与 tools/nn/train_aim.py 逐位一致：
 *
 *   全局段 48
 *     g[0]  当前段已走时间 / 10 秒
 *     g[1]  节点数 / 256
 *     g[2]  失效节点数 / 256
 *     g[3]  算力预算占比（第一版恒 1）
 *     g[8]  期望位移方向 x        ★
 *     g[9]  期望位移方向 y        ★
 *     g[10] 合法候选数 / 9
 *
 *   候选段 9 × 8（每个操作一个固定槽位，顺序 = VantageSandbox.OPERATIONS）
 *     c[0] 该候选是否合法（非真死 / 非失效 / 非耗尽）
 *     c[1] 末态位移 x（归一化）
 *     c[2] 末态位移 y（归一化）
 *     c[3] 位移方向 sin
 *     c[4] 位移方向 cos
 *     c[5] 段长 / 10 秒
 *     c[6] 死亡帧（≤1 → 真死记 0；活满记 −1）
 *     c[7] 保留（**不喂答案**，留 0）
 *
 * ⚠️ 关键设计（来自训练时的发现）：
 *    必须给"9 个候选"**专用槽位**。第一版把候选散在 256 个节点槽位里，
 *    全连接层学不会「找出 commit 的子节点」，Top1 停在 11%（等于随机）。
 *    改成 9 个固定槽位后立刻到 95%。
 */
(function (global) {
    'use strict';

    var OPS = 9;
    var G_FIELDS = 48;
    var CAND_FIELDS = 8;
    var OBS_DIM = G_FIELDS + OPS * CAND_FIELDS;      // 120
    var TIME_SCALE = 10.0;                            // 10 秒 = 子弹最长寿命
    var DEATH_HORIZON = 75;

    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
    function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); }

    /** 真死 = 能走一步就死（与树内口径一致）。 */
    function isTrueDead(r) {
        var fd = num(r.fullDeathFrame, -1);
        return fd >= 0 && fd <= 1;
    }

    /** 单个候选是否"合法可选"。 */
    function isLegal(r) {
        if (!r) return false;
        if (r.invalid || r.exhausted) return false;
        return !isTrueDead(r);
    }

    /**
     * 编码。
     * @param {object} in  {
     *     candidates: 9 个 rollout 结果（顺序 = OPERATIONS），见下
     *     wantDir:    {x, y} 期望位移方向（单位向量），可选
     *     mapSize:    地图尺寸（世界单位），用于归一化位移，缺省 10
     *     segTime:    当前段已走时间（秒），可选
     *     nodeCount:  树当前节点数，可选
     *     invalidCount: 失效节点数，可选
     *     budget:     算力预算占比 0~1，可选
     *   }
     *   候选结果字段：{ startX, startY, endX, endY, plannedFrames,
     *                   fullDeathFrame, invalid, exhausted }
     * @returns {Float32Array(120)}
     */
    function encode(inp) {
        inp = inp || {};
        var cands = inp.candidates || [];
        var mapSize = num(inp.mapSize, 10) || 10;
        var out = new Float32Array(OBS_DIM);

        // ---- 全局段 ----
        var g = out;                                   // 前 48 个就是全局段
        g[0] = clamp01(num(inp.segTime, 0) / TIME_SCALE);
        g[1] = clamp01(num(inp.nodeCount, 0) / 256);
        g[2] = clamp01(num(inp.invalidCount, 0) / 256);
        g[3] = clamp01(num(inp.budget, 1));
        var wx = num(inp.wantDir && inp.wantDir.x, 0);
        var wy = num(inp.wantDir && inp.wantDir.y, 1);
        g[8] = wx; g[9] = wy;

        // ---- 候选段 ----
        var nLegal = 0;
        for (var k = 0; k < OPS; k++) {
            var r = cands[k] || null;
            var base = G_FIELDS + k * CAND_FIELDS;
            if (r && isLegal(r)) nLegal++;
        }
        g[10] = nLegal / OPS;

        for (k = 0; k < OPS; k++) {
            r = cands[k] || null;
            base = G_FIELDS + k * CAND_FIELDS;
            if (!r) { out[base] = 0; continue; }

            var dx = (num(r.endX, num(r.startX, 0)) - num(r.startX, 0)) / mapSize;
            var dy = (num(r.endY, num(r.startY, 0)) - num(r.startY, 0)) / mapSize;
            var len = Math.sqrt(dx * dx + dy * dy) || 1e-6;

            out[base + 0] = isLegal(r) ? 1 : 0;
            out[base + 1] = dx;
            out[base + 2] = dy;
            out[base + 3] = dy / len;                  // sin
            out[base + 4] = dx / len;                  // cos
            out[base + 5] = clamp01(num(r.plannedFrames, 0) / DEATH_HORIZON * 0.03);
            var fd = num(r.fullDeathFrame, -1);
            out[base + 6] = (fd < 0) ? -1 : clamp01(fd / DEATH_HORIZON);
            out[base + 7] = 0;                         // 保留：不喂答案
        }
        return out;
    }

    /** 从 9 个候选里抽出合法掩码（供 nn.pickOp 用）。 */
    function legalMask(cands) {
        var m = new Array(OPS);
        for (var k = 0; k < OPS; k++) m[k] = isLegal(cands[k]) ? 1 : 0;
        return m;
    }

    global.VantageNNObs = {
        OBS_DIM: OBS_DIM, G_FIELDS: G_FIELDS, CAND_FIELDS: CAND_FIELDS, OPS: OPS,
        encode: encode, legalMask: legalMask,
        isLegal: isLegal, isTrueDead: isTrueDead
    };

    if (typeof module === 'object' && module.exports) module.exports = global.VantageNNObs;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this));
