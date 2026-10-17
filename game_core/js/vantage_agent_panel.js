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

    var VERSION = '1.0.0-20261017';
    var SECTION_ID = 'vt-agent-rows';
    var LAIKA_TEMPLATE_ID = '6148530';

    var S = {
        mounted: false,
        mode: 'rule',              // 'rule' | 'nn'
        on: false,
        tankId: null,
        gameMode: null,
        ckpt: null,
        cheat: true,               // 作弊开关：观测是否含作弊项（opp/col/mine）
        learn: false,              // 学习开关：逐帧把 (obs, act, lp, v) 落盘供训练器离线学习
        // —— 决策管线 ——
        seq: 0, ticks: 0, inflight: 0,
        prevNodeId: 0, prevFire: 0,
        served: 0, servedTotal: 0, activations: 0, errCount: 0, emptyTree: 0, skipInflight: 0,
        lat: [], errLog: [],
        lastResp: null, lastErr: null, lastN: 0, lastCtxTime: null,
        fireDropped: 0, skipReasons: {}, lastSkipped: '', nodeRemap: 0, lastGoodSlots: null,
        pendingPayload: null,
        learnBuf: [], learnSaved: 0, learnLines: 0, learnBytes: 0,
        session: null, server: null, compat: null,
        bridgeReady: false, lastStatusAt: 0, lastRetryAt: 0, awaitNN: false
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
                '<label style="cursor:pointer"><input type="checkbox" data-act="vt-agent-cheat" checked> 作弊开关（观测含作弊项）</label>' +
                '<label style="cursor:pointer"><input type="checkbox" data-act="vt-agent-learn"> 学习开关（记录训练样本）</label>' +
              '</div>' +
              '<div id="vt-agent-compat" style="color:#f38ba8"></div>' +
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
            renderStats();
            log('作弊开关=' + S.cheat + '（关=opp/col/mine 段置零；训练时是全发口径 ⟹ 与训练分布不一致）');
        });
        var learn = $('[data-act="vt-agent-learn"]');
        if (learn) learn.addEventListener('change', function () {
            S.learn = !!learn.checked;
            if (S.learn && !S.session) S.session = 'panel_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            renderStats();
            log('学习开关=' + S.learn + '（' + (S.learn ? '逐帧记录训练样本到 D:/vt_run/panel_learn/' + S.session + '.jsonl' : '停止记录') + '）');
        });
    }

    function defaultCkpt() {
        if (S.server && S.server.defaultCkpt) return S.server.defaultCkpt;
        return S.ckpt || 'D:/vt_run/seed/ckpt/last.pt';
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
    function pad(rows, slot, w) {
        var out = (rows || []).slice(0, slot);
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

    function buildPayload(o) {
        var N = (o.n || []).length;
        var opp = S.cheat ? oppRows(o) : zeroRows(OPP_SLOTS, OPP);
        var item = S.cheat ? itemRows(o) : zeroRows(ITEM_R, ITEM_C);
        var bRows = (o.b && o.b.length) ? o.b : [[0, 0, 0, 0, 0, 0, 0]];
        return {
            N: N,
            seed: (S.seq * 2654435761) >>> 0,
            ckpt: S.ckpt || defaultCkpt(),
            cheat: !!S.cheat,
            segs: { node: o.n, opp: opp, bullet: pad(bRows, BUL_SLOTS, 7), item: item, global: [o.g] }
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
        S.seq++;
        S.inflight = 1;
        var t0 = nowMs();
        fetch('/vt_policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
            .then(function (x) {
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
                S.lastResp = j;
                var ms = (typeof j._srv_ms === 'number') ? j._srv_ms : (nowMs() - t0);
                S.lat.push(ms);
                if (S.lat.length > 160) S.lat.shift();
                if (S.learn) queueLearn(S.pendingPayload, j);
            })
            .catch(function (e) {
                S.inflight = 0;
                S.errCount++;
                S.lastErr = 'fetch 失败: ' + String(e && e.message || e);
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
            r: { total: null, result: null, survive: null, legal: null, rewardUnassigned: true }
        });
        if (S.learnBuf.length >= 8) flushLearn();
    }
    function flushLearn() {
        if (!S.learnBuf.length) return;
        var batch = S.learnBuf.splice(0, S.learnBuf.length);
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

    // ============================================================
    // 六、服务端状态 + 面板统计
    // ============================================================
    function refreshServerStatus(cb) {
        fetch('/vt_policy/status').then(function (r) { return r.json(); }).then(function (st) {
            S.server = st;
            if (S.on && st && st.ok) {
                setStatus('神经网络已接管 ' + S.tankId + ' · 服务端 ' + (st.running ? '已加载' : '未启动') +
                          ' · 权重 ' + (st.ckpt || st.defaultCkpt) + ' · 请求 ' + st.requests, 'ok');
            }
            if (cb) cb(st);
        }).catch(function (e) {
            S.server = { ok: false, err: String(e && e.message || e) };
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
        lines.push('服务端: ' + (S.server ? ((S.server.running ? 'running' : 'idle') + ' · 权重 ' + (S.server.ckpt || S.server.defaultCkpt) + ' · 请求 ' + S.server.requests) : '未取到'));
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
        lines.push('作弊开关: ' + (S.cheat ? '开（观测含 opp/col/mine，训练口径）' : '⚠ 关（opp/col/mine 置零 ⟹ 与训练分布不一致）'));
        if (S.lastErr) lines.push('最近错误: ' + S.lastErr);
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
                if (S.learn && S.learnBuf.length) flushLearn();
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
        status: function () { return { on: S.on, tankId: S.tankId, served: S.served, seq: S.seq, err: S.errCount, lastErr: S.lastErr, server: S.server, compat: S.compat }; }
    };

    function boot() {
        log('已加载 v' + VERSION + '（只扩展 T 面板；策略桥=/vt_inject_fire.js，推理=/vt_policy）');
        setTimeout(poll, 300);
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(boot, 300);
    else document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 300); });
})(typeof window !== 'undefined' ? window : this);
