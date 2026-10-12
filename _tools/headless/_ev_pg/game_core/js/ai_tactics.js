/**
 * AI 战术增强：Flash 式弹道扫描 + 并行认知（走位/射击/安全/耗时）+ 强化躲弹
 * 由 local_patch 在 AI / AIUtils 加载后调用 TankTroubleAITactics.install()
 */
(function(global) {
    'use strict';

    function getCfg() {
        if (typeof TankTroubleAIStrength !== 'undefined') {
            var resolved = TankTroubleAIStrength.resolve();
            if (resolved && resolved.behavior) {
                return resolved.behavior;
            }
        }
        return DEFAULT_BEHAVIOR;
    }

    /** ai_strength_config 未加载时的兜底（仍启用动态躲弹等核心逻辑） */
    var DEFAULT_BEHAVIOR = {
        enabled: true,
        smartDodge: true,
        dynamicDodge: true,
        comboDodge: true,
        dodgeRequireMovement: false,
        dodgeDisplacementWeight: 0.4,
        dodgeSafetySampleDt: 0.025,
        dodgeRepeatPenalty: 2.0,
        dodgeGoalPeriod: 120,
        dodgeInputDuration: 280,
        dodgeUrgentTime: 1.65,
        dodgeUrgentDistance: 12,
        parallelCognition: true,
        temporalDodge: true,
        tacticalShoot: true,
        shotDrivenStance: true,
        requireMinRicochet: true,
        cornerRicochet: true,
        sameAngleCooldownMs: 300,
        proactiveShoot: false,
        immediateActionReplan: true,
        respectShootGoalPeriod: true,
        postShotRepositionMs: 520
    };

    var TACTICS_VERSION = 43;
    var TACTICS_MARKER = '__tacticsV43';

    function isDodgeDebugEnabled() {
        if (global._ttDodgeDebugEnabled) return true;
        try {
            if (global.localStorage && global.localStorage.getItem('tt_dodge_debug') === '1') return true;
        } catch (e) {}
        try {
            if (global.location && global.location.search && global.location.search.indexOf('dodgeDebug=1') >= 0) {
                return true;
            }
        } catch (e2) {}
        return false;
    }

    function dodgeDebugLog() {
        if (!isDodgeDebugEnabled()) return;
        var args = ['[DodgeDebug]'];
        var i;
        for (i = 0; i < arguments.length; i++) args.push(arguments[i]);
        console.log.apply(console, args);
    }

    function bumpDodgeStat(key, payload) {
        if (!global.TT_DODGE_STATS) {
            global.TT_DODGE_STATS = {
                installAttempts: 0, dodgeExecCount: 0, dodgeApplyCount: 0,
                lastDodge: null, lastPlan: null
            };
        }
        if (key === 'install') global.TT_DODGE_STATS.installAttempts++;
        if (key === 'exec') {
            global.TT_DODGE_STATS.dodgeExecCount++;
            global.TT_DODGE_STATS.lastDodge = payload || null;
        }
        if (key === 'apply') {
            global.TT_DODGE_STATS.dodgeApplyCount++;
        }
        if (key === 'plan') global.TT_DODGE_STATS.lastPlan = payload || null;
    }

    function tacticsIsInstalled() {
        return typeof AI !== 'undefined' && AI.methods && AI.methods.update &&
            AI.methods.update[TACTICS_MARKER] === true &&
            AI._tacticsVersion === TACTICS_VERSION;
    }

    function isDodgeUrgent(dodgeInfo, cfg) {
        if (!dodgeInfo) return false;
        return dodgeInfo.closestTime < (cfg.dodgeUrgentTime !== undefined ? cfg.dodgeUrgentTime : 1.6) &&
            dodgeInfo.closestDistance < (cfg.dodgeUrgentDistance !== undefined ? cfg.dodgeUrgentDistance : 12);
    }

    function shouldBlockShootForDodge(self, cfg) {
        var cog = self._aiTacticsCognition;
        if (!cog) return false;
        var maxUrgency = cfg.maxShootDodgeUrgency !== undefined ? cfg.maxShootDodgeUrgency : 0.55;
        return cog.dodgeUrgency > maxUrgency;
    }

    function tileOf(entity) {
        return {
            x: Math.floor(entity.getX() / Constants.MAZE_TILE_SIZE.m),
            y: Math.floor(entity.getY() / Constants.MAZE_TILE_SIZE.m)
        };
    }

    function findClosestEnemy(self) {
        var maze = self.gameController.getMaze();
        var tanks = self.gameController.getTanks();
        var best = null;
        for (var id in tanks) {
            if (!tanks.hasOwnProperty(id) || id === self.aiId) continue;
            var t = tanks[id];
            var tile = tileOf(t);
            var dist = maze.getDistanceBetweenPositions(self.myPosition, tile);
            if (dist === false) continue;
            if (!best || dist < best.dist) {
                best = { id: id, tile: tile, dist: dist, tank: t };
            }
        }
        return best;
    }

    function countEnemies(self) {
        var tanks = self.gameController.getTanks();
        var n = 0;
        var id;
        for (id in tanks) {
            if (tanks.hasOwnProperty(id) && id !== self.aiId) n++;
        }
        return n;
    }

    function isPlayerAI(playerId) {
        if (typeof AIs !== 'undefined' && AIs.isAI && AIs.isAI(playerId)) return true;
        if (typeof Users !== 'undefined' && Users.isLobbyAIUser && Users.isLobbyAIUser(playerId)) {
            return true;
        }
        return false;
    }

    function hasHumanOpponent(self) {
        var tanks = self.gameController.getTanks();
        var id;
        for (id in tanks) {
            if (!tanks.hasOwnProperty(id) || id === self.aiId) continue;
            if (!isPlayerAI(id)) return true;
        }
        return false;
    }

    function isAIOnlyBattle(self) {
        return countEnemies(self) > 0 && !hasHumanOpponent(self);
    }

    function getHuntPeriod(self, enemy, cfg) {
        var base = self.goal && self.goal.period ? self.goal.period : 200;
        if (isAIOnlyBattle(self)) {
            return cfg.aiOnlyHuntPeriod !== undefined ? cfg.aiOnlyHuntPeriod : 70;
        }
        if (enemy && enemy.dist > (cfg.farEnemyTileDistance || 18)) {
            return cfg.farEnemyHuntPeriod !== undefined ? cfg.farEnemyHuntPeriod : 100;
        }
        return cfg.normalHuntPeriod !== undefined ? cfg.normalHuntPeriod : Math.min(base, 140);
    }

    function computeHuntPriority(enemy, cfg) {
        var maxDist = cfg.huntMaxTileDistance !== undefined ? cfg.huntMaxTileDistance : 999;
        var base = cfg.baseHuntPriority !== undefined ? cfg.baseHuntPriority : 0.52;
        var farBoost = cfg.farEnemyHuntPriority !== undefined ? cfg.farEnemyHuntPriority : 0.62;
        if (!enemy) return base;
        if (enemy.dist >= (cfg.farEnemyTileDistance || 18)) {
            return farBoost;
        }
        var proximity = 1 - Math.min(enemy.dist, maxDist) / maxDist;
        return base + proximity * 0.12;
    }

    function applyHuntActionsToward(self, tile) {
        var maze = self.gameController.getMaze();
        if (!maze || !self.myPosition || !tile || typeof AIUtils === 'undefined') {
            return false;
        }
        var threat = self.threatMap ? self.threatMap.data() : null;
        var path = maze.getShortestPathWithGraph(self.myPosition, tile, threat, 0.1);
        if (!path || path.length === 0) {
            return false;
        }
        self.actions = AIUtils.getActionsToFollowPath(
            path,
            tile,
            AI._ACTIONS.DRIVE_TO_TILE,
            AI._ACTIONS.DRIVE_TO_POSITION,
            self.config[AI._TRAITS.DEXTERITY]
        );
        return self.actions.length > 0;
    }

    function getPreferredHuntTile(self, enemy, cfg) {
        cfg = cfg || getCfg();
        var sp = self._aiTacticsShotStancePlan ||
            (self._aiTacticsCognition && self._aiTacticsCognition.shotStancePlan);
        if (cfg.shotDrivenStance !== false && sp && sp.moveTile) {
            return sp.moveTile;
        }
        var cog = self._aiTacticsCognition;
        if (cog && cog.positionPlan && cog.positionPlan.bestTile) {
            return cog.positionPlan.bestTile;
        }
        return enemy ? enemy.tile : null;
    }

    function needsStanceReposition(self, cfg) {
        if (!cfg || cfg.shotDrivenStance === false) return false;
        var sp = self._aiTacticsShotStancePlan ||
            (self._aiTacticsCognition && self._aiTacticsCognition.shotStancePlan);
        return !!(sp && sp.needsReposition);
    }

    function forceEngageEnemy(self, enemy, cfg, priority, period) {
        if (!enemy) return false;
        var tile = getPreferredHuntTile(self, enemy, cfg) || enemy.tile;
        forceHuntGoal(self, tile, priority || computeHuntPriority(enemy, cfg),
            period || getHuntPeriod(self, enemy, cfg));
        return true;
    }

    function shouldSuppressIdle(self, cfg) {
        if (cfg.alwaysHuntWhenEnemy === false) return false;
        return !!findClosestEnemy(self);
    }

    function actionsAreNonCombat(actions, goal) {
        if (!actions || actions.length === 0) return true;
        if (goal && goal.type === AI._GOALS.SHOOT_AFTER) {
            var j;
            for (j = 0; j < actions.length; j++) {
                if (actions[j].type === AI._ACTIONS.TURN_TO ||
                    actions[j].type === AI._ACTIONS.FIRE) {
                    return false;
                }
            }
        }
        var i;
        for (i = 0; i < actions.length; i++) {
            if (actions[i].type === AI._ACTIONS.DRIVE_TO_TILE ||
                actions[i].type === AI._ACTIONS.DRIVE_TO_POSITION ||
                actions[i].type === TACTICS_ACTION_DRIVE_INPUT ||
                actions[i].type === AI._ACTIONS.FIRE) {
                return false;
            }
        }
        return true;
    }

    function trackStallAndBreak(self, deltaTime, cfg) {
        if (cfg.antiStall === false) return false;
        if (hasActiveDodgeThreat(self, cfg)) return false;
        var enemy = findClosestEnemy(self);
        if (!enemy) {
            self._aiTacticsStallTime = 0;
            return false;
        }

        var tank = self.gameController.getTank(self.aiId);
        if (!tank) return false;

        if (self._aiTacticsMoveX === undefined) {
            self._aiTacticsMoveX = tank.getX();
            self._aiTacticsMoveY = tank.getY();
            self._aiTacticsStallTime = 0;
            return false;
        }

        var moved = Math.abs(tank.getX() - self._aiTacticsMoveX) +
            Math.abs(tank.getY() - self._aiTacticsMoveY);
        var stallMs = cfg.stallBreakMs !== undefined ? cfg.stallBreakMs : 320;
        if (isAIOnlyBattle(self)) {
            stallMs = cfg.aiOnlyStallBreakMs !== undefined ? cfg.aiOnlyStallBreakMs : 220;
        }

        if (moved < (cfg.stallMoveThreshold !== undefined ? cfg.stallMoveThreshold : 0.45)) {
            self._aiTacticsStallTime += deltaTime;
        } else {
            self._aiTacticsStallTime = 0;
            self._aiTacticsMoveX = tank.getX();
            self._aiTacticsMoveY = tank.getY();
        }

        if (self._aiTacticsStallTime < stallMs) {
            return false;
        }

        self._aiTacticsStallTime = 0;
        self.goal.period = 0;
        forceEngageEnemy(self, enemy, cfg, computeHuntPriority(enemy, cfg) + 0.08, getHuntPeriod(self, enemy, cfg));
        return true;
    }

    function preDecisionAntiStall(self, cfg) {
        if (cfg.emptyActionReplan === false) return;
        var enemy = findClosestEnemy(self);
        if (!enemy) return;

        if (self.actions.length === 0) {
            if (self._aiTacticsPostShotLock > 0) return;
            if (cfg.respectShootGoalPeriod !== false &&
                self.goal.type === AI._GOALS.SHOOT_AFTER &&
                self.goal.period > 0) {
                return;
            }
            self.goal.period = 0;
            return;
        }

        if (cfg.replanNonCombatActions === false) return;
        if (self.goal.type === AI._GOALS.IDLE && actionsAreNonCombat(self.actions, self.goal)) {
            self.goal.period = 0;
            return;
        }
        if (self.goal.type === AI._GOALS.SHOOT_AFTER && actionsAreNonCombat(self.actions, self.goal)) {
            self.goal.period = 0;
        }
    }

    function promoteShootGoalIfReady(self, cfg) {
        if (!cfg || cfg.tacticalShoot === false) return false;
        if (self._aiTacticsPostShotLock > 0) return false;
        if (hasActiveDodgeThreat(self, cfg)) return false;
        if (self.goal && self.goal.type === AI._GOALS.DODGE_PROJECTILE) return false;
        if (!canFireFromShotStance(self, cfg)) return false;

        var enemy = findClosestEnemy(self);
        if (!enemy) return false;

        if (self.goal && self.goal.type === AI._GOALS.SHOOT_AFTER &&
            String(self.goal.target) === String(enemy.id)) {
            return false;
        }

        return tryTacticalShootGoal(self, enemy, cfg);
    }

    function analyzeShootConflict(self, cfg) {
        cfg = cfg || getCfg();
        var cog = self._aiTacticsCognition;
        var plan = cog && cog.shootPlan;
        var maxDodge = cfg.maxShootDodgeUrgency !== undefined ? cfg.maxShootDodgeUrgency : 0.55;
        var out = {
            hasPlan: !!(plan && plan.shot),
            worthShooting: !!(plan && plan.worthShooting),
            allowed: !!(plan && plan.allowed),
            goal: self.goal ? self.goal.type : null,
            canExecute: false,
            executing: false,
            phase: null,
            blockedBy: null
        };

        if (!out.hasPlan) {
            out.blockedBy = 'no_plan';
            return out;
        }
        if (!out.worthShooting) {
            if (plan.blocked === 'need_stance') {
                out.blockedBy = 'need_stance';
            } else if (plan.shot && requireRicochetShot(cfg) && !shotHasMinRicochet(plan.shot, cfg)) {
                out.blockedBy = 'no_ricochet';
            } else if (plan.shot && shotTooSimilarToRecent(self, plan.shot, cfg)) {
                out.blockedBy = 'sameAngleCooldown';
            } else {
                out.blockedBy = 'low_quality';
            }
            return out;
        }
        if (self._aiTacticsPostShotLock > 0) {
            out.blockedBy = 'post_shot_reposition';
            return out;
        }
        if (plan.shot && shotTooSimilarToRecent(self, plan.shot, cfg)) {
            out.blockedBy = 'sameAngleCooldown';
            return out;
        }
        if (!self._aiTacticsPlannedShot && cfg.requirePlannedShotBeforeFire !== false &&
            self.goal && self.goal.type === AI._GOALS.SHOOT_AFTER) {
            out.blockedBy = 'no_plan';
            return out;
        }
        if (self.goal && self.goal.type === AI._GOALS.DODGE_PROJECTILE) {
            out.blockedBy = 'dodge_goal';
            return out;
        }
        if (hasActiveDodgeThreat(self, cfg)) {
            out.blockedBy = 'incoming_dodge';
            return out;
        }
        if (plan.blocked === 'aggressiveness') {
            out.blockedBy = 'aggressiveness';
            return out;
        }
        if (!out.allowed) {
            out.blockedBy = cog && cog.dodgeUrgency > maxDodge ? 'dodge_urgency' : 'not_allowed';
            return out;
        }
        if (!self.goal || self.goal.type !== AI._GOALS.SHOOT_AFTER) {
            out.blockedBy = 'goal_' + (self.goal ? self.goal.type : 'none');
            return out;
        }
        if (!canFireFromShotStance(self, cfg)) {
            out.blockedBy = 'need_stance';
            return out;
        }
        if (self.actions && self.actions.length > 0) {
            var a0 = self.actions[0];
            if (a0.type === TACTICS_ACTION_DRIVE_INPUT) {
                out.blockedBy = 'dodge_action';
                return out;
            }
            if (a0.type === AI._ACTIONS.DRIVE_TO_TILE ||
                a0.type === AI._ACTIONS.DRIVE_TO_POSITION) {
                out.blockedBy = 'hunt_action';
                return out;
            }
        }

        out.canExecute = true;
        if (self.actions && self.actions.length > 0) {
            var i, act;
            for (i = 0; i < self.actions.length; i++) {
                act = self.actions[i];
                if (act.type === AI._ACTIONS.FIRE) {
                    out.executing = true;
                    out.phase = 'firing';
                    break;
                }
                if (act.type === AI._ACTIONS.TURN_TO) {
                    out.executing = true;
                    out.phase = 'aiming';
                    break;
                }
            }
        }
        return out;
    }

    function postDecisionEngage(self, cfg) {
        if (hasActiveDodgeThreat(self, cfg)) return false;
        if (self.goal && self.goal.type === AI._GOALS.DODGE_PROJECTILE) return false;

        var enemy = findClosestEnemy(self);
        if (!enemy) return false;

        var changed = false;
        var huntPrio = computeHuntPriority(enemy, cfg);
        var huntPeriod = getHuntPeriod(self, enemy, cfg);

        if (isAIOnlyBattle(self)) {
            huntPrio = Math.max(huntPrio, cfg.aiOnlyHuntPriority !== undefined ? cfg.aiOnlyHuntPriority : 0.68);
            if (self.goal.period > huntPeriod) {
                self.goal.period = huntPeriod;
            }
        }

        if (shouldSuppressIdle(self, cfg) &&
            (self.goal.type === AI._GOALS.IDLE ||
             (cfg.skipLootWhenEnemies && self.goal.type === AI._GOALS.PICK_UP_COLLECTIBLE))) {
            forceEngageEnemy(self, enemy, cfg, huntPrio, huntPeriod);
            applyHuntActionsToward(self, getPreferredHuntTile(self, enemy, cfg));
            return true;
        }

        if (self.goal.type === AI._GOALS.HUNT && enemy.dist > (cfg.huntMinTileDistance || 3)) {
            var prefTile = getPreferredHuntTile(self, enemy, cfg);
            if ((self.goal.priority || 0) < huntPrio - 0.02) {
                forceEngageEnemy(self, enemy, cfg, huntPrio, huntPeriod);
                changed = true;
            } else if (self.goal.position && prefTile &&
                (self.goal.position.x !== prefTile.x || self.goal.position.y !== prefTile.y)) {
                forceEngageEnemy(self, enemy, cfg, Math.max(self.goal.priority || 0, huntPrio), huntPeriod);
                changed = true;
            }
        }

        if (self.goal.type === AI._GOALS.SHOOT_AFTER && cfg.shootFailHuntBoost !== false) {
            if (needsStanceReposition(self, cfg)) {
                return changed;
            }
            var cogShoot = self._aiTacticsCognition && self._aiTacticsCognition.shootPlan;
            if (cogShoot && cogShoot.worthShooting && cogShoot.allowed) {
                return changed;
            }
            var target = self.gameController.getTank(self.goal.target);
            if (!target) {
                forceEngageEnemy(self, enemy, cfg, huntPrio, huntPeriod);
                return true;
            }
            if (cfg.shotDrivenStance !== false) {
                return changed;
            }
            var maze = self.gameController.getMaze();
            var dist = maze.getDistanceBetweenPositions(self.myPosition, enemy.tile);
            if (dist !== false && dist > (cfg.huntMinTileDistance || 3) + 1 &&
                actionsAreNonCombat(self.actions, self.goal)) {
                forceEngageEnemy(self, enemy, cfg, huntPrio, huntPeriod);
                return true;
            }
        }

        return changed;
    }

    function replaceIdleWanderWithHunt(self, cfg) {
        if (cfg.skipIdleWander === false || self.goal.type !== AI._GOALS.IDLE) {
            return false;
        }
        var enemy = findClosestEnemy(self);
        if (!enemy) return false;
        return applyHuntActionsToward(self, getPreferredHuntTile(self, enemy, cfg));
    }

    function forceHuntGoal(self, tile, priority, period) {
        self.goal = {
            type: AI._GOALS.HUNT,
            priority: priority,
            id: self.nextGoalId++,
            period: period || 200,
            position: tile
        };
    }

    function getTargetVelocity(self, target) {
        var vx = 0;
        var vy = 0;
        if (target.getB2DBody) {
            var vel = target.getB2DBody().GetLinearVelocity();
            vx = vel.x;
            vy = vel.y;
        }
        if (self._aiTacticsVelX !== undefined) {
            vx = vx * 0.55 + self._aiTacticsVelX * 0.45;
            vy = vy * 0.55 + self._aiTacticsVelY * 0.45;
        }
        return { x: vx, y: vy, speed: Math.sqrt(vx * vx + vy * vy) };
    }

    function normalizeAngle(angle) {
        while (angle > Math.PI) angle -= Math.PI * 2;
        while (angle < -Math.PI) angle += Math.PI * 2;
        return angle;
    }

    function bearingToTarget(tank, tx, ty) {
        var dx = tx - tank.getX();
        var dy = ty - tank.getY();
        return normalizeAngle(Math.atan2(dx, -dy) - tank.getRotation());
    }

    function getFiringScanParams(self) {
        var clever = parseFloat(self.config[AI._TRAITS.CLEVERNESS]) || 0.5;
        var bounces = Math.ceil(MathUtils.linearInterpolation(
            Constants.AI.MIN_FIRING_PATH_BOUNCES,
            Constants.AI.MAX_FIRING_PATH_BOUNCES,
            clever
        ));
        var pathLen = MathUtils.linearInterpolation(
            Constants.AI.MIN_FIRING_PATH_LENGTH,
            Constants.AI.MAX_FIRING_PATH_LENGTH,
            clever
        );
        return {
            bounces: bounces,
            maxLength: Constants.MAZE_TILE_SIZE.m * pathLen
        };
    }

    function getInterceptHitRadiusSq(cfg) {
        var tankHalf = Constants.TANK.WIDTH.m * 0.5;
        var bulletR = Constants.BULLET.RADIUS.m;
        var slack = cfg.interceptHitSlack !== undefined ? cfg.interceptHitSlack : 1.25;
        var r = (tankHalf + bulletR) * slack;
        return r * r;
    }

    function getTankForFiring(self, pose) {
        if (!pose) return self.gameController.getTank(self.aiId);
        return {
            getX: function() { return pose.x; },
            getY: function() { return pose.y; },
            getRotation: function() { return pose.rot !== undefined ? pose.rot : 0; }
        };
    }

    function worldRotationToward(fromX, fromY, toX, toY) {
        return normalizeAngle(Math.atan2(toX - fromX, -(toY - fromY)));
    }

    function simulateFiringPath(self, angle, bounces, maxLength, pose) {
        var tank = getTankForFiring(self, pose);
        if (!tank || typeof B2DUtils === 'undefined') return null;
        return B2DUtils.calculateFiringPath(
            self.gameController.getB2DWorld(),
            tank,
            angle,
            bounces,
            maxLength,
            true
        );
    }

    /**
     * Flash checkBulletPath 思路：沿反弹弹道逐段推进，用 pathLength/bulletSpeed 作为到达时间，
     * 在该时刻预测敌人位置，判断子弹是否会命中移动目标。
     */
    function checkPathTimeIntercept(pathInfo, target, vel, bulletSpeed, hitRadiusSq, leadScale) {
        if (!pathInfo || !pathInfo.path || pathInfo.path.length < 2) return null;

        var scale = leadScale !== undefined ? leadScale : 1.15;
        var tx0 = target.getX();
        var ty0 = target.getY();
        var best = null;
        var t = 0;
        var i, s, steps;

        for (i = 0; i < pathInfo.path.length - 1; i++) {
            var sx = pathInfo.path[i].x;
            var sy = pathInfo.path[i].y;
            var ex = pathInfo.path[i + 1].x;
            var ey = pathInfo.path[i + 1].y;
            var dx = ex - sx;
            var dy = ey - sy;
            var segLen = Math.sqrt(dx * dx + dy * dy);
            if (segLen < 0.001) continue;

            steps = Math.max(2, Math.ceil(segLen / (Constants.MAZE_TILE_SIZE.m * 0.2)));
            for (s = 0; s <= steps; s++) {
                var u = (s / steps) * segLen;
                var px = sx + (dx / segLen) * u;
                var py = sy + (dy / segLen) * u;
                var time = t + u / bulletSpeed;
                var predX = tx0 + vel.x * time * scale;
                var predY = ty0 + vel.y * time * scale;
                var distSq = (px - predX) * (px - predX) + (py - predY) * (py - predY);
                if (distSq <= hitRadiusSq) {
                    var score = time + Math.sqrt(distSq) * 0.05;
                    if (!best || score < best.score) {
                        best = { time: time, score: score, hitDist: Math.sqrt(distSq) };
                    }
                }
            }
            t += segLen / bulletSpeed;
        }
        return best;
    }

    /**
     * 弹道第一次进入命中范围的位置（最早相遇点）。
     */
    function findFirstPathThreat(pathInfo, target, vel, bulletSpeed, hitRadiusSq, leadScale, cfg) {
        if (!pathInfo || !pathInfo.path || pathInfo.path.length < 2 || !target) {
            return null;
        }
        var eps = cfg && cfg.cornerSegmentEpsilon !== undefined
            ? cfg.cornerSegmentEpsilon : 0.02;
        var scale = leadScale !== undefined ? leadScale : 1.15;
        var tx0 = target.getX();
        var ty0 = target.getY();
        var path = pathInfo.path;
        var t = 0;
        var i, s, steps, sx, sy, ex, ey, dx, dy, segLen, u, px, py, time;
        var predX, predY, distSq, isCornerSeg;

        for (i = 0; i < path.length - 1; i++) {
            sx = path[i].x;
            sy = path[i].y;
            ex = path[i + 1].x;
            ey = path[i + 1].y;
            dx = ex - sx;
            dy = ey - sy;
            segLen = Math.sqrt(dx * dx + dy * dy);
            if (segLen < 0.001) continue;
            isCornerSeg = i >= 1 && !isAxisAlignedSegment(dx, dy, eps);

            steps = Math.max(2, Math.ceil(segLen / (Constants.MAZE_TILE_SIZE.m * 0.2)));
            for (s = 0; s <= steps; s++) {
                u = (s / steps) * segLen;
                px = sx + (dx / segLen) * u;
                py = sy + (dy / segLen) * u;
                time = t + u / bulletSpeed;
                predX = tx0 + vel.x * time * scale;
                predY = ty0 + vel.y * time * scale;
                distSq = (px - predX) * (px - predX) + (py - predY) * (py - predY);
                if (distSq <= hitRadiusSq) {
                    return {
                        time: time,
                        segmentIndex: i,
                        onCornerSegment: isCornerSeg,
                        px: px,
                        py: py,
                        hitDist: Math.sqrt(distSq),
                        quality: 1 - Math.sqrt(distSq) / Math.sqrt(hitRadiusSq)
                    };
                }
            }
            t += segLen / bulletSpeed;
        }
        return null;
    }

    function collectCornerAimAngles(tank, target, cfg) {
        if (!tank || !target) return [];

        var ts = Constants.MAZE_TILE_SIZE.m;
        var tx = Math.floor(target.getX() / ts);
        var ty = Math.floor(target.getY() / ts);
        var radius = cfg.cornerAimRadiusTiles !== undefined ? cfg.cornerAimRadiusTiles : 4;
        var angles = [];
        var seen = {};
        var ox, oy, cx, cy, dx, dy, gx, gy, angleKey, bearing, a;
        var r, i;

        for (r = 1; r <= radius; r++) {
            for (ox = -r; ox <= r; ox++) {
                for (oy = -r; oy <= r; oy++) {
                    if (Math.abs(ox) !== r && Math.abs(oy) !== r) continue;
                    cx = (tx + ox) * ts + ts * 0.5;
                    cy = (ty + oy) * ts + ts * 0.5;
                    dx = cx - tank.getX();
                    dy = cy - tank.getY();
                    if (Math.sqrt(dx * dx + dy * dy) < ts * 0.35) continue;
                    bearing = bearingToTarget(tank, cx, cy);
                    angleKey = Math.round(bearing * 40);
                    if (seen[angleKey]) continue;
                    seen[angleKey] = true;
                    angles.push(bearing);
                    for (i = 1; i <= 3; i++) {
                        a = bearing + i * 0.06;
                        angles.push(a);
                        a = bearing - i * 0.06;
                        angles.push(a);
                    }
                }
            }
        }
        return angles;
    }

    function pathTimeAtPointIndex(path, pointIndex, bulletSpeed) {
        var dist = 0;
        var j, dx, dy;
        for (j = 0; j < pointIndex && j < path.length - 1; j++) {
            dx = path[j + 1].x - path[j].x;
            dy = path[j + 1].y - path[j].y;
            dist += Math.sqrt(dx * dx + dy * dy);
        }
        return dist / bulletSpeed;
    }

    function isAxisAlignedSegment(dx, dy, eps) {
        eps = eps !== undefined ? eps : 0.02;
        var adx = Math.abs(dx);
        var ady = Math.abs(dy);
        if (adx < eps && ady < eps) return true;
        return adx < eps || ady < eps;
    }

    function analyzePathCornerRicochets(pathInfo, cfg) {
        if (!pathInfo || !pathInfo.path || pathInfo.path.length < 3) {
            return { count: 0, hasCorner: false, points: [] };
        }
        var eps = cfg && cfg.cornerSegmentEpsilon !== undefined
            ? cfg.cornerSegmentEpsilon : 0.02;
        var path = pathInfo.path;
        var count = 0;
        var points = [];
        var i, dx, dy, segLen, dist, bulletSpeed;

        bulletSpeed = Constants.BULLET.SPEED.m;
        for (i = 1; i < path.length - 1; i++) {
            dx = path[i + 1].x - path[i].x;
            dy = path[i + 1].y - path[i].y;
            segLen = Math.sqrt(dx * dx + dy * dy);
            if (segLen < eps) continue;
            if (!isAxisAlignedSegment(dx, dy, eps)) {
                dist = 0;
                var j;
                for (j = 0; j < i; j++) {
                    var sx = path[j + 1].x - path[j].x;
                    var sy = path[j + 1].y - path[j].y;
                    dist += Math.sqrt(sx * sx + sy * sy);
                }
                count++;
                points.push({
                    x: path[i].x,
                    y: path[i].y,
                    index: i,
                    time: dist / bulletSpeed
                });
            }
        }
        return { count: count, hasCorner: count > 0, points: points };
    }

    function getFirstBounceWorldPoint(pathInfo) {
        if (!pathInfo || !pathInfo.path || pathInfo.path.length < 3) return null;
        return pathInfo.path[1];
    }

    /**
     * 首次墙反弹点离敌人越近，finalScore 减得越多（分越高）。
     * 仅对至少 1 次反弹的弹道生效。
     */
    function scoreFirstBounceProximityBonus(pathInfo, target, cfg) {
        if (!pathInfo || !target || cfg.firstBounceProximityBonus === false) return 0;
        var pt = getFirstBounceWorldPoint(pathInfo);
        if (!pt) return 0;

        var maxBonus = cfg.firstBounceProximityBonus !== undefined
            ? cfg.firstBounceProximityBonus : 1.6;
        var maxDistTiles = cfg.firstBounceProximityMaxTiles !== undefined
            ? cfg.firstBounceProximityMaxTiles : 8;
        var ts = Constants.MAZE_TILE_SIZE.m;
        var maxDist = Math.max(ts, maxDistTiles * ts);
        var dx = pt.x - target.getX();
        var dy = pt.y - target.getY();
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist >= maxDist) return 0;
        return maxBonus * (1 - dist / maxDist);
    }

    /**
     * 非轴对齐角弹段若出现在前 N 次反弹内，每段加分。
     * 段起点 path 索引 i 对应已完成 i 次反弹后的弹道。
     */
    function scoreEarlyCornerRicochetBonus(pathInfo, cfg) {
        if (!pathInfo || cfg.earlyCornerRicochetBonus === false) return 0;
        var perSeg = cfg.earlyCornerRicochetBonus !== undefined
            ? cfg.earlyCornerRicochetBonus : 0.85;
        var maxBounces = cfg.earlyCornerRicochetMaxBounces !== undefined
            ? cfg.earlyCornerRicochetMaxBounces : 3;
        var analysis = analyzePathCornerRicochets(pathInfo, cfg);
        var total = 0;
        var i, p;
        for (i = 0; i < analysis.points.length; i++) {
            p = analysis.points[i];
            if (p.index <= maxBounces) total += perSeg;
        }
        return total;
    }

    function getPathBounceCount(pathInfo) {
        if (!pathInfo || !pathInfo.path) return 0;
        return Math.max(0, pathInfo.path.length - 2);
    }

    function pathHasRicochet(pathInfo, cfg) {
        var minBounces = cfg.ricochetMinBounces !== undefined ? cfg.ricochetMinBounces : 1;
        return getPathBounceCount(pathInfo) >= minBounces;
    }

    function pathThreatensTarget(pathInfo, target, targetId, vel, bulletSpeed, hitRadiusSq, leadScale) {
        if (!pathInfo || !target) return null;
        if (pathInfo.hit && pathInfo.hit.getPlayerId &&
            String(pathInfo.hit.getPlayerId()) === String(targetId)) {
            return {
                score: pathInfo.length / bulletSpeed,
                staticHit: true
            };
        }
        var intercept = checkPathTimeIntercept(
            pathInfo, target, vel, bulletSpeed, hitRadiusSq, leadScale
        );
        if (intercept) {
            return {
                score: intercept.score,
                staticHit: false,
                intercept: intercept
            };
        }
        return null;
    }

    function pathPassesNearPoint(pathInfo, px, py, radiusSq) {
        if (!pathInfo || !pathInfo.path) return false;
        var path = pathInfo.path;
        var i, s, steps, sx, sy, ex, ey, dx, dy, segLen, u, bx, by, dSq;
        for (i = 0; i < path.length - 1; i++) {
            sx = path[i].x;
            sy = path[i].y;
            ex = path[i + 1].x;
            ey = path[i + 1].y;
            dx = ex - sx;
            dy = ey - sy;
            segLen = Math.sqrt(dx * dx + dy * dy);
            if (segLen < 0.001) continue;
            steps = Math.max(3, Math.ceil(segLen / (Constants.MAZE_TILE_SIZE.m * 0.25)));
            for (s = 0; s <= steps; s++) {
                u = s / steps;
                bx = sx + dx * u;
                by = sy + dy * u;
                dSq = (bx - px) * (bx - px) + (by - py) * (by - py);
                if (dSq <= radiusSq) return true;
            }
        }
        return false;
    }

    function collectCoverageAimPoints(self, target, cfg) {
        var maze = self.gameController.getMaze();
        if (!maze || !maze.traverseCloseTiles || !target) return [];

        var targetTile = tileOf(target);
        var radius = cfg.coverageRadiusTiles !== undefined ? cfg.coverageRadiusTiles : 5;
        var maxPoints = cfg.coverageMaxAimPoints !== undefined ? cfg.coverageMaxAimPoints : 20;
        var ts = Constants.MAZE_TILE_SIZE.m;
        var points = [];

        maze.traverseCloseTiles(targetTile, radius, function(current) {
            if (points.length >= maxPoints) return;
            points.push({
                x: (current.x + 0.5) * ts,
                y: (current.y + 0.5) * ts,
                distance: current.distance
            });
        });
        return points;
    }

    function collectCoverageAimAngles(self, tank, target, cfg) {
        if (!tank) return [];

        var points = collectCoverageAimPoints(self, target, cfg);
        var angles = [];
        var seen = {};
        var i, bearing, key;

        for (i = 0; i < points.length; i++) {
            bearing = bearingToTarget(tank, points[i].x, points[i].y);
            key = Math.round(bearing * 28);
            if (!seen[key]) {
                seen[key] = true;
                angles.push(bearing);
            }
        }
        return angles;
    }

    function getThreatRadius(cfg) {
        var tankHalf = Constants.TANK.WIDTH.m * 0.5;
        var bulletR = Constants.BULLET.RADIUS.m;
        var slack = cfg.threatCorridorSlack !== undefined ? cfg.threatCorridorSlack : 1.4;
        return (tankHalf + bulletR) * slack;
    }

    function getThreatRadiusSq(cfg) {
        var r = getThreatRadius(cfg);
        return r * r;
    }

    function samplePathThreatPoints(pathInfo, cfg) {
        if (!pathInfo || !pathInfo.path || pathInfo.path.length < 2) return [];
        var step = cfg.threatSampleStep !== undefined
            ? cfg.threatSampleStep
            : (Constants.MAZE_TILE_SIZE.m * 0.18);
        var points = [];
        var path = pathInfo.path;
        var i, s, steps, sx, sy, ex, ey, dx, dy, segLen, u;

        for (i = 0; i < path.length - 1; i++) {
            sx = path[i].x;
            sy = path[i].y;
            ex = path[i + 1].x;
            ey = path[i + 1].y;
            dx = ex - sx;
            dy = ey - sy;
            segLen = Math.sqrt(dx * dx + dy * dy);
            if (segLen < 0.001) continue;
            steps = Math.max(1, Math.ceil(segLen / step));
            for (s = 0; s <= steps; s++) {
                u = s / steps;
                points.push({ x: sx + dx * u, y: sy + dy * u });
            }
        }
        return points;
    }

    function pointThreatenedByPath(px, py, pathInfo, radiusSq) {
        return pathPassesNearPoint(pathInfo, px, py, radiusSq);
    }

    function pointThreatenedByRecentShots(px, py, recentShots, cfg) {
        if (!recentShots || recentShots.length === 0) return false;
        var radiusSq = getThreatRadiusSq(cfg);
        var i;
        for (i = 0; i < recentShots.length; i++) {
            if (recentShots[i].pathInfo &&
                pointThreatenedByPath(px, py, recentShots[i].pathInfo, radiusSq)) {
                return true;
            }
        }
        return false;
    }

    function analyzeThreatCoverage(pathInfo, aimPoints, recentShots, cfg) {
        var radiusSq = getThreatRadiusSq(cfg);
        var totalThreat = 0;
        var novelThreat = 0;
        var i;

        if (aimPoints && aimPoints.length > 0) {
            for (i = 0; i < aimPoints.length; i++) {
                if (!pointThreatenedByPath(pathInfo, aimPoints[i].x, aimPoints[i].y, radiusSq)) {
                    continue;
                }
                totalThreat++;
                if (!pointThreatenedByRecentShots(aimPoints[i].x, aimPoints[i].y, recentShots, cfg)) {
                    novelThreat++;
                }
            }
        }

        var newSamples = samplePathThreatPoints(pathInfo, cfg);
        var overlapRatio = computeCorridorOverlap(newSamples, recentShots, cfg);
        return {
            totalThreat: totalThreat,
            novelThreat: novelThreat,
            overlapRatio: overlapRatio
        };
    }

    function computeCorridorOverlap(newSamples, recentShots, cfg) {
        if (!newSamples || newSamples.length === 0 || !recentShots || recentShots.length === 0) {
            return 0;
        }
        var radiusSq = getThreatRadiusSq(cfg);
        var overlap = 0;
        var i, j, k, dSq, samples;

        for (i = 0; i < newSamples.length; i++) {
            for (j = 0; j < recentShots.length; j++) {
                samples = recentShots[j].pathSamples;
                if (!samples || samples.length === 0) continue;
                for (k = 0; k < samples.length; k++) {
                    dSq = (newSamples[i].x - samples[k].x) * (newSamples[i].x - samples[k].x) +
                        (newSamples[i].y - samples[k].y) * (newSamples[i].y - samples[k].y);
                    if (dSq <= radiusSq) {
                        overlap++;
                        break;
                    }
                }
            }
        }
        return overlap / newSamples.length;
    }

    function countPathCoverage(pathInfo, aimPoints, cfg) {
        return analyzeThreatCoverage(pathInfo, aimPoints, [], cfg).totalThreat;
    }

    function rememberRecentShot(self, shot, cfg) {
        if (!shot || !shot.pathInfo) return;
        if (!self._aiTacticsRecentShots) self._aiTacticsRecentShots = [];
        self._aiTacticsRecentShots.push({
            pathInfo: shot.pathInfo,
            pathSamples: samplePathThreatPoints(shot.pathInfo, cfg),
            angle: shotAngleRad(shot),
            dx: shot.direction ? shot.direction.x : Math.sin(shot.angle || 0),
            dy: shot.direction ? shot.direction.y : -Math.cos(shot.angle || 0),
            bounces: shot.bounceCount || 0,
            novelThreat: shot.novelThreat || 0,
            firedAt: Date.now()
        });
        var maxKeep = cfg.shotHistoryCount !== undefined ? cfg.shotHistoryCount : 10;
        while (self._aiTacticsRecentShots.length > maxKeep) {
            self._aiTacticsRecentShots.shift();
        }
    }

    function recentShotCount(self) {
        return self._aiTacticsRecentShots ? self._aiTacticsRecentShots.length : 0;
    }

    function clonePathPoints(path) {
        if (!path || !path.length) return null;
        var out = [];
        var i;
        for (i = 0; i < path.length; i++) {
            out.push({ x: path[i].x, y: path[i].y });
        }
        return out;
    }

    function shotAngleRad(shot) {
        if (!shot) return 0;
        if (shot.angle !== undefined && shot.angle !== null) return shot.angle;
        if (shot.direction) {
            return Math.atan2(shot.direction.x, -shot.direction.y);
        }
        return 0;
    }

    function angleDiffRad(a, b) {
        var d = Math.abs(a - b) % TWO_PI;
        return d > Math.PI ? TWO_PI - d : d;
    }

    function cloneShotForPlan(shot, tank, targetId) {
        if (!shot) return null;
        var path = shot.pathInfo && shot.pathInfo.path
            ? clonePathPoints(shot.pathInfo.path) : (shot.path ? clonePathPoints(shot.path) : null);
        if (!path || path.length < 2) return null;
        var dir = shot.direction
            ? { x: shot.direction.x, y: shot.direction.y }
            : { x: Math.sin(shot.angle || 0), y: -Math.cos(shot.angle || 0) };
        return {
            angle: shotAngleRad(shot),
            direction: dir,
            path: path,
            ricochet: !!shot.ricochet,
            intercept: !!shot.intercept,
            staticHit: !!shot.staticHit,
            targetId: targetId,
            originX: tank ? tank.getX() : 0,
            originY: tank ? tank.getY() : 0,
            novelThreat: shot.novelThreat || 0,
            quality: shot.quality,
            committedAt: Date.now()
        };
    }

    function plannedShotToExecutable(plan) {
        if (!plan) return null;
        return {
            angle: plan.angle,
            direction: plan.direction,
            pathInfo: { path: plan.path },
            ricochet: plan.ricochet,
            intercept: plan.intercept,
            staticHit: plan.staticHit,
            novelThreat: plan.novelThreat,
            bounceCount: plan.bounces || 0
        };
    }

    function commitPlannedShot(self, shot, targetId, cfg, pose) {
        var tank = getTankForFiring(self, pose || null);
        var plan = cloneShotForPlan(shot, tank, targetId);
        if (!plan) return false;
        self._aiTacticsPlannedShot = plan;
        return true;
    }

    function clearPlannedShot(self) {
        self._aiTacticsPlannedShot = null;
    }

    function clearPlannedShotIfStale(self) {
        if (!self._aiTacticsPlannedShot) return;
        if (!self.goal || self.goal.type !== AI._GOALS.SHOOT_AFTER) {
            clearPlannedShot(self);
            return;
        }
        if (String(self.goal.target) !== String(self._aiTacticsPlannedShot.targetId)) {
            clearPlannedShot(self);
        }
    }

    function updateShootPreviewCache(self, shot, enemyId) {
        if (!shot || !shot.pathInfo || !shot.pathInfo.path) {
            self._aiTacticsShootPreview = null;
            return;
        }
        var angle = shotAngleRad(shot);
        var key = Math.round(angle * 20) + '_' + String(enemyId);
        var prev = self._aiTacticsShootPreview;
        if (prev && prev.key === key && String(prev.targetId) === String(enemyId)) {
            return;
        }
        var tank = self.gameController.getTank(self.aiId);
        var plan = cloneShotForPlan(shot, tank, enemyId);
        if (!plan) return;
        self._aiTacticsShootPreview = { key: key, targetId: enemyId, plan: plan };
    }

    function requireRicochetShot(cfg) {
        return cfg && cfg.requireMinRicochet !== false && cfg.cornerRicochet !== false;
    }

    function getRicochetMinBounces(cfg) {
        return cfg.ricochetMinBounces !== undefined ? cfg.ricochetMinBounces : 1;
    }

    /** 硬性角弹：至少 minBounces 次墙反弹 */
    function shotHasMinRicochet(entry, cfg) {
        if (!entry || !entry.pathInfo) return false;
        return (entry.bounceCount || 0) >= getRicochetMinBounces(cfg);
    }

    function pathOverlapWithRecentShots(self, entry, cfg) {
        if (!entry || !entry.pathInfo || !self._aiTacticsRecentShots ||
            self._aiTacticsRecentShots.length === 0) {
            return 0;
        }
        var samples = samplePathThreatPoints(entry.pathInfo, cfg);
        if (!samples.length) return 0;
        return computeCorridorOverlap(samples, self._aiTacticsRecentShots, cfg);
    }

    function shotTooSimilarToRecent(self, entry, cfg) {
        if (!entry || !self._aiTacticsRecentShots || !self._aiTacticsRecentShots.length) {
            return false;
        }
        var minAngle = cfg.minRepeatAngleRad !== undefined ? cfg.minRepeatAngleRad : 0.14;
        var minMs = cfg.sameAngleCooldownMs !== undefined ? cfg.sameAngleCooldownMs : 300;
        var now = Date.now();
        var angle = shotAngleRad(entry);
        var i, r;

        for (i = self._aiTacticsRecentShots.length - 1; i >= 0; i--) {
            r = self._aiTacticsRecentShots[i];
            if (!r.firedAt || now - r.firedAt > minMs) continue;
            if (angleDiffRad(angle, r.angle) < minAngle) return true;
        }
        return false;
    }

    function stripVanillaShootActions(self) {
        if (!self.actions || !self.actions.length) return;
        var kept = [];
        var i;
        for (i = 0; i < self.actions.length; i++) {
            if (self.actions[i].type === AI._ACTIONS.FIRE ||
                self.actions[i].type === AI._ACTIONS.TURN_TO) {
                continue;
            }
            kept.push(self.actions[i]);
        }
        self.actions = kept;
    }

    function isAimingOrFiring(self) {
        if (!self.actions || !self.actions.length) return false;
        var t = self.actions[0].type;
        return t === AI._ACTIONS.TURN_TO || t === AI._ACTIONS.FIRE;
    }

    function usesTacticsShoot(cfg) {
        return cfg && (cfg.interceptShoot !== false || cfg.leadTarget);
    }

    function computeShotQuality(entry, cfg) {
        if (!entry) return 0;
        var q = 0.2;
        if (entry.intercept || entry.staticHit) q += 0.35;
        if (entry.ricochet) q += 0.12;
        var maxPts = cfg.coverageMaxAimPoints !== undefined ? cfg.coverageMaxAimPoints : 28;
        q += Math.min(0.28, (entry.novelThreat || 0) / maxPts);
        q += Math.min(0.12, (entry.totalThreat || 0) / maxPts * 0.5);
        q -= (entry.overlapRatio || 0) * 0.35;
        return q;
    }

    function passesVanillaFireGate(self, entry, cfg) {
        if (cfg.respectVanillaFireGate === false || !entry || typeof MathUtils === 'undefined') {
            return true;
        }
        var agg = self.currentAggressiveness;
        if (agg === null || agg === undefined) {
            agg = parseFloat(self.config[AI._TRAITS.AGGRESSIVENESS]) || 0.5;
        }
        var maxDist = MathUtils.linearInterpolation(
            Constants.AI.MIN_DISTANCE_TO_FIRE,
            Constants.AI.MAX_DISTANCE_TO_FIRE,
            agg
        );
        if (entry.staticHit || entry.intercept) return true;
        if (entry.pathLength) {
            return entry.pathLength / Constants.MAZE_TILE_SIZE.m <= maxDist;
        }
        return false;
    }

    function isShotWorthFiring(entry, cfg, self) {
        if (!entry) return false;
        if (requireRicochetShot(cfg) && !shotHasMinRicochet(entry, cfg)) return false;
        if (self && shotTooSimilarToRecent(self, entry, cfg)) return false;
        if (cfg.rejectRedundantShots === false) return true;

        var recent = self ? recentShotCount(self) : 0;
        var minNovel = cfg.minNovelThreatPoints !== undefined ? cfg.minNovelThreatPoints : 2;
        if (recent > 0) {
            minNovel = cfg.minFollowUpNovelThreat !== undefined
                ? cfg.minFollowUpNovelThreat
                : Math.max(minNovel, 4);
        }
        var maxOverlap = cfg.maxCorridorOverlapRatio !== undefined ? cfg.maxCorridorOverlapRatio : 0.75;
        var quality = computeShotQuality(entry, cfg);
        var minQuality = cfg.minShotQuality !== undefined ? cfg.minShotQuality : 0.45;
        if (quality < minQuality && recent > 0) return false;

        if ((entry.novelThreat || 0) >= minNovel &&
            (entry.overlapRatio || 0) <= maxOverlap) {
            return true;
        }
        if (recent === 0 && (entry.intercept || entry.staticHit) &&
            (entry.novelThreat || 0) >= 1 &&
            (entry.overlapRatio || 0) <= maxOverlap) {
            return true;
        }
        if ((entry.overlapRatio || 0) <= maxOverlap * 0.4 &&
            (entry.novelThreat || 0) >= Math.max(1, minNovel - 1)) {
            return true;
        }
        return false;
    }

    function getThreatAtTile(threatMap, tile) {
        if (!threatMap || !tile) return 0;
        if (typeof threatMap.get === 'function') {
            return threatMap.get(tile) || 0;
        }
        return 0;
    }

    function estimateTravelTimeSec(maze, from, to, threat) {
        if (!maze || !from || !to) return 0;
        if (from.x === to.x && from.y === to.y) return 0;
        var path = maze.getShortestPathWithGraph(from, to, threat, 0.1);
        if (!path || path.length === 0) return 999;
        var tiles = Math.max(0, path.length - 1);
        var turnSec = 0.18;
        return tiles * Constants.MAZE_TILE_SIZE.m / Constants.TANK.FORWARD_SPEED.m + turnSec;
    }

    function tileWorldCenter(tile) {
        var ts = Constants.MAZE_TILE_SIZE.m;
        return { x: (tile.x + 0.5) * ts, y: (tile.y + 0.5) * ts };
    }

    function evaluateIncomingThreatAt(self, wx, wy, arrivalTime, cfg) {
        if (!self.projectilePaths || typeof AIUtils === 'undefined') return 0;
        var projectiles = self.gameController.getProjectiles();
        var boldness = parseFloat(self.config[AI._TRAITS.BOLDNESS]) || 0.5;
        var scary = MathUtils.linearInterpolation(
            Constants.AI.MAX_SCARY_PROJECTILE_DISTANCE,
            Constants.AI.MIN_SCARY_PROJECTILE_DISTANCE,
            boldness
        );
        var worst = 0;
        var pid, path, projectile, bulletSpeed, bulletPos, dx, dy, dist, dodgeInfo, t;

        for (pid in self.projectilePaths) {
            if (!self.projectilePaths.hasOwnProperty(pid)) continue;
            path = self.projectilePaths[pid];
            projectile = projectiles[pid];
            if (!path || !projectile || !projectile.getB2DBody) continue;

            bulletSpeed = projectile.getB2DBody().GetLinearVelocity().Length();
            if (bulletSpeed <= 0) continue;

            t = Math.max(0, arrivalTime);
            bulletPos = positionOnProjectilePath(path, bulletSpeed, t);
            if (!bulletPos) continue;

            dx = wx - bulletPos.x;
            dy = wy - bulletPos.y;
            dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < scary) {
                worst = Math.max(worst, 1 - dist / scary);
            }

            dodgeInfo = AIUtils.checkProjectilePathForDodging(
                { getX: function() { return wx; }, getY: function() { return wy; } },
                path,
                projectile,
                self.gameController.getB2DWorld(),
                scary * scary
            );
            if (dodgeInfo.closestTime <= arrivalTime + 0.25 &&
                dodgeInfo.closestDistance < scary) {
                worst = Math.max(
                    worst,
                    (scary - dodgeInfo.closestDistance) / scary
                );
            }
        }
        return Math.min(1, worst);
    }

    function evaluateTileShootPotential(self, enemy, tile, travelTime, cfg) {
        var world = self.gameController.getB2DWorld();
        var target = enemy.tank;
        if (!world || !target) return 0;

        var center = tileWorldCenter(tile);
        var vel = getTargetVelocity(self, target);
        var leadScale = cfg.leadTimeScale !== undefined ? cfg.leadTimeScale : 1.15;
        var aimTime = travelTime + 0.22;
        var predX = target.getX() + vel.x * aimTime * leadScale;
        var predY = target.getY() + vel.y * aimTime * leadScale;

        if (B2DUtils.checkLineForMazeCollision(
            world, center, { x: predX, y: predY }
        )) {
            return 0.05;
        }

        var distTiles = enemy.dist;
        if (self.myPosition && tile.x === self.myPosition.x && tile.y === self.myPosition.y) {
            distTiles = enemy.dist;
        } else {
            var maze = self.gameController.getMaze();
            if (maze) {
                var d = maze.getDistanceBetweenPositions(tile, enemy.tile);
                if (d !== false) distTiles = d;
            }
        }

        var sweetMin = cfg.tacticalShootDistMin !== undefined ? cfg.tacticalShootDistMin : 4;
        var sweetMax = cfg.tacticalShootDistMax !== undefined ? cfg.tacticalShootDistMax : 14;
        var distScore = 0;
        if (distTiles >= sweetMin && distTiles <= sweetMax) {
            distScore = 1 - Math.abs(distTiles - (sweetMin + sweetMax) * 0.5) / (sweetMax - sweetMin);
        } else if (distTiles < sweetMin) {
            distScore = Math.max(0, distTiles / sweetMin * 0.35);
        } else {
            distScore = Math.max(0, 1 - (distTiles - sweetMax) / sweetMax);
        }
        return Math.max(0, Math.min(1, distScore));
    }

    function evaluateTileSafety(self, tile, travelTime, cfg) {
        var threatVal = getThreatAtTile(self.threatMap, tile);
        var center = tileWorldCenter(tile);
        var incoming = evaluateIncomingThreatAt(self, center.x, center.y, travelTime, cfg);
        var threatPenalty = Math.min(0.55, threatVal * 0.08);
        return Math.max(0, 1 - threatPenalty - incoming * 0.85);
    }

    function collectTacticalCandidateTiles(self, enemy, cfg) {
        var maze = self.gameController.getMaze();
        if (!maze || !self.myPosition || !enemy) return [self.myPosition];

        var threat = self.threatMap ? self.threatMap.data() : null;
        var seen = {};
        var key = self.myPosition.x + ',' + self.myPosition.y;
        var candidates = [self.myPosition];
        seen[key] = true;

        var path = maze.getShortestPathWithGraph(self.myPosition, enemy.tile, threat, 0.1);
        var i, tile, k;
        if (path) {
            for (i = 1; i < path.length && i <= 7; i++) {
                tile = path[i];
                k = tile.x + ',' + tile.y;
                if (!seen[k]) {
                    seen[k] = true;
                    candidates.push(tile);
                }
            }
        }

        var radius = cfg.tacticalProbeRadius !== undefined ? cfg.tacticalProbeRadius : 3;
        maze.traverseCloseTiles(self.myPosition, radius, function(current) {
            if (current.distance <= 0 || current.distance > radius) return;
            k = current.x + ',' + current.y;
            if (seen[k]) return;
            seen[k] = true;
            candidates.push({ x: current.x, y: current.y });
        });
        return candidates;
    }

    function limitShotStanceTiles(self, enemy, tiles, cfg) {
        var maxN = cfg.shotStanceMaxTiles !== undefined ? cfg.shotStanceMaxTiles : 12;
        if (!tiles || tiles.length <= maxN) return tiles || [];

        var maze = self.gameController.getMaze();
        var threat = self.threatMap ? self.threatMap.data() : null;
        var scored = [];
        var i, tile, travel;
        for (i = 0; i < tiles.length; i++) {
            tile = tiles[i];
            travel = estimateTravelTimeSec(maze, self.myPosition, tile, threat);
            scored.push({ tile: tile, travel: travel });
        }
        scored.sort(function(a, b) { return a.travel - b.travel; });
        var out = [];
        for (i = 0; i < Math.min(maxN, scored.length); i++) {
            out.push(scored[i].tile);
        }
        return out;
    }

    function isAtShotStance(self, stance, cfg) {
        if (!stance || !stance.world) return false;
        var tank = self.gameController.getTank(self.aiId);
        if (!tank) return false;
        var reach = cfg.shotStanceReachM !== undefined ? cfg.shotStanceReachM : 0.6;
        var dx = tank.getX() - stance.world.x;
        var dy = tank.getY() - stance.world.y;
        if (dx * dx + dy * dy > reach * reach) return false;
        if (stance.tile && self.myPosition) {
            return self.myPosition.x === stance.tile.x &&
                self.myPosition.y === stance.tile.y;
        }
        return true;
    }

    /**
     * 射击驱动站位：对每个候选格在站位点+朝向模拟完整弹道（含角弹），
     * 选「能打出有效弹 + 较安全 + 路程短」的站位，再驱动移动。
     */
    function planShotDrivenStance(self, enemy, cfg) {
        var maze = self.gameController.getMaze();
        if (!maze || !enemy) {
            return {
                bestStance: null,
                readyAtCurrent: false,
                needsReposition: false,
                moveTile: null
            };
        }

        var threat = self.threatMap ? self.threatMap.data() : null;
        var tiles = limitShotStanceTiles(
            self, enemy, collectTacticalCandidateTiles(self, enemy, cfg), cfg
        );
        var shootW = cfg.shotStanceShootWeight !== undefined ? cfg.shotStanceShootWeight : 0.58;
        var safeW = cfg.shotStanceSafetyWeight !== undefined ? cfg.shotStanceSafetyWeight : 0.32;
        var timeW = cfg.shotStanceTimeWeight !== undefined ? cfg.shotStanceTimeWeight : 0.24;
        var target = enemy.tank;
        var vel = getTargetVelocity(self, target);
        var leadScale = cfg.leadTimeScale !== undefined ? cfg.leadTimeScale : 1.15;
        var best = null;
        var currentEntry = null;
        var i, tile, center, travel, safety, shot, quality, composite, pose, rot;
        var aimTime, predX, predY, isCurrent;

        for (i = 0; i < tiles.length; i++) {
            tile = tiles[i];
            center = tileWorldCenter(tile);
            travel = estimateTravelTimeSec(maze, self.myPosition, tile, threat);
            safety = evaluateTileSafety(self, tile, travel, cfg);

            aimTime = travel + 0.22;
            predX = target.getX() + vel.x * aimTime * leadScale;
            predY = target.getY() + vel.y * aimTime * leadScale;
            rot = worldRotationToward(center.x, center.y, predX, predY);
            pose = { x: center.x, y: center.y, rot: rot };

            shot = findInterceptShot(self, enemy.id, cfg, pose);
            if (!shot) continue;
            quality = computeShotQuality(shot, cfg);
            if (quality < (cfg.minShotQuality !== undefined ? cfg.minShotQuality : 0.38)) continue;
            if (requireRicochetShot(cfg) && !shotHasMinRicochet(shot, cfg)) continue;

            composite = quality * shootW + safety * safeW - travel * timeW;
            isCurrent = self.myPosition &&
                tile.x === self.myPosition.x && tile.y === self.myPosition.y;

            if (isCurrent) composite += 0.1;

            var entry = {
                tile: tile,
                world: { x: center.x, y: center.y },
                pose: pose,
                shot: shot,
                quality: quality,
                safety: safety,
                travelTime: travel,
                composite: composite,
                firingAngle: shot.angle,
                direction: shot.direction,
                isCurrent: isCurrent
            };

            if (isCurrent) currentEntry = entry;
            if (!best || composite > best.composite) best = entry;
        }

        var readyAtCurrent = false;
        var liveShot = null;
        if (best && best.isCurrent && isAtShotStance(self, best, cfg)) {
            liveShot = findInterceptShot(self, enemy.id, cfg, best.pose);
            if ((!liveShot || !isShotWorthFiring(liveShot, cfg, self)) &&
                isShotWorthFiring(best.shot, cfg, self)) {
                liveShot = best.shot;
            }
            readyAtCurrent = !!liveShot &&
                isShotWorthFiring(liveShot, cfg, self) &&
                (!requireRicochetShot(cfg) || shotHasMinRicochet(liveShot, cfg));
        }

        return {
            bestStance: best,
            currentEntry: currentEntry,
            readyAtCurrent: readyAtCurrent,
            liveShot: liveShot,
            needsReposition: !!(best && !readyAtCurrent),
            moveTile: best ? best.tile : null,
            moveWorld: best ? best.world : null
        };
    }

    function shotStanceToPositionPlan(stancePlan, self) {
        var best = stancePlan && stancePlan.bestStance;
        if (!best) {
            return {
                bestTile: self.myPosition,
                bestScore: 0,
                currentIsGood: false,
                safety: 0,
                shootPotential: 0,
                travelTime: 0
            };
        }
        return {
            bestTile: best.tile,
            bestScore: best.composite,
            currentIsGood: stancePlan.readyAtCurrent,
            safety: best.safety,
            shootPotential: best.quality,
            travelTime: best.travelTime,
            shotStance: true
        };
    }

    function canFireFromShotStance(self, cfg) {
        if (!cfg || cfg.shotDrivenStance === false) return true;
        return !needsStanceReposition(self, cfg);
    }

    function applyDriveToWorld(self, wx, wy) {
        if (typeof AI === 'undefined') return false;
        self.actions = [{
            type: AI._ACTIONS.DRIVE_TO_POSITION,
            position: { x: wx, y: wy }
        }];
        return true;
    }

    function applyShotStanceMovement(self, cfg) {
        if (!cfg || cfg.shotDrivenStance === false) return false;
        if (hasActiveDodgeThreat(self, cfg)) return false;
        if (self.goal && self.goal.type === AI._GOALS.DODGE_PROJECTILE) return false;

        var sp = self._aiTacticsShotStancePlan ||
            (self._aiTacticsCognition && self._aiTacticsCognition.shotStancePlan);
        if (!sp || !sp.needsReposition || !sp.bestStance) return false;

        var enemy = findClosestEnemy(self);
        if (enemy) {
            var huntTile = sp.moveTile || sp.bestStance.tile;
            if (self.goal.type !== AI._GOALS.HUNT || !self.goal.position ||
                self.goal.position.x !== huntTile.x || self.goal.position.y !== huntTile.y) {
                forceEngageEnemy(
                    self, enemy, cfg,
                    Math.max(computeHuntPriority(enemy, cfg), 0.56),
                    getHuntPeriod(self, enemy, cfg)
                );
            }
        }

        var stance = sp.bestStance;
        if (isAtShotStance(self, stance, cfg)) return false;

        if (!self.myPosition ||
            self.myPosition.x !== stance.tile.x ||
            self.myPosition.y !== stance.tile.y) {
            return applyHuntActionsToward(self, stance.tile);
        }
        return applyDriveToWorld(self, stance.world.x, stance.world.y);
    }

    function evaluateTacticalPositions(self, enemy, cfg) {
        if (cfg.shotDrivenStance !== false) {
            var stancePlan = planShotDrivenStance(self, enemy, cfg);
            self._aiTacticsShotStancePlan = stancePlan;
            return shotStanceToPositionPlan(stancePlan, self);
        }

        var maze = self.gameController.getMaze();
        if (!maze || !enemy) {
            return { bestTile: self.myPosition, currentIsGood: false, score: 0 };
        }

        var threat = self.threatMap ? self.threatMap.data() : null;
        var candidates = collectTacticalCandidateTiles(self, enemy, cfg);
        var shootW = cfg.tacticalShootWeight !== undefined ? cfg.tacticalShootWeight : 0.52;
        var safeW = cfg.tacticalSafetyWeight !== undefined ? cfg.tacticalSafetyWeight : 0.38;
        var timeW = cfg.tacticalTimeWeight !== undefined ? cfg.tacticalTimeWeight : 0.22;
        var best = null;
        var i, tile, travel, shootPot, safety, composite, isCurrent;

        for (i = 0; i < candidates.length; i++) {
            tile = candidates[i];
            travel = estimateTravelTimeSec(maze, self.myPosition, tile, threat);
            shootPot = evaluateTileShootPotential(self, enemy, tile, travel, cfg);
            safety = evaluateTileSafety(self, tile, travel, cfg);
            composite = shootPot * shootW + safety * safeW - travel * timeW;
            isCurrent = self.myPosition &&
                tile.x === self.myPosition.x && tile.y === self.myPosition.y;

            if (isCurrent) composite += 0.08;

            if (!best || composite > best.composite) {
                best = {
                    tile: tile,
                    composite: composite,
                    shootPotential: shootPot,
                    safety: safety,
                    travelTime: travel,
                    isCurrent: isCurrent
                };
            }
        }

        var minSafety = cfg.minPositionSafety !== undefined ? cfg.minPositionSafety : 0.38;
        var minShoot = cfg.minPositionShootPotential !== undefined ? cfg.minPositionShootPotential : 0.28;
        var currentGood = best && best.isCurrent &&
            best.safety >= minSafety && best.shootPotential >= minShoot;

        return {
            bestTile: best ? best.tile : self.myPosition,
            bestScore: best ? best.composite : 0,
            currentIsGood: currentGood,
            safety: best ? best.safety : 0,
            shootPotential: best ? best.shootPotential : 0,
            travelTime: best ? best.travelTime : 0
        };
    }

    function computeDodgeUrgency(self, cfg) {
        if (!cfg.smartDodge || typeof AIUtils === 'undefined' || typeof MathUtils === 'undefined') {
            return 0;
        }
        if (AIUtils.checkProtected(self.aiId, self.gameController)) return 0;

        var tank = self.gameController.getTank(self.aiId);
        if (!tank || !self.projectilePaths) return 0;

        var projectiles = self.gameController.getProjectiles();
        var boldness = parseFloat(self.config[AI._TRAITS.BOLDNESS]) || 0.5;
        var scary = MathUtils.linearInterpolation(
            Constants.AI.MAX_SCARY_PROJECTILE_DISTANCE,
            Constants.AI.MIN_SCARY_PROJECTILE_DISTANCE,
            boldness
        );
        var urgentTime = cfg.dodgeUrgentTime !== undefined ? cfg.dodgeUrgentTime : 1.6;
        var urgentDist = cfg.dodgeUrgentDistance !== undefined ? cfg.dodgeUrgentDistance : 12;
        var worst = 0;
        var pid, dodgeInfo;

        for (pid in self.projectilePaths) {
            if (!self.projectilePaths.hasOwnProperty(pid) || !projectiles[pid]) continue;
            dodgeInfo = AIUtils.checkProjectilePathForDodging(
                tank,
                self.projectilePaths[pid],
                projectiles[pid],
                self.gameController.getB2DWorld(),
                scary * scary
            );
            if (dodgeInfo.closestTime < urgentTime && dodgeInfo.closestDistance < urgentDist) {
                worst = Math.max(
                    worst,
                    ((urgentDist - dodgeInfo.closestDistance) / urgentDist +
                        (1 - dodgeInfo.closestTime / urgentTime) * 0.5) * 0.5
                );
            }
        }
        return Math.min(1, worst);
    }

    function computeShootPlan(self, enemy, cfg) {
        if (!enemy) return { worthShooting: false, quality: 0 };
        if (self._aiTacticsPostShotLock > 0) {
            return { worthShooting: false, quality: 0, blocked: 'postShot' };
        }

        var shot = findInterceptShot(self, enemy.id, cfg);
        if (!shot) return { worthShooting: false, quality: 0 };

        var quality = computeShotQuality(shot, cfg);
        var worth = isShotWorthFiring(shot, cfg, self) &&
            quality >= (cfg.minShotQuality !== undefined ? cfg.minShotQuality : 0.45) &&
            passesVanillaFireGate(self, shot, cfg);

        if (worth) {
            updateShootPreviewCache(self, shot, enemy.id);
        }

        return { worthShooting: worth, shot: shot, quality: quality };
    }

    function runParallelCognition(self, cfg) {
        if (cfg.parallelCognition === false) return null;

        clearPlannedShotIfStale(self);

        var enemy = findClosestEnemy(self);
        if (!enemy) {
            self._aiTacticsCognition = null;
            self._aiTacticsShotStancePlan = null;
            return null;
        }

        var dodgeUrgency = computeDodgeUrgency(self, cfg);
        var shotDriven = cfg.shotDrivenStance !== false;
        var positionPlan = evaluateTacticalPositions(self, enemy, cfg);
        var shotStancePlan = shotDriven ? self._aiTacticsShotStancePlan : null;
        var shootPlan;

        if (shotDriven && shotStancePlan) {
            if (shotStancePlan.readyAtCurrent && shotStancePlan.liveShot) {
                var liveQ = computeShotQuality(shotStancePlan.liveShot, cfg);
                var liveWorth = isShotWorthFiring(shotStancePlan.liveShot, cfg, self) &&
                    liveQ >= (cfg.minShotQuality !== undefined ? cfg.minShotQuality : 0.38) &&
                    passesVanillaFireGate(self, shotStancePlan.liveShot, cfg);
                shootPlan = {
                    worthShooting: liveWorth,
                    shot: shotStancePlan.liveShot,
                    quality: liveQ,
                    blocked: liveWorth ? null : 'stance_shot_invalid'
                };
                if (liveWorth) {
                    updateShootPreviewCache(self, shotStancePlan.liveShot, enemy.id);
                }
            } else if (shotStancePlan.bestStance && shotStancePlan.bestStance.shot) {
                shootPlan = {
                    worthShooting: false,
                    shot: shotStancePlan.bestStance.shot,
                    previewShot: shotStancePlan.bestStance.shot,
                    quality: shotStancePlan.bestStance.quality,
                    blocked: 'need_stance',
                    allowed: false
                };
            } else {
                shootPlan = { worthShooting: false, quality: 0, blocked: 'no_plan' };
            }
        } else {
            shootPlan = computeShootPlan(self, enemy, cfg);
        }

        var maxShootDodge = cfg.maxShootDodgeUrgency !== undefined ? cfg.maxShootDodgeUrgency : 0.48;

        shootPlan.allowed = shootPlan.worthShooting && dodgeUrgency <= maxShootDodge &&
            canFireFromShotStance(self, cfg);
        shootPlan.preferReposition = shotStancePlan && shotStancePlan.needsReposition;

        var agg = self.currentAggressiveness;
        if (cfg.respectAggressiveness !== false &&
            agg !== null && agg !== undefined &&
            agg < (cfg.minAggressivenessToShoot !== undefined ? cfg.minAggressivenessToShoot : 0.12)) {
            shootPlan.allowed = false;
            shootPlan.blocked = 'aggressiveness';
        }

        self._aiTacticsCognition = {
            enemy: enemy,
            dodgeUrgency: dodgeUrgency,
            positionPlan: positionPlan,
            shotStancePlan: shotStancePlan,
            shootPlan: shootPlan
        };
        return self._aiTacticsCognition;
    }

    function canExecuteShootPlan(self, cfg) {
        if (self._aiTacticsPostShotLock > 0) return false;
        if (shouldBlockShootForDodge(self, cfg)) return false;
        var cog = self._aiTacticsCognition;
        if (!cog || !cog.shootPlan) return true;
        return !!cog.shootPlan.worthShooting;
    }

    function onShotCompleted(self, cfg) {
        self._aiTacticsPostShotLock = cfg.postShotRepositionMs !== undefined
            ? cfg.postShotRepositionMs
            : 520;
        clearPlannedShot(self);
        self._aiTacticsShootPreview = null;
        if (self.goal && self.goal.type === AI._GOALS.SHOOT_AFTER) {
            self.goal.period = cfg.shootGoalPeriodMin !== undefined
                ? cfg.shootGoalPeriodMin
                : 420;
        }
        if (self.currentAggressiveness !== null && self.currentAggressiveness !== undefined) {
            self.currentAggressiveness = Math.max(
                0,
                self.currentAggressiveness - Constants.AI.AGGRESSIVENESS_SHOOT_AFTER_SHRINKAGE
            );
        }
    }

    function pickLateralRepositionTile(self, enemy, cfg) {
        var maze = self.gameController.getMaze();
        var tank = self.gameController.getTank(self.aiId);
        if (!maze || !tank || !self.myPosition || !enemy) return null;

        var threat = self.threatMap ? self.threatMap.data() : null;
        var tx = enemy.tank.getX() - tank.getX();
        var ty = enemy.tank.getY() - tank.getY();
        var len = Math.sqrt(tx * tx + ty * ty) || 1;
        var px = -ty / len;
        var py = tx / len;
        var offsets = [
            { x: Math.round(px), y: Math.round(py) },
            { x: -Math.round(px), y: -Math.round(py) },
            { x: Math.round(-tx / len), y: Math.round(-ty / len) },
            { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }
        ];
        var ts = Constants.MAZE_TILE_SIZE.m;
        var world = self.gameController.getB2DWorld();
        var best = null;
        var i, ox, oy, nt, path, threatVal, wx, wy, score;

        for (i = 0; i < offsets.length; i++) {
            ox = self.myPosition.x + offsets[i].x;
            oy = self.myPosition.y + offsets[i].y;
            nt = { x: ox, y: oy };
            path = maze.getShortestPathWithGraph(self.myPosition, nt, threat, 0.1);
            if (!path || path.length === 0 || path.length > 4) continue;

            threatVal = getThreatAtTile(self.threatMap, nt);
            wx = (ox + 0.5) * ts;
            wy = (oy + 0.5) * ts;
            if (B2DUtils.checkLineForMazeCollision(
                world, { x: tank.getX(), y: tank.getY() }, { x: wx, y: wy }
            )) {
                continue;
            }

            score = 1 - threatVal * 0.08;
            if (offsets[i].x * tx + offsets[i].y * ty < 0) score += 0.25;
            if (evaluateIncomingThreatAt(self, wx, wy, 0.35, cfg) > 0.55) score -= 0.35;

            if (!best || score > best.score) {
                best = { tile: nt, score: score };
            }
        }
        return best ? best.tile : null;
    }

    function applyPostShotReposition(self, cfg) {
        if (self._aiTacticsPostShotLock <= 0) return false;
        if (self.goal && self.goal.type === AI._GOALS.DODGE_PROJECTILE) return false;
        if (hasActiveDodgeThreat(self, cfg)) return false;

        var enemy = findClosestEnemy(self);
        if (!enemy) return false;

        var cog = self._aiTacticsCognition;
        var tile = cog && cog.positionPlan ? cog.positionPlan.bestTile : null;
        if (!tile || (self.myPosition &&
            tile.x === self.myPosition.x && tile.y === self.myPosition.y)) {
            tile = pickLateralRepositionTile(self, enemy, cfg);
        }
        if (!tile) return false;

        if (self.goal.type !== AI._GOALS.HUNT &&
            self.goal.type !== AI._GOALS.DODGE_PROJECTILE) {
            forceEngageEnemy(
                self, enemy, cfg,
                Math.max(computeHuntPriority(enemy, cfg), 0.58),
                cfg.postShotHuntPeriod !== undefined ? cfg.postShotHuntPeriod : 180
            );
        }
        return applyHuntActionsToward(self, tile);
    }

    function finalizeShotScore(self, entry, aimPoints, cfg, target) {
        var recent = self._aiTacticsRecentShots || [];
        var threat = analyzeThreatCoverage(entry.pathInfo, aimPoints, recent, cfg);
        var totalWeight = cfg.totalThreatWeight !== undefined ? cfg.totalThreatWeight : 0.28;
        var novelWeight = cfg.novelThreatWeight !== undefined ? cfg.novelThreatWeight : 0.62;
        var overlapPenalty = cfg.corridorOverlapPenalty !== undefined ? cfg.corridorOverlapPenalty : 7.5;

        entry.totalThreat = threat.totalThreat;
        entry.novelThreat = threat.novelThreat;
        entry.overlapRatio = threat.overlapRatio;
        entry.coverage = threat.totalThreat;

        entry.finalScore = entry.score -
            threat.totalThreat * totalWeight -
            threat.novelThreat * novelWeight +
            threat.overlapRatio * overlapPenalty;

        entry.finalScore -= scoreWallGrazingBonus(entry.pathInfo, cfg);

        if (entry.ricochet) {
            var ricBonus = cfg.ricochetScoreBonus !== undefined ? cfg.ricochetScoreBonus : 1.8;
            entry.finalScore -= ricBonus * (1 + (entry.bounceCount || 0) * 0.25);
        }

        if (target && (entry.bounceCount || 0) > 0) {
            entry.finalScore -= scoreFirstBounceProximityBonus(entry.pathInfo, target, cfg);
        }
        entry.finalScore -= scoreEarlyCornerRicochetBonus(entry.pathInfo, cfg);

        return entry.finalScore;
    }

    function pickBestShotCandidate(self, best, bestRicochet, cfg) {
        var chosen;

        if (requireRicochetShot(cfg)) {
            if (!bestRicochet || !shotHasMinRicochet(bestRicochet, cfg)) return null;
            chosen = bestRicochet;
        } else {
            chosen = best;
            var minBounces = getRicochetMinBounces(cfg);
            if (cfg.preferRicochet !== false && bestRicochet && bestRicochet.ricochet &&
                (bestRicochet.bounceCount || 0) >= minBounces) {
                var slack = cfg.ricochetPreferScoreSlack !== undefined ? cfg.ricochetPreferScoreSlack : 2.2;
                if (!best || !best.ricochet) {
                    chosen = bestRicochet;
                } else if (bestRicochet.finalScore <= best.finalScore + slack) {
                    chosen = bestRicochet;
                }
            }
        }

        if (!chosen) return null;
        if (cfg.diversifyShots === false) return chosen;

        var alt = requireRicochetShot(cfg) ? null : (chosen.ricochet ? best : bestRicochet);
        if (!alt || alt === chosen) return chosen;
        if (requireRicochetShot(cfg) && !shotHasMinRicochet(alt, cfg)) return chosen;

        var novelGap = cfg.diversifyNovelThreatGap !== undefined ? cfg.diversifyNovelThreatGap : 2;
        if ((chosen.novelThreat || 0) <= (cfg.minNovelThreatPoints || 1) &&
            (alt.novelThreat || 0) >= (chosen.novelThreat || 0) + novelGap &&
            alt.finalScore <= chosen.finalScore + (cfg.diversifyScoreGap || 1.4)) {
            return alt;
        }
        if ((chosen.overlapRatio || 0) > (cfg.maxCorridorOverlapRatio || 0.78) * 0.9 &&
            (alt.overlapRatio || 1) + 0.12 < (chosen.overlapRatio || 0) &&
            alt.finalScore <= chosen.finalScore + (cfg.diversifyScoreGap || 1.4)) {
            return alt;
        }
        return chosen;
    }

    function evaluateCornerThreat(pathInfo, cfg, target, vel, bulletSpeed, hitRadiusSq, targetId) {
        if (cfg.cornerRicochet === false || !pathInfo || !target) {
            return { threatens: false, score: 0, ricochet: false };
        }

        var leadScale = cfg.leadTimeScale !== undefined ? cfg.leadTimeScale : 1.15;
        var threat = pathThreatensTarget(
            pathInfo, target, targetId, vel, bulletSpeed, hitRadiusSq, leadScale
        );
        if (!threat) {
            return { threatens: false, score: 0, ricochet: false };
        }

        var ricochet = pathHasRicochet(pathInfo, cfg);
        if (!ricochet) {
            return { threatens: true, score: threat.score, ricochet: false, directFirst: true };
        }

        var cornerAnalysis = analyzePathCornerRicochets(pathInfo, cfg);
        var bounceCount = getPathBounceCount(pathInfo);
        var score = 1 / (1 + threat.score * 0.45);
        score *= 1 + bounceCount * (cfg.ricochetPerBounceBonus !== undefined ? cfg.ricochetPerBounceBonus : 0.45);
        if (cornerAnalysis.hasCorner) {
            score *= 1 + (cfg.cornerSegmentBonus !== undefined ? cfg.cornerSegmentBonus : 0.35);
        }
        return { threatens: true, score: score, ricochet: true, bounceCount: bounceCount };
    }

    function scoreCornerRicochet(pathInfo, cfg, target, vel, bulletSpeed, hitRadiusSq, targetId) {
        if (cfg.cornerRicochet === false || !pathInfo || !target) return 0;
        var threat = evaluateCornerThreat(
            pathInfo, cfg, target, vel, bulletSpeed, hitRadiusSq, targetId
        );
        if (!threat.threatens || !threat.ricochet) return 0;

        var bonusScale = cfg.cornerRicochetBonus !== undefined ? cfg.cornerRicochetBonus : 2.8;
        var willingness = cfg.cornerRicochetWillingness !== undefined ? cfg.cornerRicochetWillingness : 0.94;
        return threat.score * bonusScale * willingness;
    }

    function pathHasUsefulCornerRicochet(pathInfo, cfg, target, vel, bulletSpeed, hitRadiusSq, targetId) {
        return evaluateCornerThreat(
            pathInfo, cfg, target, vel, bulletSpeed, hitRadiusSq, targetId
        ).ricochet;
    }

    function segmentAngleWithWallDeg(dx, dy) {
        var adx = Math.abs(dx);
        var ady = Math.abs(dy);
        if (adx < 1e-9 && ady < 1e-9) return 0;
        return Math.atan2(Math.min(adx, ady), Math.max(adx, ady)) * 180 / Math.PI;
    }

    /** 弹道段与轴对齐墙的夹角 ∈ (75°,89°) 时加分（近乎垂直入射，利于角弹） */
    function scoreWallGrazingBonus(pathInfo, cfg) {
        if (!pathInfo || !pathInfo.path || pathInfo.path.length < 2) return 0;
        var minA = cfg.wallGrazingAngleMinDeg !== undefined ? cfg.wallGrazingAngleMinDeg : 75;
        var maxA = cfg.wallGrazingAngleMaxDeg !== undefined ? cfg.wallGrazingAngleMaxDeg : 89;
        var segBonus = cfg.wallGrazingAngleBonus !== undefined ? cfg.wallGrazingAngleBonus : 1.35;
        var path = pathInfo.path;
        var total = 0;
        var i, dx, dy, deg;
        for (i = 0; i < path.length - 1; i++) {
            dx = path[i + 1].x - path[i].x;
            dy = path[i + 1].y - path[i].y;
            deg = segmentAngleWithWallDeg(dx, dy);
            if (deg > minA && deg < maxA) total += segBonus;
        }
        return total;
    }

    function applyCornerBiasToShotScore(baseScore, pathInfo, cfg, target, vel, bulletSpeed, hitRadiusSq, targetId) {
        var threat = evaluateCornerThreat(
            pathInfo, cfg, target, vel, bulletSpeed, hitRadiusSq, targetId
        );
        if (threat.ricochet) {
            return baseScore - scoreCornerRicochet(
                pathInfo, cfg, target, vel, bulletSpeed, hitRadiusSq, targetId
            ) - scoreWallGrazingBonus(pathInfo, cfg);
        }
        if (cfg.penalizeDirectShot !== false && threat.directFirst) {
            var directPenalty = cfg.directShotPenalty !== undefined ? cfg.directShotPenalty : 0.55;
            return baseScore + directPenalty;
        }
        return baseScore;
    }

    function isSuicidePath(pathInfo) {
        if (!pathInfo) return true;
        return pathInfo.firstSegmentLength < Constants.AI.MIN_FIRST_SEGMENT_TO_FIRE &&
            pathInfo.length > pathInfo.firstSegmentLength;
    }

    /**
     * Flash 4399：前方约 230° 内多 ray 扫描 + 多段反弹；优先选最短到达时间的拦截弹。
     * collectAll=true 时返回去重后的全部可行方案（按 finalScore 升序）。
     */
    function scanInterceptShots(self, targetId, cfg, pose, collectAll) {
        if (cfg.interceptShoot === false) return collectAll ? [] : null;

        var tank = getTankForFiring(self, pose);
        var target = self.gameController.getTank(targetId);
        if (!tank || !target || typeof AIUtils === 'undefined' || typeof MathUtils === 'undefined') {
            return collectAll ? [] : null;
        }
        if (AIUtils.checkProtected(targetId, self.gameController)) return collectAll ? [] : null;

        var weapon = self.gameController.getActiveWeapon(self.aiId);
        if (weapon && weapon.getType && weapon.getType() !== Constants.WEAPON_TYPES.BULLET) {
            return collectAll ? [] : null;
        }

        var scan = getFiringScanParams(self);
        var bounces = cfg.interceptBounces !== undefined
            ? cfg.interceptBounces
            : scan.bounces;
        var maxLength = scan.maxLength;
        var bulletSpeed = Constants.BULLET.SPEED.m;
        var vel = getTargetVelocity(self, target);
        var leadScale = cfg.leadTimeScale !== undefined ? cfg.leadTimeScale : 1.15;
        var hitRadiusSq = getInterceptHitRadiusSq(cfg);
        var numPaths = cfg.interceptScanPaths !== undefined ? cfg.interceptScanPaths : 31;
        var spread = cfg.interceptSpreadRad !== undefined
            ? cfg.interceptSpreadRad
            : (250 * Math.PI / 180);
        numPaths += (numPaths + 1) % 2;

        var aimPoints = collectCoverageAimPoints(self, target, cfg);
        var lead = predictLeadPoint(tank, target, self, cfg);
        var aimX = lead ? lead.x : target.getX();
        var aimY = lead ? lead.y : target.getY();
        var centerAngle = bearingToTarget(tank, aimX, aimY);
        var minAngle = centerAngle - spread * 0.5;
        var angleStep = numPaths > 1 ? spread / (numPaths - 1) : 0;
        var randomOffset = Constants.AI.FIRING_PATH_RANDOM_OFFSET * 0.08;
        var scanAngles = [];
        var angleSeen = {};
        var extraAngles = [];
        var i, angle, angleKey, pathInfo, intercept, staticHit, entry, interceptScore, staticScore;
        var best = null;
        var bestRicochet = null;
        var byAngle = {};

        if (cfg.cornerRicochet !== false) {
            extraAngles = extraAngles.concat(collectCornerAimAngles(tank, target, cfg));
        }
        if (cfg.coverageShoot !== false) {
            extraAngles = extraAngles.concat(collectCoverageAimAngles(self, tank, target, cfg));
        }

        for (i = 0; i < numPaths; i++) {
            angle = minAngle + i * angleStep +
                (randomOffset ? MathUtils.randomAroundZero(randomOffset) : 0);
            angleKey = Math.round(angle * 32);
            if (!angleSeen[angleKey]) {
                angleSeen[angleKey] = true;
                scanAngles.push(angle);
            }
        }
        for (i = 0; i < extraAngles.length; i++) {
            angle = extraAngles[i];
            angleKey = Math.round(angle * 32);
            if (!angleSeen[angleKey]) {
                angleSeen[angleKey] = true;
                scanAngles.push(angle);
            }
        }

        function considerEntry(rawScore, pathInfoLocal, angleLocal, isStatic, hasIntercept) {
            var bounceCount = getPathBounceCount(pathInfoLocal);
            var ricochet = pathHasUsefulCornerRicochet(
                pathInfoLocal, cfg, target, vel, bulletSpeed, hitRadiusSq, targetId
            );
            if (requireRicochetShot(cfg)) {
                if (!ricochet || bounceCount < getRicochetMinBounces(cfg)) return;
            }
            entry = {
                direction: pathInfoLocal.direction,
                angle: angleLocal,
                score: rawScore,
                time: isStatic ? pathInfoLocal.length / bulletSpeed : rawScore,
                pathLength: pathInfoLocal.length,
                intercept: hasIntercept,
                staticHit: isStatic,
                ricochet: ricochet,
                bounceCount: bounceCount,
                pathInfo: pathInfoLocal
            };
            finalizeShotScore(self, entry, aimPoints, cfg, target);

            if (collectAll) {
                angleKey = Math.round(angleLocal * 32);
                if (!byAngle[angleKey] || entry.finalScore < byAngle[angleKey].finalScore) {
                    byAngle[angleKey] = entry;
                }
                return;
            }

            if (requireRicochetShot(cfg)) {
                if (!bestRicochet || entry.finalScore < bestRicochet.finalScore) {
                    bestRicochet = entry;
                }
                return;
            }

            if (!best || entry.finalScore < best.finalScore) {
                best = entry;
            }
            if (ricochet && (!bestRicochet || entry.finalScore < bestRicochet.finalScore)) {
                bestRicochet = entry;
            }
        }

        for (i = 0; i < scanAngles.length; i++) {
            angle = scanAngles[i];
            pathInfo = simulateFiringPath(self, angle, bounces, maxLength, pose);
            if (!pathInfo || isSuicidePath(pathInfo)) continue;

            staticHit = pathInfo.hit && pathInfo.hit.getPlayerId &&
                String(pathInfo.hit.getPlayerId()) === String(targetId);

            if (staticHit) {
                staticScore = pathInfo.length / bulletSpeed;
                if (vel.speed > 0.05) {
                    intercept = checkPathTimeIntercept(
                        pathInfo, target, vel, bulletSpeed, hitRadiusSq, leadScale
                    );
                    if (!intercept) continue;
                    staticScore = intercept.score;
                }
                staticScore = applyCornerBiasToShotScore(
                    staticScore, pathInfo, cfg, target, vel, bulletSpeed, hitRadiusSq, targetId
                );
                considerEntry(staticScore, pathInfo, angle, true, vel.speed > 0.05);
                continue;
            }

            intercept = checkPathTimeIntercept(
                pathInfo, target, vel, bulletSpeed, hitRadiusSq, leadScale
            );
            if (!intercept) continue;

            interceptScore = applyCornerBiasToShotScore(
                intercept.score, pathInfo, cfg, target, vel, bulletSpeed, hitRadiusSq, targetId
            );
            considerEntry(interceptScore, pathInfo, angle, false, true);
        }

        if (collectAll) {
            var keys = Object.keys(byAngle);
            var all = [];
            for (i = 0; i < keys.length; i++) {
                all.push(byAngle[keys[i]]);
            }
            all.sort(function(a, b) { return a.finalScore - b.finalScore; });
            return all;
        }
        return pickBestShotCandidate(self, best, bestRicochet, cfg);
    }

    function findInterceptShot(self, targetId, cfg, pose) {
        return scanInterceptShots(self, targetId, cfg, pose, false);
    }

    function enumerateInterceptShots(self, targetId, cfg, pose) {
        return scanInterceptShots(self, targetId, cfg, pose, true) || [];
    }

    function predictLeadPoint(shooter, target, self, cfg) {
        var bulletSpeed = Constants.BULLET.SPEED.m;
        var weapon = self.gameController.getActiveWeapon(self.aiId);
        if (weapon && weapon.getType && weapon.getType() !== Constants.WEAPON_TYPES.BULLET) {
            return null;
        }

        var vel = getTargetVelocity(self, target);
        if (vel.speed < (cfg.leadMinTargetSpeed !== undefined ? cfg.leadMinTargetSpeed : 0.15)) {
            return null;
        }

        var sx = shooter.getX();
        var sy = shooter.getY();
        var tx = target.getX();
        var ty = target.getY();
        var scale = cfg.leadTimeScale !== undefined ? cfg.leadTimeScale : 1.05;
        var iters = cfg.leadIterations !== undefined ? cfg.leadIterations : 5;
        var px = tx;
        var py = ty;
        var t = 0;
        var i;

        for (i = 0; i < iters; i++) {
            var dx = px - sx;
            var dy = py - sy;
            var dist = Math.sqrt(dx * dx + dy * dy);
            t = (dist / bulletSpeed) * scale;
            px = tx + vel.x * t;
            py = ty + vel.y * t;
        }

        return { x: px, y: py, time: t, vx: vel.x, vy: vel.y };
    }

    function dexterityImprecision(self) {
        if (typeof MathUtils === 'undefined') return 0;
        return MathUtils.randomAroundZero(MathUtils.linearInterpolation(
            Constants.AI.MAX_ROTATION_IMPRECISION,
            0,
            parseFloat(self.config[AI._TRAITS.DEXTERITY]) || 0.5
        ));
    }

    function hasConfirmedHit(self, targetId, scanPaths) {
        var tank = self.gameController.getTank(self.aiId);
        if (!tank || typeof AIUtils === 'undefined' || typeof MathUtils === 'undefined') {
            return false;
        }
        var tanks = self.gameController.getTanks();
        var clever = parseFloat(self.config[AI._TRAITS.CLEVERNESS]) || 0.5;
        var bounces = Math.ceil(MathUtils.linearInterpolation(
            Constants.AI.MIN_FIRING_PATH_BOUNCES,
            Constants.AI.MAX_FIRING_PATH_BOUNCES,
            clever
        ));
        var pathLen = MathUtils.linearInterpolation(
            Constants.AI.MIN_FIRING_PATH_LENGTH,
            Constants.AI.MAX_FIRING_PATH_LENGTH,
            clever
        );
        var numPaths = Math.max(
            scanPaths || 5,
            Math.ceil(MathUtils.linearInterpolation(
                Constants.AI.MIN_NUM_FIRING_PATHS,
                Constants.AI.MAX_NUM_FIRING_PATHS,
                clever
            ))
        );
        numPaths += (numPaths + 1) % 2;
        var spread = MathUtils.linearInterpolation(
            Constants.AI.MIN_FIRING_PATH_SPREAD,
            Constants.AI.MAX_FIRING_PATH_SPREAD,
            parseFloat(self.config[AI._TRAITS.AGGRESSIVENESS]) || 0.5
        );
        var minAngle = -spread * 0.5;
        var angleStep = numPaths > 1 ? spread / (numPaths - 1) : 0;
        var i, angle, info, hitId;

        for (i = 0; i < numPaths; i++) {
            angle = minAngle + i * angleStep;
            info = AIUtils.checkFiringPath(
                tank, tanks, self.gameController, angle, bounces,
                Constants.MAZE_TILE_SIZE.m * pathLen, self.goal.weaponType
            );
            if (info.result === AIUtils._FIRING_RESULTS.HIT) {
                hitId = info.target && typeof info.target.getPlayerId === 'function'
                    ? info.target.getPlayerId() : info.target;
                if (String(hitId) === String(targetId)) {
                    return true;
                }
            }
        }
        return false;
    }

    function findLeadShot(self, targetId, cfg) {
        var tank = self.gameController.getTank(self.aiId);
        var target = self.gameController.getTank(targetId);
        if (!tank || !target || typeof AIUtils === 'undefined' || typeof MathUtils === 'undefined') {
            return null;
        }

        var lead = predictLeadPoint(tank, target, self, cfg);
        if (!lead) return null;

        var world = self.gameController.getB2DWorld();
        var sx = tank.getX();
        var sy = tank.getY();
        if (B2DUtils.checkLineForMazeCollision(world, { x: sx, y: sy }, { x: lead.x, y: lead.y })) {
            return null;
        }

        var tanks = self.gameController.getTanks();
        var clever = parseFloat(self.config[AI._TRAITS.CLEVERNESS]) || 0.5;
        var bounces = Math.ceil(MathUtils.linearInterpolation(
            Constants.AI.MIN_FIRING_PATH_BOUNCES,
            Constants.AI.MAX_FIRING_PATH_BOUNCES,
            clever
        ));
        var pathLen = MathUtils.linearInterpolation(
            Constants.AI.MIN_FIRING_PATH_LENGTH,
            Constants.AI.MAX_FIRING_PATH_LENGTH,
            clever
        );
        var baseAngle = Math.atan2(lead.x - sx, -(lead.y - sy)) - tank.getRotation();
        var scan = cfg.leadAngleScan || 5;
        var step = cfg.leadAngleStep || 0.12;
        var i, angle, info, hitId;

        for (i = -scan; i <= scan; i++) {
            angle = baseAngle + i * step;
            info = AIUtils.checkFiringPath(
                tank, tanks, self.gameController, angle, bounces,
                Constants.MAZE_TILE_SIZE.m * pathLen, self.goal.weaponType
            );
            if (info.result === AIUtils._FIRING_RESULTS.HIT) {
                hitId = info.target && typeof info.target.getPlayerId === 'function'
                    ? info.target.getPlayerId() : info.target;
                if (String(hitId) === String(targetId)) {
                    return { direction: info.direction, lead: lead, bounced: true };
                }
            }
        }

        var dx = lead.x - sx;
        var dy = lead.y - sy;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.01) return null;

        return {
            direction: { x: dx / len, y: dy / len },
            lead: lead,
            bounced: false
        };
    }

    function fireActionDuration(self) {
        var activeWeapon = self.gameController.getActiveWeapon(self.aiId);
        if (activeWeapon && activeWeapon.getType &&
            activeWeapon.getType() === Constants.WEAPON_TYPES.GATLING_GUN) {
            return (Constants.GATLING_GUN_CHARGE_TIME +
                Constants.GATLING_GUN_FIRE_RATE * activeWeapon.getField('numBullets')) * 1000;
        }
        return 1;
    }

    function fireDelayForShot(self, cfg, isIntercept) {
        var dex = parseFloat(self.config[AI._TRAITS.DEXTERITY]) || 0.5;
        if (isIntercept && cfg.interceptMaxFireDelay !== undefined) {
            return MathUtils.linearInterpolation(cfg.interceptMaxFireDelay, 0, dex);
        }
        return MathUtils.linearInterpolation(Constants.AI.MAX_FIRE_DELAY, 0, dex);
    }

    function applyInterceptAiming(self, cfg) {
        if (self.goal.type !== AI._GOALS.SHOOT_AFTER) return;
        if (self._aiTacticsPostShotLock > 0) return;
        if (shouldBlockShootForDodge(self, cfg)) return;
        if (!canFireFromShotStance(self, cfg)) return;

        var requirePlan = cfg.requirePlannedShotBeforeFire !== false;
        var shot = null;
        var cog = self._aiTacticsCognition;

        if (isAimingOrFiring(self) && self._aiTacticsPlannedShot) {
            shot = plannedShotToExecutable(self._aiTacticsPlannedShot);
        } else if (self._aiTacticsPlannedShot &&
            String(self._aiTacticsPlannedShot.targetId) === String(self.goal.target)) {
            shot = plannedShotToExecutable(self._aiTacticsPlannedShot);
        } else {
            if (cog && cog.shootPlan && cog.shootPlan.shot && cog.shootPlan.worthShooting) {
                shot = cog.shootPlan.shot;
            } else if (cfg.shotDrivenStance === false && cfg.interceptShoot !== false) {
                shot = findInterceptShot(self, self.goal.target, cfg);
            }
            if (!shot && cfg.leadTarget && !requireRicochetShot(cfg) && cfg.shotDrivenStance === false) {
                var leadShot = findLeadShot(self, self.goal.target, cfg);
                if (leadShot) {
                    shot = {
                        direction: leadShot.direction,
                        intercept: !leadShot.bounced,
                        staticHit: !leadShot.bounced,
                        ricochet: leadShot.bounced,
                        bounceCount: leadShot.bounced ? 1 : 0
                    };
                }
            }
            if (!shot || !isShotWorthFiring(shot, cfg, self)) return;
            if (!passesVanillaFireGate(self, shot, cfg)) return;
            var commitPose = null;
            if (cfg.shotDrivenStance !== false && cog && cog.shotStancePlan &&
                cog.shotStancePlan.bestStance) {
                commitPose = cog.shotStancePlan.bestStance.pose;
            }
            if (!commitPlannedShot(self, shot, self.goal.target, cfg, commitPose)) return;
            shot = plannedShotToExecutable(self._aiTacticsPlannedShot);
        }

        if (!shot || (requirePlan && !self._aiTacticsPlannedShot)) return;
        if (isAimingOrFiring(self) && self._aiTacticsPendingShot) return;

        var imprec = dexterityImprecision(self) * (cfg.aimImprecisionScale !== undefined
            ? cfg.aimImprecisionScale : 0.35);
        var isIntercept = !!(shot.intercept || shot.staticHit);
        self.actions = [
            { type: AI._ACTIONS.TURN_TO, direction: shot.direction, imprecision: imprec },
            {
                type: AI._ACTIONS.FIRE,
                duration: fireActionDuration(self),
                delay: fireDelayForShot(self, cfg, isIntercept)
            }
        ];
        self._aiTacticsPendingShot = shot;
        if (shot.intercept) {
            self._aiTacticsInterceptShot = true;
        } else {
            self._aiTacticsLeadShot = true;
        }
    }

    function tryTacticalShootGoal(self, enemy, cfg) {
        if (!enemy) return false;
        if (self._aiTacticsPostShotLock > 0) return false;
        if (!canFireFromShotStance(self, cfg)) return false;

        var cog = self._aiTacticsCognition;
        if (cfg.parallelCognition !== false) {
            if (!cog || !cog.shootPlan || !cog.shootPlan.worthShooting) return false;
            if (!cog.shootPlan.allowed) return false;
            if (shouldBlockShootForDodge(self, cfg)) return false;
        } else if (cfg.proactiveShoot === false) {
            return false;
        }

        var maxTiles = cfg.interceptMaxTiles !== undefined ? cfg.interceptMaxTiles : 14;
        if (enemy.dist > maxTiles) return false;

        var shot = cog && cog.shootPlan ? cog.shootPlan.shot : findInterceptShot(self, enemy.id, cfg);
        if (!shot || !isShotWorthFiring(shot, cfg, self)) return false;
        if (!passesVanillaFireGate(self, shot, cfg)) return false;

        var shootPeriod = cfg.shootGoalPeriodMin !== undefined ? cfg.shootGoalPeriodMin : 420;
        var offset = 0;
        if (typeof MathUtils !== 'undefined' && self.currentAggressiveness !== null) {
            offset = MathUtils.linearInterpolation(
                Constants.AI.MIN_SHOOT_AFTER_PRIORITY_OFFSET,
                Constants.AI.MAX_SHOOT_AFTER_PRIORITY_OFFSET,
                self.currentAggressiveness
            );
        }
        var prio = Math.min(
            0.72,
            ((maxTiles - enemy.dist) / maxTiles) * 0.35 + offset + 0.18
        );

        self.goal = {
            type: AI._GOALS.SHOOT_AFTER,
            priority: prio,
            id: self.nextGoalId++,
            period: shootPeriod,
            target: enemy.id,
            weaponType: Constants.WEAPON_TYPES.BULLET,
            preferredTargetInfo: { target: enemy.id, priority: 0 }
        };
        if (!commitPlannedShot(self, shot, enemy.id, cfg,
            (cfg.shotDrivenStance !== false && cog && cog.shotStancePlan &&
                cog.shotStancePlan.bestStance)
                ? cog.shotStancePlan.bestStance.pose : null)) {
            self.goal = {
                type: AI._GOALS.HUNT,
                priority: computeHuntPriority(enemy, cfg),
                id: self.nextGoalId++,
                period: getHuntPeriod(self, enemy, cfg),
                position: getPreferredHuntTile(self, enemy, cfg) || enemy.tile
            };
            return false;
        }
        return true;
    }

    function boostIncomingDodge(self, cfg) {
        return ensureIncomingDodgeGoal(self, cfg);
    }

    function threatNeedsDodgeNow(tank, threat, cfg) {
        if (!tank || !threat || !threat.dodgeInfo) return false;
        var marginNow = bodyMarginAt(
            tank.getX(), tank.getY(), tank.getRotation(), 0, [threat], cfg
        );
        var minMargin = cfg.dodgeMinMargin !== undefined ? cfg.dodgeMinMargin : -0.12;
        var bodyReach = getBodySafeCenterDist(cfg);
        var di = threat.dodgeInfo;
        var urgentTime = cfg.dodgeUrgentTime !== undefined ? cfg.dodgeUrgentTime : 2.2;
        var urgentDist = cfg.dodgeUrgentDistance !== undefined ? cfg.dodgeUrgentDistance : 16;
        if (marginNow < minMargin + 0.2) return true;
        if (di.closestDistance <= bodyReach * 0.55) return true;
        return di.closestTime <= urgentTime && di.closestDistance <= urgentDist;
    }

    function scoreThreatUrgency(tank, threat, cfg) {
        var di = threat.dodgeInfo;
        var urgentTime = cfg.dodgeUrgentTime !== undefined ? cfg.dodgeUrgentTime : 2.2;
        var urgentDist = cfg.dodgeUrgentDistance !== undefined ? cfg.dodgeUrgentDistance : 16;
        var marginNow = bodyMarginAt(
            tank.getX(), tank.getY(), tank.getRotation(), 0, [threat], cfg
        );
        var urgency = (urgentDist - Math.min(di.closestDistance, urgentDist)) / urgentDist +
            (1 - Math.min(di.closestTime, urgentTime) / urgentTime) * 0.6;
        if (marginNow < 0) urgency += 1.5 + Math.min(1.2, -marginNow);
        if (marginNow < getBodySafeCenterDist(cfg) * 0.35) urgency += 0.8;
        return urgency;
    }

    function findMostUrgentThreat(self, tank, cfg) {
        if (!tank || typeof AIUtils === 'undefined') return null;
        var threats = collectProjectileThreats(self, cfg);
        if (!threats.length) return null;

        var best = null;
        var i, th, urgency;
        for (i = 0; i < threats.length; i++) {
            th = threats[i];
            if (!threatNeedsDodgeNow(tank, th, cfg)) continue;
            urgency = scoreThreatUrgency(tank, th, cfg);
            if (!best || urgency > best.urgency) {
                best = {
                    urgency: urgency,
                    dodgeInfo: th.dodgeInfo,
                    path: th.path,
                    speed: th.speed
                };
            }
        }
        return best;
    }

    function hasActiveDodgeThreat(self, cfg) {
        var tank = self.gameController.getTank(self.aiId);
        return !!findMostUrgentThreat(self, tank, cfg);
    }

    function ensureIncomingDodgeGoal(self, cfg) {
        if (!cfg || cfg.smartDodge === false || typeof AIUtils === 'undefined') return false;
        if (AIUtils.checkProtected(self.aiId, self.gameController)) return false;
        var tank = self.gameController.getTank(self.aiId);
        if (!tank) return false;

        var urgent = findMostUrgentThreat(self, tank, cfg);
        if (!urgent) return false;

        self.goal = {
            type: AI._GOALS.DODGE_PROJECTILE,
            priority: 0.99,
            id: self.nextGoalId++,
            period: 0,
            dodgeInfo: urgent.dodgeInfo
        };
        return true;
    }

    var TACTICS_ACTION_DRIVE_INPUT = 'tactics drive input';

    /** 枚举全部合法恒定按键组合：每种组合定义一条 position(t) 轨迹 */
    function enumerateInputCombos() {
        var combos = [];
        var drives = [
            { forward: true,  back: false },
            { forward: false, back: true  },
            { forward: false, back: false }
        ];
        var steers = [
            { left: false, right: false },
            { left: true,  right: false },
            { left: false, right: true  }
        ];
        var di, si, d, s;
        for (di = 0; di < drives.length; di++) {
            for (si = 0; si < steers.length; si++) {
                d = drives[di];
                s = steers[si];
                if (!d.forward && !d.back && !s.left && !s.right) continue;
                combos.push({
                    forward: d.forward,
                    back: d.back,
                    left: s.left,
                    right: s.right
                });
            }
        }
        return combos;
    }

    var DODGE_INPUT_COMBOS = enumerateInputCombos();

    function comboHasMovement(combo) {
        return !!(combo && (combo.forward || combo.back));
    }

    function combosMatch(a, b) {
        return a && b &&
            a.forward === b.forward && a.back === b.back &&
            a.left === b.left && a.right === b.right;
    }

    function simulateDisplacement(samples) {
        if (!samples || samples.length < 2) return 0;
        var first = samples[0];
        var last = samples[samples.length - 1];
        var dx = last.x - first.x;
        var dy = last.y - first.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function countOpenDirections(self, tank, cfg) {
        var world = self.gameController.getB2DWorld();
        var pos = { x: tank.getX(), y: tank.getY() };
        var probe = Constants.MAZE_TILE_SIZE.m * (cfg.narrowProbeTiles !== undefined ? cfg.narrowProbeTiles : 0.42);
        var dirs = [
            { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }
        ];
        var open = 0;
        var i;
        for (i = 0; i < dirs.length; i++) {
            if (!B2DUtils.checkLineForMazeCollision(world, pos, {
                x: pos.x + dirs[i].x * probe,
                y: pos.y + dirs[i].y * probe
            })) {
                open++;
            }
        }
        return open;
    }

    function isNarrowSpace(self, tank, cfg) {
        var maxOpen = cfg.narrowSpaceOpenDirs !== undefined ? cfg.narrowSpaceOpenDirs : 2;
        return countOpenDirections(self, tank, cfg) <= maxOpen;
    }

    function positionOnProjectilePath(path, speed, time) {
        if (!path || path.length < 2 || speed <= 0) return null;
        var elapsed = 0;
        var i, segLen, segTime, u;
        for (i = 0; i < path.length - 1; i++) {
            var dx = path[i + 1].x - path[i].x;
            var dy = path[i + 1].y - path[i].y;
            segLen = Math.sqrt(dx * dx + dy * dy);
            segTime = segLen / speed;
            if (elapsed + segTime >= time) {
                u = segTime > 0 ? (time - elapsed) / segTime : 0;
                return {
                    x: path[i].x + dx * u,
                    y: path[i].y + dy * u
                };
            }
            elapsed += segTime;
        }
        return { x: path[path.length - 1].x, y: path[path.length - 1].y };
    }

    function simulateTankInputs(tank, inputs, duration, world) {
        var rot = tank.getRotation();
        var x = tank.getX();
        var y = tank.getY();
        var dt = 0.02;
        var t = 0;
        var fwd = Constants.TANK.FORWARD_SPEED.m;
        var back = Constants.TANK.BACK_SPEED.m;
        var rotSpd = Constants.TANK.ROTATION_SPEED;
        var hitWall = false;
        var samples = [];

        while (t <= duration + 0.0001) {
            samples.push({ t: t, x: x, y: y, rot: rot });
            if (t >= duration) break;

            var rs = 0;
            if (inputs.left && !inputs.right) rs = -rotSpd;
            else if (inputs.right && !inputs.left) rs = rotSpd;

            var sp = 0;
            if (inputs.forward) sp += fwd;
            if (inputs.back) sp -= back;

            var step = Math.min(dt, duration - t);
            rot += rs * step;
            var nx = x + Math.sin(rot) * sp * step;
            var ny = y - Math.cos(rot) * sp * step;

            if (world && typeof B2DUtils !== 'undefined' &&
                B2DUtils.checkLineForMazeCollision(world, { x: x, y: y }, { x: nx, y: ny })) {
                hitWall = true;
                break;
            }
            x = nx;
            y = ny;
            t += step;
        }
        return { samples: samples, hitWall: hitWall };
    }

    function minClearanceAlongPath(samples, path, bulletSpeed) {
        var minDist = Number.MAX_VALUE;
        var i, bulletPos, dx, dy, dist;
        for (i = 0; i < samples.length; i++) {
            bulletPos = positionOnProjectilePath(path, bulletSpeed, samples[i].t);
            if (!bulletPos) continue;
            dx = samples[i].x - bulletPos.x;
            dy = samples[i].y - bulletPos.y;
            dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) minDist = dist;
        }
        return minDist;
    }

    function collectProjectileThreats(self, cfg) {
        var threats = [];
        if (!self.projectilePaths || typeof AIUtils === 'undefined') return threats;
        var projectiles = self.gameController.getProjectiles();
        var tank = self.gameController.getTank(self.aiId);
        if (!tank) return threats;

        var boldness = parseFloat(self.config[AI._TRAITS.BOLDNESS]) || 0.5;
        var maxConsider = cfg.dodgeThreatConsiderDist !== undefined ? cfg.dodgeThreatConsiderDist : 30;
        var scary = MathUtils.linearInterpolation(
            Constants.AI.MAX_SCARY_PROJECTILE_DISTANCE,
            Constants.AI.MIN_SCARY_PROJECTILE_DISTANCE,
            boldness
        );
        var scarySq = scary * scary;
        var pid, path, projectile, speed, dodgeInfo;

        for (pid in self.projectilePaths) {
            if (!self.projectilePaths.hasOwnProperty(pid)) continue;
            path = self.projectilePaths[pid];
            projectile = projectiles[pid];
            if (!path || path.length < 2 || !projectile || !projectile.getB2DBody) continue;
            speed = projectile.getB2DBody().GetLinearVelocity().Length();
            if (speed <= 0) continue;
            dodgeInfo = AIUtils.checkProjectilePathForDodging(
                tank, path, projectile, self.gameController.getB2DWorld(), Number.MAX_VALUE
            );
            if (!dodgeInfo || !dodgeInfo.closestId) continue;
            if (dodgeInfo.closestDistance > maxConsider) continue;
            threats.push({
                id: pid,
                path: path,
                speed: speed,
                dodgeInfo: dodgeInfo,
                origin: self.projectilePositions ? self.projectilePositions[pid] : null
            });
        }
        return threats;
    }

    function minClearanceToThreatsAt(wx, wy, time, threats) {
        var minD = Number.MAX_VALUE;
        var i, bp, dx, dy;
        for (i = 0; i < threats.length; i++) {
            bp = positionOnProjectilePath(threats[i].path, threats[i].speed, time);
            if (!bp) continue;
            dx = wx - bp.x;
            dy = wy - bp.y;
            minD = Math.min(minD, Math.sqrt(dx * dx + dy * dy));
        }
        return minD;
    }

    function interpolateSampleAtTime(samples, time) {
        if (!samples || samples.length === 0) return null;
        if (time <= samples[0].t) {
            return { x: samples[0].x, y: samples[0].y, rot: samples[0].rot };
        }
        var i, u, rotA, rotB, rotDiff;
        for (i = 1; i < samples.length; i++) {
            if (samples[i].t >= time) {
                u = (samples[i].t - samples[i - 1].t) > 0
                    ? (time - samples[i - 1].t) / (samples[i].t - samples[i - 1].t) : 0;
                rotA = samples[i - 1].rot !== undefined ? samples[i - 1].rot : 0;
                rotB = samples[i].rot !== undefined ? samples[i].rot : rotA;
                rotDiff = normalizeAngleRad(rotB - rotA);
                return {
                    x: samples[i - 1].x + (samples[i].x - samples[i - 1].x) * u,
                    y: samples[i - 1].y + (samples[i].y - samples[i - 1].y) * u,
                    rot: rotA + rotDiff * u
                };
            }
        }
        var last = samples[samples.length - 1];
        return { x: last.x, y: last.y, rot: last.rot };
    }

    function displacementBeforeTime(samples, time) {
        if (!samples || samples.length === 0) return 0;
        var start = samples[0];
        var at = interpolateSampleAtTime(samples, time);
        if (!at) return 0;
        var dx = at.x - start.x;
        var dy = at.y - start.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function comboForMoveDirection(tank, dirX, dirY) {
        var dlen = Math.sqrt(dirX * dirX + dirY * dirY);
        if (dlen < 0.001) {
            return { forward: true, back: false, left: true, right: false };
        }
        dirX /= dlen;
        dirY /= dlen;
        var desired = Math.atan2(dirX, -dirY);
        var diff = normalizeAngleRad(desired - tank.getRotation());
        var forward = true;
        var back = false;
        if (Math.abs(diff) > Math.PI * 0.55) {
            forward = false;
            back = true;
            diff = normalizeAngleRad(diff > 0 ? diff - Math.PI : diff + Math.PI);
        }
        return {
            forward: forward,
            back: back,
            left: diff > 0.04,
            right: diff < -0.04
        };
    }

    function normalizeAngleRad(a) {
        while (a > Math.PI) a -= Math.PI * 2;
        while (a < -Math.PI) a += Math.PI * 2;
        return a;
    }

    function spacetimeHorizon(samples, threats, cfg) {
        var horizon = samples && samples.length > 0 ? samples[samples.length - 1].t : 0;
        var i, tEnd;
        for (i = 0; i < threats.length; i++) {
            tEnd = threats[i].dodgeInfo.closestTime + 0.15;
            if (tEnd > horizon) horizon = tEnd;
            tEnd = pathTotalTime(threats[i].path, threats[i].speed);
            if (tEnd > horizon) horizon = tEnd;
        }
        var maxH = cfg.dodgeSimMaxTime !== undefined ? cfg.dodgeSimMaxTime : 1.6;
        if (horizon > maxH) horizon = maxH;
        return horizon;
    }

    /**
     * 时空安全评估：轨迹 position(t) 在每一时刻 t 均须落在所有子弹的盲区（margin≥0）。
     * margin(t) = 子弹 OBB 最近距离；整条路径取 minMargin 为可行性判据。
     */
    function evaluateSpacetimeTrajectory(samples, threats, cfg, world) {
        if (!samples || samples.length === 0) {
            return {
                survives: false, softSurvive: false,
                minBodyMargin: -999, avgBodyMargin: -999,
                score: -1000, displacement: 0
            };
        }

        var horizon = spacetimeHorizon(samples, threats, cfg);
        var dt = cfg.dodgeSafetySampleDt !== undefined ? cfg.dodgeSafetySampleDt : 0.025;
        var minMargin = Number.MAX_VALUE;
        var sumMargin = 0;
        var count = 0;
        var t, interp, rot, margin, wallBonus, i;

        for (t = 0; t <= horizon + 0.0001; t += dt) {
            interp = interpolateSampleAtTime(samples, t);
            if (!interp) continue;
            rot = interp.rot !== undefined ? interp.rot : (samples[0].rot || 0);
            margin = bodyMarginAt(interp.x, interp.y, rot, t, threats, cfg);
            if (margin < minMargin) minMargin = margin;
            sumMargin += margin;
            count++;
        }

        var avgMargin = count > 0 ? sumMargin / count : minMargin;
        var survives = minMargin >= 0;
        var softSurvive = minMargin >= (cfg.dodgeMinMargin !== undefined ? cfg.dodgeMinMargin : -0.12);
        var displacement = simulateDisplacement(samples);
        var dispW = cfg.dodgeDisplacementWeight !== undefined ? cfg.dodgeDisplacementWeight : 0.4;
        var score = minMargin * 12 + avgMargin * 3;
        if (survives) score += 6;
        else if (softSurvive) score += minMargin * 3;
        score += displacement * dispW;

        if (world && survives) {
            wallBonus = 0;
            for (i = 0; i < threats.length; i++) {
                t = threats[i].dodgeInfo.closestTime;
                interp = interpolateSampleAtTime(samples, t);
                if (!interp) continue;
                var bp = positionOnProjectilePath(threats[i].path, threats[i].speed, t);
                if (bp && B2DUtils.checkLineForMazeCollision(world, bp, interp)) {
                    wallBonus += 0.8;
                }
            }
            score += wallBonus;
        }

        return {
            survives: survives,
            softSurvive: softSurvive,
            minBodyMargin: minMargin,
            avgBodyMargin: avgMargin,
            score: score,
            displacement: displacement
        };
    }

    function evaluateTrajectorySurvival(samples, threats, cfg, world) {
        return evaluateSpacetimeTrajectory(samples, threats, cfg, world);
    }

    function generateThroughDodgeTargets(tank, threats, world, cfg) {
        var targets = [];
        var bodySafe = getBodySafeCenterDist(cfg);
        var tx = tank.getX();
        var ty = tank.getY();
        var tankPos = { x: tx, y: ty };
        var i, j, k, di, tClose, cp, vel, vlen, nx, ny, px, py, side, dists, pt, ahead;

        for (i = 0; i < threats.length; i++) {
            di = threats[i].dodgeInfo;
            tClose = di.closestTime;
            cp = di.closestPosition;
            if (!cp || tClose > 2.5) continue;

            vel = bulletVelocityAt(threats[i], tClose);
            vlen = Math.sqrt(vel.x * vel.x + vel.y * vel.y) || threats[i].speed;
            nx = vel.x / vlen;
            ny = vel.y / vlen;
            px = -ny;
            py = nx;

            dists = [bodySafe * 1.1, bodySafe * 1.8, bodySafe * 2.6, bodySafe * 3.4];
            for (j = 0; j < dists.length; j++) {
                for (side = -1; side <= 1; side += 2) {
                    pt = { x: tx + px * side * dists[j], y: ty + py * side * dists[j] };
                    if (!B2DUtils.checkLineForMazeCollision(world, tankPos, pt)) {
                        targets.push({ x: pt.x, y: pt.y, arriveBy: tClose, kind: 'lateral' });
                    }
                    pt = { x: cp.x + px * side * dists[j], y: cp.y + py * side * dists[j] };
                    if (!B2DUtils.checkLineForMazeCollision(world, tankPos, pt)) {
                        targets.push({ x: pt.x, y: pt.y, arriveBy: tClose, kind: 'gap' });
                    }
                }
            }

            for (k = 0; k < 5; k++) {
                ahead = bodySafe * (0.8 + k * 0.65);
                pt = { x: cp.x - nx * ahead, y: cp.y - ny * ahead };
                if (!B2DUtils.checkLineForMazeCollision(world, tankPos, pt)) {
                    targets.push({ x: pt.x, y: pt.y, arriveBy: Math.max(0, tClose - 0.06), kind: 'through' });
                }
                pt = { x: cp.x + nx * ahead * 0.6, y: cp.y + ny * ahead * 0.6 };
                if (!B2DUtils.checkLineForMazeCollision(world, tankPos, pt)) {
                    targets.push({ x: pt.x, y: pt.y, arriveBy: tClose + 0.05, kind: 'throughLate' });
                }
            }
        }
        return targets;
    }

    function comboFromSteerIntent(tank, tx, ty) {
        return comboForMoveDirection(tank, tx - tank.getX(), ty - tank.getY());
    }

    function constantInputFromCombo(combo) {
        return {
            forward: !!combo.forward,
            back: !!combo.back,
            left: !!combo.left,
            right: !!combo.right
        };
    }

    function shouldKeepDodgePlan(self, cfg) {
        if (!self.actions || self.actions.length === 0) return false;
        if (self.actions[0].type !== TACTICS_ACTION_DRIVE_INPUT) return false;
        if (self.actions[0].duration <= 40) return false;

        var tank = self.gameController.getTank(self.aiId);
        if (!tank || !self._aiTacticsActiveDodgeCombo) return self.actions[0].duration > 60;

        var threats = collectProjectileThreats(self, cfg);
        if (threats.length === 0) return false;

        var world = self.gameController.getB2DWorld();
        var maxSim = spacetimeHorizon(
            [{ t: 0 }, { t: cfg.dodgeSimMaxTime || 1.6 }],
            threats,
            cfg
        );
        var sim = simulateTankInputs(tank, self._aiTacticsActiveDodgeCombo, maxSim, world);
        var ev = evaluateSpacetimeTrajectory(sim.samples, threats, cfg, world);
        if (!ev.softSurvive) return false;
        if (ev.minBodyMargin < 0 && !comboHasMovement(self._aiTacticsActiveDodgeCombo)) {
            return false;
        }
        return true;
    }

    function dodgeNeedsDisplacement(tank, threats, cfg) {
        if (!tank || !threats || !threats.length) return false;
        var rot = tank.getRotation();
        var tx = tank.getX();
        var ty = tank.getY();
        var i, marginNow;
        for (i = 0; i < threats.length; i++) {
            marginNow = bodyMarginAt(tx, ty, rot, 0, [threats[i]], cfg);
            if (marginNow < getBodySafeCenterDist(cfg) * 0.4) return true;
        }
        return false;
    }

    function selectDodgePickFromCandidates(candidates, cfg, tank, threats, lastCombo) {
        if (!candidates || candidates.length === 0) return null;
        var needsMove = dodgeNeedsDisplacement(tank, threats, cfg);
        var best = null;
        var bestSurvivor = null;
        var bestSoft = null;
        var bestMargin = null;
        var i, c, sc;

        for (i = 0; i < candidates.length; i++) {
            c = candidates[i];
            sc = c.eval.score;
            if (c.through) sc += 0.3;
            if (c.type === 'steer') sc += 0.2;
            if (needsMove && c.combo && !comboHasMovement(c.combo)) sc -= 4.0;
            if (needsMove && c.eval.displacement !== undefined && c.eval.displacement < 0.35) sc -= 2.5;
            if (!needsMove && c.combo && !comboHasMovement(c.combo)) sc -= 1.2;
            if (lastCombo && combosMatch(c.combo, lastCombo) && c.eval.minBodyMargin < 0.05) {
                sc -= cfg.dodgeRepeatPenalty !== undefined ? cfg.dodgeRepeatPenalty : 1.5;
            }
            if (c.eval.survives && (!bestSurvivor || sc > bestSurvivor.sc)) {
                bestSurvivor = { pick: c, sc: sc };
            }
            if (c.eval.softSurvive && (!bestSoft || sc > bestSoft.sc)) {
                bestSoft = { pick: c, sc: sc };
            }
            if (!bestMargin || c.eval.minBodyMargin > bestMargin.pick.eval.minBodyMargin) {
                bestMargin = { pick: c, sc: sc };
            }
            if (!best || sc > best.sc) {
                best = { pick: c, sc: sc };
            }
        }

        if (bestSurvivor) return bestSurvivor.pick;
        if (needsMove && bestMargin) return bestMargin.pick;
        return bestSoft ? bestSoft.pick : (best ? best.pick : candidates[0]);
    }

    function buildDodgePlanCandidates(tank, threats, world, cfg, self) {
        var candidates = [];
        var i, combo, sim, ev, sc, targets, tgt, margin, interp, rot, steerSim;
        var closestT = 2.0;
        var tx = tank.getX();
        var ty = tank.getY();
        var lastCombo = self ? self._aiTacticsLastDodgeCombo : null;

        for (i = 0; i < threats.length; i++) {
            closestT = Math.min(closestT, threats[i].dodgeInfo.closestTime);
        }
        var maxSim = Math.min(
            cfg.dodgeSimMaxTime !== undefined ? cfg.dodgeSimMaxTime : 1.6,
            closestT + 0.55
        );
        maxSim = Math.max(maxSim, 0.55);

        var combos = enumerateInputCombos();
        for (i = 0; i < combos.length; i++) {
            combo = combos[i];
            sim = simulateTankInputs(tank, combo, maxSim, world);
            if (sim.hitWall) continue;
            ev = evaluateSpacetimeTrajectory(sim.samples, threats, cfg, world);
            candidates.push({ type: 'constant', combo: combo, eval: ev, simSamples: sim.samples });
        }

        targets = generateThroughDodgeTargets(tank, threats, world, cfg);
        for (i = 0; i < targets.length; i++) {
            tgt = targets[i];
            steerSim = simulateSteerToPoint(tank, tgt.x, tgt.y, world, maxSim, cfg);
            if (!steerSim.hitWall && steerSim.samples.length > 1) {
                ev = evaluateSpacetimeTrajectory(steerSim.samples, threats, cfg, world);
                sc = ev.score;
                interp = interpolateSampleAtTime(steerSim.samples, tgt.arriveBy);
                if (interp) {
                    rot = interp.rot !== undefined ? interp.rot : tank.getRotation();
                    margin = bodyMarginAt(interp.x, interp.y, rot, tgt.arriveBy, threats, cfg);
                    sc += margin * 4;
                }
                ev.score = sc;
                combo = comboForMoveDirection(tank, tgt.x - tx, tgt.y - ty);
                candidates.push({ type: 'steer', combo: combo, eval: ev, through: tgt.kind,
                    steerSamples: steerSim.samples, target: tgt, simSamples: steerSim.samples });
            } else {
                combo = comboForMoveDirection(tank, tgt.x - tx, tgt.y - ty);
                sim = simulateTankInputs(tank, combo, maxSim, world);
                if (sim.hitWall) continue;
                ev = evaluateSpacetimeTrajectory(sim.samples, threats, cfg, world);
                sc = ev.score;
                interp = interpolateSampleAtTime(sim.samples, tgt.arriveBy);
                if (interp) {
                    rot = interp.rot !== undefined ? interp.rot : tank.getRotation();
                    margin = bodyMarginAt(interp.x, interp.y, rot, tgt.arriveBy, threats, cfg);
                    sc += margin * 4;
                }
                ev.score = sc;
                candidates.push({ type: 'constant', combo: combo, eval: ev, through: tgt.kind,
                    target: tgt, simSamples: sim.samples });
            }
        }

        return { candidates: candidates, targets: targets, maxSim: maxSim, lastCombo: lastCombo };
    }

    /** 执行层只支持恒定按键；steer 候选须用 combo 重算轨迹再应用 */
    function normalizePickForConstantExecution(pick, tank, threats, world, cfg, maxSim) {
        if (!pick || !pick.combo) return pick;
        var sim = simulateTankInputs(tank, pick.combo, maxSim, world);
        var ev = evaluateSpacetimeTrajectory(sim.samples, threats, cfg, world);
        return {
            type: 'constant',
            combo: pick.combo,
            eval: ev,
            simSamples: sim.samples,
            through: pick.through || null
        };
    }

    function dodgeVizHorizon(cfg, threats) {
        var closestT = 2.0;
        var i;
        if (threats) {
            for (i = 0; i < threats.length; i++) {
                closestT = Math.min(closestT, threats[i].dodgeInfo.closestTime);
            }
        }
        var inputSec = (cfg.dodgeInputDuration !== undefined ? cfg.dodgeInputDuration : 400) / 1000;
        return Math.min(
            cfg.dodgeSimMaxTime !== undefined ? cfg.dodgeSimMaxTime : 1.6,
            closestT + 0.35,
            inputSec + 0.12
        );
    }

    function trimDodgeVizTrajectory(samples) {
        if (!samples || samples.length < 2) return samples;
        var disp = simulateDisplacement(samples);
        if (disp < 0.25) {
            return samples.slice(0, Math.min(4, samples.length));
        }
        return samples;
    }

    function trajectoryForDodgeCombo(tank, combo, cfg, world, threats) {
        if (!tank || !combo) return null;
        var horizon = dodgeVizHorizon(cfg, threats);
        var sim = simulateTankInputs(tank, combo, horizon, world);
        return trimDodgeVizTrajectory(sim.samples);
    }

    function updateExecutedDodgeViz(self, tank, pick, built, cfg) {
        if (!tank || !pick || !pick.combo) {
            self._aiTacticsExecutedDodgeViz = null;
            return;
        }
        var threats = built && built.threats ? built.threats : collectProjectileThreats(self, cfg);
        var world = self.gameController.getB2DWorld();
        var horizon = dodgeVizHorizon(cfg, threats);
        var traj = pick.simSamples;
        if (!traj || pick.type === 'steer') {
            traj = trajectoryForDodgeCombo(tank, pick.combo, cfg, world, threats);
        } else {
            traj = trimDodgeVizTrajectory(traj);
        }

        var candidateTrajectories = [];
        var ranked = (built && built.candidates ? built.candidates : []).slice();
        ranked.sort(function(a, b) { return (b.eval.score || 0) - (a.eval.score || 0); });
        var pickLabel = comboLabel(pick.combo);
        var ci, c, ct;

        for (ci = 0; ci < ranked.length && ci < 5; ci++) {
            c = ranked[ci];
            if (!c.combo) continue;
            ct = trajectoryForDodgeCombo(tank, c.combo, cfg, world, threats);
            if (!ct || ct.length < 2) continue;
            candidateTrajectories.push({
                label: comboLabel(c.combo),
                survives: c.eval.survives,
                isPick: pickLabel === comboLabel(c.combo),
                trajectory: ct
            });
        }

        self._aiTacticsExecutedDodgeViz = {
            at: Date.now(),
            label: pickLabel,
            combo: pick.combo,
            survives: pick.eval ? pick.eval.survives : false,
            minMargin: pick.eval ? pick.eval.minBodyMargin : null,
            trajectory: traj,
            candidateTrajectories: candidateTrajectories,
            threatCount: threats.length
        };
    }

    function refreshExecutedDodgeVizFromActive(self, cfg) {
        var tank = self.gameController.getTank(self.aiId);
        if (!tank || !self._aiTacticsActiveDodgeCombo) return;
        var threats = collectProjectileThreats(self, cfg);
        var traj = trajectoryForDodgeCombo(
            tank, self._aiTacticsActiveDodgeCombo, cfg,
            self.gameController.getB2DWorld(), threats
        );
        if (!self._aiTacticsExecutedDodgeViz) {
            self._aiTacticsExecutedDodgeViz = {};
        }
        self._aiTacticsExecutedDodgeViz.at = Date.now();
        self._aiTacticsExecutedDodgeViz.label = comboLabel(self._aiTacticsActiveDodgeCombo);
        self._aiTacticsExecutedDodgeViz.combo = self._aiTacticsActiveDodgeCombo;
        self._aiTacticsExecutedDodgeViz.trajectory = traj;
    }

    function simulateSteerToPoint(tank, tx, ty, world, maxTime, cfg) {
        var dt = cfg.dodgeSimDt !== undefined ? cfg.dodgeSimDt : 0.025;
        var rot = tank.getRotation();
        var x = tank.getX();
        var y = tank.getY();
        var fwd = Constants.TANK.FORWARD_SPEED.m;
        var back = Constants.TANK.BACK_SPEED.m;
        var rotSpd = Constants.TANK.ROTATION_SPEED;
        var t = 0;
        var samples = [{ t: 0, x: x, y: y, rot: rot }];
        var hitWall = false;
        var arriveDist = Constants.MAZE_TILE_SIZE.m * 0.22;

        while (t < maxTime) {
            var dx = tx - x;
            var dy = ty - y;
            var dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < arriveDist) break;

            var desired = Math.atan2(dx, -dy);
            var diff = normalizeAngleRad(desired - rot);
            var step = Math.min(dt, maxTime - t);
            if (Math.abs(diff) > 0.06) {
                if (Math.abs(diff) < rotSpd * step) rot = desired;
                else rot += (diff > 0 ? rotSpd : -rotSpd) * step;
            }
            var sp = Math.abs(diff) < 1.15 ? fwd : 0;
            if (dist < Constants.MAZE_TILE_SIZE.m * 0.5 && Math.abs(diff) > 0.45) sp = 0;

            var nx = x + Math.sin(rot) * sp * step;
            var ny = y - Math.cos(rot) * sp * step;
            if (B2DUtils.checkLineForMazeCollision(world, { x: x, y: y }, { x: nx, y: ny })) {
                nx = x - Math.sin(rot) * back * step;
                ny = y + Math.cos(rot) * back * step;
                if (B2DUtils.checkLineForMazeCollision(world, { x: x, y: y }, { x: nx, y: ny })) {
                    hitWall = true;
                    break;
                }
            }
            x = nx;
            y = ny;
            t += step;
            samples.push({ t: t, x: x, y: y, rot: rot });
        }
        return { samples: samples, hitWall: hitWall, finalRot: rot, finalX: x, finalY: y };
    }

    function pickBestSpacetimeCandidate(tank, threats, world, cfg, maxSim, extraScoreFn) {
        var candidates = [];
        var combos = enumerateInputCombos();
        var i, combo, sim, ev, sc;

        for (i = 0; i < combos.length; i++) {
            combo = combos[i];
            sim = simulateTankInputs(tank, combo, maxSim, world);
            if (sim.hitWall) continue;
            ev = evaluateSpacetimeTrajectory(sim.samples, threats, cfg, world);
            sc = ev.score;
            if (extraScoreFn) sc += extraScoreFn(combo, ev, sim.samples) || 0;
            candidates.push({ combo: combo, eval: ev, score: sc });
        }

        if (candidates.length === 0) return null;

        var best = null;
        var bestSurvivor = null;
        var bestSoft = null;
        var c;
        for (i = 0; i < candidates.length; i++) {
            c = candidates[i];
            sc = c.score;
            if (c.eval.survives && (!bestSurvivor || sc > bestSurvivor.score)) {
                bestSurvivor = c;
            }
            if (c.eval.softSurvive && (!bestSoft || sc > bestSoft.score)) {
                bestSoft = c;
            }
            if (!best || sc > best.score) best = c;
        }
        return bestSurvivor || bestSoft || best;
    }

    function makeSteerTank(state) {
        return {
            getRotation: function() { return state.rot; },
            getX: function() { return state.x; },
            getY: function() { return state.y; }
        };
    }

    function simulateFollowTilePath(tank, path, world, maxTime, cfg) {
        if (!path || path.length < 2) {
            return { samples: [{ t: 0, x: tank.getX(), y: tank.getY() }], hitWall: false };
        }
        var ts = Constants.MAZE_TILE_SIZE.m;
        var allSamples = [];
        var t0 = 0;
        var state = { rot: tank.getRotation(), x: tank.getX(), y: tank.getY() };
        var fakeTank = makeSteerTank(state);
        var i, center, seg, remaining, j;

        remaining = maxTime;
        for (i = 1; i < path.length && remaining > 0.02; i++) {
            center = { x: (path[i].x + 0.5) * ts, y: (path[i].y + 0.5) * ts };
            seg = simulateSteerToPoint(fakeTank, center.x, center.y, world, remaining, cfg);
            for (j = 0; j < seg.samples.length; j++) {
                allSamples.push({ t: t0 + seg.samples[j].t, x: seg.samples[j].x, y: seg.samples[j].y });
            }
            if (seg.hitWall) return { samples: allSamples, hitWall: true };
            if (seg.samples.length > 0) {
                state.x = seg.finalX;
                state.y = seg.finalY;
                state.rot = seg.finalRot;
                t0 += seg.samples[seg.samples.length - 1].t;
                remaining = maxTime - t0;
            }
        }
        if (allSamples.length === 0) {
            allSamples.push({ t: 0, x: tank.getX(), y: tank.getY(), rot: tank.getRotation() });
        }
        return { samples: allSamples, hitWall: false };
    }

    function getTankHalfWidth() {
        return Constants.TANK.WIDTH.m * 0.5;
    }

    /** 车体矩形后半长（中心到车尾，不含炮管前伸） */
    function getTankBodyHalfLength() {
        return Constants.TANK.HEIGHT.m * 0.5;
    }

    /** 车体半长 + 炮塔/炮管前伸（取对称圆盘半径，单位：本地 px） */
    function tankForwardHalfLengthPx() {
        if (typeof Constants === 'undefined' || !Constants.TANK) return 40;
        var bodyHalf = Constants.TANK.HEIGHT.px * 0.5;
        var front = bodyHalf;
        var turretTip, muzzle;
        if (Constants.BULLET_TURRET) {
            turretTip = Math.abs(Constants.BULLET_TURRET.OFFSET_Y.px) +
                Constants.BULLET_TURRET.HEIGHT.px * 0.5;
            if (turretTip > front) front = turretTip;
        }
        if (Constants.BULLET) {
            muzzle = (Constants.BULLET.OFFSET && Constants.BULLET.OFFSET.px) || 0;
            if (Constants.BULLET.RADIUS && Constants.BULLET.RADIUS.px) {
                muzzle += Constants.BULLET.RADIUS.px;
            }
            if (muzzle > front) front = muzzle;
        }
        return Math.max(bodyHalf, front);
    }

    function getTankHalfLength() {
        return tankForwardHalfLengthPx() * Constants.METERS_PER_PIXEL;
    }

    /**
     * 规划/OBB 用非对称矩形包络：前向含炮管，后向仅车体。
     */
    function getTankHullHalfExtents(cfg) {
        return {
            halfW: getTankHalfWidth(),
            halfForward: getTankHalfLength(),
            halfBack: getTankBodyHalfLength()
        };
    }

    /** 包络矩形最远两角距离 = 黄圆直径 */
    function getTankMaxDiagonal(cfg) {
        var e = getTankHullHalfExtents(cfg);
        return Math.sqrt(
            (e.halfForward + e.halfBack) * (e.halfForward + e.halfBack) +
            (4 * e.halfW * e.halfW)
        );
    }

    function getTankHullHalfExtentsPx(spriteScale) {
        var s = spriteScale !== undefined ? spriteScale : 1;
        var ppm = Constants.PIXELS_PER_METER || 20;
        var e = getTankHullHalfExtents();
        return {
            hw: e.halfW * ppm * s,
            halfForward: e.halfForward * ppm * s,
            halfBack: e.halfBack * ppm * s,
            hl: e.halfForward * ppm * s
        };
    }

    function getTankBodyRadius() {
        return getTankHalfWidth();
    }

    function getTankReachExtent(cfg) {
        var diag = getTankMaxDiagonal(cfg);
        var slack = cfg.dodgeBodySlack !== undefined ? cfg.dodgeBodySlack : 0.15;
        return diag * 0.5 + getBulletBodyRadius() + slack;
    }

    function closestPointOnTankOBB(bx, by, cx, cy, rot) {
        var hull = getTankHullHalfExtents();
        var halfW = hull.halfW;
        var halfF = hull.halfForward;
        var halfB = hull.halfBack;
        var dx = bx - cx;
        var dy = by - cy;
        var fX = Math.sin(rot);
        var fY = -Math.cos(rot);
        var rX = Math.cos(rot);
        var rY = Math.sin(rot);
        var localF = dx * fX + dy * fY;
        var localR = dx * rX + dy * rY;
        if (localF > halfF) localF = halfF;
        else if (localF < -halfB) localF = -halfB;
        if (localR > halfW) localR = halfW;
        else if (localR < -halfW) localR = -halfW;
        return {
            x: cx + fX * localF + rX * localR,
            y: cy + fY * localF + rY * localR
        };
    }

    function bulletMarginToTankAt(bx, by, cx, cy, rot, cfg) {
        var cp = closestPointOnTankOBB(bx, by, cx, cy, rot);
        var dx = bx - cp.x;
        var dy = by - cp.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var slack = cfg.dodgeBodySlack !== undefined ? cfg.dodgeBodySlack : 0.15;
        return dist - getBulletBodyRadius() - slack;
    }

    function getBulletBodyRadius() {
        return Constants.BULLET.RADIUS.m;
    }

    /** 规划用保守安全距离（角点外接圆 + 子弹半径） */
    function getBodySafeCenterDist(cfg) {
        return getTankReachExtent(cfg);
    }

    function pathTotalTime(path, speed) {
        if (!path || path.length < 2 || speed <= 0) return 0;
        var total = 0;
        var i, dx, dy;
        for (i = 0; i < path.length - 1; i++) {
            dx = path[i + 1].x - path[i].x;
            dy = path[i + 1].y - path[i].y;
            total += Math.sqrt(dx * dx + dy * dy) / speed;
        }
        return total;
    }

    function bulletVelocityAt(threat, time) {
        var path = threat.path;
        var speed = threat.speed;
        if (!path || path.length < 2 || speed <= 0) return { x: 0, y: 0 };
        var elapsed = 0;
        var i, segLen, segTime, dx, dy;
        for (i = 0; i < path.length - 1; i++) {
            dx = path[i + 1].x - path[i].x;
            dy = path[i + 1].y - path[i].y;
            segLen = Math.sqrt(dx * dx + dy * dy);
            segTime = segLen / speed;
            if (elapsed + segTime >= time || i === path.length - 2) {
                var u = segTime > 0 ? Math.min(1, (time - elapsed) / segTime) : 0;
                var vx = (path[i + 1].x - path[i].x) / (segTime > 0 ? segTime : 1);
                var vy = (path[i + 1].y - path[i].y) / (segTime > 0 ? segTime : 1);
                return { x: vx, y: vy };
            }
            elapsed += segTime;
        }
        dx = path[path.length - 1].x - path[path.length - 2].x;
        dy = path[path.length - 1].y - path[path.length - 2].y;
        segLen = Math.sqrt(dx * dx + dy * dy) || 1;
        return { x: dx / segLen * speed, y: dy / segLen * speed };
    }

    function bodyMarginAt(wx, wy, rot, time, threats, cfg) {
        var activeDist = cfg.dodgeActiveThreatDist !== undefined ? cfg.dodgeActiveThreatDist : 8.5;
        var minMargin = Number.MAX_VALUE;
        var i, bp, dist, total, margin;
        var tankRot = rot !== undefined && rot !== null ? rot : 0;

        for (i = 0; i < threats.length; i++) {
            total = pathTotalTime(threats[i].path, threats[i].speed);
            if (time > total + 0.15) continue;

            bp = positionOnProjectilePath(threats[i].path, threats[i].speed, time);
            if (!bp) continue;

            dist = Math.sqrt((wx - bp.x) * (wx - bp.x) + (wy - bp.y) * (wy - bp.y));
            if (dist > activeDist) continue;

            margin = bulletMarginToTankAt(bp.x, bp.y, wx, wy, tankRot, cfg);
            if (margin < minMargin) minMargin = margin;
        }
        return minMargin === Number.MAX_VALUE ? 999 : minMargin;
    }

    function getDodgeSafeClearance(cfg) {
        return getBodySafeCenterDist(cfg);
    }

    function scoreDodgeCombo(tank, inputs, path, bulletSpeed, simDuration, world, cfg, dodgeInfo, threats) {
        var sim = simulateTankInputs(tank, inputs, simDuration, world);
        if (sim.hitWall) return -1000;

        if (threats && threats.length > 0) {
            var ev = evaluateSpacetimeTrajectory(sim.samples, threats, cfg, world);
            return ev.score;
        }

        var clearance = minClearanceAlongPath(sim.samples, path, bulletSpeed);
        var safe = getDodgeSafeClearance(cfg);
        var score = clearance;
        if (clearance >= safe) score += 2.0;
        score += simulateDisplacement(sim.samples) * 0.4;
        return score;
    }

    function actionsHaveDrive(actions) {
        var i;
        for (i = 0; i < actions.length; i++) {
            if (actions[i].type === AI._ACTIONS.DRIVE_TO_POSITION ||
                actions[i].type === AI._ACTIONS.DRIVE_TO_TILE ||
                actions[i].type === TACTICS_ACTION_DRIVE_INPUT) {
                return true;
            }
        }
        return false;
    }

    function actionsAreTurnOnly(actions) {
        if (!actions || actions.length === 0) return false;
        var i, hasTurn = false;
        for (i = 0; i < actions.length; i++) {
            if (actions[i].type === AI._ACTIONS.DRIVE_TO_POSITION ||
                actions[i].type === AI._ACTIONS.DRIVE_TO_TILE ||
                actions[i].type === TACTICS_ACTION_DRIVE_INPUT) {
                return false;
            }
            if (actions[i].type === AI._ACTIONS.TURN_TO) hasTurn = true;
        }
        return hasTurn;
    }

    function findBestDodgeInput(self, tank, dodgeInfo, cfg) {
        var threats = collectProjectileThreats(self, cfg);
        if (threats.length === 0) {
            var path = self.projectilePaths[dodgeInfo.closestId];
            if (!path || path.length < 2) return null;
            var projectiles = self.gameController.getProjectiles();
            var projectile = projectiles[dodgeInfo.closestId];
            if (!projectile || !projectile.getB2DBody) return null;
            var bulletSpeed = projectile.getB2DBody().GetLinearVelocity().Length();
            if (bulletSpeed <= 0) return null;
            threats = [{
                path: path,
                speed: bulletSpeed,
                dodgeInfo: dodgeInfo
            }];
        }

        var world = self.gameController.getB2DWorld();
        var closestT = dodgeInfo.closestTime;
        var maxSim = Math.min(
            cfg.dodgeSimMaxTime !== undefined ? cfg.dodgeSimMaxTime : 1.6,
            closestT + 0.55
        );
        maxSim = Math.max(maxSim, 0.45);

        var lastCombo = self._aiTacticsLastDodgeCombo;
        var pick = pickBestSpacetimeCandidate(tank, threats, world, cfg, maxSim, function(combo, ev) {
            var penalty = 0;
            if (lastCombo && combosMatch(combo, lastCombo) && ev.minBodyMargin < 0.05) {
                penalty -= cfg.dodgeRepeatPenalty !== undefined ? cfg.dodgeRepeatPenalty : 1.5;
            }
            return penalty;
        });

        if (!pick || pick.eval.minBodyMargin < (cfg.dodgeMinMargin !== undefined ? cfg.dodgeMinMargin : -0.12)) {
            return null;
        }

        return {
            combo: pick.combo,
            score: pick.eval.score,
            displacement: pick.eval.displacement
        };
    }

    function shouldUseComboDodge(self, tank, dodgeInfo, actions, cfg) {
        if (cfg.comboDodge === false) return false;

        var urgent = dodgeInfo.closestTime < (cfg.dodgeUrgentTime || 1.6) &&
            dodgeInfo.closestDistance < (cfg.dodgeUrgentDistance || 12);
        var narrow = isNarrowSpace(self, tank, cfg);
        var stuck = self.stuckNow || self.stuckTime > 25;
        var turnOnly = actionsAreTurnOnly(actions);
        var noDrive = !actionsHaveDrive(actions);

        if (narrow && (urgent || noDrive || turnOnly)) return true;
        if (stuck && urgent) return true;
        if (urgent && turnOnly) return true;
        if (urgent && noDrive) return true;

        if (urgent && cfg.dodgeWallEscape !== false) {
            var escape = pickWallEscapeDrive(self, tank, dodgeInfo);
            if (!escape) return true;
        }
        return false;
    }

    function applyComboDodgeActions(self, tank, dodgeInfo, cfg) {
        var best = findBestDodgeInput(self, tank, dodgeInfo, cfg);
        if (!best) return false;

        var safe = getDodgeSafeClearance(cfg);
        if (best.score < safe * 0.45 && !isNarrowSpace(self, tank, cfg)) {
            return false;
        }

        var c = best.combo;
        var duration = cfg.dodgeInputDuration !== undefined ? cfg.dodgeInputDuration : 280;
        self.actions = [{
            type: TACTICS_ACTION_DRIVE_INPUT,
            forward: c.forward,
            back: c.back,
            left: c.left,
            right: c.right,
            duration: duration
        }];
        self._aiTacticsPendingDodgeCombo = c;
        self._aiTacticsPendingDodgeDisplacement = best.displacement || 0;
        return true;
    }

    function applyForcedEvadeDrive(self, tank, dodgeInfo, cfg) {
        var cd = dodgeInfo.closestDirection;
        var dlen = Math.sqrt(cd.x * cd.x + cd.y * cd.y) || 1;
        var tx = -cd.y / dlen;
        var ty = cd.x / dlen;
        var tankPos = { x: tank.getX(), y: tank.getY() };
        var world = self.gameController.getB2DWorld();
        var dist = Constants.AI.AMOUNT_TO_DODGE * 1.4;
        var plusOpen = !B2DUtils.checkLineForMazeCollision(
            world, tankPos, { x: tankPos.x + tx * dist, y: tankPos.y + ty * dist }
        );
        var minusOpen = !B2DUtils.checkLineForMazeCollision(
            world, tankPos, { x: tankPos.x - tx * dist, y: tankPos.y - ty * dist }
        );
        var usePlus = plusOpen && (!minusOpen || tx >= 0);

        self.actions = [{
            type: TACTICS_ACTION_DRIVE_INPUT,
            forward: true,
            back: minusOpen && !plusOpen,
            left: usePlus ? (tx < 0) : (tx > 0),
            right: usePlus ? (tx > 0) : (tx < 0),
            duration: cfg.dodgeInputDuration !== undefined ? cfg.dodgeInputDuration : 280
        }];
        self._aiTacticsPendingDodgeCombo = {
            forward: self.actions[0].forward,
            back: self.actions[0].back,
            left: self.actions[0].left,
            right: self.actions[0].right
        };
        return true;
    }

    function applyDynamicDodge(self, tank, dodgeInfo, cfg) {
        if (applyComboDodgeActions(self, tank, dodgeInfo, cfg)) {
            return true;
        }

        var escape = pickWallEscapeDrive(self, tank, dodgeInfo);
        if (escape) {
            self.actions = [{
                type: AI._ACTIONS.DRIVE_TO_POSITION,
                position: { x: escape.x, y: escape.y },
                canReverse: true,
                imprecision: dexterityImprecision(self) * 0.12
            }];
            self._aiTacticsPendingDodgeCombo = null;
            return true;
        }

        return applyForcedEvadeDrive(self, tank, dodgeInfo, cfg);
    }

    function refreshDodgeInfo(self, dodgeInfo, cfg) {
        if (!dodgeInfo || !dodgeInfo.closestId || typeof AIUtils === 'undefined') {
            return dodgeInfo;
        }
        var tank = self.gameController.getTank(self.aiId);
        var path = self.projectilePaths[dodgeInfo.closestId];
        var projectiles = self.gameController.getProjectiles();
        var projectile = projectiles[dodgeInfo.closestId];
        if (!tank || !path || !projectile) return dodgeInfo;

        var boldness = parseFloat(self.config[AI._TRAITS.BOLDNESS]) || 0.5;
        var scary = MathUtils.linearInterpolation(
            Constants.AI.MAX_SCARY_PROJECTILE_DISTANCE,
            Constants.AI.MIN_SCARY_PROJECTILE_DISTANCE,
            boldness
        );
        return AIUtils.checkProjectilePathForDodging(
            tank, path, projectile, self.gameController.getB2DWorld(), scary * scary
        );
    }

    function stripTurnOnlyDodgeActions(self, tank, dodgeInfo, cfg) {
        if (actionsAreTurnOnly(self.actions)) {
            if (tank && dodgeInfo) {
                applyForcedEvadeDrive(self, tank, dodgeInfo, cfg);
            }
            return;
        }
        if (!self.actions || self.actions.length === 0 || !actionsHaveDrive(self.actions)) {
            return;
        }
        var kept = [];
        var i;
        for (i = 0; i < self.actions.length; i++) {
            if (self.actions[i].type !== AI._ACTIONS.TURN_TO) {
                kept.push(self.actions[i]);
            }
        }
        self.actions = kept;
    }

    function pickWallEscapeDrive(self, tank, dodgeInfo) {
        var world = self.gameController.getB2DWorld();
        var tankPos = { x: tank.getX(), y: tank.getY() };
        var cd = dodgeInfo.closestDirection;
        var dlen = Math.sqrt(cd.x * cd.x + cd.y * cd.y) || 1;
        var nx = cd.x / dlen;
        var ny = cd.y / dlen;
        var tx = -ny;
        var ty = nx;
        var dist = Constants.AI.AMOUNT_TO_DODGE * 1.6;
        var opts = [
            { x: tankPos.x + tx * dist, y: tankPos.y + ty * dist, score: 2 },
            { x: tankPos.x - tx * dist, y: tankPos.y - ty * dist, score: 2 },
            { x: tankPos.x - nx * dist, y: tankPos.y - ny * dist, score: 3 },
            { x: tankPos.x + nx * dist * 0.5, y: tankPos.y + ny * dist * 0.5, score: 0 }
        ];
        var i, best = null;
        for (i = 0; i < opts.length; i++) {
            if (B2DUtils.checkLineForMazeCollision(world, tankPos, opts[i])) continue;
            if (!best || opts[i].score > best.score) best = opts[i];
        }
        return best;
    }

    function applyDodgeCandidate(self, pick, cfg) {
        if (!pick || !pick.combo) return false;
        var duration = cfg.dodgeInputDuration !== undefined ? cfg.dodgeInputDuration : 400;
        var c = constantInputFromCombo(pick.combo);
        self.actions = [{
            type: TACTICS_ACTION_DRIVE_INPUT,
            forward: c.forward,
            back: c.back,
            left: c.left,
            right: c.right,
            duration: duration
        }];
        self._aiTacticsActiveDodgeCombo = c;
        self._aiTacticsPendingDodgeCombo = c;
        self._aiTacticsPendingDodgeDisplacement = pick.eval ? pick.eval.displacement : 0;
        bumpDodgeStat('apply', { aiId: self.aiId, combo: c, duration: duration });
        return true;
    }

    function planTemporalSafeDodge(self, tank, dodgeInfo, cfg) {
        var threats = collectProjectileThreats(self, cfg);
        if (threats.length === 0) return false;

        var world = self.gameController.getB2DWorld();
        var built = buildDodgePlanCandidates(tank, threats, world, cfg, self);
        built.threats = threats;
        if (built.candidates.length === 0) return false;

        var pick = selectDodgePickFromCandidates(
            built.candidates, cfg, tank, threats, built.lastCombo
        );
        if (pick) {
            pick = normalizePickForConstantExecution(pick, tank, threats, world, cfg, built.maxSim);
            self._aiTacticsLastPlanMinMargin = pick.eval.minBodyMargin;
            self._aiTacticsLastPlanSurvives = pick.eval.survives;
            bumpDodgeStat('plan', {
                aiId: self.aiId,
                minMargin: pick.eval.minBodyMargin,
                survives: pick.eval.survives,
                combo: pick.combo,
                score: pick.eval.score
            });
            dodgeDebugLog('plan', self.aiId, pick.combo, pick.eval);
        }
        updateExecutedDodgeViz(self, tank, pick, built, cfg);
        captureDodgeVizSnapshot(self, tank, threats, built.candidates, pick, built.maxSim, {
            phase: 'planTemporalSafeDodge',
            survivorCount: built.candidates.filter(function(c) { return c.eval.survives; }).length,
            candidateCount: built.candidates.length,
            targets: built.targets,
            cfg: cfg
        });
        return applyDodgeCandidate(self, pick, cfg);
    }

    function stripTurnActionsFromDodge(self) {
        if (!self.actions || self.actions.length === 0) return;
        var kept = [];
        var i;
        for (i = 0; i < self.actions.length; i++) {
            if (self.actions[i].type !== AI._ACTIONS.TURN_TO) {
                kept.push(self.actions[i]);
            }
        }
        self.actions = kept;
    }

    function computeInstantDodgeCombo(tank, dodgeInfo, threats, cfg, world) {
        var closestT = dodgeInfo ? dodgeInfo.closestTime : 1.0;
        var maxSim = Math.min(
            cfg.dodgeSimMaxTime !== undefined ? cfg.dodgeSimMaxTime : 1.6,
            closestT + 0.55
        );
        maxSim = Math.max(maxSim, 0.45);

        if (!threats || threats.length === 0) {
            return { forward: true, back: false, left: true, right: false };
        }

        var pick = pickBestSpacetimeCandidate(tank, threats, world, cfg, maxSim, null);
        if (pick && pick.combo) {
            if (dodgeNeedsDisplacement(tank, threats, cfg) && !comboHasMovement(pick.combo)) {
                var built = buildDodgePlanCandidates(tank, threats, world, cfg, null);
                var alt = selectDodgePickFromCandidates(
                    built.candidates, cfg, tank, threats, null
                );
                if (alt && alt.combo) return constantInputFromCombo(alt.combo);
            }
            return constantInputFromCombo(pick.combo);
        }
        return { forward: true, back: false, left: true, right: false };
    }

    function executeDodgeActions(self, cfg) {
        if (shouldKeepDodgePlan(self, cfg)) {
            refreshExecutedDodgeVizFromActive(self, cfg);
            dodgeDebugLog('keep plan', self.aiId, self._aiTacticsActiveDodgeCombo);
            return true;
        }

        var tank = self.gameController.getTank(self.aiId);
        if (!tank || !self.goal.dodgeInfo) return false;

        var dodgeInfo = refreshDodgeInfo(self, self.goal.dodgeInfo, cfg);
        self.goal.dodgeInfo = dodgeInfo;
        self.goal.period = 0;

        var threats = collectProjectileThreats(self, cfg);
        var world = self.gameController.getB2DWorld();
        var planned = planTemporalSafeDodge(self, tank, dodgeInfo, cfg);
        if (!planned) {
            var combo = computeInstantDodgeCombo(tank, dodgeInfo, threats, cfg, world);
            applyDodgeCandidate(self, { combo: combo, eval: { displacement: 0 } }, cfg);
        }
        stripTurnActionsFromDodge(self);
        if (self.actions.length === 0) {
            applyForcedEvadeDrive(self, tank, dodgeInfo, cfg);
            self._aiTacticsActiveDodgeCombo = self._aiTacticsPendingDodgeCombo;
        }

        bumpDodgeStat('exec', {
            aiId: self.aiId,
            at: Date.now(),
            threats: threats.length,
            planned: planned,
            combo: self._aiTacticsActiveDodgeCombo,
            minMargin: self._aiTacticsLastPlanMinMargin,
            survives: self._aiTacticsLastPlanSurvives,
            action: self.actions[0] || null
        });
        if (self._aiTacticsVizSnapshot) {
            self._aiTacticsVizSnapshot.action = self.actions[0] ? {
                type: self.actions[0].type,
                forward: self.actions[0].forward,
                back: self.actions[0].back,
                left: self.actions[0].left,
                right: self.actions[0].right,
                duration: self.actions[0].duration
            } : null;
            self._aiTacticsVizSnapshot.meta.executedAt = Date.now();
            self._aiTacticsVizSnapshot.meta.planned = planned;
        }
        dodgeDebugLog('execute', self.aiId, {
            threats: threats.length,
            planned: planned,
            combo: self._aiTacticsActiveDodgeCombo,
            minMargin: self._aiTacticsLastPlanMinMargin,
            action: self.actions[0]
        });
        return self.actions.length > 0;
    }

    function stripInvalidFire(self, cfg) {
        if (!cfg.fireOnlyOnHit || self.goal.type !== AI._GOALS.SHOOT_AFTER) return;

        var i, hasFire = false;
        for (i = 0; i < self.actions.length; i++) {
            if (self.actions[i].type === AI._ACTIONS.FIRE) {
                hasFire = true;
                break;
            }
        }
        if (!hasFire) return;

        if (self._aiTacticsInterceptShot || self._aiTacticsLeadShot) return;
        if (findInterceptShot(self, self.goal.target, cfg)) return;
        if (hasConfirmedHit(self, self.goal.target, cfg.fireScanPaths)) return;

        var kept = [];
        for (i = 0; i < self.actions.length; i++) {
            if (self.actions[i].type !== AI._ACTIONS.FIRE) {
                kept.push(self.actions[i]);
            }
        }
        self.actions = kept;

        if (cfg.shootFailHuntBoost !== false && actionsAreNonCombat(self.actions, self.goal) &&
            self.goal.type !== AI._GOALS.DODGE_PROJECTILE) {
            var enemy = findClosestEnemy(self);
            if (enemy) {
                forceEngageEnemy(self, enemy, cfg, computeHuntPriority(enemy, cfg), getHuntPeriod(self, enemy, cfg));
                applyHuntActionsToward(self, getPreferredHuntTile(self, enemy, cfg));
            }
        }
    }

    function shouldAllowImmediateReplan(self, cfg) {
        if (cfg.immediateActionReplan === false) return false;
        if (self.goal && self.goal.type === AI._GOALS.DODGE_PROJECTILE) return true;
        if (self._aiTacticsPostShotLock > 0) return false;
        if (cfg.respectShootGoalPeriod !== false &&
            self.goal && self.goal.type === AI._GOALS.SHOOT_AFTER &&
            self.goal.period > 0) {
            return false;
        }
        return true;
    }

    function clearGoalPeriodLock(self, cfg) {
        // cfg 可能为 null（getCfg 失败时），此时应清掉 period（不阻断行为）
        if (self.goal && cfg && cfg.respectShootGoalPeriod !== false &&
            self.goal.type === AI._GOALS.SHOOT_AFTER) {
            return;
        }
        if (self.goal) {
            self.goal.period = 0;
        }
    }

    function shouldRefreshActions(self, goalChanged, cfg) {
        if (self.goal && self.goal.type === AI._GOALS.DODGE_PROJECTILE) {
            if (shouldKeepDodgePlan(self, cfg)) return false;
            return true;
        }
        if (goalChanged) return true;
        if (!self.actions || self.actions.length === 0) {
            if (self._aiTacticsPostShotLock > 0) return true;
            if (cfg && cfg.respectShootGoalPeriod !== false &&
                self.goal && self.goal.type === AI._GOALS.SHOOT_AFTER &&
                self.goal.period > 0) {
                return false;
            }
            return true;
        }
        return false;
    }

    function install() {
        bumpDodgeStat('install');
        if (typeof AI === 'undefined' || !AI.methods) {
            dodgeDebugLog('install skipped: AI not ready');
            return false;
        }
        if (tacticsIsInstalled()) {
            return true;
        }

        // 重装保护：若上次 install 失败留下了半成品 orig，先安全回滚
        if (AI._tacticsOrig) {
            try {
                if (AI._tacticsOrig.update) AI.methods.update = AI._tacticsOrig.update;
                if (AI._tacticsOrig.updateState) AI.methods._updateState = AI._tacticsOrig.updateState;
                if (AI._tacticsOrig.decide) AI.methods._makeDecisionsAndUpdateGoal = AI._tacticsOrig.decide;
                if (AI._tacticsOrig.actions) AI.methods._updateActionsToAchieveGoal = AI._tacticsOrig.actions;
                if (AI._tacticsOrig.input) AI.methods._updateInputToDoAction = AI._tacticsOrig.input;
                if (AI._tacticsOrig.removeActions) AI.methods._updateAndRemovePerformedActions = AI._tacticsOrig.removeActions;
                if (AI.methods.update) AI.methods.update[TACTICS_MARKER] = false;
                AI._tacticsVersion = null;
            } catch (rollbackErr) {
                console.error('[AI Tactics] rollback 失败:', rollbackErr);
            }
            AI._tacticsOrig = null;
        }

        AI._tacticsOrig = {
            update: AI.methods.update,
            updateState: AI.methods._updateState,
            decide: AI.methods._makeDecisionsAndUpdateGoal,
            actions: AI.methods._updateActionsToAchieveGoal,
            input: AI.methods._updateInputToDoAction,
            removeActions: AI.methods._updateAndRemovePerformedActions
        };

        // 整个 patching 流程加 try/catch，失败时回滚到原版（清空 _tacticsOrig，
        // 下次 install 重新捕获原版），避免半成品状态卡死。
        try {

        var origInput = AI._tacticsOrig.input;
        AI.methods._updateInputToDoAction = function() {
            if (this.actions.length > 0 && this.actions[0].type === TACTICS_ACTION_DRIVE_INPUT) {
                var driveAction = this.actions[0];
                if (typeof InputState !== 'undefined') {
                    this.inputState = InputState.withState(
                        this.aiId,
                        !!driveAction.forward,
                        !!driveAction.back,
                        !!driveAction.left,
                        !!driveAction.right,
                        false
                    );
                }
                return;
            }
            origInput.call(this);
        };

        var origRemoveActions = AI._tacticsOrig.removeActions;
        AI.methods._updateAndRemovePerformedActions = function(deltaTime) {
            if (this.actions.length > 0 && this.actions[0].type === TACTICS_ACTION_DRIVE_INPUT) {
                var dodgeAction = this.actions[0];
                var tankBefore = this.gameController.getTank(this.aiId);
                var bx = tankBefore ? tankBefore.getX() : 0;
                var by = tankBefore ? tankBefore.getY() : 0;
                dodgeAction.duration -= deltaTime;
                if (dodgeAction.duration <= 0) {
                    this.actions.shift();
                    if (this._aiTacticsPendingDodgeCombo) {
                        this._aiTacticsLastDodgeCombo = this._aiTacticsPendingDodgeCombo;
                        this._aiTacticsPendingDodgeCombo = null;
                    }
                    var tankAfter = this.gameController.getTank(this.aiId);
                    if (tankAfter) {
                        this._aiTacticsLastDodgeDisplacement = Math.abs(tankAfter.getX() - bx) +
                            Math.abs(tankAfter.getY() - by);
                    }
                }
                return;
            }
            var hadFire = this.actions.length > 0 && this.actions[0].type === AI._ACTIONS.FIRE;
            if (hadFire) {
                this._aiTacticsLastFireAt = Date.now();
            }
            var pendingShot = hadFire ? this._aiTacticsPendingShot : null;
            var hadActions = this.actions.length > 0;
            origRemoveActions.call(this, deltaTime);
            if (hadActions && this.actions.length === 0) {
                var cfgDone = getCfg();
                if (!cfgDone || cfgDone.respectShootGoalPeriod === false ||
                    !this.goal || this.goal.type !== AI._GOALS.SHOOT_AFTER) {
                    clearGoalPeriodLock(this, cfgDone);
                }
            }
            if (hadFire && pendingShot &&
                (this.actions.length === 0 || this.actions[0].type !== AI._ACTIONS.FIRE)) {
                var cfgFire = getCfg();
                if (cfgFire && cfgFire.enabled !== false) {
                    rememberRecentShot(this, pendingShot, cfgFire);
                    onShotCompleted(this, cfgFire);
                }
                this._aiTacticsPendingShot = null;
            }
        };

        var origUpdate = AI._tacticsOrig.update;
        AI.methods.update = function(deltaTime) {
            var cfg = getCfg();
            if (this._aiTacticsPostShotLock > 0) {
                this._aiTacticsPostShotLock -= deltaTime;
                if (this._aiTacticsPostShotLock < 0) {
                    this._aiTacticsPostShotLock = 0;
                }
            }

            if (shouldAllowImmediateReplan(this, cfg) && this.actions.length === 0) {
                clearGoalPeriodLock(this, cfg);
            }

            this._updateState(deltaTime);

            var changed = this._makeDecisionsAndUpdateGoal(deltaTime);
            if (shouldRefreshActions(this, changed, cfg)) {
                this._updateActionsToAchieveGoal();
            }

            this._updateInputToDoAction();

            var beforeRemove = this.actions.length;
            this._updateAndRemovePerformedActions(deltaTime);

            if (shouldAllowImmediateReplan(this, cfg) &&
                beforeRemove > 0 && this.actions.length === 0) {
                this._updateActionsToAchieveGoal();
                this._updateInputToDoAction();
            }
        };

        var origUpdateState = AI._tacticsOrig.updateState;
        AI.methods._updateState = function(deltaTime) {
            var tank = this.gameController.getTank(this.aiId);
            if (tank) {
                var x = tank.getX();
                var y = tank.getY();
                if (this._aiTacticsLastX !== undefined && deltaTime > 0) {
                    var dt = deltaTime / 1000;
                    if (dt > 0) {
                        this._aiTacticsVelX = (x - this._aiTacticsLastX) / dt;
                        this._aiTacticsVelY = (y - this._aiTacticsLastY) / dt;
                    }
                }
                this._aiTacticsLastX = x;
                this._aiTacticsLastY = y;
            }
            origUpdateState.call(this, deltaTime);
            var cfgState = getCfg();
            if (cfgState && cfgState.enabled !== false) {
                runParallelCognition(this, cfgState);
            }
        };

        var origDecide = AI._tacticsOrig.decide;
        AI.methods._makeDecisionsAndUpdateGoal = function(deltaTime) {
            var cfg = getCfg();
            if (cfg && cfg.enabled !== false) {
                ensureIncomingDodgeGoal(this, cfg);
                if (trackStallAndBreak(this, deltaTime, cfg)) {
                    return true;
                }
                preDecisionAntiStall(this, cfg);
            }

            var changed = origDecide.call(this, deltaTime);
            if (!cfg || cfg.enabled === false) return changed;

            if (ensureIncomingDodgeGoal(this, cfg)) {
                return true;
            }
            if (this.goal && this.goal.type === AI._GOALS.DODGE_PROJECTILE) {
                return true;
            }

            if (promoteShootGoalIfReady(this, cfg)) {
                return true;
            }

            if (postDecisionEngage(this, cfg)) {
                return true;
            }

            if (this.actions.length === 0) {
                return true;
            }

            var maze = this.gameController.getMaze();
            if (!maze || !this.myPosition) return changed;

            var enemy = findClosestEnemy(this);
            if (!enemy) return changed;

            var period = getHuntPeriod(this, enemy, cfg);
            var huntDist = cfg.huntMinTileDistance !== undefined ? cfg.huntMinTileDistance : 3;

            if (this.goal.type === AI._GOALS.HUNT && cfg.tacticalShoot !== false) {
                if (tryTacticalShootGoal(this, enemy, cfg)) {
                    return true;
                }
            }

            if (this.goal.type === AI._GOALS.SHOOT_AFTER) {
                var cogShoot = this._aiTacticsCognition && this._aiTacticsCognition.shootPlan;
                if (cogShoot && cogShoot.worthShooting && cogShoot.allowed) {
                    return changed;
                }
                if (needsStanceReposition(this, cfg)) {
                    return changed;
                }

                var target = this.gameController.getTank(this.goal.target);
                if (!target) return changed;

                if (cfg.shotDrivenStance !== false) {
                    return changed;
                }

                var targetTile = tileOf(target);
                var dist = maze.getDistanceBetweenPositions(this.myPosition, targetTile);
                var tank = this.gameController.getTank(this.aiId);
                var blocked = typeof B2DUtils !== 'undefined' && tank && B2DUtils.checkLineForMazeCollision(
                    this.gameController.getB2DWorld(),
                    { x: tank.getX(), y: tank.getY() },
                    { x: target.getX(), y: target.getY() }
                );
                if ((dist !== false && dist > huntDist) || blocked ||
                    !cogShoot || !cogShoot.worthShooting) {
                    forceEngageEnemy(this, enemy, cfg, Math.max(this.goal.priority || 0, 0.55), period);
                    return true;
                }
            }
            return changed;
        };

        var origActions = AI._tacticsOrig.actions;
        AI.methods._updateActionsToAchieveGoal = function() {
            var cfg = getCfg();
            if (!cfg || cfg.enabled === false) return;

            if (cfg.smartDodge !== false) {
                ensureIncomingDodgeGoal(this, cfg);
            }

            if (this.goal && this.goal.type === AI._GOALS.DODGE_PROJECTILE &&
                cfg.smartDodge !== false) {
                if (!this.goal.dodgeInfo) {
                    var urgentThreat = findMostUrgentThreat(
                        this, this.gameController.getTank(this.aiId), cfg
                    );
                    if (urgentThreat) {
                        this.goal.dodgeInfo = urgentThreat.dodgeInfo;
                    }
                }
            }

            if (this.goal && this.goal.type === AI._GOALS.DODGE_PROJECTILE &&
                cfg.smartDodge !== false && this.goal.dodgeInfo) {
                this._aiTacticsLeadShot = false;
                this._aiTacticsInterceptShot = false;
                if (!shouldKeepDodgePlan(this, cfg)) {
                    this.actions = [];
                }
                executeDodgeActions(this, cfg);
                if (this.actions.length === 0 && hasActiveDodgeThreat(this, cfg)) {
                    executeDodgeActions(this, cfg);
                }
                return;
            }

            this._aiTacticsExecutedDodgeViz = null;
            this._aiTacticsLeadShot = false;
            this._aiTacticsInterceptShot = false;

            var skipVanillaDodge = cfg.smartDodge !== false &&
                this.goal.type === AI._GOALS.DODGE_PROJECTILE;
            var tacticsShoot = usesTacticsShoot(cfg) &&
                this.goal && this.goal.type === AI._GOALS.SHOOT_AFTER;

            if (tacticsShoot) {
                this.actions = [];
            } else if (skipVanillaDodge) {
                if (!this.goal.dodgeInfo) {
                    var dodgeTank = this.gameController.getTank(this.aiId);
                    var dodgeUrgent = findMostUrgentThreat(this, dodgeTank, cfg);
                    if (dodgeUrgent) this.goal.dodgeInfo = dodgeUrgent.dodgeInfo;
                }
                if (this.goal.dodgeInfo) {
                    if (!shouldKeepDodgePlan(this, cfg)) {
                        this.actions = [];
                    }
                    executeDodgeActions(this, cfg);
                    return;
                }
                if (!shouldKeepDodgePlan(this, cfg)) {
                    this.actions = [];
                }
            } else {
                AI._tacticsOrig.actions.call(this);
                if (tacticsShoot) {
                    stripVanillaShootActions(this);
                }
            }

            if (this._aiTacticsPostShotLock > 0 && applyPostShotReposition(this, cfg)) {
                return;
            }

            if (replaceIdleWanderWithHunt(this, cfg)) {
                return;
            }

            if (needsStanceReposition(this, cfg) && applyShotStanceMovement(this, cfg)) {
                return;
            }

            if (cfg.interceptShoot !== false || cfg.leadTarget) {
                applyInterceptAiming(this, cfg);
            }
            stripInvalidFire(this, cfg);

            if (this.goal.type === AI._GOALS.HUNT && this.actions.length === 0 &&
                !needsStanceReposition(this, cfg)) {
                var huntEnemy = findClosestEnemy(this);
                if (huntEnemy) {
                    applyHuntActionsToward(this, getPreferredHuntTile(this, huntEnemy, cfg));
                }
            }

            if (this.actions.length === 0 && cfg.emptyActionFallback !== false) {
                if (hasActiveDodgeThreat(this, cfg)) {
                    ensureIncomingDodgeGoal(this, cfg);
                    executeDodgeActions(this, cfg);
                } else if (this.goal.type === AI._GOALS.IDLE) {
                    replaceIdleWanderWithHunt(this, cfg);
                }
            }
        };

        AI.methods.update[TACTICS_MARKER] = true;
        AI._tacticsVersion = TACTICS_VERSION;
        var verify = verifyInstallDetail();
        console.log('[AI Tactics] v' + TACTICS_VERSION + ' installed (spacetime safe-zone trajectory search)');
        if (!verify.ok) {
            console.warn('[AI Tactics] 安装自检失败:', verify.issues);
        } else if (isDodgeDebugEnabled()) {
            console.log('[AI Tactics] 安装自检通过', verify);
        }
        return true;

        } catch (patchErr) {
            console.error('[AI Tactics] patching 中途失败, 已回滚:', patchErr);
            try {
                if (AI._tacticsOrig) {
                    if (AI._tacticsOrig.update) AI.methods.update = AI._tacticsOrig.update;
                    if (AI._tacticsOrig.updateState) AI.methods._updateState = AI._tacticsOrig.updateState;
                    if (AI._tacticsOrig.decide) AI.methods._makeDecisionsAndUpdateGoal = AI._tacticsOrig.decide;
                    if (AI._tacticsOrig.actions) AI.methods._updateActionsToAchieveGoal = AI._tacticsOrig.actions;
                    if (AI._tacticsOrig.input) AI.methods._updateInputToDoAction = AI._tacticsOrig.input;
                    if (AI._tacticsOrig.removeActions) AI.methods._updateAndRemovePerformedActions = AI._tacticsOrig.removeActions;
                    if (AI.methods.update) AI.methods.update[TACTICS_MARKER] = false;
                    AI._tacticsVersion = null;
                    AI._tacticsOrig = null;
                }
            } catch (rollbackErr) {
                console.error('[AI Tactics] 回滚也失败:', rollbackErr);
            }
            return false;
        }
    }

    function verifyInstallDetail() {
        var issues = [];
        var info = {
            version: TACTICS_VERSION,
            marker: TACTICS_MARKER,
            aiDefined: typeof AI !== 'undefined',
            installed: tacticsIsInstalled(),
            storedVersion: typeof AI !== 'undefined' ? AI._tacticsVersion : null,
            configLoaded: typeof TankTroubleAIStrength !== 'undefined',
            preset: typeof TankTroubleAIStrengthConfig !== 'undefined'
                ? TankTroubleAIStrengthConfig.activePreset : null,
            behavior: null,
            dodgeDebug: isDodgeDebugEnabled()
        };

        if (typeof TankTroubleAIStrength !== 'undefined') {
            var resolved = TankTroubleAIStrength.resolve();
            info.behavior = resolved && resolved.behavior ? {
                smartDodge: resolved.behavior.smartDodge,
                temporalDodge: resolved.behavior.temporalDodge,
                enabled: resolved.behavior.enabled
            } : null;
        }

        if (!info.aiDefined) issues.push('AI 类未加载（补丁安装过早或被覆盖）');
        if (info.aiDefined && !info.installed) {
            issues.push('战术补丁未安装或版本不匹配（期望 v' + TACTICS_VERSION +
                '，当前 ' + (info.storedVersion || '无') + '）');
        }
        if (info.aiDefined && AI._tacticsOrig &&
            AI.methods._updateActionsToAchieveGoal === AI._tacticsOrig.actions) {
            issues.push('_updateActionsToAchieveGoal 仍是原版，躲弹钩子未生效');
        }
        if (info.aiDefined && AI.methods && AI.methods._updateActionsToAchieveGoal) {
            var fnStr = String(AI.methods._updateActionsToAchieveGoal);
            if (fnStr.indexOf('executeDodgeActions') < 0) {
                issues.push('actions 更新链中找不到 executeDodgeActions');
            }
        }
        if (info.behavior && info.behavior.smartDodge === false) {
            issues.push('smartDodge 已关闭，时空躲弹不会运行');
        }

        info.issues = issues;
        info.ok = issues.length === 0;
        return info;
    }

    var FIXED_DODGE_SCENARIOS = {
        lateral_pass: {
            desc: '子弹从侧方 2.0m 掠过（应在盲区内可不动躲过）',
            tankX: 10, tankY: 10, tankRot: 0, missY: 2.0, pathLen: 16
        },
        head_on: {
            desc: '子弹直击中心，必须移动才能存活',
            tankX: 10, tankY: 10, tankRot: 0, missY: 0, pathLen: 16
        },
        obb_graze: {
            desc: '侧向 1.55m 擦车体 OBB 边缘',
            tankX: 10, tankY: 10, tankRot: 0, missY: 1.55, pathLen: 16
        }
    };

    function makeMockTank(options) {
        var x = options.tankX;
        var y = options.tankY;
        var rot = options.tankRot || 0;
        return {
            getX: function() { return x; },
            getY: function() { return y; },
            getRotation: function() { return rot; }
        };
    }

    function buildSyntheticThreat(tank, options) {
        var tx = tank.getX();
        var ty = tank.getY();
        var missY = options.missY || 0;
        var half = (options.pathLen || 16) * 0.5;
        var speed = (typeof Constants !== 'undefined' && Constants.BULLET)
            ? Constants.BULLET.SPEED.m : 14;
        var path = [
            { x: tx - half, y: ty + missY },
            { x: tx + half, y: ty + missY }
        ];
        var closestPos = { x: tx, y: ty + missY };
        var dx = tx - closestPos.x;
        var dy = ty - closestPos.y;
        var closestDistance = Math.sqrt(dx * dx + dy * dy);
        var dodgeInfo = {
            closestId: options.id || 'debug_bullet',
            closestTime: half / speed,
            closestDistance: closestDistance,
            closestPosition: closestPos,
            closestDirection: { x: 0, y: missY >= 0 ? 1 : -1 }
        };
        return {
            id: dodgeInfo.closestId,
            path: path,
            speed: speed,
            dodgeInfo: dodgeInfo
        };
    }

    function comboLabel(combo) {
        if (!combo) return 'none';
        var parts = [];
        if (combo.forward) parts.push('F');
        if (combo.back) parts.push('B');
        if (combo.left) parts.push('L');
        if (combo.right) parts.push('R');
        return parts.join('+') || 'none';
    }

    function sampleMarginFieldAtTime(tank, threats, cfg, time, options) {
        options = options || {};
        var step = options.step !== undefined ? options.step : 0.45;
        var range = options.range !== undefined ? options.range : 5.5;
        var rot = options.rot !== undefined ? options.rot : tank.getRotation();
        var cx = tank.getX();
        var cy = tank.getY();
        var points = [];
        var dx, dy, wx, wy, margin;
        for (dx = -range; dx <= range + 0.001; dx += step) {
            for (dy = -range; dy <= range + 0.001; dy += step) {
                wx = cx + dx;
                wy = cy + dy;
                margin = bodyMarginAt(wx, wy, rot, time, threats, cfg);
                points.push({ x: wx, y: wy, margin: margin, safe: margin >= 0 });
            }
        }
        return points;
    }

    function buildThreatDangerZones(threats, cfg) {
        var reach = getTankReachExtent(cfg);
        var slack = cfg.dodgeBodySlack !== undefined ? cfg.dodgeBodySlack : 0.15;
        var dangerR = reach + getBulletBodyRadius() + slack;
        var zones = [];
        var i, th, times, ti, t, bp;
        for (i = 0; i < threats.length; i++) {
            th = threats[i];
            times = [
                Math.max(0, th.dodgeInfo.closestTime - 0.12),
                th.dodgeInfo.closestTime,
                th.dodgeInfo.closestTime + 0.12
            ];
            for (ti = 0; ti < times.length; ti++) {
                t = times[ti];
                bp = positionOnProjectilePath(th.path, th.speed, t);
                if (!bp) continue;
                zones.push({
                    threatId: th.id,
                    time: t,
                    x: bp.x,
                    y: bp.y,
                    radius: dangerR,
                    critical: ti === 1
                });
            }
        }
        return zones;
    }

    function getMazeBoundsMeters(gameController) {
        var maze = gameController && gameController.getMaze
            ? gameController.getMaze() : null;
        if (!maze || !maze.getWidth || !maze.getHeight) return null;
        var ts = Constants.MAZE_TILE_SIZE.m;
        return {
            x0: 0,
            y0: 0,
            x1: maze.getWidth() * ts,
            y1: maze.getHeight() * ts
        };
    }

    function minDistancePointToSegment(px, py, ax, ay, bx, by) {
        var dx = bx - ax;
        var dy = by - ay;
        var len2 = dx * dx + dy * dy;
        var u = len2 > 0.0001 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
        if (u < 0) u = 0;
        else if (u > 1) u = 1;
        var cx = ax + u * dx;
        var cy = ay + u * dy;
        dx = px - cx;
        dy = py - cy;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function minDistancePointToPath(px, py, path) {
        if (!path || path.length < 2) return Number.MAX_VALUE;
        var minD = Number.MAX_VALUE;
        var i, d;
        for (i = 0; i < path.length - 1; i++) {
            d = minDistancePointToSegment(
                px, py, path[i].x, path[i].y, path[i + 1].x, path[i + 1].y
            );
            if (d < minD) minD = d;
        }
        return minD;
    }

    function minBodyMarginOverHorizon(wx, wy, rot, threats, cfg, horizon, dt) {
        if (!threats || threats.length === 0) return 999;
        horizon = horizon !== undefined ? horizon : 2.0;
        dt = dt !== undefined ? dt : 0.05;
        var minM = Number.MAX_VALUE;
        var t, m;
        for (t = 0; t <= horizon + 0.0001; t += dt) {
            m = bodyMarginAt(wx, wy, rot, t, threats, cfg);
            if (m < minM) minM = m;
        }
        return minM;
    }

    var TWO_PI = Math.PI * 2;

    /** 与 OBB 包络一致的凸四边形（车体矩形 + 炮管前伸） */
    function getTankHeptagonLocal(cfg) {
        var e = getTankHullHalfExtents(cfg);
        var hw = e.halfW;
        var hf = e.halfForward;
        var hb = e.halfBack;
        return [
            { f: -hb, r: -hw },
            { f: -hb, r: hw },
            { f: hf, r: hw },
            { f: hf, r: -hw }
        ];
    }

    function localToWorldOffset(lf, lr, rot) {
        var s = Math.sin(rot);
        var c = Math.cos(rot);
        return { x: s * lf + c * lr, y: -c * lf + s * lr };
    }

    function heptagonWorldVertices(cx, cy, rot, localVerts) {
        var out = [];
        var i, o;
        for (i = 0; i < localVerts.length; i++) {
            o = localToWorldOffset(localVerts[i].f, localVerts[i].r, rot);
            out.push({ x: cx + o.x, y: cy + o.y });
        }
        return out;
    }

    function pointToConvexPolygonDist(px, py, verts) {
        var minD = Number.MAX_VALUE;
        var i, j, d;
        for (i = 0; i < verts.length; i++) {
            j = (i + 1) % verts.length;
            d = minDistancePointToSegment(px, py, verts[i].x, verts[i].y, verts[j].x, verts[j].y);
            if (d < minD) minD = d;
        }
        return minD;
    }

    function pointInConvexPolygon(px, py, verts) {
        var n = verts.length;
        var i, j, cp, sign = 0;
        for (i = 0; i < n; i++) {
            j = (i + 1) % n;
            cp = (verts[j].x - verts[i].x) * (py - verts[i].y) -
                (verts[j].y - verts[i].y) * (px - verts[i].x);
            if (Math.abs(cp) < 1e-9) continue;
            if (sign === 0) sign = cp > 0 ? 1 : -1;
            else if ((cp > 0 ? 1 : -1) !== sign) return false;
        }
        return true;
    }

    function marginHeptagonAtRotation(cx, cy, theta, bx, by, localVerts, cfg) {
        var verts = heptagonWorldVertices(cx, cy, theta, localVerts);
        var dist = pointToConvexPolygonDist(bx, by, verts);
        var slack = cfg.dodgeBodySlack !== undefined ? cfg.dodgeBodySlack : 0.15;
        var expand = getBulletBodyRadius() + slack;
        if (pointInConvexPolygon(bx, by, verts)) {
            return -dist - expand;
        }
        return dist - expand;
    }

    function combinedMarginAtRotation(cx, cy, theta, bullets, localVerts, cfg) {
        var minM = Number.MAX_VALUE;
        var i, m;
        for (i = 0; i < bullets.length; i++) {
            m = marginHeptagonAtRotation(
                cx, cy, theta, bullets[i].x, bullets[i].y, localVerts, cfg
            );
            if (m < minM) minM = m;
        }
        return minM;
    }

    function safetyRotationSampleCount(cfg) {
        return cfg.safetyRotationSamples !== undefined ? cfg.safetyRotationSamples : 12;
    }

    /** 离散朝向采样求 margin 包络（仅用于脚下单点分类，O(angles×bullets)） */
    function marginEnvelopeOverRotation(cx, cy, bullets, localVerts, cfg) {
        var count = safetyRotationSampleCount(cfg);
        var globalMin = Number.MAX_VALUE;
        var globalMax = -Number.MAX_VALUE;
        var i, m, theta;
        for (i = 0; i < count; i++) {
            theta = i * TWO_PI / count;
            m = combinedMarginAtRotation(cx, cy, theta, bullets, localVerts, cfg);
            if (m < globalMin) globalMin = m;
            if (m > globalMax) globalMax = m;
        }
        return { min: globalMin, max: globalMax };
    }

    /**
     * 双圆半径（以子弹为圆心）：
     * 红：半径 = 半宽 → 直径 = 车宽
     * 黄：半径 = 包络最大对角线/2 → 覆盖斜向碰弹假安全区
     */
    function getTankZoneRadii(localVerts, cfg) {
        cfg = cfg || getCfg();
        return {
            abs: getTankHalfWidth(),
            semi: getTankMaxDiagonal(cfg) * 0.5
        };
    }

    function dist2d(ax, ay, bx, by) {
        var dx = ax - bx;
        var dy = ay - by;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function pointInAnyAbsDisk(px, py, bullets, rAbs) {
        var i;
        for (i = 0; i < bullets.length; i++) {
            if (dist2d(px, py, bullets[i].x, bullets[i].y) <= rAbs + 1e-6) return true;
        }
        return false;
    }

    /** ∃弹 rAbs → 绝对；全在 rSemi 外 → 安全；否则 margin 包络。 */
    function classifyPointMultiBullet(px, py, bullets, localVerts, cfg, radii) {
        radii = radii || getTankZoneRadii(localVerts, cfg);
        if (!bullets || !bullets.length) return 0;
        if (pointInAnyAbsDisk(px, py, bullets, radii.abs)) return 2;

        var i, d, anySemi = false;
        for (i = 0; i < bullets.length; i++) {
            d = dist2d(px, py, bullets[i].x, bullets[i].y);
            if (d > radii.semi + 1e-6) continue;
            anySemi = true;
            break;
        }
        if (!anySemi) return 0;

        var env = marginEnvelopeOverRotation(px, py, bullets, localVerts, cfg);
        if (env.max < 0) return 2;
        if (env.min >= 0) return 0;
        return 1;
    }

    function buildCircleSafetyZones(bullets, localVerts, cfg) {
        var radii = getTankZoneRadii(localVerts, cfg);
        var circles = [];
        var i;
        for (i = 0; i < bullets.length; i++) {
            circles.push({
                x: bullets[i].x,
                y: bullets[i].y,
                rAbs: radii.abs,
                rSemi: radii.semi
            });
        }
        return { radii: radii, circles: circles };
    }

    function countSemiDiskHits(px, py, bullets, rSemi) {
        var n = 0;
        var i, d;
        for (i = 0; i < bullets.length; i++) {
            d = dist2d(px, py, bullets[i].x, bullets[i].y);
            if (d <= rSemi + 1e-6) n++;
        }
        return n;
    }

    /**
     * F8 可视化着色：完整黄/红圆盘 + 多黄升格
     * ∃红盘→2；无黄盘→0；≤2 层黄盘→1（整圆）；≥3 层黄盘→margin 包络
     */
    function classifySafetyZoneVisual(px, py, bullets, cfg) {
        cfg = cfg || getCfg();
        var localVerts = getTankHeptagonLocal(cfg);
        var radii = getTankZoneRadii(localVerts, cfg);
        if (pointInAnyAbsDisk(px, py, bullets, radii.abs)) return 2;
        var n = countSemiDiskHits(px, py, bullets, radii.semi);
        if (n === 0) return 0;
        if (n <= 2) return 1;
        return classifyPointMultiBullet(px, py, bullets, localVerts, cfg, radii);
    }

    /**
     * F8 脚下/单点分类（margin 包络，非整圆可视化）
     */
    function classifySafetyZoneLevel(px, py, bullets, cfg) {
        cfg = cfg || getCfg();
        var localVerts = getTankHeptagonLocal(cfg);
        return classifyPointMultiBullet(px, py, bullets, localVerts, cfg);
    }

    /**
     * 仅几何圆盘并集（无 margin 升格），调试用。
     */
    function classifySafetyDiskUnion(px, py, circles, radii) {
        if (!circles || !circles.length || !radii) return 0;
        var rAbs = radii.abs;
        var rSemi = radii.semi;
        var inSemi = false;
        var i, d;
        for (i = 0; i < circles.length; i++) {
            d = dist2d(px, py, circles[i].x, circles[i].y);
            if (d <= rAbs + 1e-6) return 2;
            if (d <= rSemi + 1e-6) inSemi = true;
        }
        return inSemi ? 1 : 0;
    }

    /** 本时刻全部在场子弹（不限 AIUtils 威胁过滤） */
    function collectInstantBulletPositions(ai, cfg) {
        var out = [];
        if (!ai || !ai.gameController) return out;
        var projectiles = ai.gameController.getProjectiles();
        if (!projectiles) return out;
        var pid, p, owner;
        for (pid in projectiles) {
            if (!projectiles.hasOwnProperty(pid)) continue;
            p = projectiles[pid];
            if (!p || !p.getX || !p.getY) continue;
            owner = p.getPlayerId ? p.getPlayerId() : (p.playerId || null);
            out.push({
                id: pid,
                x: p.getX(),
                y: p.getY(),
                playerId: owner
            });
        }
        return out;
    }

    /**
     * 单点三类（多弹 OR）：combined(θ)=min_i margin_i(θ)
     * 绝对危险 max<0；真安全 min≥0；半危险 否则。
     */
    function classifyPointRotationZones(cx, cy, bullets, localVerts, cfg) {
        var lvl = classifyPointMultiBullet(cx, cy, bullets, localVerts, cfg);
        if (lvl === 2) return 'absolute';
        if (lvl === 1) return 'semi';
        return 'safe';
    }

    /** 双圆可视化：每弹黄/红两圆；脚下分类仍用 margin 包络。 */
    function buildInstantSafetyZonesViz(ai, tank, cfg) {
        if (!ai || !tank) return null;
        cfg = cfg || getCfg();

        var bullets = collectInstantBulletPositions(ai, cfg);
        var localVerts = getTankHeptagonLocal(cfg);
        var tx = tank.getX();
        var ty = tank.getY();
        var tankClass = classifyPointRotationZones(tx, ty, bullets, localVerts, cfg);
        var tankEnv = bullets.length
            ? marginEnvelopeOverRotation(tx, ty, bullets, localVerts, cfg) : null;

        if (!bullets.length) {
            return {
                mode: 'circles',
                bulletCount: 0,
                tankClass: 'safe',
                tankEnvelope: null,
                radii: null,
                circles: [],
                bullets: []
            };
        }

        var zones = buildCircleSafetyZones(bullets, localVerts, cfg);

        return {
            mode: 'circles',
            bulletCount: bullets.length,
            tankClass: tankClass,
            tankEnvelope: tankEnv,
            radii: zones.radii,
            circles: zones.circles,
            rotationSamples: safetyRotationSampleCount(cfg),
            bullets: bullets
        };
    }

    function buildMarginAlongTrajectory(trajectory, threats, cfg) {
        var out = [];
        var i, s, m;
        if (!trajectory) return out;
        for (i = 0; i < trajectory.length; i++) {
            s = trajectory[i];
            m = bodyMarginAt(s.x, s.y, s.rot || 0, s.t, threats, cfg);
            out.push({ x: s.x, y: s.y, t: s.t, margin: m, safe: m >= 0 });
        }
        return out;
    }

    function captureDodgeVizSnapshot(self, tank, threats, candidates, pick, maxSim, meta) {
        if (!tank) return null;
        var cfg = (meta && meta.cfg) || getCfg();
        var ranked = (candidates || []).slice();
        ranked.sort(function(a, b) { return (b.eval.score || 0) - (a.eval.score || 0); });

        var criticalTime = 999;
        var i;
        for (i = 0; i < (threats || []).length; i++) {
            criticalTime = Math.min(criticalTime, threats[i].dodgeInfo.closestTime);
        }
        if (criticalTime > 100) criticalTime = 0.5;

        var snap = {
            at: Date.now(),
            aiId: self.aiId,
            meta: meta || {},
            tank: { x: tank.getX(), y: tank.getY(), rot: tank.getRotation() },
            maxSim: maxSim,
            threats: [],
            candidates: [],
            pick: null,
            goal: self.goal ? {
                type: self.goal.type,
                priority: self.goal.priority,
                dodgeInfo: self.goal.dodgeInfo ? {
                    closestTime: self.goal.dodgeInfo.closestTime,
                    closestDistance: self.goal.dodgeInfo.closestDistance,
                    closestId: self.goal.dodgeInfo.closestId
                } : null
            } : null,
            cognition: self._aiTacticsCognition ? {
                dodgeUrgency: self._aiTacticsCognition.dodgeUrgency,
                shootPlan: self._aiTacticsCognition.shootPlan ? {
                    worthShooting: self._aiTacticsCognition.shootPlan.worthShooting,
                    allowed: self._aiTacticsCognition.shootPlan.allowed
                } : null
            } : null,
            action: self.actions && self.actions[0] ? {
                type: self.actions[0].type,
                forward: self.actions[0].forward,
                back: self.actions[0].back,
                left: self.actions[0].left,
                right: self.actions[0].right,
                duration: self.actions[0].duration
            } : null,
            criticalTime: criticalTime,
            safeField: sampleMarginFieldAtTime(tank, threats, cfg, criticalTime),
            dangerZones: buildThreatDangerZones(threats, cfg),
            planTargets: (meta && meta.targets) ? meta.targets.slice(0, 24) : [],
            candidateTrajectories: [],
            marginAlongPick: []
        };

        var pickLabel = pick ? comboLabel(pick.combo) : null;
        var world = self.gameController.getB2DWorld();
        for (i = 0; i < ranked.length && i < 12; i++) {
            var traj = ranked[i].simSamples || ranked[i].steerSamples || null;
            if (!traj && ranked[i].combo) {
                var simTmp = simulateTankInputs(tank, ranked[i].combo, maxSim, world);
                traj = simTmp.samples;
            }
            snap.candidates.push({
                rank: i + 1,
                label: comboLabel(ranked[i].combo),
                type: ranked[i].type || 'constant',
                survives: ranked[i].eval.survives,
                softSurvive: ranked[i].eval.softSurvive,
                minMargin: ranked[i].eval.minBodyMargin,
                avgMargin: ranked[i].eval.avgBodyMargin,
                score: ranked[i].eval.score,
                displacement: ranked[i].eval.displacement,
                through: ranked[i].through || null
            });
            if (traj && traj.length > 1) {
                snap.candidateTrajectories.push({
                    label: comboLabel(ranked[i].combo),
                    survives: ranked[i].eval.survives,
                    isPick: pickLabel === comboLabel(ranked[i].combo),
                    trajectory: traj
                });
            }
        }
        if (pick) {
            snap.pick = {
                label: comboLabel(pick.combo),
                combo: pick.combo,
                type: pick.type || 'constant',
                survives: pick.eval.survives,
                minMargin: pick.eval.minBodyMargin,
                avgMargin: pick.eval.avgBodyMargin,
                score: pick.eval.score,
                trajectory: null
            };
            if (pick.combo) {
                var sim = simulateTankInputs(tank, pick.combo, maxSim, world);
                snap.pick.trajectory = sim.samples;
                snap.pick.hitWall = sim.hitWall;
                snap.marginAlongPick = buildMarginAlongTrajectory(sim.samples, threats, cfg);
            }
            if (pick.steerSamples) {
                snap.pick.steerTrajectory = pick.steerSamples;
                if (!snap.marginAlongPick || snap.marginAlongPick.length === 0) {
                    snap.marginAlongPick = buildMarginAlongTrajectory(pick.steerSamples, threats, cfg);
                }
            }
        }

        for (i = 0; i < (threats || []).length; i++) {
            snap.threats.push({
                id: threats[i].id,
                path: threats[i].path,
                speed: threats[i].speed,
                closestTime: threats[i].dodgeInfo.closestTime,
                closestDistance: threats[i].dodgeInfo.closestDistance,
                closestPosition: threats[i].dodgeInfo.closestPosition
            });
        }

        self._aiTacticsVizSnapshot = snap;
        if (!global.TT_AI_VIZ_SNAPSHOTS) global.TT_AI_VIZ_SNAPSHOTS = {};
        global.TT_AI_VIZ_SNAPSHOTS[self.aiId] = snap;
        if (isDodgeDebugEnabled() || global._ttAiVizEnabled) {
            global.TT_AI_VIZ_LATEST = snap;
        }
        return snap;
    }

    var _vizRoundSeq = 0;

    function getUIGameShell(gc) {
        var game = typeof GameManager !== 'undefined' && GameManager.getGame
            ? GameManager.getGame() : null;
        if (!game || !game.state || game.state.current !== 'Game') return null;
        var state = game.state.getCurrentState();
        return state || null;
    }

    function isVizRoundActive(gc) {
        if (!gc) return false;

        var ui = getUIGameShell(gc);
        if (ui && ui.roundEnded) return false;

        var model = gc.roundController && gc.roundController.model;
        // 模型存在 + started → 回合进行中
        if (model && model.getStarted && model.getStarted()) return true;

        // 回退 1：ui.maze 已加载 + 有坦克（即使 model.started 还没设 true）
        if (ui && ui.maze) {
            var tanks = gc.getTanks ? gc.getTanks() : null;
            if (tanks) {
                var hasTank = false;
                for (var tid in tanks) {
                    if (tanks.hasOwnProperty(tid)) { hasTank = true; break; }
                }
                if (hasTank) return true;
            }
        }

        // 回退 2：模型存在（说明 roundController 已创建回合，但 tanks 还没生成）
        if (model) {
            // 如果模型存在但还没有 ui.maze，说明回合刚创建正在准备
            // 但只要 gameController 还活着 + game state 是 Game，我们就认为是活跃的
            var game = typeof GameManager !== 'undefined' && GameManager.getGame
                ? GameManager.getGame() : null;
            if (game && game.state && game.state.current === 'Game') {
                return true;
            }
        }

        return false;
    }

    function bumpVizRoundSeq() {
        _vizRoundSeq++;
    }

    function getVizRoundKey(gc) {
        if (!gc) return '';
        var id = gc.getId ? gc.getId() : 'gc';
        if (!isVizRoundActive(gc)) return id + '|wait';
        return id + '|r' + _vizRoundSeq;
    }

    function clearAllVizSnapshots() {
        global.TT_AI_VIZ_SNAPSHOTS = {};
        global.TT_AI_VIZ_LATEST = null;
        if (typeof AIs !== 'undefined' && AIs.aiManagers) {
            var i;
            for (i = 0; i < AIs.aiManagers.length; i++) {
                if (AIs.aiManagers[i] && AIs.aiManagers[i].ai) {
                    AIs.aiManagers[i].ai._aiTacticsVizSnapshot = null;
                }
            }
        }
    }

    /** 从子弹当前位置裁剪预测折线，避免上一段/出生点造成“指向错误” */
    function trimPathFromPosition(path, x, y) {
        if (!path || path.length < 2) return path;
        var bestDist = Number.MAX_VALUE;
        var bestSeg = 0;
        var bestU = 0;
        var i, ax, ay, bx, by, dx, dy, len2, u, px, py, d2;

        for (i = 0; i < path.length - 1; i++) {
            ax = path[i].x;
            ay = path[i].y;
            bx = path[i + 1].x;
            by = path[i + 1].y;
            dx = bx - ax;
            dy = by - ay;
            len2 = dx * dx + dy * dy;
            u = len2 > 0.0001 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
            if (u < 0) u = 0;
            else if (u > 1) u = 1;
            px = ax + dx * u;
            py = ay + dy * u;
            d2 = (x - px) * (x - px) + (y - py) * (y - py);
            if (d2 < bestDist) {
                bestDist = d2;
                bestSeg = i;
                bestU = u;
            }
        }

        var out = [{ x: x, y: y }];
        if (bestU < 0.999) {
            ax = path[bestSeg].x;
            ay = path[bestSeg].y;
            bx = path[bestSeg + 1].x;
            by = path[bestSeg + 1].y;
            out.push({ x: ax + (bx - ax) * bestU, y: ay + (by - ay) * bestU });
        }
        for (i = bestSeg + 1; i < path.length; i++) {
            out.push({ x: path[i].x, y: path[i].y });
        }
        if (out.length < 2) return [{ x: x, y: y }, { x: path[path.length - 1].x, y: path[path.length - 1].y }];
        return out;
    }

    function serializeAction(action) {
        if (!action) return null;
        var copy = { type: action.type, duration: action.duration, delay: action.delay };
        if (action.forward !== undefined) copy.forward = action.forward;
        if (action.back !== undefined) copy.back = action.back;
        if (action.left !== undefined) copy.left = action.left;
        if (action.right !== undefined) copy.right = action.right;
        if (action.position) copy.position = { x: action.position.x, y: action.position.y };
        if (action.direction) copy.direction = { x: action.direction.x, y: action.direction.y };
        return copy;
    }

    function serializeGoal(goal) {
        if (!goal) return null;
        return {
            type: goal.type,
            priority: goal.priority,
            period: goal.period,
            target: goal.target,
            position: goal.position ? { x: goal.position.x, y: goal.position.y } : null,
            dodgeInfo: goal.dodgeInfo ? {
                closestTime: goal.dodgeInfo.closestTime,
                closestDistance: goal.dodgeInfo.closestDistance,
                closestId: goal.dodgeInfo.closestId
            } : null
        };
    }

    /** F8 灰虚线：与双圆同帧，从当前弹体 B2D 状态重算弹道（不用 AI 上帧缓存路径）。 */
    function computeLiveProjectilePath(gc, projectile, cfg) {
        if (!gc || !projectile || typeof B2DUtils === 'undefined' ||
            !B2DUtils.calculateProjectilePath || !projectile.getB2DBody) {
            return null;
        }
        var world = gc.getB2DWorld ? gc.getB2DWorld() : null;
        if (!world) return null;
        try {
            var bounces = Constants.AI.MAX_PROJECTILE_BOUNCES;
            var pathLenTiles = Constants.AI.MAX_PROJECTILE_PATH_LENGTH;
            if (cfg && cfg.vizProjectilePathTiles) pathLenTiles = cfg.vizProjectilePathTiles;
            var pathInfo = B2DUtils.calculateProjectilePath(
                world, projectile, bounces,
                Constants.MAZE_TILE_SIZE.m * pathLenTiles, false
            );
            return pathInfo && pathInfo.path ? pathInfo.path : null;
        } catch (e) {
            return null;
        }
    }

    function buildIncomingBulletsViz(ai, cfg) {
        var bullets = collectInstantBulletPositions(ai, cfg);
        var gc = ai.gameController;
        var projectiles = gc && gc.getProjectiles ? gc.getProjectiles() : null;
        var fallbackPaths = ai.projectilePaths || {};
        var out = [];
        var i, b, path, cx, cy, p;

        for (i = 0; i < bullets.length; i++) {
            b = bullets[i];
            cx = b.x;
            cy = b.y;
            path = null;
            if (projectiles && projectiles[b.id]) {
                path = computeLiveProjectilePath(gc, projectiles[b.id], cfg);
            }
            if (!path) path = fallbackPaths[b.id];
            out.push({
                id: b.id,
                path: path ? trimPathFromPosition(path, cx, cy) : null,
                currentPos: { x: cx, y: cy }
            });
        }
        return out;
    }

    function buildHuntPathViz(ai) {
        if (ai.goal && ai.goal.type === AI._GOALS.DODGE_PROJECTILE) return null;

        var maze = ai.gameController.getMaze();
        if (!maze || !ai.myPosition) return null;

        var tile = null;
        var cog = ai._aiTacticsCognition;
        if (cog && cog.shotStancePlan && cog.shotStancePlan.needsReposition &&
            cog.shotStancePlan.moveTile) {
            tile = cog.shotStancePlan.moveTile;
        } else if (ai.goal && ai.goal.position) {
            tile = ai.goal.position;
        }
        if (!tile) {
            if (cog && cog.positionPlan && cog.positionPlan.bestTile) {
                tile = cog.positionPlan.bestTile;
            }
        }
        if (!tile) {
            var enemy = findClosestEnemy(ai);
            if (enemy) tile = enemy.tile;
        }
        if (!tile) return null;

        var threat = ai.threatMap ? ai.threatMap.data() : null;
        var path = maze.getShortestPathWithGraph(ai.myPosition, tile, threat, 0.1);
        var ts = Constants.MAZE_TILE_SIZE.m;
        var waypoints = [];
        var j;

        if (path && path.length > 0) {
            for (j = 0; j < path.length; j++) {
                waypoints.push({ x: (path[j].x + 0.5) * ts, y: (path[j].y + 0.5) * ts });
            }
        }
        return {
            tile: tile,
            tileCenter: { x: (tile.x + 0.5) * ts, y: (tile.y + 0.5) * ts },
            waypoints: waypoints
        };
    }

    function buildShootViz(ai, cfg) {
        var plan = ai._aiTacticsPlannedShot;
        var source = 'none';
        var shot = null;
        var cog = ai._aiTacticsCognition;

        if (plan && plan.path && plan.path.length >= 2) {
            source = 'committed';
            shot = plan;
        } else {
            var preview = ai._aiTacticsShootPreview;
            if (preview && preview.plan && preview.plan.path && preview.plan.path.length >= 2 &&
                cog && cog.shootPlan && cog.shootPlan.worthShooting) {
                source = 'preview';
                shot = preview.plan;
            } else if (cog && cog.shootPlan && cog.shootPlan.previewShot &&
                cog.shootPlan.blocked === 'need_stance') {
                source = 'preview';
                shot = cog.shootPlan.previewShot;
            } else if (cog && cog.shootPlan && cog.shootPlan.shot && cog.shootPlan.worthShooting) {
                var tank = ai.gameController.getTank(ai.aiId);
                var enemyId = cog.enemy ? cog.enemy.id : null;
                updateShootPreviewCache(ai, cog.shootPlan.shot, enemyId);
                if (ai._aiTacticsShootPreview && ai._aiTacticsShootPreview.plan) {
                    source = 'preview';
                    shot = ai._aiTacticsShootPreview.plan;
                }
            }
        }
        if (!shot) return null;

        var conflict = analyzeShootConflict(ai, cfg);
        var tank = ai.gameController.getTank(ai.aiId);
        var viz = {
            path: shot.path,
            angle: shot.angle,
            direction: shot.direction,
            ricochet: !!shot.ricochet,
            intercept: !!shot.intercept,
            staticHit: !!shot.staticHit,
            planSource: source,
            targetId: shot.targetId || (ai.goal ? ai.goal.target : null),
            quality: shot.quality,
            worthShooting: true,
            allowed: cogAllowed(ai),
            conflict: conflict,
            executing: conflict.executing,
            blockedBy: conflict.blockedBy,
            recentShots: recentShotCount(ai)
        };
        if (tank && shot.direction) {
            var dirLen = Math.sqrt(shot.direction.x * shot.direction.x + shot.direction.y * shot.direction.y) || 1;
            var ox = source === 'committed' ? shot.originX : tank.getX();
            var oy = source === 'committed' ? shot.originY : tank.getY();
            if (source === 'preview' && cog && cog.shotStancePlan &&
                cog.shotStancePlan.bestStance && cog.shotStancePlan.needsReposition) {
                ox = cog.shotStancePlan.bestStance.world.x;
                oy = cog.shotStancePlan.bestStance.world.y;
            }
            viz.aimLine = {
                x0: ox,
                y0: oy,
                x1: ox + shot.direction.x / dirLen * 10,
                y1: oy + shot.direction.y / dirLen * 10
            };
        }
        return viz;
    }

    function cogAllowed(ai) {
        var cog = ai._aiTacticsCognition;
        return !!(cog && cog.shootPlan && cog.shootPlan.allowed);
    }

    function buildMovePreviewViz(ai, cfg) {
        var tank = ai.gameController.getTank(ai.aiId);
        if (!tank || !ai.actions || ai.actions.length === 0) return null;

        var a = ai.actions[0];
        var world = ai.gameController.getB2DWorld();

        if (a.type === TACTICS_ACTION_DRIVE_INPUT) {
            var combo = { forward: !!a.forward, back: !!a.back, left: !!a.left, right: !!a.right };
            var threats = collectProjectileThreats(ai, cfg);
            var traj = trajectoryForDodgeCombo(tank, combo, cfg, world, threats);
            return {
                kind: 'dodge_drive',
                label: comboLabel(combo),
                trajectory: traj,
                matchesDodge: !!(ai.goal && ai.goal.type === AI._GOALS.DODGE_PROJECTILE)
            };
        }
        if (a.type === AI._ACTIONS.DRIVE_TO_POSITION && a.position) {
            var steer = simulateSteerToPoint(tank, a.position.x, a.position.y, world, 1.2, cfg);
            return {
                kind: 'drive_pos',
                target: { x: a.position.x, y: a.position.y },
                trajectory: steer.samples
            };
        }
        if (a.type === AI._ACTIONS.DRIVE_TO_TILE && a.position) {
            var ts = Constants.MAZE_TILE_SIZE.m;
            var center = { x: (a.position.x + 0.5) * ts, y: (a.position.y + 0.5) * ts };
            var steerTile = simulateSteerToPoint(tank, center.x, center.y, world, 1.2, cfg);
            return { kind: 'drive_tile', target: center, trajectory: steerTile.samples };
        }
        if (a.type === AI._ACTIONS.TURN_TO && a.direction) {
            return { kind: 'turn', direction: { x: a.direction.x, y: a.direction.y } };
        }
        if (a.type === AI._ACTIONS.FIRE) {
            return { kind: 'fire', delay: a.delay, duration: a.duration };
        }
        return { kind: 'other', type: a.type };
    }

    function buildDodgeLayerViz(ai, tank, cfg) {
        if (!tank || !ai.goal || ai.goal.type !== AI._GOALS.DODGE_PROJECTILE) {
            return null;
        }

        var exec = ai._aiTacticsExecutedDodgeViz;
        if (!exec || !exec.trajectory || exec.trajectory.length < 2) {
            return null;
        }

        return {
            pick: {
                label: exec.label,
                survives: exec.survives,
                minMargin: exec.minMargin,
                trajectory: exec.trajectory,
                source: 'executed'
            },
            candidateTrajectories: exec.candidateTrajectories || [],
            planTargets: [],
            threatCount: exec.threatCount || 0
        };
    }

    function getVizSnapshot(aiId) {
        var ai = findLiveAI(aiId);
        return ai && ai._aiTacticsVizSnapshot ? ai._aiTacticsVizSnapshot : null;
    }

    function buildLiveVizSnapshot(aiId) {
        var ai = findLiveAI(aiId);
        if (!ai) ai = findLiveAI(null);
        if (!ai) return null;

        // 强制使用 live gameController，避免 ai.gameController stale 导致找不到 tank
        var liveGc = (typeof GameManager !== 'undefined' && GameManager.getGameController)
            ? GameManager.getGameController() : null;
        if (liveGc) {
            ai.gameController = liveGc;
        }
        var gc = ai.gameController || liveGc;
        if (!gc) return null;

        var roundKey = getVizRoundKey(gc);

        // 智能匹配 tank：先按 aiId 查，再按 aiId 模糊匹配所有 tank 里的 ai 标签
        var tank = gc.getTank(ai.aiId);

        if (!tank) {
            // 兜底：如果 tanks 里只有一台，就认它（单 AI 局常见）
            var allTanks = gc.getTanks ? gc.getTanks() : null;
            if (allTanks) {
                var onlyTank = null, onlyCount = 0;
                for (var tId in allTanks) {
                    if (!allTanks.hasOwnProperty(tId)) continue;
                    onlyCount++;
                    onlyTank = allTanks[tId];
                }
                if (onlyCount === 1) tank = onlyTank;
            }
        }

        if (!tank) {
            return {
                at: Date.now(),
                roundKey: roundKey,
                aiId: ai.aiId,
                tank: null,
                empty: true
            };
        }

        var cfg = getCfg();
        var shootConflict = analyzeShootConflict(ai, cfg);

        var urgent = findMostUrgentThreat(ai, tank, cfg);
        var dodgeLayer = buildDodgeLayerViz(ai, tank, cfg);
        var bullets = buildIncomingBulletsViz(ai, cfg);
        var inp = ai.inputState;

        var snap = {
            at: Date.now(),
            roundKey: roundKey,
            aiId: ai.aiId,
            tank: { x: tank.getX(), y: tank.getY(), rot: tank.getRotation() },
            goal: serializeGoal(ai.goal),
            actions: [],
            input: inp ? {
                forward: inp.getForward ? inp.getForward() : false,
                back: inp.getBack ? inp.getBack() : false,
                left: inp.getLeft ? inp.getLeft() : false,
                right: inp.getRight ? inp.getRight() : false,
                fire: inp.getFire ? inp.getFire() : false
            } : null,
            cognition: ai._aiTacticsCognition ? {
                dodgeUrgency: ai._aiTacticsCognition.dodgeUrgency,
                enemyId: ai._aiTacticsCognition.enemy ? ai._aiTacticsCognition.enemy.id : null,
                positionPlan: ai._aiTacticsCognition.positionPlan ? {
                    bestTile: ai._aiTacticsCognition.positionPlan.bestTile,
                    safety: ai._aiTacticsCognition.positionPlan.safety,
                    shootPotential: ai._aiTacticsCognition.positionPlan.shootPotential,
                    currentIsGood: ai._aiTacticsCognition.positionPlan.currentIsGood
                } : null,
                shootPlan: ai._aiTacticsCognition.shootPlan ? {
                    worthShooting: ai._aiTacticsCognition.shootPlan.worthShooting,
                    allowed: ai._aiTacticsCognition.shootPlan.allowed,
                    quality: ai._aiTacticsCognition.shootPlan.quality,
                    blocked: ai._aiTacticsCognition.shootPlan.blocked || null
                } : null
            } : null,
            shootConflict: shootConflict,
            layers: {
                bullets: bullets,
                safetyZones: buildInstantSafetyZonesViz(ai, tank, cfg),
                dodge: dodgeLayer,
                hunt: buildHuntPathViz(ai),
                shoot: buildShootViz(ai, cfg),
                move: buildMovePreviewViz(ai, cfg)
            },
            liveMeta: {
                threatCount: bullets.length,
                hasUrgentThreat: !!urgent,
                dodgeGoalActive: !!(ai.goal && ai.goal.type === AI._GOALS.DODGE_PROJECTILE),
                dodgeExecuted: !!(ai._aiTacticsExecutedDodgeViz &&
                    ai._aiTacticsExecutedDodgeViz.trajectory),
                dodgeCombo: ai._aiTacticsActiveDodgeCombo
                    ? comboLabel(ai._aiTacticsActiveDodgeCombo) : null,
                dodgeExecCount: global.TT_DODGE_STATS ? global.TT_DODGE_STATS.dodgeExecCount : 0,
                dodgeApplyCount: global.TT_DODGE_STATS ? global.TT_DODGE_STATS.dodgeApplyCount : 0,
                installed: tacticsIsInstalled()
            }
        };

        var i;
        if (ai.actions) {
            for (i = 0; i < ai.actions.length && i < 6; i++) {
                snap.actions.push(serializeAction(ai.actions[i]));
            }
        }

        ai._aiTacticsVizSnapshot = snap;
        if (!global.TT_AI_VIZ_SNAPSHOTS) global.TT_AI_VIZ_SNAPSHOTS = {};
        global.TT_AI_VIZ_SNAPSHOTS[ai.aiId] = snap;
        global.TT_AI_VIZ_LATEST = snap;
        return snap;
    }

    function runFixedDodgeScenario(scenarioName, options) {
        if (typeof Constants === 'undefined' || !Constants.TANK) {
            return { ok: false, error: 'Constants 未加载，请在游戏页面运行' };
        }
        var base = FIXED_DODGE_SCENARIOS[scenarioName];
        if (!base) {
            return { ok: false, error: '未知场景: ' + scenarioName, available: Object.keys(FIXED_DODGE_SCENARIOS) };
        }
        var cfg = getCfg();
        var opts = {};
        var k;
        for (k in base) {
            if (base.hasOwnProperty(k)) opts[k] = base[k];
        }
        if (options) {
            for (k in options) {
                if (options.hasOwnProperty(k)) opts[k] = options[k];
            }
        }

        var tank = makeMockTank(opts);
        var threat = buildSyntheticThreat(tank, opts);
        var threats = [threat];
        var maxSim = Math.min(cfg.dodgeSimMaxTime || 1.6, threat.dodgeInfo.closestTime + 0.55);
        maxSim = Math.max(maxSim, 0.55);

        var combos = enumerateInputCombos();
        var results = [];
        var i, combo, sim, ev;
        for (i = 0; i < combos.length; i++) {
            combo = combos[i];
            sim = simulateTankInputs(tank, combo, maxSim, null);
            ev = evaluateSpacetimeTrajectory(sim.samples, threats, cfg, null);
            results.push({
                combo: combo,
                label: comboLabel(combo),
                survives: ev.survives,
                softSurvive: ev.softSurvive,
                minMargin: ev.minBodyMargin,
                displacement: ev.displacement,
                score: ev.score,
                hitWall: sim.hitWall
            });
        }

        results.sort(function(a, b) { return b.score - a.score; });
        var survivors = results.filter(function(r) { return r.survives; });
        var best = results[0] || null;
        var report = {
            ok: survivors.length > 0,
            scenario: scenarioName,
            desc: opts.desc,
            threat: threat,
            maxSim: maxSim,
            survivorCount: survivors.length,
            best: best,
            survivors: survivors.slice(0, 5),
            all: results
        };
        console.log('[DodgeHarness] ' + scenarioName + ':', report.desc);
        console.log('  存活组合:', survivors.length + '/' + results.length,
            survivors.length > 0 ? ('最佳 ' + (best && best.label)) : '无');
        if (best) {
            console.log('  最佳 minMargin=', best.minMargin.toFixed(3),
                'disp=', best.displacement.toFixed(2), best.label);
        }
        return report;
    }

    function runAllFixedScenarios() {
        var names = Object.keys(FIXED_DODGE_SCENARIOS);
        var out = {};
        var i;
        for (i = 0; i < names.length; i++) {
            out[names[i]] = runFixedDodgeScenario(names[i]);
        }
        return out;
    }

    function findLiveAI(aiId) {
        if (typeof AIs === 'undefined' || !AIs.aiManagers) return null;
        var gc = typeof GameManager !== 'undefined' && GameManager.getGameController
            ? GameManager.getGameController() : null;
        var gameId = gc && gc.getId ? gc.getId() : null;
        var i, mgr, fallback = null;
        for (i = 0; i < AIs.aiManagers.length; i++) {
            mgr = AIs.aiManagers[i];
            if (!mgr || !mgr.getAIId) continue;
            if (gameId && mgr.getGameId && mgr.getGameId() !== gameId) continue;
            if (aiId && mgr.getAIId() === aiId) return mgr.ai;
            if (!fallback) fallback = mgr.ai;
        }
        if (!aiId && fallback) return fallback;
        return null;
    }

    function injectSyntheticThreatToAI(ai, options) {
        if (!ai || !ai.gameController) return { ok: false, error: 'AI 无效' };
        var tank = ai.gameController.getTank(ai.aiId);
        if (!tank) return { ok: false, error: '坦克未生成' };

        options = options || {};
        var threat = buildSyntheticThreat(tank, options);
        var pid = threat.id;
        var projectiles = ai.gameController.getProjectiles();
        if (!projectiles) return { ok: false, error: '无法访问 projectiles' };

        projectiles[pid] = {
            getB2DBody: function() {
                var spd = threat.speed;
                return {
                    GetLinearVelocity: function() {
                        return { Length: function() { return spd; } };
                    }
                };
            }
        };
        ai.projectilePaths[pid] = threat.path;
        if (!ai.projectilePositions) ai.projectilePositions = {};
        ai.projectilePositions[pid] = { x: threat.path[0].x, y: threat.path[0].y };

        if (typeof AIUtils !== 'undefined') {
            var liveInfo = AIUtils.checkProjectilePathForDodging(
                tank, threat.path, projectiles[pid],
                ai.gameController.getB2DWorld(), Number.MAX_VALUE
            );
            if (liveInfo && liveInfo.closestId) {
                threat.dodgeInfo = liveInfo;
            }
        }

        var cfg = getCfg();
        var setGoal = ensureIncomingDodgeGoal(ai, cfg);
        if (!setGoal) {
            ai.goal = {
                type: AI._GOALS.DODGE_PROJECTILE,
                priority: 0.99,
                id: ai.nextGoalId++,
                period: 0,
                dodgeInfo: threat.dodgeInfo
            };
        }
        ai.actions = [];
        var executed = executeDodgeActions(ai, cfg);
        return {
            ok: executed,
            threat: threat,
            goal: ai.goal,
            combo: ai._aiTacticsActiveDodgeCombo,
            minMargin: ai._aiTacticsLastPlanMinMargin,
            survives: ai._aiTacticsLastPlanSurvives,
            action: ai.actions[0] || null
        };
    }

    function diagAI() {
        var verify = verifyInstallDetail();
        return {
            version: TACTICS_VERSION,
            installed: verify.installed,
            verify: verify,
            stats: global.TT_DODGE_STATS || null,
            aiDefined: typeof AI !== 'undefined',
            hasMethods: !!(typeof AI !== 'undefined' && AI.methods),
            marker: tacticsIsInstalled() ? TACTICS_VERSION : null,
            configLoaded: typeof TankTroubleAIStrength !== 'undefined',
            preset: typeof TankTroubleAIStrengthConfig !== 'undefined'
                ? TankTroubleAIStrengthConfig.activePreset : null
        };
    }

    global.TT_AI_DIAG = diagAI;
    global.TankTroubleAITactics = {
        install: install,
        isInstalled: tacticsIsInstalled,
        diag: diagAI,
        verify: verifyInstallDetail,
        runFixedScenario: runFixedDodgeScenario,
        runAllFixedScenarios: runAllFixedScenarios,
        injectSyntheticThreat: injectSyntheticThreatToAI,
        findLiveAI: findLiveAI,
        getVizSnapshot: getVizSnapshot,
        buildLiveVizSnapshot: buildLiveVizSnapshot,
        buildInstantSafetyZonesViz: buildInstantSafetyZonesViz,
        buildSpacetimeSafetyFieldViz: buildInstantSafetyZonesViz,
        classifySafetyDiskUnion: classifySafetyDiskUnion,
        classifySafetyZoneVisual: classifySafetyZoneVisual,
        classifySafetyZoneLevel: classifySafetyZoneLevel,
        classifyPointRotationZones: classifyPointRotationZones,
        getTankHalfLength: getTankHalfLength,
        getTankBodyHalfLength: getTankBodyHalfLength,
        getTankHullHalfExtents: getTankHullHalfExtents,
        getTankMaxDiagonal: getTankMaxDiagonal,
        getTankHullHalfExtentsPx: getTankHullHalfExtentsPx,
        tankForwardHalfLengthPx: tankForwardHalfLengthPx,
        marginEnvelopeOverRotation: marginEnvelopeOverRotation,
        bodyMarginAt: bodyMarginAt,
        getVizRoundKey: getVizRoundKey,
        isVizRoundActive: isVizRoundActive,
        bumpVizRoundSeq: bumpVizRoundSeq,
        clearAllVizSnapshots: clearAllVizSnapshots,
        trimPathFromPosition: trimPathFromPosition,
        comboLabel: comboLabel,
        predictLeadPoint: predictLeadPoint,
        findLeadShot: findLeadShot,
        findInterceptShot: findInterceptShot,
        enumerateInterceptShots: enumerateInterceptShots,
        analyzeShootConflict: analyzeShootConflict,
        // Vantage 沙箱复用（2026-08-09）：把闭包内的物理模拟函数暴露给 SandboxAdapter
        simulateTankInputs: simulateTankInputs,
        positionOnProjectilePath: positionOnProjectilePath,
        collectProjectileThreats: collectProjectileThreats
    };

})(typeof window !== 'undefined' ? window : this);
