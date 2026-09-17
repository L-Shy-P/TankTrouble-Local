import io

p = 'vantage_tree.js'
s = io.open(p, encoding='utf-8').read()

# ---------- 1) 录制器状态 ----------
old1 = """    var _threatEtaOverride = null;            // v105：测试用——直接指定“还有几秒挨打”"""
new1 = """    var _threatEtaOverride = null;            // v105：测试用——直接指定“还有几秒挨打”

    // v106：关键场景录制器 --------------------------------------------------
    // 主人要的“点击开始记录、再点结束导出”：把逐帧的
    //   「真实世界（坦克/子弹/死亡）」× 「树的决策（执行哪个操作、
    //     当时预测什么、预测误差多少、预测的死亡帧）」
    // 一起存下来，用来逐帧对比“预测”和“实际”——这是查
    // 「预测到死亡却没回退」「一头撞上子弹」这类问题的唯一可靠手段。
    var _rec = {
        on: false,
        buf: [],            // 逐帧轻量记录
        segSnaps: [],       // 段末快照（9 候选分数、选中项、预测死亡帧）
        maxFrames: 3600,    // 最多 60 秒（60fps）
        armed: true,        // 死亡自动抓取（不用一直开着录）
        autoKeepFrames: 360,// 死亡时保留前 6 秒
        autoPostFrames: 90, // 死亡后继续录 1.5 秒
        autoTail: 0,
        autoEvents: [],     // 自动抓取的死亡事件
        startedAt: null,
        startReason: '',
        version: 0
    };

    function recBegin(reason) {
        _rec.on = true;
        _rec.buf = [];
        _rec.segSnaps = [];
        _rec.autoTail = 0;
        _rec.startedAt = _timeAcc;
        _rec.startReason = reason || 'manual';
        _rec.version++;
        return true;
    }

    function recStop() {
        _rec.on = false;
        return _rec.buf.length;
    }

    function isRecording() { return !!_rec.on; }

    /** 死亡自动抓取：即使没在手动录，也把死亡前后这一段留住。 */
    function recNoteDeath(info) {
        if (!_rec.armed) return;
        _rec.autoEvents.push({
            t: _timeAcc,
            killer: info && info.killerPlayerId !== undefined ? info.killerPlayerId : null,
            projectileId: info && info.projectileId !== undefined ? info.projectileId : null,
            projectileType: info && info.defenderType !== undefined ? info.defenderType : null,
            bufLen: _rec.buf.length
        });
        if (_rec.autoEvents.length > 20) _rec.autoEvents.shift();
        if (!_rec.on) {
            // 没在录 → 立刻开录，并且把环形缓冲里“死亡之前”的帧也要留住：
            // 这里用一个滚动环形缓冲实现（见 recFrame 的 _recRing）。
            recBegin('auto-death');
            _rec.autoTail = _rec.autoPostFrames;
            var ring = _recRing.slice(-_rec.autoKeepFrames);
            for (var i = 0; i < ring.length; i++) _rec.buf.push(ring[i]);
        } else {
            _rec.autoTail = _rec.autoPostFrames;
        }
    }

    // 滚动环形缓冲：始终保留最近 maxFrames 帧，死亡时能被 recNoteDeath 取用。
    var _recRing = [];

    /** 每帧轻量记录。只在“开录”或“刚刚死亡要补录”时写主缓冲。 */
    function recFrame(ai, tree, adapter, tankState) {
        var node = tree && tree.commitNode;
        var frame = null;
        var proj = null;
        try { proj = adapter.getProjectiles ? adapter.getProjectiles() : null; } catch (eProj) {}
        frame = {
            t: Math.round(_timeAcc * 1000) / 1000,
            tank: {
                x: Math.round(tankState.x * 100) / 100,
                y: Math.round(tankState.y * 100) / 100,
                rot: Math.round(tankState.rot * 1000) / 1000
            },
            proj: (proj || []).map(function (p) {
                return {
                    id: p && p.id,
                    x: p && isFinite(p.x) ? Math.round(p.x * 100) / 100 : null,
                    y: p && isFinite(p.y) ? Math.round(p.y * 100) / 100 : null,
                    vx: p && isFinite(p.speedX) ? Math.round(p.speedX * 10) / 10 : null,
                    vy: p && isFinite(p.speedY) ? Math.round(p.speedY * 10) / 10 : null
                };
            }),
            op: node ? (node.opName || '?') : null,
            commitId: node ? node.id : null,
            segEnd: node && typeof node.tEndSec === 'number' ? Math.round(node.tEndSec * 1000) / 1000 : null,
            planned: node ? node.plannedFrames : null,
            seg: node ? node.segmentFrames : null,
            // 树对当前执行的这一段预测了什么
            pred: (node && node.simState && node.simState.tank) ? {
                x: Math.round(node.simState.tank.x * 100) / 100,
                y: Math.round(node.simState.tank.y * 100) / 100,
                rot: Math.round(node.simState.tank.rot * 1000) / 1000,
                tGlobal: node.simState.tGlobal !== undefined ? Math.round(node.simState.tGlobal * 1000) / 1000 : null
            } : null,
            predDeathFrame: node ? node.fullDeathFrame : null,
            predStatus: node ? node.status : null,
            predAuthority: node ? (node.deathAuthority || '') : '',
            // 当前执行段的“段末对齐误差”（上次段末记录下来的，用来量化预测偏差）
            segEndErr: node && node._segEndErr ? node._segEndErr : null,
            nodes: tree ? tree.nodeCount : -1,
            threats: (tree && tree.threats) ? tree.threats.length : 0,
            threatIds: (tree && tree.threatIds) || '',
            live: (tree && typeof tree._liveProjectileCount === 'number') ? tree._liveProjectileCount : null,
            trees: _rebuildCount,
            retreats: (tree && tree.stats) ? (tree.stats.retreats || 0) : 0
        };
        _recRing.push(frame);
        if (_recRing.length > _rec.maxFrames) _recRing.shift();
        if (_rec.on) {
            _rec.buf.push(frame);
            if (_rec.buf.length > _rec.maxFrames) _rec.buf.shift();
            if (_rec.autoTail > 0) {
                _rec.autoTail--;
                if (_rec.autoTail <= 0 && _rec.startReason === 'auto-death') {
                    _rec.on = false;   // 自动抓取完成，自动停
                }
            }
        }
    }

    /** 段末快照：这一段的 9 个候选分别多少分、选了谁、各自预测死在第几帧。 */
    function recSegmentSnapshot(tree, adapter, parent, chosen) {
        if (!_rec.on && (!_rec.armed)) return;
        var snap = {
            t: Math.round(_timeAcc * 1000) / 1000,
            parentId: parent ? parent.id : null,
            parentOp: parent ? (parent.opName || '?') : null,
            chosenId: chosen ? chosen.id : null,
            chosenOp: chosen ? (chosen.opName || '?') : null,
            cands: []
        };
        var kids = (parent && parent.children) ? parent.children : [];
        for (var i = 0; i < kids.length; i++) {
            var c = kids[i];
            if (!c) continue;
            snap.cands.push({
                id: c.id,
                op: c.opName || '?',
                safety: Math.round((Number(c.subtreeBest) || 0) * 10) / 10,
                total: Math.round((Number(c.rolloutTotal) || 0) * 10) / 10,
                fd: c.fullDeathFrame,
                status: c.status,
                auth: c.deathAuthority || '',
                seg: c.segmentFrames,
                invalid: !!c.invalid,
                exhausted: !!c.exhausted
            });
        }
        snap.terrain = (function () {
            try {
                var d = debugObjective(kids);
                return {
                    safetyFactor: Math.round(d.killfieldSafetyFactor * 1000) / 1000,
                    kfScale: Math.round(d.killfieldScale * 10) / 10,
                    currentTile: d.currentTile,
                    rows: d.rows.map(function (r) {
                        return {
                            op: r.opName,
                            safety: Math.round((Number(r.safetyTotal) || 0) * 10) / 10,
                            dir: Math.round(r.kfDirGain * 1000) / 1000,
                            bonus: Math.round(r.kfBonus * 10) / 10,
                            score: Math.round(r.score * 10) / 10
                        };
                    })
                };
            } catch (eTer) { return null; }
        })();
        _rec.segSnaps.push(snap);
        if (_rec.segSnaps.length > 300) _rec.segSnaps.shift();
    }

    /** 导出录制内容。 */
    function exportRecord() {
        return {
            version: _rec.version,
            startedAt: _rec.startedAt,
            startReason: _rec.startReason,
            frames: _rec.buf.length,
            deaths: _rec.autoEvents.slice(),
            meta: {
                treeVersion: 'v106',
                frameDt: FRAME_DT,
                tNow: _timeAcc,
                rebuilds: _rebuildCount,
                killfieldEnabled: _killfieldEnabled,
                killfieldWeight: _killfieldWeight,
                emptyFieldSafety: _emptyFieldSafety,
                emptyFieldLaziness: _emptyFieldLaziness,
                targetMixEnabled: _targetMixEnabled,
                targetMixRatio: _targetMixRatio,
                liveProjectiles: _liveProjectilesNow,
                currentTile: _currentTile ? { x: _currentTile.x, y: _currentTile.y } : null,
                anchorTile: _killfieldAnchorTile ? { x: _killfieldAnchorTile.x, y: _killfieldAnchorTile.y } : null,
                lastReset: _lastResetSnapshot,
                lastKill: _lastKillInfo
            },
            segSnaps: _rec.segSnaps,
            records: _rec.buf
        };
    }

    // 段末对齐误差：记录“树预测的段末位姿”与“真实段末位姿”的差，
    // 直接量化“预测 vs 执行”的偏差（主人怀疑的执行误差）。
    function recNoteSegmentEnd(tree, node, realTankState) {
        if (!node || !realTankState) return;
        var pred = (node.simState && node.simState.tank) ? node.simState.tank : null;
        if (!pred) return;
        var dx = realTankState.x - pred.x, dy = realTankState.y - pred.y;
        var dPos = Math.sqrt(dx * dx + dy * dy);
        var dRot = realTankState.rot - pred.rot;
        dRot = Math.atan2(Math.sin(dRot), Math.cos(dRot));
        node._segEndErr = {
            op: node.opName || '?',
            t: Math.round(_timeAcc * 1000) / 1000,
            dPos: Math.round(dPos * 1000) / 1000,
            dRot: Math.round(dRot * 1000) / 1000,
            planned: node.plannedFrames,
            seg: node.segmentFrames,
            predDeath: node.fullDeathFrame,
            status: node.status
        };
    }"""
assert old1 in s, 'recorder state'
s = s.replace(old1, new1, 1)

# ---------- 2) tick 末尾写帧 ----------
old2 = """        perfEnd('grow');
        growStep(tree, adapter, tree.threats || evalThreats);
    }"""
new2 = """        perfEnd('grow');
        growStep(tree, adapter, tree.threats || evalThreats);
        // v106：录制（轻量，默认只进环形缓冲；开录或死亡补录时才留档）
        try { recFrame(ai, tree, adapter, tankState); } catch (eRec) {}
    }"""
assert old2 in s, 'tick tail'
s = s.replace(old2, new2, 1)

# 让所有 return 分支也写帧：把 recFrame 放到 tick 最外层用 try/finally 不方便，
# 这里在三个提前 return 之前各补一次。
old3 = """            perfEnd('commit');
            commit(tree, adapter, evalThreats, tankState, { freshRoot: false });
            perfEnd('commit');
            return;"""
new3 = """            perfEnd('commit');
            commit(tree, adapter, evalThreats, tankState, { freshRoot: false });
            perfEnd('commit');
            try { recFrame(ai, tree, adapter, tankState); } catch (eRec0) {}
            return;"""
assert old3 in s, 'commit tail'
s = s.replace(old3, new3, 1)

old4 = """            perfEnd('commit');
            startCommitSlice(tree, adapter, evalThreats, tankState, { freshRoot: freshRoot });
            stepCommitSlice(tree);
            perfEnd('commit');
            return;"""
new4 = """            perfEnd('commit');
            startCommitSlice(tree, adapter, evalThreats, tankState, { freshRoot: freshRoot });
            stepCommitSlice(tree);
            perfEnd('commit');
            try { recFrame(ai, tree, adapter, tankState); } catch (eRec1) {}
            return;"""
assert old4 in s, 'commit slice tail'
s = s.replace(old4, new4, 1)

# ---------- 3) 导出 ----------
old5 = """        getPerf: perfSnapshot,"""
new5 = """        getPerf: perfSnapshot,
        // v106：关键场景录制（点击开始 / 再点结束导出）
        startRecord: function(reason) { return recBegin(reason); },
        stopRecord: recStop,
        isRecording: isRecording,
        exportRecord: exportRecord,
        peekRecord: function() { return { on: _rec.on, frames: _rec.buf.length, segSnaps: _rec.segSnaps.length, ring: _recRing.length, deaths: _rec.autoEvents.length }; },"""
assert old5 in s, 'export'
s = s.replace(old5, new5, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('ok')
