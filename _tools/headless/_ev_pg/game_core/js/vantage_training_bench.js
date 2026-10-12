/**
 * Vantage Training Bench — 把 Vantage 树 AI 接入训练模式 + 基准测试（v1）
 *
 * 依赖加载顺序：ai_vantage.js → vantage_testbench.js → training_mode.js → 本文件。
 *
 * 用法：
 *   1. 进入训练模式；
 *   2. 右上浮窗点「AI 开关」= 由 Vantage 树 AI 接管人类坦克；
 *   3. 选择基准配置，点「跑基准」自动替换发射源/地图、自动复活并统计每局存活秒数。
 *
 * 控制台 API：
 *   VantageTrainingBench.enableAI() / disableAI()
 *   VantageTrainingBench.startBenchmark('single') / listBenchmarks()
 */
(function(global) {
    'use strict';

    var PANEL_ID = 'vantage-training-bench-panel';

    var state = {
        aiEnabled: false,
        ai: null,
        aiHumanId: null,
        benchActive: false,
        benchStartAt: 0,
        lifeStart: null,
        results: [],
        runsDone: 0,
        runsTarget: 5,
        maxRunSec: 120,
        currentPreset: null,
        applying: false
    };

    var MAP_CLASSES = {
        open: {
            label: '空旷场（仅外框）',
            mapGen: function() { return mapGenFor('open'); }
        },
        standard: {
            label: '标准迷宫',
            mapGen: function() { return mapGenFor('standard'); }
        },
        dense: {
            label: '高墙迷宫',
            mapGen: function() { return mapGenFor('dense'); }
        }
    };

    var SPAWN_MODES = {
        center: '中心出生',
        corner: '近角出生',
        left: '左侧出生',
        right: '右侧出生'
    };
    var BENCH_DIMENSIONS = {
        none: { label: '0 无（保留普通训练）', preset: null, map: null, spawn: null, metric: '不应用任何基准模板，训练模式保持自身配置' },
        precision: { label: '1 精度', preset: 'precision', map: 'open', spawn: 'center', metric: '存活时间（越低说明空间/时间精度越差）' },
        terrain: { label: '2 地形理解', preset: 'terrain', map: 'dense', spawn: 'corner', metric: '是否主动脱离墙角/死路' },
        prediction: { label: '3 子弹预测', preset: 'prediction', map: 'dense', spawn: 'left', metric: '反弹弹道下的存活时间' },
        surprise: { label: '4 突袭反应', preset: 'burst', map: 'open', spawn: 'center', metric: '爆发波次内的存活率' },
        performance: { label: '5 性能', preset: 'ultimate', map: 'standard', spawn: 'center', metric: '高压下是否掉帧/冻结/误判' },
        experience: { label: '6 经验积累', preset: 'mixed', map: 'standard', spawn: 'center', metric: '多局存活时间趋势（应逐步上升）' },
        positioning: { label: '7 身位规划', preset: 'crossfire', map: 'open', spawn: 'center', metric: '交叉火力下的走位质量' }
    };

    var BENCHMARKS = {
        // —— 专项维度场景 ——
        precision: {
            label: '精度·2源',
            emitters: [
                emitter('train_emitter_vb1', '精度A', 2.0, 0, 0.70, 20, 1, 'BULLET'),
                emitter('train_emitter_vb2', '精度B', 2.4, 0, 0.80, 20, 1, 'BULLET')
            ]
        },
        terrain: {
            label: '地形·2源',
            emitters: [
                emitter('train_emitter_vb1', '地形A', 1.8, 0.05, 1.0, 20, 1, 'BULLET'),
                emitter('train_emitter_vb2', '地形B', 2.2, 0.05, 1.1, 20, 1, 'BULLET')
            ]
        },
        prediction: {
            label: '弹道预测·4源',
            emitters: [
                emitter('train_emitter_vb1', '预测A', 2.0, 0, 0.75, 20, 1, 'BULLET'),
                emitter('train_emitter_vb2', '预测B', 2.3, 0, 0.80, 20, 1, 'BULLET'),
                emitter('train_emitter_vb3', '预测C', 2.6, 0, 0.85, 20, 1, 'BULLET'),
                emitter('train_emitter_vb4', '预测D', 2.9, 0, 0.90, 20, 1, 'BULLET')
            ]
        },
        // —— 持续撒弹型：考验持续判断、路线切换与低空窗处理 ——
        sustain: {
            label: '持续撒弹·6源',
            emitters: [
                emitter('train_emitter_vb1', '持续A', 2.5, 0.05, 0.45, 20, 1, 'BULLET'),
                emitter('train_emitter_vb2', '持续B', 2.8, 0.05, 0.50, 20, 1, 'BULLET'),
                emitter('train_emitter_vb3', '持续C', 3.0, 0.08, 0.55, 20, 1, 'BULLET'),
                emitter('train_emitter_vb4', '持续D', 2.4, 0.05, 0.45, 20, 1, 'BULLET'),
                emitter('train_emitter_vb5', '持续E', 2.7, 0.06, 0.50, 20, 1, 'BULLET'),
                emitter('train_emitter_vb6', '持续F', 3.1, 0.08, 0.55, 20, 1, 'BULLET')
            ]
        },
        sustain_dense: {
            label: '高压持续·10源',
            emitters: [
                emitter('train_emitter_vb1', '高压A', 2.5, 0.10, 0.35, 20, 1, 'BULLET'),
                emitter('train_emitter_vb2', '高压B', 2.8, 0.10, 0.40, 20, 1, 'BULLET'),
                emitter('train_emitter_vb3', '高压C', 3.0, 0.12, 0.42, 20, 1, 'BULLET'),
                emitter('train_emitter_vb4', '高压D', 2.4, 0.10, 0.35, 20, 1, 'BULLET'),
                emitter('train_emitter_vb5', '高压E', 2.7, 0.12, 0.40, 20, 1, 'BULLET'),
                emitter('train_emitter_vb6', '高压F', 3.1, 0.12, 0.42, 20, 1, 'BULLET'),
                emitter('train_emitter_vb7', '高压G', 2.6, 0.10, 0.38, 20, 1, 'BULLET'),
                emitter('train_emitter_vb8', '高压H', 2.9, 0.10, 0.40, 20, 1, 'BULLET'),
                emitter('train_emitter_vb9', '高压I', 3.2, 0.10, 0.42, 20, 1, 'BULLET'),
                emitter('train_emitter_vb10', '高压J', 2.5, 0.10, 0.38, 20, 1, 'BULLET')
            ]
        },
        // —— 爆发-停歇型：考验短窗口极限操作与爆后恢复走位 ——
        burst: {
            label: '爆发停歇·6源',
            emitters: [
                emitter('train_emitter_vb1', '爆发A', 2.0, 0.05, 0.10, 3, 6.0, 'BULLET'),
                emitter('train_emitter_vb2', '爆发B', 2.3, 0.05, 0.10, 3, 6.5, 'BULLET'),
                emitter('train_emitter_vb3', '爆发C', 2.6, 0.05, 0.10, 3, 7.0, 'BULLET'),
                emitter('train_emitter_vb4', '爆发D', 2.9, 0.05, 0.10, 3, 7.5, 'BULLET'),
                emitter('train_emitter_vb5', '爆发E', 3.2, 0.05, 0.10, 3, 8.0, 'BULLET'),
                emitter('train_emitter_vb6', '爆发F', 3.5, 0.05, 0.10, 3, 8.5, 'BULLET')
            ]
        },
        shotgun_wall: {
            label: '霰弹墙·4源',
            emitters: [
                emitter('train_emitter_vb1', '霰弹A', 1.8, 0.08, 0.35, 2, 5.0, 'SHOTGUN'),
                emitter('train_emitter_vb2', '霰弹B', 2.1, 0.08, 0.35, 2, 5.5, 'SHOTGUN'),
                emitter('train_emitter_vb3', '霰弹C', 2.4, 0.08, 0.35, 2, 6.0, 'SHOTGUN'),
                emitter('train_emitter_vb4', '霰弹D', 2.7, 0.08, 0.35, 2, 6.5, 'SHOTGUN')
            ]
        },
        // —— 交叉火力型：考验方向选择与角度遮蔽利用 ——
        crossfire: {
            label: '交叉火力·8源',
            emitters: [
                emitter('train_emitter_vb1', '交叉A', 50, 0, 0.35, 20, 1, 'BULLET'),
                emitter('train_emitter_vb2', '交叉B', 50, 0, 0.38, 20, 1, 'BULLET'),
                emitter('train_emitter_vb3', '交叉C', 50, 0, 0.40, 20, 1, 'BULLET'),
                emitter('train_emitter_vb4', '交叉D', 50, 0, 0.42, 20, 1, 'BULLET'),
                emitter('train_emitter_vb5', '交叉E', 50, 0, 0.35, 20, 1, 'BULLET'),
                emitter('train_emitter_vb6', '交叉F', 50, 0, 0.38, 20, 1, 'BULLET'),
                emitter('train_emitter_vb7', '交叉G', 50, 0, 0.40, 20, 1, 'BULLET'),
                emitter('train_emitter_vb8', '交叉H', 50, 0, 0.42, 20, 1, 'BULLET')
            ]
        },
        homing_swarm: {
            label: '追踪导弹群·3源',
            emitters: [
                emitter('train_emitter_vb1', '追踪A', 2.0, 0, 2.0, 3, 6, 'HOMING_MISSILE'),
                emitter('train_emitter_vb2', '追踪B', 2.5, 0, 2.3, 3, 7, 'HOMING_MISSILE'),
                emitter('train_emitter_vb3', '追踪C', 3.0, 0, 2.6, 3, 8, 'HOMING_MISSILE')
            ]
        },
        gatling_sweep: {
            label: '加特林扫射·3源',
            emitters: [
                emitter('train_emitter_vb1', '加特林A', 3.0, 0.02, 0.45, 20, 3, 'GATLING_GUN'),
                emitter('train_emitter_vb2', '加特林B', 3.4, 0.02, 0.50, 20, 3, 'GATLING_GUN'),
                emitter('train_emitter_vb3', '加特林C', 3.8, 0.02, 0.55, 20, 3, 'GATLING_GUN')
            ]
        },
        // —— 组合型：考验面对多武器节奏切换的能力 ——
        mixed: {
            label: '武器组合·8源',
            emitters: [
                emitter('train_emitter_vb1', '组合弹A', 2.5, 0.05, 0.55, 20, 1, 'BULLET'),
                emitter('train_emitter_vb2', '组合弹B', 3.0, 0.05, 0.60, 20, 1, 'BULLET'),
                emitter('train_emitter_vb3', '双管A', 2.0, 0.05, 1.1, 10, 3, 'DOUBLE_BARREL'),
                emitter('train_emitter_vb4', '双管B', 2.3, 0.05, 1.2, 10, 3, 'DOUBLE_BARREL'),
                emitter('train_emitter_vb5', '霰弹A', 1.8, 0.08, 1.4, 3, 4, 'SHOTGUN'),
                emitter('train_emitter_vb6', '霰弹B', 2.1, 0.08, 1.5, 3, 4, 'SHOTGUN'),
                emitter('train_emitter_vb7', '追踪', 2.2, 0, 2.8, 3, 7, 'HOMING_MISSILE'),
                emitter('train_emitter_vb8', '加特林', 3.0, 0.02, 0.7, 20, 3, 'GATLING_GUN')
            ]
        },
        // —— 终局压力：所有弹种 + 多节奏，用于区分顶尖 AI ——
        ultimate: {
            label: '终极高压·12源',
            emitters: [
                emitter('train_emitter_vb1', '弹A', 2.5, 0.06, 0.35, 20, 1, 'BULLET'),
                emitter('train_emitter_vb2', '弹B', 2.8, 0.06, 0.40, 20, 1, 'BULLET'),
                emitter('train_emitter_vb3', '弹C', 3.1, 0.06, 0.42, 20, 1, 'BULLET'),
                emitter('train_emitter_vb4', '弹D', 2.4, 0.06, 0.38, 20, 1, 'BULLET'),
                emitter('train_emitter_vb5', '双管A', 2.0, 0.05, 1.0, 10, 3, 'DOUBLE_BARREL'),
                emitter('train_emitter_vb6', '双管B', 2.3, 0.05, 1.1, 10, 3, 'DOUBLE_BARREL'),
                emitter('train_emitter_vb7', '霰弹A', 1.8, 0.08, 1.2, 3, 4, 'SHOTGUN'),
                emitter('train_emitter_vb8', '霰弹B', 2.1, 0.08, 1.3, 3, 4, 'SHOTGUN'),
                emitter('train_emitter_vb9', '追踪A', 2.2, 0, 2.2, 3, 6, 'HOMING_MISSILE'),
                emitter('train_emitter_vb10', '追踪B', 2.6, 0, 2.5, 3, 7, 'HOMING_MISSILE'),
                emitter('train_emitter_vb11', '加特林A', 3.0, 0.02, 0.5, 20, 3, 'GATLING_GUN'),
                emitter('train_emitter_vb12', '加特林B', 3.4, 0.02, 0.55, 20, 3, 'GATLING_GUN')
            ]
        }
    };

    function cloneJson(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    function weaponType(name) {
        if (typeof Constants !== 'undefined' && Constants.WEAPON_TYPES) {
            var v = Constants.WEAPON_TYPES[name];
            if (v != null) return v;
        }
        var fallback = { BULLET: -1, LASER: 0, DOUBLE_BARREL: 1, SHOTGUN: 2, HOMING_MISSILE: 3, MINE: 4, GATLING_GUN: 5 };
        return fallback[name];
    }

    function emitter(id, name, rotateSpeed, directionRandomness, minShootInterval, bulletCount, magazineRecoverySec, typeName) {
        return {
            id: id,
            kind: 'point',
            name: name,
            x: null,
            y: null,
            rotation: 0,
            rotateSpeed: rotateSpeed,
            directionRandomness: directionRandomness,
            minShootInterval: minShootInterval,
            bulletCount: bulletCount,
            magazineRecoverySec: magazineRecoverySec,
            weaponType: weaponType(typeName)
        };
    }

    function mapGenFor(mapClass) {
        var theme = 0;
        if (typeof Constants !== 'undefined' && Constants.MAZE_THEMES && Constants.MAZE_THEMES.STANDARD != null) {
            theme = Constants.MAZE_THEMES.STANDARD;
        }
        var open = mapClass === 'open';
        var dense = mapClass === 'dense';
        var maze = {
            fixedWidth: 10,
            fixedHeight: 8,
            widthMultiplierMin: 1.0,
            widthMultiplierMax: 1.0,
            heightMultiplierMin: 1.0,
            heightMultiplierMax: 1.0,
            wallProbability: open ? 0 : (dense ? 0.95 : 0.8),
            tileProbability: open ? 1 : (dense ? 0.65 : 0.7),
            minReachableRatio: 1.0,
            minTilesBetweenTanks: 4,
            minTilesPerTank: 5,
            maxDeadEndPenalty: dense ? 8 : 5,
            borderOnly: open
        };
        return {
            mapClass: mapClass,
            // 地图生成只按少量真实坦克算间距；发射源另由训练模式追加，避免生成地图卡死
            maxActivePlayerCount: 3,
            ranked: true,
            symmetric: !open,
            theme: theme,
            maze: maze,
            spawns: {
                maxCrates: 0,
                maxGolds: 0,
                maxDiamonds: 0
            }
        };
    }

    var TM = function() { return global.TankTroubleTrainingMode; };

    function getGC() {
        if (typeof GameManager !== 'undefined' && GameManager.getGameController) {
            return GameManager.getGameController();
        }
        return null;
    }

    function findHumanId(gc) {
        if (!gc) return null;
        var tm = TM();
        var ids = gc.localPlayerIds || [];
        for (var i = 0; i < ids.length; i++) {
            if (tm && tm.isEmitterId && tm.isEmitterId(ids[i])) continue;
            return ids[i];
        }
        // 无人类玩家：回退到当前训练场里的非发射源坦克（lobby AI）。
        if (typeof Users !== 'undefined' && Users.getAllPlayerIds) {
            var all = Users.getAllPlayerIds();
            for (var j = 0; j < all.length; j++) {
                if (tm && tm.isEmitterId && tm.isEmitterId(all[j])) continue;
                return all[j];
            }
        }
        return ids.length ? ids[0] : null;
    }

    function ensureTreeControl() {
        if (typeof VantageTestbench === 'undefined' || !VantageTestbench.getState) return false;
        var st = VantageTestbench.getState();
        if (!st.aiControl) st.aiControl = { enabled: false, opIndex: 0, auto: false, tree: false };
        st.aiControl.enabled = true;
        st.aiControl.tree = true;
        st.aiControl.auto = false;
        return true;
    }

    // AI 不再接管任何玩家输入。Vantage AI 作为正常 lobby AI 由 AIs.update
    // 驱动；这里只确保 testbench 的 aiControl 处于树模式。
    function ensureTreeControl() {
        if (typeof VantageTestbench === 'undefined' || !VantageTestbench.getState) return false;
        var st = VantageTestbench.getState();
        if (!st.aiControl) st.aiControl = { enabled: false, opIndex: 0, auto: false, tree: false };
        st.aiControl.enabled = true;
        st.aiControl.tree = true;
        st.aiControl.auto = false;
        return true;
    }

    function tickBenchmark() {
        if (!state.benchActive) return;
        var tm = TM();
        var now = Date.now();
        var tstate = tm && tm.getTrainingState ? tm.getTrainingState() : null;
        if (tstate && !tstate.playerDead && state.lifeStart == null) {
            state.lifeStart = now;
        }
        if (state.lifeStart != null && now - state.lifeStart >= state.maxRunSec * 1000) {
            state.results.push(state.maxRunSec);
            state.runsDone++;
            state.lifeStart = null;
            log('试炼 ' + state.runsDone + '：存活 ≥ ' + state.maxRunSec + 's（超时截断）');
            if (state.runsDone >= state.runsTarget) {
                finishBenchmark();
            } else if (tm && tm.restartMap) {
                tm.restartMap(true);
                if (typeof VantageTree !== 'undefined' && VantageTree.reset) VantageTree.reset();
            }
        }
    }

    function recordDeath() {
        if (!state.benchActive) return;
        var now = Date.now();
        var life = state.lifeStart != null ? Math.max(0, (now - state.lifeStart) / 1000) : 0;
        state.results.push(life);
        state.runsDone++;
        state.lifeStart = null;
        log('试炼 ' + state.runsDone + '：存活 ' + life.toFixed(1) + 's');
        // 死亡现场留档：shape/最后事件/弹差/树操作，便于查“低级死亡”。
        if (global.console && typeof VantageTree !== 'undefined' && VantageTree.dumpDiagnostics) {
            try {
                var dg = VantageTree.dumpDiagnostics();
                console.log('[VantageTrainingBench][死亡现场]', {
                    life: life,
                    tNow: dg.tNow,
                    shape: dg.shape,
                    threatIds: dg.threatIds,
                    lastBulletError: dg.diag && dg.diag.lastBulletError,
                    lastTankError: dg.diag && dg.diag.lastTankError,
                    events: (dg.events || []).slice(-12),
                    stats: dg.stats
                });
            } catch (eDg) {}
        }
        if (state.runsDone >= state.runsTarget) {
            finishBenchmark();
        }
    }

    function finishBenchmark() {
        state.benchActive = false;
        var arr = state.results.slice();
        var sum = 0, min = Infinity, max = -Infinity, i;
        for (i = 0; i < arr.length; i++) {
            sum += arr[i];
            if (arr[i] < min) min = arr[i];
            if (arr[i] > max) max = arr[i];
        }
        if (!arr.length) { log('基准结束：无有效数据'); return; }
        var avg = sum / arr.length;
        log('基准结束 [' + (state.currentPreset ? BENCHMARKS[state.currentPreset].label : '?') + ']：' +
            arr.length + '局 | 平均 ' + avg.toFixed(1) + 's | 最短 ' + min.toFixed(1) +
            's | 最长 ' + max.toFixed(1) + 's');
        if (global.console) {
            console.log('[VantageTrainingBench]', {
                preset: state.currentPreset,
                runs: state.runsTarget,
                times: arr,
                avg: avg, min: min, max: max
            });
        }
    }

    function openMapEmitterSpots() {
        // 空旷场固定 10×8 格，八角位：四角 + 四边中点，向心朝向。
        return [
            { x: 15, y: 15, rotation: Math.atan2(35, -25) },
            { x: 50, y: 15, rotation: Math.atan2(0, -25) },
            { x: 85, y: 15, rotation: Math.atan2(-35, -25) },
            { x: 85, y: 40, rotation: Math.atan2(-35, 0) },
            { x: 85, y: 65, rotation: Math.atan2(-35, 25) },
            { x: 50, y: 65, rotation: Math.atan2(0, 25) },
            { x: 15, y: 65, rotation: Math.atan2(35, 25) },
            { x: 15, y: 40, rotation: Math.atan2(35, 0) }
        ];
    }

    function applyBurstProfile(em) {
        // 所有基准统一为“极短时间大量放弹，随后长停歇”：
        // 树有时间重建，压力则集中在短窗口。
        var wt = em.weaponType;
        var C = (typeof Constants !== 'undefined' && Constants.WEAPON_TYPES) ? Constants.WEAPON_TYPES : null;
        if (C && wt === C.HOMING_MISSILE) {
            em.bulletCount = 4;
            em.minShootInterval = 0.12;
            em.magazineRecoverySec = 20;
        } else if (C && wt === C.SHOTGUN) {
            em.bulletCount = 5;
            em.minShootInterval = 0.08;
            em.magazineRecoverySec = 16;
        } else if (C && wt === C.GATLING_GUN) {
            em.bulletCount = 30;
            em.minShootInterval = 0.04;
            em.magazineRecoverySec = 18;
        } else {
            // 普通弹/双管：短窗高密度。
            em.bulletCount = 10;
            em.minShootInterval = 0.05;
            em.magazineRecoverySec = 14;
        }
        return em;
    }

    function emittersForMap(b, mapClass) {
        var out = [];
        var spots = mapClass === 'open' ? openMapEmitterSpots() : null;
        for (var i = 0; i < b.emitters.length; i++) {
            var em = applyBurstProfile(cloneJson(b.emitters[i]));
            if (spots) {
                var sp = spots[i % spots.length];
                em.x = sp.x;
                em.y = sp.y;
                em.rotation = sp.rotation;
            }
            out.push(em);
        }
        return out;
    }

    function applyBenchmarkPreset(name, mapClass, spawnMode) {
        var b = BENCHMARKS[name];
        var tm = TM();
        if (!b || !tm) return false;
        if (state.applying) {
            log('模板正在应用，请稍候…');
            return false;
        }
        state.applying = true;
        mapClass = MAP_CLASSES[mapClass] ? mapClass : 'standard';
        spawnMode = SPAWN_MODES[spawnMode] ? spawnMode : 'center';

        // 运行中切模板极易卡死：先暂停训练，完成后再由 restartMap(true) 恢复。
        var tstate = tm.getTrainingState ? tm.getTrainingState() : null;
        if (tstate && tstate.running && tm.setRunning) {
            tm.setRunning(false);
        }

        try {
            if (!tm.replaceEmitters) {
                log('训练模式缺少 replaceEmitters 接口');
                state.applying = false;
                return false;
            }
            var emitters = emittersForMap(b, mapClass);
            var replaced = tm.replaceEmitters(emitters);
            if (typeof console !== 'undefined') {
                console.log('[VantageTrainingBench] 已写入发射源:', emitters.length, '实际:', replaced);
            }
        } catch (eEmitters) {
            if (typeof console !== 'undefined' && console.error) console.error('[VantageTrainingBench] replaceEmitters 异常:', eEmitters);
            log('发射源应用失败: ' + (eEmitters && eEmitters.message ? eEmitters.message : eEmitters));
            state.applying = false;
            return false;
        }
        try {
            if (tm.prepareBenchmarkMap) {
                var mapInfo = tm.prepareBenchmarkMap(MAP_CLASSES[mapClass].mapGen(), spawnMode);
                if (!mapInfo || !mapInfo.fixedMaze) {
                    log('地图已保存为分类参数，将在开新局时生成');
                } else if (typeof console !== 'undefined') {
                    console.log('[VantageTrainingBench] 固定地图/出生点:', mapInfo.fixedHumanSpawn);
                }
            }
        } catch (eMap) {
            if (typeof console !== 'undefined' && console.error) console.error('[VantageTrainingBench] prepareBenchmarkMap 异常:', eMap);
            log('地图应用失败: ' + (eMap && eMap.message ? eMap.message : eMap));
        }
        if (tm.applySettingsPatch) {
            tm.applySettingsPatch({
                autoRespawn: true,
                respawnInPlace: true,
                autoNewMap: false,
                respawnDelaySec: 0.5
            });
        }
        try {
            if (tm.restartMap) tm.restartMap(true);
        } catch (eRestart) {
            if (typeof console !== 'undefined' && console.error) console.error('[VantageTrainingBench] restartMap 异常:', eRestart);
            log('重开地图失败: ' + (eRestart && eRestart.message ? eRestart.message : eRestart));
        }
        if (typeof VantageTree !== 'undefined' && VantageTree.reset) VantageTree.reset();
        state.currentPreset = name;
        state.currentMapClass = mapClass;
        state.currentSpawnMode = spawnMode;
        state.applying = false;
        return true;
    }

    function startBenchmark(name, runs, mapClass, spawnMode) {
        name = name || 'single';
        mapClass = MAP_CLASSES[mapClass] ? mapClass : 'standard';
        spawnMode = SPAWN_MODES[spawnMode] ? spawnMode : 'center';
        runs = Math.max(1, Math.min(50, Math.round(runs || state.runsTarget)));
        if (!BENCHMARKS[name]) { log('未知基准配置：' + name); return false; }
        var tm = TM();
        if (!tm || !tm.isActive || !tm.isActive()) { log('请先进入训练模式'); return false; }
        state.benchActive = false;
        state.results = [];
        state.runsDone = 0;
        state.runsTarget = runs;
        state.lifeStart = null;
        state.benchStartAt = Date.now();
        enableAI();
        if (!applyBenchmarkPreset(name, mapClass, spawnMode)) { log('应用基准配置失败'); return false; }
        state.benchActive = true;
        log('基准开始 [' + BENCHMARKS[name].label + ' | ' + MAP_CLASSES[mapClass].label +
            ' | ' + SPAWN_MODES[spawnMode] + ']：目标 ' + runs + ' 局，单局上限 ' + state.maxRunSec + 's');
        return true;
    }

    function enableAI() {
        state.aiEnabled = true;
        ensureTreeControl();
        if (typeof VantageTree !== 'undefined' && VantageTree.reset) VantageTree.reset();
        log('Vantage 树模式已就绪（AI 请在 lobby 正常添加，不接管本地玩家）');
        syncPanel();
    }

    function disableAI() {
        state.aiEnabled = false;
        state.benchActive = false;
        log('Vantage 树模式已关闭（不会改动任何玩家输入）');
        syncPanel();
    }

    /* ---------- 死亡钩子：记录每局存活 ---------- */

    function wrapKillTank() {
        if (typeof RoundController === 'undefined' || !RoundController.prototype ||
            RoundController.prototype._vtbKillWrapped) return;
        var orig = RoundController.prototype.killTank;
        RoundController.prototype.killTank = function(kill) {
            var res = orig.call(this, kill);
            try {
                var victim = kill && kill.getVictimPlayerId ? kill.getVictimPlayerId() : null;
                var gc = getGC();
                var humanId = findHumanId(gc);
                if (state.benchActive && victim != null && humanId != null && victim === humanId) {
                    recordDeath();
                }
            } catch (e4) {}
            return res;
        };
        RoundController.prototype._vtbKillWrapped = true;
    }

    /* ---------- GameController.update 钩子：AI 驱动 ---------- */

    function wrapGameControllerUpdate() {
        if (typeof GameController === 'undefined' || !GameController.prototype ||
            !GameController.prototype.update || GameController.prototype._vtbUpdateWrapped) return;
        var orig = GameController.prototype.update;
        GameController.prototype.update = function() {
            // 不再接管人类/玩家输入；只在基准运行时做计时/超时处理。
            tickBenchmark();
            return orig.call(this);
        };
        GameController.prototype._vtbUpdateWrapped = true;
    }

    function ensureHooks() {
        wrapKillTank();
        wrapGameControllerUpdate();
    }

    /* ---------- 浮窗 UI ---------- */

    function log(msg) {
        if (global.console) console.log('[VantageTrainingBench] ' + msg);
        var el = document.getElementById(PANEL_ID + '-log');
        if (el) {
            el.textContent = msg;
            el.title = (el.title ? el.title + '\n' : '') + msg;
        }
    }

    function syncPanel() {
        var runBtn = document.getElementById(PANEL_ID + '-run');
        var sel = document.getElementById(PANEL_ID + '-preset');
        var runs = document.getElementById(PANEL_ID + '-runs');
        if (runBtn) runBtn.textContent = state.benchActive ? '基准中…' : '跑基准';
        if (sel) {
            if (!sel._vtbFilled) {
                var name;
                for (name in BENCHMARKS) {
                    if (!BENCHMARKS.hasOwnProperty(name)) continue;
                    var opt = document.createElement('option');
                    opt.value = name;
                    opt.textContent = BENCHMARKS[name].label;
                    sel.appendChild(opt);
                }
                sel._vtbFilled = true;
            }
        }
        var dimSel = document.getElementById(PANEL_ID + '-dim');
        if (dimSel && !dimSel._vtbFilled) {
            var dn;
            for (dn in BENCH_DIMENSIONS) {
                if (!BENCH_DIMENSIONS.hasOwnProperty(dn)) continue;
                var dopt = document.createElement('option');
                dopt.value = dn;
                dopt.textContent = BENCH_DIMENSIONS[dn].label;
                dimSel.appendChild(dopt);
            }
            dimSel._vtbFilled = true;
        }
        var mapSel = document.getElementById(PANEL_ID + '-map');
        if (mapSel && !mapSel._vtbFilled) {
            var mc;
            for (mc in MAP_CLASSES) {
                if (!MAP_CLASSES.hasOwnProperty(mc)) continue;
                var mopt = document.createElement('option');
                mopt.value = mc;
                mopt.textContent = MAP_CLASSES[mc].label;
                mapSel.appendChild(mopt);
            }
            mapSel._vtbFilled = true;
        }
        var spawnSel = document.getElementById(PANEL_ID + '-spawn');
        if (spawnSel && !spawnSel._vtbFilled) {
            var sm;
            for (sm in SPAWN_MODES) {
                if (!SPAWN_MODES.hasOwnProperty(sm)) continue;
                var sopt = document.createElement('option');
                sopt.value = sm;
                sopt.textContent = SPAWN_MODES[sm];
                spawnSel.appendChild(sopt);
            }
            spawnSel._vtbFilled = true;
        }
        if (runs) state.runsTarget = Math.max(1, Math.min(50, Math.round(parseFloat(runs.value) || 5)));
    }

    function buildPanel() {
        if (document.getElementById(PANEL_ID)) return;
        var slot = document.getElementById('tt-vantage-bench-slot');
        if (!slot) return;   // 训练调控面板尚未构建，轮询稍后再挂
        var div = document.createElement('div');
        div.id = PANEL_ID;
        div.style.cssText = 'padding:6px 2px;font:12px/1.6 monospace;color:#c8d0e0';
        div.innerHTML =
            '<div style="color:#94e2d5;font-weight:bold;margin-bottom:4px">Vantage 基准模板</div>' +
            '<select id="' + PANEL_ID + '-dim" style="width:100%;margin-bottom:4px;background:#141824;color:#c8d0e0;border:1px solid #3b4261"></select>' +
            '<select id="' + PANEL_ID + '-preset" style="width:100%;margin-bottom:4px;background:#141824;color:#c8d0e0;border:1px solid #3b4261"></select>' +
            '<select id="' + PANEL_ID + '-map" style="width:100%;margin-bottom:4px;background:#141824;color:#c8d0e0;border:1px solid #3b4261"></select>' +
            '<select id="' + PANEL_ID + '-spawn" style="width:100%;margin-bottom:4px;background:#141824;color:#c8d0e0;border:1px solid #3b4261"></select>' +
            '<div style="margin-bottom:4px">局数 <input id="' + PANEL_ID + '-runs" type="number" min="1" max="50" value="5" ' +
            'style="width:54px;background:#141824;color:#c8d0e0;border:1px solid #3b4261"> 上限 ' + state.maxRunSec + 's</div>' +
            '<button id="' + PANEL_ID + '-apply" style="width:100%;margin-bottom:4px">应用模板</button>' +
            '<button id="' + PANEL_ID + '-run" style="width:100%;margin-bottom:4px">跑基准</button>' +
            '<div id="' + PANEL_ID + '-log" style="color:#f9e2af;min-height:14px"></div>';
        slot.appendChild(div);
        var dimSel = document.getElementById(PANEL_ID + '-dim');
        var selEl = document.getElementById(PANEL_ID + '-preset');
        var mapSelEl = document.getElementById(PANEL_ID + '-map');
        var spawnSelEl = document.getElementById(PANEL_ID + '-spawn');
        function currentSelections() {
            return {
                dim: dimSel ? dimSel.value : '',
                preset: selEl ? selEl.value : 'precision',
                map: mapSelEl ? mapSelEl.value : 'open',
                spawn: spawnSelEl ? spawnSelEl.value : 'center'
            };
        }
        function applyFromDimension() {
            var d = BENCH_DIMENSIONS[dimSel.value];
            if (!d) return;
            if (!d.preset) {
                // 「无」选项：不应用任何模板，普通训练模式不被基准接管
                log('已选择无模板：训练模式保持自身配置');
                return;
            }
            selEl.value = d.preset;
            mapSelEl.value = d.map;
            spawnSelEl.value = d.spawn;
            applyBenchmarkPreset(d.preset, d.map, d.spawn);
            log('维度模板已应用：' + d.label + '（' + d.metric + '）');
        }
        var applyTimer = null;
        function scheduleApply(fn, msg) {
            if (applyTimer) clearTimeout(applyTimer);
            applyTimer = setTimeout(function() {
                applyTimer = null;
                if (state.applying) return;
                if (fn()) log(msg);
            }, 260);
        }
        if (dimSel) dimSel.addEventListener('change', function() { scheduleApply(applyFromDimension, '维度模板已应用'); });
        if (selEl) selEl.addEventListener('change', function() {
            var c = currentSelections();
            scheduleApply(function() { return applyBenchmarkPreset(c.preset, c.map, c.spawn); },
                '场景模板已应用：' + BENCHMARKS[c.preset].label);
        });
        if (mapSelEl) mapSelEl.addEventListener('change', function() {
            var c = currentSelections();
            scheduleApply(function() { return applyBenchmarkPreset(c.preset, c.map, c.spawn); },
                '地图模板已应用：' + MAP_CLASSES[c.map].label);
        });
        if (spawnSelEl) spawnSelEl.addEventListener('change', function() {
            var c = currentSelections();
            scheduleApply(function() { return applyBenchmarkPreset(c.preset, c.map, c.spawn); },
                '出生点模板已应用：' + SPAWN_MODES[c.spawn]);
        });
        document.getElementById(PANEL_ID + '-apply').addEventListener('click', function() {
            var c = currentSelections();
            applyBenchmarkPreset(c.preset, c.map, c.spawn);
            log('模板已应用：' + BENCHMARKS[c.preset].label + ' | ' + MAP_CLASSES[c.map].label + ' | ' + SPAWN_MODES[c.spawn]);
        });
        document.getElementById(PANEL_ID + '-run').addEventListener('click', function() {
            var sel = document.getElementById(PANEL_ID + '-preset');
            var mapSel = document.getElementById(PANEL_ID + '-map');
            var spawnSel = document.getElementById(PANEL_ID + '-spawn');
            var runsEl = document.getElementById(PANEL_ID + '-runs');
            var runs = runsEl ? parseFloat(runsEl.value) : state.runsTarget;
            if (state.benchActive) {
                state.benchActive = false;
                log('基准已手动终止');
            }
            startBenchmark(
                sel ? sel.value : 'single',
                runs || 5,
                mapSel ? mapSel.value : 'standard',
                spawnSel ? spawnSel.value : 'center'
            );
        });
        syncPanel();
        // 默认停在「无」：面板构建不再自动应用模板，普通训练模式不被基准接管；
        // 需要跑基准时由主人主动选择维度或点「跑基准」。
        if (dimSel) dimSel.value = 'none';
    }

    function autoInit() {
        ensureHooks();
        buildPanel();
    }

    if (document.body) autoInit();
    else if (document.addEventListener) document.addEventListener('DOMContentLoaded', autoInit);
    else if (global.addEventListener) global.addEventListener('load', autoInit);

    // GameController 可能在训练模式安装后才就绪：轮询补挂。
    var _hookTimer = setInterval(function() {
        ensureHooks();
        buildPanel();
        if (document.getElementById(PANEL_ID) &&
            typeof GameController !== 'undefined' && GameController.prototype &&
            GameController.prototype._vtbUpdateWrapped &&
            typeof RoundController !== 'undefined' && RoundController.prototype &&
            RoundController.prototype._vtbKillWrapped) {
            clearInterval(_hookTimer);
        }
    }, 500);

    global.VantageTrainingBench = {
        BENCHMARKS: BENCHMARKS,
        enableAI: enableAI,
        disableAI: disableAI,
        startBenchmark: startBenchmark,
        listBenchmarks: function() {
            var out = [], name;
            for (name in BENCHMARKS) if (BENCHMARKS.hasOwnProperty(name)) out.push({ id: name, label: BENCHMARKS[name].label });
            return out;
        },
        getResults: function() { return state.results.slice(); }
    };

    console.log('[VantageTrainingBench] 已加载：训练调控面板内基准模板（无接管）');
})(typeof window !== 'undefined' ? window : this);
