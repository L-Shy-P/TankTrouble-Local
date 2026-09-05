/* global WebAssembly, Uint8Array, Float32Array */
/**
 * VantageRustBridge — read-only bridge to the vantage_core WASM sidecar.
 *
 * Exposes:
 *   - version()
 *   - rolloutBatch(...)         (ABI v2: vt_rollout_batch)
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
                    typeof this._exports.vt_rollout_batch !== 'function' ||
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
         * Fused rollout batch over up to 9 operations (ABI v2).
         *
         * JS API:
         *   input = {
         *     cacheId: <integer 0..2^32-1>,
         *     startPose: {x,y,rot},
         *     ops: [{speed, rotationSpeed}],        // 1..9 entries
         *     walls: [{verts:[[x,y],...]}],         // 0..1024 walls, 3..8 verts
         *     bullets: [{x,y,vx,vy,radius,lifeLeft,active}], // 0..64 bullets
         *     frames: <integer 0..75>
         *   }
         * returns {ok:true,samples:[[{x,y,rot}...]],dead:[bool],deathFrame:[number]}
         *       or {ok:false,error:string}. Input validation violations throw.
         *
         * One contiguous memory block is allocated; every Float64Array offset
         * is 8-byte aligned, and Uint32Array/Int32Array offsets are 4-byte
         * aligned. Outputs are copied into plain JS objects because the wasm
         * call may grow memory and detach every pre-call typed-array view.
         */
        rolloutBatch: function (input) {
            try {
                this._ensureReady();
                var badInput = function (msg) { var e = new Error(msg); e._isValidationError = true; return e; };
                if (!input || typeof input !== 'object') {
                    throw badInput('input is required');
                }

                var cacheId = input.cacheId;
                if (typeof cacheId !== 'number' || !Number.isInteger(cacheId) ||
                        cacheId < 0 || cacheId > 0xFFFFFFFF) {
                    throw badInput('cacheId must be an integer in [0, 2^32-1]');
                }
                var frames = input.frames;
                if (typeof frames !== 'number' || !Number.isInteger(frames) ||
                        frames < 0 || frames > 75) {
                    throw badInput('frames must be an integer in [0, 75]');
                }

                var startPose = input.startPose;
                if (!startPose || typeof startPose !== 'object') {
                    throw badInput('startPose is required');
                }
                var startX = Number(startPose.x);
                var startY = Number(startPose.y);
                var startRot = Number(startPose.rot);
                if (!isFinite(startX) || !isFinite(startY) || !isFinite(startRot)) {
                    throw badInput('startPose x/y/rot must be finite numbers');
                }

                var ops = input.ops;
                if (!Array.isArray(ops) || ops.length < 1 || ops.length > 9) {
                    throw badInput('ops must be an array of 1..9 entries');
                }

                var walls = input.walls;
                if (!Array.isArray(walls)) {
                    throw badInput('walls must be an array');
                }
                if (walls.length > 1024) {
                    throw badInput('wallCount must be <= 1024');
                }

                var bullets = input.bullets;
                if (!Array.isArray(bullets)) {
                    throw badInput('bullets must be an array');
                }
                if (bullets.length > 64) {
                    throw badInput('bulletCount must be <= 64');
                }

                var opCount = ops.length;
                var wallCount = walls.length;
                var bulletCount = bullets.length;
                var stride = frames + 1;
                var i, k;

                for (i = 0; i < opCount; i++) {
                    var op = ops[i];
                    if (!op || typeof op !== 'object') {
                        throw badInput('ops[' + i + '] is not an object');
                    }
                    if (!isFinite(Number(op.speed))) {
                        throw badInput('ops[' + i + '].speed must be a finite number');
                    }
                    if (!isFinite(Number(op.rotationSpeed))) {
                        throw badInput('ops[' + i + '].rotationSpeed must be a finite number');
                    }
                }

                var totalWallVerts = 0;
                for (i = 0; i < wallCount; i++) {
                    var wall = walls[i];
                    if (!wall || !Array.isArray(wall.verts)) {
                        throw badInput('walls[' + i + '].verts must be an array');
                    }
                    var vc = wall.verts.length;
                    if (vc < 3 || vc > 8) {
                        throw badInput('walls[' + i + '].verts must have 3..8 vertices');
                    }
                    totalWallVerts += vc;
                    if (totalWallVerts > 8192) {
                        throw badInput('total wall vertices must be <= 8192');
                    }
                    for (k = 0; k < vc; k++) {
                        var wv = wall.verts[k];
                        if (!wv || typeof wv !== 'object') {
                            throw badInput('walls[' + i + '].verts[' + k + '] is not a point');
                        }
                        if (!isFinite(Number(wv.x !== undefined ? wv.x : wv[0])) ||
                                !isFinite(Number(wv.y !== undefined ? wv.y : wv[1]))) {
                            throw badInput('walls[' + i + '].verts[' + k + '] must be finite');
                        }
                    }
                }

                for (i = 0; i < bulletCount; i++) {
                    var bl = bullets[i];
                    if (!bl || typeof bl !== 'object') {
                        throw badInput('bullets[' + i + '] is not an object');
                    }
                    if (!isFinite(Number(bl.x)) || !isFinite(Number(bl.y)) ||
                            !isFinite(Number(bl.vx)) || !isFinite(Number(bl.vy)) ||
                            !isFinite(Number(bl.radius)) || !isFinite(Number(bl.lifeLeft))) {
                        throw badInput('bullets[' + i + '] has non-finite numeric fields');
                    }
                }

                var align8 = function (n) { return (n + 7) & ~7; };
                var align4 = function (n) { return (n + 3) & ~3; };

                var opSpeedBytes = opCount * 8;
                var opRotBytes = opCount * 8;
                var wallCountsBytes = Math.max(1, wallCount) * 4;
                var wallVertsBytes = Math.max(1, totalWallVerts * 2) * 8;
                var bulletXBytes = Math.max(1, bulletCount) * 8;
                var bulletYBytes = Math.max(1, bulletCount) * 8;
                var bulletVxBytes = Math.max(1, bulletCount) * 8;
                var bulletVyBytes = Math.max(1, bulletCount) * 8;
                var bulletRadiusBytes = Math.max(1, bulletCount) * 8;
                var bulletLifeBytes = Math.max(1, bulletCount) * 8;
                var bulletActiveBytes = Math.max(1, bulletCount);
                var outSamplesBytes = opCount * stride * 8;
                var outDeadBytes = opCount;
                var outDeathBytes = opCount * 4;

                // Lay out every field relative to 0 first, then allocate ONE
                // contiguous block and add the returned base to every offset.
                var off = 0;
                var opSpeedBase = off; off += opSpeedBytes;
                var opRotBase = off; off += opRotBytes;
                var wallCountsBase = off; off += wallCountsBytes;
                off = align8(off);
                var wallVertsBase = off; off += wallVertsBytes;
                var bulletXBase = off; off += bulletXBytes;
                var bulletYBase = off; off += bulletYBytes;
                var bulletVxBase = off; off += bulletVxBytes;
                var bulletVyBase = off; off += bulletVyBytes;
                var bulletRadiusBase = off; off += bulletRadiusBytes;
                var bulletLifeBase = off; off += bulletLifeBytes;
                var bulletActiveBase = off; off += bulletActiveBytes;
                off = align8(off);
                var outXBase = off; off += outSamplesBytes;
                var outYBase = off; off += outSamplesBytes;
                var outRotBase = off; off += outSamplesBytes;
                var outDeadBase = off; off += outDeadBytes;
                off = align4(off);
                var outDeathFrameBase = off; off += outDeathBytes;

                var blockBytes = off;
                var base = this._allocBytes(blockBytes);
                opSpeedBase += base;
                opRotBase += base;
                wallCountsBase += base;
                wallVertsBase += base;
                bulletXBase += base;
                bulletYBase += base;
                bulletVxBase += base;
                bulletVyBase += base;
                bulletRadiusBase += base;
                bulletLifeBase += base;
                bulletActiveBase += base;
                outXBase += base;
                outYBase += base;
                outRotBase += base;
                outDeadBase += base;
                outDeathFrameBase += base;

                var opSpeed = new Float64Array(this._memory.buffer, opSpeedBase, opCount);
                var opRotSpeed = new Float64Array(this._memory.buffer, opRotBase, opCount);
                for (i = 0; i < opCount; i++) {
                    opSpeed[i] = Number(ops[i].speed);
                    opRotSpeed[i] = Number(ops[i].rotationSpeed);
                }

                if (wallCount > 0) {
                    var wallCounts = new Uint32Array(this._memory.buffer, wallCountsBase, wallCount);
                    var wallVerts = new Float64Array(this._memory.buffer, wallVertsBase, totalWallVerts * 2);
                    var woff = 0;
                    for (i = 0; i < wallCount; i++) {
                        var w = walls[i];
                        wallCounts[i] = w.verts.length;
                        for (k = 0; k < w.verts.length; k++) {
                            var pt = w.verts[k];
                            wallVerts[woff++] = Number(pt.x !== undefined ? pt.x : pt[0]);
                            wallVerts[woff++] = Number(pt.y !== undefined ? pt.y : pt[1]);
                        }
                    }
                }

                if (bulletCount > 0) {
                    var bulletX = new Float64Array(this._memory.buffer, bulletXBase, bulletCount);
                    var bulletY = new Float64Array(this._memory.buffer, bulletYBase, bulletCount);
                    var bulletVx = new Float64Array(this._memory.buffer, bulletVxBase, bulletCount);
                    var bulletVy = new Float64Array(this._memory.buffer, bulletVyBase, bulletCount);
                    var bulletRadius = new Float64Array(this._memory.buffer, bulletRadiusBase, bulletCount);
                    var bulletLifeLeft = new Float64Array(this._memory.buffer, bulletLifeBase, bulletCount);
                    var bulletActive = new Uint8Array(this._memory.buffer, bulletActiveBase, bulletCount);
                    for (i = 0; i < bulletCount; i++) {
                        var b = bullets[i];
                        bulletX[i] = Number(b.x);
                        bulletY[i] = Number(b.y);
                        bulletVx[i] = Number(b.vx);
                        bulletVy[i] = Number(b.vy);
                        bulletRadius[i] = Number(b.radius);
                        bulletLifeLeft[i] = Number(b.lifeLeft);
                        bulletActive[i] = b.active ? 1 : 0;
                    }
                }

                // cacheId is a u64 in the C ABI; raw wasm exports expose that
                // as an i64 parameter, so JS must pass a BigInt here.
                var ret = this._exports.vt_rollout_batch(
                    BigInt(cacheId),
                    startX, startY, startRot,
                    opSpeedBase, opRotBase, opCount,
                    wallCountsBase, wallVertsBase, wallCount,
                    bulletXBase, bulletYBase, bulletVxBase, bulletVyBase,
                    bulletRadiusBase, bulletLifeBase, bulletActiveBase, bulletCount,
                    frames,
                    outXBase, outYBase, outRotBase,
                    outDeadBase, outDeathFrameBase
                );
                if (ret !== 1) {
                    throw new Error('vt_rollout_batch returned failure (' + ret + ')');
                }

                // Rust may allocate and grow wasm memory during the call, which
                // detaches all pre-call views. Recreate the output views from
                // the final buffer before reading.
                var outX = new Float64Array(this._memory.buffer, outXBase, opCount * stride);
                var outY = new Float64Array(this._memory.buffer, outYBase, opCount * stride);
                var outRot = new Float64Array(this._memory.buffer, outRotBase, opCount * stride);
                var outDead = new Uint8Array(this._memory.buffer, outDeadBase, opCount);
                var outDeathFrame = new Int32Array(this._memory.buffer, outDeathFrameBase, opCount);

                var samples = [];
                var dead = [];
                var deathFrame = [];
                for (i = 0; i < opCount; i++) {
                    var opSamples = [];
                    for (k = 0; k <= frames; k++) {
                        var idx = i * stride + k;
                        opSamples.push({
                            x: outX[idx],
                            y: outY[idx],
                            rot: outRot[idx]
                        });
                    }
                    samples.push(opSamples);
                    dead.push(outDead[i] !== 0);
                    deathFrame.push(outDeathFrame[i]);
                }

                return {
                    ok: true,
                    samples: samples,
                    dead: dead,
                    deathFrame: deathFrame
                };
            } catch (e) {
                if (e && e._isValidationError) throw e;
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
        console.log('[VantageRustBridge] loaded (v2 ABI: vt_rollout_batch available, not auto-init)');
    }
})(typeof window !== 'undefined' ? window : this);
