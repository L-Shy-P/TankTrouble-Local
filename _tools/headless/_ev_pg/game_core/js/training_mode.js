/**
 * TankTrouble 训练模式 — 子弹发射源练习场
 */
(function() {
    'use strict';

    var EMITTER_PREFIX = 'train_emitter_';
    var EMITTER_KIND_POINT = 'point';
    var EMITTER_KIND_LINE = 'line';
    var LINE_WALL_PICK_MAX_DIST = 1.2;
    var STORAGE_KEY = 'tt_training_emitters_v1';
    var SETTINGS_KEY = 'tt_training_settings_v1';
    var MAP_GEN_KEY = 'tt_training_map_gen_v1';
    var EMITTER_CONFIG_FORMAT = 'tt_training_emitters';
    var LEVEL_FORMAT = 'tt_training_level';
    var MAP_GEN_FORMAT = 'tt_training_map_gen';
    var CONFIG_VERSION = 1;
    var CONFIG_API = '/api/training-configs';
    var INSTANT_ROTATE_SPEED = 50;
    var TRAINING_LOBBY_Y_DIVISOR = 1.75;
    var DEFAULT_RESPAWN_DELAY_SEC = 0.5;
    var RESPAWN_INVINCIBLE_SEC = 0.5;

    var state = {
        inTrainingGame: false,
        running: false,
        panelVisible: false,
        currentPage: 'main',
        emitters: [],
        runtime: {},
        selectedId: null,
        editId: null,
        drag: null,
        rotateDrag: null,
        wheelEmitterId: null,
        playerDead: false,
        pendingBenchmarkSpawnMode: null,
        lastDeathPose: null,
        respawnTimer: null,
        skipSpawnAnimationId: null,
        suppressTrainingSpawnFx: 0,
        respawnInvincibleUntil: {},
        stats: null,
        settings: null,
        mapGen: null,
        mapGenCache: null,
        fixedMazeData: null,
        fixedHumanSpawn: null,
        useFixedEmitterPositions: false,
        wallPickEmitterId: null,
        lineEmitterGfx: null,
        _patchesApplied: false
    };

    function getTrainingLobbyY(game, lobbyState) {
        var localBtn = lobbyState && lobbyState.localGameButton;
        if (localBtn && typeof localBtn.y === 'number') {
            return localBtn.y - 72;
        }
        return game.height / TRAINING_LOBBY_Y_DIVISOR;
    }

    function getMainPhaser() {
        if (typeof GameManager === 'undefined') return null;
        if (GameManager.getGame) {
            var viaGetter = GameManager.getGame();
            if (viaGetter && viaGetter.state) return viaGetter;
        }
        if (GameManager.phaserInstance && GameManager.phaserInstance.state) {
            return GameManager.phaserInstance;
        }
        return null;
    }

    function isLobbyUiReady(lobby) {
        if (!lobby || !lobby.game || !lobby.localGameButton) return false;
        var lb = lobby.localGameButton;
        return lb.exists !== false && lb.scale && lb.scale.x > 0.1;
    }

    function restoreLobbyUi() {
        var ph = getMainPhaser();
        if (!ph || !ph.state || ph.state.current !== 'Lobby') return;
        var lobby = ph.state.getCurrentState();
        if (!lobby) return;

        lobby.joiningGame = false;

        var localBtn = lobby.localGameButton;
        if (localBtn) {
            if (localBtn.spawn && (!localBtn.exists || !localBtn.scale || localBtn.scale.x < 0.1)) {
                localBtn.spawn();
            }
            localBtn.exists = true;
            localBtn.visible = true;
            if (localBtn.enable) localBtn.enable();
        }

        lobby.trainingGameButton = null;
        if (isLobbyUiReady(lobby)) {
            setupLobbyButton(lobby);
            positionLobbyButton(lobby);
            syncLobbyButton(lobby);
            ensureLobbyButtonVisible(lobby);
        } else {
            scheduleAttachToActiveLobby();
        }
        if (lobby._updateGameButtons) lobby._updateGameButtons();
    }

    function wrapTrainingRoundController(rc) {
        if (!rc || rc._ttTrainingWrapped) return;
        if (typeof rc.killTank === 'function') {
            var origKill = rc.killTank;
            rc.killTank = function(kill) {
                if (kill && kill.getVictimPlayerId && isEmitterId(kill.getVictimPlayerId())) {
                    return;
                }
                var victim = kill && kill.getVictimPlayerId ? kill.getVictimPlayerId() : null;
                if (victim && isTrainingPlayerInvincible(victim)) {
                    return;
                }
                var deathPose = null;
                if (victim && !isEmitterId(victim)) {
                    var deadTank = this.getTank(victim);
                    if (deadTank) {
                        deathPose = {
                            x: deadTank.getX(),
                            y: deadTank.getY(),
                            rotation: deadTank.getRotation()
                        };
                    }
                }
                var result = origKill.call(this, kill);
                if (victim && !isEmitterId(victim)) {
                    onTrainingPlayerDeath(victim, deathPose);
                }
                return result;
            };
        }
        if (typeof rc.destroyTank === 'function') {
            var origDestroy = rc.destroyTank;
            rc.destroyTank = function(playerId) {
                if (isEmitterId(playerId)) return;
                return origDestroy.call(this, playerId);
            };
        }
        if (typeof rc.removeTank === 'function') {
            var origRemove = rc.removeTank;
            rc.removeTank = function(playerId) {
                if (isEmitterId(playerId)) return;
                return origRemove.call(this, playerId);
            };
        }
        rc._ttTrainingWrapped = true;
    }

    function wrapTrainingGameInstance(ttGame) {
        if (!ttGame || ttGame._ttInstanceWrapped) return;
        ttGame._trainingMode = true;

        var baseUpdate = (typeof ttGame.update === 'function')
            ? ttGame.update
            : GameController.prototype.update;

        ttGame.update = function() {
            var t0 = this.lastUpdate;
            if (this.model && typeof GameModel !== 'undefined' &&
                this.model.getState() === GameModel._STATES.BETWEEN_ROUNDS) {
                this.betweenRoundsDuration = 1e6;
                this.celebrationStarted = true;
                this.celebrationEnded = true;
            }
            wrapTrainingRoundController(this.roundController);
            var deltaTime = Math.min(
                (new Date() - t0) / 1000.0,
                (typeof Constants !== 'undefined' && Constants.MAX_DELTA_TIME) || 0.1
            );
            if (state.inTrainingGame && this.model) {
                updateTrainingEmitters(this, deltaTime);
                updateHumanInvincibilityCollision(this);
            }
            baseUpdate.call(this);
            if (!state.inTrainingGame || !this.model) return;
            // v47：把“真实世界刚走完的一步时长”记到 gameController 上。
            // Phaser 传给 AIs.update 的 physicsElapsedMS 是固定 desiredFps
            // （默认 60fps=16.67ms），而 GameController/RoundModel 的 Box2D
            // Step 用的是 Date.now 墙钟 delta（包含 AI 树计算耗时）——两者
            // 长期漂移会让 Vantage 树的时间轴和坦克真实运动错开。
            // 这里记录 wall-clock 实际步长，VantageTree 下一 tick 用同一
            // 步长推进 _timeAcc，树图/段末对齐才与坦克操作状态同源。
            // 只有 RoundModel 真跑了一步才计数/记时；暂停/倒计时期间世界
            // 没 Step，树时间轴也绝不能前进。
            var protoPatched = typeof GameController !== 'undefined' &&
                GameController.prototype && GameController.prototype._trainingGCPatched;
            if (!protoPatched) {
                var rcM = this.roundController && this.roundController.model;
                if (rcM && rcM.running) {
                    this._ttWorldStepCount = (this._ttWorldStepCount || 0) + 1;
                    this._ttLastWorldDt = Math.min(
                        (new Date() - t0) / 1000.0,
                        (typeof Constants !== 'undefined' && Constants.MAX_DELTA_TIME) || 0.1
                    );
                }
            }
            updateEmitterAmmoHUD(this);
            updateTrainingStats(deltaTime, this);
            if (this.model.getState() === GameModel._STATES.ENDED) {
                this.model.setState(GameModel._STATES.BETWEEN_ROUNDS);
                this.betweenRoundsDuration = 1e6;
                this.celebrationStarted = true;
                this.celebrationEnded = true;
            }
        };

        var baseInit = (typeof ttGame._initializeRound === 'function')
            ? ttGame._initializeRound
            : GameController.prototype._initializeRound;
        if (typeof baseInit === 'function') {
            ttGame._initializeRound = function() {
                trainingAfterInitializeRound(this, baseInit);
            };
        }

        wrapTrainingRoundController(ttGame.roundController);
        ttGame._ttInstanceWrapped = true;
    }

    function colourHex(hex) {
        return {
            type: 'solid',
            rawValue: '0x' + hex.toString(16),
            numericValue: String(hex),
            imageValue: ''
        };
    }

    function isEmitterId(playerId) {
        return playerId && String(playerId).indexOf(EMITTER_PREFIX) === 0;
    }

    function shouldSuppressTrainingSpawnFx(playerId) {
        if (!state.inTrainingGame) return false;
        if (state.suppressTrainingSpawnFx > 0) return true;
        if (state.skipSpawnAnimationId != null && playerId != null &&
            String(state.skipSpawnAnimationId) === String(playerId)) {
            return true;
        }
        return false;
    }

    function forceTankSpriteSpawnScale(sprite) {
        if (!sprite || typeof UIConstants === 'undefined') return;
        if (sprite.spawnTween) {
            sprite.spawnTween.stop();
            sprite.spawnTween = null;
        }
        sprite.scale.setTo(UIConstants.GAME_ASSET_SCALE, UIConstants.GAME_ASSET_SCALE);
    }

    function purgeTankFromRoundModel(rc, playerId) {
        if (!rc || !rc.model || !playerId) return;
        var model = rc.model;
        var tank = model.tanks[playerId];
        if (!tank) {
            var pending = model.destroyedPlayerIds;
            if (pending) {
                var pi;
                for (pi = pending.length - 1; pi >= 0; pi--) {
                    if (pending[pi] === playerId) {
                        pending.splice(pi, 1);
                    }
                }
            }
            return;
        }
        if (tank.getB2DBody && model.b2dworld) {
            model.b2dworld.DestroyBody(tank.getB2DBody());
        }
        delete model.tanks[playerId];
        var defWid = model.playerIdDefaultWeaponId[playerId];
        if (defWid) delete model.weapons[defWid];
        var otherIds = model.playerIdOtherWeaponIds[playerId] || [];
        var j;
        for (j = 0; j < otherIds.length; j++) {
            delete model.weapons[otherIds[j]];
        }
        delete model.playerIdDefaultWeaponId[playerId];
        delete model.playerIdOtherWeaponIds[playerId];
        var upgIds = model.playerIdUpgradeIds[playerId] || [];
        for (j = 0; j < upgIds.length; j++) {
            delete model.upgrades[upgIds[j]];
        }
        delete model.playerIdUpgradeIds[playerId];
        if (model.playerIdModifiers) {
            delete model.playerIdModifiers[playerId];
        }
        if (model.destroyedPlayerIds) {
            var di;
            for (di = model.destroyedPlayerIds.length - 1; di >= 0; di--) {
                if (model.destroyedPlayerIds[di] === playerId) {
                    model.destroyedPlayerIds.splice(di, 1);
                }
            }
        }
        model.cachedRoundState = null;
    }

    function grantRespawnInvincibility(playerId) {
        if (!playerId) return;
        state.respawnInvincibleUntil[playerId] = Date.now() + RESPAWN_INVINCIBLE_SEC * 1000;
    }

    function isTrainingPlayerInvincible(playerId) {
        if (!state.inTrainingGame || !playerId || isEmitterId(playerId)) return false;
        var until = state.respawnInvincibleUntil[playerId];
        if (!until) return false;
        if (Date.now() >= until) {
            delete state.respawnInvincibleUntil[playerId];
            return false;
        }
        return true;
    }

    function setTankProjectileCollision(tank, enabled) {
        if (!tank || !tank.getB2DBody || typeof Constants === 'undefined') return;
        var body = tank.getB2DBody();
        if (!body || !body.GetFixtureList) return;
        var projMask = Constants.COLLISION_CATEGORIES.PROJECTILE;
        var fixture = body.GetFixtureList();
        while (fixture) {
            var filter = fixture.GetFilterData();
            if (enabled) {
                filter.maskBits |= projMask;
            } else {
                filter.maskBits &= ~projMask;
            }
            fixture.SetFilterData(filter);
            fixture = fixture.GetNext();
        }
    }

    function updateHumanInvincibilityCollision(gc) {
        if (!state.inTrainingGame || !gc || !gc.roundController) return;
        var humanId = getPrimaryHumanId(gc);
        if (!humanId) return;
        var tank = gc.roundController.getTank(humanId);
        if (!tank) return;
        var inv = isTrainingPlayerInvincible(humanId);
        if (inv) {
            setTankProjectileCollision(tank, false);
            tank._ttInvincibleNoProj = true;
        } else if (tank._ttInvincibleNoProj) {
            setTankProjectileCollision(tank, true);
            tank._ttInvincibleNoProj = false;
        }
    }

    function isGatlingEmitter(em) {
        return em && typeof Constants !== 'undefined' &&
            Number(em.weaponType) === Number(Constants.WEAPON_TYPES.GATLING_GUN);
    }

    function isHomingEmitter(em) {
        return em && typeof Constants !== 'undefined' &&
            Number(em.weaponType) === Number(Constants.WEAPON_TYPES.HOMING_MISSILE);
    }

    function emitterWeaponTypeMatches(weapon, em) {
        if (!weapon || !em || em.weaponType == null) return false;
        var wt = weapon.getType ? weapon.getType() : null;
        return wt != null && Number(wt) === Number(em.weaponType);
    }

    function resetEmitterConfiguredWeapon(weapon, em) {
        if (!emitterWeaponTypeMatches(weapon, em)) return false;
        prepEmitterWeaponForShot(weapon);
        return true;
    }

    function countEmitterProjectiles(rc, emId, projectileType) {
        if (!rc || !rc.model || !rc.model.projectiles) return 0;
        var projectiles = rc.model.projectiles;
        var n = 0;
        var id;
        for (id in projectiles) {
            if (!Object.prototype.hasOwnProperty.call(projectiles, id)) continue;
            var p = projectiles[id];
            if (p.getPlayerId() !== emId) continue;
            if (projectileType != null && p.getType() !== projectileType) continue;
            n++;
        }
        return n;
    }

    function isLineEmitter(em) {
        return em && em.kind === EMITTER_KIND_LINE;
    }

    function isPointEmitter(em) {
        return !em || !em.kind || em.kind === EMITTER_KIND_POINT;
    }

    function hasLineWall(em) {
        return isLineEmitter(em) &&
            em.lineX1 != null && em.lineY1 != null &&
            em.lineX2 != null && em.lineY2 != null;
    }

    function worldPx(mx, my) {
        if (typeof UIUtils !== 'undefined' && UIUtils.mpx) {
            return { x: UIUtils.mpx(mx), y: UIUtils.mpx(my) };
        }
        var ppm = (typeof Constants !== 'undefined' && Constants.PIXELS_PER_METER)
            ? Constants.PIXELS_PER_METER : 20;
        return { x: mx * ppm, y: my * ppm };
    }

    function lineEmitterLength(em) {
        if (!hasLineWall(em)) return 0;
        var dx = em.lineX2 - em.lineX1;
        var dy = em.lineY2 - em.lineY1;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function lineEmitterPosAt(em, t) {
        return {
            x: em.lineX1 + (em.lineX2 - em.lineX1) * t,
            y: em.lineY1 + (em.lineY2 - em.lineY1) * t
        };
    }

    function advanceLineEmitterPosition(rt, em, deltaTime) {
        if (!hasLineWall(em)) return;
        var len = lineEmitterLength(em);
        if (len < 0.01) return;
        if (rt.lineT == null) rt.lineT = 0;
        if (rt.lineDir == null) rt.lineDir = 1;
        var speed = em.moveSpeed != null ? em.moveSpeed : 1;
        var ts = getTileSize();
        rt.lineT += (speed * ts / len) * deltaTime * rt.lineDir;
        if (rt.lineT >= 1) {
            rt.lineT = 1;
            rt.lineDir = -1;
        } else if (rt.lineT <= 0) {
            rt.lineT = 0;
            rt.lineDir = 1;
        }
    }

    function getLineEmitterSpawnPose(em, rt) {
        if (!hasLineWall(em)) return null;
        if (rt.lineT == null) rt.lineT = 0;
        var pos = lineEmitterPosAt(em, rt.lineT);
        return {
            x: pos.x,
            y: pos.y,
            rotation: em.rotation != null ? em.rotation : 0
        };
    }

    function collectMazeWallSegments(maze) {
        var segments = [];
        if (!maze || !maze.getTiles) return segments;
        var tiles = maze.getTiles();
        var w = maze.getWidth();
        var h = maze.getHeight();
        var ts = getTileSize();
        var i, j, tile, floor, x0, y0;
        for (i = 0; i < w; i++) {
            for (j = 0; j < h; j++) {
                tile = tiles[i][j];
                if (!tile) continue;
                floor = tile[0] === 1;
                x0 = i * ts;
                y0 = j * ts;
                if (tile[1] === 1) {
                    segments.push({
                        x1: x0, y1: y0, x2: x0 + ts, y2: y0,
                        outer: j === 0
                    });
                }
                if (tile[2] === 1) {
                    segments.push({
                        x1: x0, y1: y0, x2: x0, y2: y0 + ts,
                        outer: i === 0
                    });
                }
                if (floor) {
                    if (j + 1 < h) {
                        if (tiles[i][j + 1][1] === 1) {
                            segments.push({
                                x1: x0, y1: y0 + ts, x2: x0 + ts, y2: y0 + ts,
                                outer: false
                            });
                        }
                    } else {
                        segments.push({
                            x1: x0, y1: y0 + ts, x2: x0 + ts, y2: y0 + ts,
                            outer: true
                        });
                    }
                    if (i + 1 < w) {
                        if (tiles[i + 1][j][2] === 1) {
                            segments.push({
                                x1: x0 + ts, y1: y0, x2: x0 + ts, y2: y0 + ts,
                                outer: false
                            });
                        }
                    } else {
                        segments.push({
                            x1: x0 + ts, y1: y0, x2: x0 + ts, y2: y0 + ts,
                            outer: true
                        });
                    }
                }
            }
        }
        return segments;
    }

    function distPointToSegment(px, py, seg) {
        var dx = seg.x2 - seg.x1;
        var dy = seg.y2 - seg.y1;
        var len2 = dx * dx + dy * dy;
        if (len2 < 1e-9) {
            var ddx = px - seg.x1;
            var ddy = py - seg.y1;
            return Math.sqrt(ddx * ddx + ddy * ddy);
        }
        var t = ((px - seg.x1) * dx + (py - seg.y1) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        var cx = seg.x1 + t * dx;
        var cy = seg.y1 + t * dy;
        var ex = px - cx;
        var ey = py - cy;
        return Math.sqrt(ex * ex + ey * ey);
    }

    function findNearestWallSegment(maze, mx, my, maxDist) {
        var segments = collectMazeWallSegments(maze);
        var best = null;
        var bestD = maxDist * maxDist;
        var i, d;
        for (i = 0; i < segments.length; i++) {
            d = distPointToSegment(mx, my, segments[i]);
            if (d * d < bestD) {
                bestD = d * d;
                best = segments[i];
            }
        }
        return best;
    }

    function pickLongestOuterWallSegment(maze) {
        var segments = collectMazeWallSegments(maze);
        var best = null;
        var bestLen = 0;
        var i, seg, len;
        for (i = 0; i < segments.length; i++) {
            seg = segments[i];
            if (!seg.outer) continue;
            len = Math.sqrt((seg.x2 - seg.x1) * (seg.x2 - seg.x1) + (seg.y2 - seg.y1) * (seg.y2 - seg.y1));
            if (len > bestLen) {
                bestLen = len;
                best = seg;
            }
        }
        return best;
    }

    function applyWallSegmentToEmitter(em, seg) {
        if (!em || !seg) return;
        em.lineX1 = seg.x1;
        em.lineY1 = seg.y1;
        em.lineX2 = seg.x2;
        em.lineY2 = seg.y2;
        saveEmitters();
    }

    function spawnOrMoveLineEmitterTank(gc, em) {
        if (!gc || !gc.roundController || !hasLineWall(em)) return;
        var rc = gc.roundController;
        var rt = getRuntime(em.id);
        var pose = getLineEmitterSpawnPose(em, rt);
        if (!pose || typeof TankState === 'undefined') return;
        var tank = rc.getTank(em.id);
        if (!tank) {
            rc.spawnTank(em.id, pose, false);
        } else {
            var ts = TankState.withState(
                em.id, pose.x, pose.y, false, false, pose.rotation,
                false, false, false, false
            );
            rc.setTankState(ts, false);
        }
        em.x = pose.x;
        em.y = pose.y;
        em.rotation = pose.rotation;
        disableEmitterProjectileCollision(rc.getTank(em.id));
        applyEmitterWeapon(gc, em);
    }

    function hideLineEmitterVisuals(ui) {
        if (!ui || !state.inTrainingGame) return;
        var i, em, id, spr;
        for (i = 0; i < state.emitters.length; i++) {
            em = state.emitters[i];
            if (!isLineEmitter(em)) continue;
            id = em.id;
            if (ui.tankSprites && ui.tankSprites[id]) {
                spr = ui.tankSprites[id];
                spr.visible = false;
                spr.alpha = 0;
                spr.renderable = false;
            }
            if (ui.tankNameGroups && ui.tankNameGroups[id]) {
                ui.tankNameGroups[id].visible = false;
            }
            if (ui.weaponSymbolGroups && ui.weaponSymbolGroups[id]) {
                ui.weaponSymbolGroups[id].visible = false;
            }
        }
    }

    function ensureLineEmitterGfx(ui) {
        if (!ui || !ui.game || !ui.gameGroup) return null;
        if (state.lineEmitterGfx && state.lineEmitterGfx.game === ui.game && !state.lineEmitterGfx.destroyed) {
            return state.lineEmitterGfx;
        }
        if (state.lineEmitterGfx && state.lineEmitterGfx.destroy) {
            state.lineEmitterGfx.destroy();
        }
        state.lineEmitterGfx = ui.game.add.graphics(0, 0, ui.gameGroup);
        state.lineEmitterGfx.game = ui.game;
        return state.lineEmitterGfx;
    }

    function drawDashedWorldLine(g, x1, y1, x2, y2, dashM, gapM, color, alpha, width) {
        var p1 = worldPx(x1, y1);
        var p2 = worldPx(x2, y2);
        var dx = p2.x - p1.x;
        var dy = p2.y - p1.y;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1) return;
        var ux = dx / len;
        var uy = dy / len;
        var dashPx = worldPx(dashM, 0).x - worldPx(0, 0).x;
        var gapPx = worldPx(gapM, 0).x - worldPx(0, 0).x;
        var dist = 0;
        var draw = true;
        var px = p1.x;
        var py = p1.y;
        g.lineStyle(width, color, alpha);
        while (dist < len) {
            var step = draw ? dashPx : gapPx;
            if (step <= 0) step = 4;
            var nd = Math.min(len, dist + step);
            var nx = p1.x + ux * nd;
            var ny = p1.y + uy * nd;
            if (draw) {
                g.moveTo(px, py);
                g.lineTo(nx, ny);
            }
            px = nx;
            py = ny;
            dist = nd;
            draw = !draw;
        }
    }

    function updateLineEmitterGraphics(gc) {
        if (!state.inTrainingGame) return;
        var ui = getUIGameState();
        if (!ui) return;
        var g = ensureLineEmitterGfx(ui);
        if (!g) return;
        g.clear();
        hideLineEmitterVisuals(ui);
        var ts = getTileSize();
        var i, em, rt, p1, p2, pos, rot, aimLen, ax, ay;
        for (i = 0; i < state.emitters.length; i++) {
            em = state.emitters[i];
            if (!isLineEmitter(em) || !hasLineWall(em)) continue;
            p1 = worldPx(em.lineX1, em.lineY1);
            p2 = worldPx(em.lineX2, em.lineY2);
            g.lineStyle(3, 0x3399ff, 0.9);
            g.moveTo(p1.x, p1.y);
            g.lineTo(p2.x, p2.y);
            rt = getRuntime(em.id);
            if (rt.lineT == null) rt.lineT = 0;
            pos = lineEmitterPosAt(em, rt.lineT);
            rot = em.rotation != null ? em.rotation : 0;
            if (rt.aimPreview) {
                aimLen = ts * 1.4;
                ax = pos.x + Math.sin(rot) * aimLen;
                ay = pos.y - Math.cos(rot) * aimLen;
                drawDashedWorldLine(g, pos.x, pos.y, ax, ay, 0.12, 0.1, 0xffee55, 0.95, 2);
            }
        }
    }

    function destroyLineEmitterGfx() {
        if (state.lineEmitterGfx && state.lineEmitterGfx.destroy) {
            state.lineEmitterGfx.destroy();
        }
        state.lineEmitterGfx = null;
    }

    function startWallPick(em) {
        if (!state.inTrainingGame) {
            window.alert('请先进入训练对局，再在地图上选择墙壁。');
            return;
        }
        if (!em || !isLineEmitter(em)) return;
        state.wallPickEmitterId = em.id;
        setPanelVisible(false);
        updateStatusLine();
    }

    function applyLineWallPick(gc, maze, mx, my) {
        var seg = findNearestWallSegment(maze, mx, my, LINE_WALL_PICK_MAX_DIST);
        if (!seg) {
            window.alert('未选中墙壁，请点击更靠近墙边的位置。');
            return false;
        }
        var em = getEmitterById(state.wallPickEmitterId);
        if (!em) return false;
        applyWallSegmentToEmitter(em, seg);
        resetRuntime(em.id);
        spawnOrMoveLineEmitterTank(gc, em);
        state.wallPickEmitterId = null;
        updateStatusLine();
        return true;
    }

    function applyOuterEdgeWall(gc, em) {
        if (!gc || !em) return;
        var maze = gc.getMaze && gc.getMaze();
        if (!maze) {
            window.alert('地图尚未就绪');
            return;
        }
        var seg = pickLongestOuterWallSegment(maze);
        if (!seg) {
            window.alert('未找到地图外边缘墙壁');
            return;
        }
        applyWallSegmentToEmitter(em, seg);
        resetRuntime(em.id);
        spawnOrMoveLineEmitterTank(gc, em);
        var status = document.getElementById('tt-em-line-wall-status');
        if (status) status.textContent = '已附着外边缘';
    }

    function startMagazineReload(rt, em) {
        var recSec = em.magazineRecoverySec != null ? em.magazineRecoverySec : 3;
        if (recSec <= 0) {
            rt.ammo = Math.max(1, em.bulletCount || 1);
            rt.reloadTimer = 0;
        } else {
            rt.reloadTimer = recSec;
        }
    }

    function advanceEmitterAim(rt) {
        if (rt.shotPool && rt.shotPool.length) {
            rt.shotIdx = (rt.shotIdx + 1) % rt.shotPool.length;
        }
        rt.targetWorldAngle = null;
    }

    function endGatlingBurst(rt, em, interval, gc, emitterId) {
        rt.gatlingBurst = false;
        advanceEmitterAim(rt);
        rt.cooldown = interval;
        if (!gc || !gc.roundController) return;
        var weapon = gc.getActiveWeapon(emitterId);
        if (weapon && typeof weapon.release === 'function') {
            weapon.release();
        }
        if (typeof InputState !== 'undefined') {
            gc.roundController.setInputState(
                InputState.withState(emitterId, false, false, false, false, false)
            );
        }
    }

    function releaseAllGatlingBursts(gc) {
        if (!gc) return;
        var i;
        for (i = 0; i < state.emitters.length; i++) {
            var em = state.emitters[i];
            if (!isGatlingEmitter(em)) continue;
            var rt = state.runtime[em.id];
            if (!rt || !rt.gatlingBurst) continue;
            endGatlingBurst(rt, em, 0, gc, em.id);
        }
    }

    function clearEmitterMagazine(emId) {
        var rt = getRuntime(emId);
        var em = getEmitterById(emId);
        if (!rt || !em) return;
        rt.ammo = 0;
        rt.gatlingBurst = false;
        startMagazineReload(rt, em);
        var gc = getActiveGameController();
        if (gc && gc.roundController) {
            var weapon = gc.getActiveWeapon(emId);
            if (weapon && typeof weapon.release === 'function') {
                weapon.release();
            }
            if (typeof InputState !== 'undefined') {
                gc.roundController.setInputState(
                    InputState.withState(emId, false, false, false, false, false)
                );
            }
        }
        updateEmitterAmmoHUD(gc);
    }

    function normalizeAngle(a) {
        while (a > Math.PI) a -= Math.PI * 2;
        while (a < -Math.PI) a += Math.PI * 2;
        return a;
    }

    function lerpAngle(a, b, t) {
        var diff = normalizeAngle(b - a);
        return normalizeAngle(a + diff * t);
    }

    function shortestAngleDiff(from, to) {
        return normalizeAngle(to - from);
    }

    function defaultSettings() {
        return {
            autoRespawn: true,
            respawnInPlace: true,
            autoNewMap: false,
            respawnDelaySec: DEFAULT_RESPAWN_DELAY_SEC
        };
    }

    function loadSettings() {
        state.settings = defaultSettings();
        try {
            var raw = localStorage.getItem(SETTINGS_KEY);
            if (!raw) return;
            var parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return;
            if (typeof parsed.autoRespawn === 'boolean') state.settings.autoRespawn = parsed.autoRespawn;
            if (typeof parsed.respawnInPlace === 'boolean') state.settings.respawnInPlace = parsed.respawnInPlace;
            if (typeof parsed.autoNewMap === 'boolean') state.settings.autoNewMap = parsed.autoNewMap;
            if (typeof parsed.respawnDelaySec === 'number' && !isNaN(parsed.respawnDelaySec)) {
                state.settings.respawnDelaySec = Math.max(0, Math.min(5, parsed.respawnDelaySec));
            }
        } catch (e) { /* ignore */ }
    }

    function saveSettings() {
        if (!state.settings) return;
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
        } catch (e) { /* ignore */ }
    }

    function getRespawnDelayMs() {
        if (!state.settings) return DEFAULT_RESPAWN_DELAY_SEC * 1000;
        return Math.max(0, state.settings.respawnDelaySec || 0) * 1000;
    }

    function syncSettingsUI() {
        if (!state.settings) return;
        var autoRespawn = document.getElementById('tt-set-auto-respawn');
        var inPlace = document.getElementById('tt-set-respawn-inplace');
        var autoMap = document.getElementById('tt-set-auto-newmap');
        var delay = document.getElementById('tt-set-respawn-delay');
        var delayVal = document.getElementById('tt-set-respawn-delay-val');
        if (autoRespawn) autoRespawn.checked = !!state.settings.autoRespawn;
        if (inPlace) inPlace.checked = !!state.settings.respawnInPlace;
        if (autoMap) autoMap.checked = !!state.settings.autoNewMap;
        if (delay) {
            delay.value = String(state.settings.respawnDelaySec);
            if (delayVal) delayVal.textContent = String(state.settings.respawnDelaySec);
        }
    }

    function syncMapGenUI() {
        if (!state.mapGen) return;
        var mg = state.mapGen;
        var mc = mg.maze || {};
        var sp = mg.spawns || {};
        function setCheck(id, val) {
            var el = document.getElementById(id);
            if (el) el.checked = !!val;
        }
        function setRange(id, valId, val, digits) {
            var el = document.getElementById(id);
            var lab = document.getElementById(valId);
            if (el) el.value = String(val);
            if (lab) lab.textContent = digits != null ? Number(val).toFixed(digits) : String(val);
        }
        function setNum(id, val) {
            var el = document.getElementById(id);
            if (!el) return;
            el.value = (val == null || val === '') ? '' : String(val);
        }
        setCheck('tt-mapgen-ranked', mg.ranked);
        setCheck('tt-mapgen-symmetric', mg.symmetric);
        setCheck('tt-mapgen-border-only', mc.borderOnly);
        var theme = document.getElementById('tt-mapgen-theme');
        if (theme) theme.value = String(mg.theme);
        setRange('tt-mapgen-max-players', 'tt-mapgen-max-players-val', mg.maxActivePlayerCount);
        setNum('tt-mapgen-fixed-width', mc.fixedWidth);
        setNum('tt-mapgen-fixed-height', mc.fixedHeight);
        setRange('tt-mapgen-width-mult-min', 'tt-mapgen-width-mult-min-val', mc.widthMultiplierMin, 2);
        setRange('tt-mapgen-width-mult-max', 'tt-mapgen-width-mult-max-val', mc.widthMultiplierMax, 2);
        setRange('tt-mapgen-height-mult-min', 'tt-mapgen-height-mult-min-val', mc.heightMultiplierMin, 2);
        setRange('tt-mapgen-height-mult-max', 'tt-mapgen-height-mult-max-val', mc.heightMultiplierMax, 2);
        setRange('tt-mapgen-wall-prob', 'tt-mapgen-wall-prob-val', mc.wallProbability != null ? mc.wallProbability : 0.8, 2);
        setRange('tt-mapgen-tile-prob', 'tt-mapgen-tile-prob-val', mc.tileProbability != null ? mc.tileProbability : 0.7, 2);
        setNum('tt-mapgen-wall-prob-num', mc.wallProbability != null ? mc.wallProbability : 0.8);
        setNum('tt-mapgen-tile-prob-num', mc.tileProbability != null ? mc.tileProbability : 0.7);
        setRange('tt-mapgen-reachable', 'tt-mapgen-reachable-val', mc.minReachableRatio, 2);
        setRange('tt-mapgen-tiles-between', 'tt-mapgen-tiles-between-val', mc.minTilesBetweenTanks);
        setRange('tt-mapgen-tiles-per-tank', 'tt-mapgen-tiles-per-tank-val', mc.minTilesPerTank);
        setRange('tt-mapgen-dead-end', 'tt-mapgen-dead-end-val', mc.maxDeadEndPenalty);
        setRange('tt-mapgen-max-crates', 'tt-mapgen-max-crates-val', sp.maxCrates);
        setRange('tt-mapgen-crate-min', 'tt-mapgen-crate-min-val', sp.crateSpawnMinSec, 1);
        setRange('tt-mapgen-crate-var', 'tt-mapgen-crate-var-val', sp.crateSpawnVarianceSec, 1);
        setRange('tt-mapgen-crate-dist', 'tt-mapgen-crate-dist-val', sp.crateMinTilesToTanks);
        setRange('tt-mapgen-max-golds', 'tt-mapgen-max-golds-val', sp.maxGolds);
        setRange('tt-mapgen-gold-dist', 'tt-mapgen-gold-dist-val', sp.goldMinTilesToTanks);
        setRange('tt-mapgen-max-diamonds', 'tt-mapgen-max-diamonds-val', sp.maxDiamonds);
        setRange('tt-mapgen-diamond-dist', 'tt-mapgen-diamond-dist-val', sp.diamondMinTilesToTanks);
        var crateTypes = sp.crateTypes || mg.crateTypes || [];
        var crateOpts = getMapGenCrateOptions();
        var ci;
        for (ci = 0; ci < crateOpts.length; ci++) {
            setCheck('tt-mapgen-crate-' + crateOpts[ci].value, crateTypes.indexOf(crateOpts[ci].value) >= 0);
        }
        var fixedHint = document.getElementById('tt-mapgen-fixed-hint');
        if (fixedHint) {
            fixedHint.textContent = state.fixedMazeData
                ? '当前为固定自制关卡；点「换新地图」将恢复随机生成。'
                : (mc.borderOnly
                    ? '当前为空旷训练场（仅外框墙，无内墙）。'
                    : '当前为随机迷宫生成（下次换图或新开一局时生效）。');
        }
        setMazeProbControlsDisabled(!!mc.borderOnly);
    }

    function setMazeProbControlsDisabled(disabled) {
        var ids = [
            'tt-mapgen-wall-prob', 'tt-mapgen-wall-prob-num',
            'tt-mapgen-tile-prob', 'tt-mapgen-tile-prob-num',
            'tt-mapgen-symmetric'
        ];
        var i;
        for (i = 0; i < ids.length; i++) {
            var el = document.getElementById(ids[i]);
            if (el) el.disabled = disabled;
        }
    }

    function bindMazeProbControl(rangeId, numId, valId, setter, digits) {
        var rangeEl = document.getElementById(rangeId);
        var numEl = document.getElementById(numId);
        if (!rangeEl) return;
        function applyVal(v) {
            if (isNaN(v)) return;
            v = Math.max(0, Math.min(1, v));
            setter(v);
            rangeEl.value = String(v);
            if (numEl) numEl.value = String(v);
            var lab = document.getElementById(valId);
            if (lab) lab.textContent = v.toFixed(digits != null ? digits : 2);
            if (state.mapGen && state.mapGen.maze) {
                state.mapGen.maze.borderOnly = false;
            }
            saveMapGenSettings();
            var gc = getActiveGameController();
            if (gc) applyMapGenToGameController(gc);
        }
        rangeEl.addEventListener('input', function() {
            applyVal(parseFloat(rangeEl.value));
        });
        if (numEl && !numEl._ttBound) {
            numEl._ttBound = true;
            numEl.addEventListener('change', function() {
                applyVal(parseFloat(numEl.value));
            });
        }
    }

    function bindMapGenUI() {
        if (!state.mapGen) loadMapGenSettings();
        var ranked = document.getElementById('tt-mapgen-ranked');
        if (!ranked || ranked._ttBound) return;
        ranked._ttBound = true;

        function persistMapGen() {
            saveMapGenSettings();
            var gc = getActiveGameController();
            if (gc) applyMapGenToGameController(gc);
        }

        function bindCheck(id, setter) {
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', function() {
                setter(el.checked);
                persistMapGen();
            });
        }

        function bindRange(id, setter, valId, digits) {
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('input', function() {
                var v = parseFloat(el.value);
                if (isNaN(v)) return;
                setter(v);
                if (valId) {
                    var lab = document.getElementById(valId);
                    if (lab) lab.textContent = digits != null ? v.toFixed(digits) : String(v);
                }
                persistMapGen();
            });
        }

        function bindOptionalNum(id, mazeKey) {
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', function() {
                var raw = el.value.trim();
                state.mapGen.maze[mazeKey] = raw === '' ? null : parseInt(raw, 10);
                persistMapGen();
            });
        }

        bindCheck('tt-mapgen-ranked', function(v) { state.mapGen.ranked = v; });
        bindCheck('tt-mapgen-symmetric', function(v) { state.mapGen.symmetric = v; });
        bindCheck('tt-mapgen-border-only', function(v) {
            state.mapGen.maze.borderOnly = v;
            if (v) {
                state.mapGen.maze.wallProbability = 0;
                state.mapGen.maze.tileProbability = 1;
                state.mapGen.symmetric = false;
            }
            syncMapGenUI();
            persistMapGen();
        });
        var theme = document.getElementById('tt-mapgen-theme');
        if (theme) {
            theme.addEventListener('change', function() {
                state.mapGen.theme = parseInt(theme.value, 10);
                persistMapGen();
            });
        }
        bindRange('tt-mapgen-max-players', function(v) {
            state.mapGen.maxActivePlayerCount = Math.round(v);
        }, 'tt-mapgen-max-players-val');
        bindOptionalNum('tt-mapgen-fixed-width', 'fixedWidth');
        bindOptionalNum('tt-mapgen-fixed-height', 'fixedHeight');
        bindRange('tt-mapgen-width-mult-min', function(v) { state.mapGen.maze.widthMultiplierMin = v; }, 'tt-mapgen-width-mult-min-val', 2);
        bindRange('tt-mapgen-width-mult-max', function(v) { state.mapGen.maze.widthMultiplierMax = v; }, 'tt-mapgen-width-mult-max-val', 2);
        bindRange('tt-mapgen-height-mult-min', function(v) { state.mapGen.maze.heightMultiplierMin = v; }, 'tt-mapgen-height-mult-min-val', 2);
        bindRange('tt-mapgen-height-mult-max', function(v) { state.mapGen.maze.heightMultiplierMax = v; }, 'tt-mapgen-height-mult-max-val', 2);
        bindMazeProbControl('tt-mapgen-wall-prob', 'tt-mapgen-wall-prob-num', 'tt-mapgen-wall-prob-val',
            function(v) { state.mapGen.maze.wallProbability = v; }, 2);
        bindMazeProbControl('tt-mapgen-tile-prob', 'tt-mapgen-tile-prob-num', 'tt-mapgen-tile-prob-val',
            function(v) { state.mapGen.maze.tileProbability = v; }, 2);
        bindRange('tt-mapgen-reachable', function(v) { state.mapGen.maze.minReachableRatio = v; }, 'tt-mapgen-reachable-val', 2);
        bindRange('tt-mapgen-tiles-between', function(v) { state.mapGen.maze.minTilesBetweenTanks = Math.round(v); }, 'tt-mapgen-tiles-between-val');
        bindRange('tt-mapgen-tiles-per-tank', function(v) { state.mapGen.maze.minTilesPerTank = Math.round(v); }, 'tt-mapgen-tiles-per-tank-val');
        bindRange('tt-mapgen-dead-end', function(v) { state.mapGen.maze.maxDeadEndPenalty = Math.round(v); }, 'tt-mapgen-dead-end-val');
        bindRange('tt-mapgen-max-crates', function(v) { state.mapGen.spawns.maxCrates = Math.round(v); }, 'tt-mapgen-max-crates-val');
        bindRange('tt-mapgen-crate-min', function(v) { state.mapGen.spawns.crateSpawnMinSec = v; }, 'tt-mapgen-crate-min-val', 1);
        bindRange('tt-mapgen-crate-var', function(v) { state.mapGen.spawns.crateSpawnVarianceSec = v; }, 'tt-mapgen-crate-var-val', 1);
        bindRange('tt-mapgen-crate-dist', function(v) { state.mapGen.spawns.crateMinTilesToTanks = Math.round(v); }, 'tt-mapgen-crate-dist-val');
        bindRange('tt-mapgen-max-golds', function(v) { state.mapGen.spawns.maxGolds = Math.round(v); }, 'tt-mapgen-max-golds-val');
        bindRange('tt-mapgen-gold-dist', function(v) { state.mapGen.spawns.goldMinTilesToTanks = Math.round(v); }, 'tt-mapgen-gold-dist-val');
        bindRange('tt-mapgen-max-diamonds', function(v) { state.mapGen.spawns.maxDiamonds = Math.round(v); }, 'tt-mapgen-max-diamonds-val');
        bindRange('tt-mapgen-diamond-dist', function(v) { state.mapGen.spawns.diamondMinTilesToTanks = Math.round(v); }, 'tt-mapgen-diamond-dist-val');

        var crateOpts = getMapGenCrateOptions();
        var ci;
        for (ci = 0; ci < crateOpts.length; ci++) {
            (function(crateType) {
                var crateEl = document.getElementById('tt-mapgen-crate-' + crateType);
                if (!crateEl) return;
                crateEl.addEventListener('change', function() {
                    var list = state.mapGen.spawns.crateTypes.slice();
                    var idx = list.indexOf(crateType);
                    if (crateEl.checked && idx < 0) list.push(crateType);
                    if (!crateEl.checked && idx >= 0) list.splice(idx, 1);
                    list.sort(function(a, b) { return a - b; });
                    state.mapGen.spawns.crateTypes = list;
                    state.mapGen.crateTypes = list.slice();
                    persistMapGen();
                });
            })(crateOpts[ci].value);
        }

        var exportBtn = document.getElementById('tt-mapgen-export');
        if (exportBtn) {
            exportBtn.addEventListener('click', function() {
                try { exportMapGenConfig(); } catch (e) {
                    window.alert('导出失败：' + (e.message || String(e)));
                }
            });
        }
        var importBtn = document.getElementById('tt-mapgen-import');
        var importFile = document.getElementById('tt-mapgen-import-file');
        if (importBtn && importFile) {
            importBtn.addEventListener('click', function() { importFile.click(); });
            importFile.addEventListener('change', function() {
                if (!importFile.files || !importFile.files[0]) return;
                importJsonFromFile(importFile.files[0], applyMapGenConfig);
                importFile.value = '';
            });
        }
        var saveServer = document.getElementById('tt-mapgen-save-server');
        if (saveServer) {
            saveServer.addEventListener('click', function() {
                var nameInput = document.getElementById('tt-mapgen-save-name');
                var name = nameInput && nameInput.value ? nameInput.value.trim() : 'map-gen';
                saveConfigToServer('map_gen', name, buildMapGenExport())
                    .then(function(filename) {
                        if (nameInput) nameInput.value = filename.replace(/\.json$/i, '');
                        refreshServerConfigSelect('map_gen', 'tt-mapgen-server-list');
                        window.alert('已保存到 training_configs/map_gen/' + filename);
                    })
                    .catch(function(err) {
                        window.alert('保存失败：' + (err.message || String(err)));
                    });
            });
        }
        var loadServer = document.getElementById('tt-mapgen-load-server');
        if (loadServer) {
            loadServer.addEventListener('click', function() {
                var select = document.getElementById('tt-mapgen-server-list');
                if (!select || !select.value) {
                    window.alert('请先从列表选择配置');
                    return;
                }
                loadConfigFromServer('map_gen', select.value)
                    .then(applyMapGenConfig)
                    .catch(function(err) {
                        window.alert('加载失败：' + (err.message || String(err)));
                    });
            });
        }
        refreshServerConfigSelect('map_gen', 'tt-mapgen-server-list');
        syncMapGenUI();
    }

    function bindConfigIOUI() {
        var exportEmitters = document.getElementById('tt-export-emitters');
        if (exportEmitters && !exportEmitters._ttBound) {
            exportEmitters._ttBound = true;
            exportEmitters.addEventListener('click', function() {
                try { exportEmitterConfig(); } catch (e) {
                    window.alert('导出失败：' + (e.message || String(e)));
                }
            });
        }
        var importEmitters = document.getElementById('tt-import-emitters');
        var importEmittersFile = document.getElementById('tt-import-emitters-file');
        if (importEmitters && importEmittersFile && !importEmitters._ttBound) {
            importEmitters._ttBound = true;
            importEmitters.addEventListener('click', function() { importEmittersFile.click(); });
            importEmittersFile.addEventListener('change', function() {
                if (!importEmittersFile.files || !importEmittersFile.files[0]) return;
                importJsonFromFile(importEmittersFile.files[0], applyEmitterConfig);
                importEmittersFile.value = '';
            });
        }
        var saveEmittersServer = document.getElementById('tt-emitters-save-server');
        if (saveEmittersServer && !saveEmittersServer._ttBound) {
            saveEmittersServer._ttBound = true;
            saveEmittersServer.addEventListener('click', function() {
                var nameInput = document.getElementById('tt-emitters-save-name');
                var name = nameInput && nameInput.value ? nameInput.value.trim() : 'emitters';
                saveConfigToServer('emitters', name, buildEmitterConfigExport())
                    .then(function(filename) {
                        if (nameInput) nameInput.value = filename.replace(/\.json$/i, '');
                        refreshServerConfigSelect('emitters', 'tt-emitters-server-list');
                        window.alert('已保存到 training_configs/emitters/' + filename);
                    })
                    .catch(function(err) {
                        window.alert('保存失败：' + (err.message || String(err)));
                    });
            });
        }
        var loadEmittersServer = document.getElementById('tt-emitters-load-server');
        if (loadEmittersServer && !loadEmittersServer._ttBound) {
            loadEmittersServer._ttBound = true;
            loadEmittersServer.addEventListener('click', function() {
                var select = document.getElementById('tt-emitters-server-list');
                if (!select || !select.value) {
                    window.alert('请先从列表选择配置');
                    return;
                }
                loadConfigFromServer('emitters', select.value)
                    .then(applyEmitterConfig)
                    .catch(function(err) {
                        window.alert('加载失败：' + (err.message || String(err)));
                    });
            });
        }

        var exportLevel = document.getElementById('tt-export-level');
        if (exportLevel && !exportLevel._ttBound) {
            exportLevel._ttBound = true;
            exportLevel.addEventListener('click', function() {
                try { exportLevelConfig(); } catch (e) {
                    window.alert('导出失败：' + (e.message || String(e)));
                }
            });
        }
        var importLevel = document.getElementById('tt-import-level');
        var importLevelFile = document.getElementById('tt-import-level-file');
        if (importLevel && importLevelFile && !importLevel._ttBound) {
            importLevel._ttBound = true;
            importLevel.addEventListener('click', function() { importLevelFile.click(); });
            importLevelFile.addEventListener('change', function() {
                if (!importLevelFile.files || !importLevelFile.files[0]) return;
                importJsonFromFile(importLevelFile.files[0], applyLevelConfig);
                importLevelFile.value = '';
            });
        }
        var saveLevelServer = document.getElementById('tt-level-save-server');
        if (saveLevelServer && !saveLevelServer._ttBound) {
            saveLevelServer._ttBound = true;
            saveLevelServer.addEventListener('click', function() {
                var nameInput = document.getElementById('tt-level-export-name');
                var name = nameInput && nameInput.value ? nameInput.value.trim() : 'training-level';
                saveConfigToServer('levels', name, buildLevelExport(name))
                    .then(function(filename) {
                        refreshServerConfigSelect('levels', 'tt-level-server-list');
                        window.alert('已保存到 training_configs/levels/' + filename);
                    })
                    .catch(function(err) {
                        window.alert('保存失败：' + (err.message || String(err)));
                    });
            });
        }
        var loadLevelServer = document.getElementById('tt-level-load-server');
        if (loadLevelServer && !loadLevelServer._ttBound) {
            loadLevelServer._ttBound = true;
            loadLevelServer.addEventListener('click', function() {
                var select = document.getElementById('tt-level-server-list');
                if (!select || !select.value) {
                    window.alert('请先从列表选择关卡');
                    return;
                }
                loadConfigFromServer('levels', select.value)
                    .then(applyLevelConfig)
                    .catch(function(err) {
                        window.alert('加载失败：' + (err.message || String(err)));
                    });
            });
        }
        refreshServerConfigSelect('emitters', 'tt-emitters-server-list');
        refreshServerConfigSelect('levels', 'tt-level-server-list');
    }

    function bindSettingsUI() {
        var autoRespawn = document.getElementById('tt-set-auto-respawn');
        var inPlace = document.getElementById('tt-set-respawn-inplace');
        var autoMap = document.getElementById('tt-set-auto-newmap');
        var delay = document.getElementById('tt-set-respawn-delay');
        var delayVal = document.getElementById('tt-set-respawn-delay-val');
        if (!autoRespawn || autoRespawn._ttBound) return;
        autoRespawn._ttBound = true;

        autoRespawn.addEventListener('change', function() {
            state.settings.autoRespawn = autoRespawn.checked;
            saveSettings();
        });
        if (inPlace) {
            inPlace.addEventListener('change', function() {
                state.settings.respawnInPlace = inPlace.checked;
                saveSettings();
            });
        }
        if (autoMap) {
            autoMap.addEventListener('change', function() {
                state.settings.autoNewMap = autoMap.checked;
                saveSettings();
                updateStatusLine();
            });
        }
        if (delay) {
            delay.addEventListener('input', function() {
                state.settings.respawnDelaySec = Math.max(0, Math.min(5, parseFloat(delay.value) || 0));
                if (delayVal) delayVal.textContent = String(state.settings.respawnDelaySec);
                saveSettings();
                updateStatusLine();
            });
        }
        syncSettingsUI();
    }

    function loadEmitters() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                var parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    state.emitters = parsed;
                    var i;
                    for (i = 0; i < state.emitters.length; i++) {
                        normalizeEmitterConfig(state.emitters[i]);
                    }
                }
            }
        } catch (e) { /* ignore */ }
    }

    function saveEmitters() {
        try {
            var slim = [];
            var i;
            for (i = 0; i < state.emitters.length; i++) {
                var em = state.emitters[i];
                slim.push({
                    id: em.id,
                    name: em.name,
                    rotateSpeed: em.rotateSpeed,
                    directionRandomness: em.directionRandomness,
                    minShootInterval: em.minShootInterval,
                    bulletCount: em.bulletCount,
                    magazineRecoverySec: em.magazineRecoverySec,
                    weaponType: em.weaponType
                });
            }
            localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
        } catch (e) { /* ignore */ }
    }

    function cloneJson(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    function serializeEmitterParams(em) {
        var out = {
            id: em.id,
            name: em.name,
            kind: em.kind || EMITTER_KIND_POINT,
            rotateSpeed: em.rotateSpeed,
            directionRandomness: em.directionRandomness,
            minShootInterval: em.minShootInterval,
            bulletCount: em.bulletCount,
            magazineRecoverySec: em.magazineRecoverySec,
            weaponType: em.weaponType
        };
        if (isLineEmitter(em)) {
            out.moveSpeed = em.moveSpeed;
            out.lineX1 = em.lineX1;
            out.lineY1 = em.lineY1;
            out.lineX2 = em.lineX2;
            out.lineY2 = em.lineY2;
        }
        return out;
    }

    function serializeEmitterForLevel(em, gc) {
        var out = serializeEmitterParams(em);
        out.x = em.x;
        out.y = em.y;
        out.rotation = em.rotation;
        if (gc && gc.roundController) {
            var tank = gc.roundController.getTank(em.id);
            if (tank) {
                out.x = tank.getX();
                out.y = tank.getY();
                out.rotation = tank.getRotation();
            }
        }
        return out;
    }

    function serializeRuntimeForExport() {
        var out = {};
        var id;
        for (id in state.runtime) {
            if (!Object.prototype.hasOwnProperty.call(state.runtime, id)) continue;
            var rt = state.runtime[id];
            out[id] = {
                ammo: rt.ammo,
                reloadTimer: rt.reloadTimer,
                cooldown: rt.cooldown,
                shotIdx: rt.shotIdx,
                gatlingBurst: !!rt.gatlingBurst,
                targetWorldAngle: rt.targetWorldAngle
            };
        }
        return out;
    }

    function getCurrentMazeData(gc) {
        if (!gc || typeof gc.getMaze !== 'function') return null;
        var maze = gc.getMaze();
        if (!maze || typeof maze.toObj !== 'function') return null;
        return cloneJson(maze.toObj());
    }

    function getCurrentHumanSpawn(gc) {
        var humanId = getPrimaryHumanId(gc);
        if (!humanId || !gc.roundController) return null;
        var tank = gc.roundController.getTank(humanId);
        if (!tank) return null;
        return {
            x: tank.getX(),
            y: tank.getY(),
            rotation: tank.getRotation()
        };
    }

    function buildEmitterConfigExport() {
        return {
            format: EMITTER_CONFIG_FORMAT,
            version: CONFIG_VERSION,
            savedAt: new Date().toISOString(),
            emitters: state.emitters.map(serializeEmitterParams)
        };
    }

    function buildLevelExport(levelName) {
        var gc = getActiveGameController();
        var emitters = [];
        var i;
        for (i = 0; i < state.emitters.length; i++) {
            emitters.push(serializeEmitterForLevel(state.emitters[i], gc));
        }
        return {
            format: LEVEL_FORMAT,
            version: CONFIG_VERSION,
            savedAt: new Date().toISOString(),
            name: levelName || '训练关卡',
            settings: cloneJson(state.settings || defaultSettings()),
            maze: getCurrentMazeData(gc),
            humanSpawn: getCurrentHumanSpawn(gc),
            emitters: emitters,
            runtime: serializeRuntimeForExport()
        };
    }

    function buildMapGenExport() {
        return {
            format: MAP_GEN_FORMAT,
            version: CONFIG_VERSION,
            savedAt: new Date().toISOString(),
            mapGen: cloneJson(state.mapGen || defaultMapGenSettings())
        };
    }

    function validateEmitterConfig(data) {
        return data && data.format === EMITTER_CONFIG_FORMAT && Array.isArray(data.emitters);
    }

    function validateLevelConfig(data) {
        return data && data.format === LEVEL_FORMAT && Array.isArray(data.emitters) && data.maze && data.maze.tiles;
    }

    function validateMapGenConfig(data) {
        if (!data) return false;
        if (data.format === MAP_GEN_FORMAT && data.mapGen) return true;
        return data.ranked != null || data.symmetric != null || data.theme != null;
    }

    function normalizeMapGenSettings(src) {
        var base = defaultMapGenSettings();
        if (!src || typeof src !== 'object') return base;
        var raw = src.mapGen && typeof src.mapGen === 'object' ? src.mapGen : src;
        if (typeof raw.ranked === 'boolean') base.ranked = raw.ranked;
        if (typeof raw.symmetric === 'boolean') base.symmetric = raw.symmetric;
        if (typeof raw.theme === 'number' && !isNaN(raw.theme)) base.theme = raw.theme;
        if (typeof raw.maxActivePlayerCount === 'number' && raw.maxActivePlayerCount >= 2) {
            base.maxActivePlayerCount = Math.min(8, Math.floor(raw.maxActivePlayerCount));
        }
        if (Array.isArray(raw.crateTypes)) {
            base.crateTypes = raw.crateTypes.slice();
            base.spawns.crateTypes = raw.crateTypes.slice();
        }
        if (raw.maze && typeof raw.maze === 'object') {
            mergeMapGenMaze(base.maze, raw.maze);
        }
        if (raw.spawns && typeof raw.spawns === 'object') {
            mergeMapGenSpawns(base.spawns, raw.spawns);
            if (Array.isArray(raw.spawns.crateTypes)) {
                base.crateTypes = raw.spawns.crateTypes.slice();
            }
        }
        ensureMapGenMazeDefaults(base);
        return base;
    }

    function ensureMapGenMazeDefaults(mg) {
        if (!mg) return;
        if (!mg.maze) mg.maze = defaultMapGenMaze();
        if (!mg.spawns) {
            mg.spawns = defaultMapGenSpawns(mg.crateTypes || [0, 1, 2, 3, 4, 5, 6]);
        }
        var mc = mg.maze;
        if (mc.wallProbability == null) {
            if (typeof Constants !== 'undefined' && Constants.MAZE &&
                Constants.MAZE.WALL_PROBABILITIES && Constants.MAZE.WALL_PROBABILITIES.length) {
                mc.wallProbability = Constants.MAZE.WALL_PROBABILITIES[0];
            } else {
                mc.wallProbability = 0.8;
            }
        }
        if (mc.tileProbability == null) {
            if (typeof Constants !== 'undefined' && Constants.MAZE &&
                Constants.MAZE.TILE_PROBABILITIES && Constants.MAZE.TILE_PROBABILITIES.length) {
                mc.tileProbability = Constants.MAZE.TILE_PROBABILITIES[0];
            } else {
                mc.tileProbability = 0.7;
            }
        }
    }

    function mergeMapGenMaze(dst, src) {
        var keys = [
            'fixedWidth', 'fixedHeight', 'widthMultiplierMin', 'widthMultiplierMax',
            'heightMultiplierMin', 'heightMultiplierMax', 'wallProbability', 'tileProbability',
            'minReachableRatio', 'minTilesBetweenTanks', 'minTilesPerTank', 'maxDeadEndPenalty',
            'borderOnly'
        ];
        var i;
        for (i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (k === 'borderOnly') {
                if (typeof src[k] === 'boolean') dst[k] = src[k];
            } else if (src[k] != null && !isNaN(src[k])) {
                dst[k] = src[k];
            }
        }
    }

    function mergeMapGenSpawns(dst, src) {
        var keys = [
            'maxCrates', 'crateSpawnMinSec', 'crateSpawnVarianceSec', 'crateMinTilesToTanks',
            'maxGolds', 'goldMinTilesToTanks', 'maxDiamonds', 'diamondMinTilesToTanks'
        ];
        var i;
        for (i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (src[k] != null && !isNaN(src[k])) dst[k] = src[k];
        }
        if (Array.isArray(src.crateTypes)) dst.crateTypes = src.crateTypes.slice();
    }

    function defaultMapGenMaze() {
        return {
            fixedWidth: null,
            fixedHeight: null,
            widthMultiplierMin: 1.0,
            widthMultiplierMax: 1.5,
            heightMultiplierMin: 1.0,
            heightMultiplierMax: 1.5,
            wallProbability: null,
            tileProbability: null,
            minReachableRatio: 1.0,
            minTilesBetweenTanks: 4,
            minTilesPerTank: 5,
            maxDeadEndPenalty: 5,
            borderOnly: false
        };
    }

    function defaultMapGenSpawns(crateTypes) {
        return {
            crateTypes: crateTypes.slice(),
            maxCrates: 3,
            crateSpawnMinSec: 3,
            crateSpawnVarianceSec: 5,
            crateMinTilesToTanks: 4,
            maxGolds: 3,
            goldMinTilesToTanks: 5,
            maxDiamonds: 1,
            diamondMinTilesToTanks: 6
        };
    }

    function defaultMapGenSettings() {
        var themeRandom = 4;
        var maxPlayers = 8;
        var crates = [0, 1, 2, 3, 4, 5, 6];
        if (typeof Constants !== 'undefined') {
            if (Constants.MAZE_THEMES && Constants.MAZE_THEMES.RANDOM != null) {
                themeRandom = Constants.MAZE_THEMES.RANDOM;
            }
            if (Constants.GAME && Constants.GAME.MAX_ACTIVE_PLAYERS) {
                maxPlayers = Constants.GAME.MAX_ACTIVE_PLAYERS;
            } else if (Constants.CLIENT && Constants.CLIENT.MAX_PLAYERS) {
                maxPlayers = Math.max(Constants.CLIENT.MAX_PLAYERS, 8);
            }
            if (Constants.GAME_MODES && Constants.GAME_MODE_INFO &&
                Constants.GAME_MODE_INFO[Constants.GAME_MODES.BOOT_CAMP]) {
                crates = Constants.GAME_MODE_INFO[Constants.GAME_MODES.BOOT_CAMP]
                    .DEFAULT_AVAILABLE_CRATES.slice();
            }
            var mc = defaultMapGenMaze();
            if (Constants.MAZE) {
                mc.widthMultiplierMax = Constants.MAZE.MAX_RANDOM_WIDTH_MULTIPLIER || 1.5;
                mc.heightMultiplierMax = Constants.MAZE.MAX_RANDOM_HEIGHT_MULTIPLIER || 1.5;
            }
            if (Constants.MAZE_MINIMUM_REACHABLE_RATIO != null) {
                mc.minReachableRatio = Constants.MAZE_MINIMUM_REACHABLE_RATIO;
            }
            if (Constants.MAZE_MINIMUM_TILES_BETWEEN_TANKS != null) {
                mc.minTilesBetweenTanks = Constants.MAZE_MINIMUM_TILES_BETWEEN_TANKS;
            }
            if (Constants.MAZE_MINIMUM_TILES_PER_TANK != null) {
                mc.minTilesPerTank = Constants.MAZE_MINIMUM_TILES_PER_TANK;
            }
            if (Constants.MAZE_MAX_DEAD_END_PENALTY != null) {
                mc.maxDeadEndPenalty = Constants.MAZE_MAX_DEAD_END_PENALTY;
            }
            if (Constants.MAZE && Constants.MAZE.WALL_PROBABILITIES && Constants.MAZE.WALL_PROBABILITIES.length) {
                mc.wallProbability = Constants.MAZE.WALL_PROBABILITIES[0];
            }
            if (Constants.MAZE && Constants.MAZE.TILE_PROBABILITIES && Constants.MAZE.TILE_PROBABILITIES.length) {
                mc.tileProbability = Constants.MAZE.TILE_PROBABILITIES[0];
            }
            var sp = defaultMapGenSpawns(crates);
            if (Constants.MAX_CRATES != null) sp.maxCrates = Constants.MAX_CRATES;
            if (Constants.CRATE_SPAWN_DURATION_MIN != null) sp.crateSpawnMinSec = Constants.CRATE_SPAWN_DURATION_MIN;
            if (Constants.CRATE_SPAWN_DURATION_VARIANCE != null) {
                sp.crateSpawnVarianceSec = Constants.CRATE_SPAWN_DURATION_VARIANCE;
            }
            if (Constants.CRATE_MINIMUM_TILES_TO_TANKS != null) {
                sp.crateMinTilesToTanks = Constants.CRATE_MINIMUM_TILES_TO_TANKS;
            }
            if (Constants.MAX_GOLDS != null) sp.maxGolds = Constants.MAX_GOLDS;
            if (Constants.GOLD_MINIMUM_TILES_TO_TANKS != null) {
                sp.goldMinTilesToTanks = Constants.GOLD_MINIMUM_TILES_TO_TANKS;
            }
            if (Constants.MAX_DIAMONDS != null) sp.maxDiamonds = Constants.MAX_DIAMONDS;
            if (Constants.DIAMOND_MINIMUM_TILES_TO_TANKS != null) {
                sp.diamondMinTilesToTanks = Constants.DIAMOND_MINIMUM_TILES_TO_TANKS;
            }
            return {
                ranked: false,
                symmetric: false,
                theme: themeRandom,
                maxActivePlayerCount: maxPlayers,
                crateTypes: crates,
                maze: mc,
                spawns: sp
            };
        }
        return {
            ranked: false,
            symmetric: false,
            theme: themeRandom,
            maxActivePlayerCount: maxPlayers,
            crateTypes: crates,
            maze: defaultMapGenMaze(),
            spawns: defaultMapGenSpawns(crates)
        };
    }

    function captureVanillaConstants() {
        if (state._vanillaConstants || typeof Constants === 'undefined') return;
        state._vanillaConstants = {
            MAZE: cloneJson(Constants.MAZE),
            MAZE_MINIMUM_REACHABLE_RATIO: Constants.MAZE_MINIMUM_REACHABLE_RATIO,
            MAZE_MINIMUM_TILES_BETWEEN_TANKS: Constants.MAZE_MINIMUM_TILES_BETWEEN_TANKS,
            MAZE_MINIMUM_TILES_PER_TANK: Constants.MAZE_MINIMUM_TILES_PER_TANK,
            MAZE_MAX_DEAD_END_PENALTY: Constants.MAZE_MAX_DEAD_END_PENALTY,
            MAX_CRATES: Constants.MAX_CRATES,
            CRATE_SPAWN_DURATION_MIN: Constants.CRATE_SPAWN_DURATION_MIN,
            CRATE_SPAWN_DURATION_VARIANCE: Constants.CRATE_SPAWN_DURATION_VARIANCE,
            CRATE_MINIMUM_TILES_TO_TANKS: Constants.CRATE_MINIMUM_TILES_TO_TANKS,
            MAX_GOLDS: Constants.MAX_GOLDS,
            GOLD_MINIMUM_TILES_TO_TANKS: Constants.GOLD_MINIMUM_TILES_TO_TANKS,
            MAX_DIAMONDS: Constants.MAX_DIAMONDS,
            DIAMOND_MINIMUM_TILES_TO_TANKS: Constants.DIAMOND_MINIMUM_TILES_TO_TANKS
        };
    }

    function restoreVanillaConstants() {
        if (!state._vanillaConstants || typeof Constants === 'undefined') return;
        var v = state._vanillaConstants;
        Constants.MAZE = cloneJson(v.MAZE);
        Constants.MAZE_MINIMUM_REACHABLE_RATIO = v.MAZE_MINIMUM_REACHABLE_RATIO;
        Constants.MAZE_MINIMUM_TILES_BETWEEN_TANKS = v.MAZE_MINIMUM_TILES_BETWEEN_TANKS;
        Constants.MAZE_MINIMUM_TILES_PER_TANK = v.MAZE_MINIMUM_TILES_PER_TANK;
        Constants.MAZE_MAX_DEAD_END_PENALTY = v.MAZE_MAX_DEAD_END_PENALTY;
        Constants.MAX_CRATES = v.MAX_CRATES;
        Constants.CRATE_SPAWN_DURATION_MIN = v.CRATE_SPAWN_DURATION_MIN;
        Constants.CRATE_SPAWN_DURATION_VARIANCE = v.CRATE_SPAWN_DURATION_VARIANCE;
        Constants.CRATE_MINIMUM_TILES_TO_TANKS = v.CRATE_MINIMUM_TILES_TO_TANKS;
        Constants.MAX_GOLDS = v.MAX_GOLDS;
        Constants.GOLD_MINIMUM_TILES_TO_TANKS = v.GOLD_MINIMUM_TILES_TO_TANKS;
        Constants.MAX_DIAMONDS = v.MAX_DIAMONDS;
        Constants.DIAMOND_MINIMUM_TILES_TO_TANKS = v.DIAMOND_MINIMUM_TILES_TO_TANKS;
    }

    function applyTrainingMazeConstants(overrides) {
        if (!state.mapGen || !state.mapGen.maze || typeof Constants === 'undefined') return;
        captureVanillaConstants();
        var mc = state.mapGen.maze;
        overrides = overrides || {};
        var wallProb = overrides.wallProbability != null ? overrides.wallProbability
            : (mc.borderOnly ? 0 : mc.wallProbability);
        var tileProb = overrides.tileProbability != null ? overrides.tileProbability
            : (mc.borderOnly ? 1 : mc.tileProbability);
        if (wallProb != null) {
            Constants.MAZE.WALL_PROBABILITIES = [wallProb];
        }
        if (tileProb != null) {
            Constants.MAZE.TILE_PROBABILITIES = [tileProb];
        }
        var reachable = overrides.minReachableRatio != null ? overrides.minReachableRatio : mc.minReachableRatio;
        if (reachable != null) {
            Constants.MAZE_MINIMUM_REACHABLE_RATIO = reachable;
        }
        var between = overrides.minTilesBetweenTanks != null ? overrides.minTilesBetweenTanks : mc.minTilesBetweenTanks;
        if (between != null) {
            Constants.MAZE_MINIMUM_TILES_BETWEEN_TANKS = between;
        }
        if (mc.minTilesPerTank != null) {
            Constants.MAZE_MINIMUM_TILES_PER_TANK = mc.minTilesPerTank;
        }
        if (mc.maxDeadEndPenalty != null) {
            Constants.MAZE_MAX_DEAD_END_PENALTY = mc.maxDeadEndPenalty;
        }
    }

    function restoreTrainingMazeConstants() {
        if (!state._vanillaConstants) return;
        if (typeof Constants === 'undefined') return;
        Constants.MAZE = cloneJson(state._vanillaConstants.MAZE);
        Constants.MAZE_MINIMUM_REACHABLE_RATIO = state._vanillaConstants.MAZE_MINIMUM_REACHABLE_RATIO;
        Constants.MAZE_MINIMUM_TILES_BETWEEN_TANKS = state._vanillaConstants.MAZE_MINIMUM_TILES_BETWEEN_TANKS;
        Constants.MAZE_MINIMUM_TILES_PER_TANK = state._vanillaConstants.MAZE_MINIMUM_TILES_PER_TANK;
        Constants.MAZE_MAX_DEAD_END_PENALTY = state._vanillaConstants.MAZE_MAX_DEAD_END_PENALTY;
    }

    function applyTrainingSpawnConstants() {
        if (!state.mapGen || !state.mapGen.spawns || typeof Constants === 'undefined') return;
        captureVanillaConstants();
        var sp = state.mapGen.spawns;
        if (sp.maxCrates != null) Constants.MAX_CRATES = sp.maxCrates;
        if (sp.crateSpawnMinSec != null) Constants.CRATE_SPAWN_DURATION_MIN = sp.crateSpawnMinSec;
        if (sp.crateSpawnVarianceSec != null) {
            Constants.CRATE_SPAWN_DURATION_VARIANCE = sp.crateSpawnVarianceSec;
        }
        if (sp.crateMinTilesToTanks != null) {
            Constants.CRATE_MINIMUM_TILES_TO_TANKS = sp.crateMinTilesToTanks;
        }
        if (sp.maxGolds != null) Constants.MAX_GOLDS = sp.maxGolds;
        if (sp.goldMinTilesToTanks != null) {
            Constants.GOLD_MINIMUM_TILES_TO_TANKS = sp.goldMinTilesToTanks;
        }
        if (sp.maxDiamonds != null) Constants.MAX_DIAMONDS = sp.maxDiamonds;
        if (sp.diamondMinTilesToTanks != null) {
            Constants.DIAMOND_MINIMUM_TILES_TO_TANKS = sp.diamondMinTilesToTanks;
        }
    }

    function createTrainingMaze(gameMode, playerIds, theme) {
        if (typeof Maze === 'undefined' || typeof Constants === 'undefined') return null;
        var mazeCfg = (state.mapGen && state.mapGen.maze) ? state.mapGen.maze : {};
        // —— 安全接口①：剔除发射源伪玩家 ——
        // 引擎 initializeRound 用 getMaze(getActivePlayerIds()) 生成地图，发射源（固定炮台）
        // 也在其中。它们不参与坦克布位：不过滤时多源+固定小图会令 createRandom 的
        // 间距放置无解 → while(true) 死循环 → 网页未响应（实测 10×8 图 +12 源 + 间距4 必死）。
        var mazePlayerIds = [];
        var mpi;
        for (mpi = 0; mpi < (playerIds ? playerIds.length : 0); mpi++) {
            if (!isEmitterId(playerIds[mpi])) mazePlayerIds.push(playerIds[mpi]);
        }
        if (!mazePlayerIds.length && playerIds && playerIds.length) mazePlayerIds = [playerIds[0]];
        var refPlayers = (state.mapGen && state.mapGen.maxActivePlayerCount)
            ? state.mapGen.maxActivePlayerCount
            : mazePlayerIds.length;
        var n = Math.min(Math.max(refPlayers, 1), 8);
        var idx = Math.min(n, Constants.MAZE.WIDTH_FOR_PLAYERS.length - 1);
        var baseW = Constants.MAZE.BASE_WIDTH + Constants.MAZE.WIDTH_FOR_PLAYERS[idx];
        var baseH = Constants.MAZE.BASE_HEIGHT + Constants.MAZE.HEIGHT_FOR_PLAYERS[idx];
        var wLo = mazeCfg.widthMultiplierMin != null ? mazeCfg.widthMultiplierMin : 1.0;
        var wHi = mazeCfg.widthMultiplierMax != null ? mazeCfg.widthMultiplierMax : Constants.MAZE.MAX_RANDOM_WIDTH_MULTIPLIER;
        var hLo = mazeCfg.heightMultiplierMin != null ? mazeCfg.heightMultiplierMin : 1.0;
        var hHi = mazeCfg.heightMultiplierMax != null ? mazeCfg.heightMultiplierMax : Constants.MAZE.MAX_RANDOM_HEIGHT_MULTIPLIER;
        var wMult = Math.random() * (wHi - wLo) + wLo;
        var hMult = Math.random() * (hHi - hLo) + hLo;
        // —— 安全接口③：参数 clamp ——
        // 面板允许手输任意数字：fixedWidth/Height=0 或负数会让 Maze.createSymmetric
        // 在 0×0 block 上无限 continue（实测 20 万次迭代撞上限），概率超 [0,1]、
        // 负间距同样会破坏生成器约定。生成前统一夹回安全区间（不改用户配置本身）。
        var safeMinSide = 6;   // 实测下限：对称 6×6 安全（2×2 亦可，取 6 留裕量）
        var width = mazeCfg.fixedWidth != null && mazeCfg.fixedWidth >= safeMinSide
            ? Math.min(mazeCfg.fixedWidth, Constants.MAZE.MAX_WIDTH)
            : Math.min(Constants.MAZE.MAX_WIDTH, Math.floor(baseW * wMult));
        var height = mazeCfg.fixedHeight != null && mazeCfg.fixedHeight >= safeMinSide
            ? Math.min(mazeCfg.fixedHeight, Constants.MAZE.MAX_HEIGHT)
            : Math.min(Constants.MAZE.MAX_HEIGHT, Math.floor(baseH * hMult));
        width = Math.max(width, safeMinSide);
        height = Math.max(height, safeMinSide);
        var effectiveTheme = gameMode.ranked ? Constants.MAZE_THEMES.STANDARD : theme;
        var borderOnly = !!mazeCfg.borderOnly;
        var openArena = borderOnly || (mazeCfg.wallProbability === 0 && mazeCfg.tileProbability === 1);
        var useSymmetric = !!gameMode.symmetric && !openArena;
        // —— 安全接口②：非对称路径坦克容量预检 ——
        // createRandom 按切比雪夫间距 d 逐个放坦克，容量约 ceil(W/(d+1))*ceil(H/(d+1))+2
        // （实测 10×8/d4：≤6 稳定、8 需 291 次重试、14 死循环）。超容时自动收紧间距
        // 兜底（d=2 实测 10×8 图 14 坦克 2 次迭代即成），杜绝手动配置组合出的死循环。
        var cfgBetween = mazeCfg.minTilesBetweenTanks != null
            ? Math.max(0, Math.round(mazeCfg.minTilesBetweenTanks))
            : Constants.MAZE_MINIMUM_TILES_BETWEEN_TANKS;
        var minBetween = cfgBetween;
        var overrides = openArena ? { wallProbability: 0, tileProbability: 1 } : null;
        if (!openArena) {
            // 概率夹回 [0,1]（面板手输可能越界）
            overrides = {
                wallProbability: Math.min(1, Math.max(0, mazeCfg.wallProbability != null ? mazeCfg.wallProbability : 0.8)),
                tileProbability: Math.min(1, Math.max(0, mazeCfg.tileProbability != null ? mazeCfg.tileProbability : 0.7))
            };
        }
        if (!useSymmetric) {
            while (minBetween > 0 &&
                   mazePlayerIds.length > Math.ceil(width / (minBetween + 1)) * Math.ceil(height / (minBetween + 1)) + 2) {
                minBetween--;
            }
            if (minBetween !== cfgBetween) {
                overrides.minTilesBetweenTanks = minBetween;
            }
        }
        applyTrainingMazeConstants(overrides);
        try {
            var generated = useSymmetric
                ? Maze.createSymmetric(width, height, mazePlayerIds, effectiveTheme)
                : Maze.createRandom(width, height, mazePlayerIds, effectiveTheme);
            // 结果校验：tiles 非空 + 坦克布位齐全，防止半成品图流入引擎导致白屏
            if (!generated || !generated.data || !generated.data.tiles ||
                !generated.data.tiles.length || !generated.data.tiles[0] ||
                !generated.data.tiles[0].length ||
                !generated.tankPositions || generated.tankPositions.length < mazePlayerIds.length) {
                console.error('[Training Mode] 地图生成校验失败，尺寸', width + 'x' + height);
                return null;
            }
            return generated;
        } catch (eMaze) {
            console.error('[Training Mode] 地图生成异常:', eMaze);
            return null;
        } finally {
            restoreTrainingMazeConstants();
        }
    }

    /* ---------- 地图缓存：优先用做好的地图，miss 才按参数随机生成 ---------- */

    function mapGenCacheKey(playerIds) {
        // 指纹 = 地图生成参数 + 真实玩家列表（发射源已剔除）。任一变化 → 缓存失效。
        var mg = state.mapGen || {};
        var mc = mg.maze || {};
        var real = [];
        var i;
        for (i = 0; i < (playerIds ? playerIds.length : 0); i++) {
            if (!isEmitterId(playerIds[i])) real.push(String(playerIds[i]));
        }
        return JSON.stringify([
            real,
            mg.ranked, mg.symmetric, mg.theme, mg.maxActivePlayerCount,
            mc.fixedWidth, mc.fixedHeight,
            mc.widthMultiplierMin, mc.widthMultiplierMax,
            mc.heightMultiplierMin, mc.heightMultiplierMax,
            mc.wallProbability, mc.tileProbability, mc.borderOnly,
            mc.minReachableRatio, mc.minTilesBetweenTanks,
            mc.minTilesPerTank, mc.maxDeadEndPenalty
        ]);
    }

    function restoreCachedMaze(cache, playerIds) {
        // withObject 不会重建 tankPositions（fields 默认 []）：从缓存恢复，
        // 并校验布位玩家集合与当前真实玩家一致，不一致视为缓存不可用。
        if (!cache || !cache.data || !Array.isArray(cache.tankPositions)) return null;
        var real = {};
        var i;
        for (i = 0; i < (playerIds ? playerIds.length : 0); i++) {
            if (!isEmitterId(playerIds[i])) real[String(playerIds[i])] = true;
        }
        var cached = {};
        for (i = 0; i < cache.tankPositions.length; i++) {
            cached[String(cache.tankPositions[i].playerId)] = true;
        }
        var k;
        for (k in real) if (!cached[k]) return null;
        for (k in cached) if (!real[k]) return null;
        try {
            var maze = Maze.withObject(cloneJson(cache.data));
            maze.tankPositions = cloneJson(cache.tankPositions);
            return maze;
        } catch (eRestore) {
            console.error('[Training Mode] 缓存地图恢复失败:', eRestore);
            return null;
        }
    }

    function getOrGenerateTrainingMaze(gm, playerIds, theme, fallbackGetMaze) {
        if (state.fixedMazeData && typeof Maze !== 'undefined') {
            return Maze.withObject(cloneJson(state.fixedMazeData));
        }
        var key = mapGenCacheKey(playerIds);
        var cache = state.mapGenCache;
        // ① 参数未变：直接复用做好的地图（基准多局同图，公平且免重复生成）
        if (cache && cache.key === key) {
            var restored = restoreCachedMaze(cache, playerIds);
            if (restored) return restored;
        }
        // ② 按当前参数随机生成（内部已做 clamp/容量预检/异常保护/结果校验）
        var maze = createTrainingMaze(gm, playerIds, theme);
        if (maze) {
            state.mapGenCache = {
                key: key,
                data: cloneJson(maze.data),
                tankPositions: cloneJson(maze.tankPositions)
            };
            return maze;
        }
        // ③ 生成失败：退回旧参数的缓存地图（宁可用旧图也不白屏）
        if (cache && cache.data) {
            var fallbackRestored = restoreCachedMaze(cache, playerIds);
            if (fallbackRestored) {
                console.warn('[Training Mode] 当前参数生成失败，已回退上一张可用地图');
                return fallbackRestored;
            }
        }
        // ④ 全失败：交给引擎原生 getMaze（vanilla 常量，官方参数，绝对安全）
        console.warn('[Training Mode] 训练地图生成彻底失败，回退引擎原生生成');
        state.mapGenCache = null;
        return fallbackGetMaze ? fallbackGetMaze.call(gm, playerIds, theme) : null;
    }

    function loadMapGenSettings() {
        state.mapGen = defaultMapGenSettings();
        try {
            var raw = localStorage.getItem(MAP_GEN_KEY);
            if (!raw) {
                ensureMapGenMazeDefaults(state.mapGen);
                return;
            }
            state.mapGen = normalizeMapGenSettings(JSON.parse(raw));
        } catch (e) { /* ignore */ }
        ensureMapGenMazeDefaults(state.mapGen);
    }

    function saveMapGenSettings() {
        if (!state.mapGen) return;
        try {
            localStorage.setItem(MAP_GEN_KEY, JSON.stringify(state.mapGen));
        } catch (e) { /* ignore */ }
    }

    function applyMapGenToGameController(gc) {
        if (!gc || !state.mapGen) return;
        var mg = state.mapGen;
        gc.ranked = !!mg.ranked;
        gc.symmetric = !!mg.symmetric;
        gc.storm = false;
        gc.premium = false;
        var crates = (mg.spawns && mg.spawns.crateTypes) ? mg.spawns.crateTypes : mg.crateTypes;
        gc.crateTypes = crates.slice();
        mg.crateTypes = gc.crateTypes.slice();
        if (gc.gameMode) {
            if (typeof gc.gameMode.setRanked === 'function') gc.gameMode.setRanked(gc.ranked);
            if (typeof gc.gameMode.setSymmetric === 'function') gc.gameMode.setSymmetric(gc.symmetric);
            if (typeof gc.gameMode.setStorm === 'function') gc.gameMode.setStorm(false);
            if (typeof gc.gameMode.setCrateTypes === 'function') gc.gameMode.setCrateTypes(gc.crateTypes);
        }
        if (gc.model && typeof gc.model.setTheme === 'function') {
            gc.model.setTheme(mg.theme);
        }
        applyTrainingSpawnConstants();
    }

    function getMapGenThemeOptions() {
        var themes = (typeof Constants !== 'undefined' && Constants.MAZE_THEMES)
            ? Constants.MAZE_THEMES : {};
        return [
            { value: themes.RANDOM != null ? themes.RANDOM : 4, label: '随机主题' },
            { value: themes.STANDARD != null ? themes.STANDARD : 0, label: '标准' },
            { value: themes.HALLOWEEN != null ? themes.HALLOWEEN : 1, label: '万圣节' },
            { value: themes.CHRISTMAS != null ? themes.CHRISTMAS : 2, label: '圣诞' }
        ];
    }

    function getMapGenCrateOptions() {
        return [
            { value: 0, label: '激光武器箱' },
            { value: 1, label: '双管炮武器箱' },
            { value: 2, label: '霰弹枪武器箱' },
            { value: 3, label: '追踪导弹武器箱' },
            { value: 4, label: '地雷武器箱' },
            { value: 5, label: '加特林武器箱' },
            { value: 6, label: '护盾武器箱' }
        ];
    }

    function downloadJsonFile(filename, data) {
        var json = JSON.stringify(data, null, 2);
        var blob = new Blob([json], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function exportEmitterConfig() {
        var data = buildEmitterConfigExport();
        var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        downloadJsonFile('training-emitters-' + stamp + '.json', data);
    }

    function exportLevelConfig() {
        var nameInput = document.getElementById('tt-level-export-name');
        var levelName = nameInput && nameInput.value ? nameInput.value.trim() : '';
        var data = buildLevelExport(levelName);
        if (!data.maze) {
            throw new Error('当前没有可导出的地图，请先进入训练对局');
        }
        var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        var safeName = (levelName || 'training-level').replace(/[^\w\u4e00-\u9fff-]+/g, '-');
        downloadJsonFile(safeName + '-' + stamp + '.json', data);
    }

    function exportMapGenConfig() {
        var data = buildMapGenExport();
        var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        downloadJsonFile('training-map-gen-' + stamp + '.json', data);
    }

    function applyEmitterConfig(data) {
        if (!validateEmitterConfig(data)) {
            throw new Error('无效的发射源配置：需要 tt_training_emitters 格式');
        }
        var byId = {};
        var i;
        for (i = 0; i < state.emitters.length; i++) {
            byId[state.emitters[i].id] = state.emitters[i];
        }
        for (i = 0; i < data.emitters.length; i++) {
            var src = cloneJson(data.emitters[i]);
            normalizeEmitterConfig(src);
            if (byId[src.id]) {
                var keep = byId[src.id];
                keep.name = src.name;
                keep.rotateSpeed = src.rotateSpeed;
                keep.directionRandomness = src.directionRandomness;
                keep.minShootInterval = src.minShootInterval;
                keep.bulletCount = src.bulletCount;
                keep.magazineRecoverySec = src.magazineRecoverySec;
                keep.weaponType = src.weaponType;
            } else {
                state.emitters.push(src);
                primeEmitterPlayerCache(src.id);
            }
        }
        saveEmitters();
        var gc = getActiveGameController();
        if (state.inTrainingGame && gc) {
            // 移除模板里已不存在的旧发射源玩家，否则旧单点会一直残留。
            var newIds = {};
            for (oi = 0; oi < state.emitters.length; oi++) newIds[state.emitters[oi].id] = true;
            for (oi in oldIds) {
                if (oldIds.hasOwnProperty(oi) && !newIds[oi] && gc.removePlayer) {
                    try { gc.removePlayer(oi); } catch (eRemove) {}
                }
            }
            ensureEmitterPlayers(gc);
            var j;
            for (j = 0; j < state.emitters.length; j++) {
                applyEmitterWeapon(gc, state.emitters[j]);
            }
            updateEmitterAmmoHUD(gc);
        }
        refreshEmitterList();
    }

    function applyLevelConfig(data, opts) {
        opts = opts || {};
        if (!validateLevelConfig(data)) {
            throw new Error('无效的训练关卡：需要包含地图与发射源');
        }
        if (data.settings) {
            state.settings = cloneJson(data.settings);
            saveSettings();
            syncSettingsUI();
        }
        state.fixedMazeData = cloneJson(data.maze);
        state.fixedHumanSpawn = data.humanSpawn ? cloneJson(data.humanSpawn) : null;
        state.emitters = [];
        var i;
        for (i = 0; i < data.emitters.length; i++) {
            var em = cloneJson(data.emitters[i]);
            normalizeEmitterConfig(em);
            state.emitters.push(em);
            primeEmitterPlayerCache(em.id);
        }
        saveEmitters();
        restoreRuntimeFromSnapshot(data.runtime);
        state.useFixedEmitterPositions = true;
        var gc = getActiveGameController();
        if (state.inTrainingGame && gc) {
            releaseAllGatlingBursts(gc);
            if (opts.restartMap !== false) {
                restartTrainingMap(state.running, { keepFixedLevel: true });
            } else {
                ensureEmitterPlayers(gc);
                spawnTrainingTanksForFixedMaze(gc);
                applyEmitterPositionsFromConfig(gc);
                updateEmitterAmmoHUD(gc);
            }
            updateStatsUI();
            updateStatusLine();
        }
        refreshEmitterList();
        var nameEl = document.getElementById('tt-level-export-name');
        if (nameEl && data.name) nameEl.value = data.name;
    }

    function applyMapGenConfig(data) {
        if (!validateMapGenConfig(data)) {
            throw new Error('无效的地图生成配置');
        }
        state.mapGen = normalizeMapGenSettings(data);
        saveMapGenSettings();
        syncMapGenUI();
        var gc = getActiveGameController();
        if (gc) applyMapGenToGameController(gc);
    }

    function importJsonFromFile(file, handler) {
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function() {
            try {
                handler(JSON.parse(reader.result));
            } catch (err) {
                window.alert('导入失败：' + (err.message || String(err)));
            }
        };
        reader.readAsText(file);
    }

    function fetchConfigList(category) {
        return fetch(CONFIG_API + '/' + category).then(function(res) {
            return res.json();
        });
    }

    function loadConfigFromServer(category, filename) {
        return fetch(CONFIG_API + '/' + category + '/' + encodeURIComponent(filename))
            .then(function(res) { return res.json(); })
            .then(function(payload) {
                if (!payload.ok) throw new Error(payload.error || '加载失败');
                return payload.data;
            });
    }

    function saveConfigToServer(category, filename, data) {
        return fetch(CONFIG_API + '/' + category + '/' + encodeURIComponent(filename), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }).then(function(res) { return res.json(); })
            .then(function(payload) {
                if (!payload.ok) throw new Error(payload.error || '保存失败');
                return payload.filename;
            });
    }

    function refreshServerConfigSelect(category, selectId) {
        var select = document.getElementById(selectId);
        if (!select) return;
        fetchConfigList(category).then(function(payload) {
            if (!payload.ok) return;
            var files = payload.files || [];
            select.innerHTML = '<option value="">— 服务器配置 —</option>';
            var i;
            for (i = 0; i < files.length; i++) {
                var opt = document.createElement('option');
                opt.value = files[i];
                opt.textContent = files[i];
                select.appendChild(opt);
            }
        }).catch(function() { /* offline */ });
    }

    function spawnTrainingTanksForFixedMaze(gc) {
        // 手动补坦克：fixedMazeData 路径与 v45 正常生成路径共用。
        // v45 起 createTrainingMaze 过滤发射源伪玩家，引擎只按 maze.tankPositions
        // spawnTank，发射源坦克由这里补齐（配置坐标优先，线源走专用 pose）。
        var rc = gc.roundController;
        if (!rc) return;
        var humanId = getPrimaryHumanId(gc);
        if (humanId && !rc.getTank(humanId)) {
            var spawn = state.fixedHumanSpawn || pickRandomSpawnPosition(rc);
            if (spawn) rc.spawnTank(humanId, spawn, false);
        }
        var i;
        for (i = 0; i < state.emitters.length; i++) {
            var em = state.emitters[i];
            if (rc.getTank(em.id)) continue;
            if (isLineEmitter(em)) {
                if (hasLineWall(em)) {
                    var linePose = getLineEmitterSpawnPose(em, getRuntime(em.id));
                    if (linePose) rc.spawnTank(em.id, linePose, false);
                }
                continue;
            }
            var pos = (em.x != null && em.y != null)
                ? { x: em.x, y: em.y, rotation: em.rotation != null ? em.rotation : 0 }
                : pickRandomSpawnPosition(rc);
            if (pos) rc.spawnTank(em.id, pos, false);
        }
    }

    function installTrainingGetMazeHook(gc) {
        if (!gc || !gc.gameMode || state.fixedMazeData) return null;
        if (!state.inTrainingGame) return null;
        if (!state.mapGen) loadMapGenSettings();
        var gm = gc.gameMode;
        var prev = gm.getMaze;
        gm.getMaze = function(playerIds, theme) {
            if (state.fixedMazeData && typeof Maze !== 'undefined') {
                return Maze.withObject(cloneJson(state.fixedMazeData));
            }
            return getOrGenerateTrainingMaze(this, playerIds, theme, prev);
        };
        return { gm: gm, prev: prev };
    }

    function restoreTrainingGetMazeHook(token) {
        if (token && token.gm && token.prev) {
            token.gm.getMaze = token.prev;
        }
    }

    function trainingAfterInitializeRound(gc, origInitRound) {
        ensureEmitterPlayers(gc);
        if (!state.mapGen) loadMapGenSettings();
        applyMapGenToGameController(gc);
        applyTrainingSpawnConstants();
        var mazeHook = installTrainingGetMazeHook(gc);
        try {
            origInitRound.call(gc);
        } finally {
            restoreTrainingGetMazeHook(mazeHook);
        }
        if (state.fixedMazeData) {
            spawnTrainingTanksForFixedMaze(gc);
            applyEmitterPositionsFromConfig(gc);
            state.useFixedEmitterPositions = false;
        } else {
            // v45：createTrainingMaze 已过滤发射源伪玩家（防布位死循环），引擎
            // 不再为其 spawnTank——这里补齐发射源坦克，再做出生点/位置套用。
            spawnTrainingTanksForFixedMaze(gc);
            // v43：基准出生点只存 mode，开新局后按真实 maze 解析合法格。
            if (state.fixedHumanSpawn && gc.roundController && typeof TankState !== 'undefined') {
                var fixedHumanId = getPrimaryHumanId(gc);
                var fixedHumanTank = fixedHumanId ? gc.roundController.getTank(fixedHumanId) : null;
                if (fixedHumanTank) {
                    var fh = state.fixedHumanSpawn;
                    var spawnPose = fh.mode
                        ? resolveBenchmarkSpawnForExternal(gc.roundController.getMaze(), fh.mode)
                        : { x: fh.x, y: fh.y, rotation: fh.rotation || 0 };
                    if (spawnPose && typeof spawnPose.x === 'number') {
                        var fts = TankState.withState(
                            fixedHumanId, spawnPose.x, spawnPose.y, false, false,
                            spawnPose.rotation || 0, false, false, false, false
                        );
                        gc.roundController.setTankState(fts, false);
                    }
                }
            }
            if (state.useFixedEmitterPositions) {
                applyEmitterPositionsFromConfig(gc);
                state.useFixedEmitterPositions = false;
            } else {
                randomizeEmitterPositions(gc);
            }
        }
        wrapTrainingRoundController(gc.roundController);
    }

    function clearFixedLevel() {
        state.fixedMazeData = null;
        state.fixedHumanSpawn = null;
        state.useFixedEmitterPositions = false;
    }

    function applyEmitterPositionsFromConfig(gc) {
        if (!gc || !gc.roundController) return;
        var rc = gc.roundController;
        var i;
        for (i = 0; i < state.emitters.length; i++) {
            var em = state.emitters[i];
            if (isLineEmitter(em)) {
                if (hasLineWall(em)) {
                    spawnOrMoveLineEmitterTank(gc, em);
                }
                continue;
            }
            if (em.x == null || em.y == null) continue;
            var tank = rc.getTank(em.id);
            if (!tank || typeof TankState === 'undefined') continue;
            var ts = TankState.withState(
                em.id, em.x, em.y, false, false, em.rotation || 0,
                false, false, false, false
            );
            rc.setTankState(ts, false);
            disableEmitterProjectileCollision(rc.getTank(em.id));
            applyEmitterWeapon(gc, em);
        }
    }

    function restoreRuntimeFromSnapshot(snapshotRuntime) {
        state.runtime = {};
        if (!snapshotRuntime) return;
        var id;
        for (id in snapshotRuntime) {
            if (!Object.prototype.hasOwnProperty.call(snapshotRuntime, id)) continue;
            var src = snapshotRuntime[id];
            var em = getEmitterById(id);
            state.runtime[id] = {
                targetWorldAngle: src.targetWorldAngle != null ? src.targetWorldAngle : null,
                ammo: src.ammo != null ? src.ammo : (em ? em.bulletCount : 0),
                cooldown: src.cooldown || 0,
                reloadTimer: src.reloadTimer || 0,
                shotPool: null,
                shotPoolTile: '',
                shotPoolEmitter: null,
                shotIdx: src.shotIdx || 0,
                gatlingBurst: false,
                lineT: src.lineT != null ? src.lineT : 0,
                lineDir: src.lineDir != null ? src.lineDir : 1,
                aimPreview: false
            };
        }
    }

    function formatDuration(sec) {
        sec = Math.max(0, Math.floor(sec || 0));
        var m = Math.floor(sec / 60);
        var s = sec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function initTrainingStats() {
        state.stats = {
            totalSeconds: 0,
            lifeSeconds: 0,
            deaths: 0,
            rounds: 1,
            bestLife: 0,
            lifeStart: null
        };
        state.playerDead = false;
    }

    function getActiveGameController() {
        if (typeof GameManager !== 'undefined' && GameManager.getGameController) {
            return GameManager.getGameController();
        }
        return null;
    }

    function updateStatsUI() {
        var el = document.getElementById('tt-training-stats');
        if (!el || !state.stats) return;
        el.innerHTML = [
            '<div class="tt-stat-row"><span>本局存活</span><strong>' + formatDuration(state.stats.lifeSeconds) + '</strong></div>',
            '<div class="tt-stat-row"><span>最佳存活</span><strong>' + formatDuration(state.stats.bestLife) + '</strong></div>',
            '<div class="tt-stat-row"><span>死亡次数</span><strong>' + state.stats.deaths + '</strong></div>',
            '<div class="tt-stat-row"><span>地图局数</span><strong>' + state.stats.rounds + '</strong></div>',
            '<div class="tt-stat-row"><span>总训练时长</span><strong>' + formatDuration(state.stats.totalSeconds) + '</strong></div>'
        ].join('');
    }

    function updateTrainingStats(deltaTime, gc) {
        if (!state.stats || !state.inTrainingGame) return;
        var humanId = getPrimaryHumanId(gc);
        var humanAlive = humanId && gc.roundController && gc.roundController.getTank(humanId);
        if (state.running && !state.playerDead && humanAlive) {
            if (!state.stats.lifeStart) state.stats.lifeStart = Date.now();
            state.stats.lifeSeconds += deltaTime;
            state.stats.totalSeconds += deltaTime;
        }
        updateStatsUI();
    }

    function showDeathOverlay(lifeSeconds) {
        var overlay = document.getElementById('tt-training-death-overlay');
        var text = document.getElementById('tt-death-survival');
        if (text) text.textContent = '本次存活 ' + formatDuration(lifeSeconds);
        if (overlay) overlay.classList.remove('tt-hidden');
    }

    function hideDeathOverlay() {
        var overlay = document.getElementById('tt-training-death-overlay');
        if (overlay) overlay.classList.add('tt-hidden');
    }

    function onTrainingPlayerDeath(playerId, deathPose) {
        if (!state.inTrainingGame || isEmitterId(playerId) || state.playerDead) return;
        var lastLife = 0;
        if (state.stats) {
            lastLife = state.stats.lifeSeconds;
            state.stats.bestLife = Math.max(state.stats.bestLife, lastLife);
            state.stats.deaths += 1;
            state.stats.lifeSeconds = 0;
            state.stats.lifeStart = null;
        }
        state.lastDeathPose = deathPose;
        state.playerDead = true;
        var wasRunning = state.running;
        state.running = false;
        releaseAllGatlingBursts(getActiveGameController());
        updateStatsUI();
        updateStatusLine();
        if (state.respawnTimer) {
            clearTimeout(state.respawnTimer);
            state.respawnTimer = null;
        }

        var settings = state.settings || defaultSettings();
        var delay = getRespawnDelayMs();

        function afterDelay(fn) {
            if (delay <= 0) {
                fn();
                return;
            }
            state.respawnTimer = setTimeout(function() {
                state.respawnTimer = null;
                if (!state.inTrainingGame || !state.playerDead) return;
                fn();
            }, delay);
        }

        if (settings.autoNewMap) {
            afterDelay(function() {
                restartTrainingMap(wasRunning);
            });
            return;
        }

        if (settings.autoRespawn) {
            afterDelay(function() {
                respawnTrainingPlayer(wasRunning);
            });
            return;
        }

        showDeathOverlay(lastLife);
    }

    function pickRandomSpawnPosition(rc) {
        var maze = rc.getMaze && rc.getMaze();
        if (!maze || !maze.getRandomUnusedPosition) return null;
        var roundState = rc.model.getRoundState && rc.model.getRoundState(true);
        var minDist = (typeof Constants !== 'undefined' && Constants.CRATE_MINIMUM_TILES_TO_TANKS)
            ? Constants.CRATE_MINIMUM_TILES_TO_TANKS : 2;
        return maze.getRandomUnusedPosition(roundState, minDist);
    }

    function respawnTrainingPlayer(resumeRunning) {
        var gc = getActiveGameController();
        if (!gc || !gc.roundController) return;
        var rc = gc.roundController;
        var humanId = getPrimaryHumanId(gc);
        if (!humanId) return;
        var settings = state.settings || defaultSettings();
        var pos = null;
        if (settings.respawnInPlace && state.lastDeathPose) {
            pos = state.lastDeathPose;
        } else {
            pos = pickRandomSpawnPosition(rc);
        }
        if (!pos) return;
        state.suppressTrainingSpawnFx += 1;
        state.skipSpawnAnimationId = humanId;
        try {
            purgeTankFromRoundModel(rc, humanId);
            rc.spawnTank(humanId, pos, false);
        } finally {
            state.suppressTrainingSpawnFx = Math.max(0, state.suppressTrainingSpawnFx - 1);
            state.skipSpawnAnimationId = null;
        }
        grantRespawnInvincibility(humanId);
        var respawnTank = rc.getTank(humanId);
        if (respawnTank) {
            setTankProjectileCollision(respawnTank, false);
            respawnTank._ttInvincibleNoProj = true;
        }
        state.playerDead = false;
        state.lastDeathPose = null;
        if (state.stats) {
            state.stats.lifeSeconds = 0;
            state.stats.lifeStart = null;
        }
        if (resumeRunning) {
            state.running = true;
        }
        hideDeathOverlay();
        updateStatusLine();
        updateStatsUI();
    }

    function purgeStaleEmitterPlayers(gc) {
        if (!gc || !gc.model) return;
        var wanted = {};
        var i;
        for (i = 0; i < state.emitters.length; i++) wanted[state.emitters[i].id] = true;
        var ids = gc.model.getAllPlayerIds ? gc.model.getAllPlayerIds() : [];
        for (i = 0; i < ids.length; i++) {
            var id = ids[i];
            if (isEmitterId(id) && !wanted[id]) {
                try { gc.removePlayer(id); } catch (eRemove) {}
            }
        }
    }

    function restartTrainingMap(resumeRunning, opts) {
        opts = opts || {};
        if (!state.inTrainingGame) return;   // 大厅/主页禁止动游戏控制器，防未响应
        ensureTrainingPatches();
        var gc = getActiveGameController();
        if (!gc || typeof gc._initializeRound !== 'function') return;
        state.running = false;
        releaseAllGatlingBursts(gc);
        if (!opts.keepFixedLevel) {
            clearFixedLevel();
        }
        prepareGameForNewRound(gc);
        purgeStaleEmitterPlayers(gc);
        if (state.respawnTimer) {
            clearTimeout(state.respawnTimer);
            state.respawnTimer = null;
        }
        state.playerDead = false;
        state.lastDeathPose = null;
        hideDeathOverlay();
        if (state.stats) {
            state.stats.rounds += 1;
            state.stats.lifeSeconds = 0;
            state.stats.lifeStart = null;
        }
        state.runtime = {};
        applyMapGenToGameController(gc);
        applyTrainingSpawnConstants();
        gc._initializeRound();
        finishRoundStartAfterInit(gc);
        if (state.inTrainingGame && gc.roundController) {
            wrapTrainingRoundController(gc.roundController);
        }
        if (resumeRunning) {
            state.running = true;
        } else {
            state.running = false;
        }
        updateStatusLine();
        updateStatsUI();
        syncMapGenUI();
    }

    function prepareGameForNewRound(gc) {
        if (!gc || !gc.model || typeof GameModel === 'undefined') return;
        var st = gc.model.getState();
        if (st === GameModel._STATES.IN_ROUND) {
            if (typeof gc.endRound === 'function') {
                try {
                    gc.endRound(null);
                } catch (e) { /* ignore */ }
            }
        } else if (st === GameModel._STATES.COUNTING_DOWN && gc.roundController &&
            typeof gc.roundController.endRound === 'function') {
            try {
                gc.roundController.endRound(null);
            } catch (e) { /* ignore */ }
        }
        gc.model.setState(GameModel._STATES.BETWEEN_ROUNDS);
        gc.betweenRoundsDuration = 1e6;
        gc.celebrationStarted = true;
        gc.celebrationEnded = true;
    }

    function finishRoundStartAfterInit(gc) {
        if (!gc || !gc.model || typeof GameModel === 'undefined') return;
        if (gc.model.getState() !== GameModel._STATES.COUNTING_DOWN) return;
        if (typeof gc.countDown === 'function') {
            gc.countDown(0);
        }
        if (typeof gc.startRound === 'function') {
            gc.startRound();
        }
    }

    function nextEmitterId() {
        var max = -1;
        var i;
        for (i = 0; i < state.emitters.length; i++) {
            var m = parseInt(String(state.emitters[i].id).replace(EMITTER_PREFIX, ''), 10);
            if (!isNaN(m) && m > max) max = m;
        }
        return EMITTER_PREFIX + (max + 1);
    }

    function normalizeEmitterConfig(em) {
        if (!em) return;
        if (!em.kind) em.kind = EMITTER_KIND_POINT;
        if (em.weaponType == null) {
            em.weaponType = (typeof Constants !== 'undefined' && Constants.WEAPON_TYPES)
                ? Constants.WEAPON_TYPES.BULLET : -1;
        }
        if (isLineEmitter(em) && em.moveSpeed == null) {
            em.moveSpeed = 1;
        }
        if (em.magazineRecoverySec == null) {
            if (typeof em.bulletRecoverySpeed === 'number' && em.bulletRecoverySpeed > 0) {
                em.magazineRecoverySec = Math.max(0.5, (em.bulletCount || 20) / em.bulletRecoverySpeed);
            } else {
                em.magazineRecoverySec = 3;
            }
        }
        delete em.bulletRecoverySpeed;
    }

    function getEmitterWeaponOptions() {
        var wt = (typeof Constants !== 'undefined' && Constants.WEAPON_TYPES) ? Constants.WEAPON_TYPES : {};
        return [
            { value: wt.BULLET != null ? wt.BULLET : -1, label: '普通子弹' },
            { value: wt.LASER != null ? wt.LASER : 0, label: '激光' },
            { value: wt.DOUBLE_BARREL != null ? wt.DOUBLE_BARREL : 1, label: '双管炮' },
            { value: wt.SHOTGUN != null ? wt.SHOTGUN : 2, label: '霰弹枪' },
            { value: wt.HOMING_MISSILE != null ? wt.HOMING_MISSILE : 3, label: '追踪导弹' },
            { value: wt.MINE != null ? wt.MINE : 4, label: '地雷' },
            { value: wt.GATLING_GUN != null ? wt.GATLING_GUN : 5, label: '加特林' }
        ];
    }

    function createEmitterWeaponState(em) {
        if (typeof IdGenerator === 'undefined' || typeof Constants === 'undefined') return null;
        var pid = em.id;
        var wid = IdGenerator.instance.gen('bw');
        var wt = em.weaponType;
        if (wt == null) wt = Constants.WEAPON_TYPES.BULLET;

        if (wt === Constants.WEAPON_TYPES.LASER && typeof LaserWeapon !== 'undefined') {
            return LaserWeapon.createInitialWeaponState(wid, pid);
        }
        if (wt === Constants.WEAPON_TYPES.DOUBLE_BARREL && typeof DoubleBarrelWeapon !== 'undefined') {
            return DoubleBarrelWeapon.createInitialWeaponState(wid, pid, 1);
        }
        if (wt === Constants.WEAPON_TYPES.SHOTGUN && typeof ShotgunWeapon !== 'undefined') {
            return ShotgunWeapon.createInitialWeaponState(wid, pid, 1);
        }
        if (wt === Constants.WEAPON_TYPES.HOMING_MISSILE && typeof HomingMissileWeapon !== 'undefined') {
            return HomingMissileWeapon.createInitialWeaponState(wid, pid);
        }
        if (wt === Constants.WEAPON_TYPES.MINE && typeof MineWeapon !== 'undefined') {
            return MineWeapon.createInitialWeaponState(wid, pid, 1);
        }
        if (wt === Constants.WEAPON_TYPES.GATLING_GUN && typeof GatlingGunWeapon !== 'undefined') {
            return GatlingGunWeapon.createInitialWeaponState(wid, pid, 1);
        }
        if (typeof BulletWeapon !== 'undefined') {
            return BulletWeapon.createInitialWeaponState(wid, pid, 1);
        }
        return null;
    }

    function applyEmitterWeapon(gc, em) {
        if (!gc || !gc.roundController || !em) return;
        var ws = createEmitterWeaponState(em);
        if (ws) {
            gc.roundController.setWeaponState(ws);
        }
    }

    function ensureEmitterWeaponType(gc, em) {
        if (!gc || !em || !gc.getActiveWeapon) return;
        var weapon = gc.getActiveWeapon(em.id);
        if (weapon && emitterWeaponTypeMatches(weapon, em)) return;
        applyEmitterWeapon(gc, em);
    }

    function prepEmitterWeaponForShot(weapon) {
        if (!weapon) return;
        if (typeof weapon.release === 'function') {
            weapon.release();
        }
        var wt = weapon.getType ? weapon.getType() : null;
        var C = typeof Constants !== 'undefined' ? Constants.WEAPON_TYPES : {};

        if (wt === C.BULLET) {
            weapon._numBullets = 1;
            weapon._bulletsFired = 0;
            weapon._triggerPulled = false;
        } else if (wt === C.LASER) {
            weapon._fired = false;
            weapon._timeSinceFire = 0;
        } else if (wt === C.DOUBLE_BARREL) {
            weapon._numBullets = 1;
            weapon._triggerPulled = false;
        } else if (wt === C.SHOTGUN) {
            weapon._numBullets = 1;
            weapon._reloadTime = 0;
            weapon._triggerPulled = false;
        } else if (wt === C.HOMING_MISSILE) {
            weapon._launched = false;
            weapon._activationTime = 0;
        } else if (wt === C.MINE) {
            weapon._numMines = 1;
            weapon._triggerPulled = false;
        } else         if (wt === C.GATLING_GUN) {
            weapon._numBullets = 1;
            weapon._triggerPulled = false;
            weapon._weaponCharge = 0;
            weapon._timeSinceFire = 0;
            weapon._newBurst = true;
        }
    }

    function spawnEmitterProjectiles(rc, tank, weapon) {
        if (!weapon.getProjectileStates) return false;
        var states = weapon.getProjectileStates(tank);
        if (!states || !states.length) return false;
        var i;
        for (i = 0; i < states.length; i++) {
            rc.setProjectileState(states[i]);
        }
        return true;
    }

    function spawnEmitterTraps(rc, tank, weapon) {
        if (!weapon.getTrapStates) return false;
        var states = weapon.getTrapStates(tank);
        if (!states || !states.length) return false;
        var i;
        for (i = 0; i < states.length; i++) {
            rc.setTrapState(states[i]);
        }
        return true;
    }

    function emitterFireShot(rc, tank, em) {
        var weapon = rc.getActiveWeapon(em.id);
        if (!weapon) return false;
        var wt = weapon.getType ? weapon.getType() : null;
        var C = typeof Constants !== 'undefined' ? Constants.WEAPON_TYPES : {};
        if (wt === C.HOMING_MISSILE) {
            return false;
        }
        prepEmitterWeaponForShot(weapon);
        var ok = false;

        if (wt === C.MINE) {
            if (weapon.fire && weapon.fire()) {
                ok = spawnEmitterTraps(rc, tank, weapon);
            }
        } else if (wt === C.GATLING_GUN) {
            if (weapon.getProjectileStates) {
                var gStates = weapon.getProjectileStates(tank);
                if (gStates && gStates.length) {
                    var gi;
                    for (gi = 0; gi < gStates.length; gi++) {
                        rc.setProjectileState(gStates[gi]);
                    }
                    ok = true;
                }
            }
        } else {
            if (weapon.fire && weapon.fire()) {
                ok = spawnEmitterProjectiles(rc, tank, weapon) || spawnEmitterTraps(rc, tank, weapon);
            }
        }
        if (typeof weapon.release === 'function') {
            weapon.release();
        }
        return ok;
    }

    function updateEmitterAmmo(rt, em, deltaTime, gc) {
        var maxAmmo = Math.max(1, em.bulletCount || 1);
        if (rt.ammo == null) rt.ammo = maxAmmo;
        if (rt.reloadTimer == null) rt.reloadTimer = 0;
        var wasReloading = rt.ammo <= 0 && rt.reloadTimer > 0;

        if (rt.ammo <= 0) {
            rt.ammo = 0;
            if (rt.reloadTimer > 0) {
                rt.reloadTimer = Math.max(0, rt.reloadTimer - deltaTime);
                if (rt.reloadTimer <= 0) {
                    rt.ammo = maxAmmo;
                }
            }
        } else {
            rt.ammo = Math.min(maxAmmo, rt.ammo);
            if (rt.reloadTimer > 0) {
                rt.reloadTimer = 0;
            }
        }

        if (wasReloading && rt.reloadTimer <= 0 && rt.ammo >= maxAmmo && gc) {
            ensureEmitterWeaponType(gc, em);
        }
    }

    function syncEmitterWeapon(gc, emitterId, rt, em) {
        if (!gc.getActiveWeapon) return;
        var weapon = gc.getActiveWeapon(emitterId);
        if (!weapon) return;
        var wt = weapon.getType ? weapon.getType() : null;
        var C = typeof Constants !== 'undefined' ? Constants.WEAPON_TYPES : {};
        var isGatling = wt === C.GATLING_GUN;

        if (rt.ammo < 1) {
            if (isGatling && weapon._triggerPulled) {
                weapon._triggerPulled = false;
            }
            rt.gatlingBurst = false;
            return;
        }

        if (isGatling) {
            weapon._triggerPulled = false;
            if (weapon._weaponCharge > 0) {
                weapon._weaponCharge = 0;
            }
            return;
        }

        if (wt === C.HOMING_MISSILE) {
            return;
        }

        if (typeof weapon.release === 'function') {
            weapon.release();
        }
    }

    function defaultEmitter() {
        return {
            id: nextEmitterId(),
            kind: EMITTER_KIND_POINT,
            name: '点发射源 ' + (state.emitters.length + 1),
            x: null,
            y: null,
            rotation: 0,
            rotateSpeed: 2.5,
            directionRandomness: 0,
            minShootInterval: 0.8,
            bulletCount: 20,
            magazineRecoverySec: 3,
            weaponType: (typeof Constants !== 'undefined' && Constants.WEAPON_TYPES)
                ? Constants.WEAPON_TYPES.BULLET : -1
        };
    }

    function defaultLineEmitter() {
        return {
            id: nextEmitterId(),
            kind: EMITTER_KIND_LINE,
            name: '线发射源 ' + (state.emitters.length + 1),
            x: null,
            y: null,
            rotation: 0,
            rotateSpeed: 2.5,
            moveSpeed: 1,
            directionRandomness: 0,
            minShootInterval: 0.8,
            bulletCount: 20,
            magazineRecoverySec: 3,
            weaponType: (typeof Constants !== 'undefined' && Constants.WEAPON_TYPES)
                ? Constants.WEAPON_TYPES.BULLET : -1,
            lineX1: null,
            lineY1: null,
            lineX2: null,
            lineY2: null
        };
    }

    function getEmitterById(id) {
        var i;
        for (i = 0; i < state.emitters.length; i++) {
            if (state.emitters[i].id === id) return state.emitters[i];
        }
        return null;
    }

    function getRuntime(id) {
        if (!state.runtime[id]) {
            var em = getEmitterById(id);
            state.runtime[id] = {
                targetWorldAngle: null,
                ammo: em ? em.bulletCount : 0,
                cooldown: 0,
                reloadTimer: 0,
                shotPool: null,
                shotPoolTile: '',
                shotPoolEmitter: null,
                shotIdx: 0,
                gatlingBurst: false,
                lineT: 0,
                lineDir: 1,
                aimPreview: false
            };
        }
        return state.runtime[id];
    }

    function resetRuntime(id) {
        var em = getEmitterById(id);
        if (!em) {
            delete state.runtime[id];
            return;
        }
        state.runtime[id] = {
            targetWorldAngle: null,
            ammo: em.bulletCount,
            cooldown: 0,
            reloadTimer: 0,
            shotPool: null,
            shotPoolTile: '',
            shotPoolEmitter: null,
            shotIdx: 0,
            gatlingBurst: false,
            lineT: 0,
            lineDir: 1,
            aimPreview: false
        };
    }

    function makeEmitterPlayerDetails(playerId) {
        var em = getEmitterById(playerId);
        var name = em ? em.name : '发射源';
        return {
            playerId: playerId,
            username: name,
            victories: 0, kills: 0, deaths: 0, suicides: 0, surrenders: 0, experience: 0,
            turretColour: colourHex(0xff6600),
            treadColour: colourHex(0x333333),
            baseColour: colourHex(0xff6600),
            turretAccessory: '0', barrelAccessory: '0', frontAccessory: '0', backAccessory: '0',
            treadAccessory: '0', backgroundAccessory: '0', badge: '0',
            email: null, lastLogin: null, created: null, realName: null, birthYear: null, country: null,
            newsSubscriber: false, gmLevel: 0, beta: false, verified: false, banned: null,
            usernameApproved: true, premium: false,             guest: false, rank: 0, xp: 0, lastForumPost: 0
        };
    }

    function primeEmitterPlayerCache(playerId) {
        if (typeof Caches === 'undefined' || typeof PlayerDetails === 'undefined') return;
        try {
            var cache = Caches.getPlayerDetailsCache();
            var raw = makeEmitterPlayerDetails(playerId);
            cache.set(playerId, PlayerDetails.withObject(raw));
        } catch (e) { /* ignore */ }
    }

    function primeAllEmitterCaches() {
        var i;
        for (i = 0; i < state.emitters.length; i++) {
            primeEmitterPlayerCache(state.emitters[i].id);
        }
    }

    function getHumanPlayerIds() {
        if (typeof Users === 'undefined' || !Users.getAllPlayerIds) return [];
        var ids = Users.getAllPlayerIds();
        var humans = [];
        var i;
        for (i = 0; i < ids.length; i++) {
            if (!isEmitterId(ids[i]) &&
                !(typeof Users.isLobbyAIUser === 'function' && Users.isLobbyAIUser(ids[i])) &&
                !(typeof AIs !== 'undefined' && AIs.isAI && AIs.isAI(ids[i]))) {
                humans.push(ids[i]);
            }
        }
        return humans;
    }

    function getTrainingPlayerIds() {
        if (typeof Users === 'undefined' || !Users.getAllPlayerIds) return [];
        var ids = Users.getAllPlayerIds();
        var out = [];
        var i;
        for (i = 0; i < ids.length; i++) {
            if (!isEmitterId(ids[i])) out.push(ids[i]);
        }
        return out;
    }

    function getPrimaryHumanId(gc) {
        var humans = getHumanPlayerIds();
        if (humans.length > 0) return humans[0];
        // 训练基准允许无人类玩家：回退到大厅 AI（Vantage/Laika）。
        var training = getTrainingPlayerIds();
        if (training.length > 0) return training[0];
        if (gc && gc.localPlayerIds) {
            var i;
            for (i = 0; i < gc.localPlayerIds.length; i++) {
                if (!isEmitterId(gc.localPlayerIds[i])) return gc.localPlayerIds[i];
            }
        }
        return null;
    }

    function getTileSize() {
        if (typeof Constants !== 'undefined' && Constants.MAZE_TILE_SIZE) {
            return Constants.MAZE_TILE_SIZE.m || Constants.MAZE_TILE_SIZE;
        }
        return 4;
    }

    function gridCenterForTank(tank) {
        var ts = getTileSize();
        var col = Math.floor(tank.getX() / ts);
        var row = Math.floor(tank.getY() / ts);
        return {
            x: (col + 0.5) * ts,
            y: (row + 0.5) * ts
        };
    }

    function worldAngleToPoint(fromX, fromY, toX, toY) {
        return Math.atan2(toX - fromX, -(toY - fromY));
    }

    var AIM_ALIGN_THRESHOLD = 0.12;

    function emitterAiConfig() {
        if (typeof AI === 'undefined' || !AI._TRAITS) return {};
        var c = {};
        c[AI._TRAITS.CLEVERNESS] = 1;
        c[AI._TRAITS.DEXTERITY] = 1;
        c[AI._TRAITS.AGGRESSIVENESS] = 1;
        c[AI._TRAITS.BOLDNESS] = 1;
        return c;
    }

    function emitterShootCfg() {
        return {
            interceptShoot: true,
            coverageShoot: true,
            cornerRicochet: true,
            diversifyShots: false,
            preferRicochet: true
        };
    }

    function makeEmitterAiSelf(gc, emitterId) {
        return {
            gameController: gc,
            aiId: emitterId,
            config: emitterAiConfig()
        };
    }

    function humanTileKey(humanTank) {
        if (!humanTank) return '';
        var ts = getTileSize();
        return Math.floor(humanTank.getX() / ts) + ',' + Math.floor(humanTank.getY() / ts);
    }

    function rebuildEmitterShotPool(gc, em, tank, humanId) {
        var relAngles = [];
        if (humanId && typeof TankTroubleAITactics !== 'undefined' &&
            TankTroubleAITactics.enumerateInterceptShots) {
            var shots = TankTroubleAITactics.enumerateInterceptShots(
                makeEmitterAiSelf(gc, em.id), humanId, emitterShootCfg()
            );
            var seen = {};
            var i, k;
            for (i = 0; i < shots.length; i++) {
                if (shots[i].angle === undefined || shots[i].angle === null) continue;
                k = Math.round(shots[i].angle * 32);
                if (!seen[k]) {
                    seen[k] = true;
                    relAngles.push(shots[i].angle);
                }
            }
        }
        if (!relAngles.length && humanId && gc.roundController) {
            var ht = gc.roundController.getTank(humanId);
            if (ht) {
                var gc2 = gridCenterForTank(ht);
                relAngles.push(normalizeAngle(
                    worldAngleToPoint(tank.getX(), tank.getY(), gc2.x, gc2.y) - tank.getRotation()
                ));
            }
        }
        return relAngles;
    }

    function pickEmitterTargetAngle(gc, em, tank, humanTank, humanId, rt) {
        var rand = Math.max(0, Math.min(1, em.directionRandomness || 0));
        var tileKey = humanTileKey(humanTank);
        if (!rt.shotPool || !rt.shotPool.length || rt.shotPoolTile !== tileKey ||
            rt.shotPoolEmitter !== em.id) {
            rt.shotPool = rebuildEmitterShotPool(gc, em, tank, humanId);
            rt.shotPoolTile = tileKey;
            rt.shotPoolEmitter = em.id;
            rt.shotIdx = 0;
        }
        if (!rt.shotPool.length) {
            return normalizeAngle(Math.random() * Math.PI * 2 - Math.PI);
        }

        var relAngle = rt.shotPool[rt.shotIdx % rt.shotPool.length];
        var baseWorld = normalizeAngle(tank.getRotation() + relAngle);
        if (rand <= 0) {
            return baseWorld;
        }
        var maxOffset = rand * (Math.PI / 3);
        return normalizeAngle(baseWorld + (Math.random() * 2 - 1) * maxOffset);
    }

    function getEmitterAmmoText(emId) {
        var em = getEmitterById(emId);
        var rt = state.runtime[emId];
        if (!em) return '';
        var max = Math.max(1, em.bulletCount || 1);
        if (!rt) return max + '/' + max;
        if (rt.ammo <= 0 && rt.reloadTimer > 0) {
            return '装填 ' + (Math.ceil(rt.reloadTimer * 10) / 10) + 's';
        }
        return Math.max(0, rt.ammo) + '/' + max;
    }

    function ensureAmmoHud() {
        if (document.getElementById('tt-emitter-ammo-hud')) return;
        var el = document.createElement('div');
        el.id = 'tt-emitter-ammo-hud';
        el.className = 'tt-hidden';
        document.body.appendChild(el);
    }

    function updateEmitterAmmoHUD(gc) {
        ensureAmmoHud();
        var hud = document.getElementById('tt-emitter-ammo-hud');
        if (!hud) return;
        if (!state.inTrainingGame || !state.emitters.length) {
            hud.classList.add('tt-hidden');
            return;
        }
        hud.classList.remove('tt-hidden');
        var lines = [];
        var i;
        for (i = 0; i < state.emitters.length; i++) {
            var em = state.emitters[i];
            lines.push(em.name + ': ' + getEmitterAmmoText(em.id));
        }
        hud.textContent = lines.join('\n');
    }

    function disableEmitterProjectileCollision(tank) {
        if (!tank || tank._ttNoProjectileCollision) return;
        if (!tank.getB2DBody || typeof Constants === 'undefined') return;
        var body = tank.getB2DBody();
        if (!body || !body.GetFixtureList) return;
        var projMask = Constants.COLLISION_CATEGORIES.PROJECTILE;
        var tankMask = Constants.COLLISION_CATEGORIES.TANK;
        var fixture = body.GetFixtureList();
        while (fixture) {
            var filter = fixture.GetFilterData();
            // 发射源既不该被子弹打，也不该和 AI/玩家坦克发生物理推挤：
            // 否则预测沙箱（没有发射源体）必然与现实产生段末偏差。
            filter.maskBits &= ~(projMask | tankMask);
            fixture.SetFilterData(filter);
            fixture = fixture.GetNext();
        }
        tank._ttNoProjectileCollision = true;
    }

    function getUIGameState() {
        var ph = getMainPhaser();
        if (!ph || !ph.state || ph.state.current !== 'Game') return null;
        return ph.state.getCurrentState();
    }

    function screenToMaze(uiState, clientX, clientY) {
        var canvas = uiState.game.canvas;
        var rect = canvas.getBoundingClientRect();
        var sx = (clientX - rect.left) / rect.width * uiState.game.width;
        var sy = (clientY - rect.top) / rect.height * uiState.game.height;
        var g = uiState.gameGroup;
        var px = (sx - g.position.x) / g.scale.x;
        var py = (sy - g.position.y) / g.scale.y;
        if (typeof UIUtils !== 'undefined' && UIUtils.pxm) {
            return { x: UIUtils.pxm(px), y: UIUtils.pxm(py) };
        }
        return { x: px / 50, y: py / 50 };
    }

    function ensureDefaultEmitter() {
        if (state.emitters.length === 0) {
            var em = defaultEmitter();
            normalizeEmitterConfig(em);
            state.emitters.push(em);
            saveEmitters();
        }
    }

    function ensureEmitterPlayers(gc) {
        if (!gc || !gc.addPlayer || !gc.model) return;
        primeAllEmitterCaches();
        var i;
        for (i = 0; i < state.emitters.length; i++) {
            var id = state.emitters[i].id;
            var queued = gc.model.queuedPlayers && id in gc.model.queuedPlayers;
            var active = gc.model.activePlayers && id in gc.model.activePlayers;
            if (!queued && !active) {
                gc.addPlayer(id);
            }
            if (gc.localPlayerIds && gc.localPlayerIds.indexOf(id) < 0) {
                gc.localPlayerIds.push(id);
            }
        }
        if (gc.roundController && gc.localPlayerIds) {
            gc.roundController.localPlayerIds = gc.localPlayerIds.slice();
        }
    }

    function randomizeEmitterPositions(gc) {
        var rc = gc.roundController;
        if (!rc) return;
        var i;
        for (i = 0; i < state.emitters.length; i++) {
            var em = state.emitters[i];
            if (isLineEmitter(em)) continue;
            var tank = rc.getTank(em.id);
            if (!tank) continue;
            var pos = pickRandomSpawnPosition(rc);
            if (!pos) {
                pos = { x: tank.getX(), y: tank.getY(), rotation: tank.getRotation() };
            }
            em.x = pos.x;
            em.y = pos.y;
            em.rotation = pos.rotation != null ? pos.rotation : (Math.random() * Math.PI * 2 - Math.PI);
            if (typeof TankState !== 'undefined') {
                var ts = TankState.withState(
                    em.id, em.x, em.y, false, false, em.rotation,
                    false, false, false, false
                );
                rc.setTankState(ts, false);
            }
            disableEmitterProjectileCollision(rc.getTank(em.id));
            applyEmitterWeapon(gc, em);
            resetRuntime(em.id);
        }
    }

    function findNearestEmitterTank(rc, mx, my, maxDist) {
        var best = null;
        var bestD = maxDist * maxDist;
        var i, em, tank, dx, dy, d, seg;
        for (i = 0; i < state.emitters.length; i++) {
            em = state.emitters[i];
            if (isLineEmitter(em)) {
                if (!hasLineWall(em)) continue;
                seg = { x1: em.lineX1, y1: em.lineY1, x2: em.lineX2, y2: em.lineY2 };
                d = distPointToSegment(mx, my, seg);
                if (d * d < bestD) {
                    bestD = d * d;
                    best = em;
                }
                continue;
            }
            tank = rc.getTank(em.id);
            if (!tank) continue;
            dx = tank.getX() - mx;
            dy = tank.getY() - my;
            d = dx * dx + dy * dy;
            if (d < bestD) {
                bestD = d;
                best = em;
            }
        }
        return best;
    }

    function updateTrainingEmitters(gc, deltaTime) {
        if (!state.inTrainingGame || !gc.roundController || state.playerDead) return;
        var rc = gc.roundController;
        if (!rc.model) return;
        if (!rc.model.getStarted || !rc.model.getStarted()) {
            updateLineEmitterGraphics(gc);
            return;
        }

        var humanId = getPrimaryHumanId(gc);
        var humanTank = humanId ? rc.getTank(humanId) : null;

        var i;
        for (i = 0; i < state.emitters.length; i++) {
            var em = state.emitters[i];
            if (isLineEmitter(em)) {
                if (!hasLineWall(em)) continue;
                if (!rc.getTank(em.id)) {
                    spawnOrMoveLineEmitterTank(gc, em);
                }
            }
            var tank = rc.getTank(em.id);
            if (!tank) continue;
            var rt = getRuntime(em.id);
            rt.aimPreview = false;

            disableEmitterProjectileCollision(tank);

            if (!state.running) {
                if (isLineEmitter(em)) {
                    spawnOrMoveLineEmitterTank(gc, em);
                }
                continue;
            }

            if (isLineEmitter(em)) {
                advanceLineEmitterPosition(rt, em, deltaTime);
                var linePose = getLineEmitterSpawnPose(em, rt);
                if (linePose && typeof TankState !== 'undefined') {
                    var lineTs = TankState.withState(
                        em.id, linePose.x, linePose.y, false, false, linePose.rotation,
                        false, false, false, false
                    );
                    rc.setTankState(lineTs, false);
                    em.x = linePose.x;
                    em.y = linePose.y;
                    tank = rc.getTank(em.id);
                }
            }

            rt.cooldown = Math.max(0, rt.cooldown - deltaTime);
            updateEmitterAmmo(rt, em, deltaTime, gc);

            if (rt.targetWorldAngle === null) {
                rt.targetWorldAngle = pickEmitterTargetAngle(
                    gc, em, tank, humanTank, humanId, rt
                );
            }

            var rotateSpeed = em.rotateSpeed || 0;
            var instant = rotateSpeed >= INSTANT_ROTATE_SPEED;
            var targetAngle = rt.targetWorldAngle;
            var currentRot = tank.getRotation();
            var newRot = currentRot;
            var turnLeft = false;
            var turnRight = false;

            if (instant) {
                newRot = targetAngle;
            } else if (rotateSpeed > 0) {
                var step = rotateSpeed * deltaTime;
                var diff = shortestAngleDiff(currentRot, targetAngle);
                if (Math.abs(diff) <= step) {
                    newRot = targetAngle;
                } else if (diff > 0) {
                    turnRight = true;
                    newRot = normalizeAngle(currentRot + step);
                } else {
                    turnLeft = true;
                    newRot = normalizeAngle(currentRot - step);
                }
            }

            var interval = Math.max(0.05, em.minShootInterval || 0.5);
            var aligned = instant || Math.abs(shortestAngleDiff(newRot, targetAngle)) < AIM_ALIGN_THRESHOLD;
            var homing = isHomingEmitter(em);
            var homingWeapon = homing ? gc.getActiveWeapon(em.id) : null;
            var homingBusy = homingWeapon && homingWeapon._launched;
            var homingInFlight = 0;
            if (homing && typeof Constants !== 'undefined') {
                homingInFlight = countEmitterProjectiles(rc, em.id, Constants.WEAPON_TYPES.HOMING_MISSILE);
            }
            var wantFire = aligned && rt.cooldown <= 0 && rt.ammo >= 1 && !homingBusy &&
                (!homing || homingInFlight < 1);
            var fireDown = false;
            rt.aimPreview = wantFire || (aligned && rt.cooldown <= interval * 0.35);

            syncEmitterWeapon(gc, em.id, rt, em);
            if (homing) {
                if (wantFire) {
                    fireDown = true;
                }
            } else if (wantFire && emitterFireShot(rc, tank, em)) {
                rt.cooldown = interval;
                rt.ammo -= 1;
                advanceEmitterAim(rt);
                if (rt.ammo <= 0) {
                    startMagazineReload(rt, em);
                }
            }

            if (typeof InputState !== 'undefined') {
                var inp = InputState.withState(em.id, false, false, turnLeft, turnRight, fireDown);
                rc.setInputState(inp);
            }
            if (instant && typeof TankState !== 'undefined') {
                var after = rc.getTank(em.id);
                if (after) {
                    var fix = TankState.withState(
                        em.id, after.getX(), after.getY(), false, false, newRot,
                        false, false, false, false
                    );
                    rc.setTankState(fix, false);
                }
            }
        }
        updateLineEmitterGraphics(gc);
    }

    var panelEl = null;
    var fabEl = null;

    function buildPanelDOM() {
        if (panelEl) return;
        panelEl = document.createElement('div');
        panelEl.id = 'tt-training-panel';
        panelEl.className = 'tt-hidden';
        panelEl.innerHTML = [
            '<div class="tt-training-header">',
            '  <button type="button" class="tt-header-back tt-hidden" id="tt-training-header-back" title="返回">←</button>',
            '  <h2 id="tt-training-header-title">训练调控</h2>',
            '  <button type="button" class="tt-training-btn danger tt-header-close" id="tt-training-close">关闭</button>',
            '</div>',
            '<div class="tt-training-body">',
            '  <div id="tt-training-page-main" class="tt-training-page">',
            '    <div id="tt-training-status" class="tt-training-status paused">训练已暂停 — 按 P 开始</div>',
            '    <button type="button" class="tt-training-btn" id="tt-training-toggle-run">开始训练 (P)</button>',
            '    <div id="tt-training-stats" class="tt-training-stats"></div>',
            '    <div id="tt-vantage-bench-slot"></div>',
            '    <div class="tt-card">',
            '      <button type="button" class="tt-card-head" id="tt-nav-settings">',
            '        <span class="tt-card-title">训练</span>',
            '        <span class="tt-card-arrow">设置 ›</span>',
            '      </button>',
            '      <div class="tt-card-foot">',
            '        <div class="tt-io-label">关卡配置 <span class="tt-io-hint">本机文件 / 服务器，二选一即可</span></div>',
            '        <input type="text" id="tt-level-export-name" class="tt-config-input full" placeholder="名称（导出/保存时用）">',
            '        <div class="tt-io-group">',
            '          <div class="tt-io-group-head">载入</div>',
            '          <div class="tt-io-pair">',
            '            <button type="button" class="tt-io-btn" id="tt-import-level">从文件导入</button>',
            '            <button type="button" class="tt-io-btn" id="tt-level-load-server">从服务器加载</button>',
            '            <input type="file" id="tt-import-level-file" accept=".json,application/json" class="tt-hidden-file">',
            '          </div>',
            '          <select id="tt-level-server-list" class="tt-config-select full"></select>',
            '        </div>',
            '        <div class="tt-io-group">',
            '          <div class="tt-io-group-head">保存</div>',
            '          <div class="tt-io-pair">',
            '            <button type="button" class="tt-io-btn" id="tt-export-level">导出到文件</button>',
            '            <button type="button" class="tt-io-btn" id="tt-level-save-server">保存到服务器</button>',
            '          </div>',
            '        </div>',
            '      </div>',
            '    </div>',
            '    <div class="tt-card">',
            '      <button type="button" class="tt-card-head" id="tt-nav-mapgen">',
            '        <span class="tt-card-title">地图与道具</span>',
            '        <span class="tt-card-arrow">设置 ›</span>',
            '      </button>',
            '      <div class="tt-card-foot">',
            '        <div class="tt-io-label">地图配置 <span class="tt-io-hint">本机文件 / 服务器，二选一即可</span></div>',
            '        <div class="tt-io-group">',
            '          <div class="tt-io-group-head">载入</div>',
            '          <div class="tt-io-pair">',
            '            <button type="button" class="tt-io-btn" id="tt-mapgen-import">从文件导入</button>',
            '            <button type="button" class="tt-io-btn" id="tt-mapgen-load-server">从服务器加载</button>',
            '            <input type="file" id="tt-mapgen-import-file" accept=".json,application/json" class="tt-hidden-file">',
            '          </div>',
            '          <select id="tt-mapgen-server-list" class="tt-config-select full"></select>',
            '        </div>',
            '        <div class="tt-io-group">',
            '          <div class="tt-io-group-head">保存</div>',
            '          <div class="tt-io-pair">',
            '            <button type="button" class="tt-io-btn" id="tt-mapgen-export">导出到文件</button>',
            '            <button type="button" class="tt-io-btn" id="tt-mapgen-save-server">保存到服务器</button>',
            '          </div>',
            '          <input type="text" id="tt-mapgen-save-name" class="tt-config-input full" placeholder="服务器保存名">',
            '        </div>',
            '        <button type="button" class="tt-io-btn tt-io-btn-wide" id="tt-training-restart-map-btn">立即换新地图</button>',
            '      </div>',
            '    </div>',
            '    <div class="tt-card">',
            '      <button type="button" class="tt-card-head" id="tt-training-list-btn">',
            '        <span class="tt-card-title">发射源</span>',
            '        <span class="tt-card-arrow">管理 ›</span>',
            '      </button>',
            '      <div class="tt-card-foot">',
            '        <div class="tt-io-label">发射源参数 <span class="tt-io-hint">本机文件 / 服务器，二选一即可</span></div>',
            '        <div class="tt-io-group">',
            '          <div class="tt-io-group-head">载入</div>',
            '          <div class="tt-io-pair">',
            '            <button type="button" class="tt-io-btn" id="tt-import-emitters">从文件导入</button>',
            '            <button type="button" class="tt-io-btn" id="tt-emitters-load-server">从服务器加载</button>',
            '            <input type="file" id="tt-import-emitters-file" accept=".json,application/json" class="tt-hidden-file">',
            '          </div>',
            '          <select id="tt-emitters-server-list" class="tt-config-select full"></select>',
            '        </div>',
            '        <div class="tt-io-group">',
            '          <div class="tt-io-group-head">保存</div>',
            '          <div class="tt-io-pair">',
            '            <button type="button" class="tt-io-btn" id="tt-export-emitters">导出到文件</button>',
            '            <button type="button" class="tt-io-btn" id="tt-emitters-save-server">保存到服务器</button>',
            '          </div>',
            '          <input type="text" id="tt-emitters-save-name" class="tt-config-input full" placeholder="服务器保存名">',
            '        </div>',
            '      </div>',
            '    </div>',
            '    <p class="tt-training-hint">暂停时：点发射源可拖动移动；Shift+拖动或滚轮调朝向。线发射源在编辑页选择墙壁附着。</p>',
            '  </div>',
            '  <div id="tt-training-page-settings" class="tt-training-page tt-training-subpage hidden">',
            '    <div class="tt-training-subpage-content">',
            '    <div class="tt-training-settings">',
            '      <h3 class="tt-training-subhead">训练设置</h3>',
            '      <label class="tt-training-check"><input type="checkbox" id="tt-set-auto-respawn" checked> 阵亡后自动复活</label>',
            '      <label class="tt-training-check"><input type="checkbox" id="tt-set-respawn-inplace" checked> 在死亡位置复活</label>',
            '      <label class="tt-training-check"><input type="checkbox" id="tt-set-auto-newmap"> 阵亡后自动换新地图</label>',
            '      <div class="tt-training-field tt-training-field-compact">',
            '        <label><span>复活/换图延迟 (秒)</span><span id="tt-set-respawn-delay-val">0.5</span></label>',
            '        <input type="range" id="tt-set-respawn-delay" min="0" max="3" step="0.1" value="0.5">',
            '      </div>',
            '    </div>',
            '    </div>',
            '  </div>',
            '  <div id="tt-training-page-mapgen" class="tt-training-page tt-training-subpage hidden">',
            '    <div class="tt-training-subpage-content">',
            '    <p class="tt-training-hint" id="tt-mapgen-fixed-hint">当前为随机迷宫生成。</p>',
            '    <div class="tt-training-config-io">',
            '      <h3 class="tt-training-subhead">迷宫生成</h3>',
            '      <label class="tt-training-check tt-mapgen-highlight"><input type="checkbox" id="tt-mapgen-border-only"> 空旷训练场（仅外框墙，无内墙）</label>',
            '      <p class="tt-training-hint">内墙概率=0 且地板概率=1 时等同空旷场；也可勾选上方一键设置。</p>',
            '      <label class="tt-training-check"><input type="checkbox" id="tt-mapgen-symmetric"> 对称迷宫</label>',
            '      <label class="tt-training-check"><input type="checkbox" id="tt-mapgen-ranked"> 排位模式（强制标准主题）</label>',
            '      <div class="tt-training-field tt-training-field-compact">',
            '        <label><span>地图主题</span></label>',
            '        <select id="tt-mapgen-theme" class="tt-config-select full">',
            '          <option value="4">随机主题</option>',
            '          <option value="0">标准</option>',
            '          <option value="1">万圣节</option>',
            '          <option value="2">圣诞</option>',
            '        </select>',
            '      </div>',
            '      <div class="tt-training-field tt-training-field-compact">',
            '        <label><span>尺寸参考玩家数</span><span id="tt-mapgen-max-players-val">8</span></label>',
            '        <input type="range" id="tt-mapgen-max-players" min="2" max="8" step="1" value="8">',
            '      </div>',
            '      <div class="tt-config-row">',
            '        <input type="number" id="tt-mapgen-fixed-width" class="tt-config-input" placeholder="固定宽度(格，留空随机)" min="4" max="16">',
            '        <input type="number" id="tt-mapgen-fixed-height" class="tt-config-input" placeholder="固定高度(格，留空随机)" min="4" max="10">',
            '      </div>',
            '      <div class="tt-training-field tt-training-field-compact">',
            '        <label><span>宽度倍率下限</span><span id="tt-mapgen-width-mult-min-val">1.0</span></label>',
            '        <input type="range" id="tt-mapgen-width-mult-min" min="1" max="1.5" step="0.05" value="1">',
            '      </div>',
            '      <div class="tt-training-field tt-training-field-compact">',
            '        <label><span>宽度倍率上限</span><span id="tt-mapgen-width-mult-max-val">1.5</span></label>',
            '        <input type="range" id="tt-mapgen-width-mult-max" min="1" max="2" step="0.05" value="1.5">',
            '      </div>',
            '      <div class="tt-training-field tt-training-field-compact">',
            '        <label><span>高度倍率下限</span><span id="tt-mapgen-height-mult-min-val">1.0</span></label>',
            '        <input type="range" id="tt-mapgen-height-mult-min" min="1" max="1.5" step="0.05" value="1">',
            '      </div>',
            '      <div class="tt-training-field tt-training-field-compact">',
            '        <label><span>高度倍率上限</span><span id="tt-mapgen-height-mult-max-val">1.5</span></label>',
            '        <input type="range" id="tt-mapgen-height-mult-max" min="1" max="2" step="0.05" value="1.5">',
            '      </div>',
            '      <div class="tt-param-row">',
            '        <label class="tt-param-label"><span>内墙生成概率</span><span class="tt-param-hint">0=无内墙</span></label>',
            '        <div class="tt-param-control">',
            '          <input type="range" id="tt-mapgen-wall-prob" min="0" max="1" step="0.05" value="0.8">',
            '          <input type="number" id="tt-mapgen-wall-prob-num" class="tt-param-num" min="0" max="1" step="0.05" value="0.8">',
            '          <span class="tt-param-val" id="tt-mapgen-wall-prob-val">0.80</span>',
            '        </div>',
            '      </div>',
            '      <div class="tt-param-row">',
            '        <label class="tt-param-label"><span>地板生成概率</span><span class="tt-param-hint">1=铺满</span></label>',
            '        <div class="tt-param-control">',
            '          <input type="range" id="tt-mapgen-tile-prob" min="0" max="1" step="0.05" value="0.7">',
            '          <input type="number" id="tt-mapgen-tile-prob-num" class="tt-param-num" min="0" max="1" step="0.05" value="0.7">',
            '          <span class="tt-param-val" id="tt-mapgen-tile-prob-val">0.70</span>',
            '        </div>',
            '      </div>',
            '      <div class="tt-training-field tt-training-field-compact">',
            '        <label><span>可达区域比例</span><span id="tt-mapgen-reachable-val">1.0</span></label>',
            '        <input type="range" id="tt-mapgen-reachable" min="0.5" max="1" step="0.05" value="1">',
            '      </div>',
            '      <div class="tt-training-field tt-training-field-compact">',
            '        <label><span>坦克最小间距(格)</span><span id="tt-mapgen-tiles-between-val">4</span></label>',
            '        <input type="range" id="tt-mapgen-tiles-between" min="1" max="8" step="1" value="4">',
            '      </div>',
            '      <div class="tt-training-field tt-training-field-compact">',
            '        <label><span>每坦克最少占地(格)</span><span id="tt-mapgen-tiles-per-tank-val">5</span></label>',
            '        <input type="range" id="tt-mapgen-tiles-per-tank" min="2" max="10" step="1" value="5">',
            '      </div>',
            '      <div class="tt-training-field tt-training-field-compact">',
            '        <label><span>死胡同惩罚上限</span><span id="tt-mapgen-dead-end-val">5</span></label>',
            '        <input type="range" id="tt-mapgen-dead-end" min="1" max="10" step="1" value="5">',
            '      </div>',
            '    </div>',
            '    <div class="tt-training-config-io">',
            '      <h3 class="tt-training-subhead">道具刷新</h3>',
            '      <p class="tt-training-hint">训练场会刷新武器箱；金币/钻石参数与联机规则一致。</p>',
            '      <p class="tt-training-hint">可刷新武器箱：</p>',
            '      <div class="tt-mapgen-crates">',
            '        <label class="tt-training-check"><input type="checkbox" id="tt-mapgen-crate-0" checked> 激光武器箱</label>',
            '        <label class="tt-training-check"><input type="checkbox" id="tt-mapgen-crate-1" checked> 双管炮武器箱</label>',
            '        <label class="tt-training-check"><input type="checkbox" id="tt-mapgen-crate-2" checked> 霰弹枪武器箱</label>',
            '        <label class="tt-training-check"><input type="checkbox" id="tt-mapgen-crate-3" checked> 追踪导弹武器箱</label>',
            '        <label class="tt-training-check"><input type="checkbox" id="tt-mapgen-crate-4" checked> 地雷武器箱</label>',
            '        <label class="tt-training-check"><input type="checkbox" id="tt-mapgen-crate-5" checked> 加特林武器箱</label>',
            '        <label class="tt-training-check"><input type="checkbox" id="tt-mapgen-crate-6" checked> 护盾武器箱</label>',
            '      </div>',
            '      <div class="tt-training-field tt-training-field-compact">',
            '        <label><span>同屏武器箱上限</span><span id="tt-mapgen-max-crates-val">3</span></label>',
            '        <input type="range" id="tt-mapgen-max-crates" min="0" max="6" step="1" value="3">',
            '      </div>',
            '      <div class="tt-training-field tt-training-field-compact">',
            '        <label><span>武器箱刷新间隔下限(秒)</span><span id="tt-mapgen-crate-min-val">3.0</span></label>',
            '        <input type="range" id="tt-mapgen-crate-min" min="0.5" max="15" step="0.5" value="3">',
            '      </div>',
            '      <div class="tt-training-field tt-training-field-compact">',
            '        <label><span>武器箱刷新间隔浮动(秒)</span><span id="tt-mapgen-crate-var-val">5.0</span></label>',
            '        <input type="range" id="tt-mapgen-crate-var" min="0" max="20" step="0.5" value="5">',
            '      </div>',
            '      <div class="tt-training-field tt-training-field-compact">',
            '        <label><span>武器箱距坦克最少格数</span><span id="tt-mapgen-crate-dist-val">4</span></label>',
            '        <input type="range" id="tt-mapgen-crate-dist" min="0" max="10" step="1" value="4">',
            '      </div>',
            '      <div class="tt-training-field tt-training-field-compact">',
            '        <label><span>同屏金币上限</span><span id="tt-mapgen-max-golds-val">3</span></label>',
            '        <input type="range" id="tt-mapgen-max-golds" min="0" max="6" step="1" value="3">',
            '      </div>',
            '      <div class="tt-training-field tt-training-field-compact">',
            '        <label><span>金币距坦克最少格数</span><span id="tt-mapgen-gold-dist-val">5</span></label>',
            '        <input type="range" id="tt-mapgen-gold-dist" min="0" max="10" step="1" value="5">',
            '      </div>',
            '      <div class="tt-training-field tt-training-field-compact">',
            '        <label><span>同屏钻石上限</span><span id="tt-mapgen-max-diamonds-val">1</span></label>',
            '        <input type="range" id="tt-mapgen-max-diamonds" min="0" max="3" step="1" value="1">',
            '      </div>',
            '      <div class="tt-training-field tt-training-field-compact">',
            '        <label><span>钻石距坦克最少格数</span><span id="tt-mapgen-diamond-dist-val">6</span></label>',
            '        <input type="range" id="tt-mapgen-diamond-dist" min="0" max="12" step="1" value="6">',
            '      </div>',
            '    </div>',
            '    </div>',
            '  </div>',
            '  <div id="tt-training-page-list" class="tt-training-page tt-training-subpage hidden">',
            '    <div class="tt-training-subpage-content">',
            '    <button type="button" class="tt-training-btn compact" id="tt-training-add-point">添加点发射源</button>',
            '    <button type="button" class="tt-training-btn compact secondary" id="tt-training-add-line">添加线发射源</button>',
            '    <ul class="tt-training-list" id="tt-training-emitter-list"></ul>',
            '    </div>',
            '  </div>',
            '  <div id="tt-training-page-edit" class="tt-training-page tt-training-subpage hidden">',
            '    <div class="tt-training-subpage-content">',
            '    <div id="tt-training-edit-fields"></div>',
            '    <button type="button" class="tt-training-btn danger" id="tt-training-delete">删除发射源</button>',
            '    </div>',
            '  </div>',
            '</div>'
        ].join('');
        document.body.appendChild(panelEl);

        var deathOverlay = document.createElement('div');
        deathOverlay.id = 'tt-training-death-overlay';
        deathOverlay.className = 'tt-hidden';
        deathOverlay.innerHTML = [
            '<div class="tt-death-box">',
            '  <h3>坦克被摧毁</h3>',
            '  <p id="tt-death-survival">本次存活 0:00</p>',
            '  <button type="button" class="tt-training-btn" id="tt-training-respawn">复活继续</button>',
            '  <button type="button" class="tt-training-btn secondary" id="tt-training-restart-map">换新地图</button>',
            '</div>'
        ].join('');
        document.body.appendChild(deathOverlay);

        fabEl = document.createElement('button');
        fabEl.id = 'tt-training-fab';
        fabEl.type = 'button';
        fabEl.textContent = '调控面板';
        document.body.appendChild(fabEl);
        ensureAmmoHud();

        panelEl.querySelector('#tt-training-close').addEventListener('click', function() {
            setPanelVisible(false);
        });
        panelEl.querySelector('#tt-training-header-back').addEventListener('click', function() {
            if (state.currentPage === 'edit') {
                showPage('list');
                refreshEmitterList();
            } else {
                showPage('main');
            }
        });
        fabEl.addEventListener('click', function() {
            setPanelVisible(!state.panelVisible);
        });
        panelEl.querySelector('#tt-training-add-point').addEventListener('click', onAddEmitter);
        panelEl.querySelector('#tt-training-add-line').addEventListener('click', onAddLineEmitter);
        panelEl.querySelector('#tt-training-toggle-run').addEventListener('click', function() {
            toggleTrainingRun();
        });
        panelEl.querySelector('#tt-training-list-btn').addEventListener('click', function() {
            showPage('list');
            refreshEmitterList();
        });
        panelEl.querySelector('#tt-nav-settings').addEventListener('click', function() {
            showPage('settings');
        });
        panelEl.querySelector('#tt-nav-mapgen').addEventListener('click', function() {
            showPage('mapgen');
        });
        panelEl.querySelector('#tt-training-delete').addEventListener('click', onDeleteEmitter);
        panelEl.querySelector('#tt-training-restart-map-btn').addEventListener('click', function() {
            restartTrainingMap(state.running);
        });
        deathOverlay.querySelector('#tt-training-respawn').addEventListener('click', function() {
            respawnTrainingPlayer(true);
        });
        deathOverlay.querySelector('#tt-training-restart-map').addEventListener('click', function() {
            restartTrainingMap(true);
        });

        bindSettingsUI();
        bindMapGenUI();
        bindConfigIOUI();
        document.addEventListener('keydown', onGlobalKeyDown);
    }

    function ensureConfigPanel() {
        buildPanelDOM();
        showFab(true);
        if (state.currentPage) {
            showPage(state.currentPage);
        }
        syncSettingsUI();
        syncMapGenUI();
        updateStatusLine();
        updateStatsUI();
        updateActionButtons();
        updatePanelHeader();
    }

    function setPanelVisible(on) {
        state.panelVisible = !!on;
        if (!panelEl) return;
        panelEl.classList.toggle('tt-hidden', !state.panelVisible);
        if (fabEl) {
            fabEl.classList.toggle('panel-open', state.panelVisible);
        }
        if (state.panelVisible) {
            syncSettingsUI();
            syncMapGenUI();
        }
        updateStatusLine();
    }

    function showFab(on) {
        if (!fabEl) return;
        fabEl.classList.toggle('visible', !!on);
    }

    function showPage(name) {
        state.currentPage = name;
        var pages = {
            main: 'tt-training-page-main',
            settings: 'tt-training-page-settings',
            mapgen: 'tt-training-page-mapgen',
            list: 'tt-training-page-list',
            edit: 'tt-training-page-edit'
        };
        var k;
        for (k in pages) {
            var el = document.getElementById(pages[k]);
            if (el) el.classList.toggle('hidden', k !== name);
        }
        if (name === 'settings') {
            syncSettingsUI();
        }
        if (name === 'mapgen') {
            if (!state.mapGen) loadMapGenSettings();
            syncMapGenUI();
        }
        updatePanelHeader();
    }

    function updatePanelHeader() {
        var back = document.getElementById('tt-training-header-back');
        var title = document.getElementById('tt-training-header-title');
        if (!back || !title) return;
        var page = state.currentPage || 'main';
        var titles = {
            main: '训练调控',
            settings: '训练设置',
            mapgen: '地图与道具',
            list: '发射源',
            edit: '编辑发射源'
        };
        title.textContent = titles[page] || '训练调控';
        back.classList.toggle('tt-hidden', page === 'main');
        back.title = page === 'edit' ? '返回列表' : '返回主页';
    }

    function updateActionButtons() {
        var restartBtn = document.getElementById('tt-training-restart-map-btn');
        var runBtn = document.getElementById('tt-training-toggle-run');
        var inGame = state.inTrainingGame;
        if (restartBtn) restartBtn.disabled = !inGame;
        if (runBtn) runBtn.disabled = !inGame;
    }

    function updateStatusLine() {
        var el = document.getElementById('tt-training-status');
        var runBtn = document.getElementById('tt-training-toggle-run');
        if (!el) return;
        if (!state.inTrainingGame) {
            el.textContent = '未在训练对局中';
            el.className = 'tt-training-status paused';
            if (runBtn) runBtn.textContent = '开始训练 (P)';
            updateActionButtons();
            return;
        }
        if (state.wallPickEmitterId) {
            el.textContent = '点击地图上的墙壁以设置线发射源（Esc 取消）';
            el.className = 'tt-training-status paused';
            if (runBtn) runBtn.textContent = '开始训练 (P)';
            updateActionButtons();
            return;
        }
        if (state.running) {
            el.textContent = '训练进行中 — 按 P 暂停';
            el.className = 'tt-training-status running';
            if (runBtn) runBtn.textContent = '暂停训练 (P)';
        } else if (state.playerDead) {
            var settings = state.settings || defaultSettings();
            var delaySec = settings.respawnDelaySec || 0;
            if (settings.autoNewMap) {
                el.textContent = delaySec > 0
                    ? ('阵亡 — ' + delaySec + ' 秒后自动换新地图')
                    : '阵亡 — 正在换新地图…';
            } else if (settings.autoRespawn) {
                var place = settings.respawnInPlace ? '死亡位置' : '随机位置';
                el.textContent = delaySec > 0
                    ? ('阵亡 — ' + delaySec + ' 秒后在' + place + '自动复活')
                    : ('阵亡 — 正在' + place + '复活…');
            } else {
                el.textContent = '阵亡 — 请手动选择复活或换图';
            }
            el.className = 'tt-training-status paused';
            if (runBtn) runBtn.textContent = '开始训练 (P)';
        } else {
            el.textContent = '训练已暂停 — 按 P 开始（可拖动发射源）';
            el.className = 'tt-training-status paused';
            if (runBtn) runBtn.textContent = '开始训练 (P)';
        }
        updateActionButtons();
    }

    function bindTrainingKeys(uiState) {
        if (!uiState || !uiState.game || uiState._ttTrainingKeysBound) return;
        var kb = uiState.game.input && uiState.game.input.keyboard;
        if (!kb || typeof Phaser === 'undefined') return;
        var pKey = kb.addKey(Phaser.Keyboard.P);
        pKey.onDown.add(function() { toggleTrainingRun(); });
        uiState._ttTrainingKeysBound = true;
    }

    function refreshEmitterList() {
        var ul = document.getElementById('tt-training-emitter-list');
        if (!ul) return;
        ul.innerHTML = '';
        var i;
        for (i = 0; i < state.emitters.length; i++) {
            (function(em) {
                var li = document.createElement('li');
                var label = document.createElement('span');
                label.className = 'tt-emitter-list-label';
                label.textContent = (isLineEmitter(em) ? '[线] ' : '[点] ') + em.name + ' — 弹匣 ' + getEmitterAmmoText(em.id);
                li.appendChild(label);
                var btnRow = document.createElement('span');
                btnRow.className = 'tt-emitter-list-btns';
                var clearBtn = document.createElement('button');
                clearBtn.type = 'button';
                clearBtn.className = 'tt-training-btn secondary';
                clearBtn.textContent = '清空';
                clearBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    clearEmitterMagazine(em.id);
                    refreshEmitterList();
                });
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'tt-training-btn secondary';
                btn.textContent = '编辑';
                btn.addEventListener('click', function() {
                    state.editId = em.id;
                    openEditPage(em);
                });
                btnRow.appendChild(clearBtn);
                btnRow.appendChild(btn);
                li.appendChild(btnRow);
                ul.appendChild(li);
            })(state.emitters[i]);
        }
    }

    function fieldHtml(label, id, min, max, step, value) {
        return '<div class="tt-training-field"><label><span>' + label + '</span><span id="' + id + '-val"></span></label>' +
            '<input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '"></div>';
    }

    function weaponSelectHtml(em) {
        var opts = getEmitterWeaponOptions();
        var html = '<div class="tt-training-field"><label>武器类型</label><select id="tt-em-weapon">';
        var i;
        for (i = 0; i < opts.length; i++) {
            var sel = Number(em.weaponType) === Number(opts[i].value) ? ' selected' : '';
            html += '<option value="' + opts[i].value + '"' + sel + '>' + opts[i].label + '</option>';
        }
        html += '</select></div>';
        return html;
    }

    function openEditPage(em) {
        normalizeEmitterConfig(em);
        showPage('edit');
        var box = document.getElementById('tt-training-edit-fields');
        if (!box) return;
        var line = isLineEmitter(em);
        var wallStatus = hasLineWall(em) ? '已附着墙壁' : '未选择墙壁';
        var parts = [
            '<div class="tt-training-field"><label>类型</label>',
            '<span class="tt-em-kind-label">' + (line ? '线发射源' : '点发射源') + '</span></div>',
            '<div class="tt-training-field"><label>名称</label>',
            '<input type="text" id="tt-em-name" value="' + (em.name || '').replace(/"/g, '&quot;') + '"></div>',
            weaponSelectHtml(em),
            fieldHtml('转动速度 (50=瞬间)', 'tt-em-rotate', 0, 50, 0.5, em.rotateSpeed),
            fieldHtml('方向随机度 (0~1)', 'tt-em-rand', 0, 1, 0.05, em.directionRandomness),
            fieldHtml('最小射击间隔 (秒)', 'tt-em-interval', 0.05, 5, 0.05, em.minShootInterval),
            fieldHtml('弹匣容量', 'tt-em-bullets', 1, 200, 1, em.bulletCount),
            fieldHtml('弹匣恢复 (秒)', 'tt-em-recovery', 0, 30, 0.5, em.magazineRecoverySec)
        ];
        if (line) {
            parts.push(fieldHtml('沿线移动速度 (格/秒)', 'tt-em-move', 0, 10, 0.1, em.moveSpeed != null ? em.moveSpeed : 1));
            parts.push(
                '<div class="tt-training-field tt-line-wall-field">',
                '  <label>墙壁附着 <span id="tt-em-line-wall-status">' + wallStatus + '</span></label>',
                '  <div class="tt-line-wall-btns">',
                '    <button type="button" class="tt-training-btn secondary" id="tt-em-pick-wall">点击地图选墙</button>',
                '    <button type="button" class="tt-training-btn secondary" id="tt-em-pick-outer">一键外边缘</button>',
                '  </div>',
                '  <p class="tt-training-hint">暂停训练后点击地图上的墙边；蓝线标示附着位置。</p>',
                '</div>'
            );
        }
        parts.push(fieldHtml(line ? '炮口朝向 (弧度)' : '起始朝向 (弧度)', 'tt-em-rotation', -3.14, 3.14, 0.05, em.rotation || 0));
        parts.push(
            '<div class="tt-training-field tt-ammo-live">',
            '  <label>当前弹匣 <span id="tt-em-ammo-live">' + getEmitterAmmoText(em.id) + '</span></label>',
            '  <button type="button" class="tt-training-btn secondary" id="tt-em-clear-mag">立即清空</button>',
            '</div>'
        );
        box.innerHTML = parts.join('');

        var ids = ['tt-em-rotate', 'tt-em-rand', 'tt-em-interval', 'tt-em-bullets', 'tt-em-recovery', 'tt-em-rotation'];
        var keys = ['rotateSpeed', 'directionRandomness', 'minShootInterval', 'bulletCount', 'magazineRecoverySec', 'rotation'];
        if (line) {
            ids.splice(5, 0, 'tt-em-move');
            keys.splice(5, 0, 'moveSpeed');
        }
        var j;
        for (j = 0; j < ids.length; j++) {
            (function(inputId, key) {
                var input = document.getElementById(inputId);
                var valEl = document.getElementById(inputId + '-val');
                function sync() {
                    var v = parseFloat(input.value);
                    em[key] = v;
                    if (valEl) valEl.textContent = String(Math.round(v * 100) / 100);
                    saveEmitters();
                    resetRuntime(em.id);
                    if (line && key === 'rotation' && state.inTrainingGame) {
                        var gc = getActiveGameController();
                        if (gc) spawnOrMoveLineEmitterTank(gc, em);
                    }
                }
                input.addEventListener('input', sync);
                sync();
            })(ids[j], keys[j]);
        }

        var weaponSel = document.getElementById('tt-em-weapon');
        if (weaponSel) {
            weaponSel.addEventListener('change', function() {
                em.weaponType = parseInt(weaponSel.value, 10);
                saveEmitters();
                resetRuntime(em.id);
                var gc = getActiveGameController();
                if (state.inTrainingGame && gc) {
                    applyEmitterWeapon(gc, em);
                }
            });
        }

        var nameInput = document.getElementById('tt-em-name');
        nameInput.addEventListener('change', function() {
            em.name = nameInput.value || em.name;
            saveEmitters();
        });

        var clearMagBtn = document.getElementById('tt-em-clear-mag');
        if (clearMagBtn) {
            clearMagBtn.addEventListener('click', function() {
                clearEmitterMagazine(em.id);
                var live = document.getElementById('tt-em-ammo-live');
                if (live) live.textContent = getEmitterAmmoText(em.id);
            });
        }

        if (line) {
            var pickWallBtn = document.getElementById('tt-em-pick-wall');
            if (pickWallBtn) {
                pickWallBtn.addEventListener('click', function() {
                    startWallPick(em);
                });
            }
            var pickOuterBtn = document.getElementById('tt-em-pick-outer');
            if (pickOuterBtn) {
                pickOuterBtn.addEventListener('click', function() {
                    var gc = getActiveGameController();
                    applyOuterEdgeWall(gc, em);
                });
            }
        }
    }

    function onAddEmitter() {
        var em = defaultEmitter();
        normalizeEmitterConfig(em);
        state.emitters.push(em);
        saveEmitters();
        var gc = typeof GameManager !== 'undefined' && GameManager.getGameController
            ? GameManager.getGameController() : null;
        if (state.inTrainingGame && gc) {
            ensureEmitterPlayers(gc);
        }
        refreshEmitterList();
        state.editId = em.id;
        openEditPage(em);
        showPage('edit');
    }

    function onAddLineEmitter() {
        var em = defaultLineEmitter();
        normalizeEmitterConfig(em);
        state.emitters.push(em);
        saveEmitters();
        var gc = typeof GameManager !== 'undefined' && GameManager.getGameController
            ? GameManager.getGameController() : null;
        if (state.inTrainingGame && gc) {
            ensureEmitterPlayers(gc);
        }
        refreshEmitterList();
        state.editId = em.id;
        openEditPage(em);
        showPage('edit');
    }

    function onDeleteEmitter() {
        if (!state.editId) return;
        var id = state.editId;
        state.emitters = state.emitters.filter(function(e) { return e.id !== id; });
        delete state.runtime[id];
        saveEmitters();
        state.editId = null;
        showPage('list');
        refreshEmitterList();
    }

    function toggleTrainingRun() {
        if (!state.inTrainingGame || state.playerDead) return;
        state.running = !state.running;
        if (!state.running) {
            var gc = getActiveGameController();
            releaseAllGatlingBursts(gc);
            if (gc && gc.roundController && typeof InputState !== 'undefined') {
                var rc = gc.roundController;
                var ei;
                for (ei = 0; ei < state.emitters.length; ei++) {
                    rc.setInputState(InputState.withState(state.emitters[ei].id, false, false, false, false, false));
                }
            }
            var k;
            for (k in state.runtime) {
                if (state.runtime.hasOwnProperty(k)) {
                    state.runtime[k].cooldown = 0;
                    state.runtime[k].firePulse = false;
                }
            }
        }
        updateStatusLine();
    }

    function onGlobalKeyDown(e) {
        var tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.key === '`' || e.key === 'Backquote') {
            e.preventDefault();
            setPanelVisible(!state.panelVisible);
            return;
        }
        if (!state.inTrainingGame) return;
        if (state.wallPickEmitterId && (e.key === 'Escape' || e.key === 'Esc')) {
            state.wallPickEmitterId = null;
            updateStatusLine();
            return;
        }
        if (e.key === 'p' || e.key === 'P') {
            e.preventDefault();
            toggleTrainingRun();
        }
    }

    /* ---------- Map drag (paused only) ---------- */

    function onMapPointerDown(e) {
        if (!state.inTrainingGame || state.running) return;
        var ui = getUIGameState();
        var gc = GameManager.getGameController();
        if (!ui || !gc || !gc.roundController) return;
        if (!gc.roundController.model.getStarted()) return;

        var maze = screenToMaze(ui, e.clientX, e.clientY);
        if (state.wallPickEmitterId) {
            var mazeObj = gc.getMaze && gc.getMaze();
            var pickId = state.wallPickEmitterId;
            if (applyLineWallPick(gc, mazeObj, maze.x, maze.y)) {
                state.editId = pickId;
                openEditPage(getEmitterById(pickId));
            }
            e.preventDefault();
            return;
        }

        var em = findNearestEmitterTank(gc.roundController, maze.x, maze.y, 3);
        if (!em) return;
        if (isLineEmitter(em) && !e.shiftKey) return;

        if (e.shiftKey) {
            state.rotateDrag = {
                emitterId: em.id,
                ui: ui
            };
        } else {
            state.drag = {
                emitterId: em.id,
                ui: ui
            };
        }
        e.preventDefault();
    }

    function onMapPointerMove(e) {
        var gc = GameManager.getGameController();
        if (!gc || !gc.roundController) return;
        var rc = gc.roundController;

        if (state.drag) {
            var maze = screenToMaze(state.drag.ui, e.clientX, e.clientY);
            var em = getEmitterById(state.drag.emitterId);
            if (!em || isLineEmitter(em) || typeof TankState === 'undefined') return;
            em.x = maze.x;
            em.y = maze.y;
            var tank = rc.getTank(em.id);
            var rot = em.rotation != null ? em.rotation : (tank ? tank.getRotation() : 0);
            var ts = TankState.withState(em.id, em.x, em.y, false, false, rot, false, false, false, false);
            rc.setTankState(ts, false);
        }

        if (state.rotateDrag) {
            var em2 = getEmitterById(state.rotateDrag.emitterId);
            var tank2 = rc.getTank(state.rotateDrag.emitterId);
            if (!em2 || !tank2) return;
            var m2 = screenToMaze(state.rotateDrag.ui, e.clientX, e.clientY);
            em2.rotation = worldAngleToPoint(tank2.getX(), tank2.getY(), m2.x, m2.y);
            var ts2 = TankState.withState(
                em2.id, tank2.getX(), tank2.getY(), false, false, em2.rotation,
                false, false, false, false
            );
            rc.setTankState(ts2, false);
        }
    }

    function onMapWheel(e) {
        if (!state.inTrainingGame || state.running) return;
        var ui = getUIGameState();
        var gc = getActiveGameController();
        if (!ui || !gc || !gc.roundController) return;
        if (!gc.roundController.model.getStarted()) return;

        var maze = screenToMaze(ui, e.clientX, e.clientY);
        var em = findNearestEmitterTank(gc.roundController, maze.x, maze.y, 4);
        if (!em) return;
        e.preventDefault();

        var step = e.deltaY > 0 ? -0.1 : 0.1;
        em.rotation = normalizeAngle((em.rotation || 0) + step);
        var tank = gc.roundController.getTank(em.id);
        if (!tank || typeof TankState === 'undefined') return;
        var ts = TankState.withState(
            em.id, tank.getX(), tank.getY(), false, false, em.rotation,
            false, false, false, false
        );
        gc.roundController.setTankState(ts, false);
    }

    function onMapPointerUp() {
        state.drag = null;
        state.rotateDrag = null;
    }

    function bindMapPointerEvents() {
        var gameDiv = document.getElementById('game');
        if (!gameDiv || gameDiv._ttTrainingPointerBound) return;
        gameDiv.addEventListener('mousedown', onMapPointerDown);
        gameDiv.addEventListener('wheel', onMapWheel, { passive: false });
        window.addEventListener('mousemove', onMapPointerMove);
        window.addEventListener('mouseup', onMapPointerUp);
        gameDiv._ttTrainingPointerBound = true;
    }

    /* ---------- Game entry ---------- */

    function createTrainingGame(lobbyState) {
        ensureDefaultEmitter();
        primeAllEmitterCaches();
        ensureTrainingPatches();

        var humanIds = getHumanPlayerIds();
        var trainingPlayerIds = getTrainingPlayerIds();
        var lobbyAiIds = [];
        var pi;
        for (pi = 0; pi < trainingPlayerIds.length; pi++) {
            var pid = trainingPlayerIds[pi];
            var isLobbyAI = (typeof Users !== 'undefined' && Users.isLobbyAIUser &&
                Users.isLobbyAIUser(pid)) ||
                (typeof AIs !== 'undefined' && AIs.isAI && AIs.isAI(pid));
            if (humanIds.indexOf(pid) < 0 && isLobbyAI) lobbyAiIds.push(pid);
        }
        // 允许无人类玩家：正常在 lobby 添加 AI 后即可进入训练/基准模式。
        if (trainingPlayerIds.length < 1) {
            // 仍然允许进入：只有发射源的纯训练场。若无发射源，训练没有意义，
            // 但不再用“必须有人类玩家”阻断。
        }

        if (typeof AIs !== 'undefined' && AIs.removeAllAIManagers) {
            AIs.removeAllAIManagers();
        }

        lobbyState.joiningGame = true;
        if (lobbyState._updateGameButtons) lobbyState._updateGameButtons();
        Constants.setMode(Constants.MODE_CLIENT_LOCAL);

        state.inTrainingGame = true;
        state.running = false;
        state.runtime = {};
        if (!state.settings) loadSettings();

        if (!state.mapGen) loadMapGenSettings();
        var mg = state.mapGen || defaultMapGenSettings();
        var maxPlayers = Math.max(
            mg.maxActivePlayerCount || 8,
            state.emitters.length + trainingPlayerIds.length
        );

        var ttGame = GameController.create(
            BootCampGameMode.create(),
            !!mg.ranked,
            !!mg.symmetric,
            false,
            maxPlayers,
            (mg.spawns && mg.spawns.crateTypes ? mg.spawns.crateTypes : mg.crateTypes).slice(),
            false,
            mg.theme
        );

        ttGame._trainingMode = true;
        applyMapGenToGameController(ttGame);
        applyTrainingSpawnConstants();
        wrapTrainingGameInstance(ttGame);
        ttGame.localPlayerIds = humanIds.slice();
        var i;
        for (i = 0; i < humanIds.length; i++) {
            ttGame.addPlayer(humanIds[i]);
        }
        // lobby 里正常添加的 AI：挂 AI manager 后作为普通玩家加入。
        for (i = 0; i < lobbyAiIds.length; i++) {
            try {
                if (typeof AIs !== 'undefined' && AIs.addAIManager) {
                    AIs.addAIManager(ttGame, lobbyAiIds[i]);
                }
            } catch (eAI) {
                if (typeof console !== 'undefined' && console.warn) {
                    console.warn('[Training Mode] AI manager 挂载失败:', lobbyAiIds[i], eAI);
                }
            }
            ttGame.addPlayer(lobbyAiIds[i]);
        }
        ensureEmitterPlayers(ttGame);

        if (ttGame.roundController) {
            ttGame.roundController.localPlayerIds = ttGame.localPlayerIds.slice();
        }

        initTrainingStats();

        ensureConfigPanel();
        bindMapPointerEvents();

        lobbyState.state.start('Game', true, false, ttGame);
    }

    function leaveTrainingGame() {
        state.inTrainingGame = false;
        state.running = false;
        state.playerDead = false;
        state.lastDeathPose = null;
        state.skipSpawnAnimationId = null;
        state.suppressTrainingSpawnFx = 0;
        state.respawnInvincibleUntil = {};
        if (state.respawnTimer) {
            clearTimeout(state.respawnTimer);
            state.respawnTimer = null;
        }
        state.stats = null;
        clearFixedLevel();
        restoreVanillaConstants();
        hideDeathOverlay();
        state.drag = null;
        state.rotateDrag = null;
        state.wallPickEmitterId = null;
        destroyLineEmitterGfx();
        var hud = document.getElementById('tt-emitter-ammo-hud');
        if (hud) hud.classList.add('tt-hidden');
        updateStatusLine();
        updateStatsUI();
        updateActionButtons();
        setTimeout(restoreLobbyUi, 0);
    }

    /* ---------- Patches ---------- */

    function patchMockData() {
        if (!window.TankTroubleLocalPatch || TankTroubleLocalPatch._trainingMockPatched) return;
        var orig = TankTroubleLocalPatch.buildMockData;
        TankTroubleLocalPatch.buildMockData = function(method, params) {
            var m = method;
            if (m && m.indexOf('tanktrouble.') === 0) {
                m = m.substring('tanktrouble.'.length);
            }
            if (m === 'getPlayerDetails') {
                var pid = params && params[0] ? String(params[0]) : '';
                if (isEmitterId(pid)) {
                    return makeEmitterPlayerDetails(pid);
                }
            }
            return orig(method, params);
        };
        TankTroubleLocalPatch._trainingMockPatched = true;
    }

    function patchLobbyStateFactory() {
        if (typeof Game === 'undefined' || !Game.UILobbyState ||
            Game.UILobbyState._ttLobbyFactoryPatched ||
            typeof Game.UILobbyState.create !== 'function') {
            return;
        }
        var origFactory = Game.UILobbyState.create;
        Game.UILobbyState.create = function() {
            var StateCtor = origFactory.apply(this, arguments);
            var stateProto = StateCtor && StateCtor.prototype;
            if (stateProto && !stateProto._trainingLobbyCreatePatched && stateProto.create) {
                var origCreate = stateProto.create;
                stateProto.create = function() {
                    origCreate.call(this);
                    if (!isLobbyUiReady(this)) return;
                    setupLobbyButton(this);
                    positionLobbyButton(this);
                    syncLobbyButton(this);
                    ensureLobbyButtonVisible(this);
                };
                stateProto._trainingLobbyCreatePatched = true;
            }
            return StateCtor;
        };
        Game.UILobbyState._ttLobbyFactoryPatched = true;
    }

    function patchLobbyCreate() {
        patchLobbyStateFactory();
        if (typeof Game === 'undefined' || !Game.UILobbyState) return false;
        var proto = Game.UILobbyState.prototype;
        if (!proto || proto._trainingLobbyCreatePatched || !proto.create) return true;
        var origCreate = proto.create;
        proto.create = function() {
            origCreate.call(this);
            if (!isLobbyUiReady(this)) return;
            setupLobbyButton(this);
            positionLobbyButton(this);
            syncLobbyButton(this);
            ensureLobbyButtonVisible(this);
        };
        proto._trainingLobbyCreatePatched = true;
        return true;
    }

    function attachToActiveLobby() {
        var ph = getMainPhaser();
        if (!ph || !ph.state) return false;
        if (ph.state.current !== 'Lobby') return false;
        var lobby = ph.state.getCurrentState();
        if (!lobby || !isLobbyUiReady(lobby)) return false;
        setupLobbyButton(lobby);
        positionLobbyButton(lobby);
        syncLobbyButton(lobby);
        ensureLobbyButtonVisible(lobby);
        return !!lobby.trainingGameButton;
    }

    function scheduleAttachToActiveLobby() {
        if (state._attachTimer) return;
        var attempts = 0;
        state._attachTimer = setInterval(function() {
            attempts += 1;
            var ph = getMainPhaser();
            if (ph && ph.state && ph.state.current === 'Lobby') {
                if (attachToActiveLobby()) {
                    clearInterval(state._attachTimer);
                    state._attachTimer = null;
                    return;
                }
            }
            if (attempts >= 200) {
                clearInterval(state._attachTimer);
                state._attachTimer = null;
            }
        }, 50);
    }

    function ensureLobbyButtonVisible(lobbyState) {
        var btn = lobbyState && lobbyState.trainingGameButton;
        if (!btn) return;
        if (btn.spawn && (!btn.exists || (btn.scale && btn.scale.x < 0.1))) {
            btn.spawn();
        }
        btn.exists = true;
        btn.visible = true;
        if (btn.scale && btn.scale.x < 0.5) {
            btn.scale.set(1, 1);
        }
        if (lobbyState.localGameButton && lobbyState.localGameButton.bringToTop && lobbyState.localGameButton.parent) {
            lobbyState.localGameButton.bringToTop();
        }
        if (btn.bringToTop && btn.parent) {
            btn.bringToTop();
        }
    }

    function hookPhaserStateChanges(ph) {
        if (!ph || !ph.state || ph.state._ttTrainingStateHooked) return;
        var st = ph.state;
        var onLobby = function() {
            if (st.current !== 'Lobby') return;
            patchLobbyCreate();
            setTimeout(restoreLobbyUi, 0);
        };
        if (st.onStateChange && st.onStateChange.add) {
            st.onStateChange.add(onLobby);
        }
        st._ttTrainingStateHooked = true;
    }

    function hookGameManagerInsertGame() {
        if (typeof GameManager === 'undefined' || !GameManager.insertGame ||
            GameManager._ttTrainingInsertHooked) {
            return true;
        }
        var origInsert = GameManager.insertGame;
        GameManager.insertGame = function(parentElement) {
            patchLobbyStateFactory();
            var ph = origInsert.apply(GameManager, arguments);
            hookPhaserStateChanges(ph);
            setupLobbyHooks();
            patchLobbyStateFactory();
            scheduleAttachToActiveLobby();
            return ph;
        };
        GameManager._ttTrainingInsertHooked = true;
        var existing = getMainPhaser();
        if (existing) hookPhaserStateChanges(existing);
        return true;
    }

    function setupLobbyButton(lobbyState) {
        var skipReason = null;
        if (!lobbyState) skipReason = 'no_lobbyState';
        else if (lobbyState.trainingGameButton) skipReason = 'already_has_button';
        else if (typeof UIButtonGroup === 'undefined') skipReason = 'no_UIButtonGroup';
        else if (typeof UIConstants === 'undefined') skipReason = 'no_UIConstants';
        if (skipReason) {
            if (skipReason === 'already_has_button' && isLobbyUiReady(lobbyState)) {
                positionLobbyButton(lobbyState);
                syncLobbyButton(lobbyState);
                ensureLobbyButtonVisible(lobbyState);
            }
            return;
        }
        if (!isLobbyUiReady(lobbyState)) return;
        try {
            lobbyState.trainingGameButton = lobbyState.game.add.existing(new UIButtonGroup(
                lobbyState.game,
                lobbyState.game.width / 2.0,
                getTrainingLobbyY(lobbyState.game, lobbyState),
                '',
                UIConstants.BUTTON_SIZES.LARGE,
                'Training',
                function() {
                    createTrainingGame(lobbyState);
                },
                lobbyState
            ));
            if (lobbyState.trainingGameButton.spawn) {
                lobbyState.trainingGameButton.spawn();
            }
            ensureLobbyButtonVisible(lobbyState);
        } catch (err) {
            console.warn('[Training Mode] setupLobbyButton failed:', err);
        }
    }

    function positionLobbyButton(lobbyState) {
        if (lobbyState && lobbyState.trainingGameButton) {
            lobbyState.trainingGameButton.x = lobbyState.game.width / 2.0;
            lobbyState.trainingGameButton.y = getTrainingLobbyY(lobbyState.game, lobbyState);
        }
    }

    function syncLobbyButton(lobbyState) {
        if (!lobbyState || !lobbyState.trainingGameButton) return;
        if (lobbyState.joiningGame) {
            lobbyState.trainingGameButton.disable();
        } else {
            lobbyState.trainingGameButton.enable();
        }
    }

    function retireLobbyButton(lobbyState) {
        if (lobbyState && lobbyState.trainingGameButton && lobbyState.trainingGameButton.retire) {
            lobbyState.trainingGameButton.retire();
        }
    }

    function setupLobbyHooks() {
        if (typeof Game === 'undefined' || !Game.UILobbyState) return false;
        var proto = Game.UILobbyState.prototype;
        if (!proto) return false;
        if (proto._trainingLobbyHooked) {
            patchLobbyCreate();
            scheduleAttachToActiveLobby();
            return true;
        }
        proto._trainingLobbyHooked = true;

        patchLobbyCreate();

        if (proto._onSizeChangeHandler) {
            var origSize = proto._onSizeChangeHandler;
            proto._onSizeChangeHandler = function() {
                origSize.call(this);
                positionLobbyButton(this);
            };
        }

        if (proto._updateGameButtons) {
            var origUpdateBtns = proto._updateGameButtons;
            proto._updateGameButtons = function() {
                origUpdateBtns.call(this);
                syncLobbyButton(this);
            };
        }

        if (proto._retireUI) {
            var origRetire = proto._retireUI;
            proto._retireUI = function() {
                origRetire.call(this);
            };
        }

        var origRemove = proto._removeUI;
        if (origRemove) {
            proto._removeUI = function() {
                if (this.trainingGameButton && this.trainingGameButton.remove) {
                    this.trainingGameButton.remove();
                }
                origRemove.call(this);
            };
        }

        scheduleAttachToActiveLobby();
        return true;
    }

    function patchRoundModelForTraining() {
        if (typeof RoundModel === 'undefined' || !RoundModel.prototype ||
            RoundModel.prototype._ttTrainingReloadPatched) {
            return true;
        }

        function skipReloadForEmitter(self, projectileId, eventName) {
            var projectile = self.projectiles[projectileId];
            if (!projectile || !isEmitterId(projectile.getPlayerId())) {
                return false;
            }
            self.cachedRoundState = null;
            self.destroyedProjectileIds.push(projectileId);
            self._notifyEventListeners(eventName, projectileId);
            return true;
        }

        if (RoundModel.prototype.timeoutProjectile) {
            var origTimeout = RoundModel.prototype.timeoutProjectile;
            RoundModel.prototype.timeoutProjectile = function(projectileId) {
                if (skipReloadForEmitter(this, projectileId, RoundModel._EVENTS.PROJECTILE_TIMEOUT)) {
                    return;
                }
                return origTimeout.call(this, projectileId);
            };
        }

        if (RoundModel.prototype.destroyProjectile) {
            var origDestroy = RoundModel.prototype.destroyProjectile;
            RoundModel.prototype.destroyProjectile = function(projectileId) {
                if (skipReloadForEmitter(this, projectileId, RoundModel._EVENTS.PROJECTILE_DESTROYED)) {
                    return;
                }
                return origDestroy.call(this, projectileId);
            };
        }

        RoundModel.prototype._ttTrainingReloadPatched = true;
        return true;
    }

    /**
     * v48：给 RoundModel.update 装“步长表”。这是 Vantage 树时间轴同源的
     * 最权威数据源：b2dworld.Step 实际收到的 dt 在这里记录，不靠 GameController
     * 包装层估计。下一 tick 开始时，真实坦克已经按这步走完，树也用这步推进。
     */
    function patchRoundModelStepMeter() {
        if (typeof RoundModel === 'undefined' || !RoundModel.prototype ||
            RoundModel.prototype._ttStepMeterPatched) {
            return true;
        }
        if (!RoundModel.prototype.update) return false;
        var origUpdate = RoundModel.prototype.update;
        RoundModel.prototype.update = function(deltaTime) {
            if (this.running) {
                this._ttStepCount = (this._ttStepCount || 0) + 1;
                this._ttLastStepDt = (typeof deltaTime === 'number' && isFinite(deltaTime))
                    ? deltaTime : 0.02;
            }
            return origUpdate.call(this, deltaTime);
        };
        RoundModel.prototype._ttStepMeterPatched = true;
        return true;
    }

    function patchEmitterPullTrigger() {
        if (typeof RoundController === 'undefined' || !RoundController.prototype) {
            return true;
        }
        if (RoundController.prototype._ttEmitterPullPatchVer === 3) {
            return true;
        }
        if (!RoundController.prototype._ttOrigPullTrigger) {
            RoundController.prototype._ttOrigPullTrigger = RoundController.prototype.pullTrigger;
        }
        var origPull = RoundController.prototype._ttOrigPullTrigger;
        RoundController.prototype.pullTrigger = function(playerId) {
            if (state.inTrainingGame && isEmitterId(playerId)) {
                if (!state.running) {
                    return;
                }
                var em = getEmitterById(playerId);
                if (!em) {
                    return;
                }
                if (isGatlingEmitter(em)) {
                    return origPull.call(this, playerId);
                }
                if (isHomingEmitter(em)) {
                    var rt = getRuntime(playerId);
                    var weapon = this.getActiveWeapon(playerId);
                    var homingInFlight = 0;
                    if (typeof Constants !== 'undefined') {
                        homingInFlight = countEmitterProjectiles(this, playerId,
                            Constants.WEAPON_TYPES.HOMING_MISSILE);
                    }
                    if (!rt || rt.ammo < 1 || !weapon || weapon._launched || homingInFlight > 0) {
                        return;
                    }
                    origPull.call(this, playerId);
                    var after = this.getActiveWeapon(playerId);
                    if (after && after._launched) {
                        rt.ammo -= 1;
                        rt.cooldown = Math.max(0.05, em.minShootInterval || 0.5);
                        advanceEmitterAim(rt);
                        if (rt.ammo <= 0) {
                            startMagazineReload(rt, em);
                        }
                    }
                    return;
                }
                return;
            }
            return origPull.call(this, playerId);
        };
        RoundController.prototype._ttEmitterPullPatchVer = 3;
        RoundController.prototype._ttEmitterPullPatched = true;
        return true;
    }

    function patchEmitterReleaseTrigger() {
        if (typeof RoundController === 'undefined' || !RoundController.prototype ||
            RoundController.prototype._ttEmitterReleasePatched) {
            return true;
        }
        var origRelease = RoundController.prototype.releaseTrigger;
        RoundController.prototype.releaseTrigger = function(playerId) {
            if (state.inTrainingGame && isEmitterId(playerId) && !state.running) {
                return;
            }
            return origRelease.call(this, playerId);
        };
        RoundController.prototype._ttEmitterReleasePatched = true;
        return true;
    }

    function patchEmitterDelayedFire() {
        if (typeof RoundController === 'undefined' || !RoundController.prototype ||
            RoundController.prototype._ttEmitterDelayedPatched) {
            return true;
        }
        var origDelayed = RoundController.prototype.delayedFire;
        RoundController.prototype.delayedFire = function(playerId) {
            if (state.inTrainingGame && isEmitterId(playerId)) {
                return;
            }
            return origDelayed.call(this, playerId);
        };
        RoundController.prototype._ttEmitterDelayedPatched = true;
        return true;
    }

    function patchEmitterWeaponDestroy() {
        if (typeof RoundController === 'undefined' || !RoundController.prototype ||
            RoundController.prototype._ttEmitterWeaponDestroyVer === 2) {
            return true;
        }
        var origDestroy = RoundController.prototype.destroyWeapon;
        RoundController.prototype.destroyWeapon = function(weaponDeactivation) {
            if (state.inTrainingGame && weaponDeactivation) {
                var emitterId = weaponDeactivation.getPlayerId
                    ? weaponDeactivation.getPlayerId() : null;
                if (emitterId && isEmitterId(emitterId)) {
                    var em = getEmitterById(emitterId);
                    var weaponId = weaponDeactivation.getWeaponId
                        ? weaponDeactivation.getWeaponId() : null;
                    var weapon = this.model && this.model.weapons && weaponId
                        ? this.model.weapons[weaponId] : null;
                    if (em && weapon && resetEmitterConfiguredWeapon(weapon, em)) {
                        return;
                    }
                }
            }
            var playerId = weaponDeactivation && weaponDeactivation.getPlayerId
                ? weaponDeactivation.getPlayerId() : null;
            origDestroy.call(this, weaponDeactivation);
            if (state.inTrainingGame && playerId && isEmitterId(playerId)) {
                var em = getEmitterById(playerId);
                if (em) {
                    var active = this.getActiveWeapon(playerId);
                    if (!active || !emitterWeaponTypeMatches(active, em)) {
                        applyEmitterWeapon({ roundController: this }, em);
                    }
                }
            }
        };
        RoundController.prototype._ttEmitterWeaponDestroyVer = 2;
        return true;
    }

    function patchKillTank() {
        if (typeof RoundController === 'undefined' || !RoundController.prototype ||
            RoundController.prototype._trainingKillPatched) {
            return true;
        }
        var origKill = RoundController.prototype.killTank;
        RoundController.prototype.killTank = function(kill) {
            if (kill && kill.getVictimPlayerId && isEmitterId(kill.getVictimPlayerId())) {
                return;
            }
            var victim = kill && kill.getVictimPlayerId ? kill.getVictimPlayerId() : null;
            if (victim && isTrainingPlayerInvincible(victim)) {
                return;
            }
            var deathPose = null;
            if (victim && !isEmitterId(victim)) {
                var deadTank = this.getTank(victim);
                if (deadTank) {
                    deathPose = {
                        x: deadTank.getX(),
                        y: deadTank.getY(),
                        rotation: deadTank.getRotation()
                    };
                }
            }
            var result = origKill.call(this, kill);
            if (victim && !isEmitterId(victim)) {
                onTrainingPlayerDeath(victim, deathPose);
            }
            return result;
        };
        var origDestroy = RoundController.prototype.destroyTank;
        RoundController.prototype.destroyTank = function(playerId) {
            if (isEmitterId(playerId)) return;
            return origDestroy.call(this, playerId);
        };
        if (RoundController.prototype.removeTank) {
            var origRemoveTank = RoundController.prototype.removeTank;
            RoundController.prototype.removeTank = function(playerId) {
                if (isEmitterId(playerId)) return;
                return origRemoveTank.call(this, playerId);
            };
        }
        RoundController.prototype._trainingKillPatched = true;
        return true;
    }

    function patchGameController() {
        if (typeof GameController === 'undefined' || !GameController.prototype ||
            GameController.prototype._trainingGCPatched) {
            return true;
        }
        if (!GameController.prototype.update) {
            return false;
        }

        var origInitRound = GameController.prototype._initializeRound;
        if (typeof origInitRound === 'function') {
            GameController.prototype._initializeRound = function() {
                if (this._trainingMode) {
                    trainingAfterInitializeRound(this, origInitRound);
                    return;
                }
                origInitRound.call(this);
            };
        }

        var origUpdate = GameController.prototype.update;
        GameController.prototype.update = function() {
            var t0 = this.lastUpdate;
            if (this._trainingMode && this.model &&
                typeof GameModel !== 'undefined' &&
                this.model.getState() === GameModel._STATES.BETWEEN_ROUNDS) {
                this.betweenRoundsDuration = 1e6;
                this.celebrationStarted = true;
                this.celebrationEnded = true;
            }
            var deltaTime = Math.min(
                (new Date() - t0) / 1000.0,
                (typeof Constants !== 'undefined' && Constants.MAX_DELTA_TIME) || 0.1
            );
            if (this._trainingMode && this.model) {
                updateTrainingEmitters(this, deltaTime);
                updateHumanInvincibilityCollision(this);
            }
            origUpdate.call(this);
            if (!this._trainingMode || !this.model) return;
            var rcM2 = this.roundController && this.roundController.model;
            if (rcM2 && rcM2.running) {
                this._ttWorldStepCount = (this._ttWorldStepCount || 0) + 1;
                this._ttLastWorldDt = Math.min(
                    (new Date() - t0) / 1000.0,
                    (typeof Constants !== 'undefined' && Constants.MAX_DELTA_TIME) || 0.1
                );
            }
            updateEmitterAmmoHUD(this);
            updateTrainingStats(deltaTime, this);
            if (this.model.getState() === GameModel._STATES.ENDED) {
                this.model.setState(GameModel._STATES.BETWEEN_ROUNDS);
                this.betweenRoundsDuration = 1e6;
                this.celebrationStarted = true;
                this.celebrationEnded = true;
            }
        };

        if (GameController.prototype._roundModelEventHandler) {
            var origRoundModel = GameController.prototype._roundModelEventHandler;
            GameController.prototype._roundModelEventHandler = function(self, id, evt, data) {
                if (self._trainingMode && typeof RoundModel !== 'undefined' &&
                    evt === RoundModel._EVENTS.ROUND_ENDED) {
                    return;
                }
                return origRoundModel.call(this, self, id, evt, data);
            };
        }

        GameController.prototype._trainingGCPatched = true;
        return true;
    }

    function patchUIGameStateSpawnHandlers() {
        if (typeof Game === 'undefined' || !Game.UIGameState) return false;
        var proto = Game.UIGameState.prototype;
        if (!proto) return false;

        if (proto._createTank && !proto._ttTrainingSpawnPatched) {
            var origCreateTank = proto._createTank;
            proto._createTank = function(tank, playSpawnAnimation, smoothing) {
                if (tank && shouldSuppressTrainingSpawnFx(tank.getPlayerId())) {
                    playSpawnAnimation = false;
                }
                return origCreateTank.call(this, tank, playSpawnAnimation, smoothing);
            };
            proto._ttTrainingSpawnPatched = true;
        }

        if (proto._createWeapon && !proto._ttTrainingWeaponSpawnPatched) {
            var origCreateWeapon = proto._createWeapon;
            proto._createWeapon = function(weapon, playSpawnAnimation) {
                if (weapon && shouldSuppressTrainingSpawnFx(weapon.getPlayerId())) {
                    playSpawnAnimation = false;
                }
                return origCreateWeapon.call(this, weapon, playSpawnAnimation);
            };
            proto._ttTrainingWeaponSpawnPatched = true;
        }

        if (proto._createCollectible && !proto._ttTrainingCollectibleSpawnPatched) {
            var origCreateCollectible = proto._createCollectible;
            proto._createCollectible = function(collectible, playSpawnAnimation) {
                if (state.suppressTrainingSpawnFx > 0) {
                    playSpawnAnimation = false;
                }
                return origCreateCollectible.call(this, collectible, playSpawnAnimation);
            };
            proto._ttTrainingCollectibleSpawnPatched = true;
        }

        if (proto._createUpgrade && !proto._ttTrainingUpgradeSpawnPatched) {
            var origCreateUpgrade = proto._createUpgrade;
            proto._createUpgrade = function(upgrade, playSpawnAnimation) {
                if (upgrade && shouldSuppressTrainingSpawnFx(upgrade.getPlayerId())) {
                    playSpawnAnimation = false;
                }
                return origCreateUpgrade.call(this, upgrade, playSpawnAnimation);
            };
            proto._ttTrainingUpgradeSpawnPatched = true;
        }

        return true;
    }

    function patchUIGameState() {
        patchUIGameStateSpawnHandlers();
        if (typeof Game === 'undefined' || !Game.UIGameState ||
            Game.UIGameState._trainingPatched) {
            return true;
        }
        var proto = Game.UIGameState.prototype;
        if (!proto || !proto._leaveState) return false;

        var origLeave = proto._leaveState;
        proto._leaveState = function() {
            if (this.gameController && this.gameController._trainingMode) {
                leaveTrainingGame();
            }
            origLeave.call(this);
            setTimeout(restoreLobbyUi, 0);
        };

        var origRound = proto._roundEventHandler;
        proto._roundEventHandler = function(self, id, evt, data) {
            origRound.call(this, self, id, evt, data);
            if (self && self.gameController && self.gameController._trainingMode &&
                typeof RoundModel !== 'undefined') {
                if (evt === RoundModel._EVENTS.ROUND_STARTED) {
                    if (state.fixedMazeData || state.useFixedEmitterPositions) {
                        applyEmitterPositionsFromConfig(self.gameController);
                    } else {
                        randomizeEmitterPositions(self.gameController);
                    }
                    bindTrainingKeys(self);
                }
            }
        };

        Game.UIGameState._trainingPatched = true;
        return true;
    }

    function patchUISpawnAnimations() {
        patchUIGameStateSpawnHandlers();
        if (typeof UITankSprite !== 'undefined' && UITankSprite.prototype &&
            !UITankSprite.prototype._ttTrainingSpawnPatched) {
            var origTankSpawn = UITankSprite.prototype.spawn;
            UITankSprite.prototype.spawn = function(x, y, rotation, playerId, animate, smoothing) {
                if (shouldSuppressTrainingSpawnFx(playerId)) {
                    animate = false;
                }
                origTankSpawn.call(this, x, y, rotation, playerId, animate, smoothing);
                if (shouldSuppressTrainingSpawnFx(playerId)) {
                    forceTankSpriteSpawnScale(this);
                }
                var em = getEmitterById(playerId);
                if (em && isLineEmitter(em)) {
                    this.visible = false;
                    this.alpha = 0;
                    this.renderable = false;
                }
            };
            UITankSprite.prototype._ttTrainingSpawnPatched = true;
        }

        if (typeof UICrateSprite !== 'undefined' && UICrateSprite.prototype &&
            !UICrateSprite.prototype._ttTrainingSpawnPatched) {
            var origCrateSpawn = UICrateSprite.prototype.spawn;
            UICrateSprite.prototype.spawn = function(x, y, rotation, contentFrame, crateId, animate) {
                if (state.suppressTrainingSpawnFx > 0) {
                    animate = false;
                }
                origCrateSpawn.call(this, x, y, rotation, contentFrame, crateId, animate);
                if (state.suppressTrainingSpawnFx > 0 && typeof UIConstants !== 'undefined') {
                    if (this.spawnTween) {
                        this.spawnTween.stop();
                        this.spawnTween = null;
                    }
                    this.scale.setTo(UIConstants.GAME_ASSET_SCALE, UIConstants.GAME_ASSET_SCALE);
                }
            };
            UICrateSprite.prototype._ttTrainingSpawnPatched = true;
        }

        return true;
    }

    function patchInputs() {
        if (typeof Inputs === 'undefined' || Inputs._trainingPatched) return true;
        if (Inputs.loadInputSetAssignments && !Inputs._trainingLoadPatched) {
            var origLoad = Inputs.loadInputSetAssignments;
            Inputs.loadInputSetAssignments = function(playerIds) {
                var filtered = playerIds;
                if (Array.isArray(playerIds)) {
                    filtered = [];
                    var i;
                    for (i = 0; i < playerIds.length; i++) {
                        if (!isEmitterId(playerIds[i])) {
                            filtered.push(playerIds[i]);
                        }
                    }
                }
                return origLoad(filtered);
            };
            Inputs._trainingLoadPatched = true;
        }
        Inputs._trainingPatched = true;
        return true;
    }

    function countTrainingPlayerSlots(ids) {
        if (!ids) return 0;
        var combat = 0;
        var hasEmitter = false;
        var i;
        for (i = 0; i < ids.length; i++) {
            if (isEmitterId(ids[i])) {
                hasEmitter = true;
            } else {
                combat++;
            }
        }
        return combat + (hasEmitter ? 1 : 0);
    }

    function countTrainingCombatants(tanks) {
        if (!tanks) return 0;
        var ids = Object.keys(tanks);
        var combat = 0;
        var hasEmitter = false;
        var i;
        for (i = 0; i < ids.length; i++) {
            if (isEmitterId(ids[i])) {
                hasEmitter = true;
            } else {
                combat++;
            }
        }
        return combat + (hasEmitter ? 1 : 0);
    }

    function patchGameModel() {
        if (typeof GameModel === 'undefined' || !GameModel.prototype ||
            GameModel.prototype._ttTrainingPatched) {
            return true;
        }
        if (!GameModel.prototype.getActivePlayerCount) return false;
        var origActive = GameModel.prototype.getActivePlayerCount;
        GameModel.prototype.getActivePlayerCount = function() {
            if (!state.inTrainingGame) {
                return origActive.call(this);
            }
            return countTrainingPlayerSlots(Object.keys(this.activePlayers));
        };
        GameModel.prototype._ttTrainingPatched = true;
        return true;
    }

    function patchBootCampGameMode() {
        if (typeof BootCampGameMode === 'undefined' || !BootCampGameMode.prototype) {
            return false;
        }
        if (BootCampGameMode.prototype._ttTrainingPatched) {
            return true;
        }

        if (BootCampGameMode.prototype.isRoundOver) {
            var origIsOver = BootCampGameMode.prototype.isRoundOver;
            BootCampGameMode.prototype.isRoundOver = function() {
                if (state.inTrainingGame) return false;
                return origIsOver.call(this);
            };
        }

        if (BootCampGameMode.prototype.update) {
            var origUpdate = BootCampGameMode.prototype.update;
            BootCampGameMode.prototype.update = function(deltaTime) {
                origUpdate.call(this, deltaTime);
                if (!state.inTrainingGame) return;
                if (this.tanks) {
                    this.tankCount = countTrainingCombatants(this.tanks);
                }
                if (typeof Constants !== 'undefined' && Constants.ROUND_FINISHING_DURATION) {
                    this.roundFinishingDuration = Constants.ROUND_FINISHING_DURATION;
                }
            };
        }

        if (BootCampGameMode.prototype.getMaze) {
            var origGetMaze = BootCampGameMode.prototype.getMaze;
            BootCampGameMode.prototype.getMaze = function(playerIds, theme) {
                if (state.inTrainingGame && state.fixedMazeData && typeof Maze !== 'undefined') {
                    return Maze.withObject(cloneJson(state.fixedMazeData));
                }
                if (state.inTrainingGame && state.mapGen) {
                    return getOrGenerateTrainingMaze(this, playerIds, theme, origGetMaze);
                }
                return origGetMaze.call(this, playerIds, theme);
            };
        }

        BootCampGameMode.prototype._ttTrainingPatched = true;
        return true;
    }

    function ensureTrainingPatches() {
        patchMockData();
        patchRoundModelForTraining();
        patchRoundModelStepMeter();
        patchEmitterPullTrigger();
        patchEmitterReleaseTrigger();
        patchEmitterDelayedFire();
        patchEmitterWeaponDestroy();
        patchKillTank();
        patchGameController();
        patchGameModel();
        patchBootCampGameMode();
        patchUISpawnAnimations();
        patchUIGameState();
        patchInputs();
        patchLobbyCreate();
        patchLobbyStateFactory();
    }

    /* ---------- 外部集成接口（Vantage 基准测试用） ---------- */

    function replaceEmittersForExternal(list) {
        if (!Array.isArray(list)) return 0;
        var oldIds = {};
        var oi;
        for (oi = 0; oi < state.emitters.length; oi++) {
            oldIds[state.emitters[oi].id] = true;
        }
        state.emitters = [];
        var fixedPositions = true;
        for (var i = 0; i < list.length; i++) {
            var em = cloneJson(list[i]);
            normalizeEmitterConfig(em);
            state.emitters.push(em);
            if (em.x == null || em.y == null) fixedPositions = false;
        }
        state.useFixedEmitterPositions = fixedPositions && state.emitters.length > 0;
        primeAllEmitterCaches();
        saveEmitters();
        var gc = getActiveGameController();
        if (state.inTrainingGame && gc) {
            // 当前游戏是按旧 maxActivePlayerCount 建的：模板换多发射源时，
            // 先放大容量，否则 restartMap 只会激活前 8 个（甚至仍是旧默认源）。
            if (gc.setMaxActivePlayerCount && gc.getMaxActivePlayerCount) {
                var needSlots = state.emitters.length + getTrainingPlayerIds().length;
                if (needSlots > gc.getMaxActivePlayerCount()) {
                    gc.setMaxActivePlayerCount(needSlots);
                }
            }
            ensureEmitterPlayers(gc);
            for (var j = 0; j < state.emitters.length; j++) {
                applyEmitterWeapon(gc, state.emitters[j]);
            }
            updateEmitterAmmoHUD(gc);
        }
        refreshEmitterList();
        if (typeof console !== 'undefined') {
            console.log('[Training Mode] replaceEmitters 完成，当前发射源数:', state.emitters.length);
        }
        return state.emitters.length;
    }

    function setRunningForExternal(v) {
        if (!state.inTrainingGame) return false;
        if (state.playerDead) return false;
        v = !!v;
        if (state.running === v) {
            updateStatusLine();
            return true;
        }
        state.running = v;
        if (!v) {
            var gc = getActiveGameController();
            releaseAllGatlingBursts(gc);
            if (gc && gc.roundController && typeof InputState !== 'undefined') {
                var rc = gc.roundController;
                var ei;
                for (ei = 0; ei < state.emitters.length; ei++) {
                    rc.setInputState(InputState.withState(state.emitters[ei].id, false, false, false, false, false));
                }
            }
            var k;
            for (k in state.runtime) {
                if (state.runtime.hasOwnProperty(k)) {
                    state.runtime[k].cooldown = 0;
                    state.runtime[k].firePulse = false;
                }
            }
        }
        updateStatusLine();
        return true;
    }

    function applySettingsPatchForExternal(patch) {
        if (!state.settings) loadSettings();
        if (!patch || typeof patch !== 'object') return state.settings;
        if (typeof patch.autoRespawn === 'boolean') state.settings.autoRespawn = patch.autoRespawn;
        if (typeof patch.respawnInPlace === 'boolean') state.settings.respawnInPlace = patch.respawnInPlace;
        if (typeof patch.autoNewMap === 'boolean') state.settings.autoNewMap = patch.autoNewMap;
        if (typeof patch.respawnDelaySec === 'number' && isNaN(patch.respawnDelaySec) === false) {
            state.settings.respawnDelaySec = Math.max(0, Math.min(5, patch.respawnDelaySec));
        }
        saveSettings();
        syncSettingsUI();
        return state.settings;
    }

    function setFixedHumanSpawnForExternal(spawn) {
        if (!spawn || typeof spawn.x !== 'number' || typeof spawn.y !== 'number') {
            state.fixedHumanSpawn = null;
            return null;
        }
        state.fixedHumanSpawn = {
            x: spawn.x,
            y: spawn.y,
            rotation: typeof spawn.rotation === 'number' ? spawn.rotation : 0
        };
        return state.fixedHumanSpawn;
    }

    function resolveBenchmarkSpawnForExternal(maze, mode) {
        if (!maze || !maze.getWidth || !maze.getTiles) return null;
        var w = maze.getWidth(), h = maze.getHeight();
        var modeTargets = {
            center: { x: (w - 1) * 0.5, y: (h - 1) * 0.5 },
            corner: { x: 1.0, y: 1.0 },
            left: { x: 1.0, y: (h - 1) * 0.5 },
            right: { x: w - 2.0, y: (h - 1) * 0.5 }
        };
        var target = modeTargets[mode] || modeTargets.center;
        var tiles = maze.getTiles();
        var best = null, bestD = Infinity, col, row, d, tile;
        for (col = 0; col < w; col++) {
            for (row = 0; row < h; row++) {
                tile = tiles[col][row];
                if (!tile || tile[0] !== 1) continue;
                d = (col - target.x) * (col - target.x) + (row - target.y) * (row - target.y);
                if (d < bestD) { bestD = d; best = { x: col, y: row }; }
            }
        }
        if (!best) return null;
        var physX = (best.x + 0.5) * (typeof Constants !== 'undefined' ? Constants.MAZE_TILE_SIZE.m : 10);
        var physY = (best.y + 0.5) * (typeof Constants !== 'undefined' ? Constants.MAZE_TILE_SIZE.m : 10);
        var rot = 0;
        if (mode === 'left') rot = Math.PI * 0.5;        // 面向 +x
        else if (mode === 'right') rot = -Math.PI * 0.5; // 面向 -x
        else if (mode === 'corner') {
            var dx = (w - 1) * 0.5 - best.x;
            var dy = (h - 1) * 0.5 - best.y;
            rot = Math.atan2(dx, -dy);                    // 游戏朝向向量 (sin, -cos)
        }
        return { x: physX, y: physY, rotation: rot };
    }

    function prepareBenchmarkMapForExternal(mapGen, spawnMode) {
        if (!mapGen || typeof mapGen !== 'object') return null;
        state.mapGen = normalizeMapGenSettings(mapGen);
        ensureMapGenMazeDefaults(state.mapGen);
        saveMapGenSettings();
        clearFixedLevel();
        // 根因修复：不在大厅/主页/进入训练时同步生成 Maze。
        // 只保存地图分类参数，并把出生点保存为 mode；真正的地图由
        // 训练模式的 BootCampGameMode.getMaze 在开新局时生成，
        // trainingAfterInitializeRound 再按 mode 在合法格上解析出生点。
        state.fixedHumanSpawn = { mode: spawnMode || 'center' };
        return {
            mapClass: mapGen.mapClass || 'custom',
            spawnMode: spawnMode || 'center',
            fixedMaze: false,
            fixedHumanSpawn: state.fixedHumanSpawn
        };
    }

    function getTrainingStatsForExternal() {
        return state.stats ? cloneJson(state.stats) : null;
    }

    function getTrainingStateForExternal() {
        return {
            inTrainingGame: state.inTrainingGame,
            running: state.running,
            playerDead: state.playerDead,
            emitterCount: state.emitters.length
        };
    }

    function restartTrainingMapForExternal(resumeRunning) {
        restartTrainingMap(!!resumeRunning);
    }

    function install() {
        if (state._patchesApplied) {
            ensureTrainingPatches();
            loadSettings();
            loadMapGenSettings();
            ensureConfigPanel();
            return true;
        }
        try {
            loadEmitters();
            loadSettings();
            loadMapGenSettings();
            primeAllEmitterCaches();
            ensureTrainingPatches();
            hookGameManagerInsertGame();
            setupLobbyHooks();
            ensureConfigPanel();
            state._patchesApplied = true;
            console.log('[Training Mode] installed');
        } catch (err) {
            console.error('[Training Mode] install failed:', err);
            return false;
        }
        return true;
    }

    window.TankTroubleTrainingMode = {
        install: install,
        ensureTrainingPatches: ensureTrainingPatches,
        getUIGameState: getUIGameState,
        screenToMaze: screenToMaze,
        getEmitterPlayerDetailsRaw: makeEmitterPlayerDetails,
        setupLobbyHooks: setupLobbyHooks,
        hookGameManagerInsertGame: hookGameManagerInsertGame,
        setupLobbyButton: setupLobbyButton,
        positionLobbyButton: positionLobbyButton,
        syncLobbyButton: syncLobbyButton,
        ensureLobbyButtonVisible: ensureLobbyButtonVisible,
        restoreLobbyUi: restoreLobbyUi,
        attachToActiveLobby: attachToActiveLobby,
        scheduleAttachToActiveLobby: scheduleAttachToActiveLobby,
        isActive: function() { return state.inTrainingGame; },
        isRunning: function() { return state.running; },
        toggleRun: toggleTrainingRun,
        getEmitters: function() { return state.emitters.slice(); },
        isEmitterId: isEmitterId,
        exportEmitterConfig: exportEmitterConfig,
        exportLevelConfig: exportLevelConfig,
        exportMapGenConfig: exportMapGenConfig,
        applyEmitterConfig: applyEmitterConfig,
        applyLevelConfig: applyLevelConfig,
        applyMapGenConfig: applyMapGenConfig,
        buildEmitterConfigExport: buildEmitterConfigExport,
        buildLevelExport: buildLevelExport,
        buildMapGenExport: buildMapGenExport,
        replaceEmitters: replaceEmittersForExternal,
        applySettingsPatch: applySettingsPatchForExternal,
        setRunning: setRunningForExternal,
        setFixedHumanSpawn: setFixedHumanSpawnForExternal,
        prepareBenchmarkMap: prepareBenchmarkMapForExternal,
        getStats: getTrainingStatsForExternal,
        getTrainingState: getTrainingStateForExternal,
        restartMap: restartTrainingMapForExternal
    };
})();
