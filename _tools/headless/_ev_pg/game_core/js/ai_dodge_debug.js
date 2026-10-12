/**
 * 躲弹调试 + F8 全量计算可视化（Phaser 世界坐标）
 * H — 隐藏/显示面板 | 面板标题栏可拖动 | — 折叠为标签
 */
(function(global) {
    'use strict';

    var VIZ_KEY = 'tt_ai_viz';
    var PANEL_POS_KEY = 'tt_ai_viz_panel_pos';
    var PANEL_HIDDEN_KEY = 'tt_ai_viz_panel_hidden';

    var _vizOn = false;
    var _vizRoot = null;
    var _vizShell = null;
    var _vizHeader = null;
    var _vizBody = null;
    var _vizTab = null;
    var _panelHidden = false;
    var _vizRaf = 0;
    var _watchTimer = null;
    var _selectedAiId = null;
    var _phaserGfx = null;
    var _phaserGfxGroup = null;
    var _safetyGfx = null;  // 双圆专用 Graphics 对象（MAX blendMode）
    var _safetyGfxGroup = null;
    var _drag = null;

    function debugEnabled() {
        if (global._ttDodgeDebugEnabled || global._ttAiVizEnabled) return true;
        try {
            if (global.localStorage && global.localStorage.getItem('tt_dodge_debug') === '1') return true;
            if (global.localStorage && global.localStorage.getItem(VIZ_KEY) === '1') return true;
        } catch (e) {}
        try {
            if (global.location && global.location.search.indexOf('dodgeDebug=1') >= 0) return true;
        } catch (e2) {}
        return false;
    }

    function tactics() { return global.TankTroubleAITactics; }

    function worldPx(mx, my) {
        if (typeof UIUtils !== 'undefined' && UIUtils.mpx) {
            return { x: UIUtils.mpx(mx), y: UIUtils.mpx(my) };
        }
        var ppm = (typeof Constants !== 'undefined' && Constants.PIXELS_PER_METER)
            ? Constants.PIXELS_PER_METER : 20;
        return { x: mx * ppm, y: my * ppm };
    }

    function meterRadiusPx(r) {
        if (typeof UIUtils !== 'undefined' && UIUtils.mpx) return UIUtils.mpx(r);
        return r * ((typeof Constants !== 'undefined' && Constants.PIXELS_PER_METER)
            ? Constants.PIXELS_PER_METER : 20);
    }

    function vizSpriteScale(ctx) {
        if (ctx && ctx.state && ctx.state.tankSprites) {
            var sprites = ctx.state.tankSprites;
            var id, spr;
            for (id in sprites) {
                if (!sprites.hasOwnProperty(id)) continue;
                spr = sprites[id];
                if (!spr || spr.exists === false) continue;
                if (spr.scale && spr.scale.x > 0) return spr.scale.x;
                break;
            }
        }
        if (typeof UIConstants !== 'undefined' && UIConstants.GAME_ASSET_SCALE) {
            return UIConstants.GAME_ASSET_SCALE;
        }
        return 2;
    }

    function tankHalfExtentsPx(ctx) {
        var s = vizSpriteScale(ctx);
        if (typeof TankTroubleAITactics !== 'undefined' &&
            TankTroubleAITactics.getTankHullHalfExtentsPx) {
            return TankTroubleAITactics.getTankHullHalfExtentsPx(s);
        }
        var hw = 30 * s;
        var hf = 40 * s;
        var hb = 34 * s;
        if (typeof Constants !== 'undefined' && Constants.TANK) {
            hw = Constants.TANK.WIDTH.px * 0.5 * s;
            hf = Constants.TANK.HEIGHT.px * 0.5 * s;
            hb = hf;
        }
        return { hw: hw, halfForward: hf, halfBack: hb, hl: hf };
    }

    function drawHullOBB(g, cx, cy, rot, ext, color, lineAlpha, fillAlpha) {
        var hw = ext.hw;
        var hf = ext.halfForward !== undefined ? ext.halfForward : ext.hl;
        var hb = ext.halfBack !== undefined ? ext.halfBack : ext.hl;
        var fX = Math.sin(rot), fY = -Math.cos(rot);
        var rX = Math.cos(rot), rY = Math.sin(rot);
        var corners = [
            { x: cx + fX * hf + rX * hw, y: cy + fY * hf + rY * hw },
            { x: cx + fX * hf - rX * hw, y: cy + fY * hf - rY * hw },
            { x: cx - fX * hb - rX * hw, y: cy - fY * hb - rY * hw },
            { x: cx - fX * hb + rX * hw, y: cy - fY * hb + rY * hw }
        ];
        g.lineStyle(2, color, lineAlpha || 0.9);
        g.moveTo(corners[0].x, corners[0].y);
        g.lineTo(corners[1].x, corners[1].y);
        g.lineTo(corners[2].x, corners[2].y);
        g.lineTo(corners[3].x, corners[3].y);
        g.lineTo(corners[0].x, corners[0].y);
        if (fillAlpha) {
            g.beginFill(color, fillAlpha);
            g.moveTo(corners[0].x, corners[0].y);
            g.lineTo(corners[1].x, corners[1].y);
            g.lineTo(corners[2].x, corners[2].y);
            g.lineTo(corners[3].x, corners[3].y);
            g.endFill();
        }
    }

    function bulletRadiusPx() {
        var s = vizSpriteScale(getPhaserGameContext());
        if (typeof Constants !== 'undefined' && Constants.BULLET) {
            return Constants.BULLET.RADIUS.m * (Constants.PIXELS_PER_METER || 20) * s;
        }
        return 5 * s;
    }

    function getPhaserGameContext() {
        var game = typeof GameManager !== 'undefined' && GameManager.getGame
            ? GameManager.getGame() : null;
        if (!game || !game.state || game.state.current !== 'Game') return null;
        var state = game.state.getCurrentState();
        if (!state || !state.gameGroup) return null;
        return { game: game, state: state, group: state.gameGroup };
    }

    function detachPhaserGfx() {
        if (_phaserGfx) {
            try {
                if (_phaserGfx.parent) _phaserGfx.parent.remove(_phaserGfx);
            } catch (e1) {}
            try { _phaserGfx.destroy(); } catch (e2) {}
            _phaserGfx = null;
            _phaserGfxGroup = null;
        }
        if (_safetyGfx) {
            try {
                if (_safetyGfx.parent) _safetyGfx.parent.remove(_safetyGfx);
            } catch (e3) {}
            try { _safetyGfx.destroy(); } catch (e4) {}
            _safetyGfx = null;
            _safetyGfxGroup = null;
        }
    }

    function phaserGfxIsValid(ctx) {
        if (!_phaserGfx || !ctx || !ctx.group) return false;
        if (_phaserGfx.destroyed || _phaserGfx.exists === false) return false;
        if (_phaserGfxGroup !== ctx.group) return false;
        if (_phaserGfx.parent !== ctx.group) return false;
        try {
            if (ctx.group.children && ctx.group.children.indexOf(_phaserGfx) < 0) return false;
        } catch (e) {}
        return true;
    }

    /** 插在坦克/子弹组之前，保证双圆在实体下方、地板上方 */
    function placeSafetyBehindActors(ctx, displayObj) {
        var group = ctx.group;
        var state = ctx.state;
        var idx = group.children.length;
        var ti, pi, fi;
        if (state.tankGroup && state.tankGroup.parent === group) {
            ti = group.getChildIndex(state.tankGroup);
            if (ti >= 0 && ti < idx) idx = ti;
        }
        if (state.projectileGroup && state.projectileGroup.parent === group) {
            pi = group.getChildIndex(state.projectileGroup);
            if (pi >= 0 && pi < idx) idx = pi;
        }
        if (idx >= group.children.length) {
            if (state.mazeFloorGroup && state.mazeFloorGroup.parent === group) {
                fi = group.getChildIndex(state.mazeFloorGroup);
                if (fi >= 0) idx = fi + 1;
            }
        }
        if (displayObj.parent !== group) group.add(displayObj);
        group.setChildIndex(displayObj, idx);
    }

    /**
     * 直接用 Graphics 对象画双圆（抛弃 BitmapData sprite 方案）
     * 保证只有一份，不频闪，不错位
     * 使用两个填充圆，保持原色，低 alpha 减轻重叠加深
     */
    function drawLayerSafetyZones(zones) {
        var g = ensureSafetyGfx();
        if (!g || !zones || !zones.radii) return;
        g.clear();

        var bullets = zones.bullets;
        if (!bullets || !bullets.length) bullets = zones.circles;
        if (!bullets || !bullets.length) return;

        var radii = zones.radii;
        var diamYellow = meterRadiusPx(radii.semi) * 2;  // 黄圆直径（像素）
        var diamRed = meterRadiusPx(radii.abs) * 2;      // 红圆直径（像素）

        // 先画黄圆（外层，低 alpha 减轻重叠加深）
        g.beginFill(COL.dangerSemi, 0.3);
        for (var i = 0; i < bullets.length; i++) {
            var b = bullets[i];
            var pt = worldPx(b.x, b.y);
            g.drawCircle(pt.x, pt.y, diamYellow);
        }
        g.endFill();

        // 再画红圆（内层，低 alpha 减轻重叠加深）
        g.beginFill(COL.dangerAbsolute, 0.4);
        for (var i = 0; i < bullets.length; i++) {
            var b = bullets[i];
            var pt = worldPx(b.x, b.y);
            g.drawCircle(pt.x, pt.y, diamRed);
        }
        g.endFill();
    }

    function ensureSafetyGfx() {
        var ctx = getPhaserGameContext();
        if (!ctx) return null;
        if (_safetyGfx && _safetyGfxGroup === ctx.group && !_safetyGfx.destroyed) {
            return _safetyGfx;
        }
        if (_safetyGfx) {
            try { _safetyGfx.destroy(); } catch (e) {}
            _safetyGfx = null;
        }
        _safetyGfx = ctx.game.add.graphics(0, 0);
        _safetyGfx.name = 'ttAiSafetyZones';
        _safetyGfx.blendMode = PIXI.blendModes.NORMAL;  // 使用正常混合模式，保持原色
        ctx.group.add(_safetyGfx);
        _safetyGfxGroup = ctx.group;
        // 确保双圆在坦克和子弹层级下面
        placeSafetyBehindActors(ctx, _safetyGfx);
        return _safetyGfx;
    }

    function ensurePhaserGfx() {
        var ctx = getPhaserGameContext();
        if (!ctx) return null;
        if (phaserGfxIsValid(ctx)) {
            if (typeof _phaserGfx.bringToTop === 'function') _phaserGfx.bringToTop();
            return _phaserGfx;
        }
        detachPhaserGfx();
        _phaserGfx = ctx.game.add.graphics(0, 0);
        _phaserGfx.name = 'ttAiDodgeViz';
        ctx.group.add(_phaserGfx);
        if (typeof _phaserGfx.bringToTop === 'function') _phaserGfx.bringToTop();
        _phaserGfxGroup = ctx.group;
        return _phaserGfx;
    }

    function onRoundBoundary() {
        detachPhaserGfx();
        _selectedAiId = null;
        var t = tactics();
        if (t && t.clearAllVizSnapshots) t.clearAllVizSnapshots();
    }

    function isRoundLive(gc) {
        var t = tactics();
        if (t && t.isVizRoundActive) return t.isVizRoundActive(gc);
        return !!(gc && gc.roundController && gc.roundController.model &&
            gc.roundController.model.getStarted && gc.roundController.model.getStarted());
    }

    function ensureVizAIReady(gc) {
        if (!gc) return;
        if (listAIIds().length > 0) return;
        var patch = global.TankTroubleLocalPatch;
        if (patch && patch.reviveGameAI) patch.reviveGameAI();
        // 强制再次刷新一次（多帧后 tanks 可能才生成）
        if (!ensureVizAIReady._retryPending) {
            ensureVizAIReady._retryPending = true;
            var tryCount = 0;
            var iv = setInterval(function() {
                tryCount++;
                if (listAIIds().length > 0 || tryCount > 20) {
                    clearInterval(iv);
                    ensureVizAIReady._retryPending = false;
                } else {
                    if (patch && patch.reviveGameAI) patch.reviveGameAI();
                }
            }, 200);
        }
    }

    function syncVizOnRoundEvent(gc) {
        ensureVizAIReady(gc);
        detachPhaserGfx();
        _lastRoundKey = null;
        var t = tactics();
        if (t && t.clearAllVizSnapshots) t.clearAllVizSnapshots();
    }

    function resolveSelectedAiId() {
        var ids = listAIIds();
        if (!ids.length) return null;
        if (_selectedAiId && ids.indexOf(_selectedAiId) >= 0) return _selectedAiId;
        _selectedAiId = ids[0];
        return _selectedAiId;
    }

    function hookRoundEventsForViz() {
        if (hookRoundEventsForViz._done) return;
        if (typeof Game === 'undefined' || !Game.UIGameState) return;
        var proto = Game.UIGameState.prototype;
        if (!proto || !proto._roundEventHandler || proto._ttVizRoundPatched) return;

        var origRound = proto._roundEventHandler;
        proto._roundEventHandler = function(self, id, evt, data) {
            origRound.call(this, self, id, evt, data);
            if (!_vizOn || typeof RoundModel === 'undefined') return;
            var gc = self && self.gameController;
            if (evt === RoundModel._EVENTS.ROUND_CREATED) {
                // 强制重置 UI 的 roundEnded 标志，确保 isVizRoundActive 在新回合开始时返回 true
                if (self) self.roundEnded = false;
                var t = tactics();
                if (t && t.bumpVizRoundSeq) t.bumpVizRoundSeq();
                syncVizOnRoundEvent(gc);
            } else if (evt === RoundModel._EVENTS.ROUND_STARTED) {
                if (self) self.roundEnded = false;
                syncVizOnRoundEvent(gc);
            } else if (evt === RoundModel._EVENTS.ROUND_ENDED ||
                evt === RoundModel._EVENTS.CELEBRATION_STARTED) {
                detachPhaserGfx();
                _lastRoundKey = null;
                _roundWasLive = false;
            }
        };
        proto._ttVizRoundPatched = true;
        hookRoundEventsForViz._done = true;
    }

    function drawOBB(g, cx, cy, rot, hw, hl, color, lineAlpha, fillAlpha) {
        var fX = Math.sin(rot), fY = -Math.cos(rot);
        var rX = Math.cos(rot), rY = Math.sin(rot);
        var corners = [
            { x: cx + fX * hl + rX * hw, y: cy + fY * hl + rY * hw },
            { x: cx + fX * hl - rX * hw, y: cy + fY * hl - rY * hw },
            { x: cx - fX * hl - rX * hw, y: cy - fY * hl - rY * hw },
            { x: cx - fX * hl + rX * hw, y: cy - fY * hl + rY * hw }
        ];
        g.lineStyle(2, color, lineAlpha || 0.9);
        g.moveTo(corners[0].x, corners[0].y);
        g.lineTo(corners[1].x, corners[1].y);
        g.lineTo(corners[2].x, corners[2].y);
        g.lineTo(corners[3].x, corners[3].y);
        g.lineTo(corners[0].x, corners[0].y);
        if (fillAlpha) {
            g.beginFill(color, fillAlpha);
            g.moveTo(corners[0].x, corners[0].y);
            g.lineTo(corners[1].x, corners[1].y);
            g.lineTo(corners[2].x, corners[2].y);
            g.lineTo(corners[3].x, corners[3].y);
            g.endFill();
        }
    }

    function stopVizLoop() {
        if (_vizRaf) {
            try { global.cancelAnimationFrame(_vizRaf); } catch (e1) {}
            try { global.clearTimeout(_vizRaf); } catch (e2) {}
            _vizRaf = 0;
        }
    }

    var _vizPanelTick = 0;

    /** requestAnimationFrame 驱动画面；不依赖 UIGameState.render（本游戏几乎不调）。 */
    function vizLoop() {
        if (!_vizOn) {
            stopVizLoop();
            return;
        }
        try { refreshVizFrame(); } catch (e) {
            console.error('[TT_VIZ] refreshVizFrame err:', e);
        }
        _vizPanelTick++;
        if (_vizPanelTick >= 12) {
            _vizPanelTick = 0;
            try { refreshVizPanel(); } catch (e2) {
                console.error('[TT_VIZ] refreshVizPanel err:', e2);
            }
        }
        _vizRaf = global.requestAnimationFrame(vizLoop);
    }

    function startVizLoop() {
        stopVizLoop();
        _vizPanelTick = 0;
        _vizRaf = global.requestAnimationFrame(vizLoop);
    }

    var _lastRoundKey = null;
    var _roundWasLive = false;
    var _lastVizSnap = null;

    /** 颜色规范 — 见面板图例 */
    var COL = {
        bulletPath: 0x9e9e9e,
        bulletPos: 0xbdbdbd,
        dodgePick: 0x00e676,
        dodgeCand: 0x4fc3f7,
        huntPath: 0x26c6da,
        huntTarget: 0x00acc1,
        shootPath: 0xff9800,
        shootAim: 0xff5722,
        movePreview: 0xab47bc,
        turnAim: 0xffeb3b,
        tankPlan: 0x42a5f5,
        tankLive: 0xffffff,
        enemy: 0xec407a,
        closestHit: 0xff6f00,
        safeField: 0x88ff88,
        dangerAbsolute: 0xcc2222,
        dangerSemi: 0xffcc00
    };

    function drawDashedPolylineMeters(g, samples, color, width, alpha, dash, gap) {
        if (!samples || samples.length < 2) return;
        dash = dash || 8;
        gap = gap || 6;
        var i, p0, p1, dx, dy, len, ux, uy, pos, drawOn, seg;
        for (i = 1; i < samples.length; i++) {
            p0 = worldPx(samples[i - 1].x, samples[i - 1].y);
            p1 = worldPx(samples[i].x, samples[i].y);
            dx = p1.x - p0.x;
            dy = p1.y - p0.y;
            len = Math.sqrt(dx * dx + dy * dy);
            if (len < 0.5) continue;
            ux = dx / len;
            uy = dy / len;
            pos = 0;
            drawOn = true;
            g.lineStyle(width || 1, color, alpha || 0.85);
            while (pos < len) {
                seg = Math.min(drawOn ? dash : gap, len - pos);
                if (drawOn) {
                    g.moveTo(p0.x + ux * pos, p0.y + uy * pos);
                    g.lineTo(p0.x + ux * (pos + seg), p0.y + uy * (pos + seg));
                }
                pos += seg;
                drawOn = !drawOn;
            }
        }
    }

    function drawSolidPolylineMeters(g, samples, color, width, alpha) {
        if (!samples || samples.length < 2) return;
        var i, p0, p1;
        g.lineStyle(width || 2, color, alpha || 0.9);
        p0 = worldPx(samples[0].x, samples[0].y);
        g.moveTo(p0.x, p0.y);
        for (i = 1; i < samples.length; i++) {
            p1 = worldPx(samples[i].x, samples[i].y);
            g.lineTo(p1.x, p1.y);
        }
    }

    function drawLineMeters(g, x0, y0, x1, y1, color, width, alpha, dashed) {
        if (dashed) {
            drawDashedPolylineMeters(g,
                [{ x: x0, y: y0 }, { x: x1, y: y1 }], color, width, alpha);
        } else {
            var a = worldPx(x0, y0);
            var b = worldPx(x1, y1);
            g.lineStyle(width || 2, color, alpha || 0.9);
            g.moveTo(a.x, a.y);
            g.lineTo(b.x, b.y);
        }
    }

    function drawSquareMeters(g, mx, my, halfPx, color, fillAlpha) {
        var pt = worldPx(mx, my);
        if (fillAlpha) {
            g.beginFill(color, fillAlpha);
            g.drawRect(pt.x - halfPx, pt.y - halfPx, halfPx * 2, halfPx * 2);
            g.endFill();
        }
        g.lineStyle(2, color, 0.95);
        g.drawRect(pt.x - halfPx, pt.y - halfPx, halfPx * 2, halfPx * 2);
    }

    function drawCrossMeters(g, mx, my, size, color) {
        var pt = worldPx(mx, my);
        g.lineStyle(2, color, 0.95);
        g.moveTo(pt.x - size, pt.y);
        g.lineTo(pt.x + size, pt.y);
        g.moveTo(pt.x, pt.y - size);
        g.lineTo(pt.x, pt.y + size);
    }

    function drawFilledCircleDiameterPx(g, mx, my, diameterPx, color, alpha) {
        if (!diameterPx || diameterPx <= 0) return;
        var pt = worldPx(mx, my);
        if (diameterPx < 1) return;
        g.beginFill(color, alpha);
        g.drawCircle(pt.x, pt.y, diameterPx);
        g.endFill();
    }

    function drawFilledCircleMeters(g, mx, my, radiusM, color, alpha) {
        if (!radiusM || radiusM <= 0) return;
        drawFilledCircleDiameterPx(g, mx, my, meterRadiusPx(radiusM) * 2, color, alpha);
    }

    function drawLayerBullets(g, bullets) {
        if (!bullets || !bullets.length) return;
        var i, b, br, pt;
        br = bulletRadiusPx();
        for (i = 0; i < bullets.length; i++) {
            b = bullets[i];
            if (b.path && b.path.length >= 2) {
                drawDashedPolylineMeters(g, b.path, COL.bulletPath, 1.5, 0.75);
            }
            if (b.currentPos) {
                pt = worldPx(b.currentPos.x, b.currentPos.y);
                g.beginFill(COL.bulletPos, 0.85);
                g.drawCircle(pt.x, pt.y, br * 2);
                g.endFill();
            }
            if (b.closestPosition) {
                drawCrossMeters(g, b.closestPosition.x, b.closestPosition.y, 5, COL.closestHit);
            }
        }
    }

    function drawLayerDodge(g, dodge) {
        if (!dodge) return;
        var i, c;
        if (dodge.candidateTrajectories) {
            for (i = 0; i < dodge.candidateTrajectories.length; i++) {
                c = dodge.candidateTrajectories[i];
                if (!c.trajectory || c.isPick) continue;
                drawSolidPolylineMeters(g, c.trajectory, COL.dodgeCand, 1, 0.35);
            }
        }
        if (dodge.pick && dodge.pick.trajectory && dodge.pick.trajectory.length > 1) {
            drawSolidPolylineMeters(g, dodge.pick.trajectory, COL.dodgePick, 4, 0.95);
        }
        if (dodge.planTargets) {
            for (i = 0; i < dodge.planTargets.length; i++) {
                drawCrossMeters(g, dodge.planTargets[i].x, dodge.planTargets[i].y, 4, COL.dodgeCand);
            }
        }
    }

    function drawLayerHunt(g, hunt, tank) {
        if (!hunt) return;
        if (hunt.waypoints && hunt.waypoints.length >= 2) {
            drawSolidPolylineMeters(g, hunt.waypoints, COL.huntPath, 3, 0.85);
        } else if (hunt.tileCenter && tank) {
            drawLineMeters(g, tank.x, tank.y, hunt.tileCenter.x, hunt.tileCenter.y,
                COL.huntPath, 2, 0.6, true);
        }
        if (hunt.tileCenter) {
            drawSquareMeters(g, hunt.tileCenter.x, hunt.tileCenter.y, 7, COL.huntTarget, 0.25);
        }
    }

    function drawLayerShoot(g, shoot, tank) {
        if (!shoot) return;
        var committed = shoot.planSource === 'committed';
        var alpha = shoot.executing ? 0.95 : (shoot.blockedBy ? 0.38 : (committed ? 0.88 : 0.55));
        var pathAlpha = shoot.executing ? 0.9 : (shoot.blockedBy ? 0.32 : (committed ? 0.82 : 0.45));
        if (shoot.path && shoot.path.length >= 2) {
            drawDashedPolylineMeters(g, shoot.path, COL.shootPath, committed ? 2.8 : 2.2, pathAlpha);
        }
        if (shoot.aimLine) {
            drawLineMeters(g, shoot.aimLine.x0, shoot.aimLine.y0,
                shoot.aimLine.x1, shoot.aimLine.y1, COL.shootAim, 3, alpha, false);
        }
        if (shoot.targetId && tank) {
            var gc = typeof GameManager !== 'undefined' && GameManager.getGameController
                ? GameManager.getGameController() : null;
            if (gc) {
                var tgt = gc.getTank(shoot.targetId);
                if (tgt && tgt.getX) {
                    drawSquareMeters(g, tgt.getX(), tgt.getY(), 8, COL.enemy, 0.2);
                }
            }
        }
    }

    function drawLayerMove(g, move, tank) {
        if (!move || !tank) return;
        if (move.trajectory && move.trajectory.length >= 2) {
            drawSolidPolylineMeters(g, move.trajectory, COL.movePreview, 3, 0.8);
        }
        if (move.kind === 'turn' && move.direction) {
            var dlen = Math.sqrt(move.direction.x * move.direction.x +
                move.direction.y * move.direction.y) || 1;
            drawLineMeters(g, tank.x, tank.y,
                tank.x + move.direction.x / dlen * 6,
                tank.y + move.direction.y / dlen * 6,
                COL.turnAim, 2, 0.9, false);
        }
        if (move.target) {
            drawSquareMeters(g, move.target.x, move.target.y, 6, COL.movePreview, 0.3);
        }
    }

    function drawPhaserViz(snap) {
        var g = ensurePhaserGfx();
        if (!g) return;
        g.clear();

        if (!snap || !snap.tank) return;

        var ext = tankHalfExtentsPx(getPhaserGameContext());
        var layers = snap.layers || {};
        var tank = snap.tank;

        // 先画双圆（在子弹下面，使用独立的 Graphics 对象 + SCREEN blendMode）
        drawLayerSafetyZones(layers.safetyZones);

        drawLayerBullets(g, layers.bullets);
        drawLayerDodge(g, layers.dodge);
        drawLayerHunt(g, layers.hunt, tank);
        drawLayerShoot(g, layers.shoot, tank);
        drawLayerMove(g, layers.move, tank);

        var tankPt = worldPx(tank.x, tank.y);
        drawHullOBB(g, tankPt.x, tankPt.y, tank.rot || 0, ext, COL.tankPlan, 0.9, 0.08);
        drawHullOBB(g, tankPt.x, tankPt.y, tank.rot || 0, ext, COL.tankLive, 0.55, 0);
    }

    function getCurrentRoundKey() {
        var gc = typeof GameManager !== 'undefined' && GameManager.getGameController
            ? GameManager.getGameController() : null;
        var t = tactics();
        if (t && t.getVizRoundKey) return t.getVizRoundKey(gc);
        return gc && gc.getId ? gc.getId() : '';
    }

    function verify() {
        var t = tactics();
        if (!t || !t.verify) return { ok: false, issues: ['未加载'] };
        var report = t.verify();
        console.log(report.ok ? '[躲弹自检] 通过' : '[躲弹自检] 失败', report);
        return report;
    }

    function runScenario(name, options) {
        var t = tactics();
        return t && t.runFixedScenario ? t.runFixedScenario(name, options) : null;
    }

    function runAll() {
        var t = tactics();
        return t && t.runAllFixedScenarios ? t.runAllFixedScenarios() : null;
    }

    function listAIIds() {
        var ids = [];
        var gc = typeof GameManager !== 'undefined' && GameManager.getGameController
            ? GameManager.getGameController() : null;
        var gameId = gc && gc.getId ? gc.getId() : null;
        if (typeof AIs !== 'undefined' && AIs.aiManagers) {
            var i, mgr;
            for (i = 0; i < AIs.aiManagers.length; i++) {
                mgr = AIs.aiManagers[i];
                if (!mgr || !mgr.getAIId) continue;
                if (gameId && mgr.getGameId && mgr.getGameId() !== gameId) continue;
                ids.push(mgr.getAIId());
            }
        }
        return ids;
    }

    function getSnapshot(aiId) {
        var t = tactics();
        if (t && t.buildLiveVizSnapshot) {
            return t.buildLiveVizSnapshot(aiId || _selectedAiId);
        }
        return null;
    }

    function status() {
        var ids = listAIIds();
        if (!_selectedAiId && ids.length) _selectedAiId = ids[0];
        var out = {
            verify: tactics() && tactics().verify ? tactics().verify() : null,
            vizOn: _vizOn,
            panelHidden: _panelHidden,
            selectedAi: _selectedAiId,
            snapshot: getSnapshot(_selectedAiId)
        };
        console.log('[TT_DODGE_DEBUG] status', out);
        return out;
    }

    function injectTest(aiId, options) {
        var t = tactics();
        if (!t || !t.injectSyntheticThreat) return null;
        var ai = t.findLiveAI(aiId || _selectedAiId);
        if (!ai) { console.error('找不到 AI'); return null; }
        options = options || {};
        if (options.scenario) {
            var presets = { lateral_pass: { missY: 2.0 }, head_on: { missY: 0 }, obb_graze: { missY: 1.55 } };
            var p = presets[options.scenario];
            if (p) { var k; for (k in p) if (p.hasOwnProperty(k)) options[k] = p[k]; }
        }
        var result = t.injectSyntheticThreat(ai, options);
        _selectedAiId = ai.aiId;
        if (_vizOn) refreshViz();
        return result;
    }

    function formatInputKeys(inp) {
        if (!inp) return '—';
        var p = [];
        if (inp.forward) p.push('W');
        if (inp.back) p.push('S');
        if (inp.left) p.push('A');
        if (inp.right) p.push('D');
        if (inp.fire) p.push('F');
        return p.length ? p.join('+') : '—';
    }

    function formatActionLine(a, idx) {
        if (!a) return '';
        var s = (idx + 1) + '. ' + (a.type || '?');
        if (a.type === 'tactics drive input' || (a.forward !== undefined)) {
            s += ' [' + formatInputKeys(a) + ']';
        }
        if (a.duration) s += ' ' + Math.round(a.duration) + 'ms';
        if (a.delay) s += ' delay' + Math.round(a.delay) + 'ms';
        if (a.position) s += ' →(' + a.position.x.toFixed(1) + ',' + a.position.y.toFixed(1) + ')';
        return s;
    }

    function formatSnapshotHtml(snap) {
        if (!snap || !snap.tank) {
            return '<div style="color:#888">等待本回合坦克生成…</div>';
        }
        var v = tactics() && tactics().verify ? tactics().verify() : {};
        var h = [];
        var meta = snap.liveMeta || {};
        var goal = snap.goal || {};
        var cog = snap.cognition || {};

        h.push('<div style="color:#8f8;font-weight:bold">AI 决策面板 v' + (v.version || '?') + '</div>');
        h.push('<div style="color:#9cf;font-size:10px;margin:4px 0">' +
            '目标 <b style="color:#fff">' + (goal.type || '—') + '</b>' +
            (goal.priority !== undefined ? ' prio=' + goal.priority.toFixed(2) : '') +
            (goal.period ? ' period=' + goal.period : '') +
            '</div>');

        if (meta.threatCount !== undefined) {
            h.push('<div style="font-size:10px;color:#aaa">威胁弹 ' + meta.threatCount +
                ' | 紧急 ' + (meta.hasUrgentThreat ? '是' : '否') +
                ' | 躲弹执行 ' + (meta.dodgeExecCount || 0) +
                ' | 按键应用 ' + (meta.dodgeApplyCount || 0) + '</div>');
        }

        if (meta.dodgeGoalActive) {
            h.push('<div style="font-size:10px;color:#69f0ae;margin-top:3px">躲弹目标 <b>激活</b>' +
                (meta.dodgeCombo ? ' 按键=' + meta.dodgeCombo : '') +
                (meta.dodgeExecuted ? ' ✓已规划' : ' ✗未规划') + '</div>');
        } else if (meta.hasUrgentThreat) {
            h.push('<div style="font-size:10px;color:#fa0;margin-top:3px">有紧急威胁但未切躲弹目标（检查 protected/阈值）</div>');
        }

        var sz = snap.layers && snap.layers.safetyZones;
        if (sz) {
            var clsLabel = { safe: '真安全', semi: '半危险', absolute: '绝对危险' };
            var line = '双圆 v' + (v.version || '?') + ' | 弹 ' + (sz.bulletCount || 0);
            if (sz.radii) {
                line += ' 红直径=车宽' + (sz.radii.abs * 2).toFixed(2) + 'm' +
                    ' 黄直径=对角' + (sz.radii.semi * 2).toFixed(2) + 'm';
            }
            line += ' | 脚下 <b style="color:#fff">' +
                (clsLabel[sz.tankClass] || sz.tankClass) + '</b>';
            if (sz.tankEnvelope) {
                line += ' margin∈[' + sz.tankEnvelope.min.toFixed(2) + ',' +
                    sz.tankEnvelope.max.toFixed(2) + ']';
            }
            h.push('<div style="font-size:10px;color:#bbb;margin-top:4px">' + line + '</div>');
        }

        if (snap.input) {
            h.push('<div style="font-size:10px;margin:3px 0">当前输入 <span style="color:#ce93d8">' +
                formatInputKeys(snap.input) + '</span></div>');
        }

        if (snap.actions && snap.actions.length) {
            h.push('<div style="font-size:10px;color:#888;margin-top:4px">动作队列</div>');
            var ai;
            for (ai = 0; ai < snap.actions.length; ai++) {
                h.push('<div style="font-size:10px;color:#ddd;padding-left:6px">' +
                    formatActionLine(snap.actions[ai], ai) + '</div>');
            }
        }

        if (cog.shootPlan) {
            var shootBlockLabels = {
                no_plan: '无计划',
                low_quality: '质量不足',
                post_shot_reposition: '射后走位',
                shotCooldown: '射击冷却',
                sameAngleCooldown: '同角度0.3s',
                no_ricochet: '无角弹方案',
                need_stance: '需站位',
                dodge_goal: '躲弹目标',
                incoming_dodge: '来袭子弹',
                dodge_urgency: '躲弹紧迫',
                aggressiveness: '攻击性低',
                not_allowed: '未允许',
                goal_HUNT: '追击抢占',
                goal_IDLE: '闲逛抢占',
                goal_none: '无目标',
                dodge_action: '躲弹动作',
                hunt_action: '追击动作'
            };
            var planSourceLabel = { committed: '已锁定', preview: '预览', none: '—' };
            h.push('<div style="font-size:10px;margin-top:4px;color:#ffb74d">射击计划: ' +
                (cog.shootPlan.worthShooting ? '值得' : '不值得') +
                (cog.shootPlan.allowed ? ' ✓允许' : ' ✗阻止') +
                (cog.shootPlan.quality !== undefined ? ' Q=' + cog.shootPlan.quality.toFixed(2) : '') +
                '</div>');
            if (snap.layers && snap.layers.shoot) {
                h.push('<div style="font-size:10px;color:#ffcc80">弹道线 ' +
                    (planSourceLabel[snap.layers.shoot.planSource] || snap.layers.shoot.planSource) +
                    (snap.layers.shoot.recentShots !== undefined
                        ? ' | 近期 ' + snap.layers.shoot.recentShots + ' 发' : '') +
                    '</div>');
            }
            if (snap.shootConflict) {
                var sc = snap.shootConflict;
                var blockLabel = sc.blockedBy
                    ? (shootBlockLabels[sc.blockedBy] || sc.blockedBy) : null;
                h.push('<div style="font-size:10px;color:' +
                    (sc.canExecute ? '#81c784' : '#ef9a9a') + '">射击执行: ' +
                    (sc.executing ? ('进行中' + (sc.phase === 'firing' ? '·开火' : '·瞄准')) :
                        (sc.canExecute ? '可执行' : ('被阻·' + (blockLabel || '—')))) +
                    '</div>');
            }
        }
        if (cog.positionPlan && cog.positionPlan.bestTile) {
            h.push('<div style="font-size:10px;color:#4dd0e1">走位格 (' +
                cog.positionPlan.bestTile.x + ',' + cog.positionPlan.bestTile.y + ')' +
                ' 安全=' + (cog.positionPlan.safety || 0).toFixed(2) +
                (cog.positionPlan.shotStance ? ' 射击站位' : '') + '</div>');
        }
        if (cog.shotStancePlan) {
            var sp = cog.shotStancePlan;
            h.push('<div style="font-size:10px;color:#80deea">射击站位: ' +
                (sp.readyAtCurrent ? '就位✓' : (sp.needsReposition ? '需移动' : '无方案')) +
                (sp.moveTile ? ' →(' + sp.moveTile.x + ',' + sp.moveTile.y + ')' : '') +
                (sp.bestStance && sp.bestStance.quality !== undefined
                    ? ' Q=' + sp.bestStance.quality.toFixed(2) : '') +
                '</div>');
        }
        if (cog.dodgeUrgency !== undefined) {
            h.push('<div style="font-size:10px;color:#81c784">躲弹紧迫度 ' +
                cog.dodgeUrgency.toFixed(2) + '</div>');
        }

        if (snap.layers && snap.layers.dodge && snap.layers.dodge.pick) {
            var pk = snap.layers.dodge.pick;
            h.push('<div style="font-size:10px;margin-top:4px;color:#69f0ae">躲弹选中 <b>' +
                pk.label + '</b> minM=' + pk.minMargin.toFixed(2) +
                (pk.survives ? ' ✓' : '') + '</div>');
        }

        h.push('<div style="color:#777;font-size:9px;line-height:1.55;margin-top:8px;border-top:1px solid #333;padding-top:6px">' +
            '<div><span style="color:#ffcc00">■黄</span> 半对角圆盘（直径=车体包络最大对角线） &nbsp; <span style="color:#cc2222">■红</span> 半宽圆盘（直径=车宽）</div>' +
            '<div><span style="color:#9e9e9e">┅灰虚线</span> 敌方子弹预测（从当前弹位裁剪）</div>' +
            '<div><span style="color:#00e676">━绿粗线</span> 躲弹<strong>实际执行</strong>轨迹（与紫线应重合） &nbsp; <span style="color:#4fc3f7">━浅蓝细线</span> 其他躲弹候选</div>' +
            '<div><span style="color:#26c6da">━青线</span> 追击/走位路径 &nbsp; <span style="color:#00acc1">■青块</span> 目标格</div>' +
            '<div><span style="color:#ff9800">┅橙虚线</span> 我方射击弹道 &nbsp; <span style="color:#ff5722">━橙红线</span> 瞄准方向</div>' +
            '<div><span style="color:#ab47bc">━紫线</span> 当前动作预计轨迹（躲弹时应=绿线；追击时为走位）</div>' +
            '<div><span style="color:#ffeb3b">━黄线</span> 转向 &nbsp; <span style="color:#42a5f5">蓝框</span> 规划车体 &nbsp; <span style="color:#fff">白框</span> 实际坦克</div></div>');
        h.push('<div style="margin-top:6px;color:#666;font-size:10px">F8关 H隐面板 I测试 [ ]切AI</div>');
        return h.join('');
    }

    function refreshVizFrame() {
        if (!_vizOn) return;

        var gc = typeof GameManager !== 'undefined' && GameManager.getGameController
            ? GameManager.getGameController() : null;
        var isLive = isRoundLive(gc);
        var roundKey = getCurrentRoundKey();
        var boundary = (_lastRoundKey !== null && roundKey !== _lastRoundKey) ||
            (_roundWasLive && !isLive);

        if (boundary) onRoundBoundary();
        _lastRoundKey = roundKey;
        _roundWasLive = isLive;

        if (!isLive) {
            if (_vizBody && !_panelHidden) {
                _vizBody.innerHTML = '<div style="color:#888">回合间隙 — 等待下一局开始</div>';
            }
            detachPhaserGfx();
            return;
        }

        ensureVizAIReady(gc);

        if (!getPhaserGameContext()) {
            if (_vizBody && !_panelHidden) {
                _vizBody.innerHTML = '<div style="color:#888">对局进行中 — 等待画面就绪…</div>';
            }
            return;
        }

        resolveSelectedAiId();
        var snap = getSnapshot(_selectedAiId);
        _lastVizSnap = snap;
        if (snap && snap.tank) {
            drawPhaserViz(snap);
        } else {
            var g2 = ensurePhaserGfx();
            if (g2) g2.clear();
        }
        return snap;
    }

    function refreshVizPanel() {
        if (!_vizOn || !_vizBody || _panelHidden) return;
        if (!listAIIds().length) {
            _vizBody.innerHTML = '<div style="color:#fa0">对局进行中 — 未识别到 AI，正在同步…</div>';
        } else if (_lastVizSnap) {
            _vizBody.innerHTML = formatSnapshotHtml(_lastVizSnap);
        }
    }

    function refreshViz() {
        if (!_vizOn) return;
        refreshVizFrame();
        refreshVizPanel();
    }

    function loadPanelPos() {
        try {
            var raw = global.localStorage.getItem(PANEL_POS_KEY);
            if (raw) return JSON.parse(raw);
        } catch (e) {}
        return { left: null, top: 8 };
    }

    function savePanelPos() {
        if (!_vizShell) return;
        try {
            global.localStorage.setItem(PANEL_POS_KEY, JSON.stringify({
                left: parseInt(_vizShell.style.left, 10) || 0,
                top: parseInt(_vizShell.style.top, 10) || 0
            }));
        } catch (e) {}
    }

    function setupPanelDrag() {
        if (!_vizHeader || !_vizShell) return;
        _vizHeader.addEventListener('mousedown', function(e) {
            if (e.target.tagName === 'BUTTON') return;
            e.preventDefault();
            var rect = _vizShell.getBoundingClientRect();
            var parent = _vizShell.offsetParent || document.body;
            var pr = parent.getBoundingClientRect();
            _drag = {
                startX: e.clientX,
                startY: e.clientY,
                origL: rect.left - pr.left,
                origT: rect.top - pr.top
            };
        });
        global.addEventListener('mousemove', function(e) {
            if (!_drag || !_vizShell) return;
            var parent = _vizShell.offsetParent || document.body;
            var pr = parent.getBoundingClientRect();
            var nl = _drag.origL + (e.clientX - _drag.startX);
            var nt = _drag.origT + (e.clientY - _drag.startY);
            _vizShell.style.left = Math.max(0, nl) + 'px';
            _vizShell.style.top = Math.max(0, nt) + 'px';
            _vizShell.style.right = 'auto';
        });
        global.addEventListener('mouseup', function() {
            if (_drag) { _drag = null; savePanelPos(); }
        });
    }

    function setPanelHidden(hidden) {
        _panelHidden = !!hidden;
        try {
            if (_panelHidden) global.localStorage.setItem(PANEL_HIDDEN_KEY, '1');
            else global.localStorage.removeItem(PANEL_HIDDEN_KEY);
        } catch (e) {}
        if (_vizShell) _vizShell.style.display = _panelHidden ? 'none' : 'block';
        if (_vizTab) _vizTab.style.display = _panelHidden ? 'block' : 'none';
    }

    function togglePanelHidden() {
        setPanelHidden(!_panelHidden);
    }

    function ensureVizDom() {
        if (_vizRoot) return;
        var gameEl = document.getElementById('game');
        if (!gameEl) return;

        var pos = loadPanelPos();
        try {
            if (global.localStorage.getItem(PANEL_HIDDEN_KEY) === '1') _panelHidden = true;
        } catch (e2) {}

        _vizRoot = document.createElement('div');
        _vizRoot.id = 'tt-ai-viz-root';
        _vizRoot.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:99990;font:12px/1.4 Consolas,monospace';

        _vizShell = document.createElement('div');
        _vizShell.style.cssText = [
            'position:absolute',
            pos.left !== null ? ('left:' + pos.left + 'px') : 'right:8px',
            'top:' + (pos.top || 8) + 'px',
            'width:320px', 'max-height:70%', 'pointer-events:auto',
            'background:rgba(0,0,0,0.88)', 'color:#eee',
            'border:1px solid #4a8', 'border-radius:8px',
            'box-shadow:0 6px 24px rgba(0,0,0,0.55)', 'overflow:hidden'
        ].join(';');

        _vizHeader = document.createElement('div');
        _vizHeader.style.cssText = [
            'cursor:move', 'padding:8px 10px', 'background:rgba(40,80,60,0.5)',
            'border-bottom:1px solid #4a8', 'display:flex', 'justify-content:space-between',
            'align-items:center', 'user-select:none', 'font-weight:bold'
        ].join(';');
        _vizHeader.innerHTML = '<span>AI 计算可视化</span><span>' +
            '<button type="button" id="tt-viz-fold" style="margin-right:4px;cursor:pointer;background:#333;color:#eee;border:1px solid #666;border-radius:3px;padding:2px 8px">—</button>' +
            '<button type="button" id="tt-viz-close" style="cursor:pointer;background:#522;color:#fcc;border:1px solid #844;border-radius:3px;padding:2px 8px">×</button>' +
            '</span>';

        _vizBody = document.createElement('div');
        _vizBody.style.cssText = 'padding:10px;overflow:auto;max-height:55vh';

        _vizShell.appendChild(_vizHeader);
        _vizShell.appendChild(_vizBody);

        _vizTab = document.createElement('div');
        _vizTab.id = 'tt-ai-viz-tab';
        _vizTab.textContent = 'AI ▸';
        _vizTab.style.cssText = [
            'position:absolute', 'right:0', 'top:40%', 'pointer-events:auto',
            'background:rgba(0,0,0,0.8)', 'color:#8f8', 'padding:10px 6px',
            'border:1px solid #4a8', 'border-right:none', 'border-radius:6px 0 0 6px',
            'cursor:pointer', 'writing-mode:vertical-rl', 'font-weight:bold'
        ].join(';');
        _vizTab.addEventListener('click', function() { setPanelHidden(false); });

        _vizRoot.appendChild(_vizShell);
        _vizRoot.appendChild(_vizTab);

        if (getComputedStyle(gameEl).position === 'static') gameEl.style.position = 'relative';
        gameEl.appendChild(_vizRoot);

        setupPanelDrag();
        document.getElementById('tt-viz-fold').addEventListener('click', function(e) {
            e.stopPropagation();
            togglePanelHidden();
        });
        document.getElementById('tt-viz-close').addEventListener('click', function(e) {
            e.stopPropagation();
            toggleViz(false);
        });

        setPanelHidden(_panelHidden);
    }

    function toggleViz(force) {
        _vizOn = force !== undefined ? !!force : !_vizOn;
        global._ttAiVizEnabled = _vizOn;
        global._ttDodgeDebugEnabled = _vizOn || debugEnabled();
        try {
            if (_vizOn) global.localStorage.setItem(VIZ_KEY, '1');
            else global.localStorage.removeItem(VIZ_KEY);
        } catch (e) {}

        if (_vizOn) {
            hookRoundEventsForViz();
            ensureVizDom();
            _lastRoundKey = null;
            _roundWasLive = false;
            detachPhaserGfx();
            resolveSelectedAiId();
            refreshViz();
            startVizLoop();
            console.log('%c[AI可视化] 已开启 — requestAnimationFrame 每帧刷新', 'color:#4f8;font-weight:bold');
            verify();
        } else {
            stopVizLoop();
            _lastRoundKey = null;
            _roundWasLive = false;
            detachPhaserGfx();
            var t = tactics();
            if (t && t.clearAllVizSnapshots) t.clearAllVizSnapshots();
            if (_vizRoot && _vizRoot.parentNode) _vizRoot.parentNode.removeChild(_vizRoot);
            _vizRoot = _vizShell = _vizHeader = _vizBody = _vizTab = null;
        }
        return _vizOn;
    }

    function cycleAI(dir) {
        var ids = listAIIds();
        if (!ids.length) return;
        var idx = ids.indexOf(_selectedAiId);
        if (idx < 0) idx = 0;
        idx = (idx + (dir || 1) + ids.length) % ids.length;
        _selectedAiId = ids[idx];
        refreshViz();
    }

    function onKeyDown(e) {
        if (e.key === 'F8') { e.preventDefault(); toggleViz(); return; }
        if (!_vizOn) return;
        if (e.key === 'h' || e.key === 'H') { e.preventDefault(); togglePanelHidden(); return; }
        if (e.key === 'i' || e.key === 'I') { e.preventDefault(); injectTest(_selectedAiId, { scenario: 'head_on' }); return; }
        if (e.key === '[') { e.preventDefault(); cycleAI(-1); return; }
        if (e.key === ']') { e.preventDefault(); cycleAI(1); return; }
    }

    function enable() {
        try { global.localStorage.setItem('tt_dodge_debug', '1'); } catch (e) {}
        toggleViz(true);
    }

    function disable() { toggleViz(false); }

    function help() {
        console.log([
            'F8 开关 | H 隐藏面板 | I 注入测试弹 | [ ] 切换 AI',
            '灰虚线=敌方子弹预测  绿粗线=躲弹选中  青线=走位/追击',
            '橙虚线=我方射击弹道  紫线=当前动作轨迹  面板显示目标/动作/认知'
        ].join('\n'));
    }

    global.addEventListener('keydown', onKeyDown);

    global.TT_DODGE_DEBUG = {
        enable: enable, disable: disable, toggleViz: toggleViz,
        togglePanel: togglePanelHidden, help: help, verify: verify,
        runScenario: runScenario, runAll: runAll, status: status,
        injectTest: injectTest, getSnapshot: getSnapshot
    };

    console.log('F8=AI可视化 H=隐面板');
    (function tryHookRoundViz() {
        hookRoundEventsForViz();
        if (!hookRoundEventsForViz._done) {
            setTimeout(tryHookRoundViz, 50);
        }
    })();
    if (debugEnabled()) setTimeout(function() {
        hookRoundEventsForViz();
        if (global.localStorage && global.localStorage.getItem(VIZ_KEY) === '1') toggleViz(true);
    }, 1000);
})(typeof window !== 'undefined' ? window : this);
