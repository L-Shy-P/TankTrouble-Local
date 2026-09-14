/**
 * TankTrouble 本地模式补丁 — 在 ajax.js 加载后立即执行
 * v3：移除本地部署不需要的 Cookie 同意提示条。
 * v4：点击地面只设置树评分目标，不再直接接管 AI 驾驶。
 */
(function() {
    'use strict';

    var _localGuestCounter = 0;
    var _lobbyLaikaCounter = 0;
    var LAIKA_TEMPLATE_ID = '6148530';
    var LOCAL_MAX_TANKS = 8;
    var _ajaxPatched = false;
    var _aiConstantsApplied = false;

    function getLocalMaxTanks() {
        if (typeof Constants !== 'undefined' && Constants.CLIENT &&
            Constants.CLIENT.MAX_PLAYERS > LOCAL_MAX_TANKS) {
            return Constants.CLIENT.MAX_PLAYERS;
        }
        return LOCAL_MAX_TANKS;
    }

    function applyLocalLimits() {
        if (typeof Constants !== 'undefined' && Constants.CLIENT) {
            Constants.CLIENT.MAX_PLAYERS = LOCAL_MAX_TANKS;
        }
    }

    function countLobbyTanks() {
        if (typeof Users === 'undefined' || !Users.getAllPlayerIds) {
            return 0;
        }
        return Users.getAllPlayerIds().length;
    }

    function canAddMoreLobbyTanks() {
        return countLobbyTanks() < getLocalMaxTanks();
    }

    function getLocalAIProfiles() {
        if (typeof TankTroubleAIStrength !== 'undefined') {
            return TankTroubleAIStrength.getAIList();
        }
        return [
            {
                playerId: '6148530',
                config: {
                    name: 'Laika',
                    dexterity: '0.6', cleverness: '0.4', boldness: '0.9',
                    greediness: '0.2', determination: '0.6',
                    aggressiveness: '0.9', vengefulness: '0.8'
                }
            }
        ];
    }

    function buildLocalAIs() {
        return getLocalAIProfiles();
    }

    var LOCAL_AIS = buildLocalAIs();

    var AI_PLAYER_DETAILS = {
        '6148530': {
            playerId: '6148530',
            username: 'Laika',
            victories: 0, kills: 0, deaths: 0, suicides: 0, surrenders: 0, experience: 0,
            turretColour: colourHex(0x4c4c4c),
            treadColour: colourHex(0xcccccc),
            baseColour: colourHex(0x4c4c4c),
            turretAccessory: '0', barrelAccessory: '0', frontAccessory: '0', backAccessory: '0',
            treadAccessory: '0', backgroundAccessory: '0', badge: '0',
            email: null, lastLogin: null, created: null, realName: null, birthYear: null, country: null,
            newsSubscriber: false, gmLevel: 0, beta: false, verified: true, banned: null,
            usernameApproved: true, premium: false, guest: false, rank: 11, xp: 0, lastForumPost: 0
        },
        'vantage_template': {
            playerId: 'vantage_template',
            username: 'Vantage',
            victories: 0, kills: 0, deaths: 0, suicides: 0, surrenders: 0, experience: 0,
            turretColour: colourHex(0x4c4c4c),
            treadColour: colourHex(0xcccccc),
            baseColour: colourHex(0x4c4c4c),
            turretAccessory: '0', barrelAccessory: '0', frontAccessory: '0', backAccessory: '0',
            treadAccessory: '0', backgroundAccessory: '0', badge: '0',
            email: null, lastLogin: null, created: null, realName: null, birthYear: null, country: null,
            newsSubscriber: false, gmLevel: 0, beta: false, verified: true, banned: null,
            usernameApproved: true, premium: false, guest: false, rank: 11, xp: 0, lastForumPost: 0
        }
    };

    function getLobbyLaikaDisplayName(instanceId) {
        if (typeof Users === 'undefined' || !Users.lobbyAIUsers) {
            return 'Laika 2';
        }
        var lobbyIds = Object.keys(Users.lobbyAIUsers);
        var i;
        for (i = 0; i < lobbyIds.length; i++) {
            if (lobbyIds[i] === instanceId) {
                return 'Laika ' + (i + 2);
            }
        }
        return 'Laika ' + (lobbyIds.length + 2);
    }

    function makeLobbyLaikaPlayerDetails(instanceId) {
        var template = AI_PLAYER_DETAILS[LAIKA_TEMPLATE_ID];
        var details = JSON.parse(JSON.stringify(template));
        details.playerId = instanceId;
        details.username = getLobbyLaikaDisplayName(instanceId);
        details.turretAccessory = '0';
        details.barrelAccessory = '0';
        details.frontAccessory = '0';
        details.backAccessory = '0';
        details.treadAccessory = '0';
        details.backgroundAccessory = '0';
        details.badge = '0';
        return details;
    }

    function cloneLaikaConfig(template) {
        var copy = {};
        var k;
        for (k in template) {
            if (template.hasOwnProperty(k)) copy[k] = template[k];
        }
        return copy;
    }

    function registerLobbyAIInstance(instanceId) {
        ensureAIsReady();
        if (typeof AIs === 'undefined' || !AIs.ais) return;
        
        // 检查是否是Vantage
        var isVantage = instanceId && instanceId.indexOf('vantage_') === 0;
        
        var template;
        if (isVantage) {
            // Vantage 复用 Laika 头像/Spine（name 须为 Laika），用 isVantage 区分 AI 逻辑
            template = AIs.ais[instanceId] || (AIs.getAI && AIs.getAI(LAIKA_TEMPLATE_ID));
            if (!template && LOCAL_AIS.length > 0) {
                template = LOCAL_AIS[0].config;
            }
            if (!template) return;
            if (!AIs.ais[instanceId]) {
                AIs.ais[instanceId] = cloneLaikaConfig(template);
            }
            AIs.ais[instanceId].name = 'Laika';
            AIs.ais[instanceId].isVantage = true;
        } else {
            // 普通Laika
            template = AIs.ais[instanceId] || (AIs.getAI && AIs.getAI(LAIKA_TEMPLATE_ID));
            if (!template && LOCAL_AIS.length > 0) {
                template = LOCAL_AIS[0].config;
            }
            if (!template) return;
            if (!AIs.ais[instanceId]) {
                AIs.ais[instanceId] = cloneLaikaConfig(template);
            }
            AIs.ais[instanceId].name = 'Laika';
        }
    }

    function ensureLobbyLaikaSpineAvatar(avatarGroup, playerId, targetScale) {
        if (!avatarGroup || avatarGroup.avatarSpine) return;
        if (typeof UILaikaSpine === 'undefined' || typeof UIConstants === 'undefined') {
            return;
        }
        registerLobbyAIInstance(playerId);
        avatarGroup.name = 'Laika';
        avatarGroup.avatarSpine = avatarGroup.addChild(new UILaikaSpine(
            avatarGroup.game,
            UIConstants.AVATAR_LAIKA_X,
            UIConstants.AVATAR_LAIKA_Y,
            playerId,
            true
        ));
        var scale = targetScale !== undefined ? targetScale : (avatarGroup.targetScale || 1);
        avatarGroup.targetScale = scale * UIConstants.AVATAR_LAIKA_SCALE;
        avatarGroup.avatarSpine.anchor.setTo(0.5, 0.5);
        avatarGroup.avatarSpine.idle();
    }

    function refreshLobbyAIAvatarInPanel(playerId) {
        if (typeof UIPlayerPanel === 'undefined' || !UIPlayerPanel.phaserInstance ||
            !UIPlayerPanel.phaserInstance.state) {
            return;
        }
        var state = UIPlayerPanel.phaserInstance.state.getCurrentState();
        if (!state || !state.localTankIcons || !state.localTankIcons[playerId]) {
            return;
        }
        var entry = state.localTankIcons[playerId];
        if (entry && entry.avatar) {
            ensureLobbyLaikaSpineAvatar(entry.avatar, playerId, entry.avatar.targetScale);
        }
        if (state.scheduleUpdate) {
            state.scheduleUpdate(true);
        }
    }

    function ensureAllLobbyAIsRegistered() {
        if (typeof Users === 'undefined' || !Users.lobbyAIUsers) return;
        if (!ensureAIsReady()) return;
        var ids = Object.keys(Users.lobbyAIUsers);
        var i;
        for (i = 0; i < ids.length; i++) {
            registerLobbyAIInstance(ids[i]);
        }
    }

    function isLobbyAIPlayer(playerId) {
        return typeof Users !== 'undefined' && Users.isLobbyAIUser &&
            Users.isLobbyAIUser(playerId);
    }

    function isLobbyOrRegisteredAI(playerId) {
        if (isLobbyAIPlayer(playerId)) {
            return true;
        }
        return typeof AIs !== 'undefined' && AIs.isAI && AIs.isAI(playerId);
    }

    function findAIManagerFor(gameId, aiId) {
        if (typeof AIs === 'undefined' || !AIs.aiManagers) return null;
        var i;
        for (i = 0; i < AIs.aiManagers.length; i++) {
            if (AIs.aiManagers[i].getAIId() === aiId &&
                AIs.aiManagers[i].getGameId() === gameId) {
                return AIs.aiManagers[i];
            }
        }
        return null;
    }

    function getActiveLocalGameController() {
        if (typeof GameManager === 'undefined' || !GameManager.getGameController) {
            return null;
        }
        if (typeof Constants === 'undefined' || !Constants.getMode) {
            return null;
        }
        if (Constants.getMode() !== Constants.MODE_CLIENT_LOCAL) {
            return null;
        }
        return GameManager.getGameController();
    }

    function isSoloAutoAIInGame(gameController, aiId) {
        if (!gameController || aiId !== LAIKA_TEMPLATE_ID || isLobbyAIPlayer(aiId)) {
            return false;
        }
        var i, lp = gameController.localPlayerIds || [];
        for (i = 0; i < lp.length; i++) {
            if (lp[i] === aiId) return true;
        }
        if (gameController.getTank && gameController.getTank(aiId)) {
            return true;
        }
        if (gameController.model) {
            var qp = gameController.model.queuedPlayers || {};
            var ap = gameController.model.activePlayers || {};
            if (qp[aiId] || ap[aiId]) return true;
        }
        return false;
    }

    function attachAIManagerDirect(gameController, aiId) {
        if (!gameController || !aiId) return false;
        if (typeof AIs === 'undefined' || !AIs.aiManagers) return false;
        if (typeof AIManager === 'undefined' || !AIManager.create) return false;

        if (isLobbyAIPlayer(aiId)) {
            registerLobbyAIInstance(aiId);
        } else if (!AIs.ais[aiId]) {
            ensureAIsReady();
        }
        var cfg = resolveAIConfig(aiId);
        if (!cfg) {
            console.warn('[Local Patch] 无 AI 配置，无法创建 AIManager:', aiId);
            return false;
        }

        var gameId = gameController.getId();
        var existing = findAIManagerFor(gameId, aiId);
        if (existing) {
            rebindingAIManagerAfterCreate(existing, gameController, false);
            return true;
        }

        try {
            var manager;
            // 检查是否是Vantage，使用VantageAI类
            if ((cfg.isVantage || (aiId && aiId.indexOf('vantage_') === 0)) &&
                typeof VantageAIManager !== 'undefined') {
                if (!cfg.isVantage) {
                    cfg.isVantage = true;
                }
                manager = VantageAIManager.create(aiId, cfg, gameController);
                manager.isVantage = true;
                // Vantage 正常加入游戏时也进入树模式（不依赖调试面板手点）。
                if (typeof VantageTestbench !== 'undefined' && VantageTestbench.getState) {
                    var tbState = VantageTestbench.getState();
                    if (!tbState.aiControl) tbState.aiControl = { enabled: false, opIndex: 0, auto: false, tree: false };
                    tbState.aiControl.enabled = true;
                    tbState.aiControl.tree = true;
                    tbState.aiControl.auto = false;
                }
                console.log('[Vantage] 创建VantageAIManager:', aiId);
            } else {
                manager = AIManager.create(aiId, cfg, gameController);
            }
            AIs.aiManagers.push(manager);
            if (!AIs.aisInUse) {
                AIs.aisInUse = {};
            }
            if (!AIs.aisInUse[gameId]) {
                AIs.aisInUse[gameId] = [];
            }
            if (AIs.aisInUse[gameId].indexOf(aiId) < 0) {
                AIs.aisInUse[gameId].push(aiId);
            }
            rebindingAIManagerAfterCreate(manager, gameController, true);
            return true;
        } catch (err) {
            console.error('[Local Patch] AIManager.create 失败:', aiId, err);
            return false;
        }
    }

    function ensureLobbyAIManager(gameController, aiId) {
        if (!gameController || !aiId || !isLobbyAIPlayer(aiId)) return false;
        var ok = attachAIManagerDirect(gameController, aiId);
        if (!ok) {
            console.warn('[Local Patch] ensureLobbyAIManager 失败:', aiId);
        }
        return ok;
    }

    function resolveAIConfig(aiId) {
        registerLobbyAIInstance(aiId);
        if (!AIs.ais[aiId] && AIs.ais[LAIKA_TEMPLATE_ID]) {
            AIs.ais[aiId] = cloneLaikaConfig(AIs.ais[LAIKA_TEMPLATE_ID]);
        }
        return AIs.ais[aiId] || null;
    }

    function hasAIManagerFor(gameId, aiId) {
        if (typeof AIs === 'undefined' || !AIs.aiManagers) return false;
        var i;
        for (i = 0; i < AIs.aiManagers.length; i++) {
            if (AIs.aiManagers[i].getAIId() === aiId &&
                AIs.aiManagers[i].getGameId() === gameId) {
                return true;
            }
        }
        return false;
    }

    function getGamePlayerIds(gameController) {
        var ids = [];
        var seen = {};
        var i, pid, q, a, tanks, tid;
        if (gameController && gameController.model) {
            q = gameController.model.queuedPlayers
                ? Object.keys(gameController.model.queuedPlayers) : [];
            a = gameController.model.activePlayers
                ? Object.keys(gameController.model.activePlayers) : [];
            for (i = 0; i < q.length; i++) {
                pid = q[i];
                if (!seen[pid]) { ids.push(pid); seen[pid] = true; }
            }
            for (i = 0; i < a.length; i++) {
                pid = a[i];
                if (!seen[pid]) { ids.push(pid); seen[pid] = true; }
            }
        }
        if (gameController && gameController.getTanks) {
            tanks = gameController.getTanks();
            if (tanks) {
                for (tid in tanks) {
                    if (tanks.hasOwnProperty(tid) && !seen[tid]) {
                        ids.push(tid);
                        seen[tid] = true;
                    }
                }
            }
        }
        if (typeof Users !== 'undefined' && Users.lobbyAIUsers) {
            var lobbyIds = Object.keys(Users.lobbyAIUsers);
            for (i = 0; i < lobbyIds.length; i++) {
                pid = lobbyIds[i];
                if (!seen[pid]) { ids.push(pid); seen[pid] = true; }
            }
        }
        if (ids.length === 0 && typeof Users !== 'undefined' && Users.getAllPlayerIds) {
            ids = Users.getAllPlayerIds();
        }
        return ids;
    }

    function scheduleAISyncForGame(gameController) {
        if (!gameController) return;
        syncAIManagersForGame(gameController);
        var delays = [50, 200, 600];
        var i;
        for (i = 0; i < delays.length; i++) {
            (function(delay) {
                setTimeout(function() {
                    syncAIManagersForGame(gameController);
                }, delay);
            })(delays[i]);
        }
    }

    function syncAIManagersForGame(gameController) {
        reviveAllAIManagersForGame(gameController);
    }

    function attachAIManagersForGame(gameController) {
        if (!gameController || typeof Users === 'undefined' || !Users.lobbyAIUsers) return;
        ensureAIsReady();
        ensureAllLobbyAIsRegistered();
        var lobbyIds = Object.keys(Users.lobbyAIUsers);
        var i, pid, tanks, tid;
        for (i = 0; i < lobbyIds.length; i++) {
            pid = lobbyIds[i];
            ensureLobbyAIManager(gameController, pid);
        }
        tanks = gameController.getTanks ? gameController.getTanks() : null;
        if (tanks) {
            for (tid in tanks) {
                if (tanks.hasOwnProperty(tid) && isLobbyAIPlayer(tid) &&
                    !findAIManagerFor(gameController.getId(), tid)) {
                    console.warn('[Local Patch] 坦克已生成但缺少 AIManager，补挂:', tid);
                    ensureLobbyAIManager(gameController, tid);
                }
            }
        }
    }

    function rebindingAIManagerAfterCreate(manager, gameController, resetAI) {
        if (!manager || !gameController) return;
        manager.gameController = gameController;
        if (manager.ai) {
            manager.ai.gameController = gameController;
            if (resetAI && manager.ai._reset) {
                manager.ai._reset();
            }
        }
    }

    function reviveAllAIManagersForGame(gameController) {
        if (!gameController) return;
        ensureAIsReady();
        attachAIManagersForGame(gameController);

        if (isSoloAutoAIInGame(gameController, LAIKA_TEMPLATE_ID)) {
            attachAIManagerDirect(gameController, LAIKA_TEMPLATE_ID);
        }

        if (typeof AIs === 'undefined' || !AIs.aiManagers) return;
        var gameId = gameController.getId();
        var i;
        for (i = 0; i < AIs.aiManagers.length; i++) {
            if (AIs.aiManagers[i].getGameId() === gameId) {
                rebindingAIManagerAfterCreate(AIs.aiManagers[i], gameController, true);
            }
        }
    }

    function cleanupLegacyLobbyTemplateAI() {
        if (typeof Users === 'undefined' || !Users.lobbyAIUsers ||
            !Users.lobbyAIUsers[LAIKA_TEMPLATE_ID]) {
            return;
        }
        delete Users.lobbyAIUsers[LAIKA_TEMPLATE_ID];
        Users._notifyEventListeners(Users.EVENTS.GUEST_REMOVED, LAIKA_TEMPLATE_ID);
    }

    function createLobbyLaikaId() {
        _lobbyLaikaCounter++;
        return 'laika_' + Date.now() + '_' + _lobbyLaikaCounter;
    }

    function colourHex(value) {
        var hex = (value >>> 0).toString(16).toLowerCase();
        while (hex.length < 6) hex = '0' + hex;
        var s = '0x' + hex;
        return { type: 'numeric', rawValue: s, numericValue: s, imageValue: '' };
    }

    function makeGuestPlayerDetails(playerId) {
        _localGuestCounter++;
        return {
            playerId: playerId,
            username: 'Guest ' + _localGuestCounter,
            victories: 0, kills: 0, deaths: 0, suicides: 0, surrenders: 0, experience: 0,
            turretColour: colourHex(0x427fff),
            treadColour: colourHex(0x888888),
            baseColour: colourHex(0xff9900),
            turretAccessory: '0', barrelAccessory: '0', frontAccessory: '0', backAccessory: '0',
            treadAccessory: '0', backgroundAccessory: '0', badge: '0',
            email: null, lastLogin: null, created: null, realName: null, birthYear: null, country: null,
            newsSubscriber: false, gmLevel: 0, beta: false, verified: false, banned: null,
            usernameApproved: true, premium: false, guest: true, rank: 0, xp: 0, lastForumPost: 0
        };
    }

    function normalizeMethod(method) {
        if (!method) return method;
        if (method.indexOf('tanktrouble.') === 0) {
            return method.substring('tanktrouble.'.length);
        }
        return method;
    }

    function buildMockData(method, params) {
        method = normalizeMethod(method);
        var innerData;

        switch (method) {
            case 'account.createGuests':
                var numGuests = params && params[0] ? params[0] : 1;
                var playerDetails = [];
                var multiplayerTokens = [];
                var ts = Date.now();
                for (var i = 0; i < numGuests; i++) {
                    var guestId = 'guest_' + ts + '_' + i;
                    playerDetails.push(makeGuestPlayerDetails(guestId));
                    multiplayerTokens.push('local_token_' + guestId);
                }
                innerData = { playerDetails: playerDetails, multiplayerTokens: multiplayerTokens };
                break;

            case 'getAIs':
                innerData = LOCAL_AIS;
                break;

            case 'getPlayerDetails':
                var pid = params && params[0] ? String(params[0]) : 'guest_0';
                if (pid.indexOf('train_emitter_') === 0 &&
                    typeof TankTroubleTrainingMode !== 'undefined' &&
                    TankTroubleTrainingMode.getEmitterPlayerDetailsRaw) {
                    innerData = TankTroubleTrainingMode.getEmitterPlayerDetailsRaw(pid);
                } else if (typeof Users !== 'undefined' && Users.isLobbyAIUser &&
                    Users.isLobbyAIUser(pid)) {
                    var lobbyAIInfo = Users.lobbyAIUsers[pid];
                    if (lobbyAIInfo && lobbyAIInfo.isVantage) {
                        innerData = makeLobbyVantagePlayerDetails(pid);
                    } else {
                        innerData = makeLobbyLaikaPlayerDetails(pid);
                    }
                } else if (AI_PLAYER_DETAILS[pid]) {
                    innerData = AI_PLAYER_DETAILS[pid];
                } else {
                    innerData = makeGuestPlayerDetails(pid);
                }
                break;

            case 'garage.getGarageContent':
                var garagePid = params && params[0] ? params[0] : 'guest_0';
                innerData = {
                    playerId: garagePid,
                    boxes: [{
                        id: 1,
                        accessories: [],
                        sprayCans: [
                            { colour: colourHex(0x427fff) },
                            { colour: colourHex(0xff0000) },
                            { colour: colourHex(0x00ff00) },
                            { colour: colourHex(0x0000ff) }
                        ]
                    }]
                };
                break;

            case 'garage.setColour':
            case 'garage.setAccessory':
            case 'account.deleteGuest':
                innerData = params && params[0] ? String(params[0]) : '';
                break;

            case 'account.deauthenticate':
            case 'updateTutorialProgress':
            case 'ping':
                innerData = {};
                break;

            case 'getCurrency':
                innerData = { playerId: params && params[0] ? params[0] : 'guest_0', gold: 999, diamonds: 999 };
                break;

            case 'admin.getAdminRoles':
            case 'getFavourites':
            case 'achievement.getAchievements':
            case 'achievement.getUnseenAchievements':
            case 'message.getMessages':
            case 'message.getMessagesFromOldestUnseen':
            case 'news.getNewsPosts':
                innerData = [];
                break;

            case 'getScraps':
                innerData = { scraps: 1000, velocity: 0 };
                break;

            case 'getStatistics':
                innerData = {};
                break;

            case 'getTutorialProgress':
                innerData = { completed: true };
                break;

            case 'getPrimaryContent':
                innerData = { html: '' };
                break;

            case 'account.authenticate':
            case 'account.signUp':
                return { error: true };

            default:
                console.log('[Local Patch] unhandled method: ' + method);
                innerData = {};
                break;
        }

        return { result: { result: true, data: innerData } };
    }

    function ensureAIsReady() {
        LOCAL_AIS = buildLocalAIs();
        if (typeof AIs === 'undefined') return false;
        if (!AIs.ais) AIs.ais = {};
        for (var i = 0; i < LOCAL_AIS.length; i++) {
            AIs.ais[LOCAL_AIS[i].playerId] = LOCAL_AIS[i].config;
        }
        AIs.initialized = true;
        return true;
    }

    function applyAIStrengthConfig() {
        if (typeof TankTroubleAIStrength === 'undefined') return false;
        var resolved = TankTroubleAIStrength.resolve();
        LOCAL_AIS = resolved.aiProfiles.slice();

        if (!_aiConstantsApplied && typeof Constants !== 'undefined' && Constants.AI) {
            var n = TankTroubleAIStrength.applyDecisionConstants(resolved.decisionOverrides);
            if (n > 0) {
                console.log('[AI Strength] 已覆盖 Constants.AI 键数量:', n,
                    '预设:', (typeof TankTroubleAIStrengthConfig !== 'undefined' && TankTroubleAIStrengthConfig.activePreset) || 'custom');
            }
            _aiConstantsApplied = true;
        }
        return true;
    }

    function applyAjaxPatch() {
        if (_ajaxPatched) return true;
        if (typeof TankTrouble === 'undefined' || !TankTrouble.Ajax || !TankTrouble.Ajax._call) {
            return false;
        }

        TankTrouble.Ajax._call = function(successfn, errorfn, completefn, method, params) {
            var mock = buildMockData(method, params);
            if (mock.error) {
                setTimeout(function() {
                    var errorResult = { error: { message: 'Local mode - no ' + method } };
                    if (typeof errorfn === 'function') errorfn(errorResult);
                    if (typeof completefn === 'function') completefn(errorResult);
                }, 0);
                return;
            }

            setTimeout(function() {
                try {
                    if (TankTrouble.Ajax._unwrapAchievementUnlocksFromData) {
                        TankTrouble.Ajax._unwrapAchievementUnlocksFromData(mock);
                    }
                } catch (e) {}
                if (typeof successfn === 'function') successfn(mock);
                if (typeof completefn === 'function') completefn(mock);
            }, 0);
        };

        _ajaxPatched = true;
        console.log('[Local Patch] Ajax._call patched');
        return true;
    }

    function patchAIsInit() {
        if (typeof AIs === 'undefined' || !AIs.init || AIs._localInitPatched) return;
        AIs._localInitPatched = true;
        var origInit = AIs.init;
        AIs.init = function() {
            ensureAIsReady();
            try { origInit.call(AIs); } catch (e) {
                console.warn('[Local Patch] AIs.init error:', e);
            }
            ensureAIsReady();
            ensureAllLobbyAIsRegistered();
        };

        if (typeof Backend !== 'undefined' && Backend.getInstance) {
            var backend = Backend.getInstance();
            if (backend && backend.getAIs && !backend._localGetAIsPatched) {
                backend._localGetAIsPatched = true;
                var origGetAIs = backend.getAIs;
                backend.getAIs = function(successfn, errorfn, completefn, cache) {
                    origGetAIs.call(backend, function(result) {
                        ensureAIsReady();
                        ensureAllLobbyAIsRegistered();
                        if (typeof successfn === 'function') successfn(result);
                    }, errorfn, completefn, cache);
                };
            }
        }
    }

    function getNextLobbyAIId() {
        if (!canAddMoreLobbyTanks()) {
            return null;
        }
        return createLobbyLaikaId();
    }

    // Vantage相关函数
    var _lobbyVantageCounter = 0;
    function createLobbyVantageId() {
        _lobbyVantageCounter++;
        return 'vantage_' + _lobbyVantageCounter;
    }

    function getLobbyVantageDisplayName(instanceId) {
        if (typeof Users === 'undefined' || !Users.lobbyAIUsers) {
            return 'Vantage 1';
        }
        var lobbyIds = Object.keys(Users.lobbyAIUsers);
        var i;
        for (i = 0; i < lobbyIds.length; i++) {
            if (lobbyIds[i] === instanceId) {
                return 'Vantage ' + (i + 1);
            }
        }
        return 'Vantage ' + (lobbyIds.length + 1);
    }

    function makeLobbyVantagePlayerDetails(instanceId) {
        var template = AI_PLAYER_DETAILS['vantage_template'];
        var details = JSON.parse(JSON.stringify(template));
        details.playerId = instanceId;
        details.username = getLobbyVantageDisplayName(instanceId);
        details.turretAccessory = '0';
        details.barrelAccessory = '0';
        details.frontAccessory = '0';
        details.backAccessory = '0';
        details.treadAccessory = '0';
        details.backgroundAccessory = '0';
        details.badge = '0';
        return details;
    }

    function addLobbyVantagePlayer() {
        ensureAIsReady();
        if (typeof AIs === 'undefined' || !AIs.isReady || !AIs.isReady()) {
            if (typeof TankTrouble !== 'undefined' && TankTrouble.ErrorBox) {
                TankTrouble.ErrorBox.show('AI data is still loading. Please try again in a moment.');
            }
            return false;
        }
        if (!canAddMoreLobbyTanks()) {
            if (TankTrouble.ErrorBox) {
                TankTrouble.ErrorBox.show('Cannot add more tanks (limit: ' +
                    getLocalMaxTanks() + ').');
            }
            return false;
        }
        var aiId = createLobbyVantageId();
        if (!aiId) return false;
        if (typeof Users.addLobbyAIUser === 'function') {
            Users.addLobbyAIUser(aiId, true); // 第二个参数表示是Vantage
            return true;
        }
        return false;
    }

    function addLobbyAIPlayer() {
        ensureAIsReady();
        if (typeof AIs === 'undefined' || !AIs.isReady || !AIs.isReady()) {
            if (typeof TankTrouble !== 'undefined' && TankTrouble.ErrorBox) {
                TankTrouble.ErrorBox.show('AI data is still loading. Please try again in a moment.');
            }
            return false;
        }
        if (!canAddMoreLobbyTanks()) {
            if (TankTrouble.ErrorBox) {
                TankTrouble.ErrorBox.show('Cannot add more tanks (limit: ' +
                    getLocalMaxTanks() + ').');
            }
            return false;
        }
        var aiId = getNextLobbyAIId();
        if (!aiId) return false;
        if (typeof Users.addLobbyAIUser === 'function') {
            Users.addLobbyAIUser(aiId);
            return true;
        }
        return false;
    }

    function patchUsersForLobbyAI() {
        if (typeof Users === 'undefined' || Users._lobbyAIPatched) return true;
        Users._lobbyAIPatched = true;
        Users.lobbyAIUsers = Users.lobbyAIUsers || {};
        cleanupLegacyLobbyTemplateAI();

        var origGetAll = Users.getAllPlayerIds;
        Users.getAllPlayerIds = function() {
            var ids = origGetAll.call(Users);
            var lobbyIds = Object.keys(Users.lobbyAIUsers);
            var i;
            for (i = 0; i < lobbyIds.length; i++) {
                if (ids.indexOf(lobbyIds[i]) < 0) {
                    ids.push(lobbyIds[i]);
                }
            }
            return ids;
        };

        Users.addLobbyAIUser = function(aiId, isVantage) {
            if (!aiId || Users.lobbyAIUsers[aiId]) return false;
            if (aiId === LAIKA_TEMPLATE_ID) {
                aiId = createLobbyLaikaId();
            }
            if (!canAddMoreLobbyTanks()) {
                return false;
            }
            registerLobbyAIInstance(aiId);
            Users.lobbyAIUsers[aiId] = { templateId: LAIKA_TEMPLATE_ID, isVantage: !!isVantage };
            Users._notifyEventListeners(Users.EVENTS.GUEST_ADDED, aiId);
            setTimeout(function() { refreshLobbyAIAvatarInPanel(aiId); }, 0);
            return true;
        };

        Users.removeLobbyAIUser = function(aiId) {
            if (!Users.lobbyAIUsers[aiId]) return false;
            delete Users.lobbyAIUsers[aiId];
            if (typeof AIs !== 'undefined' && AIs.ais && aiId !== LAIKA_TEMPLATE_ID) {
                delete AIs.ais[aiId];
            }
            Users._notifyEventListeners(Users.EVENTS.GUEST_REMOVED, aiId);
            return true;
        };

        Users.isLobbyAIUser = function(aiId) {
            return !!Users.lobbyAIUsers[aiId];
        };

        var origIsAnyUser = Users.isAnyUser;
        Users.isAnyUser = function(playerId) {
            if (Users.isLobbyAIUser(playerId)) return true;
            return origIsAnyUser.call(Users, playerId);
        };

        Users.addEventListener(function(ctxt, evt, data) {
            if (evt === Users.EVENTS.GUEST_ADDED && Users.isLobbyAIUser(data)) {
                registerLobbyAIInstance(data);
                var gc = getActiveLocalGameController();
                if (gc) {
                    attachAIManagerDirect(gc, data);
                    if (gc.model) {
                        var qp = gc.model.queuedPlayers || {};
                        var ap = gc.model.activePlayers || {};
                        if (!qp[data] && !ap[data]) {
                            gc.addPlayer(data);
                        }
                    }
                    if (gc.localPlayerIds && gc.localPlayerIds.indexOf(data) < 0) {
                        gc.localPlayerIds.push(data);
                    }
                    if (gc.roundController && gc.roundController.localPlayerIds &&
                        gc.roundController.localPlayerIds.indexOf(data) < 0) {
                        gc.roundController.localPlayerIds.push(data);
                    }
                    reviveAllAIManagersForGame(gc);
                }
            } else if (evt === Users.EVENTS.GUESTS_ADDED && Array.isArray(data)) {
                var j;
                for (j = 0; j < data.length; j++) {
                    if (Users.isLobbyAIUser(data[j])) {
                        registerLobbyAIInstance(data[j]);
                    }
                }
            }
            if (evt === Users.EVENTS.GUEST_ADDED ||
                evt === Users.EVENTS.GUESTS_ADDED ||
                evt === Users.EVENTS.GUEST_REMOVED) {
                if (typeof UIPlayerPanel !== 'undefined' && UIPlayerPanel.phaserInstance &&
                    UIPlayerPanel.phaserInstance.state &&
                    UIPlayerPanel.phaserInstance.state.getCurrentState) {
                    var mainState = UIPlayerPanel.phaserInstance.state.getCurrentState();
                    if (mainState && mainState.scheduleUpdate) {
                        mainState.scheduleUpdate(true);
                    }
                }
            }
        }, null);

        return true;
    }

    function patchAIsForLobbyInstances() {
        if (typeof AIs === 'undefined' || AIs._lobbyInstancePatched) return true;
        if (!AIs.addAIManager || typeof AIManager === 'undefined' || !AIManager.create) {
            return false;
        }

        if (AIs.getAvailableAIId) {
            var origGetAvailableAIId = AIs.getAvailableAIId;
            AIs.getAvailableAIId = function(gameId, difficulty) {
                var id = origGetAvailableAIId.call(AIs, gameId, difficulty);
                if (!id || String(id).indexOf('laika_') === 0) {
                    if (AIs.ais[LAIKA_TEMPLATE_ID]) return LAIKA_TEMPLATE_ID;
                }
                return id;
            };
        }

        AIs.addAIManager = function(gameController, aiId) {
            return attachAIManagerDirect(gameController, aiId);
        };

        if (AIs.isAI && !AIs._lobbyIsAIPatched) {
            AIs._lobbyIsAIPatched = true;
            var origIsAI = AIs.isAI;
            AIs.isAI = function(aiId) {
                if (typeof Users !== 'undefined' && Users.isLobbyAIUser &&
                    Users.isLobbyAIUser(aiId)) {
                    return true;
                }
                return origIsAI.call(AIs, aiId);
            };
        }

        if (AIs.getAI && !AIs._lobbyGetAIPatched) {
            AIs._lobbyGetAIPatched = true;
            var origGetAI = AIs.getAI;
            AIs.getAI = function(aiId) {
                if (typeof Users !== 'undefined' && Users.isLobbyAIUser &&
                    Users.isLobbyAIUser(aiId)) {
                    registerLobbyAIInstance(aiId);
                }
                return origGetAI.call(AIs, aiId);
            };
        }

        if (AIs.removeAllAIManagers && !AIs._localRemoveAllPatched) {
            AIs._localRemoveAllPatched = true;
            var origRemoveAll = AIs.removeAllAIManagers;
            AIs.removeAllAIManagers = function() {
                while (AIs.aiManagers.length > 0) {
                    var mgr = AIs.aiManagers[0];
                    AIs.removeAIManager(mgr.getGameId(), mgr.getAIId());
                }
            };
        }

        if (AIs.reset && !AIs._localResetPatched) {
            AIs._localResetPatched = true;
            var origAIsReset = AIs.reset;
            AIs.reset = function() {
                origAIsReset.call(AIs);
                var gc = getActiveLocalGameController();
                if (gc) {
                    reviveAllAIManagersForGame(gc);
                }
            };
        }

        AIs._lobbyInstancePatched = true;
        return true;
    }

    function patchAIManagerForLocal() {
        if (typeof AIManager === 'undefined' || !AIManager.prototype ||
            AIManager.prototype._localDrivePatched) {
            return true;
        }
        var origUpdate = AIManager.prototype.update;
        AIManager.prototype.update = function(deltaTime) {
            if (typeof TankTroubleAITactics !== 'undefined' &&
                !TankTroubleAITactics.isInstalled()) {
                TankTroubleAITactics.install();
            }
            if (typeof GameManager !== 'undefined' && GameManager.getGameController) {
                var live = GameManager.getGameController();
                if (live) {
                    this.gameController = live;
                    if (this.ai) {
                        this.ai.gameController = live;
                    }
                }
            }
            origUpdate.call(this, deltaTime);
            if (typeof Constants === 'undefined' || !Constants.getMode ||
                Constants.getMode() !== Constants.MODE_CLIENT_LOCAL) {
                return;
            }
            var gc = this.gameController;
            var rc = gc && gc.roundController;
            if (!rc || !rc.model) {
                return;
            }
            if (typeof TankTroubleAITactics !== 'undefined' &&
                TankTroubleAITactics.isVizRoundActive) {
                if (!TankTroubleAITactics.isVizRoundActive(gc)) return;
            } else if (!rc.model.getStarted || !rc.model.getStarted()) {
                return;
            }
            if (!this.ai || !this.ai.getInputState) {
                return;
            }
            if (!gc.getTank || !gc.getTank(this.getAIId())) {
                return;
            }
            gc.setInputState(this.ai.getInputState());
        };
        AIManager.prototype._localDrivePatched = true;
        return true;
    }

    function patchGameManagerForLocalAI() {
        if (typeof GameManager === 'undefined' || !GameManager.setGameController ||
            GameManager._localAISetGCPatched) {
            return true;
        }
        var origSetGC = GameManager.setGameController;
        GameManager.setGameController = function(gameController) {
            origSetGC.call(GameManager, gameController);
            if (gameController && typeof Constants !== 'undefined' &&
                Constants.getMode &&
                Constants.getMode() === Constants.MODE_CLIENT_LOCAL) {
                scheduleAISyncForGame(gameController);
            }
        };
        GameManager._localAISetGCPatched = true;
        return true;
    }

    function patchUIGameStateForAI() {
        if (typeof Game === 'undefined' || !Game.UIGameState ||
            Game.UIGameState._localAISyncPatched) {
            return true;
        }
        var proto = Game.UIGameState.prototype;
        if (!proto || !proto.init || !proto._roundEventHandler) return false;

        var origInit = proto.init;
        proto.init = function(gameController) {
            origInit.call(this, gameController);
            scheduleAISyncForGame(gameController);
        };

        var origRound = proto._roundEventHandler;
        proto._roundEventHandler = function(self, id, evt, data) {
            origRound.call(this, self, id, evt, data);
            if (typeof RoundModel !== 'undefined' && self && self.gameController) {
                if (evt === RoundModel._EVENTS.ROUND_STARTED) {
                    reviveAllAIManagersForGame(self.gameController);
                } else if (evt === RoundModel._EVENTS.ROUND_CREATED) {
                    attachAIManagersForGame(self.gameController);
                }
            }
        };

        Game.UIGameState._localAISyncPatched = true;
        return true;
    }

    function patchTankInfoBoxForLobbyAI() {
        if (typeof TankTrouble === 'undefined' || !TankTrouble.TankInfoBox) return false;
        var box = TankTrouble.TankInfoBox;
        if (box._lobbyAIPatched) return true;

        var origShowButtons = box._showRelevantButtonsAndInfo;
        box._showRelevantButtonsAndInfo = function() {
            var isLobbyAI = typeof Users !== 'undefined' && Users.isLobbyAIUser &&
                Users.isLobbyAIUser(this.playerId);
            if (isLobbyAI) {
                var self = this;
                this.infoGoldAndDiamondTableRow.show();
                this.infoDiamondSvg.clear();
                this.infoGoldSvg.clear();
                this.info.addClass('localPlayer');
                this.infoLogOut.off('mouseup').on('mouseup', function(event) {
                    if (self.showing && !$(this).hasClass('disabled')) {
                        self.hide();
                        Users.removeLobbyAIUser(self.playerId);
                    }
                }).show();
                this._updateLogInAndOutStatus();
                return;
            }
            origShowButtons.call(this);
            if (typeof Users !== 'undefined' && Users.isGuestUser &&
                Users.isGuestUser(this.playerId)) {
                var guestSelf = this;
                this.infoLogOut.off('mouseup').on('mouseup', function(event) {
                    if (guestSelf.showing && !$(this).hasClass('disabled')) {
                        guestSelf.hide();
                        Users.removeGuestUser(guestSelf.playerId);
                    }
                }).show();
                this.infoLogOut.removeClass('disabled');
                this.infoLogOut.tooltipster('content', 'Remove this guest from the lobby');
                this.infoLogOut.tooltipster('option', 'theme', 'tooltipster-default');
            }
        };

        var origLogInOut = box._updateLogInAndOutStatus;
        box._updateLogInAndOutStatus = function() {
            if (typeof Users !== 'undefined' && Users.isLobbyAIUser &&
                Users.isLobbyAIUser(this.playerId)) {
                this.infoLogOut.removeClass('disabled');
                this.infoLogOut.tooltipster('content', 'Remove this AI opponent from the lobby');
                this.infoLogOut.tooltipster('option', 'theme', 'tooltipster-default');
                return;
            }
            if (typeof Users !== 'undefined' && Users.isGuestUser &&
                Users.isGuestUser(this.playerId)) {
                this.infoLogOut.removeClass('disabled');
                this.infoLogOut.tooltipster('content', 'Remove this guest from the lobby');
                this.infoLogOut.tooltipster('option', 'theme', 'tooltipster-default');
                return;
            }
            origLogInOut.call(this);
        };

        box._lobbyAIPatched = true;
        return true;
    }

    function patchUITankAvatarForLobbyAI() {
        if (typeof UITankAvatarGroup === 'undefined' ||
            UITankAvatarGroup.prototype._lobbyAvatarPatched) {
            return true;
        }

        var origSpawn = UITankAvatarGroup.prototype.spawn;
        UITankAvatarGroup.prototype.spawn = function(x, y, playerId, animate, targetScale) {
            if (typeof Users !== 'undefined' && Users.isLobbyAIUser &&
                Users.isLobbyAIUser(playerId)) {
                ensureAIsReady();
                registerLobbyAIInstance(playerId);
            }
            try {
                origSpawn.call(this, x, y, playerId, animate, targetScale);
            } catch (spawnErr) {
                console.warn('[Vantage] UITankAvatarGroup.spawn 回退:', spawnErr);
            }
            if (typeof Users !== 'undefined' && Users.isLobbyAIUser &&
                Users.isLobbyAIUser(playerId)) {
                ensureLobbyLaikaSpineAvatar(this, playerId, targetScale);
            }
        };

        var origRefresh = UITankAvatarGroup.prototype.refresh;
        if (origRefresh) {
            UITankAvatarGroup.prototype.refresh = function(x, y, targetScale) {
                origRefresh.call(this, x, y, targetScale);
                if (typeof Users !== 'undefined' && Users.isLobbyAIUser &&
                    Users.isLobbyAIUser(this.playerId)) {
                    ensureLobbyLaikaSpineAvatar(this, this.playerId, targetScale);
                }
            };
        }

        UITankAvatarGroup.prototype._lobbyAvatarPatched = true;
        return true;
    }

    function patchUITankIconSafeDraw() {
        if (typeof UITankIcon === 'undefined' || UITankIcon._safeDrawPatched) return true;
        if (!UITankIcon.drawTankIcon) return false;

        var origDraw = UITankIcon.drawTankIcon;
        UITankIcon.drawTankIcon = function(canvas) {
            var i;
            for (i = 3; i < arguments.length; i++) {
                var img = arguments[i];
                if (img && img instanceof HTMLImageElement && !img.complete) {
                    return;
                }
                if (img && !(img instanceof HTMLImageElement) &&
                    !(img instanceof HTMLCanvasElement) &&
                    !(img instanceof HTMLVideoElement)) {
                    return;
                }
            }
            try {
                return origDraw.apply(UITankIcon, arguments);
            } catch (e) {
                console.warn('[Local Patch] drawTankIcon 跳过无效贴图:', e);
            }
        };
        UITankIcon._safeDrawPatched = true;
        return true;
    }

    function patchGameControllerForLobbyAI() {
        if (typeof GameController === 'undefined' || !GameController.prototype ||
            GameController.prototype._lobbyAIPatched) {
            return true;
        }
        if (!GameController.prototype.addPlayer) return false;

        var origAddPlayer = GameController.prototype.addPlayer;
        if (!GameController.prototype._localAddPlayerPatched) {
            GameController.prototype.addPlayer = function(playerId) {
                if (typeof Constants !== 'undefined' && Constants.getMode &&
                    Constants.getMode() === Constants.MODE_CLIENT_LOCAL &&
                    isLobbyAIPlayer(playerId)) {
                    attachAIManagerDirect(this, playerId);
                }
                return origAddPlayer.call(this, playerId);
            };
            GameController.prototype._localAddPlayerPatched = true;
        }

        var origInitializeRound = GameController.prototype._initializeRound;
        if (origInitializeRound && !GameController.prototype._localInitRoundPatched) {
            GameController.prototype._initializeRound = function() {
                origInitializeRound.call(this);
                if (typeof Constants !== 'undefined' && Constants.getMode &&
                    Constants.getMode() === Constants.MODE_CLIENT_LOCAL) {
                    reviveAllAIManagersForGame(this);
                }
            };
            GameController.prototype._localInitRoundPatched = true;
        }

        var origCreateRound = GameController.prototype._createRoundController;
        if (origCreateRound) {
            GameController.prototype._createRoundController = function() {
                if (this.localPlayerIds && this.localPlayerIds.length === 0 &&
                    typeof Users !== 'undefined' && Users.getAllPlayerIds) {
                    this.localPlayerIds = Users.getAllPlayerIds().slice();
                }
                origCreateRound.call(this);
                if (this.roundController && this.localPlayerIds) {
                    this.roundController.localPlayerIds = this.localPlayerIds.slice();
                }
            };
        }

        GameController.prototype._lobbyAIPatched = true;
        return true;
    }

    function patchInputsForLobbyAI() {
        if (typeof Inputs === 'undefined' || Inputs._lobbyAIPatched) return true;
        if (!Inputs._authenticationEventHandler) return false;

        if (Inputs.loadInputSetAssignments && !Inputs._lobbyLoadInputPatched) {
            Inputs._lobbyLoadInputPatched = true;
            var origLoadInputs = Inputs.loadInputSetAssignments;
            Inputs.loadInputSetAssignments = function(playerIds) {
                var filtered = playerIds;
                if (typeof Users !== 'undefined' && Users.isLobbyAIUser && Array.isArray(playerIds)) {
                    filtered = [];
                    var fi;
                    for (fi = 0; fi < playerIds.length; fi++) {
                        if (!Users.isLobbyAIUser(playerIds[fi])) {
                            filtered.push(playerIds[fi]);
                        }
                    }
                }
                return origLoadInputs.call(Inputs, filtered);
            };
        }

        var origHandler = Inputs._authenticationEventHandler;
        Inputs._authenticationEventHandler = function(self, evt, data) {
            if (typeof Users !== 'undefined' && Users.isLobbyAIUser) {
                if (evt === Users.EVENTS.GUEST_ADDED && Users.isLobbyAIUser(data)) {
                    return;
                }
                if (evt === Users.EVENTS.GUESTS_ADDED && Array.isArray(data)) {
                    var onlyLobbyAI = data.length > 0;
                    var i;
                    for (i = 0; i < data.length; i++) {
                        if (!Users.isLobbyAIUser(data[i])) {
                            onlyLobbyAI = false;
                            break;
                        }
                    }
                    if (onlyLobbyAI) return;
                }
            }
            origHandler.call(Inputs, self, evt, data);
        };
        Inputs._lobbyAIPatched = true;
        return true;
    }

    function patchTrainingLobby() {
        if (typeof TankTroubleTrainingMode === 'undefined' ||
            !TankTroubleTrainingMode.setupLobbyHooks) {
            return false;
        }
        return TankTroubleTrainingMode.setupLobbyHooks();
    }

    function patchCreateLocalGame() {
        if (typeof Game === 'undefined' || !Game.UILobbyState) return false;
        var proto = Game.UILobbyState.prototype;
        if (!proto || !proto.createLocalGame || proto._localGamePatched) return true;

        proto.createLocalGame = function() {
            ensureAIsReady();
            ensureAllLobbyAIsRegistered();
            cleanupLegacyLobbyTemplateAI();

            var playerIds = Users.getAllPlayerIds();
            var humanIds = [];
            var lobbyAiIds = [];
            var i, pid;
            for (i = 0; i < playerIds.length; ++i) {
                pid = playerIds[i];
                if (isLobbyAIPlayer(pid)) {
                    lobbyAiIds.push(pid);
                } else {
                    humanIds.push(pid);
                }
            }

            var expectedTanks = humanIds.length + lobbyAiIds.length;
            if (humanIds.length <= 1 && lobbyAiIds.length === 0) {
                expectedTanks += 1;
            }
            if (expectedTanks < 2) {
                if (typeof TankTrouble !== 'undefined' && TankTrouble.ErrorBox) {
                    TankTrouble.ErrorBox.show(
                        'Need at least 2 tanks to start. Add another AI (no guest required).'
                    );
                }
                return;
            }

            if (typeof AIs !== 'undefined' && AIs.removeAllAIManagers) {
                AIs.removeAllAIManagers();
            }
            this.joiningGame = true;
            this._updateGameButtons();
            Constants.setMode(Constants.MODE_CLIENT_LOCAL);
            var ttGame = GameController.create(
                BootCampGameMode.create(), false, false, false,
                getLocalMaxTanks(),
                Constants.GAME_MODE_INFO[Constants.GAME_MODES.BOOT_CAMP].DEFAULT_AVAILABLE_CRATES,
                false, Constants.MAZE_THEMES.RANDOM
            );
            ttGame.localPlayerIds = playerIds.slice();
            for (i = 0; i < humanIds.length; ++i) {
                ttGame.addPlayer(humanIds[i]);
            }
            for (i = 0; i < lobbyAiIds.length; ++i) {
                pid = lobbyAiIds[i];
                registerLobbyAIInstance(pid);
                attachAIManagerDirect(ttGame, pid);
                ttGame.addPlayer(pid);
            }
            // 仅当大厅里只有 1 名人类且没有手动 Add AI 时，才走原版单人自动 Laika（6148530）
            if (humanIds.length <= 1 && lobbyAiIds.length === 0) {
                if (AIs.ais[LAIKA_TEMPLATE_ID]) {
                    attachAIManagerDirect(ttGame, LAIKA_TEMPLATE_ID);
                    ttGame.addPlayer(LAIKA_TEMPLATE_ID);
                    if (ttGame.localPlayerIds.indexOf(LAIKA_TEMPLATE_ID) < 0) {
                        ttGame.localPlayerIds.push(LAIKA_TEMPLATE_ID);
                    }
                }
            }
            reviveAllAIManagersForGame(ttGame);
            if (ttGame.roundController) {
                ttGame.roundController.localPlayerIds = ttGame.localPlayerIds.slice();
            }
            this.state.start('Game', true, false, ttGame);
            scheduleAISyncForGame(ttGame);
        };
        proto._localGamePatched = true;
        return true;
    }

    function patchStayInLobby() {
        if (typeof Game === 'undefined') return false;

        if (Game.UIPreloadState && Game.UIPreloadState.prototype &&
            !Game.UIPreloadState._localStayLobbyPatched) {
            var preloadProto = Game.UIPreloadState.prototype;
            preloadProto.create = function() {
                if (typeof AudioManager !== 'undefined') {
                    this.game.sound.mute = !AudioManager.isSoundOn();
                    if (AudioManager.isSoundOn()) {
                        this.game.sound.volume = AudioManager.getSoundVolume();
                    }
                }
                this.state.start('Lobby');
                if (typeof TankTroubleTrainingMode !== 'undefined' &&
                    TankTroubleTrainingMode.scheduleAttachToActiveLobby) {
                    TankTroubleTrainingMode.scheduleAttachToActiveLobby();
                }
            };
            Game.UIPreloadState._localStayLobbyPatched = true;
        }

        if (Game.UIGameState && Game.UIGameState.prototype &&
            !Game.UIGameState._localStayLobbyPatched) {
            var gameProto = Game.UIGameState.prototype;
            if (gameProto._leaveState) {
                gameProto._leaveState = function() {
                    GameManager.setGameController(null);
                    this.state.start('Lobby');
                    if (typeof TankTroubleTrainingMode !== 'undefined' &&
                        TankTroubleTrainingMode.restoreLobbyUi) {
                        setTimeout(TankTroubleTrainingMode.restoreLobbyUi, 0);
                    }
                };
            }
            Game.UIGameState._localStayLobbyPatched = true;
        }

        return true;
    }

    function patchPlayerPanelAuth() {
        return true;
    }

    function patchAddUserBox() {
        if (typeof TankTrouble === 'undefined' || !TankTrouble.AddUserBox) return false;
        var box = TankTrouble.AddUserBox;
        if (box._localPatched) return true;

        var origInit = box._initialize;
        box._initialize = function() {
            origInit.call(this);
            if (this.addUserOtherDiv) this.addUserOtherDiv.hide();
            injectAddUserAIButton(this);
        };
        box._localPatched = true;
        if (box.initialized) {
            injectAddUserAIButton(box);
        }
        return true;
    }

    function injectAddUserAIButton(box) {
        if (!box || box.addUserAI || typeof Utils === 'undefined' || !box.addUserGuest) return;
        box.addUserGuest.css({
            width: '94px',
            display: 'inline-block',
            marginRight: '10px'
        });
        box.addUserAI = Utils.createFixedWidthButton('Add AI', 'medium', 94);
        box.addUserAI.css({ display: 'inline-block' });
        box.addUserGuest.after(box.addUserAI);
        box.addUserAI.click(function() {
            if (box.showing) {
                box.hide();
                addLobbyAIPlayer();
            }
        });

        // 添加Vantage按钮
        if (!box.addUserVantage) {
            box.addUserVantage = Utils.createFixedWidthButton('Add Vantage', 'medium', 120);
            box.addUserVantage.css({ display: 'inline-block', marginLeft: '10px' });
            box.addUserAI.after(box.addUserVantage);
            box.addUserVantage.click(function() {
                if (box.showing) {
                    box.hide();
                    addLobbyVantagePlayer();
                }
            });
        }
    }

    function patchUtilsImages() {
        if (typeof Utils === 'undefined' || !Utils.addImageWithClasses || Utils._localImagePatched) return;
        Utils._localImagePatched = true;
        var orig = Utils.addImageWithClasses;
        Utils.addImageWithClasses = function(container, classes, src) {
            var image = $('<img class=\'' + classes + '\'/>');
            image.attr('src', g_url(src));
            if (src.substring(src.length - 4) === '.png') {
                image.attr('srcset', g_url(src.substring(0, src.length - 4) + '@2x.png') + ' 2x');
                image.on('error', function() {
                    if (this.src.indexOf('@2x') >= 0) {
                        this.removeAttribute('srcset');
                        this.src = g_url(src);
                    }
                });
            }
            container.append(image);
            return container;
        };
    }

    function debugAIState() {
        var gc = typeof GameManager !== 'undefined' && GameManager.getGameController
            ? GameManager.getGameController() : null;
        if (gc) {
            reviveAllAIManagersForGame(gc);
        }
        var lobbyIds = typeof Users !== 'undefined' && Users.lobbyAIUsers
            ? Object.keys(Users.lobbyAIUsers) : [];
        var managers = typeof AIs !== 'undefined' && AIs.aiManagers ? AIs.aiManagers : [];
        var rows = [];
        var i, pid, mgr, tank;
        for (i = 0; i < lobbyIds.length; i++) {
            pid = lobbyIds[i];
            mgr = gc ? findAIManagerFor(gc.getId(), pid) : null;
            tank = gc && gc.getTank ? gc.getTank(pid) : null;
            rows.push({
                aiId: pid,
                hasConfig: !!(AIs && AIs.ais && AIs.ais[pid]),
                hasManager: !!mgr,
                hasTank: !!tank,
                roundStarted: !!(gc && gc.roundController && gc.roundController.model &&
                    gc.roundController.model.getStarted && gc.roundController.model.getStarted())
            });
        }
        console.table(rows);
        console.log('[Local Patch] AIManager 总数:', managers.length, 'GameController:', gc && gc.getId());
        if (typeof TankTroubleAITactics !== 'undefined' && TankTroubleAITactics.verify) {
            var v = TankTroubleAITactics.verify();
            console.log('[Local Patch] 战术补丁自检:', v.ok ? '通过 v' + v.version : '失败', v.issues || []);
        }
        return rows;
    }

    var _mapFullscreen = false;
    var _fullscreenStyleEl = null;
    var _fullscreenBtn = null;
    var _fullscreenListenersBound = false;

    function isMapFullscreen() {
        return _mapFullscreen || !!document.fullscreenElement;
    }

    function updateFullscreenButtonLabel() {
        if (!_fullscreenBtn) return;
        var on = isMapFullscreen();
        _fullscreenBtn.textContent = on ? '退出全屏' : '全屏';
        _fullscreenBtn.title = on ? '退出全屏 (Esc)' : '全屏显示地图';
        _fullscreenBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    function getGameContainerSize() {
        // 全屏时直接用窗口尺寸，不依赖容器布局
        if (isMapFullscreen()) {
            return { width: window.innerWidth, height: window.innerHeight };
        }
        var el = document.getElementById('game');
        if (!el) {
            return { width: window.innerWidth, height: window.innerHeight };
        }
        var w = el.clientWidth;
        var h = el.clientHeight;
        if (w <= 0) w = window.innerWidth;
        if (h <= 0) h = window.innerHeight;
        return { width: w, height: h };
    }

    function syncPhaserCanvasToGameContainer(game) {
        if (!game || !game.scale) return false;

        var size = getGameContainerSize();
        var pr = (game.device && game.device.pixelRatio > 1) ? game.device.pixelRatio : 1;

        if (typeof Phaser !== 'undefined' &&
            game.scale.scaleMode === Phaser.ScaleManager.USER_SCALE && pr > 1) {
            var targetW = Math.round(size.width * pr);
            var targetH = Math.round(size.height * pr);
            game.scale.setGameSize(targetW, targetH);
            game.scale.setUserScale(1 / pr, 1 / pr, 0, 0);
        } else {
            game.scale.setGameSize(Math.round(size.width), Math.round(size.height));
        }

        if (game.world && game.world.setBounds) {
            game.world.setBounds(0, 0, game.width, game.height);
        }
        if (game.camera) {
            game.camera.setBoundsToWorld();
            game.camera.view.x = 0;
            game.camera.view.y = 0;
        }
        return true;
    }

    function triggerActiveGameRelayout() {
        var game = typeof GameManager !== 'undefined' && GameManager.getGame
            ? GameManager.getGame() : null;
        if (!game || !game.state || game.state.current !== 'Game') {
            return;
        }
        var state = game.state.getCurrentState();
        if (state && typeof state._onSizeChangeHandler === 'function') {
            state._onSizeChangeHandler();
        }
    }

    function refreshLayoutAfterFullscreen() {
        if (!isMapFullscreen()) {
            if (typeof ResizeManager !== 'undefined' && ResizeManager.refresh) {
                ResizeManager.refresh();
            }
            return;
        }

        // 全屏时隐藏 PlayerPanel，#game 由 CSS position:fixed 铺满窗口
        $('#playerPanel').width(0).height(0);

        var game = typeof GameManager !== 'undefined' && GameManager.getGame
            ? GameManager.getGame() : null;
        if (!game) return;

        var attemptRelayout = function(tries) {
            requestAnimationFrame(function() {
                var w = window.innerWidth;
                var h = window.innerHeight;
                if ((w <= 0 || h <= 0) && tries < 8) {
                    attemptRelayout(tries + 1);
                    return;
                }
                // 用窗口尺寸更新 Phaser 游戏尺寸
                syncPhaserCanvasToGameContainer(game);
                if (game.scale && game.scale.refresh) {
                    game.scale.refresh();
                }
                triggerActiveGameRelayout();
            });
        };
        attemptRelayout(0);
    }

    function layoutMazeFullscreen(uiState) {
        if (!uiState || !uiState.gameGroup || !uiState.game) {
            return false;
        }

        var localBounds = uiState.gameGroup.getLocalBounds();
        if (!localBounds || localBounds.width <= 0 || localBounds.height <= 0) {
            return false;
        }

        var unscaledMazeWidth = localBounds.width;
        var unscaledMazeHeight = localBounds.height;
        var unscaledMazeOffsetX = -localBounds.x;
        var unscaledMazeOffsetY = -localBounds.y;

        var viewW = uiState.game.width;
        var viewH = uiState.game.height;

        var pad = 10;
        var gameScale = Math.min(
            (viewW - pad * 2) / unscaledMazeWidth,
            (viewH - pad * 2) / unscaledMazeHeight
        );
        gameScale = Math.floor(gameScale * 100.0) / 100.0;
        if (gameScale <= 0) {
            return false;
        }

        uiState.gameGroup.scale.set(gameScale, gameScale);
        uiState.gameGroup.position.set(
            Math.ceil((viewW - unscaledMazeWidth * gameScale) * 0.5 + unscaledMazeOffsetX * gameScale),
            Math.ceil((viewH - unscaledMazeHeight * gameScale) * 0.5 + unscaledMazeOffsetY * gameScale)
        );
        return true;
    }

    function repositionFullscreenHud(uiState) {
        // 在 USER_SCALE 模式下，game.width 是物理像素，HUD 坐标需要除以 pixelRatio
        var w = uiState.game.width;
        var h = uiState.game.height;
        var pr = (uiState.game.device && uiState.game.device.pixelRatio > 1)
            ? uiState.game.device.pixelRatio : 1;
        if (pr > 1 &&
            typeof Phaser !== 'undefined' &&
            uiState.game.scale.scaleMode === Phaser.ScaleManager.USER_SCALE) {
            w = w / pr;
            h = h / pr;
        }
        if (uiState.overtimeGroup) {
            uiState.overtimeGroup.position.x = w / 2.0;
        }
        if (uiState.counterTimerGroup) {
            uiState.counterTimerGroup.position.x = w / 2.0;
        }
        if (uiState.roundTitleGroup) {
            uiState.roundTitleGroup.position.set(
                w / 2.0,
                h / 2.0 + (typeof UIConstants !== 'undefined'
                    ? UIConstants.ROUND_TITLE_OFFSET : 0)
            );
        }
        if (uiState.countDownGroup) {
            uiState.countDownGroup.position.set(
                w / 2.0, h / 2.0
            );
        }
        if (uiState.leaveGameGroup) {
            uiState.leaveGameGroup.position.x = w -
                (typeof UIConstants !== 'undefined' ? UIConstants.LEAVE_GAME_MARGIN : 20);
        }
        if (uiState.waitingIconGroup) {
            uiState.waitingIconGroup.position.set(
                w / 2.0, h / 3.0
            );
        }
        if (uiState.celebrationTrophyGroup) {
            uiState.celebrationTrophyGroup.position.set(
                w / 2.0, h / 2.0
            );
        }
    }

    function setMapFullscreen(on) {
        _mapFullscreen = !!on;
        document.documentElement.classList.toggle('tt-map-fullscreen', _mapFullscreen);
        updateFullscreenButtonLabel();
        refreshLayoutAfterFullscreen();
    }

    function requestBrowserFullscreen() {
        var el = document.documentElement;
        var req = el.requestFullscreen || el.webkitRequestFullscreen ||
            el.mozRequestFullScreen || el.msRequestFullscreen;
        if (!req) return Promise.resolve();
        return Promise.resolve(req.call(el));
    }

    function exitBrowserFullscreen() {
        var exit = document.exitFullscreen || document.webkitExitFullscreen ||
            document.mozCancelFullScreen || document.msExitFullscreen;
        if (!exit || !document.fullscreenElement) return Promise.resolve();
        return Promise.resolve(exit.call(document));
    }

    function toggleMapFullscreen() {
        if (isMapFullscreen()) {
            exitBrowserFullscreen().finally(function() {
                setMapFullscreen(false);
            });
            return;
        }
        requestBrowserFullscreen().then(function() {
            setMapFullscreen(true);
        }).catch(function() {
            setMapFullscreen(true);
        });
    }

    function ensureFullscreenStyles() {
        if (_fullscreenStyleEl) return;
        _fullscreenStyleEl = document.createElement('style');
        _fullscreenStyleEl.textContent = [
            '#tt-map-fullscreen-btn {',
            '  position: fixed; top: 8px; left: 8px; z-index: 10050;',
            '  padding: 6px 12px; border: 1px solid rgba(255,255,255,0.35);',
            '  border-radius: 4px; background: rgba(20,30,50,0.82); color: #fff;',
            '  font: 13px/1.2 Arial,sans-serif; cursor: pointer;',
            '  box-shadow: 0 2px 8px rgba(0,0,0,0.35);',
            '}',
            '#tt-map-fullscreen-btn:hover { background: rgba(35,50,80,0.92); }',
            'html.tt-map-fullscreen, html.tt-map-fullscreen body {',
            '  overflow: hidden !important; margin: 0 !important; padding: 0 !important;',
            '  width: 100% !important; height: 100% !important;',
            '}',
            'html.tt-map-fullscreen #header,',
            'html.tt-map-fullscreen #playerPanel,',
            'html.tt-map-fullscreen #version { display: none !important; }',
            'html.tt-map-fullscreen #contentWrapper,',
            'html.tt-map-fullscreen #content,',
            'html.tt-map-fullscreen #mainContent {',
            '  width: 100% !important; max-width: none !important;',
            '  height: 100% !important;',
            '  margin: 0 !important; padding: 0 !important;',
            '}',
            'html.tt-map-fullscreen #game {',
            '  position: fixed !important; top: 0 !important; left: 0 !important;',
            '  width: 100vw !important; height: 100vh !important;',
            '  max-width: none !important; max-height: none !important;',
            '  z-index: 9999 !important;',
            '  box-sizing: border-box !important; overflow: hidden !important;',
            '  margin: 0 !important; padding: 0 !important;',
            '}',
            'html.tt-map-fullscreen #game canvas {',
            '  display: block !important;',
            '  width: 100vw !important; height: 100vh !important;',
            '}'
        ].join('\n');
        document.head.appendChild(_fullscreenStyleEl);
    }

    function installFullscreenButton() {
        ensureFullscreenStyles();
        if (_fullscreenBtn) return true;
        var gameEl = document.getElementById('game');
        if (!gameEl) return false;

        _fullscreenBtn = document.createElement('button');
        _fullscreenBtn.id = 'tt-map-fullscreen-btn';
        _fullscreenBtn.type = 'button';
        _fullscreenBtn.textContent = '全屏';
        _fullscreenBtn.title = '全屏显示地图';
        _fullscreenBtn.setAttribute('aria-pressed', 'false');
        _fullscreenBtn.addEventListener('click', function(event) {
            event.preventDefault();
            event.stopPropagation();
            toggleMapFullscreen();
        });
        document.body.appendChild(_fullscreenBtn);
        updateFullscreenButtonLabel();

        if (!_fullscreenListenersBound) {
            _fullscreenListenersBound = true;
            document.addEventListener('fullscreenchange', function() {
                var on = !!document.fullscreenElement;
                _mapFullscreen = on;
                document.documentElement.classList.toggle('tt-map-fullscreen', on);
                updateFullscreenButtonLabel();
                refreshLayoutAfterFullscreen();
            });
            window.addEventListener('resize', function() {
                if (isMapFullscreen()) refreshLayoutAfterFullscreen();
            });
        }
        return true;
    }

    function patchResizeManagerForFullscreen() {
        if (typeof ResizeManager === 'undefined' || !ResizeManager._updateSizes ||
            ResizeManager._localFullscreenPatched) {
            return true;
        }
        var origUpdateSizes = ResizeManager._updateSizes;
        ResizeManager._updateSizes = function() {
            if (isMapFullscreen()) {
                // 全屏时隐藏 PlayerPanel，不触发原始 resize 逻辑
                $('#playerPanel').width(0).height(0);
                return;
            }
            origUpdateSizes.call(ResizeManager);
        };
        ResizeManager._localFullscreenPatched = true;
        return true;
    }

    function patchGameManagerForFullscreen() {
        if (typeof GameManager === 'undefined' || !GameManager._resizeEventHandler ||
            GameManager._localFullscreenResizePatched) {
            return true;
        }
        var origResizeHandler = GameManager._resizeEventHandler;
        GameManager._resizeEventHandler = function(self, evt, data) {
            if (isMapFullscreen() && GameManager.phaserInstance) {
                syncPhaserCanvasToGameContainer(GameManager.phaserInstance);
            }
            origResizeHandler.call(GameManager, self, evt, data);
            if (isMapFullscreen()) {
                triggerActiveGameRelayout();
            }
        };
        GameManager._localFullscreenResizePatched = true;
        return true;
    }

    function patchUIGameStateForFullscreen() {
        if (typeof Game === 'undefined' || !Game.UIGameState ||
            Game.UIGameState._localFullscreenPatched) {
            return true;
        }
        var proto = Game.UIGameState.prototype;
        if (!proto || !proto._onSizeChangeHandler) return false;

        var origSizeChange = proto._onSizeChangeHandler;
        proto._onSizeChangeHandler = function() {
            // 先调用原始 handler，它会根据 game.width/height 正确计算缩放和位置
            origSizeChange.call(this);

            // 全屏时，将地图从顶部对齐改为垂直居中
            if (isMapFullscreen() && this.gameGroup) {
                var currentY = this.gameGroup.position.y;
                var scaledHeight = this.gameGroup.height;
                var viewH = this.game.height;
                // 原始 handler 用 MAZE_TOP_MARGIN 作为顶部偏移
                // 全屏时改为垂直居中
                var centeredY = Math.ceil((viewH - scaledHeight) * 0.5 +
                    (-this.gameGroup.getLocalBounds().y) * this.gameGroup.scale.y);
                if (Math.abs(centeredY - currentY) > 1) {
                    this.gameGroup.position.y = centeredY;
                }
            }
        };

        Game.UIGameState._localFullscreenPatched = true;
        return true;
    }

    /** v3：本地部署不需要 Cookie 同意提示条，直接禁用。 */
    function removeCookieConsent() {
        if (typeof TankTrouble !== 'undefined' && TankTrouble.CookieBox) {
            TankTrouble.CookieBox.checkForCookie = function() { return true; };
            TankTrouble.CookieBox.show = function() {};
        }
        var cookieEl = document.getElementById('cookie');
        if (cookieEl && cookieEl.parentNode) cookieEl.parentNode.removeChild(cookieEl);
    }

    function applyDeferredPatches() {
        removeCookieConsent();
        applyLocalLimits();
        applyAIStrengthConfig();
        patchUsersForLobbyAI();
        patchAIsForLobbyInstances();
        patchAIManagerForLocal();
        patchGameManagerForLocalAI();
        patchGameControllerForLobbyAI();
        patchUIGameStateForAI();
        patchResizeManagerForFullscreen();
        patchGameManagerForFullscreen();
        patchUIGameStateForFullscreen();
        installFullscreenButton();
        patchInputsForLobbyAI();
        patchAIsInit();
        patchCreateLocalGame();
        patchStayInLobby();
        patchPlayerPanelAuth();
        patchTankInfoBoxForLobbyAI();
        patchUITankAvatarForLobbyAI();
        patchUITankIconSafeDraw();
        patchAddUserBox();
        patchUtilsImages();
        if (typeof TankTroubleTrainingMode !== 'undefined') {
            try {
                TankTroubleTrainingMode.install();
            } catch (err) {
                console.error('[Local Patch] Training mode install failed:', err);
            }
            if (TankTroubleTrainingMode.hookGameManagerInsertGame) {
                TankTroubleTrainingMode.hookGameManagerInsertGame();
            }
            if (TankTroubleTrainingMode.ensureTrainingPatches) {
                TankTroubleTrainingMode.ensureTrainingPatches();
            }
        }
        patchTrainingLobby();
        if (typeof TankTroubleAITactics !== 'undefined') {
            if (TankTroubleAITactics.install()) {
                if (!window._aiTacticsInstallLogged) {
                    window._aiTacticsInstallLogged = true;
                    var v = (typeof AI !== 'undefined' && AI._tacticsVersion) || '?';
                    console.log('[Local Patch] AI tactics v' + v + ' active');
                }
            }
        }
        ensureAIsReady();
    }

    function scheduleDeferredPatches() {
        applyDeferredPatches();
        var tries = 0;
        var timer = setInterval(function() {
            applyDeferredPatches();
            tries++;
            if (tries >= 200) clearInterval(timer);
        }, 50);
    }

    (function tryPatchAjax() {
        if (!applyAjaxPatch()) {
            setTimeout(tryPatchAjax, 10);
        }
    })();

    window.TankTroubleLocalPatch = {
        get LOCAL_AIS() { return LOCAL_AIS; },
        buildLocalAIs: buildLocalAIs,
        applyAIStrengthConfig: applyAIStrengthConfig,
        buildMockData: buildMockData,
        makeGuestPlayerDetails: makeGuestPlayerDetails,
        ensureAIsReady: ensureAIsReady,
        reviveGameAI: function() {
            var gc = typeof GameManager !== 'undefined' && GameManager.getGameController
                ? GameManager.getGameController() : null;
            if (gc) reviveAllAIManagersForGame(gc);
        },
        addLobbyAIPlayer: addLobbyAIPlayer,
        addLobbyVantagePlayer: addLobbyVantagePlayer,
        getNextLobbyAIId: getNextLobbyAIId,
        applyAjaxPatch: applyAjaxPatch,
        applyDeferredPatches: applyDeferredPatches,
        scheduleDeferredPatches: scheduleDeferredPatches,
        debugAIState: debugAIState,
        isMapFullscreen: isMapFullscreen,
        toggleMapFullscreen: toggleMapFullscreen,
        setMapFullscreen: setMapFullscreen,
        // Vantage调试：在游戏区域内点击地面时调用
        setVantageDebugTarget: setVantageDebugTarget
    };

    /**
     * 屏幕点击 -> 迷宫格子。复用 training_mode.screenToMaze + Laika 的 floor(getX/MAZE_TILE_SIZE.m)。
     */
    function clientPointToMazeTile(evt) {
        if (typeof TankTroubleTrainingMode === 'undefined' ||
            !TankTroubleTrainingMode.screenToMaze ||
            !TankTroubleTrainingMode.getUIGameState ||
            typeof Constants === 'undefined' || !Constants.MAZE_TILE_SIZE) {
            return null;
        }
        var ui = TankTroubleTrainingMode.getUIGameState();
        if (!ui) {
            return null;
        }
        var gc = typeof GameManager !== 'undefined' ? GameManager.getGameController() : null;
        if (!gc || !gc.getMaze) {
            return null;
        }
        var maze = gc.getMaze();
        if (!maze) {
            return null;
        }
        var meters = TankTroubleTrainingMode.screenToMaze(ui, evt.clientX, evt.clientY);
        var tile = {
            x: Math.floor(meters.x / Constants.MAZE_TILE_SIZE.m),
            y: Math.floor(meters.y / Constants.MAZE_TILE_SIZE.m)
        };
        if (maze.isPositionInsideMaze(tile)) {
            return tile;
        }
        return null;
    }

    /** v4：点击地面只设置“树评分目标”，不再直接接管 AI 驾驶。
     *  树只在几个操作安全分完全相同时，用末端姿态与目标方向的接近程度做平局裁决。 */
    function setVantageMoveTarget(tileX, tileY) {
        if (typeof VantageTree !== 'undefined' && VantageTree.setMoveTarget) {
            VantageTree.setMoveTarget(tileX, tileY);
            // 清掉旧的“直接驾驶”调试目标，避免树和旧寻路同时抢输入。
            if (typeof AIs !== 'undefined' && AIs.aiManagers) {
                for (var i = 0; i < AIs.aiManagers.length; i++) {
                    var m = AIs.aiManagers[i];
                    if (m && m.isVantage && m.ai && typeof m.ai.clearDebugTarget === 'function') {
                        m.ai.clearDebugTarget();
                    }
                }
            }
            return true;
        }
        return setVantageDebugTarget(tileX, tileY);
    }

    /**
     * 给Vantage AI设置调试目标位置
     * @param {number} tileX 目标格子X
     * @param {number} tileY 目标格子Y
     */
    function setVantageDebugTarget(tileX, tileY) {
        if (typeof AIs === 'undefined' || !AIs.aiManagers) {
            console.warn('[Vantage] AIs未就绪');
            return false;
        }
        var found = false;
        for (var i = 0; i < AIs.aiManagers.length; i++) {
            var m = AIs.aiManagers[i];
            if (m && m.isVantage && m.ai && typeof m.ai.setDebugTarget === 'function') {
                m.ai.setDebugTarget(tileX, tileY);
                found = true;
            }
        }
        if (!found) {
            console.warn('[Vantage] 未找到Vantage AI实例');
        }
        return found;
    }

    // ==================== Vantage 调试：点击地面触发寻路 ====================
    (function attachVantageClickHandler() {
        if (typeof jQuery === 'undefined') {
            setTimeout(attachVantageClickHandler, 50);
            return;
        }
        // 等待Vantage实例出现
        var attachTries = 0;
        function tryAttach() {
            attachTries++;
            if (attachTries > 600) return; // 最多尝试30秒
            if (typeof AIs === 'undefined' || !AIs.aiManagers || AIs.aiManagers.length === 0) {
                setTimeout(tryAttach, 50);
                return;
            }
            var hasVantage = false;
            for (var i = 0; i < AIs.aiManagers.length; i++) {
                if (AIs.aiManagers[i] && AIs.aiManagers[i].isVantage) {
                    hasVantage = true;
                    break;
                }
            }
            if (!hasVantage) {
                setTimeout(tryAttach, 50);
                return;
            }
            // 找到游戏地图canvas
            var $canvas = jQuery('#phaserCanvasContainer canvas, canvas').first();
            if ($canvas.length === 0) {
                setTimeout(tryAttach, 200);
                return;
            }
            $canvas.off('click.vantage').on('click.vantage', function(evt) {
                var tile = clientPointToMazeTile(evt);
                if (tile) {
                    console.log('[Vantage] 点击地面 -> 目标 (' + tile.x + ',' + tile.y + ')，由树评分决定是否前往');
                    setVantageMoveTarget(tile.x, tile.y);
                } else {
                    console.warn('[Vantage] 点击位置不在迷宫内');
                }
            });
            console.log('[Vantage] 地面点击事件已绑定');
        }
        setTimeout(tryAttach, 200);
    })();
})();
