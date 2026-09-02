/**
 * Tank Trouble — AI 决策强度配置（仅影响 AI 思考与操作，不改坦克移速/子弹数等物理数据）
 *
 * 用法：
 *   1. 设 activePreset 为 'easy' | 'normal' | 'hard' | 'expert' | 'maximum'，或 null 使用下方 custom 块
 *   2. 改 aiProfiles 里各 AI 的 traits（0.0～1.0）
 *   3. 改 decisionOverrides 里任意 Constants.AI 键（见文件末尾参考表）
 *   4. 保存后 Ctrl+Shift+R 强刷
 *
 * 原理：traits 通过 linearInterpolation(MIN, MAX, trait) 映射到决策参数；
 *       decisionOverrides 直接覆盖 Constants.AI，对所有 AI 生效。
 */
(function(global) {
    'use strict';

    /** @typedef {Object} AIProfile
     *  @property {string} playerId
     *  @property {string} name
     *  @property {Object} traits
     */

    var TRAIT_DEFAULTS = {
        /** 攻击性：追击/开火/埋雷意愿；越高越主动找架打 */
        aggressiveness: '0.5',
        /** 复仇心：被谁打死越多，越优先打谁 */
        vengefulness: '0.5',
        /** 聪明：威胁感知范围、弹道反弹预测精度、目标切换频率、拾取距离 */
        cleverness: '0.5',
        /** 贪婪：捡武器箱/金币/钻石的优先级 */
        greediness: '0.5',
        /** 胆量：越低越早躲子弹；越高越敢走危险区、越少逃跑 */
        boldness: '0.5',
        /** 专注：越高越不轻易换目标（当前 goal 的 priority 掉得更慢） */
        determination: '0.5',
        /** 灵巧：越高瞄准越准、反应/开火延迟越短 */
        dexterity: '0.5'
    };

    function profile(playerId, name, traits) {
        var t = {};
        var k;
        for (k in TRAIT_DEFAULTS) {
            if (TRAIT_DEFAULTS.hasOwnProperty(k)) {
                t[k] = traits[k] !== undefined ? String(traits[k]) : TRAIT_DEFAULTS[k];
            }
        }
        return { playerId: playerId, config: Object.assign({ name: name }, t) };
    }

    /** 官方可玩 AI：仅 Laika（6148530）；Dimitri 无有效 AIManager 行为 */
    var VANILLA_PROFILES = [
        profile('6148530', 'Laika', {
            dexterity: '0.6', cleverness: '0.4', boldness: '0.9',
            greediness: '0.2', determination: '0.6',
            aggressiveness: '0.9', vengefulness: '0.8'
        })
    ];

    /**
     * 预设 decisionOverrides 说明：
     *   提高 MAX_* 且 cleverness 高的 AI 更强；降低 MAX_FIRE_DELAY 反应更快；
     *   提高 MAX_NUM_FIRING_PATHS / MAX_FIRING_PATH_BOUNCES 瞄准更准；提高 MIN_GOAL_PERIOD 的 MIN 侧=更频繁重算目标
     */
    var PRESETS = {
        easy: {
            aiProfiles: [
                profile('6148530', 'Laika', {
                    aggressiveness: '0.5', cleverness: '0.25', boldness: '0.6',
                    dexterity: '0.35', determination: '0.3', vengefulness: '0.3', greediness: '0.15'
                })
            ],
            decisionOverrides: {
                MAX_FIRE_DELAY: 450,
                MAX_NUM_FIRING_PATHS: 2,
                MAX_FIRING_PATH_BOUNCES: 3,
                MAX_PROJECTILE_BOUNCES: 2,
                MIN_GOAL_PERIOD: 200,
                MAX_GOAL_PERIOD: 1000,
                MAX_HUNT_PRIORITY: 0.12,
                MAX_ROTATION_IMPRECISION: 0.45
            }
        },

        normal: {
            aiProfiles: VANILLA_PROFILES,
            decisionOverrides: {}
        },

        hard: {
            aiProfiles: [
                profile('6148530', 'Laika', {
                    aggressiveness: '0.95', cleverness: '0.75', boldness: '0.85',
                    dexterity: '0.8', determination: '0.85', vengefulness: '0.9', greediness: '0.35'
                })
            ],
            decisionOverrides: {
                MAX_FIRE_DELAY: 120,
                MAX_NUM_FIRING_PATHS: 7,
                MAX_FIRING_PATH_BOUNCES: 8,
                MAX_PROJECTILE_BOUNCES: 6,
                MIN_GOAL_PERIOD: 60,
                MAX_GOAL_PERIOD: 400,
                MAX_HUNT_PRIORITY: 0.35,
                MAX_ROTATION_IMPRECISION: 0.12,
                MIN_DISTANCE_TO_FIRE: 12.0,
                MAX_DISTANCE_TO_FIRE: 28.0,
                MAX_ESCAPE_PATH_LENGTH: 9,
                MIN_PATH_THREAT_WEIGHT: 0.25
            }
        },

        expert: {
            aiProfiles: [
                profile('6148530', 'Laika', {
                    aggressiveness: '1.0', cleverness: '0.95', boldness: '0.75',
                    dexterity: '0.95', determination: '0.95', vengefulness: '1.0', greediness: '0.4'
                })
            ],
            decisionOverrides: {
                MAX_FIRE_DELAY: 40,
                MAX_RETALIATE_DELAY: 30,
                MAX_NUM_FIRING_PATHS: 9,
                MAX_FIRING_PATH_BOUNCES: 10,
                MAX_PROJECTILE_BOUNCES: 8,
                MAX_PROJECTILE_DISTANCE_TO_CONSIDER: 14,
                MAX_TANK_HUNT_DISTANCE_TO_CONSIDER: 28,
                MIN_GOAL_PERIOD: 40,
                MAX_GOAL_PERIOD: 250,
                MAX_HUNT_PRIORITY: 0.45,
                MAX_ROTATION_IMPRECISION: 0.05,
                MIN_DISTANCE_TO_FIRE: 16.0,
                MAX_DISTANCE_TO_FIRE: 32.0,
                MAX_ESCAPE_PATH_LENGTH: 11,
                MIN_PATH_THREAT_WEIGHT: 0.35,
                MAX_PRIORITY_DECREASE: 0.00005,
                KILLS_TO_REMEMBER: 15
            }
        },

        /**
         * 最强可用预设（高 traits + 加强决策，但不破坏行为逻辑）
         *
         * 切勿极端化的参数（会导致站桩连射/愣住）：
         *   MAX_FIRE_DELAY → 0        每帧开火
         *   MIN_GOAL_PERIOD → 过小    每十几 ms 打断动作队列
         *   MAX_DISTANCE_TO_FIRE 过大  打不中仍疯狂射击
         *   SHOOT_AFTER 偏移过大        压制 HUNT，不靠近敌人
         */
        maximum: {
            aiProfiles: [
                profile('6148530', 'Laika', {
                    aggressiveness: '0.82', cleverness: '0.94', boldness: '0.52',
                    dexterity: '0.93', determination: '0.92', vengefulness: '0.88', greediness: '0.25'
                })
            ],
            decisionOverrides: {
                MAX_AGGRESSIVENESS_GROWTH: 0.00035,
                AGGRESSIVENESS_SHOOT_AFTER_SHRINKAGE: 0.32,
                AGGRESSIVENESS_RETALIATE_SHRINKAGE: 0.22,
                MIN_GOAL_PERIOD: 120,
                MAX_GOAL_PERIOD: 320,
                MIN_PRIORITY_DECREASE: 0.00006,
                MAX_PRIORITY_DECREASE: 0.00035,
                MAX_FIRE_DELAY: 120,
                MAX_RETALIATE_DELAY: 80,
                MAX_ROTATION_IMPRECISION: 0.05,
                MAX_NUM_FIRING_PATHS: 9,
                MAX_FIRING_PATH_BOUNCES: 10,
                MAX_FIRING_PATH_LENGTH: 12,
                MIN_FIRING_PATH_SPREAD: 0.85,
                MAX_FIRING_PATH_SPREAD: 3.2,
                FIRING_PATH_RANDOM_OFFSET: 0.06,
                MAX_PROJECTILE_BOUNCES: 7,
                MAX_PROJECTILE_DISTANCE_TO_CONSIDER: 16,
                MIN_TANK_HUNT_DISTANCE_TO_CONSIDER: 8,
                MAX_TANK_HUNT_DISTANCE_TO_CONSIDER: 64,
                MIN_TANK_TARGET_DISTANCE_TO_CONSIDER: 3,
                MAX_TANK_TARGET_DISTANCE_TO_CONSIDER: 10,
                MIN_DISTANCE_TO_FIRE: 6.0,
                MAX_DISTANCE_TO_FIRE: 14.0,
                MIN_SHOOT_AFTER_PRIORITY_OFFSET: 0.0,
                MAX_SHOOT_AFTER_PRIORITY_OFFSET: 0.35,
                MAX_HUNT_PRIORITY: 0.72,
                MAX_ESCAPE_PATH_LENGTH: 12,
                MIN_ESCAPE_PATH_LENGTH: 2,
                MIN_IDLE_DURATION: 0,
                MAX_IDLE_DURATION: 0,
                TIME_TO_DODGE: 1.65,
                DISTANCE_TO_DODGE: 12,
                AMOUNT_TO_DODGE: 5.5,
                DODGE_PRIORITY_OFFSET: 3.2,
                MIN_SCARY_PROJECTILE_DISTANCE: 4,
                MAX_SCARY_PROJECTILE_DISTANCE: 16,
                MIN_PATH_THREAT_WEIGHT: 0.45,
                MAX_PATH_THREAT_WEIGHT: 0.95,
                MIN_PATH_DEAD_END_WEIGHT: 0.55,
                MAX_PATH_DEAD_END_WEIGHT: 1.4,
                KILLS_TO_REMEMBER: 14,
                MAX_REVENGE_PRIORITY: 0.82,
                MAX_LAY_TRAP_PRIORITY_OFFSET: 1.0,
                MIN_IDLE_DISTANCE: 6
            },
            /**
             * 行为补丁（local_patch.js 读取，弥补纯 Constants 调参的局限）
             */
            behavior: {
                enabled: true,
                huntMinTileDistance: 3,
                /** 有敌人时不再闲逛到随机空地 */
                alwaysHuntWhenEnemy: true,
                skipIdleWander: true,
                skipLootWhenEnemies: true,
                /** 动作队列空 / 发呆时立刻重算目标 */
                antiStall: true,
                immediateActionReplan: true,
                emptyActionReplan: true,
                replanNonCombatActions: true,
                stallBreakMs: 320,
                aiOnlyStallBreakMs: 220,
                stallMoveThreshold: 0.45,
                /** 纯 AI 对战时加快节奏 */
                aiOnlyBoost: true,
                aiOnlyHuntPriority: 0.68,
                aiOnlyHuntPeriod: 70,
                farEnemyTileDistance: 18,
                farEnemyHuntPriority: 0.62,
                farEnemyHuntPeriod: 100,
                normalHuntPeriod: 120,
                baseHuntPriority: 0.52,
                huntMaxTileDistance: 999,
                shootFailHuntBoost: true,
                fireOnlyOnHit: true,
                fireScanPaths: 11,
                /** 威胁走廊封路：每发子弹=轨迹加宽，优先覆盖未被覆盖的区域 */
                coverageShoot: true,
                coverageRadiusTiles: 6,
                coverageMaxAimPoints: 28,
                threatCorridorSlack: 1.4,
                totalThreatWeight: 0.28,
                novelThreatWeight: 0.72,
                corridorOverlapPenalty: 8.0,
                rejectRedundantShots: true,
                minNovelThreatPoints: 2,
                minFollowUpNovelThreat: 4,
                maxCorridorOverlapRatio: 0.68,
                diversifyShots: true,
                shotHistoryCount: 10,
                diversifyNovelThreatGap: 3,
                diversifyScoreGap: 1.6,
                minShotQuality: 0.38,
                sameAngleCooldownMs: 300,
                minRepeatAngleRad: 0.16,
                maxRepeatOverlapRatio: 0.48,
                requirePlannedShotBeforeFire: true,
                aimImprecisionScale: 0.35,
                /** Flash 4399：31 条 ray × 250° 扇形 + 弹道时间拦截 */
                interceptShoot: true,
                interceptScanPaths: 31,
                interceptSpreadRad: 4.363,
                interceptBounces: 10,
                interceptMaxTiles: 14,
                interceptMaxFireDelay: 90,
                interceptHitSlack: 1.35,
                proactiveShoot: false,
                tacticalShoot: true,
                /** 射击驱动站位：先规划有效弹道，再移动到该弹道的站位点射击 */
                shotDrivenStance: true,
                shotStanceMaxTiles: 12,
                shotStanceReachM: 0.6,
                shotStanceShootWeight: 0.58,
                shotStanceSafetyWeight: 0.32,
                shotStanceTimeWeight: 0.24,
                /** 并行认知：同时评估走位、射击位、安全、移动耗时 */
                parallelCognition: true,
                respectVanillaFireGate: true,
                respectAggressiveness: true,
                respectShootGoalPeriod: false,
                minAggressivenessToShoot: 0.12,
                maxShootDodgeUrgency: 0.55,
                tacticalShootWeight: 0.52,
                tacticalSafetyWeight: 0.38,
                tacticalTimeWeight: 0.22,
                tacticalProbeRadius: 3,
                tacticalShootDistMin: 4,
                tacticalShootDistMax: 14,
                minPositionSafety: 0.28,
                minPositionShootPotential: 0.22,
                postShotRepositionMs: 320,
                postShotHuntPeriod: 160,
                shootGoalPeriodMin: 280,
                /** 角弹/反弹：至少 1 次墙反弹即算角弹，强烈优先于直射 */
                cornerRicochet: true,
                requireMinRicochet: true,
                preferRicochet: true,
                ricochetMinBounces: 1,
                ricochetScoreBonus: 2.4,
                ricochetPerBounceBonus: 0.65,
                ricochetPreferScoreSlack: 2.2,
                wallGrazingAngleMinDeg: 75,
                wallGrazingAngleMaxDeg: 89,
                wallGrazingAngleBonus: 1.35,
                penalizeDirectShot: true,
                directShotPenalty: 0.85,
                cornerRicochetBonus: 3.8,
                cornerRicochetWillingness: 0.99,
                cornerSegmentBonus: 0.4,
                cornerSegmentEpsilon: 0.02,
                cornerAimRadiusTiles: 4,
                /** 首次反弹点离敌人越近，弹道评分越高 */
                firstBounceProximityBonus: 1.75,
                firstBounceProximityMaxTiles: 8,
                /** 前 N 次反弹内发生的角弹段，每段额外加分 */
                earlyCornerRicochetBonus: 0.9,
                earlyCornerRicochetMaxBounces: 3,
                /** 预判敌人移动后再瞄准（原版只打当前位置） */
                leadTarget: true,
                leadIterations: 6,
                leadTimeScale: 1.18,
                leadMinTargetSpeed: 0.12,
                leadAngleScan: 8,
                leadAngleStep: 0.08,
                /** 更早、更优先躲弹；动态移动躲弹，禁止原地转向 */
                /** 时空躲弹：坦克实体半径 + 子弹半径 + 穿弹时间窗 */
                temporalDodge: true,
                dodgeSafetySampleDt: 0.025,
                dodgeBodySlack: 0.15,
                dodgeActiveThreatDist: 8.5,
                dodgeMinMargin: -0.12,
                dodgeThreatConsiderDist: 30,
                dodgeSimMaxTime: 1.6,
                dodgeSimDt: 0.025,
                dodgeInputDuration: 400,
                dodgeGoalPeriod: 60,
                smartDodge: true,
                dynamicDodge: true,
                comboDodge: true,
                dodgeRequireMovement: false,
                dodgeDisplacementWeight: 0.4,
                dodgeLateralWeight: 1.15,
                dodgeRepeatPenalty: 2.0,
                dodgeMinClearance: 1.85,
                narrowSpaceOpenDirs: 2,
                narrowProbeTiles: 0.42,
                dodgePriorityBoost: 2.8,
                dodgeUrgentTime: 2.2,
                dodgeUrgentDistance: 16,
                dodgeThreatConsiderDist: 30,
                dodgeWallEscape: true,
                /** 本时刻安全区 F8：双圆半径 + margin 朝向采样 */
                safetyRotationSamples: 16
            }
        }
    };

    var CONFIG = {
        /**
         * 当前预设：'easy' | 'normal' | 'hard' | 'expert' | 'maximum' | null
         * null = 使用 custom 块（可单独微调 aiProfiles + decisionOverrides）
         */
        activePreset: 'maximum',

        presets: PRESETS,

        /** activePreset 为 null 时生效 */
        custom: {
            aiProfiles: VANILLA_PROFILES,
            decisionOverrides: {
                // 示例：取消注释即可全局加强瞄准
                // MAX_FIRING_PATH_BOUNCES: 8,
                // MAX_NUM_FIRING_PATHS: 7,
                // MAX_FIRE_DELAY: 100
            }
        }
    };

    /**
     * 解析当前生效的配置块
     * @returns {{ aiProfiles: Array, decisionOverrides: Object }}
     */
    function resolve() {
        var presetName = CONFIG.activePreset;
        if (presetName && PRESETS[presetName]) {
            return {
                aiProfiles: PRESETS[presetName].aiProfiles,
                decisionOverrides: PRESETS[presetName].decisionOverrides || {},
                behavior: PRESETS[presetName].behavior || CONFIG.behavior || null
            };
        }
        return {
            aiProfiles: CONFIG.custom.aiProfiles || VANILLA_PROFILES,
            decisionOverrides: CONFIG.custom.decisionOverrides || {},
            behavior: CONFIG.custom.behavior || CONFIG.behavior || null
        };
    }

    /**
     * 将 decisionOverrides 写入 Constants.AI（需在 Constants 加载后调用）
     */
    function applyDecisionConstants(overrides) {
        if (typeof Constants === 'undefined' || !Constants.AI || !overrides) {
            return 0;
        }
        var n = 0;
        var key;
        for (key in overrides) {
            if (!overrides.hasOwnProperty(key)) continue;
            if (Constants.AI[key] === undefined) {
                console.warn('[AI Strength] 未知 Constants.AI 键:', key);
                continue;
            }
            Constants.AI[key] = overrides[key];
            n++;
        }
        return n;
    }

    /**
     * 转为 getAIs / AIs.ais 使用的数组
     */
    function getAIList() {
        return resolve().aiProfiles.slice();
    }

    global.TankTroubleAIStrengthConfig = CONFIG;
    global.TankTroubleAIStrength = {
        resolve: resolve,
        getAIList: getAIList,
        applyDecisionConstants: applyDecisionConstants,
        TRAIT_DEFAULTS: TRAIT_DEFAULTS,
        profile: profile
    };

})(typeof window !== 'undefined' ? window : this);

/*
================================================================================
 decisionOverrides 完整参考（Constants.AI，默认值来自 RELEASE-2026-05-11-01）
 改 MAX_* 通常让高 cleverness 的 AI 更强；改 MIN_* 影响低 cleverness AI。
 traits 与下列常量通过 cleverness/aggressiveness 等插值联动，二者可同时使用。
================================================================================

【威胁感知 — 聪明(cleverness)越高，越接近右侧 MAX 值】
  PATH_STEP_SIZE: 0.1
    威胁图/弹道采样步长（格）
  MIN/MAX_PROJECTILE_DISTANCE_TO_CONSIDER: 4 / 10
    纳入计算的飞行子弹最远距离（格）
  MIN/MAX_PROJECTILE_PATH_LENGTH: 4 / 10
    子弹轨迹模拟长度（格）
  MIN/MAX_PROJECTILE_BOUNCES: 1 / 5
    预测子弹反弹次数
  PROJECTILE_THREAT_TIME_FALLOFF: 0.25
    子弹到达时间与自身到达时间差的影响衰减
  PROJECTILE_THREAT_WEIGHT: 0.5
    子弹威胁在 threatMap 上的权重
  MIN/MAX_TRAP_THREAT_DISTANCE_TO_CONSIDER: 8 / 16
    感知地雷/陷阱的距离（格）
  TRAP_THREAT_WEIGHT: 10
  MINE_INITIAL_THREAT_WEIGHT: 10
  MINE_THREAT_MIN/MAX_TIME_FALLOFF: 0.1 / 1.0
    地雷放置越久威胁越低
  OWN_MINE_THREAT_MAX/MIN_TIME_MODIFIER: 0.8 / 0.2
    对自己埋的地雷威胁折扣（cleverness 高则更忽略）
  MIN/MAX_TANK_THREAT_DISTANCE_TO_CONSIDER: 8 / 16
    感知敌方坦克威胁的距离
  MIN/MAX_FIRING_THREAT_PATH_BOUNCES: 2 / 5
    预测「敌人可能朝我开火」的反弹次数
  MIN/MAX_FIRING_THREAT_PATH_LENGTH: 2 / 10
  FIRING_PATH_THREAT_WEIGHT: 0.25
  TANK_THREAT_WEIGHT: 2
  LASER_AIMER_THREAT_WEIGHT: 0.5
  SPAWN_ZONE_THREAT_WEIGHT: 10
  STORM_ZONE_THREAT_WEIGHT: 10

【攻击性动态 — aggressiveness trait】
  MIN/MAX_AGGRESSIVENESS_GROWTH: 0 / 0.0003
    每毫秒 currentAggressiveness 向配置上限增长的速度
  AGGRESSIVENESS_SHOOT_AFTER_SHRINKAGE: 0.3
    主动射击后攻击性临时降低量
  AGGRESSIVENESS_RETALIATE_SHRINKAGE: 0.2
    反击开火后降低量
  AGGRESSIVENESS_LAY_TRAP_SHRINKAGE: 0.5
    埋雷后降低量

【贪婪动态 — greediness trait】
  MIN/MAX_GREEDINESS_GROWTH: 0 / 0.0003
  GREEDINESS_PICK_UP_COLLECTIBLE_SHRINKAGE: 0.5
    捡东西后贪婪临时降低

【拾取优先级 — cleverness / greediness】
  MIN/MAX_CRATE_DISTANCE_TO_CONSIDER: 4 / 10
  MIN/MAX_CRATE_DISTANCE_FALLOFF: 0.01 / 0.25
  MIN/MAX_CRATE_PRIORITY_OFFSET: 0.5 / 1.0
  MIN/MAX_CURRENCY_DISTANCE_TO_CONSIDER: 6 / 20
  MIN/MAX_CURRENCY_DISTANCE_FALLOFF: 0.01 / 0.25
  MIN/MAX_GOLD_PRIORITY_OFFSET: 0 / 0.5
  MIN/MAX_DIAMOND_PRIORITY_OFFSET: 0.1 / 1.0

【目标切换 — determination / cleverness】
  MIN/MAX_PRIORITY_DECREASE: 0.0001 / 0.001
    当前目标 priority 衰减速度（determination 高=衰减慢=更专注）
  MIN/MAX_GOAL_PERIOD: 100 / 800 ms
    选定目标后多久内不重新决策（cleverness 低=周期更长=更「呆」）

【追击 / 闲逛】
  MAX_HUNT_PRIORITY: 0.2
    HUNT 目标 priority 上限系数
  IDLE_PRIORITY: 0.01
  MIN/MAX_IDLE_DURATION: 100 / 500 ms
  MIN_IDLE_DISTANCE: 2
  MIN/MAX_TANK_HUNT_DISTANCE_TO_CONSIDER: 6 / 20

【复仇 / 制胜目标 — vengefulness / cleverness】
  KILLS_TO_REMEMBER: 10
  MIN/MAX_KILLS_TO_BE_BLINDED_BY_REVENGE: 1 / 5
  MIN/MAX_REVENGE_PRIORITY: 0.2 / 0.8
  MIN/MAX_WIN_PRIORITY: 0.1 / 0.7

【躲避子弹 — boldness】
  MIN/MAX_SCARY_PROJECTILE_DISTANCE: 3 / 15
    视为「可怕」的子弹距离
  MIN/MAX_DODGE_PROJECTILE_DISTANCE: 4 / 12
  MIN/MAX_ESCAPE_PATH_LENGTH: 1 / 7
    躲避寻路长度（格）
  TIME_TO_DODGE: 1.0
  DISTANCE_TO_DODGE: 8.0
  AMOUNT_TO_DODGE: 4.0
  DODGE_PRIORITY_OFFSET: 1.5

【射击决策 — aggressiveness / cleverness / dexterity】
  MIN/MAX_TANK_TARGET_DISTANCE_TO_CONSIDER: 3 / 8
  MIN/MAX_SHOOT_AFTER_PRIORITY_OFFSET: 0 / 1.5
  MAX_FIRE_DELAY: 300 ms
    dexterity=0 时的开火反应延迟上限；降低=全体 AI 反应更快
  MIN/MAX_FIRING_PATH_BOUNCES: 1 / 6
    射击前扫描弹道的反弹次数
  MIN/MAX_FIRING_PATH_LENGTH: 2 / 8
  MIN/MAX_NUM_FIRING_PATHS: 1 / 5
    每帧尝试的射击角度数量
  MIN/MAX_FIRING_PATH_SPREAD: 1.04 / 2.09 rad
    扫描扇形宽度（aggressiveness 高=更宽=更乱枪）
  FIRING_PATH_RANDOM_OFFSET: 0.35
  MIN/MAX_PREFERRED_CLOSEST_DISTANCE_OFFSET: 3 / 8
    优先目标命中距离容差
  MIN/MAX_DISTANCE_TO_FIRE: 8 / 20
    「够近才开火」的 NEAR 判定（aggressiveness）
  MIN_FIRST_SEGMENT_TO_FIRE: 4.0
    第一段过短则视为自杀射击
  MIN/MAX_DISTANCE_TO_RETALIATE: 4 / 10
  MAX_RETALIATE_DELAY: 100 ms

【埋雷 / 脱困 / 逃跑】
  MIN/MAX_LAY_TRAP_PRIORITY_OFFSET: 0 / 1.0
  LAY_TRAP_DRIVE_FORWARD_DISTANCE: 0.33
  OWN_TRAP_MIN_DISTANCE: 2
  GET_UNSTUCK_GOAL_PERIOD: 30
  GET_UNSTUCK_DISTANCE: 2.5
  MAX_STUCK_TIME: 100
  MIN/MAX_RUN_AWAY_DISTANCE_TO_CONSIDER: 6 / 20
  MIN/MAX_RUN_AWAY_PRIORITY_OFFSET: 0.2 / 1.0
  MIN/MAX_LASER_AIMER_DISTANCE: 3 / 12

【驾驶 / 转向精度 — dexterity】
  DRIVE_TO_TILE_DISTANCE_SQUARED: 4.0
  DRIVE_TO_POSITION_DISTANCE_SQUARED: 1.0
  TURN_TO_DIFFERENCE: 0.1
  MAX_ROTATION_IMPRECISION: 0.3 rad
    瞄准随机误差上限；降低=更准
  MIN/MAX_TURN_AROUND_ANGLE: 1.04 / 2.09

【寻路权重 — cleverness / boldness】
  MIN/MAX_PATH_DEAD_END_WEIGHT: 0.2 / 1
    死胡同惩罚（高=更Avoid死路）
  MIN/MAX_PATH_THREAT_WEIGHT: 0.1 / 1
    绕开 threatMap 的强度（boldness 低=更绕路）
  MAX_PATH_LENGTH_TO_REVERSE: 1
  POSITION_DEAD_DISTANCE: 1
  POSITION_DEAD_ANGLE: 1.13
  ROTATION_DEAD_ANGLE: 0.1
*/
