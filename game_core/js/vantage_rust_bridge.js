/* global WebAssembly, Uint8Array, Float32Array */
/**
 * VantageRustBridge — read-only bridge to the vantage_core WASM sidecar.
 *
 * Exposes:
 *   - version()
 *   - buildWallRects(...)
 *   - sweepDangerFrames(...)
 *   - minimalDecide(...)
 *
 * It is intentionally NOT auto-initialized and does not modify any existing
 * Vantage module. Call `await VantageRustBridge.init()` from a manual test.
 */
(function (global) {
    'use strict';

    var PAGE_SIZE = 64 * 1024;

    function errorMessage(e) {
        if (e && e.message) return e.message;
        return String(e);
    }

    function failure(e) {
        return { ok: false, error: errorMessage(e) };
    }

    var VantageRustBridge = {
        _instance: null,
        _exports: null,
        _memory: null,
        _ready: false,

        /**
         * Whether the current environment can run this bridge at all.
         * Does not imply init() has succeeded.
         */
        isAvailable: function () {
            try {
                return typeof WebAssembly === 'object' &&
                    WebAssembly !== null &&
                    typeof WebAssembly.instantiate === 'function';
            } catch (e) {
                return false;
            }
        },

        _ensureReady: function () {
            if (!this._ready || !this._exports || !this._memory) {
                throw new Error('VantageRustBridge is not initialized; call init() first');
            }
        },

        /**
         * Grow the module memory if needed and return a byte offset that is
         * safe to use for `byteLength` bytes. The returned region lives in
         * freshly appended pages, so it can never overlap wasm stack/static
         * data.
         */
        _allocBytes: function (byteLength) {
            this._ensureReady();
            if (!(byteLength >= 0)) {
                throw new Error('invalid allocation size');
            }
            var memory = this._memory;
            var base = memory.buffer.byteLength;
            var neededPages = Math.ceil((base + byteLength) / PAGE_SIZE);
            var currentPages = memory.buffer.byteLength / PAGE_SIZE;
            if (neededPages > currentPages) {
                memory.grow(neededPages - currentPages);
            }
            return base;
        },

        /**
         * @param {string} [wasmUrl='js/wasm/vantage_core.wasm']
         * @returns {Promise<{ok:true}|{ok:false,error:string}>}
         */
        init: async function (wasmUrl) {
            try {
                wasmUrl = wasmUrl || 'js/wasm/vantage_core.wasm';

                var instance;
                if (typeof WebAssembly.instantiateStreaming === 'function') {
                    try {
                        instance = (await WebAssembly.instantiateStreaming(fetch(wasmUrl))).instance;
                    } catch (eStreaming) {
                        var resp = await fetch(wasmUrl);
                        var buf = await resp.arrayBuffer();
                        instance = (await WebAssembly.instantiate(buf)).instance;
                    }
                } else {
                    var resp2 = await fetch(wasmUrl);
                    var buf2 = await resp2.arrayBuffer();
                    instance = (await WebAssembly.instantiate(buf2)).instance;
                }

                if (!instance || !instance.exports) {
                    throw new Error('WASM instantiate returned no exports');
                }
                this._instance = instance;
                this._exports = instance.exports;
                this._memory = instance.exports.memory;
                if (!this._memory) {
                    throw new Error('vantage_core.wasm does not export memory');
                }
                if (typeof this._exports.vt_version !== 'function' ||
                    typeof this._exports.vt_build_wall_rects !== 'function' ||
                    typeof this._exports.vt_sweep_danger_frames !== 'function' ||
                    typeof this._exports.vt_minimal_decide !== 'function') {
                    throw new Error('vantage_core.wasm is missing required vt_* exports');
                }

                this._ready = true;
                return { ok: true };
            } catch (e) {
                this._ready = false;
                return failure(e);
            }
        },

        /**
         * ABI version of the loaded WASM sidecar.
         * @returns {number|{ok:false,error:string}}
         */
        version: function () {
            try {
                this._ensureReady();
                return this._exports.vt_version();
            } catch (e) {
                return failure(e);
            }
        },

        /**
         * Build wall rects from maze tiles.
         *
         * @param {Array<number>|Uint8Array} tiles width*height*3 bytes,
         *   layout [width][height][3]: tile[0]=floor, tile[1]=top wall,
         *   tile[2]=left wall.
         * @param {number} width
         * @param {number} height
         * @param {number} tileSize
         * @param {number} wallWidth
         * @param {number} [maxRects=4096]
         * @returns {{ok:true,count:number,rects:Array}|{ok:false,error:string}}
         */
        buildWallRects: function (tiles, width, height, tileSize, wallWidth, maxRects) {
            try {
                this._ensureReady();
                if (!tiles) throw new Error('tiles is required');
                width = width >>> 0;
                height = height >>> 0;
                tileSize = Number(tileSize);
                wallWidth = Number(wallWidth);
                maxRects = (maxRects === undefined || maxRects === null) ? 4096 : (maxRects >>> 0);
                if (maxRects === 0) {
                    return { ok: true, count: 0, rects: [] };
                }
                var tileBytes = width * height * 3;
                if (tileBytes === 0) {
                    return { ok: true, count: 0, rects: [] };
                }
                if (tiles.length < tileBytes) {
                    throw new Error('tiles length ' + tiles.length + ' < width*height*3 = ' + tileBytes);
                }

                var inBase = this._allocBytes(tileBytes);
                var inBytes = new Uint8Array(this._memory.buffer, inBase, tileBytes);
                inBytes.set(tiles.length === tileBytes ? tiles : Array.prototype.slice.call(tiles, 0, tileBytes));

                var outFloats = maxRects * 4;
                var outBase = this._allocBytes(outFloats * 4);

                var count = this._exports.vt_build_wall_rects(
                    inBase, width, height, tileSize, wallWidth, outBase, maxRects
                );

                var out = new Float32Array(this._memory.buffer, outBase, count * 4);
                var rects = [];
                for (var r = 0; r < count; r++) {
                    rects.push({
                        minX: out[r * 4],
                        minY: out[r * 4 + 1],
                        maxX: out[r * 4 + 2],
                        maxY: out[r * 4 + 3]
                    });
                }
                return { ok: true, count: count, rects: rects };
            } catch (e) {
                return failure(e);
            }
        },

        /**
         * Conservative danger coarse filter for rollout node frames.
         *
         * @param {Array<{x:number,y:number,rot:number}>} nodeSamples
         * @param {number} nodeT0
         * @param {number} nodeDt
         * @param {Array<{x:number,y:number,vx:number,vy:number,alive:(0|1)}>} bulletTrack
         * @param {number} bulletT0
         * @param {number} bulletDt
         * @param {number} margin
         * @returns {{ok:true,dangerCount:number,flags:Uint8Array}|{ok:false,error:string}}
         */
        sweepDangerFrames: function (nodeSamples, nodeT0, nodeDt, bulletTrack, bulletT0, bulletDt, margin) {
            try {
                this._ensureReady();
                if (!Array.isArray(nodeSamples) || nodeSamples.length === 0) {
                    throw new Error('nodeSamples must be a non-empty array');
                }
                if (!Array.isArray(bulletTrack) || bulletTrack.length === 0) {
                    throw new Error('bulletTrack must be a non-empty array');
                }

                nodeT0 = Number(nodeT0);
                nodeDt = Number(nodeDt);
                bulletT0 = Number(bulletT0);
                bulletDt = Number(bulletDt);
                margin = Number(margin);

                var nodeFrames = nodeSamples.length;
                var bulletFrames = bulletTrack.length;

                // One contiguous block: node x/y/rot, bullet x/y/vx/vy,
                // bullet alive flags, and output danger flags. All views are
                // created from the final buffer after the single allocation,
                // so no later _allocBytes call can detach them.
                var blockBytes = nodeFrames * 12 + bulletFrames * 16 + bulletFrames + nodeFrames;
                var blockBase = this._allocBytes(blockBytes);

                var nodeBase = blockBase;
                var nodeX = new Float32Array(this._memory.buffer, nodeBase, nodeFrames);
                var nodeY = new Float32Array(this._memory.buffer, nodeBase + nodeFrames * 4, nodeFrames);
                var nodeRot = new Float32Array(this._memory.buffer, nodeBase + nodeFrames * 8, nodeFrames);

                var k;
                for (k = 0; k < nodeFrames; k++) {
                    var ns = nodeSamples[k];
                    var nx = ns && typeof ns === 'object' ? (ns.x !== undefined ? ns.x : ns[0]) : ns;
                    var ny = ns && typeof ns === 'object' ? (ns.y !== undefined ? ns.y : ns[1]) : ns;
                    var nr = ns && typeof ns === 'object' ? (ns.rot !== undefined ? ns.rot : ns[2]) : 0;
                    nodeX[k] = Number(nx) || 0;
                    nodeY[k] = Number(ny) || 0;
                    nodeRot[k] = Number(nr) || 0;
                }

                var bulletBase = nodeBase + nodeFrames * 12;
                var bulletX = new Float32Array(this._memory.buffer, bulletBase, bulletFrames);
                var bulletY = new Float32Array(this._memory.buffer, bulletBase + bulletFrames * 4, bulletFrames);
                var bulletVx = new Float32Array(this._memory.buffer, bulletBase + bulletFrames * 8, bulletFrames);
                var bulletVy = new Float32Array(this._memory.buffer, bulletBase + bulletFrames * 12, bulletFrames);
                var bulletAlive = new Uint8Array(this._memory.buffer, bulletBase + bulletFrames * 16, bulletFrames);

                var b;
                for (b = 0; b < bulletFrames; b++) {
                    var bt = bulletTrack[b];
                    if (!bt || typeof bt !== 'object') {
                        throw new Error('bulletTrack[' + b + '] is not an object');
                    }
                    bulletX[b] = Number(bt.x !== undefined ? bt.x : bt[0]) || 0;
                    bulletY[b] = Number(bt.y !== undefined ? bt.y : bt[1]) || 0;
                    bulletVx[b] = Number(bt.vx !== undefined ? bt.vx : (bt.speedX !== undefined ? bt.speedX : bt[2])) || 0;
                    bulletVy[b] = Number(bt.vy !== undefined ? bt.vy : (bt.speedY !== undefined ? bt.speedY : bt[3])) || 0;
                    bulletAlive[b] = bt.alive === 0 || bt.alive === false ? 0 : 1;
                }

                var flagsBase = bulletBase + bulletFrames * 16 + bulletFrames;
                var flags = new Uint8Array(this._memory.buffer, flagsBase, nodeFrames);
                flags.fill(0);

                var dangerCount = this._exports.vt_sweep_danger_frames(
                    nodeBase,
                    nodeBase + nodeFrames * 4,
                    nodeBase + nodeFrames * 8,
                    nodeT0,
                    nodeDt,
                    nodeFrames,
                    bulletBase,
                    bulletBase + bulletFrames * 4,
                    bulletBase + bulletFrames * 8,
                    bulletBase + bulletFrames * 12,
                    bulletBase + bulletFrames * 16,
                    bulletT0,
                    bulletDt,
                    bulletFrames,
                    margin,
                    flagsBase
                );

                // Read output flags from a fresh view, so this stays correct
                // even if the Rust side ever allocates during the call.
                var outFlags = new Uint8Array(this._memory.buffer, flagsBase, nodeFrames);
                return {
                    ok: true,
                    dangerCount: dangerCount,
                    flags: outFlags.slice()
                };
            } catch (e) {
                return failure(e);
            }
        },
        /**
         * Minimal pure-computation decision for the 9-operation, 75-frame
         * rollout scoring array. Death data is supplied by the caller; the
         * Rust sidecar only performs probeSegment / buildCandidate /
         * pickBestChildByRolloutTotal and never decides death itself.
         *
         * @param {Array<{opName:string,totalScore:number,dead:boolean,deathFrame:number,perFrameScores:Array<number>}>} candidates
         *   Exactly 9 candidates, in VantageSandbox.OPERATIONS order.
         * @param {{epsilon?:number,tMin?:number,tMax?:number}} [options]
         * @returns {{ok:true,selectedIndex:number,segmentFrames:number}|{ok:false,error:string}}
         */
        minimalDecide: function (candidates, options) {
            try {
                this._ensureReady();
                if (!Array.isArray(candidates) || candidates.length !== 9) {
                    throw new Error('candidates must be an array of exactly 9 operation score objects');
                }

                options = options || {};
                var epsilon = Number(options.epsilon !== undefined ? options.epsilon : Math.PI * Math.PI);
                var tMin = Number(options.tMin !== undefined ? options.tMin : 3);
                var tMax = Number(options.tMax !== undefined ? options.tMax : 30);
                tMin = Math.max(0, Math.floor(tMin)) >>> 0;
                tMax = Math.max(0, Math.floor(tMax)) >>> 0;
                if (tMax < tMin) {
                    throw new Error('tMax must be >= tMin');
                }

                var FRAMES = 75;
                var count = candidates.length;
                var i, k;

                // Allocate one contiguous block, then create every view from
                // the final buffer. Creating views after the single growth
                // avoids the detached-buffer pitfall of grow-after-view.
                var align8 = function (n) {
                    return (n + 7) & ~7;
                };
                var totalBytes = count * 8;
                var deadBytes = count;
                var deathBytes = count * 8;
                var pfsBytes = count * FRAMES * 8;
                var blockBytes = totalBytes + align8(deadBytes) + deathBytes + pfsBytes + 8;

                var base = this._allocBytes(blockBytes);
                var off = base;
                var totals = new Float64Array(this._memory.buffer, off, count);
                off += totalBytes;
                var deadFlags = new Uint8Array(this._memory.buffer, off, count);
                off += align8(deadBytes);
                var deathFrames = new BigInt64Array(this._memory.buffer, off, count);
                off += deathBytes;
                var flatScores = new Float64Array(this._memory.buffer, off, count * FRAMES);
                off += pfsBytes;
                var outBase = off;

                for (i = 0; i < count; i++) {
                    var c = candidates[i];
                    if (!c || typeof c !== 'object') {
                        throw new Error('candidates[' + i + '] is not an object');
                    }
                    totals[i] = Number(c.totalScore);
                    if (!isFinite(totals[i])) totals[i] = 0;
                    deadFlags[i] = c.dead ? 1 : 0;

                    var df = (c.deathFrame === undefined || c.deathFrame === null) ? -1 : Number(c.deathFrame);
                    if (!isFinite(df)) df = -1;
                    deathFrames[i] = BigInt(Math.round(df));

                    var pfs = c.perFrameScores;
                    if (!pfs || typeof pfs.length !== 'number') {
                        throw new Error('candidates[' + i + '].perFrameScores is not array-like');
                    }
                    for (k = 0; k < FRAMES; k++) {
                        var v = k < pfs.length ? Number(pfs[k]) : 0;
                        if (!isFinite(v)) v = 0;
                        flatScores[i * FRAMES + k] = v;
                    }
                }

                var ok = this._exports.vt_minimal_decide(
                    base,
                    base + totalBytes,
                    base + totalBytes + align8(deadBytes),
                    base + totalBytes + align8(deadBytes) + deathBytes,
                    count,
                    FRAMES,
                    epsilon,
                    tMin,
                    tMax,
                    outBase,
                    outBase + 4
                );
                if (ok !== 1) {
                    throw new Error('vt_minimal_decide returned failure (' + ok + ')');
                }

                // The Rust call may grow wasm memory while building its own
                // temporary Vecs, which detaches any pre-call JS typed-array
                // views. Create fresh views after the call and read the
                // outputs from the final buffer.
                var outSelected = new Int32Array(this._memory.buffer, outBase, 1);
                var outSegment = new Int32Array(this._memory.buffer, outBase + 4, 1);

                return {
                    ok: true,
                    selectedIndex: outSelected[0],
                    segmentFrames: outSegment[0]
                };
            } catch (e) {
                return failure(e);
            }
        }

    };

    global.VantageRustBridge = VantageRustBridge;

    if (typeof console !== 'undefined' && typeof console.log === 'function') {
        console.log('[VantageRustBridge] loaded (minimal phase, not auto-init)');
    }
})(typeof window !== 'undefined' ? window : this);
