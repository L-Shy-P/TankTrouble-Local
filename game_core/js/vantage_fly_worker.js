/**
 * Vantage × FlyWire · 果蝇反射层（LIF 引擎 + Web Worker 外壳）
 * ==========================================================================
 * 数据：external_ai/flywire/reflex_core.bin.gz / .json
 *   由 tools/flywire/extract_reflex_subgraph.py 从 FlyWire Codex 公开数据抽出。
 *   3508 神经元 / 114,957 条边 / 102 万突触（视觉逼近探测 → 逃逸下行神经元）。
 *
 * 二进制格式（小端）：
 *   header : uint32 n, uint32 e
 *   edges  : e × (uint32 pre, uint32 post, float32 w)   ← 已按 pre 排序
 *
 * 接口（三层，只吃数字吐数字，不碰游戏）：
 *   感觉编码 = 8 个扇区的逼近强度 [0..1]，由调用方（游戏侧）算好
 *   反射输出 = 82 个下行神经元的发放率
 *   本文件不做任何游戏相关的判断，也不做决策。
 *
 * ⚠️ LIF 参数与 tools/flywire/reflex_experiment.py 严格对齐：
 *    tau=20 / thr=1.0 / refr=3 / noise=0.01 / 最强扇区增益 1.6
 *    改这里必须同步改 Python，否则离线实验的结论不再适用。
 */
(function (global) {
    'use strict';

    var TAU = 20.0, THR = 1.0, REFR = 3, NOISE = 0.01, GAIN = 2.2;   // 2.2：按游戏真实尺度（格=10单位）重标定

    // ============================================================
    // 纯逻辑（不含 Worker/DOM 依赖，可在 Node 里直接测）
    // ============================================================
    function FlyReflex() {
        this.n = 0; this.e = 0;
        this.ptr = null; this.col = null; this.w = null; this.pre = null;
        this.sectorIdx = null;   // 8 个 Int32Array，每扇区的种子神经元下标
        this.readoutIdx = null;  // Int32Array，下行神经元下标
        this.V = null; this.refr = null;
    }

    /** 从已解压的 ArrayBuffer + 配置对象建立 CSR。 */
    FlyReflex.prototype.init = function (buf, cfg) {
        var dv = new DataView(buf);
        var n = dv.getUint32(0, true), e = dv.getUint32(4, true);
        this.n = n; this.e = e;

        var pre = new Int32Array(e), post = new Int32Array(e), w = new Float32Array(e);
        var off = 8;
        for (var i = 0; i < e; i++) {
            pre[i] = dv.getUint32(off, true);
            post[i] = dv.getUint32(off + 4, true);
            w[i] = dv.getFloat32(off + 8, true);
            off += 12;
        }

        // 权重归一化：99 分位 → 0.35（与 Python 的 normalize_w 一致）
        var abs = new Float32Array(e);
        for (i = 0; i < e; i++) abs[i] = Math.abs(w[i]);
        var sorted = Array.prototype.slice.call(abs).sort(function (a, b) { return a - b; });
        var p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] || 1;
        var scale = 0.35 / Math.max(1e-6, p99);
        for (i = 0; i < e; i++) w[i] *= scale;

        // CSR（边已按 pre 排序，但仍显式建一次以防上游变化）
        var order = new Int32Array(e);
        for (i = 0; i < e; i++) order[i] = i;
        Array.prototype.sort.call(order, function (a, b) { return pre[a] - pre[b]; });
        var ptr = new Int32Array(n + 1), col = new Int32Array(e), ww = new Float32Array(e);
        var pr = new Int32Array(e);
        for (i = 0; i < e; i++) {
            var k = order[i];
            ptr[pre[k] + 1]++;
        }
        for (i = 0; i < n; i++) ptr[i + 1] += ptr[i];
        var cur = ptr.slice(0, n);
        for (i = 0; i < e; i++) {
            k = order[i];
            var p = cur[pre[k]]++;
            col[p] = post[k]; ww[p] = w[k]; pr[p] = pre[k];
        }
        this.ptr = ptr; this.col = col; this.w = ww; this.pre = pr;

        var s = [];
        for (i = 0; i < 8; i++) {
            var arr = (cfg.sectors && cfg.sectors[i]) || (cfg.sectors && cfg.sectors[String(i)]) || [];
            s.push(Int32Array.from(arr));
        }
        this.sectorIdx = s;
        this.readoutIdx = Int32Array.from(cfg.readouts || []);
        // 感觉编码增益。fixed = 固定增益（强度本身携带紧迫度，默认）
        //                    normalized = 按本帧最强扇区归一化（旧行为，会抹掉绝对量级）
        this.gainMode = 'fixed';
        this.gain = GAIN;
        this.V = new Float32Array(n);
        this.refr = new Int32Array(n);
        this._spikeCount = new Int32Array(n);   // 本窗口每神经元发放次数
        var allSeed = [];
        for (i = 0; i < 8; i++) for (var q = 0; q < s[i].length; q++) allSeed.push(s[i][q]);
        return { neurons: n, edges: e, readouts: this.readoutIdx.length,
                 sectorSizes: s.map(function (a) { return a.length; }),
                 seedIdx: allSeed, readoutIdx: Array.prototype.slice.call(this.readoutIdx) };
    };

    /** 重置膜电位与不应期（跨局/重生时调用）。 */
    FlyReflex.prototype.reset = function () {
        if (this.V) this.V.fill(0);
        if (this.refr) this.refr.fill(0);
    };

    /**
     * 跑 steps 步 LIF。
     * @param {Array<number>} sectors 8 个扇区的逼近强度（原始值即可，内部按最强扇区归一化）
     * @param {number} steps 步数（建议 = 游戏帧率对应的毫秒数 / 5，见文档）
     * @param {number} binMs 分箱宽度（毫秒），用于把发放数转成"率"
     * @returns {{rates: Float32Array, spikes: number, seedSpikes: number}}
     */
    FlyReflex.prototype.step = function (sectors, steps, binMs) {
        steps = steps || 20;
        binMs = binMs || 5;
        var n = this.n, ptr = this.ptr, col = this.col, w = this.w, pre = this.pre;
        var V = this.V, refr = this.refr;

        // 感觉编码：每个扇区各自的种子神经元 × 该扇区强度，按最强扇区归一化到 GAIN
        var stim = new Float32Array(n);
        var mx = 0, k;
        for (k = 0; k < 8; k++) if (sectors[k] > mx) mx = sectors[k];
        var g = (this.gainMode === 'normalized' && mx > 1e-6) ? (this.gain / mx)
                                                             : this.gain;
        if (g > 0) {
            for (k = 0; k < 8; k++) {
                var idx = this.sectorIdx[k], v = (sectors[k] || 0) * g;
                for (var j = 0; j < idx.length; j++) stim[idx[j]] = v;
            }
        }

        var dnCounts = new Float32Array(this.readoutIdx.length);
        var spikeCount = this._spikeCount;
        spikeCount.fill(0);
        var totalSpikes = 0;
        for (var t = 0; t < steps; t++) {
            for (var i = 0; i < n; i++) V[i] += (-V[i] + stim[i]) / TAU;

            // 发放判定 + 突触投递（只有"突触前发放"的边才传电流）
            var fired = null;
            for (i = 0; i < n; i++) {
                if (V[i] >= THR && refr[i] === 0) {
                    if (!fired) fired = [];
                    fired.push(i);
                }
            }
            if (fired) {
                totalSpikes += fired.length;
                for (var fi = 0; fi < fired.length; fi++) {
                    var s = fired[fi];
                    spikeCount[s]++;
                    refr[s] = REFR;
                    for (var eIdx = ptr[s]; eIdx < ptr[s + 1]; eIdx++) V[col[eIdx]] += w[eIdx];
                    V[s] = 0;
                }
            }
            for (i = 0; i < n; i++) {
                if (refr[i] > 0) refr[i]--;
                V[i] += (Math.random() - 0.5) * 2 * NOISE;
            }
        }
        // 读出：下行神经元的窗口发放数 → 率（Hz 口径，binMs 是每步代表的毫秒）
        var ms = steps * binMs;
        for (var r = 0; r < this.readoutIdx.length; r++) {
            dnCounts[r] = spikeCount[this.readoutIdx[r]] * 1000 / ms;
        }
        var seedSpikes = 0;
        for (var kk = 0; kk < 8; kk++) {
            var si = this.sectorIdx[kk];
            for (var q = 0; q < si.length; q++) seedSpikes += spikeCount[si[q]];
        }
        return { rates: dnCounts, spikes: totalSpikes, seedSpikes: seedSpikes,
                 gain: g, ms: ms, byNeuron: spikeCount };
    };

    global.FlyReflex = FlyReflex;

    // ============================================================
    // Web Worker 外壳
    // ============================================================
    if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
        var reflex = null, cfg = null, ready = false;

        /**
         * 解压 gzip。
         * ⚠️ 必须用 Blob.stream().pipeThrough() —— 手写
         *    `writer.write(u8); writer.close()` 在输入较大时（本数据 422KB）会因
         *    背压死锁：write() 的 Promise 无人 await，管道写满后就永久挂起，
         *    表现为"页面一直卡在加载中、既不成功也不报错"。
         */
        function gunzipToArrayBuffer(u8) {
            if (typeof DecompressionStream === 'undefined') {
                return Promise.reject(new Error('浏览器不支持 DecompressionStream，请用 Chrome/Edge 103+ 或 Firefox 113+'));
            }
            var ds = new DecompressionStream('gzip');
            return new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
        }

        self.onmessage = function (ev) {
            var m = ev.data || {};
            if (m.cmd === 'init') {
                console.log('[FlyWorker] init: 开始拉取', m.bin);
                Promise.all([
                    fetch(m.bin).then(function (r) {
                        console.log('[FlyWorker] bin HTTP', r.status, r.headers.get('content-length'), 'bytes');
                        if (!r.ok) throw new Error('bin HTTP ' + r.status);
                        return r.arrayBuffer();
                    }).then(function (ab) {
                        console.log('[FlyWorker] 解压中…', ab.byteLength, 'bytes(gz)');
                        return gunzipToArrayBuffer(new Uint8Array(ab));
                    }),
                    fetch(m.cfg).then(function (r) {
                        if (!r.ok) throw new Error('cfg HTTP ' + r.status);
                        return r.json();
                    })
                ]).then(function (res) {
                    console.log('[FlyWorker] 解压完成，建 CSR…', res[0].byteLength, 'bytes');
                    cfg = res[1];
                    reflex = new FlyReflex();
                    var info = reflex.init(res[0], cfg);
                    ready = true;
                    self.postMessage({ type: 'ready', info: info });
                }).catch(function (err) {
                    self.postMessage({ type: 'error', where: 'init', message: String(err) });
                });
            } else if (m.cmd === 'step') {
                if (!ready) { self.postMessage({ type: 'error', where: 'step', message: 'not ready' }); return; }
                try {
                    var out = reflex.step(m.sectors || [], m.steps || 20, m.binMs || 5);
                    self.postMessage({ type: 'out', rates: out.rates, spikes: out.spikes,
                                       seedSpikes: out.seedSpikes, byNeuron: out.byNeuron, gain: out.gain, ms: out.ms,
                                       readouts: cfg.readouts, sectors: cfg.sectors });
                } catch (e) {
                    self.postMessage({ type: 'error', where: 'step', message: String(e) });
                }
            } else if (m.cmd === 'reset') {
                if (reflex) reflex.reset();
            }
        };
    }

    if (typeof module === 'object' && module.exports) {
        module.exports = { FlyReflex: FlyReflex, TAU: TAU, THR: THR, REFR: REFR, NOISE: NOISE, GAIN: GAIN };
    }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this));
