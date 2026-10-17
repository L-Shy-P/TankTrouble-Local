/**
 * Vantage · T 面板「智能体模式」扩展（2026-10-17）
 * ==========================================================================
 * 主人原话：「游戏里有完整的 T 键 Vantage 面板……选择智能体模式后，选择神经网络，
 *   然后就进入当前架构的配置页。可以调整作弊开关和学习开关等，环境不兼容 Vantage 时
 *   （比如 DM 模式）要及时提示。」
 *
 * 本文件【只扩展、不重写】既有的 T 面板（`vantage_testbench.js:2250` 的 `#vt-bench-panel`、
 * `:2316-2331` 的「AI 操控」区、`:4190` 的 T 键绑定）。
 *
 * ⛔ 不另写一套决策桥：树的交互全部复用 `_tools/headless/inject_fire.js`（经服务器
 *    `/vt_inject_fire.js` 原样下发）——
 *     · `window.__b.step(nodeId, fire)`：读观测 + 记下"沿树的 slot 路径 + 是否开火"
 *     · `window.__b.build()`：决策当帧沿当前树按 slot 路径重走取新鲜节点 id，拼 picks
 *     · `window.__b.setFireBack('now')`：picks[1] 的 back = L−1−rel（当帧开火口径）
 * ⛔ 不另写一套推理：观测 JSON 原样 POST 到 `/vt_policy`（`game_core/server.py` 的桥），
 *    由 `_tools/training/policy_server_graph.py` 一问一答（VT_CKPT 权重）。
 *
 * 兼容性（⛔ 静默降级）：见 `compatCheck()`；不兼容时【红字 + 拒绝切换】并把下拉退回规则版。
 */
(function (global) {
    'use strict';

    var VERSION = '1.1.0-20261017';
    var SECTION_ID = 'vt-agent-rows';
    var LAIKA_TEMPLATE_ID = '6148530';

    // ⭐ 配置三开关的唯一落点（父代理 2026-10-17 裁定：面板只写这三个布尔，⛔ 不调服务端）
    //    cheat = 观测是否含作弊项 · learn = 是否记录训练样本 · mem = 记忆（2 token × 256 维 × A/B 两份）
    var CFG = global.__vtConfig = global.__vtConfig || { cheat: true, learn: false, mem: true };
    if (typeof CFG.cheat !== 'boolean') CFG.cheat = true;
    if (typeof CFG.learn !== 'boolean') CFG.learn = false;
    if (typeof CFG.mem !== 'boolean') CFG.mem = true;

    var S = {
        mounted: false,
        mode: 'rule',              // 'rule' | 'nn'
        on: false,
        tankId: null,
        gameMode: null,
        ckpt: null,
        cheat: CFG.cheat,            // 作弊开关：观测是否含作弊项（opp/col/mine）
        learn: CFG.learn,            // 学习开关：逐帧把 (obs, act, lp, v) 落盘供训练器离线学习
        mem: CFG.mem,                // 记忆开关：2 token × 256 维 × A/B 两份（只写 __vtConfig，不调服务端）
        lastRecordedTick: -1, lastRecordedSkipped: '',
        lastFireSubmits: 0, lastFireNoCursor: 0, lastFireSkippedRetry: 0, lastPulseBlocked: 0, lastEmptyBlocked: 0,
        // —— 决策管线 ——
        seq: 0, ticks: 0, inflight: 0,
        prevNodeId: 0, prevFire: 0,
        served: 0, servedTotal: 0, activations: 0, errCount: 0, emptyTree: 0, skipInflight: 0,
        lat: [], errLog: [], fireStat: { n: 0, fire1: 0, fire0: 0 },
        lastResp: null, lastErr: null, lastN: 0, lastCtxTime: null, lastObs: null,
        fireDropped: 0, skipReasons: {}, lastSkipped: '', nodeRemap: 0, lastGoodSlots: null,
        pendingPayload: null,
        learnBuf: [], learnSaved: 0, learnLines: 0, learnBytes: 0,
        hist: [], histMax: 20000, lastTankPos: null, lastFrameEntry: null,
        session: null, server: null, compat: null,
        bridgeReady: false, lastStatusAt: 0, lastRetryAt: 0, awaitNN: false, lastRoundState: null, roundSeq: 0
    };

    function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
    function $(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }
    function txt(id) { var el = document.getElementById(id); return el ? el.textContent : ''; }
    function log() {
        var a = Array.prototype.slice.call(arguments);
        a.unshift('[VantageAgentPanel]');
        try { console.log.apply(console, a); } catch (e) {}
    }

    function setStatus(text, level) {
        var el = document.getElementById('vt-agent-status');
        if (!el) return;
        el.textContent = text;
        el.style.color = level === 'bad' ? '#f38ba8' : (level === 'warn' ? '#f9e2af' : (level === 'ok' ? '#a6e3a1' : '#6c7086'));
        if (level === 'bad') log('⛔ ' + text); else log(text);
    }

    // ============================================================
    // 一、环境兼容检测（⛔ 不静默：不兼容就拒绝切换 + 红字）
    // ============================================================
    function gameStateName() {
        try { return GameManager.getGame().state.current; } catch (e) { return '?'; }
    }
    function currentGc() {
        try { return (typeof GameManager !== 'undefined' && GameManager.getGameController) ? GameManager.getGameController() : null; } catch (e) { return null; }
    }

    function compatCheck() {
        var hard = [], soft = [], warns = [], info = {};
        if (typeof VantageTree === 'undefined') hard.push('VantageTree 未加载');
        if (typeof VantageTreeInterface === 'undefined') hard.push('VantageTreeInterface 未加载');
        if (typeof VantageObserve === 'undefined') hard.push('VantageObserve（观测编码器）未加载');
        if (typeof VantageSandbox === 'undefined') hard.push('VantageSandbox 未加载');

        var gs = gameStateName();
        info.gameState = gs;
        if (gs !== 'Game') hard.push('不在对局里（当前状态 ' + gs + '）—— 请先在大厅开 Local game');

        var gc = currentGc();
        if (!gc) {
            hard.push('没有 GameController');
        } else {
            var mode = null;
            try { mode = gc.getMode ? gc.getMode() : (gc.gameMode ? gc.gameMode.mode : null); } catch (eMode) {}
            info.mode = mode;
            S.gameMode = mode;
            if (typeof Constants !== 'undefined' && Constants.GAME_MODES) {
                var GM = Constants.GAME_MODES;
                if (mode === GM.DEATHMATCH) {
                    hard.push('DM（Deathmatch）不兼容：Vantage 的树/观测/奖励是 BOOT_CAMP 单回合口径' +
                        '（DeathmatchGameMode 有复活、倒计时、毒雾 overtime —— game_modes_decoded.js: DeathmatchGameMode）');
                } else if (mode === GM.TEAM_DEATHMATCH) {
                    hard.push('团队死斗（TEAM_DEATHMATCH）不兼容：同 DM，复活/计分口径不同');
                } else if (mode === GM.CLASSIC) {
                    warns.push('经典模式：本地默认 storm=false，且毒雾「何时出现」未实现（vantage_observe.js:592）⟹ 风暴雨口径可能不对');
                }
            }
            var tanks = {};
            try { tanks = gc.getTanks ? gc.getTanks() : {}; } catch (eT) {}
            var vids = [];
            for (var id in tanks) if (id.indexOf('vantage_') === 0) vids.push(id);
            info.vantageTanks = vids;
            if (!vids.length) {
                // ⭐ 软原因：Vantage 可能只是这一回合阵亡了（BOOT_CAMP 会开下一回合）⟹ 暂停并自动等它回来，
                //    ⛔ 不是"环境不兼容"、也不静默退回规则版。
                soft.push('场上暂时没有 Vantage 坦克（若这一回合已阵亡，下一回合会自动继续；否则请在大厅点「Add Vantage」）');
            } else {
                S.tankId = S.tankId && vids.indexOf(S.tankId) >= 0 ? S.tankId : vids[0];
                info.tankId = S.tankId;
                try {
                    var ad = VantageSandbox.createAdapter(gc, S.tankId);
                    var ts = ad && ad.getTankState ? ad.getTankState() : null;
                    if (!ts) soft.push('观测源不可用：VantageSandbox.createAdapter(' + S.tankId + ').getTankState() 返回空');
                } catch (eAd) {
                    soft.push('观测源异常：' + String(eAd && eAd.message || eAd));
                }
            }
            var tree = null;
            try { tree = VantageTree.getTree ? VantageTree.getTree() : null; } catch (eTree) {}
            info.treeNodes = tree && typeof tree.nodeCount === 'number' ? tree.nodeCount : null;
            if (!tree) warns.push('树还没起来：第一帧才会建树；若一直为空，检查「AI 操控」是否被切走（Vantage AI 正常加入时会自动进树模式：local_patch.js:369-382）');
            if (!(S.server && S.server.ok)) warns.push('策略服务端状态还没取到（点「重载权重」可重试）');
            if (S.server && S.server.ok && S.server.bridgeJsExists === false) hard.push('桥脚本不存在：' + S.server.bridgeJs);
        }
        var reasons = hard.concat(soft);
        S.compat = { ok: reasons.length === 0, hard: hard, soft: soft, reasons: reasons, warns: warns, info: info };
        renderCompat();
        return S.compat;
    }

    function renderCompat() {
        var box = document.getElementById('vt-agent-compat');
        if (!box) return;
        var c = S.compat;
        if (!c) { box.innerHTML = ''; return; }
        var html = '';
        if (c.reasons.length) html += '<div style="color:#f38ba8">⛔ 不兼容：' + c.reasons.join('<br>⛔ ') + '</div>';
        if (c.warns.length) html += '<div style="color:#f9e2af">⚠ ' + c.warns.join('<br>⚠ ') + '</div>';
        if (!html && c.ok) html = '<div style="color:#a6e3a1">✔ 环境兼容</div>';
        box.innerHTML = html;
    }

    /**
     * ⭐ 权重指纹行（父代理 2026-10-17 第②条）：路径 + md5 + step + mem + 开火头。
     *    数据源 `/vt_policy/status`（server.py 从策略进程 stderr 解析 `CKPT_LOADED` / `FIRE_DIST`）。
     *    ⛔ 读不到就写"未提供"；若 `FIRE_DIST fire1=0` 一律红字"不会开枪"。
     */
    function renderCkptInfo() {
        var box = document.getElementById('vt-agent-ckptinfo');
        if (!box) return;
        var s = S.server;
        if (!s || !s.ok) {
            box.style.color = '#f9e2af';
            box.textContent = '权重: 服务端状态未取到（点「重载」重试）';
            return;
        }
        var path = s.ckptPath || s.ckpt || s.defaultCkpt || '未提供';
        var md5 = s.ckptMd5 || '未提供';
        var step = (s.ckptStep === null || s.ckptStep === undefined) ? '未提供' : s.ckptStep;
        var fd = s.fireDist;
        if (!fd && S.fireStat && S.fireStat.n > 0) fd = { n: S.fireStat.n, fire1: S.fireStat.fire1, fire0: S.fireStat.fire0, source: 'panel' };
        var fireTxt = fd ? (fd.fire1 + '/' + fd.n + ' fire1' + (fd.source === 'panel' ? '（面板统计）' : '')) : '未知（样本<200）';
        var fireDead = !!(s.fireHeadDead || (fd && fd.n >= 30 && fd.fire1 === 0));
        var lines = [];
        lines.push('权重: ' + path);
        lines.push('  md5=' + md5 + '  step=' + step + '  mem=' + (S.mem ? 'on' : 'off') + '  fire头=' + fireTxt);
        if (s.ckptLine) lines.push('  ' + s.ckptLine);
        if (s.ckptKeys) lines.push('  ' + s.ckptKeys);
        if (s.ckptState && s.ckptState !== 'loaded') lines.push('⛔ 权重未加载（ckptState=' + s.ckptState + '）');
        if (fireDead) lines.push('⛔ 当前权重开火头恒 0（不会开枪）—— 这是权重问题，不是面板问题');
        if (s.memResetLine) lines.push('  记忆: ' + s.memResetLine + (S.mem ? '' : '  ⚠ 记忆开关=off ⟹ 服务端喂零'));
        var bad = (s.ckptState === 'loaded' ? false : (s.ckptState ? true : false)) || fireDead;
        box.style.color = bad ? '#f38ba8' : '#89b4fa';
        box.textContent = lines.join('\n');
    }

    /** 记忆槽的回合 id（服务端 `round_id` 变了才清 mem；null = 不清） */
    function roundId() {
        try {
            var gc = currentGc();
            var rs = gc && gc.getRoundState ? gc.getRoundState() : null;
            if (rs && rs.getId) return rs.getId();
        } catch (e) {}
        return 'panel#' + (S.roundSeq || 0);   // ⛔ 绝不返回 null（null ⟹ 服务端永远不清 mem）
    }

    // ============================================================
    // 二、面板 DOM（插在既有「AI 操控」下面、实验区上面；⛔ 不重建面板）
    // ============================================================
    function buildSection() {
        var exp = document.getElementById('vt-exp-rows');
        if (!exp || document.getElementById(SECTION_ID)) return false;
        var box = document.createElement('div');
        box.id = SECTION_ID;
        box.style.cssText = 'flex:0 0 auto;padding:4px 8px;border-bottom:1px solid #45475a;display:flex;flex-direction:column;gap:3px';
        box.innerHTML =
            '<div style="text-align:center;font-weight:bold;color:#f5c2e7">智能体模式（神经网络 = 我们的 PPO 策略）</div>' +
            '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:3px 8px">' +
              '<select data-act="vt-agent-mode" style="background:#181825;color:#cdd6f4;border:1px solid #6c7086;border-radius:4px;padding:2px 6px;font:inherit;cursor:pointer">' +
                '<option value="rule">规则版（原生树，默认）</option>' +
                '<option value="nn">神经网络（我们的策略）</option>' +
              '</select>' +
              '<span id="vt-agent-status" style="color:#6c7086">规则版</span>' +
            '</div>' +
            '<div id="vt-agent-cfg" style="display:none;flex-direction:column;gap:3px;border-top:1px solid #45475a;margin-top:2px;padding-top:3px">' +
              '<div style="display:flex;gap:4px;align-items:center">' +
                '<span style="white-space:nowrap">权重</span>' +
                '<input data-act="vt-agent-ckpt" style="flex:1;min-width:0;background:#181825;color:#cdd6f4;border:1px solid #6c7086;border-radius:4px;padding:1px 4px;font:inherit">' +
                '<button data-act="vt-agent-load" style="cursor:pointer;background:#45475a;color:#cdd6f4;border:1px solid #6c7086;border-radius:4px;padding:1px 6px;font:inherit">重载</button>' +
              '</div>' +
              '<div style="display:flex;flex-wrap:wrap;gap:3px 10px">' +
                '<label style="cursor:pointer" title="观测是否包含作弊项（opp/col/mine）；训练时是全发口径"><input type="checkbox" data-act="vt-agent-cheat"> 作弊开关</label>' +
                '<label style="cursor:pointer" title="逐帧把 (obs,act,lp,v) 追加到 D:/vt_run/panel_learn/*.jsonl，供训练器离线学习"><input type="checkbox" data-act="vt-agent-learn"> 学习开关</label>' +
                '<label style="cursor:pointer" title="记忆：2 token × 256 维 × A/B 两份（只写 window.__vtConfig.mem，不发请求）"><input type="checkbox" data-act="vt-agent-mem"> 记忆（2 token × 256 维 × A/B 两份）</label>' +
              '</div>' +
              '<div id="vt-agent-compat" style="color:#f38ba8"></div>' +
              '<div id="vt-agent-ckptinfo" style="color:#89b4fa;white-space:pre-wrap">权重: 服务端状态未取到</div>' +
              '<div id="vt-agent-frame" style="color:#cdd6f4;white-space:pre-wrap;line-height:1.4;border-top:1px dashed #45475a;padding-top:2px">逐帧操作：等待神经网络…</div>' +
              '<div id="vt-agent-roll" style="color:#a6adc8;white-space:pre;overflow-x:auto;line-height:1.25;max-height:132px;border-top:1px dashed #45475a;padding-top:2px"></div>' +
              '<div style="display:flex;gap:6px;align-items:center">' +
                '<button data-act="vt-agent-export" style="cursor:pointer;background:#45475a;color:#cdd6f4;border:1px solid #6c7086;border-radius:4px;padding:1px 6px;font:inherit">导出操作历史 JSONL</button>' +
                '<span id="vt-agent-hist" style="color:#6c7086">历史 0 帧（含被拒操作）</span>' +
              '</div>' +
              '<div id="vt-agent-stats" style="color:#a6adc8;white-space:pre-wrap;line-height:1.45"></div>' +
            '</div>';
        exp.parentNode.insertBefore(box, exp);
        bindSection();
        S.mounted = true;
        return true;
    }

    function bindSection() {
        var sel = $('[data-act="vt-agent-mode"]');
        if (sel) sel.addEventListener('change', function () {
            if (sel.value === 'nn') activateNN(); else deactivateNN('手动切回规则版');
        });
        var ck = $('[data-act="vt-agent-ckpt"]');
        if (ck) {
            ck.value = S.ckpt || defaultCkpt();
            ck.addEventListener('change', function () { S.ckpt = ck.value.trim(); setStatus('权重路径已改：下次请求生效', 'warn'); });
        }
        var btn = $('[data-act="vt-agent-load"]');
        if (btn) btn.addEventListener('click', function () {
            var c = $('[data-act="vt-agent-ckpt"]');
            S.ckpt = c ? c.value.trim() : S.ckpt;
            refreshServerStatus(function (st) {
                if (st && st.ok) setStatus('策略服务端就绪（' + (st.running ? '已加载 ' : '未启动，首个请求时加载 ') + (st.ckpt || st.defaultCkpt) + '）', 'ok');
                else setStatus('⛔ 策略服务端状态获取失败', 'bad');
            });
        });
        var cheat = $('[data-act="vt-agent-cheat"]');
        if (cheat) cheat.addEventListener('change', function () {
            S.cheat = !!cheat.checked;
            CFG.cheat = S.cheat;                 // ⭐ 唯一落点（父代理裁定：只写布尔）
            renderStats();
            log('作弊开关=' + S.cheat + '（关=opp/col/mine 段置零；训练时是全发口径 ⟹ 与训练分布不一致）');
        });
        var learn = $('[data-act="vt-agent-learn"]');
        if (learn) learn.addEventListener('change', function () {
            S.learn = !!learn.checked;
            CFG.learn = S.learn;                 // ⭐ 唯一落点
            if (S.learn && !S.session) S.session = 'panel_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            renderStats();
            log('学习开关=' + S.learn + '（' + (S.learn ? '逐帧记录训练样本到 D:/vt_run/panel_learn/' + S.session + '.jsonl' : '停止记录') + '）');
        });
        var mem = $('[data-act="vt-agent-mem"]');
        if (mem) mem.addEventListener('change', function () {
            S.mem = !!mem.checked;
            CFG.mem = S.mem;                     // ⭐ 唯一落点：只写 window.__vtConfig.mem，不发请求
            renderStats();
            log('记忆开关=' + S.mem + '（2 token × 256 维 × A/B 两份；只写 window.__vtConfig.mem）');
        });
        var expBtn = $('[data-act="vt-agent-export"]');
        if (expBtn) expBtn.addEventListener('click', function () { downloadJSONL(); });
        // 从 __vtConfig 回填勾选状态（三个开关互不联动）
        if (cheat) cheat.checked = !!CFG.cheat;
        if (learn) learn.checked = !!CFG.learn;
        if (mem) mem.checked = !!CFG.mem;
    }

    function defaultCkpt() {
        if (S.server && S.server.defaultCkpt) return S.server.defaultCkpt;
        return S.ckpt || 'D:/vt_run/smoke_mem2/ckpt/last.pt';
    }

    // ============================================================
    // 三、策略桥加载 + 智能体注册
    // ============================================================
    function ensureBridge(cb) {
        if (global.__b && global.__b.build) { S.bridgeReady = true; cb(null); return; }
        var sc = document.createElement('script');
        sc.src = '/vt_inject_fire.js?v=1';       // 服务器把 _tools/headless/inject_fire.js 原样下发（唯一实现）
        sc.onload = function () {
            S.bridgeReady = !!(global.__b && global.__b.build);
            cb(S.bridgeReady ? null : '桥脚本已加载但 window.__b 不存在（inject_fire.js 改动？）');
        };
        sc.onerror = function () {
            cb('桥脚本 /vt_inject_fire.js 加载失败：只有 game_core/server.py 提供这个端点（静态服务器没有）');
        };
        document.head.appendChild(sc);
    }

    function makeAgent(phase) {
        return {
            name: 'nnpanel' + phase,
            isReady: function () { return S.on === true; },
            decide: function (ctx, info) {
                if (!S.on) return null;
                var t = (ctx && typeof ctx.time === 'number') ? ctx.time : null;
                if (S.lastCtxTime === null || t !== S.lastCtxTime) {
                    S.lastCtxTime = t;
                    S.ticks++;
                    tickRefresh();
                }
                // ⭐ 帧内重试：树把"射击帧被拒（如 0 帧自杀）"作为 rejected 送回来时，
                //    本帧【放弃射击、保住路线】（⛔ 不静默：计数 + 面板显示），而不是整包丢掉。
                if (info && info.attempt > 1 && global.__b && global.__b.wantFire) {
                    global.__b.wantFire = false;
                    S.fireDropped++;
                }
                var out = null;
                try { out = global.__b.build(); }
                catch (e) { S.errCount++; S.lastErr = 'build 抛异常: ' + String(e && e.message || e); return null; }
                try {
                    var is = global.__vantageIface;
                    if (is && is.skipped) {
                        var sk = String(is.skipped);
                        if (sk !== S.lastSkipped) { S.lastSkipped = sk; S.skipReasons[sk] = (S.skipReasons[sk] || 0) + 1; }
                    }
                } catch (eSk) {}
                // ⭐ 逐帧操作记录（每 tick 一次，B 相之后；含被拒操作）——父代理 2026-10-17 第 2/3 件
                if (ctx && ctx.phase === 'B') {
                    try { recordFrame(ctx, info, out); } catch (eRf) { log('recordFrame 异常: ' + String(eRf && eRf.message || eRf)); }
                }
                return out;
            }
        };
    }

    function activateNN() {
        setStatus('检查环境…', 'warn');
        var c = compatCheck();
        if (c.hard && c.hard.length) {
            setStatus('⛔ 环境不兼容，拒绝切到神经网络：' + c.hard[0], 'bad');
            S.awaitNN = false;
            revertSelect();
            return;
        }
        if (c.soft && c.soft.length) {
            // ⏸ 软原因（多半是这一回合 Vantage 已阵亡）⟹ 保留「神经网络」选项、暂停等待，自动重试。
            S.mode = 'nn';
            S.on = false;
            S.awaitNN = true;
            var cfgS = document.getElementById('vt-agent-cfg');
            if (cfgS) cfgS.style.display = 'flex';
            setStatus('⏸ 等待：' + c.soft[0] + '（会自动继续，不退回规则版）', 'warn');
            return;
        }
        S.awaitNN = false;
        ensureBridge(function (err) {
            if (err) { setStatus('⛔ ' + err, 'bad'); S.awaitNN = false; revertSelect(); return; }
            S.mode = 'nn';
            S.on = true;
            S.activations++;
            S.lastCtxTime = null;
            S.prevNodeId = 0;
            S.prevFire = 0;
            S.seq = 0;
            S.served = 0; S.errCount = 0; S.emptyTree = 0; S.skipInflight = 0;
            S.lat = []; S.errLog = [];
            global.__b.tankId = S.tankId;
            try { global.__b.setFireBack('now'); } catch (eFb) {}
            // 确保树在 tick（Vantage AI 正常加入时 local_patch.js:369-382 已自动开；这里再兜一次）
            try {
                if (typeof VantageTestbench !== 'undefined' && VantageTestbench.getState) {
                    var st = VantageTestbench.getState();
                    if (!st.aiControl) st.aiControl = { enabled: false, opIndex: 0, auto: false, tree: false };
                    st.aiControl.enabled = true; st.aiControl.tree = true; st.aiControl.auto = false;
                }
            } catch (eAc) {}
            var A = makeAgent('A'), B = makeAgent('B');
            VantageTreeInterface.Agents.register(A, 'A');
            VantageTreeInterface.Agents.register(B, 'B');
            VantageTreeInterface.Agents.use(A.name, 'A');
            VantageTreeInterface.Agents.use(B.name, 'B');
            setStatus('神经网络已接管 ' + S.tankId + '（等待首个决策）', 'ok');
            refreshServerStatus(function (st) {
                if (!st || !st.ok) { abortNN('策略服务端不可用（/vt_policy/status 失败）'); return; }
                setStatus('神经网络已接管 ' + S.tankId + ' · 服务端 ' + (st.running ? '已加载' : '未启动') +
                          ' · 权重 ' + (st.ckpt || st.defaultCkpt), 'ok');
            });
            log('已切到神经网络：tank=' + S.tankId + ' fireBack=now（picks[1] back=L−1−rel）');
        });
    }

    function revertSelect() {
        var sel = $('[data-act="vt-agent-mode"]');
        if (sel) sel.value = 'rule';
        var cfg = document.getElementById('vt-agent-cfg');
        if (cfg) cfg.style.display = 'none';
    }

    function deactivateNN(why) {
        var was = S.on;
        S.on = false;
        S.mode = 'rule';
        try { if (typeof VantageTreeInterface !== 'undefined') VantageTreeInterface.Agents.use('rule'); } catch (e) {}
        var cfg = document.getElementById('vt-agent-cfg');
        if (cfg) cfg.style.display = 'none';
        setStatus(was ? ('已切回规则版（' + (why || '') + '）') : '规则版', was ? 'warn' : '');
        log('deactivateNN: ' + (why || ''));
    }

    function abortNN(reason) {
        var cfg = document.getElementById('vt-agent-cfg');
        if (cfg) cfg.style.display = 'flex';
        S.on = false;
        S.mode = 'rule';
        try { if (typeof VantageTreeInterface !== 'undefined') VantageTreeInterface.Agents.use('rule'); } catch (e) {}
        setStatus('⛔ 已强制停止神经网络：' + reason, 'bad');
        var box = document.getElementById('vt-agent-compat');
        if (box) box.innerHTML = '<div style="color:#f38ba8">⛔ 已强制停止神经网络：' + reason + '</div>';
        revertSelect();
        log('ABORT: ' + reason);
    }

    /**
     * ⏸ 软暂停：Vantage 这一回合阵亡 / 观测源暂时读不到 ⟹ 停止消费决策、保留「神经网络」选项，
     *    下一回合坦克回来时自动恢复。⛔ 这不是"退回规则版"：下拉仍是「神经网络」、状态是黄字。
     */
    function suspendNN(reason) {
        if (!S.on) return;
        S.on = false;
        S.awaitNN = true;
        try { if (typeof VantageTreeInterface !== 'undefined') VantageTreeInterface.Agents.use('rule'); } catch (e) {}
        setStatus('⏸ 暂停神经网络：' + reason + '（会自动恢复）', 'warn');
        log('SUSPEND: ' + reason);
    }

    // ============================================================
    // 四、每帧决策管线（观测 → /vt_policy → 下一帧生效）
    // ============================================================
    var OPP = 15, OPP_SLOTS = 8, BUL_SLOTS = 64, ITEM_R = 8, ITEM_C = 6;

    function zeroRows(n, w) { var out = []; for (var i = 0; i < n; i++) { var r = []; for (var j = 0; j < w; j++) r.push(0); out.push(r); } return out; }
    function pad(rows, slot, w) {        var out = (rows || []).slice(0, slot);
        var z = []; for (var j = 0; j < w; j++) z.push(0);
        while (out.length < slot) out.push(z.slice());
        return out;
    }
    // ⭐ 与 `_tools/headless/_collect_tmp.js:9-24` 同一口径（服务端 opp 槽 (B,8,15)、item 8×6）
    function oppRows(o) {
        var src = (o && o.opp) || [];
        var nb = Math.floor(src.length / OPP), out = [];
        for (var b = 0; b < OPP_SLOTS; b++) {
            var r = [];
            for (var i = 0; i < OPP; i++) r.push(b < nb ? +src[b * OPP + i] || 0 : 0);
            out.push(r);
        }
        return out;
    }
    function itemRows(o) {
        var col = (o && o.col) || [], mine = (o && o.mine) || [], out = [];
        for (var k = 0; k < ITEM_R; k++) {
            var c = col.slice(k * 3, k * 3 + 3), m = mine.slice(k * 3, k * 3 + 3);
            while (c.length < 3) c.push(0);
            while (m.length < 3) m.push(0);
            out.push([+c[0] || 0, +c[1] || 0, +c[2] || 0, +m[0] || 0, +m[1] || 0, +m[2] || 0]);
        }
        return out;
    }

    /** 诊断：找出载荷里第一个"非有限数字"（服务端 torch.tensor 遇到字符串会报 invalid data type 'str'） */
    function diagPayload(p) {
        try {
            var segs = p.segs || {};
            for (var k in segs) {
                var rows = segs[k];
                if (!rows || !rows.length) return { seg: k, why: '空段', type: typeof rows };
                for (var i = 0; i < rows.length; i++) {
                    var row = rows[i];
                    if (!row || typeof row.length !== 'number') return { seg: k, i: i, why: '行不是数组', type: typeof row, sample: JSON.stringify(rows).slice(0, 160) };
                    for (var j = 0; j < row.length; j++) {
                        if (typeof row[j] !== 'number' || !isFinite(row[j])) {
                            return { seg: k, i: i, j: j, value: String(row[j]).slice(0, 40), type: typeof row[j],
                                     rowsType: typeof rows, rowsIsArr: Array.isArray(rows), rowsLen: rows.length,
                                     rowType: typeof row, rowIsArr: Array.isArray(row), rowLen: row.length,
                                     sample: JSON.stringify(rows).slice(0, 160) };
                        }
                    }
                }
            }
            return null;
        } catch (e) { return { why: 'diag 异常', err: String(e && e.message || e) }; }
    }

    /**
     * 把观测段归一成"行 × 宽 的数字矩阵"。
     * ⚠️ 实测（2026-10-17）：`__b.step()` 的某些段会给【逗号连接的字符串】
     *    （例：`b = "45.93,26.00,17.44,-4.45,1.32,-1,3.98"`），直接喂服务端会得到
     *    `new(): invalid data type 'str'`。这里显式拆开（⛔ 不是静默丢弃：拆不出数字就当错误）。
     */
    function normSeg(x, w) {
        var rows = [];
        if (x === null || x === undefined) return rows;
        if (typeof x === 'string') {
            var parts = x.indexOf(';') >= 0 ? x.split(';') : [x];
            for (var a = 0; a < parts.length; a++) {
                var s = parts[a];
                if (!s) continue;
                var arr = s.split(',').map(function (t) { return Number(t); });
                rows.push(arr);
            }
            return rows;
        }
        if (typeof x.length !== 'number') return rows;
        if (!x.length) return rows;
        if (typeof x[0] === 'string') {
            for (var b = 0; b < x.length; b++) rows.push(String(x[b]).split(',').map(function (t) { return Number(t); }));
            return rows;
        }
        if (Array.isArray(x[0])) {
            for (var c = 0; c < x.length; c++) rows.push(Array.prototype.map.call(x[c], function (t) { return Number(t); }));
            return rows;
        }
        // 扁平数字数组 → 按 w 切行
        for (var i = 0; i + w <= x.length; i += w) rows.push(Array.prototype.slice.call(x, i, i + w).map(function (t) { return Number(t); }));
        if (!rows.length) rows.push(Array.prototype.map.call(x, function (t) { return Number(t); }));
        return rows;
    }

    function buildPayload(o) {
        var nRows = normSeg(o.n, 10);
        var N = nRows.length;
        var oppSrc = S.cheat ? normSeg(o.opp, OPP) : [];
        var opp = [];
        for (var k = 0; k < OPP_SLOTS; k++) {
            var r = (S.cheat && oppSrc[k]) ? oppSrc[k] : [];
            var rr = [];
            for (var j = 0; j < OPP; j++) rr.push(typeof r[j] === 'number' && isFinite(r[j]) ? r[j] : 0);
            opp.push(rr);
        }
        var item = zeroRows(ITEM_R, ITEM_C);
        if (S.cheat) {
            var colR = normSeg(o.col, 3), mineR = normSeg(o.mine, 3);
            for (var m = 0; m < ITEM_R; m++) {
                var cc = colR[m] || [], mm = mineR[m] || [];
                item[m] = [cc[0] || 0, cc[1] || 0, cc[2] || 0, mm[0] || 0, mm[1] || 0, mm[2] || 0];
            }
        }
        var bRows = normSeg(o.b, 7);
        if (!bRows.length) bRows = [[0, 0, 0, 0, 0, 0, 0]];
        var gRows = normSeg(o.g, 38);
        var gRow = [];
        for (var q = 0; q < 38; q++) gRow.push((gRows[0] && typeof gRows[0][q] === 'number' && isFinite(gRows[0][q])) ? gRows[0][q] : 0);
        return {
            N: N,
            seed: (S.seq * 2654435761) >>> 0,
            ckpt: S.ckpt || defaultCkpt(),
            cheat: !!S.cheat,
            mem_on: S.mem ? 1 : 0,           // ⭐ 记忆开关真正下发给服务端（`policy_server_graph.py:143` d.get('mem_on')）
            round_id: roundId(),             // ⭐ 服务端只在 round_id 变化时清 mem（`:147-149`）
            segs: { node: nRows, opp: opp, bullet: pad(bRows, BUL_SLOTS, 7), item: item, global: [gRow] }
        };
    }

    function tickRefresh() {
        if (!S.on) return;
        if (S.inflight) { S.skipInflight++; return; }
        if (!global.__b || !global.__b.step) { S.lastErr = '桥未安装'; return; }
        var o = null;
        try { o = JSON.parse(global.__b.step(S.prevNodeId, S.prevFire)); }
        catch (e) { S.errCount++; S.lastErr = 'step 抛异常: ' + String(e && e.message || e); return; }
        if (!o || o.err) { S.errCount++; S.lastErr = 'step: ' + String(o && o.err || '空返回'); return; }
        S.lastN = (o.n || []).length;
        S.lastObs = o;
        // ⭐ 策略给的 nodeId 可能在下几帧被剪枝掉（树会 prune）⟹ `step` 找不到它、nSlots=-1。
        //    这里【复用上一份 slot 路径】让 build 继续沿当前树重走（slot 重映射就是为此设计的），
        //    避免整帧 no-output（giveUpA/B）。⛔ 不静默：计数 + 面板显示。
        if (o.nSlots === -1 || o.nSlots === 0 || !global.__b.pendingSlots || !global.__b.pendingSlots.length) {
            S.nodeRemap++;
            if (S.lastGoodSlots && S.lastGoodSlots.length) global.__b.pendingSlots = S.lastGoodSlots;
            S.prevNodeId = 0;
        } else if (global.__b.pendingSlots && global.__b.pendingSlots.length) {
            S.lastGoodSlots = global.__b.pendingSlots.slice();
        }
        if (!S.lastN) { S.emptyTree++; return; }
        var payload = buildPayload(o);
        S.pendingPayload = payload;
        S.payloadDiag = diagPayload(payload);
        if (S.payloadDiag) {
            // ⛔ 不把脏载荷发给服务端（否则只会拿到一句 invalid data type 'str'）；当场显形
            S.errCount++;
            S.lastErr = '载荷含非有限数字 ⟹ 拒绝发送: ' + JSON.stringify(S.payloadDiag);
            return;
        }
        S.seq++;
        S.inflight = 1;
        var t0 = nowMs();
        var _ctrl = null, _to = null;
        try {
            if (typeof AbortController !== 'undefined') {
                _ctrl = new AbortController();
                _to = setTimeout(function () { try { _ctrl.abort(); } catch (e) {} }, 20000);   // ⛔ 不许无限挂起（静默失败）
            }
        } catch (eAb) {}
        fetch('/vt_policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
                              signal: _ctrl ? _ctrl.signal : undefined })
            .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
            .then(function (x) {
                if (_to) { try { clearTimeout(_to); } catch (eC) {} }
                S.inflight = 0;
                var j = x.j || {};
                if (j.err) {
                    S.errCount++;
                    S.lastErr = 'policy: ' + j.err;
                    if (S.errLog.length < 8) S.errLog.push(String(j.err).slice(0, 160));
                    return;
                }
                if (typeof j.nodeId !== 'number') {
                    S.errCount++;
                    S.lastErr = 'policy 返回缺 nodeId（键=' + Object.keys(j).join(',') + '）';
                    return;
                }
                S.prevNodeId = j.nodeId;
                S.prevFire = (j.fire === 1) ? 1 : 0;
                S.served++;
                S.servedTotal++;
                var _fs = S.fireStat || (S.fireStat = { n: 0, fire1: 0, fire0: 0 });
                _fs.n++; if (j.fire === 1) _fs.fire1++; else _fs.fire0++;
                if (S.served === 1 || S.served % 60 === 0) { try { refreshServerStatus(function () {}); } catch (eRs) {} }
                S.lastResp = j;
                var ms = (typeof j._srv_ms === 'number') ? j._srv_ms : (nowMs() - t0);
                S.lat.push(ms);
                if (S.lat.length > 160) S.lat.shift();
                if (S.learn) queueLearn(S.pendingPayload, j);
            })
            .catch(function (e) {
                if (_to) { try { clearTimeout(_to); } catch (eC2) {} }
                S.inflight = 0;
                S.errCount++;
                var aborted = String(e && e.name || '') === 'AbortError';
                if (aborted) S.reqTimeouts = (S.reqTimeouts || 0) + 1;
                S.lastErr = (aborted ? '⛔ 请求超时(20s，已中止) ' : 'fetch 失败: ') + String(e && e.message || e);
            });
    }

    // ============================================================
    // 五、学习开关：把每帧 (obs, act, lp, v) 批量落盘（供训练器离线学习；页内不做梯度）
    // ============================================================
    function queueLearn(payload, j) {
        if (!payload || !payload.segs) return;
        S.learnBuf.push({
            t: S.seq, tank: S.tankId, mode: 'nn', cheat: !!S.cheat,
            obs: payload.segs, act: { nodeId: j.nodeId, fire: (j.fire === 1) ? 1 : 0 },
            lp: (typeof j.lp === 'number' && isFinite(j.lp)) ? j.lp : null,
            v: (typeof j.v === 'number' && isFinite(j.v)) ? j.v : null,
            srv: { mode: j.mode || null, payload: j.payload || null },
            r: { total: null, result: null, survive: 0.01, legal: null, rewardUnassigned: true }   // survive 口径同 `_collect_tmp.js`（每帧 0.01）；result 回合结束时补
        });
        if (S.learnBuf.length >= 9) flushLearn(true);   // ⭐ 留最新 1 帧在缓冲里 ⟹ 回合结束能给"最后一帧"补 result
    }
    function flushLearn(keepLast) {
        var keep = keepLast ? 1 : 0;
        var n = S.learnBuf.length - keep;
        if (n <= 0) return;
        var batch = S.learnBuf.splice(0, n);
        if (!S.session) S.session = 'panel_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        fetch('/vt_learn', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                             body: JSON.stringify({ session: S.session, frames: batch }) })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                if (j && j.ok) { S.learnSaved += batch.length; S.learnLines = j.lines; S.learnBytes = j.bytes; }
                else { S.lastErr = 'learn: ' + (j && j.err); S.errCount++; }
            })
            .catch(function (e) { S.learnBuf = batch.concat(S.learnBuf); S.lastErr = 'learn fetch: ' + String(e && e.message || e); S.errCount++; });
    }

    /**
     * ⭐ 回合结果（父代理 2026-10-17 第③条）：胜 +1 / 负 -1 / 平 -0.25。
     *    判据只读游戏真值：`SCORE_TYPES.VICTORY=1` 且我方 >0 → 胜；回合结束但我方坦克不在场 → 负；其余 → 平。
     */
    function roundOutcome() {
        try {
            var gc = currentGc();
            if (!gc) return { result: null, why: 'no gc' };
            var tanks = gc.getTanks ? gc.getTanks() : {};
            var alive = !!(tanks && tanks[S.tankId]);
            var scores = gc.getScores ? gc.getScores() : {};
            var victory = 0;
            for (var k in scores) {
                var s = scores[k];
                var pid = s.getPlayerId ? s.getPlayerId() : s.playerId;
                var type = s.getType ? s.getType() : s.type;
                var val = s.getValue ? s.getValue() : s.value;
                if (String(pid) !== String(S.tankId)) continue;
                if (type === 1 && typeof val === 'number' && val > 0) victory = 1;   // SCORE_TYPES.VICTORY = 1
            }
            if (victory) return { result: 1, why: 'victory' };
            if (!alive) return { result: -1, why: 'dead' };
            return { result: -0.25, why: 'draw(no victory score & alive)' };
        } catch (e) { return { result: null, why: 'err: ' + String(e && e.message || e) }; }
    }

    /** 回合结束时给【缓冲里最后一帧】补 result/total，然后整批落盘（⛔ 不改主体奖励设计） */
    function finalizeRoundLearning() {
        if (!S.learnBuf.length) return;
        var last = S.learnBuf[S.learnBuf.length - 1];
        if (!last || !last.r) return;
        var out = roundOutcome();
        last.r.result = out.result;
        last.r.survive = 0.01;
        last.r.total = (out.result === null) ? null : +(out.result + 0.01).toFixed(4);
        last.r.rewardAssignedBy = 'panel:roundEnd(' + out.why + ')';
        last.r.rewardUnassigned = (out.result === null);
        flushLearn(false);
        log('学习样本回合收尾: result=' + out.result + '（' + out.why + '）');
    }

    // ============================================================
    // 五·B、逐帧操作视图 + 操作历史 JSONL（含被拒操作）
    //   数据源：`window.__b.readonly()`（另一代理已暴露 lastPick/lastFire/lastRouteLen）
    //   ⛔ 读不到就写"未提供"，不编数；⛔ 被拒记录不过滤。
    // ============================================================
    function ro() {
        try { return (global.__b && global.__b.readonly) ? global.__b.readonly() : null; } catch (e) { return null; }
    }
    function nodeRowOf(o, row) {
        try {
            if (!o || !o.n || row === null || row === undefined || row < 0 || row >= o.n.length) return null;
            var r = o.n[row];
            return { row: row, uid: (r[0] | 0), parent: (r[1] | 0), slot: (r[2] | 0), depth: (r[3] | 0) };
        } catch (e) { return null; }
    }
    function opNameOf(slot) {
        try { return (VantageSandbox.OPERATIONS[slot] || {}).name || null; } catch (e) { return null; }
    }
    function tankPos() {
        try {
            var gc = currentGc();
            var t = gc && gc.getTank ? gc.getTank(S.tankId) : null;
            return t ? { x: +t.getX().toFixed(2), y: +t.getY().toFixed(2) } : null;
        } catch (e) { return null; }
    }
    /** 最终 inputs：取"本帧 picks[0] 目标节点"自己的 inputs（树执行路线用的就是它） */
    function plannedInputs() {
        try {
            var tree = VantageTree.getTree();
            if (!tree || !global.__b.pendingSlots || !global.__b.pendingSlots.length) return null;
            var w = global.__b.walk(tree, global.__b.pendingSlots);
            var n = w && w.node;
            if (!n || !n.inputs) return null;
            var i = n.inputs;
            return { forward: !!i.forward, back: !!i.back, left: !!i.left, right: !!i.right, from: 'pickNode.inputs' };
        } catch (e) { return null; }
    }
    function recordFrame(ctx, info, builtOut) {
        // ⭐ 一个 tick 只记一行（树会因"帧内重试"多次调 decide，⛔ 不能把重试记成多帧）
        if (S.lastRecordedTick === S.ticks) return;
        S.lastRecordedTick = S.ticks;
        var r = ro();
        var pick = (r && r.lastPick) ? { row: r.lastPick.row, uid: r.lastPick.uid, depth: r.lastPick.depth, opName: r.lastPick.opName, source: 'readonly' } : null;
        // ⭐ readonly 读不到（或树满/走兜底时它不写）⟹ 用【本次观测行 + 策略选中的 row】补，⛔ 不编数
        if (!pick || pick.row === null || pick.row === undefined || pick.uid === null || pick.uid === undefined || !pick.opName) {
            var nr = nodeRowOf(S.lastObs, S.prevNodeId);
            if (nr) {
                pick = { row: nr.row, uid: nr.uid, depth: nr.depth, opName: opNameOf(nr.slot) || (pick && pick.opName) || null, source: 'obsRow' };
            } else if (!pick) {
                pick = { row: null, uid: null, depth: null, opName: null, provided: false };
            }
        }
        var st = null; try { st = global.__b.stats ? global.__b.stats() : null; } catch (e2) {}
        // ⭐ fire 三态：policy（策略原始）/ submitted（本帧真提交了射击帧）/ blockedBy（谁拦的）
        var fire = (r && r.lastFire) ? { policy: r.lastFire.policy, submitted: r.lastFire.submitted, blockedBy: r.lastFire.blockedBy || null } : null;
        var dSub = st ? (st.fireSubmits - (S.lastFireSubmits || 0)) : 0;
        var dNoCur = st ? (st.fireNoCursor - (S.lastFireNoCursor || 0)) : 0;
        var dRetry = st ? ((st.fireSkippedRetry || 0) - (S.lastFireSkippedRetry || 0)) : 0;
        var dPulse = st ? ((st.pulseBlocked || 0) - (S.lastPulseBlocked || 0)) : 0;
        var dEmpty = st ? ((st.emptyBlocked || 0) - (S.lastEmptyBlocked || 0)) : 0;
        if (st) {
            S.lastFireSubmits = st.fireSubmits; S.lastFireNoCursor = st.fireNoCursor;
            S.lastFireSkippedRetry = st.fireSkippedRetry || 0; S.lastPulseBlocked = st.pulseBlocked || 0; S.lastEmptyBlocked = st.emptyBlocked || 0;
        }
        if (!fire) {
            fire = { policy: S.prevFire ? 1 : 0, submitted: dSub > 0 ? 1 : 0,
                     blockedBy: dNoCur > 0 ? 'noCursor' : (dRetry > 0 ? 'retry' : (dPulse > 0 ? 'pulse' : (dEmpty > 0 ? 'empty' : null))) };
        }
        var rejected = [];
        var skippedNow = '';
        try { var iface = global.__vantageIface; skippedNow = (iface && iface.skipped) ? String(iface.skipped) : ''; } catch (e1) {}
        // agent 级跳过：只在"本帧发生变化"时记一条（树满会连续多帧，全记会淹没历史），原始值放 skipped 字段
        if (skippedNow && skippedNow !== S.lastRecordedSkipped) rejected.push({ type: 'agent', reason: skippedNow });
        S.lastRecordedSkipped = skippedNow;
        if (info && info.attempt > 1 && info.reason) rejected.push({ type: 'retry', reason: String(info.reason) });
        if (fire.policy === 1 && fire.submitted === 0 && fire.blockedBy) rejected.push({ type: 'fire', reason: String(fire.blockedBy) });
        if (st && st.fireErr && fire.policy === 1) rejected.push({ type: 'fire', reason: String(st.fireErr) });
        var pos = tankPos();
        var moved = null;
        if (S.lastTankPos && pos) moved = +(Math.abs(pos.x - S.lastTankPos.x) + Math.abs(pos.y - S.lastTankPos.y)).toFixed(2);
        S.lastTankPos = pos;
        var inputs = plannedInputs();
        if (!inputs && pick && pick.row !== null && pick.row !== undefined && S.lastObs) {
            var nri = nodeRowOf(S.lastObs, pick.row);
            if (nri) {
                var opi = null; try { opi = VantageSandbox.OPERATIONS[nri.slot]; } catch (e3) {}
                if (opi && opi.inputs) inputs = { forward: !!opi.inputs.forward, back: !!opi.inputs.back, left: !!opi.inputs.left, right: !!opi.inputs.right, from: 'OPERATIONS[slot]' };
            }
        }
        var entry = {
            f: S.ticks,
            N: (S.lastObs && S.lastObs.n) ? S.lastObs.n.length : S.lastN,
            pick: pick,
            lp: (S.lastResp && typeof S.lastResp.lp === 'number') ? S.lastResp.lp : null,
            v: (S.lastResp && typeof S.lastResp.v === 'number') ? S.lastResp.v : null,
            fire: fire,
            routeLen: (r && r.lastRouteLen !== undefined && r.lastRouteLen !== null) ? r.lastRouteLen : (r && r.lastPick ? r.lastPick.depth : null),
            inputs: inputs,
            skipped: skippedNow || null,
            rejected: rejected,
            moved: moved
        };
        S.lastFrameEntry = entry;
        S.hist.push(entry);
        if (S.hist.length > S.histMax) S.hist.splice(0, S.hist.length - S.histMax);
        renderFrameView();
        renderHistSpan();
    }

    function padStr(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
    function renderHistSpan() {
        var el = document.getElementById('vt-agent-hist');
        if (el) el.textContent = '历史 ' + S.hist.length + ' 帧（含被拒操作）';
    }
    function show(v) { return (v === null || v === undefined) ? '未提供' : String(v); }

    function renderFrameView() {
        var box = document.getElementById('vt-agent-frame');
        if (!box) return;
        var e = S.lastFrameEntry;
        if (!e) { box.textContent = '逐帧操作：等待神经网络…'; return; }
        var p = e.pick || {}, f = e.fire || {}, i = e.inputs;
        var lines = [];
        lines.push('f=' + e.f + ' · N=' + show(e.N) + ' · 选中行 row=' + show(p.row) + ' → uid=' + show(p.uid) + ' · depth=' + show(p.depth) + ' · op=' + (p.opName || '未提供'));
        lines.push('lp=' + (typeof e.lp === 'number' ? e.lp.toFixed(4) : '未提供') + ' · v=' + (typeof e.v === 'number' ? e.v.toFixed(4) : '未提供') +
                   ' · routeLen=' + show(e.routeLen) + ' · moved=' + (e.moved === null ? '—' : e.moved));
        lines.push('fire: 策略=' + show(f.policy) + ' · 已提交=' + show(f.submitted) + ' · 被拦=' + (f.blockedBy || '无'));
        lines.push('最终 inputs: ' + (i ? ('fwd=' + (i.forward ? 1 : 0) + ' back=' + (i.back ? 1 : 0) + ' left=' + (i.left ? 1 : 0) + ' right=' + (i.right ? 1 : 0) + '（' + i.from + '）') : '未提供'));
        if (e.rejected && e.rejected.length) lines.push('被拒: ' + e.rejected.map(function (x) { return x.type + ':' + x.reason; }).join(' | '));
        box.textContent = lines.join('\n');
        renderRolling();
    }

    function renderRolling() {
        var box = document.getElementById('vt-agent-roll');
        if (!box) return;
        var rows = S.hist.slice(-60);
        var out = [padStr('f', 6) + padStr('row', 5) + padStr('uid', 6) + padStr('op', 7) + padStr('lp', 9) + padStr('v', 9) + padStr('fire', 9) + 'inputs/moved'];
        for (var k = 0; k < rows.length; k++) {
            var e = rows[k], p = e.pick || {}, f = e.fire || {}, i = e.inputs;
            var fireStr = (show(f.policy) + '/' + show(f.submitted) + '/' + (f.blockedBy || '-'));
            var inp = i ? ('' + (i.forward ? 'F' : '-') + (i.back ? 'B' : '-') + (i.left ? 'L' : '-') + (i.right ? 'R' : '-')) : '?';
            out.push(padStr(e.f, 6) + padStr(show(p.row), 5) + padStr(show(p.uid), 6) + padStr((p.opName || '?'), 7) +
                     padStr(typeof e.lp === 'number' ? e.lp.toFixed(2) : '?', 9) + padStr(typeof e.v === 'number' ? e.v.toFixed(2) : '?', 9) +
                     padStr(fireStr, 9) + inp + '/' + (e.moved === null ? '-' : e.moved));
        }
        box.textContent = out.join('\n');
    }

    function exportJSONL() {
        var lines = [];
        for (var i = 0; i < S.hist.length; i++) lines.push(JSON.stringify(S.hist[i]));
        return lines.length ? (lines.join('\n') + '\n') : '';
    }
    function downloadJSONL() {
        var text = exportJSONL();
        try {
            var blob = new Blob([text], { type: 'application/x-ndjson;charset=utf-8' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'vantage_ops_' + (S.session || 'panel') + '.jsonl';
            document.body.appendChild(a);
            a.click();
            var href = a.href;
            setTimeout(function () { try { URL.revokeObjectURL(href); a.remove(); } catch (e) {} }, 1000);
            setStatus('已导出操作历史 ' + S.hist.length + ' 帧（含被拒）', 'ok');
        } catch (e) {
            setStatus('⛔ 导出失败: ' + String(e && e.message || e), 'bad');
        }
    }

    // ============================================================
    // 六、服务端状态 + 面板统计
    // ============================================================
    function refreshServerStatus(cb) {
        fetch('/vt_policy/status').then(function (r) { return r.json(); }).then(function (st) {
            S.server = st;
            if (S.on && st && st.ok) {
                setStatus('神经网络已接管 ' + S.tankId + ' · 服务端 ' + (st.running ? '已加载' : '未启动') +
                          ' · 权重 ' + (st.ckpt || st.defaultCkpt) +
                          (st.ckptMd5 ? (' md5=' + st.ckptMd5) : '') +
                          (st.ckptStep !== null && st.ckptStep !== undefined ? (' step=' + st.ckptStep) : '') +
                          ' · 请求 ' + st.requests, st.fireHeadDead ? 'bad' : 'ok');
            }
            renderCkptInfo();
            if (cb) cb(st);
        }).catch(function (e) {
            S.server = { ok: false, err: String(e && e.message || e) };
            renderCkptInfo();
            if (cb) cb(S.server);
        });
    }

    function median(arr) {
        if (!arr || !arr.length) return null;
        var a = arr.slice().sort(function (x, y) { return x - y; });
        return a[Math.floor(a.length / 2)];
    }

    function renderStats() {
        var box = document.getElementById('vt-agent-stats');
        if (!box) return;
        var st = null;
        try { st = global.__b && global.__b.stats ? global.__b.stats() : null; } catch (e) {}
        var tree = null;
        try { tree = VantageTree.getTree ? VantageTree.getTree() : null; } catch (e2) {}
        var med = median(S.lat);
        var cov = S.ticks ? (100 * S.served / S.ticks) : 0;
        var lines = [];
        lines.push('状态: ' + (S.on ? '神经网络运行中' : '未运行') + ' · 坦克: ' + (S.tankId || '-') +
                   ' · 游戏模式: ' + (S.gameMode === null || S.gameMode === undefined ? '?' : S.gameMode));
        lines.push('服务端: ' + (S.server ? ((S.server.running ? 'running' : 'idle') + ' · 权重 ' + (S.server.ckpt || S.server.defaultCkpt) +
                   ' · md5=' + (S.server.ckptMd5 || '未提供') + ' · step=' + (S.server.ckptStep === null || S.server.ckptStep === undefined ? '未提供' : S.server.ckptStep) +
                   ' · fire头=' + (S.server.fireDist ? (S.server.fireDist.fire1 + '/' + S.server.fireDist.n) : '未知') +
                   (S.server.fireHeadDead ? ' ⛔恒0' : '') + ' · 请求 ' + S.server.requests) : '未取到'));
        lines.push('策略调用: ' + S.served + ' 次 / 请求 ' + S.seq + ' · 错误 ' + S.errCount +
                   ' · 累计 ' + S.servedTotal + ' 次 / 恢复 ' + S.activations + ' 次' +
                   ' · 服务端延迟中位 ' + (med === null ? '-' : med.toFixed(1)) + ' ms');
        lines.push('tick: ' + S.ticks + ' · 决策覆盖率 ' + cov.toFixed(1) + '% · 空树跳过 ' + S.emptyTree + ' · 在飞跳过 ' + S.skipInflight +
                   ' · 节点被剪枝换路 ' + S.nodeRemap + ' · N=' + S.lastN + (tree && tree.nodeCount ? (' · 树节点 ' + tree.nodeCount) : ''));
        if (S.lastResp) lines.push('最近: nodeId=' + S.lastResp.nodeId + ' fire=' + S.lastResp.fire +
                   ' lp=' + (typeof S.lastResp.lp === 'number' ? S.lastResp.lp.toFixed(3) : '-') +
                   ' v=' + (typeof S.lastResp.v === 'number' ? S.lastResp.v.toFixed(3) : '-') +
                   ' mode=' + (S.lastResp.mode || '-') + '/' + (S.lastResp.payload || '-'));
        if (st) lines.push('桥: fireSubmits=' + st.fireSubmits + ' pickExtras=' + st.pickExtras + ' giveUpB=' + st.giveUpB +
                   ' fireNoCursor=' + st.fireNoCursor + ' fireErr=' + (st.fireErr || '-') +
                   ' buildOK=' + st.buildOK + ' buildMisses=' + st.buildMisses + ' skipped=' + (st.skipped || '-'));
        lines.push('射击: 本帧放弃开火(保路线) ' + S.fireDropped + ' 次 · 拒绝原因 ' +
                   (Object.keys(S.skipReasons).length ? Object.keys(S.skipReasons).map(function (k) { return k + '×' + S.skipReasons[k]; }).slice(0, 4).join(' | ') : '无'));
        lines.push('学习: ' + (S.learn ? ('记录中 · 已落盘 ' + S.learnSaved + ' 帧 / 文件 ' + (S.learnLines || 0) + ' 行') : '关') +
                   (S.session && S.learnSaved ? (' · D:/vt_run/panel_learn/' + S.session + '.jsonl') : ''));
        lines.push('作弊开关: ' + (S.cheat ? '开（观测含 opp/col/mine，训练口径）' : '⚠ 关（opp/col/mine 置零 ⟹ 与训练分布不一致）') +
                   ' · 学习: ' + (S.learn ? '开' : '关') + ' · 记忆: ' + (S.mem ? '开（2 token × 256 维 × A/B）' : '关') +
                   '（window.__vtConfig = ' + JSON.stringify({ cheat: CFG.cheat, learn: CFG.learn, mem: CFG.mem }) + '）');
        lines.push('操作历史: ' + S.hist.length + ' 帧（含被拒；最近 60 帧见上表，按钮可导出 JSONL）');
        if (S.lastErr) lines.push('最近错误: ' + S.lastErr);
        if (S.payloadDiag) lines.push('载荷诊断: ' + JSON.stringify(S.payloadDiag));
        if (S.errLog.length) lines.push('错误样本: ' + S.errLog.slice(-3).join(' | '));
        box.textContent = lines.join('\n');
    }

    function poll() {
        try {
            if (!S.mounted) buildSection();
            if (S.mounted) {
                var cfg = document.getElementById('vt-agent-cfg');
                if (cfg) cfg.style.display = (S.mode === 'nn' || S.on) ? 'flex' : 'none';
                // ⭐ 运行中也要检测不兼容（DM 中途切过来、坦克消失等）——⛔ 不许静默降级
                // ⭐ 服务端状态定期刷新（运行中也要刷；⛔ 别让面板显示过期状态）
                if (Date.now() - S.lastStatusAt > 3000) {
                    S.lastStatusAt = Date.now();
                    refreshServerStatus(function () { if (S.mounted) renderStats(); });
                }
                if (S.on) {
                    var c = compatCheck();
                    if (c.hard && c.hard.length) abortNN(c.hard[0]);
                    else if (c.soft && c.soft.length) suspendNN(c.soft[0]);
                } else if (S.mode === 'nn' && S.awaitNN) {
                    if (Date.now() - S.lastRetryAt > 1000) {
                        S.lastRetryAt = Date.now();
                        activateNN();          // ⏸ 自动等 Vantage 回来（不静默退回规则版）
                    }
                }
                // ⭐ 回合结束检测（只读）：给学习样本最后一帧补 result（胜 +1 / 负 -1 / 平 -0.25）
                var curRound = null;
                try { var gcr = currentGc(); curRound = gcr ? gcr.getState() : null; } catch (eR) {}
                if (S.lastRoundState === 'in round' && curRound !== null && curRound !== 'in round') {
                    if (S.learn) { try { finalizeRoundLearning(); } catch (eF) { log('finalizeRoundLearning 异常: ' + String(eF && eF.message || eF)); } }
                }
                if (curRound === 'in round' && S.lastRoundState !== null && S.lastRoundState !== 'in round') S.roundSeq = (S.roundSeq || 0) + 1;   // 新回合 ⟹ 记忆槽清零
                S.lastRoundState = curRound;
                if (S.learn) flushLearn(true);          // ⭐ 留最新 1 帧
                renderCkptInfo();
                renderStats();
            }
        } catch (e) {
            try { console.error('[VantageAgentPanel] poll 异常:', e); } catch (e2) {}
        }
        setTimeout(poll, 500);
    }

    // ============================================================
    // 七、对外 API（探针/测试用；也方便主人在控制台查）
    // ============================================================
    global.VantageAgentPanel = {
        VERSION: VERSION,
        getState: function () { return S; },
        compatCheck: compatCheck,
        buildPayload: function (o) { return buildPayload(o); },   // 诊断：作弊开关对载荷的影响（单测用）
        activateNN: activateNN,
        deactivateNN: deactivateNN,
        exportJSONL: exportJSONL,                       // 操作历史（含被拒）⟹ 一行一帧
        history: function () { return S.hist; },
        config: function () { return { cheat: CFG.cheat, learn: CFG.learn, mem: CFG.mem }; },
        status: function () { return { on: S.on, tankId: S.tankId, served: S.served, seq: S.seq, err: S.errCount, lastErr: S.lastErr, server: S.server, compat: S.compat }; }
    };

    function boot() {
        log('已加载 v' + VERSION + '（只扩展 T 面板；策略桥=/vt_inject_fire.js，推理=/vt_policy）');
        setTimeout(poll, 300);
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(boot, 300);
    else document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 300); });
})(typeof window !== 'undefined' ? window : this);
