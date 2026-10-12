# -*- coding: utf-8 -*-
"""阶段2-1：只给 vantage_sandbox.js 的 createVantageAdapter 加取数方法/字段。
只加不改语义：getTankState 的 x/y/rot 原样保留，getProjectiles 只加 lifeLeft。"""
import io, sys

P = 'game_core/js/vantage_sandbox.js'
s = io.open(P, encoding='utf-8', newline='').read()
orig_len = len(s)


def rep(old, new, tag):
    global s
    assert s.count(old) == 1, '[%s] anchor count=%d' % (tag, s.count(old))
    s = s.replace(old, new)
    print('OK  ' + tag)


# ── ① getTankState：只加字段（x/y/rot 原样） ───────────────────────────────
old_tankstate = """            getTankState: function() {
                var tank = gameController.getTank(aiId);
                if (!tank) return null;
                return { x: tank.getX(), y: tank.getY(), rot: tank.getRotation() };
            },"""
new_tankstate = """            getTankState: function() {
                var tank = gameController.getTank(aiId);
                if (!tank) return null;
                // v175（阶段2-1）：【只加字段】—— x/y/rot 这三个既有字段含义原样不动。
                //   按键 5 个 + locked：⚠️ Tank.getForward/getBack/getLeft/getRight/getFireDown
                //   在 locked 时**全部返回 false**（7b2ed8ad…:行3 每个 getter 体内都有
                //   `if(this.locked){return false;}`）⟹ 不给 locked 就分不清「没按」与「被武器锁定」。
                //   speed/rotationSpeed 同样在 locked 时被归零（同文件 getSpeed/getRotationSpeed）。
                //   弹药/护盾走下面两个只读小工具（_ammoOf/_shieldOf），失败一律给 null，绝不抛。
                return {
                    x: tank.getX(),
                    y: tank.getY(),
                    rot: tank.getRotation(),
                    forward: tank.getForward ? tank.getForward() : null,
                    back: tank.getBack ? tank.getBack() : null,
                    left: tank.getLeft ? tank.getLeft() : null,
                    right: tank.getRight ? tank.getRight() : null,
                    fireDown: tank.getFireDown ? tank.getFireDown() : null,
                    locked: tank.getLocked ? tank.getLocked() : null,
                    speed: tank.getSpeed ? tank.getSpeed() : null,
                    rotationSpeed: tank.getRotationSpeed ? tank.getRotationSpeed() : null,
                    ammo: _ammoOf(aiId),
                    shield: _shieldOf(aiId)
                };
            },"""
rep(old_tankstate, new_tankstate, 'tankstate')

# ── ② getProjectiles：只加 lifeLeft ────────────────────────────────────────
old_proj = """                        type: p.getType ? p.getType() : null,
                        targetId: (p.currentTargetPlayerId === undefined || p.currentTargetPlayerId === null)
                            ? null : p.currentTargetPlayerId
                    });"""
new_proj = """                        type: p.getType ? p.getType() : null,
                        targetId: (p.currentTargetPlayerId === undefined || p.currentTargetPlayerId === null)
                            ? null : p.currentTargetPlayerId,
                        // v175（阶段2-1）：lifeLeft = lifetime − getTimeAlive()。
                        //   ⚠️ lifeTotal 直读【普通实例属性】p.lifetime：游戏里 **没有 getLifetime()**
                        //   （418577fd…:行4 Projectile.fields 有 lifetime/timeAlive，方法区只有 getTimeAlive）。
                        //   ⚠️ 地雷破片（Shrapnel）建体时 lifetime 传 0 ⟹ 它的 lifeLeft 恒 ≤0，
                        //   这不是 bug，是「碎片一出即老」的真实口径（见本文件 v161 注释）。
                        //   ✅ 只加这一个字段；bounces/deadlyToOwner/stopped【本轮故意不加】（要主人拍 6/9 维）。
                        lifeLeft: (typeof p.lifetime === 'number' && p.getTimeAlive)
                            ? (p.lifetime - p.getTimeAlive()) : null
                    });"""
rep(old_proj, new_proj, 'projectiles.lifeLeft')

# ── ③ 只读小工具（插在 var adapter = { 之前） ────────────────────────────
anchor_adapter = """    function createVantageAdapter(gameController, aiId) {
        var consts = buildConstants();

        var adapter = {"""
helpers = """    function createVantageAdapter(gameController, aiId) {
        var consts = buildConstants();

        // ── v175（阶段2-1）：只读取数小工具（全部 try 包裹，取不到就给 null，绝不改游戏状态）──
        // 护盾升级类型码：Constants.UPGRADE_TYPES.SHIELD === 2（b714588d…:行1@4009）
        var SHIELD_UPGRADE_TYPE = (typeof Constants !== 'undefined' && Constants.UPGRADE_TYPES)
            ? Constants.UPGRADE_TYPES.SHIELD : 2;

        /** 读 Classy 私有字段：先走 getField（自动去 `_` 前缀），再兜底直读 `_name` */
        function _priv(obj, name) {
            if (!obj) return null;
            try {
                if (typeof obj.getField === 'function') {
                    var v = obj.getField(name);
                    if (v !== undefined && v !== null) return v;
                }
            } catch (eGF) {}
            var key = '_' + name;
            return (obj[key] !== undefined) ? obj[key] : null;
        }

        /** 当前武器弹药（活对象；⚠️ 绝不读序列化 fieldsJSON —— 那条路会全 null） */
        function _ammoOf(playerId) {
            var w = null;
            try { w = gameController.getActiveWeapon(playerId); } catch (eA) {}
            if (!w) return null;
            var numBullets = _priv(w, 'numBullets');
            var bulletsFired = _priv(w, 'bulletsFired');
            return {
                weaponId: (w.getId ? w.getId() : null),
                type: (w.getType ? w.getType() : null),
                numBullets: numBullets,
                bulletsFired: bulletsFired,
                numMines: _priv(w, 'numMines'),
                triggerPulled: _priv(w, 'triggerPulled'),
                // 两种口径**原样给、不换算**：
                //   默认枪（BulletWeapon）：_numBullets=初值(5)、_bulletsFired 递增 ⟹ 剩余=numBullets-bulletsFired
                //   双管/霰弹/地雷/加特林：_numBullets/_numMines 直接递减 ⟹ 本身就是剩余
                remainingByDifference: (numBullets !== null && bulletsFired !== null)
                    ? (numBullets - bulletsFired) : null
            };
        }

        /** 护盾（在 upgrades 里，**不在** MODIFIER_TYPES —— 后者只有 {SPEED:0}，b714588d…:行1@4295） */
        function _shieldOf(playerId) {
            var u = null;
            try {
                if (typeof gameController.getUpgradeByPlayerIdAndType === 'function') {
                    u = gameController.getUpgradeByPlayerIdAndType(playerId, SHIELD_UPGRADE_TYPE);
                }
            } catch (eS) {}
            if (!u) return null;
            return {
                upgradeId: (u.getId ? u.getId() : null),
                type: (u.getType ? u.getType() : null),
                lifetime: _priv(u, 'lifetime'),
                weakened: _priv(u, 'weakened')
            };
        }

        /** 武器活对象的摘要（id/type/全部自定义字段） */
        function _weaponSummary(w) {
            if (!w) return null;
            var fields = null;
            try { fields = (typeof w.getFields === 'function') ? w.getFields() : null; } catch (eWF) {}
            return {
                id: (w.getId ? w.getId() : null),
                playerId: (w.getPlayerId ? w.getPlayerId() : null),
                type: (w.getType ? w.getType() : null),
                fields: fields
            };
        }

        var adapter = {"""
rep(anchor_adapter, helpers, 'helpers')

# ── ④ 新取数方法（插在 getB2DWorld 之后） ───────────────────────────────
anchor_b2d = """            getB2DWorld: function() {
                return gameController.getB2DWorld();
            },
"""
new_methods = """            getB2DWorld: function() {
                return gameController.getB2DWorld();
            },

            // ══════════════════════════════════════════════════════════════════
            // v175（阶段2-1）：纯转发取数（**只加**；全部是 GameController 上真实存在的方法，
            //   逐个已在 ce217c9b…:行1 核对过：@17186/@17287/@17903/@17691/@18914/@18712/
            //   @10202/@18561/@18004/@18121/@18240/@16639/@16785/@16838/@9905）。
            //   返回【活对象】（与既有 getMaze/getB2DWorld 同口径），不拷贝、不换算。
            // ══════════════════════════════════════════════════════════════════
            getTank: function(playerId) {
                return gameController.getTank(playerId);
            },

            getTanks: function() {
                return gameController.getTanks();
            },

            getCollectibles: function() {
                return gameController.getCollectibles();
            },

            getTraps: function() {
                return gameController.getTraps();
            },

            getZones: function() {
                return gameController.getZones();
            },

            getUpgradeByPlayerIdAndType: function(playerId, type) {
                return gameController.getUpgradeByPlayerIdAndType(playerId, type);
            },

            getScores: function() {
                return gameController.getScores();
            },

            getScoreByPlayerIdAndType: function(playerId, type) {
                return gameController.getScoreByPlayerIdAndType(playerId, type);
            },

            getCounters: function() {
                var out = [];
                var counters = null;
                try { counters = gameController.getCounters(); } catch (eC) {}
                for (var cid in counters) {
                    var c = counters[cid];
                    if (!c) continue;
                    out.push({
                        id: cid,
                        type: (c.getType ? c.getType() : null),
                        // 剩余秒：TimerCountdownCounter._currentTime 递减 / OvertimeCountUpCounter._currentTime 递增
                        // （7b2ed8ad…:行32@34499 / 行34@35206）
                        currentTime: _priv(c, 'currentTime'),
                        startTime: _priv(c, 'startTime')
                    });
                }
                return out;
            },

            /** 回合/游戏状态字符串（GameModel._STATES：between rounds/counting down/in round/ended） */
            getState: function() {
                return gameController.getState ? gameController.getState() : null;
            },

            /**
             * ⚠️ 与游戏里 RoundState.getWeaponStates() **不是同一个东西**（那个只在 expanded
             * 的 RoundState 上，且游戏侧 GameController/RoundController 都没透出 getWeapons）。
             * 本方法是【逐玩家】口径：getActiveWeapon + getDefaultWeapon + getQueuedWeapons
             * （ce217c9b…:行1@18004/@18121/@18240），不受 RoundState 的 expanded 位影响。
             */
            getWeaponStates: function(playerId) {
                var id = (playerId === undefined || playerId === null) ? aiId : String(playerId);
                var active = null, def = null, queued = [];
                try { active = gameController.getActiveWeapon(id); } catch (eWA) {}
                try { def = gameController.getDefaultWeapon(id); } catch (eWD) {}
                try {
                    var q = gameController.getQueuedWeapons(id) || [];
                    for (var i = 0; i < q.length; i++) queued.push(_weaponSummary(q[i]));
                } catch (eWQ) {}
                return {
                    playerId: id,
                    active: _weaponSummary(active),
                    default: _weaponSummary(def),
                    queued: queued
                };
            },

            /**
             * ⚠️【如实标注】返回值**恒为 Constants.TEAMS.NO_TEAM = 0**。
             * 证据：所有已实现的 GameMode.getTeam() 都 `return Constants.TEAMS.NO_TEAM`
             * （54518faa…:行45@41391；Classic 继承、Deathmatch 行49 同款），且 addPlayer 硬编码
             * NO_TEAM（ce217c9b…:行1@5081）；全仓 grep：TEAM_RED/TEAM_BLUE **只出现在常量定义处**，
             * 没有任何写入点。字段是真字段，数据是假数据 ⟹ 保留能力，但**观测编码阶段不要编队友段**。
             */
            getTeam: function(playerId) {
                var id = (playerId === undefined || playerId === null) ? aiId : String(playerId);
                var player = null;
                try { player = gameController.getActivePlayer(id); } catch (ePA) {}
                if (!player) {
                    try { player = gameController.getQueuedPlayer(id); } catch (ePQ) {}
                }
                if (player && typeof player.getTeam === 'function') return player.getTeam();
                return null;
            },

            /**
             * RoundState 快照。expanded=false 时等价于 GameController.getRoundState()（它内部传
             * this.playerAdded）；expanded=true 时**直达 RoundController.getRoundState(true)**
             * （82e43ebf…:行1@7800 `expandedState |= !this.initialRoundStateSent`）。
             * ⚠️ 结构性坑：地雷/武器/升级/计时器/毒雾五段**只在 expanded 时**才有
             * （46989e39…:行1@18340 `if(expandedState){this._getExpandedRoundState(rs);}`）
             * ⟹ 那五类请直接走 getTraps/getUpgradeByPlayerIdAndType/getZones/getCounters/getWeaponStates。
             */
            getRoundState: function(expanded) {
                var rc = gameController.roundController || null;
                if (expanded && rc && typeof rc.getRoundState === 'function') {
                    try { return rc.getRoundState(true); } catch (eRS) {}
                }
                return gameController.getRoundState ? gameController.getRoundState() : null;
            },

            /** 地图/对局配置四件套（对称 / 毒雾开关 / 可刷新道具类型 / 玩家上限）+ 模式 */
            getMatchConfig: function() {
                var gm = null;
                try { gm = gameController.getGameMode ? gameController.getGameMode() : null; } catch (eGM) {}
                // ⚠️ crateTypes 在游戏里【只有字段、没有 getter】（ce217c9b…:行1@731 字段块；
                //   getCrateTypes 只存在于网络消息 CreateGameMessage，54518faa…:行32@16571）
                var crates = null;
                try {
                    if (gameController.crateTypes && gameController.crateTypes.length !== undefined) {
                        crates = Array.prototype.slice.call(gameController.crateTypes);
                    } else if (gm && gm.crateTypes && gm.crateTypes.length !== undefined) {
                        crates = Array.prototype.slice.call(gm.crateTypes);
                    }
                } catch (eCT) {}
                return {
                    symmetric: gameController.getSymmetric ? gameController.getSymmetric() : null,
                    storm: gameController.getStorm ? gameController.getStorm() : null,
                    crateTypes: crates,
                    maxActivePlayerCount: gameController.getMaxActivePlayerCount ? gameController.getMaxActivePlayerCount() : null,
                    mode: gameController.getMode ? gameController.getMode() : null,
                    premium: gameController.getPremium ? gameController.getPremium() : null,
                    ranked: gameController.getRanked ? gameController.getRanked() : null
                };
            },
"""
rep(anchor_b2d, new_methods, 'new_methods')

io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('written, %d -> %d chars (+%d)' % (orig_len, len(s), len(s) - orig_len))
