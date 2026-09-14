/**
 * Vantage 调试工作台 v3（测试系统，见 docs/Vantage躲弹实现/测试系统.md）
 *
 * 2026-09-07 v80：
 *   T 键开面板、Y 键开树图；全局选路加“当前会变弱”警告。
 * 2026-09-07 v79：
 *   面板/树图仍然支持任意空白处拖动，但鼠标始终使用默认样式。
 * 2026-09-07 v78：
 *   默认使用重置配置；面板/树图空白处可拖动；树图文字优化。
 * 2026-09-07 v77（配合树 v91 / 沙箱 v34）：
 *   分类标题居中并加灰色分割线；“推荐预设”改为“重置配置”；
 *   面板可任意空白处拖动；压缩运行/树区冗余文字。
 * 2026-09-07 v76（配合树 v91 / 沙箱 v34）：
 *   预测时长滑块（1~15 秒）、剪枝补偿层数/持续帧数；生长栏淡黄色。
 * 2026-09-07 v75（配合树 v90 / 沙箱 v34）：
 *   树图默认贴地图右侧；面板/树图不再限制在屏幕内；
 *   实验项改为易懂名称、每类一种颜色、悬浮 0.5s 显示说明。
 * 2026-09-07 v74（配合树 v90 / 沙箱 v34）：
 *   Rust 物理默认开启；实验区新增“预热上限”、“回退节点数”、“回退帧数”；
 *   回退滑块改为 input 实时落值，避免拖动时被面板刷新弹回。
 * 2026-08-23 v48（配合树 v52：节点详情显示 rolloutTotal；新事件标签）：
 *   tree 选路已改 75 帧全累积总分，工作台同步显示 n.rolloutTotal；
 *   树事件增加 global-reroute / next-retarget / next-pruned-retarget 标签。
 * 2026-08-23 v49（配合树 v53：弹簧绳开关）：
 *   state.exp 增加 springRope:true；面板实验区新增“弹簧绳”开关；
 *   同步/初始化时调用 VantageTree.setSpringRopeEnabled。
 * 2026-08-23 v50（树事件标签补全）：
 *   treeEventMeta 增加 lazy-layer-updated / lazy-frontier /
 *   lazy-outside-updated 的事件颜色、简称与名称。
 * 2026-09-07 v63（配合桥 v10 / 沙箱 v33 / 树 v79 / scoring v32；面板显示 Rust评分/JS确认统计）：
 *   Rust 九操作评分 vt_score_paths 接入树 rolloutNine；版本号同步。
 * 2026-09-07 v60（配合桥 v9 / 沙箱 v32 / 树 v77）：
 *   实验区新增“无弹生长”复选框，绑定 VantageTree.setGrowWithoutThreatsEnabled；
 *   开启后树在无 threats 时继续生长（无子弹纯数据搬运/更新性能实验）。
 * 2026-09-07 v59（配合桥 v8 / 沙箱 v31 / 树 v76）：
 *   Rust vt_rescore_nodes 升级 ABI v4：节点可携带 previousScores，
 *   新弹帧级增量评分；testbench 仅版本号同步。
 * 2026-09-05 v54（Rust 物理开关也启用增量层刷新）：
 *   开启“Rust物理”后，树 stale 层刷新还会优先走
 *   VantageSandbox.rescoreTankSamples（vt_rescore_nodes，ABI v3），
 *   对已有 rolloutSamples 重评分 + 融合验证，不再重跑坦克物理。
 * 2026-09-05 v53（Rust 物理预测实验开关）：
 *   state.exp.rustPhysics 默认 false；面板实验区新增“Rust物理”；
 *   开启时初始化 VantageRustBridge 并调用
 *   VantageSandbox.setRustPhysicsEnabled(true)，树 rollouts 可走
 *   vt_rollout_batch 预测；关闭时回退 JS 融合世界。
 * 2026-09-05 v52（Rust 最小决策实验开关）：
 *   state.exp.rustMinimal 默认 false；面板实验区新增“Rust最小”；
 *   开启时 VantageTree.setRustMinimalEnabled(true) 并初始化
 *   VantageRustBridge；关闭时回退 JS 选路。
 * 2026-08-23 v51（弹簧绳默认关）：
 *   配合 scoring v27 / tree v57，state.exp.springRope 默认改为 false。
 * 2026-08-23 v46（树图死亡颜色分档 + 紧凑主干布局）：
 *   drawTree 节点颜色按 fullDeathFrame 分档（绿/红/橙红/橙/黄/浅绿）；
 *   单条深链主干沿 next 拉直，浅叶兄弟紧贴父节点，不再累积大梯形空白。
 * 2026-08-23 v44（地图渲染性能修复 + 树图分层布局）：
 *   renderTreeViz 增加可见世界包围盒裁剪；活动节点>120 只画金线尾迹，
 *   >300 父子连线也只画金线边；state.mapRender 记录实际绘制量。
 *   drawTree 改为分层分支布局，见 TB_VERSION v43/v44 注释。
 *
 * 三件独立设施：
 *   1. 时间控制器 —— 暂停游戏+AI（一停俱停）/ 单帧递进（固定 0.02s = 沙箱 FRAME_DT）
 *   2. 探针       —— 暂停瞬间主动重算快照；运行中每帧自动算全套（性能测试模式）
 *   3. 渲染器     —— 冻结画面标注 + DOM 数据面板（可拖动、带鼠标按钮）+ 沙箱虚影
 *
 * 挂载点：游戏类是 Classy 类系统（实例原型 = 类对象.__methods 表），
 *   补丁挂 Game.UIGameState.__methods.update / GameController.__methods.update。
 *
 * v3 变更（主人 2026-08-14 反馈）：
 *   - 9 操作沙箱模拟全自动（暂停后自动跑，无需手动点）；主面板常驻显示最优操作
 *   - 运行中（面板开着时）每帧自动算 威胁+基准时间+单帧分+9操作，显示每帧计算耗时（性能测试）
 *   - B 键任意时刻可开面板（不再必须先暂停）；面板可拖动；暂停/步进/标注/导出 全部有鼠标按钮
 *
 * 键位（游戏侧）：P 暂停/恢复  N 递进一帧  Shift+N ×10  V 标注  T 面板  Y 树图  E 导出
 * 键位（沙箱侧）：→ 单帧  Shift+→ ×10  ← 回退  Home 起点  Esc 退出
 *
 * v11 变更（2026-08-15）：
 *   - AI 操控区元素改 ctrl.querySelector（getElementById 对未入文档树的面板返回
 *     null → syncAiControl 必炸 → 面板全空，上轮真凶）
 *   - updatePanel 拆分 + 入口兜底：渲染异常降级为面板红字，绝不炸调用链
 *   - 新增 TB_VERSION 版本自报（console 启动行 + VantageTestbench.VERSION）——
 *     连续两轮"修一个错另一个"实为浏览器缓存旧版 js，版本必须可一眼核验
 */
(function(global) {
    'use strict';

    var TB_VERSION = 'v80';   // 与 index.html ?v= 同步递增；console/断言脚本可查
    // v51（2026-08-23）：弹簧绳默认关。
    // v50（2026-08-23）：树事件标签补 lazy 系列。
    // v49（2026-08-23）：配合树 v53，面板新增弹簧绳开关并同步树配置。
    // v48（2026-08-23）：配合树 v52，节点详情显示 rolloutTotal（75帧全累积总分）。
    // v47（2026-08-23）：节点详情显示计划/实际/死亡帧/段均分；树图标注金线断因。
    //   只读诊断，不改树决策。死亡标签不再写“75帧死”，直接显示 fullDeathFrame。
    // v44（2026-08-23）：地图渲染视口裁剪 + 节点阈值降载；树图事件标签修正已并入 v43。
    // v41（2026-08-23）：lane 开关改为调用 VantageTree.setLaneEnabled，树内车道压分真正可用。

    var FRAME_DT_MS = 20;          // 单帧递进步长（毫秒）= 沙箱 FRAME_DT × 1000
    var FRAME_DT_SEC = FRAME_DT_MS / 1000;
    var MAX_SNAPSHOTS = 600;
    var MAX_HISTORY = 300;
    // v7.4→v7.6 实验模式常量：固定帧数改由 state.exp.evalFrames（滑块 1~300，
    // 默认 75）持有，静态常量退役

    var state = {
        paused: false,
        stepping: false,
        stepQueue: 0,
        frameCount: 0,             // 暂停期间累计递进帧序号（≡ history 点数）
        vizOn: true,
        panelOn: false,            // 默认关；B 开（运行中开 = 性能测试模式）
        snapshots: [],
        history: [],
        lastSnapshot: null,
        expanded: null,            // （v7.7 退役，保字段防旧引用炸——读侧已全改 expandedSet）
        expandedThreat: null,
        sandbox: null,             // 暂停态 9 操作（自动跑）
        treePreview: null,         // 树节点虚影预览 {node, frameIdx}
        live: null,                // 运行态每帧数据 {tankState, threats, baseTime, results, bestIdx}
        perf: { last: 0, avg: 0, max: 0, n: 0 },  // 运行态每帧轻计算耗时（毫秒）
        perfLightMs: 0,         // 最近一帧轻计算耗时
        perfNineMs: 0,          // 最近一轮 9 操作耗时
        perfNineCount: 0,       // 9 操作累计轮次
        mapRender: { totalNodes: 0, nodesDrawn: 0, tailSegments: 0, tailDots: 0 },  // v44：地图渲染裁剪诊断
        errLight: null,         // 轻计算异常（面板显形，不再吞）
        errNine: null,          // 9 操作/沙箱异常（面板显形）
        errRun: null,           // perfTick 链顶层异常（含熔断标志，面板红字 + stack 首行）
        // v6 AI 操控（主人 2026-08-15 要求）：enabled 时 AI 按选定操作驱动；
        // auto 时每帧取最高分操作。默认全关 = AI 静止。
        aiControl: { enabled: false, opIndex: 0, auto: false, tree: false },
        // v7.4 实验模式（主人 2026-08-15 A/B 对比：短基准 vs 长+软死亡）：
        //   fixed75 = 9 操作固定帧模拟，无视动态基准时间（帧数=滑块 evalFrames）
        //   noDeath = 死亡不扣 10 万，只在死亡帧停止累加（长窗下比整段安全）
        //   lane = 车道压分开关（主人 2026-08-16 要求；关 = lanePenaltyRatio 0）
        //   springRope = 弹簧绳距离评分开关（主人 2026-08-23 要求；默认开）
        //   evalFrames = 固定帧滑块值（默认 75，1~300，主人 2026-08-16 要求）
        exp: { fixed75: false, noDeath: false, lane: false, springRope: false, rustMinimal: false, rustPhysics: true, growWithoutThreats: true, growLayers: 1, maxNodes: 500, warmupMaxNodes: 500, nodeCap: false, horizonCap: true, horizonSec: 8, refineBeyond: true, continuousRefine: false, pruneCompensateLayers: 0, pruneCompensateFrames: 1, retreatNodes: 3, retreatFrames: 200, deepSelect: false, evalFrames: 75 },
        lastLive: null,       // AI 死亡前的 live 冻结（面板布局保留，主人 2026-08-16 要求）
        fps: 0,               // v7.7 游戏帧率（perfTick 间隔滑动平均）
        expandedSet: {},      // v7.7 多开折叠区（旧单值 expanded 退役）
        treeViewOn: false,    // v7.8 交互式树视图（T 键 / 面板「树图」按钮）
    };

    var _gfx = null;
    var _uiPatched = false;
    var _gcPatched = false;
    var _perfDead = false;   // 运行态计算熔断标志（perfTick 炸过一次后停，P 暂停重置）

    // ============================================================
    // 一、时间控制器（Classy __methods 挂载）
    // ============================================================

    function patchUIGameState() {
        if (typeof Game === 'undefined' || !Game.UIGameState) return false;
        var methods = Game.UIGameState.__methods;
        if (!methods || !methods.update) return false;
        if (_uiPatched) return true;
        var orig = methods.update;
        methods.update = function() {
            if (state.paused) {
                if (state.stepQueue > 0) {
                    state.stepQueue--;
                    state.stepping = true;
                    var t = this.game && this.game.time;
                    var savedMS, savedS;
                    if (t) {
                        savedMS = t.physicsElapsedMS; savedS = t.physicsElapsed;
                        t.physicsElapsedMS = FRAME_DT_MS;
                        t.physicsElapsed = FRAME_DT_SEC;
                    }
                    try {
                        orig.apply(this, arguments);
                    } finally {
                        if (t) { t.physicsElapsedMS = savedMS; t.physicsElapsed = savedS; }
                        state.stepping = false;
                    }
                    state.frameCount++;
                    // 同协议：递进链上的 afterStep（快照+9操作+渲染+面板）也兜底
                    try {
                        afterStep(true);
                    } catch (eStep) {
                        state.errNine = '暂停递进链异常: ' +
                            (eStep && eStep.message ? eStep.message : eStep);
                        console.error('[Testbench] afterStep 异常:', eStep);
                    }
                }
                return;
            }
            var r = orig.apply(this, arguments);
            // 运行态计算挂在游戏 update 链上——任何异常冒泡都会打断 Phaser
            // RAF 主循环 = 游戏永久冻结（v4 时代实锤过一次，v6.2 又犯）。
            // 协议：补丁边界全链路兜底 + 一次性熔断 + 炸点显形到面板。
            if (state.panelOn && !_perfDead) {
                try {
                    perfTick();
                } catch (eRun) {
                    _perfDead = true;   // 熔断：停止后续帧的运行态计算，保游戏不死
                    var stk = eRun && eRun.stack ? String(eRun.stack).split('\n') : [];
                    state.errRun = 'perfTick 已熔断: ' +
                        (eRun && eRun.message ? eRun.message : eRun) +
                        (stk[1] ? ' | ' + stk[1].trim() : '');
                    console.error('[Testbench] perfTick 异常（已熔断，P 暂停可重试）:', eRun);
                    try { updatePanel(); } catch (eP) {}
                }
            }
            return r;
        };
        _uiPatched = true;
        return true;
    }

    function patchGameController() {
        if (typeof GameController === 'undefined' || !GameController.__methods) return false;
        var methods = GameController.__methods;
        if (!methods.update) return false;
        if (_gcPatched) return true;
        var orig = methods.update;
        methods.update = function() {
            if (state.stepping) {
                this.lastUpdate = new Date(Date.now() - FRAME_DT_MS);
            }
            return orig.apply(this, arguments);
        };
        _gcPatched = true;
        return true;
    }

    function inGameState() {
        var game = typeof GameManager !== 'undefined' && GameManager.getGame
            ? GameManager.getGame() : null;
        return !!(game && game.state && game.state.current === 'Game');
    }

    function togglePause() {
        if (!inGameState()) return;
        state.paused = !state.paused;
        state.stepQueue = 0;
        if (state.paused) {
            afterStep(false);          // 第 0 帧基准采集（自动跑 9 操作）
        } else {
            var ctx = getPhaserCtx();
            if (ctx && ctx.state.gameController) {
                ctx.state.gameController.lastUpdate = new Date();
            }
            state.sandbox = null;
            // v63：取消暂停时保留折叠区展开状态；运行态树详情不再每次自动收起。
            state.expandedThreat = null;
            _perfDead = false;         // 熔断解除：暂停修复现场后恢复运行重试
            state.errRun = null;
            clearGfx();
            updatePanel();
        }
        console.log('[Testbench] ' + (state.paused ? '已暂停（游戏+AI 同步冻结）' : '恢复运行'));
    }

    function requestStep(n) {
        if (!state.paused) return;
        state.stepQueue += (n || 1);
    }

    // ============================================================
    // 二、探针
    // ============================================================

    function findVantageManager() {
        if (typeof AIs === 'undefined' || !AIs.aiManagers) return null;
        for (var i = 0; i < AIs.aiManagers.length; i++) {
            var m = AIs.aiManagers[i];
            if (m && m.isVantage) return m;
        }
        return null;
    }

    function getAdapter(ai) {
        return ai._vantageAdapter || VantageSandbox.createAdapter(ai.gameController, ai.aiId);
    }

    /** 冻结帧快照：主动重算（含 baseTime.details），不用 AI 活数据 */
    function captureSnapshot() {
        if (typeof VantageSandbox === 'undefined' || typeof VantageScoring === 'undefined') {
            return null;
        }
        var m = findVantageManager();
        if (!m || !m.ai) return null;
        var ai = m.ai;
        var gc = ai.gameController;
        if (!gc || !gc.getTank || !gc.getTank(ai.aiId)) return null;

        var adapter = getAdapter(ai);
        if (!adapter) return null;
        var tankState = adapter.getTankState();
        if (!tankState) return null;

        var threats = VantageScoring.computeThreats(adapter, tankState);
        var baseTime = VantageScoring.computeBaseTime(threats, null, adapter.constants);

        var bullets = adapter.getProjectiles();
        var positions = [];
        for (var i = 0; i < bullets.length; i++) {
            positions.push({ x: bullets[i].x, y: bullets[i].y });
        }
        var frame = VantageScoring.scoreFrame(adapter, tankState, positions);
        var headingOk = frame.dead
            ? true
            : VantageScoring.headingInFreeIntervals(tankState.rot, frame.freeIntervals);

        return {
            frameNo: state.frameCount,
            at: Date.now(),
            tankState: tankState,
            threats: threats,
            baseTime: baseTime,
            frameScore: frame,
            headingInFree: headingOk
        };
    }

    function afterStep(record) {
        var snap = captureSnapshot();
        state.lastSnapshot = snap;
        if (snap) {
            state.snapshots.push(snap);
            if (state.snapshots.length > MAX_SNAPSHOTS) state.snapshots.shift();
            if (record) {
                state.history.push({
                    frame: snap.frameNo,
                    score: snap.frameScore.frameScore,
                    baseTimeSec: snap.baseTime.baseTimeSec
                });
                if (state.history.length > MAX_HISTORY) state.history.shift();
            }
        }
        if (record) {
            state.expandedThreat = null;
        }
        runNineOps();               // v3：自动跑 9 操作（暂停/递进后无需手动点）
        renderViz();
        updatePanel();
    }

    // ============================================================
    // 三、9 操作沙箱（全自动）+ 运行态性能测试
    // ============================================================

    /** 实验模式 → scorePath cfg 覆盖（v7.6：车道压分开关并入） */
    function expCfgOverride() {
        var o = {};
        if (state.exp.noDeath) o.deathPenalty = 0;
        if (!state.exp.lane) o.lanePenaltyRatio = 0;
        if (!state.exp.springRope) o.springRopeEnabled = false;
        for (var k in o) return o;   // 非空即返回
        return null;                 // 全默认 → 不传 cfg（走模块默认）
    }

    /** v24 性能闸门：面板侧 rollout 只保留最紧迫的 8 颗子弹。
     *  霰弹枪等大量弹同时存在时，避免每帧对 20+ 条折线做完整采样。 */
    var PANEL_MAX_BULLETS = 40;
    function limitPanelThreats(threats) {
        if (!threats || threats.length <= PANEL_MAX_BULLETS) return threats;
        return threats.slice().sort(function(a, b) {
            var at = (a.tIn !== null && a.tIn !== undefined) ? a.tIn : 999;
            var bt = (b.tIn !== null && b.tIn !== undefined) ? b.tIn : 999;
            if (at !== bt) return at - bt;
            return ((a.closestDist !== undefined ? a.closestDist : 999) -
                    (b.closestDist !== undefined ? b.closestDist : 999));
        }).slice(0, PANEL_MAX_BULLETS);
    }

    /** 对 9 种操作各跑一次 scorePath（= 模拟 + 逐帧积累评分），并选出最优 */
    function computeNineOps(adapter, tankState, threats, frames) {
        var simState0 = VantageSandbox.createNodeSimState(tankState, 0);
        var ops = VantageSandbox.OPERATIONS;
        var cfgOv = expCfgOverride();
        var results = [];
        var bestIdx = -1;
        for (var i = 0; i < ops.length; i++) {
            var r = VantageScoring.scorePath(adapter, simState0, ops[i].inputs, frames, threats, cfgOv);
            r.opIndex = i;
            r.opName = ops[i].name;
            results.push(r);
            if (bestIdx < 0 || r.totalScore > results[bestIdx].totalScore) bestIdx = i;
        }
        return { results: results, bestIdx: bestIdx, frames: frames };
    }

    /** 暂停态：以冻结帧为父状态自动跑 9 操作 */
    function runNineOps() {
        var snap = state.lastSnapshot;
        if (!snap) return;
        var m = findVantageManager();
        var ai = m && m.ai;
        if (!ai) return;
        var adapter = getAdapter(ai);
        if (!adapter) return;
        try {
            // v7.4→v7.6 实验模式：fixed = 无视动态基准，固定帧长（滑块可调）
            var frames = state.exp.fixed75 ? state.exp.evalFrames : snap.baseTime.baseTimeFrames;
            var out = computeNineOps(adapter, snap.tankState, limitPanelThreats(snap.threats), frames);
            state.sandbox = {
                results: out.results,
                bestIdx: out.bestIdx,
                frames: out.frames,
                adapter: adapter,
                threats: snap.threats,
                tankState0: snap.tankState,
                activeOp: null,
                simSamples: null,
                frameIdx: 0
            };
            state.errNine = null;
        } catch (e) {
            state.errNine = '暂停态9操作异常: ' + (e && e.message ? e.message : e);
            console.warn('[Testbench] 9 操作模拟异常:', e);
            return;
        }
        // 树骨架第 1 步（03 一.2）：9 操作结果 → 段长探测（纯后处理）
        try {
            state.sandbox.segment = (typeof VantageTree !== 'undefined')
                ? VantageTree.probeSegment(out.results) : null;
        } catch (eSeg) {
            state.sandbox.segment = null;
            console.warn('[Testbench] 段长探测异常:', eSeg);
        }
    }

    /**
     * 运行态计算分层（v6.2，2026-08-15）：
     * v6 运行态全灭的真凶 = 沙箱 SetTransform 传错参数（本 Box2D 版本只收
     * 单个 b2Transform，两参摆位须用 SetPositionAndAngle）→ 每次必炸被
     * catch 吞掉 → live 数据永不生成 → 没算没渲染。已修（见 sandbox v6.1）。
     * 离线实测（真 Box2D 源码，node）：9 操作×75 帧一轮 ≈ 7ms（最差 18ms）、
     * 首建克隆世界 4.3ms——主人说的个位数毫秒正确，此前"百 ms 级"是臆断。
     * 分层保留（面板实时性 + 帧预算友好），间隔按实测数据收窄：
     *   轻计算（每帧）：威胁+基准+单帧分 → 渲染/面板
     *   9 操作（节流）：间隔 = clamp(上轮耗时×2, 30ms, 200ms)，约每 2 帧一轮
     */
    var _lastNineAt = 0;
    var _nineInterval = 30;
    // v6.3 分帧切片状态：每帧只算 OPS_PER_FRAME 个操作（≈1.5ms/帧），
    // 一轮 9 操作跨 5 帧完成——同步阻塞从"一轮全算"（真实迷宫下可能
    // 50~150ms×每 30ms = 帧率雪崩 = 死机体感）摊薄成恒定小开销。
    var _nineSlice = null;   // { adapter, tankState, threats, frames, idx, results, t0, round }

    var _lastPanelFlush = 0;
    var PANEL_FLUSH_MS = 80;   // v7.3：运行态数据区刷新节流（~12Hz）——
                               // 每帧 innerHTML 全量重建既费 DOM 又与点击竞态；
                               // 交互路径（handlePanelAction/暂停）不节流即时刷

    var _fpsWindow = [];       // v24 FPS：最近1秒的 perfTick 时间戳窗口
    var _lightSkip = 0;        // v26：多弹时轻计算隔帧跑，削小尖峰
    var _vizSkip = 0;          // v26：地图标注隔帧重画

    function perfTick() {
        // v30.2：树视图独立于主面板刷新——旧逻辑只在 panelOn 且未暂停时
        // 走 updatePanel→drawTree 链，面板一关树图就永远冻结（主人报
        // "树图不画"的入口之一）。现在只要树视图开着且游戏在跑，就每帧重绘。
        if (state.treeViewOn && _tv && !state.paused) {
            try { drawTree(); } catch (eTv) {}
        }
        if (!state.panelOn || state.paused) return;
        // v24 FPS 修正：旧算法丢弃 >500ms 的卡顿间隔，卡顿后反而显示高帧率。
        // 新算法统计最近 1 秒窗口内实际发生了几次 perfTick；卡顿会真实拉低数值。
        var now = performance.now();
        _fpsWindow.push(now);
        while (_fpsWindow.length && now - _fpsWindow[0] > 1000) _fpsWindow.shift();
        if (_fpsWindow.length >= 2) {
            state.fps = (_fpsWindow.length - 1) * 1000 / (now - _fpsWindow[0]);
        }
        // v26：轻计算（computeThreats）是每帧小尖峰的主要来源之一。
        // 弹多时隔 1~2 帧算一次；AI 树模式不依赖 state.live，面板数字仍够新。
        if (_lightSkip > 0) {
            _lightSkip--;
        } else {
            lightPerf();
            _lightSkip = (state.live && state.live.threats && state.live.threats.length > 8) ? 2 : 0;
        }
        if (_nineSlice) {
            nineSliceStep();                     // 一轮进行中：每帧切一片
        } else if (!state.aiControl.tree && now - _lastNineAt >= _nineInterval) {
            // v26：树模式不再每帧维护自动模式的 9 操作表（AI 决策不读它），
            // 只在自动/手动模式开启。树模式下面板省掉这一整块开销。
            _lastNineAt = now;
            nineSliceStart();                    // 到点：开新轮（首片本帧执行）
            nineSliceStep();
        }
        // v26：地图标注隔帧重画；Phaser 画面本身仍每帧渲染，视觉几乎无差。
        if (_vizSkip > 0) {
            _vizSkip--;
        } else {
            renderViz();      // 独立于任何 try 块，计算炸了也渲染
            _vizSkip = 1;
        }
        if (now - _lastPanelFlush >= PANEL_FLUSH_MS) {
            _lastPanelFlush = now;
            updatePanel();
        }
    }

    /** 轻计算：威胁+基准时间+单帧分（每帧；数据进 state.live 供渲染/面板） */
    function lightPerf() {
        if (typeof VantageSandbox === 'undefined' || typeof VantageScoring === 'undefined') return;
        var m = findVantageManager();
        if (!m || !m.ai) return;
        var ai = m.ai;
        if (!ai.gameController || !ai.gameController.getTank || !ai.gameController.getTank(ai.aiId)) {
            // v7.4：AI 死亡/未入局 → 清 live。残影冻结 = 主人实测"死亡后轨迹
            // 渲染错误"的根因：旧折线与真弹位置持续错位还一直画。清空后
            // renderViz 数据源为空自动停画，重生后自然恢复。
            // v7.6：live 冻结进 lastLive（面板用死亡前数据保布局——主人嫌
            // 死亡后面板全空、回来还要重新展开折叠区，麻烦）。
            if (state.live) state.lastLive = state.live;
            state.live = null;
            return;
        }

        var t0 = performance.now();
        try {
            var adapter = getAdapter(ai);
            var tankState = adapter.getTankState();
            if (!tankState) return;
            var threats = VantageScoring.computeThreats(adapter, tankState);
            var baseTime = VantageScoring.computeBaseTime(threats, null, adapter.constants);
            var bulletsNow = [];
            var panelThreats = limitPanelThreats(threats);
            for (var bi = 0; bi < panelThreats.length; bi++) {
                bulletsNow.push({ x: panelThreats[bi].x, y: panelThreats[bi].y });
            }
            var frameScore = VantageScoring.scoreFrame(adapter, tankState, bulletsNow);
            if (!state.live) state.live = {};
            state.live.tankState = tankState;
            state.live.threats = threats;
            state.live.baseTime = baseTime;
            state.live.frameScore = frameScore;
            // v7.1 面板统一：运行态实时分数也入 history（与暂停递进共用曲线，
            // 横轴 = 最近 300 次采样：递进帧/运行帧混排，看趋势不看绝对帧号）
            state.history.push({
                frame: state.history.length,
                score: frameScore.frameScore,
                baseTimeSec: baseTime.baseTimeSec
            });
            if (state.history.length > MAX_HISTORY) state.history.shift();
            state.errLight = null;
        } catch (e) {
            state.errLight = '轻计算异常: ' + (e && e.message ? e.message : e);
        }
        state.perfLightMs = performance.now() - t0;
        state.perf.last = state.perfLightMs;
        state.perf.n++;
        state.perf.avg = state.perf.avg * 0.9 + state.perfLightMs * 0.1;
        if (state.perfLightMs > state.perf.max) state.perf.max = state.perfLightMs;
    }

    /** 9 操作轮启动：固定本轮输入快照（轮进行中坦克/子弹变化不干扰本轮） */
    function nineSliceStart() {
        if (!state.live || !state.live.tankState || !state.live.threats || !state.live.baseTime) return;
        var m = findVantageManager();
        if (!m || !m.ai) return;
        try {
            var adapter = getAdapter(m.ai);
            _nineSlice = {
                adapter: adapter,
                tankState: state.live.tankState,
                threats: limitPanelThreats(state.live.threats),
                // v7.4→v7.6 实验模式：fixed 固定帧长（滑块），否则动态基准时间
                frames: state.exp.fixed75 ? state.exp.evalFrames : state.live.baseTime.baseTimeFrames,
                idx: 0,
                results: [],
                t0: performance.now(),
                computeMs: 0,   // v7.7：纯计算累计（挂钟含跨帧等待，主人指出显示有误）
                round: state.perfNineCount + 1
            };
        } catch (e) {
            state.errNine = '9操作启动异常: ' + (e && e.message ? e.message : e);
            _nineSlice = null;
        }
    }

    /** 9 操作切片推进：每帧最多 OPS_PER_FRAME 个操作（单操作≈0.8ms 实测） */
    var OPS_PER_FRAME = 2;

    function nineSliceStep() {
        var slice = _nineSlice;
        if (!slice) return;
        var ops = VantageSandbox.OPERATIONS;
        // v7.6：统一走 expCfgOverride（noDeath + lane 开关合并）
        var cfgOv = expCfgOverride();
        var tSlice0 = performance.now();
        try {
            var n;
            for (n = 0; n < OPS_PER_FRAME && slice.idx < ops.length; n++, slice.idx++) {
                var r = VantageScoring.scorePath(slice.adapter,
                    VantageSandbox.createNodeSimState(slice.tankState, 0),
                    ops[slice.idx].inputs, slice.frames, slice.threats, cfgOv);
                r.opIndex = slice.idx;
                r.opName = ops[slice.idx].name;
                slice.results.push(r);
            }
            slice.computeMs += performance.now() - tSlice0;   // v7.7 纯计算累计
            state.errNine = null;
        } catch (e) {
            slice.computeMs += performance.now() - tSlice0;
            state.errNine = '9操作切片异常(idx=' + slice.idx + '): ' +
                (e && e.message ? e.message : e);
            _nineSlice = null;   // 本轮作废，下个间隔重开
            return;
        }
        if (slice.idx >= ops.length) {
            // 轮完成：选优、并入 live、按实测自适应间隔
            var bestIdx = -1;
            for (var i = 0; i < slice.results.length; i++) {
                if (bestIdx < 0 || slice.results[i].totalScore > slice.results[bestIdx].totalScore) bestIdx = i;
            }
            if (!state.live) state.live = {};
            state.live.results = slice.results;
            state.live.bestIdx = bestIdx;
            state.live.frames = slice.frames;
            // 树骨架第 1 步（03 一.2）：段长探测（纯后处理，不炸九操作链）
            try {
                state.live.segment = (typeof VantageTree !== 'undefined')
                    ? VantageTree.probeSegment(slice.results) : null;
            } catch (eSeg) {
                state.live.segment = null;
            }
            state.perfNineMs = slice.computeMs;   // v7.7：纯计算耗时（非挂钟）
            state.perfNineCount = slice.round;
            // 轮间隔节奏仍按挂钟×2（纯计算太快会把轮次贴满跑，负载失衡）
            _nineInterval = Math.min(200, Math.max(30, (performance.now() - slice.t0) * 2));
            _nineSlice = null;
        }
    }

    function enterSandboxOp(opIndex) {
        var sb = state.sandbox;
        if (!sb || !sb.results[opIndex]) return;
        var sim = sb.adapter.simulateTank(
            sb.tankState0, VantageSandbox.OPERATIONS[opIndex].inputs, sb.frames);
        sb.activeOp = opIndex;
        sb.simSamples = sim.samples;
        sb.frameIdx = 0;
        renderViz();
        updatePanel();
    }

    function sbMaxIdx() {
        var sb = state.sandbox;
        var r = sb.results[sb.activeOp];
        var cap = Math.min(sb.frames, sb.simSamples.length - 1);
        if (r.dead && r.deathFrame >= 0) cap = Math.min(cap, r.deathFrame);
        return cap;
    }

    function sbStep(n) {
        var sb = state.sandbox;
        if (!sb || sb.activeOp === null) return;
        sb.frameIdx = Math.max(0, Math.min(sbMaxIdx(), sb.frameIdx + n));
        renderViz();
        updatePanel();
    }

    function sbExit() {
        var sb = state.sandbox;
        if (!sb) return;
        sb.activeOp = null;
        sb.simSamples = null;
        sb.frameIdx = 0;
        renderViz();
        updatePanel();
    }

    // ============================================================
    // 四、渲染器（冻结画面标注 + 沙箱虚影）
    // ============================================================

    function getPhaserCtx() {
        var game = typeof GameManager !== 'undefined' && GameManager.getGame
            ? GameManager.getGame() : null;
        if (!game || !game.state || game.state.current !== 'Game') return null;
        var st = game.state.getCurrentState();
        if (!st || !st.gameGroup) return null;
        return { game: game, state: st, group: st.gameGroup };
    }

    function metersToPx(m) {
        var ppm = (typeof Constants !== 'undefined' && Constants.PIXELS_PER_METER)
            ? Constants.PIXELS_PER_METER : 20;
        return m * ppm;
    }

    function ensureGfx() {
        var ctx = getPhaserCtx();
        if (!ctx) return null;
        if (_gfx && !_gfx.destroyed && _gfx.parent === ctx.group) return _gfx;
        clearGfx();
        _gfx = ctx.game.add.graphics(0, 0);
        _gfx.name = 'ttVantageBench';
        ctx.group.add(_gfx);
        if (typeof _gfx.bringToTop === 'function' && _gfx.parent) _gfx.bringToTop();
        return _gfx;
    }

    function clearGfx() {
        if (_gfx) {
            try {
                if (_gfx.parent) _gfx.parent.remove(_gfx);
            } catch (e1) {}
            try { _gfx.destroy(); } catch (e2) {}
            _gfx = null;
        }
    }

    function drawDashedPolyline(g, pts, color, width, alpha) {
        if (!pts || pts.length < 2) return;
        var dash = 8, gap = 6;
        var i, p0x, p0y, p1x, p1y, dx, dy, len, ux, uy, pos, drawOn, seg;
        for (i = 1; i < pts.length; i++) {
            p0x = metersToPx(pts[i - 1].x); p0y = metersToPx(pts[i - 1].y);
            p1x = metersToPx(pts[i].x); p1y = metersToPx(pts[i].y);
            dx = p1x - p0x; dy = p1y - p0y;
            len = Math.sqrt(dx * dx + dy * dy);
            if (len < 0.5) continue;
            ux = dx / len; uy = dy / len;
            pos = 0; drawOn = true;
            g.lineStyle(width || 1, color, alpha || 0.8);
            while (pos < len) {
                seg = Math.min(drawOn ? dash : gap, len - pos);
                if (drawOn) {
                    g.moveTo(p0x + ux * pos, p0y + uy * pos);
                    g.lineTo(p0x + ux * (pos + seg), p0y + uy * (pos + seg));
                }
                pos += seg;
                drawOn = !drawOn;
            }
        }
    }

    function drawCross(g, mx, my, size, color) {
        var x = metersToPx(mx), y = metersToPx(my);
        g.lineStyle(2, color, 0.95);
        g.moveTo(x - size, y); g.lineTo(x + size, y);
        g.moveTo(x, y - size); g.lineTo(x, y + size);
    }

    /** 扇形（折线逼近弧）；角度为游戏朝向角（0=朝上） */
    function drawWedge(g, cxM, cyM, radiusM, startTheta, endTheta, color, alpha) {
        var cx = metersToPx(cxM), cy = metersToPx(cyM);
        var r = metersToPx(radiusM);
        var segs = 16;
        var span = endTheta - startTheta;
        g.beginFill(color, alpha);
        g.moveTo(cx, cy);
        for (var i = 0; i <= segs; i++) {
            var theta = startTheta + span * i / segs;
            g.lineTo(cx + Math.sin(theta) * r, cy - Math.cos(theta) * r);
        }
        g.lineTo(cx, cy);
        g.endFill();
    }

    /** 坦克虚影车体轮廓（画法同 ai_dodge_debug.js 的 drawHullOBB，ext 为像素） */
    function drawHullOBB(g, cx, cy, rot, ext, color, lineAlpha, fillAlpha) {
        var hw = ext.hw;
        var hf = ext.halfForward !== undefined ? ext.halfForward : ext.hl;
        var hb = ext.halfBack !== undefined ? ext.halfBack : ext.hl;
        var fX = Math.sin(rot), fY = -Math.cos(rot);
        var rX = Math.cos(rot), rY = Math.sin(rot);
        var corners = [
            [cx + fX * hf + rX * hw, cy + fY * hf + rY * hw],
            [cx + fX * hf - rX * hw, cy + fY * hf - rY * hw],
            [cx - fX * hb - rX * hw, cy - fY * hb - rY * hw],
            [cx - fX * hb + rX * hw, cy - fY * hb + rY * hw]
        ];
        g.lineStyle(2, color, lineAlpha);
        g.beginFill(color, fillAlpha);
        g.moveTo(corners[0][0], corners[0][1]);
        for (var i = 1; i < 4; i++) g.lineTo(corners[i][0], corners[i][1]);
        g.lineTo(corners[0][0], corners[0][1]);
        g.endFill();
    }

    function tankExtPx() {
        return {
            hw: metersToPx((Constants.TANK.WIDTH.m || 4) * 0.5),
            halfForward: metersToPx((Constants.TANK.HEIGHT.m || 5) * 0.5),
            halfBack: metersToPx((Constants.TANK.HEIGHT.m || 5) * 0.5)
        };
    }

    function threatColor(tEnd) {
        if (tEnd < 0.5) return 0xff3355;   // 红：窗口将关，火烧眉毛
        if (tEnd < 1.5) return 0xff9933;   // 橙：紧迫
        return 0x8899aa;                    // 灰：尚远
    }

    function renderViz() {
        if (!state.vizOn) { clearGfx(); return; }
        // v6：数据源 = 暂停态快照 / 运行态 live（主人要求不暂停也渲染）
        var src = state.paused ? state.lastSnapshot : state.live;
        if (!src) { clearGfx(); return; }
        var g = ensureGfx();
        if (!g) return;
        g.clear();

        var threats = src.threats;
        var baseTime = src.baseTime;
        var frameScore = src.frameScore;
        var tank = src.tankState;
        if (!threats || !baseTime || !frameScore || !tank) { clearGfx(); return; }

        var i, th;
        // 1. 每颗威胁子弹的反射折线 + 最近点十字
        for (i = 0; i < threats.length; i++) {
            th = threats[i];
            if (!th.path || th.path.length < 2) continue;
            var col = !th.hasWindow ? 0x555a6e : threatColor(th.tEnd);  // 无关弹=暗灰
            drawDashedPolyline(g, th.path, col, th.id === baseTime.baseBulletId ? 2 : 1, th.hasWindow ? 0.7 : 0.35);
            if (th.closestX !== undefined) {
                drawCross(g, th.closestX, th.closestY, 6, col);
            }
        }
        // 2. 基准子弹高亮圈（黄圈 = 基准弹 = 最深窗口弹）
        for (i = 0; i < threats.length; i++) {
            th = threats[i];
            if (th.id === baseTime.baseBulletId) {
                g.lineStyle(3, 0xffee44, 0.95);
                g.drawCircle(metersToPx(th.x), metersToPx(th.y), 16);
            }
        }
        // 3. 遮蔽角扇区（红=遮蔽，绿=剩余；精确法区间与游戏 rot 同 convention）
        if (!frameScore.dead) {
            drawWedge(g, tank.x, tank.y, 2.6, 0, Math.PI * 2, 0xff3355, 0.18);
            for (i = 0; i < frameScore.freeIntervals.length; i++) {
                var iv = frameScore.freeIntervals[i];
                drawWedge(g, tank.x, tank.y, 2.6, iv.start, iv.start + iv.width, 0x44ee77, 0.22);
            }
        }
        // 4. 坦克朝向线
        var hx = tank.x + Math.sin(tank.rot) * 3;
        var hy = tank.y - Math.cos(tank.rot) * 3;
        g.lineStyle(2, 0x66ccff, 0.9);
        g.moveTo(metersToPx(tank.x), metersToPx(tank.y));
        g.lineTo(metersToPx(hx), metersToPx(hy));

        // 5. 危险圈 D_hit（青色实线圈，半径 10m——威胁窗口判定圈）+ 坦克外接圆（橙虚线感）
        var dHit = baseTime.details ? baseTime.details.hitRadius : 10;
        g.lineStyle(2, 0x66f7ff, 0.75);
        g.drawCircle(metersToPx(tank.x), metersToPx(tank.y), metersToPx(dHit) * 2);
        var geo = VantageScoring.exactGeom ? VantageScoring.exactGeom() : null;
        if (geo) {
            g.lineStyle(1.5, 0xffb86c, 0.55);
            g.drawCircle(metersToPx(tank.x), metersToPx(tank.y), metersToPx(geo.R_SEMI) * 2);
        }

        // 6. 沙箱虚影（仅暂停态）
        if (state.paused) renderSandboxViz(g);

        // 7. 整树预览（阶段③：树模式激活时画——节点末态色块 + 父子连线 +
        //    commitNode 高亮圈 + 白圈=根。色深 = subtreeBest 归一（蓝低→绿高），
        //    红 = dead（03 八节验收 3「近宽远尖纺锤」肉眼可判）
        renderTreeViz(g);
        renderTreeNodePreview(g);
    }

    /** 整树预览（阶段③ v3）。树模式激活才有树；<800 节点全画。
     *  金色粗线 = 预定路线（argmax 链，主人 2026-08-16 要求同步地图）——
     *  按各节点 rolloutSamples 头段逐帧拼出真实轨迹（非直线连接） */
    /** v44：地图渲染视口裁剪。返回可见世界范围（米）；拿不到相机则返回 null（不裁剪）。 */
    function getVisibleWorldBounds(g) {
        var cam = g.game && g.game.camera;
        if (!cam) return null;
        var ppm = (typeof Constants !== 'undefined' && Constants.PIXELS_PER_METER) ? Constants.PIXELS_PER_METER : 20;
        var m = 8;
        return {
            minX: cam.x / ppm - m,
            maxX: (cam.x + cam.width) / ppm + m,
            minY: cam.y / ppm - m,
            maxY: (cam.y + cam.height) / ppm + m
        };
    }

    function sampleBBox(n) {
        var bb = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
        var arr = n.rolloutSamples;
        if (arr && arr.length) {
            for (var i = 0; i < arr.length; i++) {
                var s = arr[i];
                if (!s) continue;
                if (s.x < bb.minX) bb.minX = s.x;
                if (s.x > bb.maxX) bb.maxX = s.x;
                if (s.y < bb.minY) bb.minY = s.y;
                if (s.y > bb.maxY) bb.maxY = s.y;
            }
        } else if (n.simState && n.simState.tank) {
            bb.minX = bb.maxX = n.simState.tank.x;
            bb.minY = bb.maxY = n.simState.tank.y;
        }
        return bb;
    }

    function bboxVisible(bb, vb) {
        if (!vb) return true;
        if (bb.minX > vb.maxX || bb.maxX < vb.minX || bb.minY > vb.maxY || bb.maxY < vb.minY) return false;
        return true;
    }

    function pxVisible(px, py, cam, marginPx) {
        if (!cam) return true;
        return px >= cam.x - marginPx && px <= cam.x + cam.width + marginPx &&
               py >= cam.y - marginPx && py <= cam.y + cam.height + marginPx;
    }

    function segVisiblePx(x0, y0, x1, y1, cam, marginPx) {
        if (!cam) return true;
        if ((x0 < cam.x - marginPx && x1 < cam.x - marginPx) ||
            (x0 > cam.x + cam.width + marginPx && x1 > cam.x + cam.width + marginPx) ||
            (y0 < cam.y - marginPx && y1 < cam.y - marginPx) ||
            (y0 > cam.y + cam.height + marginPx && y1 > cam.y + cam.height + marginPx)) return false;
        return true;
    }

    /** 整树预览（阶段③ v3）。v44：按可见世界范围裁剪 rollout 尾迹；
     *  节点数超过 120 只画金线尾迹，超过 300 父子连线也只画金线边。 */
    function renderTreeViz(g) {
        if (typeof VantageTree === 'undefined') return;
        var tr = VantageTree.getTree();
        if (!tr || !tr.root) return;
        var nodes = [];
        tr.walk(function (n) { nodes.push(n); });
        if (nodes.length > 800) return;
        var vb = getVisibleWorldBounds(g);
        var cam = g.game && g.game.camera;
        var marginPx = 40;
        var i, n;

        state.mapRender = state.mapRender || { totalNodes: 0, nodesDrawn: 0, tailSegments: 0, tailDots: 0 };
        state.mapRender.totalNodes = nodes.length;
        state.mapRender.nodesDrawn = 0;
        state.mapRender.tailSegments = 0;
        state.mapRender.tailDots = 0;

        var mn = Infinity, mx = -Infinity;
        for (i = 0; i < nodes.length; i++) {
            if (nodes[i].subtreeBest < mn) mn = nodes[i].subtreeBest;
            if (nodes[i].subtreeBest > mx) mx = nodes[i].subtreeBest;
        }
        var span = (mx - mn) || 1;
        var cp = tr.commitPath || [];

        function drawTail(n, style, alpha) {
            if (!n.rolloutSamples || n.rolloutSamples.length < 2) return;
            var bb = sampleBBox(n);
            if (!bboxVisible(bb, vb)) return;
            g.lineStyle(1, style, alpha);
            var p0 = n.rolloutSamples[0];
            var x0 = metersToPx(p0.x), y0 = metersToPx(p0.y);
            var started = false;
            for (var k = 1; k < n.rolloutSamples.length; k++) {
                var s2 = n.rolloutSamples[k];
                if (!s2) break;
                var x1 = metersToPx(s2.x), y1 = metersToPx(s2.y);
                if (segVisiblePx(x0, y0, x1, y1, cam, marginPx)) {
                    if (!started) { g.moveTo(x0, y0); started = true; }
                    g.lineTo(x1, y1);
                    state.mapRender.tailSegments++;
                } else {
                    started = false;
                }
                x0 = x1; y0 = y1;
            }
        }

        function drawTailDots(n, step, radius) {
            var arr = n.rolloutSamples;
            if (!arr || arr.length < 2) return;
            var bb = sampleBBox(n);
            if (!bboxVisible(bb, vb)) return;
            g.lineStyle(1, 0x89b4fa, 0.5);
            for (var k = step; k < arr.length; k += step) {
                var s = arr[k];
                if (!s) break;
                var x = metersToPx(s.x), y = metersToPx(s.y);
                if (!pxVisible(x, y, cam, marginPx)) continue;
                g.drawCircle(x, y, radius);
                state.mapRender.tailDots++;
            }
        }

        // 金线：淡金完整尾迹 + 亮金执行段
        if (cp.length) {
            g.lineStyle(1, 0xf9e2af, 0.32);
            for (var tp = 1; tp < cp.length; tp++) {
                drawTail(cp[tp], 0xf9e2af, 0.32);
            }
            g.lineStyle(3, 0xf9e2af, 0.95);
            var started = false;
            var rootTk = tr.root.simState && tr.root.simState.tank;
            if (rootTk) {
                var rtx = metersToPx(rootTk.x), rty = metersToPx(rootTk.y);
                if (pxVisible(rtx, rty, cam, marginPx)) { g.moveTo(rtx, rty); started = true; }
            }
            for (var p = 1; p < cp.length; p++) {
                var pn = cp[p];
                if (!pn.rolloutSamples || !pn.rolloutSamples.length) continue;
                var upto = Math.min(pn.segmentFrames, pn.rolloutSamples.length - 1);
                for (var k2 = 0; k2 <= upto; k2++) {
                    var s2 = pn.rolloutSamples[k2];
                    if (!s2) break;
                    var sx = metersToPx(s2.x), sy = metersToPx(s2.y);
                    if (!started) { if (pxVisible(sx, sy, cam, marginPx)) { g.moveTo(sx, sy); started = true; } }
                    else { g.lineTo(sx, sy); }
                }
            }
        }

        // 父子连线：节点>300 时只画 commitPath 边
        var cpSet = {};
        for (i = 0; i < cp.length; i++) cpSet[cp[i].id] = true;
        g.lineStyle(1, 0x89b4fa, 0.22);
        var drawAllEdges = nodes.length <= 300;
        for (i = 0; i < nodes.length; i++) {
            n = nodes[i];
            if (!n.parent || !n.simState || !n.parent.simState) continue;
            if (!drawAllEdges && !(cpSet[n.id] && cpSet[n.parent.id])) continue;
            var ebb = sampleBBox(n);
            var pbb = sampleBBox(n.parent);
            if (!bboxVisible(ebb, vb) && !bboxVisible(pbb, vb)) continue;
            var ex0 = metersToPx(n.parent.simState.tank.x), ey0 = metersToPx(n.parent.simState.tank.y);
            var ex1 = metersToPx(n.simState.tank.x), ey1 = metersToPx(n.simState.tank.y);
            if (!segVisiblePx(ex0, ey0, ex1, ey1, cam, marginPx)) continue;
            g.moveTo(ex0, ey0);
            g.lineTo(ex1, ey1);
        }

        // 非金线尾迹：节点>120 时只画金线
        var tailNodes = nodes.length > 120 ? cp : nodes;
        for (i = 0; i < tailNodes.length; i++) {
            n = tailNodes[i];
            if (!n.rolloutSamples || n.rolloutSamples.length < 2) continue;
            drawTail(n, 0x89b4fa, 0.25);
            drawTailDots(n, 15, 1.8);
        }

        // 节点块（只画可见世界内的节点）
        for (i = 0; i < nodes.length; i++) {
            var nd = nodes[i];
            if (!nd.simState) continue;
            var ndbb = sampleBBox(nd);
            if (!bboxVisible(ndbb, vb)) continue;
            var px2 = metersToPx(nd.simState.tank.x), py2 = metersToPx(nd.simState.tank.y);
            if (!pxVisible(px2, py2, cam, marginPx)) continue;
            state.mapRender.nodesDrawn++;
            if (nd.status === 'dead') {
                g.lineStyle(1, 0xff3355, 0.85);
                g.beginFill(0xff3355, 0.55);
                g.drawRect(px2 - 2.5, py2 - 2.5, 5, 5);
                g.endFill();
            } else if (nd.fullDead) {
                g.lineStyle(1, 0xffb86c, 0.85);
                g.beginFill(0xffb86c, 0.45);
                g.drawRect(px2 - 2.5, py2 - 2.5, 5, 5);
                g.endFill();
            } else {
                var f = (nd.subtreeBest - mn) / span;
                var rC = Math.round(80 + (94 - 80) * (1 - f) + 0),
                    gC = Math.round(180 * (1 - f) + 250 * f),
                    bC = Math.round(250 * (1 - f) + 133 * f);
                g.lineStyle(1, (rC << 16) | (gC << 8) | bC, 0.9);
                g.beginFill((rC << 16) | (gC << 8) | bC, 0.45);
                g.drawRect(px2 - 2.5, py2 - 2.5, 5, 5);
                g.endFill();
            }
        }

        // doomedSnaps 灰点（保留语义）
        var ds = tr.doomedSnaps || [];
        for (var di = 0; di < ds.length; di++) {
            var dsn = ds[di];
            if (!dsn || typeof dsn.x !== 'number' || typeof dsn.y !== 'number') continue;
            var dxp = metersToPx(dsn.x), dyp = metersToPx(dsn.y);
            if (!pxVisible(dxp, dyp, cam, marginPx)) continue;
            g.lineStyle(1, 0x585b70, 0.55);
            g.beginFill(0x585b70, 0.35);
            g.drawCircle(dxp, dyp, 4);
            g.endFill();
        }

        // commitNode 青圈 + 根白圈 + 金线末端
        if (tr.commitNode && tr.commitNode.simState) {
            var cmx = metersToPx(tr.commitNode.simState.tank.x), cmy = metersToPx(tr.commitNode.simState.tank.y);
            if (pxVisible(cmx, cmy, cam, marginPx)) {
                g.lineStyle(2, 0x66f7ff, 0.9);
                g.drawCircle(cmx, cmy, 10);
            }
        }
        if (tr.root && tr.root.simState) {
            var rox = metersToPx(tr.root.simState.tank.x), roy = metersToPx(tr.root.simState.tank.y);
            if (pxVisible(rox, roy, cam, marginPx)) {
                g.lineStyle(2, 0xffffff, 0.9);
                g.drawCircle(rox, roy, 12);
            }
        }
        if (cp.length > 1) {
            var tipN = cp[cp.length - 1];
            if (tipN && tipN.simState) {
                var tix = metersToPx(tipN.simState.tank.x), tiy = metersToPx(tipN.simState.tank.y);
                if (pxVisible(tix, tiy, cam, marginPx)) {
                    g.lineStyle(2, 0xf9e2af, 0.95);
                    g.beginFill(0xf9e2af, 0.6);
                    g.drawCircle(tix, tiy, 7);
                    g.endFill();
                }
            }
        }
    }

    function renderSandboxViz(g) {
        var sb = state.sandbox;
        if (!sb || sb.activeOp === null || !sb.simSamples) return;
        var r = sb.results[sb.activeOp];
        var k = sb.frameIdx;
        var s = sb.simSamples[Math.min(k, sb.simSamples.length - 1)];
        if (!s) return;

        var ext = tankExtPx();
        var deadNow = r.dead && r.deathFrame >= 0 && k >= r.deathFrame;
        if (!deadNow) {
            drawHullOBB(g, metersToPx(s.x), metersToPx(s.y), s.rot, ext, 0x66f7ff, 0.9, 0.15);
        } else {
            var ds = sb.simSamples[Math.min(r.deathFrame, sb.simSamples.length - 1)];
            if (ds) {
                drawHullOBB(g, metersToPx(ds.x), metersToPx(ds.y), ds.rot, ext, 0xff3355, 0.9, 0.25);
                drawCross(g, ds.x, ds.y, 10, 0xff3355);
            }
        }

        var radius = metersToPx((Constants.BULLET && Constants.BULLET.RADIUS && Constants.BULLET.RADIUS.m) || 0.35);
        for (var b = 0; b < sb.threats.length; b++) {
            var th = sb.threats[b];
            var pos = sb.adapter.bulletPosAt(th.path, th.speed, k * FRAME_DT_SEC);
            if (!pos) continue;
            g.lineStyle(1.5, 0xffffff, 0.85);
            g.beginFill(0xffffff, 0.35);
            g.drawCircle(metersToPx(pos.x), metersToPx(pos.y), radius * 2);
            g.endFill();
        }

        if (k > 0) {
            g.lineStyle(1, 0x66f7ff, 0.4);
            var last = sb.simSamples[0];
            g.moveTo(metersToPx(last.x), metersToPx(last.y));
            for (var j = 1; j <= k && j < sb.simSamples.length; j++) {
                g.lineTo(metersToPx(sb.simSamples[j].x), metersToPx(sb.simSamples[j].y));
            }
        }
    }

    /** 树节点虚影预览：点击树节点后可在地图上逐帧看该节点的模拟。
     *  v34：threats 不再使用节点里可能失真的旧锚点，而是点击瞬间重新计算。 */
    function setTreeNodePreview(node) {
        if (!node || !node.rolloutSamples || !node.rolloutSamples.length) {
            state.treePreview = null;
            return;
        }
        var threats = [];
        try {
            var m = findVantageManager();
            var ai = m && m.ai;
            if (ai && typeof VantageScoring !== 'undefined') {
                var adapter = getAdapter(ai);
                var tankState = adapter && adapter.getTankState();
                if (adapter && tankState) {
                    threats = VantageScoring.computeThreats(adapter, tankState);
                }
            }
        } catch (ePrev) {
            threats = [];
        }
        state.treePreview = { node: node, frameIdx: 0, threats: threats };
        renderViz();
    }

    function stepTreeNodePreview(delta) {
        var tp = state.treePreview;
        if (!tp) return;
        var max = tp.node.rolloutSamples.length - 1;
        tp.frameIdx = Math.max(0, Math.min(max, tp.frameIdx + delta));
        renderViz();
        if (_tv) updateTreeNodeInfo();
    }

    function renderTreeNodePreview(g) {
        var tp = state.treePreview;
        if (!tp || !tp.node.rolloutSamples || !tp.node.rolloutSamples.length) return;
        var samples = tp.node.rolloutSamples;
        var k = Math.min(tp.frameIdx, samples.length - 1);
        var s = samples[k];
        if (!s) return;

        // 历史轨迹
        if (k > 0) {
            g.lineStyle(1, 0x66f7ff, 0.35);
            g.moveTo(metersToPx(samples[0].x), metersToPx(samples[0].y));
            for (var j = 1; j <= k; j++) {
                g.lineTo(metersToPx(samples[j].x), metersToPx(samples[j].y));
            }
        }

        // 当前坦克虚影
        var ext = tankExtPx();
        var deadNow = (tp.node.rolloutDeathFrame >= 0 && k >= tp.node.rolloutDeathFrame);
        if (deadNow) {
            drawHullOBB(g, metersToPx(s.x), metersToPx(s.y), s.rot, ext, 0xff3355, 0.9, 0.25);
            drawCross(g, s.x, s.y, 10, 0xff3355);
        } else {
            drawHullOBB(g, metersToPx(s.x), metersToPx(s.y), s.rot, ext, 0x66f7ff, 0.9, 0.18);
        }

        // 子弹虚影：优先用点击瞬间重新计算的 threats（tp.threats）。
        // 只有拿不到 live threats 时才退回节点旧锚点。
        var threats = tp.threats || tp.node.threats || (state.live && state.live.threats) || [];
        if (!threats.length) return;
        var m = findVantageManager();
        var ai = m && m.ai;
        if (!ai) return;
        var adapter = getAdapter(ai);
        if (!adapter || !adapter.bulletPosAt) return;
        // live threats 从点击时刻开始，baseT=0；旧锚点才用 rolloutStartT。
        var baseT = tp.threats ? 0
            : ((typeof tp.node.rolloutStartT === 'number')
                ? tp.node.rolloutStartT
                : (tp.node.simState ? (tp.node.simState.tGlobal || 0) : 0));
        var tNow = baseT + k * FRAME_DT_SEC;
        var radius = metersToPx((Constants.BULLET && Constants.BULLET.RADIUS && Constants.BULLET.RADIUS.m) || 0.35);
        for (var b = 0; b < threats.length; b++) {
            var th = threats[b];
            if (!th || !th.path) continue;
            var pos = adapter.bulletPosAt(th.path, th.speed, tNow);
            if (!pos) continue;
            g.lineStyle(1.5, 0xffffff, 0.8);
            g.beginFill(0xffffff, 0.3);
            g.drawCircle(metersToPx(pos.x), metersToPx(pos.y), radius * 2);
            g.endFill();
        }
    }

    // ============================================================
    // 四点五、树视图（v7.8 交互式树图：X=时间 Y=分支；自动跟随缩放、
    //                手动平移/缩放、点节点看详情；主人 2026-08-16 要求）
    // ============================================================

    var _tv = null;          // {el, canvas, ctx, info, followChk, view, selected, layout}
    var TV_PAD_X = 34, TV_PAD_Y = 14;

    function ensureTreeView() {
        if (_tv) return _tv;
        var el = document.createElement('div');
        el.id = 'vt-treeview';
        el.style.cssText = 'position:fixed;left:0;top:0;z-index:99998;' +
            'background:rgba(20,22,34,0.94);border:1px solid #6c7086;border-radius:6px;' +
            'color:#cdd6f4;font:11px/1.5 Consolas,monospace;pointer-events:auto;display:none';
        var head = document.createElement('div');
        head.style.cssText = 'padding:4px 8px;border-bottom:1px solid #45475a;cursor:default;user-select:none';
        head.innerHTML = '<b style="color:#94e2d5">预测树</b> ' +
            '<label style="cursor:pointer;color:#89b4fa"><input type="checkbox" data-tv="follow" checked> 跟随</label>' +
            '<span style="color:#6c7086"> 拖空白=移动窗口 · 画布拖=平移 · 滚轮=缩放 · 点节点=详情</span>' +
            '<button data-tv="export" style="cursor:pointer;background:#45475a;color:#cdd6f4;border:1px solid #6c7086;border-radius:4px;padding:0 6px;margin-left:6px">导出诊断</button>' +
            '<button data-tv="close" style="float:right;cursor:pointer;background:#45475a;color:#cdd6f4;border:1px solid #6c7086;border-radius:4px;padding:0 6px">×</button>';
        el.appendChild(head);
        head.addEventListener('click', function(e) {
            var t = e.target;
            while (t && t !== head && !(t.dataset && t.dataset.tv)) t = t.parentNode;
            if (!t || t === head || !t.dataset || !t.dataset.tv) return;
            if (t.dataset.tv === 'export') exportTreeDiagnostics();
        });
        var canvas = document.createElement('canvas');
        canvas.width = 506;
        canvas.height = 360;
        canvas.style.cssText = 'display:block;margin:6px 8px;border:1px solid #45475a;background:#11111b;cursor:crosshair';
        el.appendChild(canvas);
        var info = document.createElement('div');
        info.style.cssText = 'padding:2px 8px 6px;color:#94e2d5;min-height:16px;white-space:pre-wrap';
        info.textContent = '点击树上的节点查看详情；拖动树图空白处可移动窗口';
        info.addEventListener('click', function(e) {
            var t = e.target;
            while (t && t !== info && !(t.dataset && t.dataset.tvn)) t = t.parentNode;
            if (!t || t === info || !t.dataset || !t.dataset.tvn) return;
            var act = t.dataset.tvn;
            var sel = _tv && _tv.selected;
            if (!sel) return;
            if (act === 'show') setTreeNodePreview(sel);
            else if (act === 'prev') stepTreeNodePreview(-1);
            else if (act === 'next') stepTreeNodePreview(1);
        });
        el.appendChild(info);
        document.body.appendChild(el);

        var FOLLOW_LEFT_SEC = 0.25;       // 跟随窗口左边界：now 往前保留 0.25s
        var FOLLOW_WINDOW_SEC = 2.0;       // 跟随窗口总宽度：2s，不再显示大片空未来
        var view = {
            scale: (canvas.width - TV_PAD_X - 12) / FOLLOW_WINDOW_SEC,
            yScale: 16,          // v42：纵向分支布局缩放（px/槽位）
            viewX: 0,
            viewY: 0,            // v42：纵向平移（槽位）
            follow: true,
            followLeftSec: FOLLOW_LEFT_SEC,
            followWindowSec: FOLLOW_WINDOW_SEC
        };
        var tv = {
            el: el, canvas: canvas, ctx: canvas.getContext('2d'),
            info: info, view: view,
            followChk: head.querySelector('[data-tv="follow"]'),
            selected: null, layout: null,
            userMoved: false
        };

        // 关闭 / 跟随
        var closeBtn = head.querySelector('[data-tv="close"]');
        closeBtn.addEventListener('mousedown', function(e) { e.stopPropagation(); });
        closeBtn.addEventListener('click', function() { toggleTreeView(); });
        tv.followChk.addEventListener('change', function() {
            view.follow = tv.followChk.checked;
            drawTree();
        });

        // v77：树图任意空白处都能拖动；画布、按钮、复选框、节点详情按钮保持原交互。
        function isTreeViewInteractive(t) {
            var n = t;
            while (n && n !== el) {
                if (n.dataset && (n.dataset.tv || n.dataset.tvn)) return true;
                var tag = (n.tagName || '').toLowerCase();
                if (tag === 'button' || tag === 'input' || tag === 'select' ||
                    tag === 'textarea' || tag === 'label' || tag === 'canvas' || tag === 'a') {
                    return true;
                }
                n = n.parentNode;
            }
            return false;
        }
        (function() {
            var hd = null;
            el.addEventListener('mousedown', function(e) {
                if (e.button !== 0) return;
                if (isTreeViewInteractive(e.target)) return;
                var r = el.getBoundingClientRect();
                _tv.userMoved = true;
                hd = { dx: e.clientX - r.left, dy: e.clientY - r.top };
                e.preventDefault();
            });
            head.addEventListener('dblclick', function() {
                _tv.userMoved = false;
                placeTreeView();
            });
            document.addEventListener('mousemove', function(e) {
                if (!hd) return;
                el.style.left = (e.clientX - hd.dx) + 'px';
                el.style.top = (e.clientY - hd.dy) + 'px';
            });
            document.addEventListener('mouseup', function() { hd = null; });
        })();
        // v79：拖动功能保留，但树图各处保持默认光标，不再显示移动图标。

        // 滚轮缩放（光标时间锚定；缩放不再取消跟随，只保留用户缩放倍率）
        canvas.addEventListener('wheel', function(e) {
            e.preventDefault();
            var f = e.deltaY < 0 ? 1.18 : 1 / 1.18;
            var rect = canvas.getBoundingClientRect();
            var mx = e.clientX - rect.left;
            var my = e.clientY - rect.top;
            var tAt = view.viewX + (mx - TV_PAD_X) / view.scale;
            var yAt = view.viewY + (my - TV_PAD_Y) / view.yScale;
            view.scale = Math.max(30, Math.min(1500, view.scale * f));
            view.yScale = Math.max(3, Math.min(80, view.yScale * f));
            view.viewX = tAt - (mx - TV_PAD_X) / view.scale;
            view.viewY = yAt - (my - TV_PAD_Y) / view.yScale;
            drawTree();
        }, { passive: false });

        // 拖平移 / 点选（拖动超过阈值=平移并脱离跟随；否则=点选节点）
        var drag = null;
        canvas.addEventListener('mousedown', function(e) {
            drag = { x: e.clientX, y: e.clientY, moved: 0 };
            e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (!drag) return;
            var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            drag.moved += Math.abs(dx) + Math.abs(dy);
            if (drag.moved > 4) {
                view.viewX -= dx / view.scale;
                view.viewY -= dy / view.yScale;
                view.follow = false;
                if (tv.followChk.checked) tv.followChk.checked = false;
                drawTree();
            }
            drag.x = e.clientX;
            drag.y = e.clientY;
        });
        document.addEventListener('mouseup', function(e) {
            if (!drag) return;
            var wasClick = drag.moved <= 4;
            drag = null;
            if (!wasClick) return;
            var rect = canvas.getBoundingClientRect();
            tv.selected = hitTestNode(e.clientX - rect.left, e.clientY - rect.top);
            updateTreeNodeInfo();
            drawTree();
        });

        _tv = tv;
        return tv;
    }

    /** v90：取 Phaser 里“地图本体”在浏览器坐标中的矩形。
     *  用 gameGroup 的 localBounds + toGlobal + scale.bounds 换算，
     *  这样树图贴的是地图边缘，不是屏幕边缘。 */
    function getGameMapRect() {
        var ctx = getPhaserCtx();
        if (!ctx || !ctx.game || !ctx.group) return null;
        var game = ctx.game, group = ctx.group;
        if (!group.getLocalBounds || !group.toGlobal) return null;
        if (typeof Phaser === 'undefined' || !Phaser.Point) return null;
        var lb = group.getLocalBounds();
        if (!lb || !isFinite(lb.width) || lb.width <= 0 || !isFinite(lb.height) || lb.height <= 0) return null;
        var p0 = group.toGlobal(new Phaser.Point(lb.x, lb.y));
        var p1 = group.toGlobal(new Phaser.Point(lb.x + lb.width, lb.y + lb.height));
        if (!p0 || !p1) return null;
        var sf = (game.scale && game.scale.scaleFactor) ? game.scale.scaleFactor : { x: 1, y: 1 };
        var gb = (game.scale && game.scale.bounds) ? game.scale.bounds : { x: 0, y: 0 };
        var left = gb.x + p0.x / sf.x;
        var top = gb.y + p0.y / sf.y;
        var right = gb.x + p1.x / sf.x;
        var bottom = gb.y + p1.y / sf.y;
        if (!isFinite(left) || !isFinite(top) || !isFinite(right) || !isFinite(bottom)) return null;
        return { left: left, top: top, right: right, bottom: bottom,
                 width: right - left, height: bottom - top };
    }

    /** v90：树图默认贴在“地图右侧边缘”，不夹回屏幕内。
     *  如果拿不到地图，就贴游戏画布右侧；再拿不到才贴屏幕右侧。 */
    function placeTreeView() {
        if (!_tv || !_tv.el) return;
        var el = _tv.el;
        if (state.treeViewOn !== true || el.style.display === 'none') return;
        var mapRect = getGameMapRect();
        if (mapRect) {
            el.style.left = Math.round(mapRect.right + 8) + 'px';
            el.style.top = Math.round(mapRect.top) + 'px';
        } else {
            var canvas = document.querySelector('#phaserCanvasContainer canvas, canvas');
            if (canvas && canvas.getBoundingClientRect) {
                var cr = canvas.getBoundingClientRect();
                el.style.left = Math.round(cr.right + 8) + 'px';
                el.style.top = Math.round(cr.top) + 'px';
            } else {
                el.style.left = ((window.innerWidth || 1920) + 8) + 'px';
                el.style.top = '8px';
            }
        }
        _tv.userMoved = false;
    }

    function toggleTreeView() {
        state.treeViewOn = !state.treeViewOn;
        if (state.treeViewOn) {
            ensureTreeView().el.style.display = 'block';
            placeTreeView();
            drawTree();
        } else if (_tv) {
            _tv.el.style.display = 'none';
        }
        syncButtonLabels();
    }

    function hitTestNode(mx, my) {
        if (!_tv || !_tv.layout) return null;
        var best = null, bd = 196;   // 14px 半径²
        for (var i = 0; i < _tv.layout.length; i++) {
            var p = _tv.layout[i];
            var d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
            if (d < bd) { bd = d; best = p.n; }
        }
        return best;
    }

    function updateTreeNodeInfo() {
        if (!_tv) return;
        var n = _tv.selected;
        if (!n || !n.simState) { _tv.info.textContent = '点击树上的节点查看详情；拖动树图空白处可移动窗口'; return; }
        var tp = state.treePreview;
        var frameTxt = tp && tp.node === n
            ? (' | 预览帧 ' + tp.frameIdx + '/' + (n.rolloutSamples.length - 1)) : '';

        // v47 只读诊断：死亡帧必须显式给帧号，避免“75帧死”被误解为活满75帧。
        // fullDeathFrame 是当前威胁口径下的预测死亡帧；rolloutDeathFrame 是
        // 建节点时原始 rollout 留档（refresh 后二者可能不同）。
        var planned = n.plannedFrames || n.segmentFrames || 0;
        var actual = n.segmentFrames || 0;
        var avg = planned > 0 ? (n.segmentScore || 0) / planned : 0;
        var deathFrame = (typeof n.fullDeathFrame === 'number') ? n.fullDeathFrame :
            ((typeof n.rolloutDeathFrame === 'number') ? n.rolloutDeathFrame : -1);
        var deathTxt, deathCol;
        if (deathFrame < 0) {
            deathTxt = '75帧内未死';
            deathCol = '#a6e3a1';
        } else if (deathFrame === 1) {
            deathTxt = '1帧真死';
            deathCol = '#f38ba8';
        } else {
            deathTxt = '75帧内死亡 @ 第' + deathFrame + '帧';
            deathCol = '#fab387';
        }
        var rawDeathTxt = (typeof n.rolloutDeathFrame === 'number' && n.rolloutDeathFrame >= 0)
            ? '' + n.rolloutDeathFrame : '-';
        var nextTxt = n.next ? ('#' + n.next.id + ' ' + (n.next.opName || '?')) : '-';
        var rawTotal = (typeof n.rolloutTotal === 'number')
            ? n.rolloutTotal : (n.segmentScore || 0) + (n.baseExt || 0);

        var statusTxt = n.status === 'dead' ? '段内死亡'
            : (n.status === 'alive' ? '存活'
            : (n.fullDead ? '软死' : (n.status || '未知')));
        _tv.info.innerHTML = '#' + n.id + ' ' + (n.opName || '根') +
            (n.exhausted ? ' <b style="color:#cba6f7">已回退</b>' : '') +
            ' <b style="color:' + (n.status === 'dead' ? '#f38ba8'
                : n.fullDead ? '#fab387' : '#a6e3a1') + '">' + statusTxt + '</b>' +
            ' | <b style="color:' + deathCol + '">' + deathTxt + '</b>' +
            ' <span style="color:#6c7086">原始预测死帧 ' + rawDeathTxt + '</span>' +
            ' | 计划 ' + planned + '帧(' + (planned * 0.02).toFixed(2) + 's)' +
            ' | 实际 ' + actual + '帧(' + (actual * 0.02).toFixed(2) + 's)' +
            ' | 本段得分 ' + (n.segmentScore || 0).toFixed(1) +
            ' | 本段均分 ' + avg.toFixed(2) +
            ' | 后续基线 ' + (n.baseExt || 0).toFixed(1) +
            ' | <span style="color:#89b4fa">75帧总分 ' + rawTotal.toFixed(1) + '</span>' +
            ' | <b style="color:#f9e2af">子树选路分 ' + (n.subtreeBest || 0).toFixed(1) + '</b>' +
            ' | 子节点 ' + n.children.length +
            ' | 下一步 ' + nextTxt +
            ' | 位置(' + n.simState.tank.x.toFixed(1) + ',' + n.simState.tank.y.toFixed(1) + ',' +
            Math.round(n.simState.tank.rot * 180 / Math.PI) + '°)' + frameTxt +
            '<br><button data-tvn="show" style="cursor:pointer;margin:2px 4px 0 0">预览该节点</button>' +
            '<button data-tvn="prev" style="cursor:pointer;margin:2px 4px 0 0">◀ 上一步</button>' +
            '<button data-tvn="next" style="cursor:pointer;margin:2px 4px 0 0">下一步 ▶</button>';
    }

    /** v47 只读诊断：找最近一次整根重置/大剪枝的可见原因。 */
    function treeLastResetText(tr) {
        var evs = (tr && tr.events) || [];
        for (var i = evs.length - 1; i >= 0; i--) {
            var e = evs[i];
            if (!e) continue;
            if (e.type === 'fresh' || e.type === 'rebuild' ||
                e.type === 'prune' || e.type === 'threat' ||
                e.type === 'global-reroute') {
                return '最近异常: ' + e.type + ' @' + (e.t || 0).toFixed(2) +
                    's ' + (e.info || '');
            }
        }
        return '最近异常: -';
    }

    /** v47 只读诊断：解释金线为什么停在某个节点。
     *  这里不改树，只把 commitPathOf 的停止原因翻译给人看。 */
    function treePathBreakReason(tr) {
        var cp = tr && tr.commitPath;
        if (!cp || cp.length < 2) return '金线断因: 无执行节点';
        var tip = cp[cp.length - 1];
        if (!tip) return '金线断因: 空末端';
        var root = tr.root;
        var depthSec = tip.tEndSec - root.tEndSec;
        var cfgHorizon = (tr.cfg && tr.cfg.horizonSec) ? tr.cfg.horizonSec : 8;
        if (tip.children.length === 0) {
            if (tip.status === 'dead') {
                return '金线断因: ' + (tip.fullDeathFrame >= 2 ?
                    ('软死@' + tip.fullDeathFrame + '帧（可续树）') :
                    ('真死@' + tip.fullDeathFrame + '帧'));
            }
            if (depthSec >= cfgHorizon) return '金线断因: 到达视界' + cfgHorizon.toFixed(1) + 's';
            var gh = (tr.diag && tr.diag.growHistory) || [];
            var lastGrow = gh.length ? gh[gh.length - 1] : null;
            return '金线断因: 叶未扩展' + (lastGrow ? ('(' + lastGrow.code + ')') : '');
        }
        if (!tip.next) return '金线断因: next缺失';
        if (tip.children.indexOf(tip.next) < 0 ||
            tip.next.exhausted || tip.next.invalid) {
            return '金线断因: next失效(#' + (tip.next.id || '?') + ')';
        }
        if (tip.next.fullDeathFrame === 1) {
            return '金线状态: next是1帧真死(#' + tip.next.id + ')，段末会回退';
        }
        if (tip.next.status === 'dead') {
            return '金线状态: next软死@' + tip.next.fullDeathFrame + '帧(#' + tip.next.id + ')';
        }
        return '金线正常: 沿next→#' + tip.next.id + ' ' + (tip.next.opName || '?');
    }

    /** 泳道序（主人 2026-08-16 指定，从上到下；新布局用于子节点排序与历史快照 fallback） */
    var TV_OP_ORDER = ['前右', '前左', '前', '左', '静止', '右', '后', '后右', '后左'];

    /** v42：树事件元数据（顶带标记 + 面板事件流共用） */
    function treeEventMeta(type) {
        switch (type) {
            case 'commit':  return { c: '#66f7ff', s: 'C', n: '坍缩' };
            case 'rebuild': return { c: '#f38ba8', s: 'R', n: '重建' };
            case 'retreat': return { c: '#cba6f7', s: '退', n: '回退' };
            case 'desync':  return { c: '#f9e2af', s: 'D', n: '不同步' };
            case 'reuse':   return { c: '#a6e3a1', s: '复', n: '复用' };
            case 'retire':  return { c: '#89b4fa', s: '役', n: '退役' };
            case 'invalid': return { c: '#e78284', s: '失', n: '结构失效' };
            case 'fresh':   return { c: '#fab387', s: 'F', n: '重建' };
            case 'threat':  return { c: '#cba6f7', s: '威', n: '威胁变化' };
            case 'prune':   return { c: '#eba0ac', s: '剪', n: '剪枝' };
            case 'global-reroute': return { c: '#f9e2af', s: '全', n: '全局重选' };
            case 'next-retarget':  return { c: '#94e2d5', s: '向', n: 'next重定向' };
            case 'next-pruned-retarget': return { c: '#89b4fa', s: '剪向', n: '剪枝next修复' };
            case 'lazy-layer-updated':   return { c: '#94e2d5', s: '更', n: '主线更新' };
            case 'lazy-frontier':        return { c: '#89b4fa', s: '前', n: '刷新前沿' };
            case 'lazy-outside-updated': return { c: '#a6e3a1', s: '外', n: '线外更新' };
            case 'control': return { c: '#f9e2af', s: '控', n: '输入不一致' };
            default:        return { c: '#fab387', s: 'A', n: '对齐败' };
        }
    }

    /** 绘制 v3（主人 2026-08-16 定规矩后重写）：
     *  X=绝对连续时间轴；Y=操作泳道（TV_OP_ORDER 固定序，每层 9 候选对齐）；
     *  节点=圆点（红=死，蓝→绿=subtreeBest 归一，灰=执行过/已弃）；
     *  金线=预定路线（argmax 链）；execTrail=执行过的路径灰链；
     *  doomedSnaps=上次坍缩被弃的 8 兄弟灰点（下次 commit 消失）；
     *  顶带事件标记 C=坍缩 R=重建 A=对齐败；now 竖线恒右移 */
    function drawTree() {
        if (!_tv || !state.treeViewOn) return;
        try {
            var ctx = _tv.ctx, W = _tv.canvas.width, H = _tv.canvas.height;
            ctx.clearRect(0, 0, W, H);
            var tr = (typeof VantageTree !== 'undefined') ? VantageTree.getTree() : null;
            if (!tr || !tr.root || !tr.root.simState) {
                ctx.fillStyle = '#585b70';
                ctx.font = '12px Consolas';
                ctx.fillText('树未启动（AI 操控下拉选「树」）', 12, 20);
                _tv.layout = null;
                return;
            }
            var root = tr.root;
            var i, nd;

            // ---- 收集活动节点 ----
            var nodes = [];
            (function collect(n) { nodes.push(n); for (var c = 0; c < n.children.length; c++) collect(n.children[c]); })(root);

            // ---- X=时间 ----
            var tNow = tr.tNow;
            var minT = tNow - 0.05, maxT = tNow;
            var mn = Infinity, mx2 = -Infinity;
            for (i = 0; i < nodes.length; i++) {
                nd = nodes[i];
                nd._vx = nd.tEndSec;
                if (nd._vx - nd.segmentFrames * 0.02 < minT) minT = nd._vx - nd.segmentFrames * 0.02;
                if (nd._vx > maxT) maxT = nd._vx;
                if (nd.subtreeBest < mn) mn = nd.subtreeBest;
                if (nd.subtreeBest > mx2) mx2 = nd.subtreeBest;
            }
            var trail = tr.execTrail || [], doomed = tr.doomedSnaps || [];
            var v = _tv.view;
            if (v.follow) {
                v.viewX = tNow - (v.followLeftSec || 0.25);
            } else {
                for (i = 0; i < trail.length; i++) {
                    if (trail[i].tEnd < minT) minT = trail[i].tEnd;
                    if (trail[i].tEnd > maxT) maxT = trail[i].tEnd;
                }
                for (i = 0; i < doomed.length; i++) {
                    if (doomed[i].tEnd < minT) minT = doomed[i].tEnd;
                    if (doomed[i].tEnd > maxT) maxT = doomed[i].tEnd;
                }
            }
            maxT += 0.05;
            var span = (mx2 - mn) || 1;

            // ---- Y=分层分支布局 ----
            var slotCounter = 0;
            var SUBTREE_GAP = 0.7;
            function sortedKids(n) {
                if (!n.children || !n.children.length) return [];
                var arr = n.children.slice();
                arr.sort(function(a, b) {
                    var ai = a.opName ? TV_OP_ORDER.indexOf(a.opName) : 4;
                    var bi = b.opName ? TV_OP_ORDER.indexOf(b.opName) : 4;
                    if (ai < 0) ai = 4;
                    if (bi < 0) bi = 4;
                    return ai - bi;
                });
                return arr;
            }
            function layoutNode(n) {
                var kids = sortedKids(n);
                if (!kids.length) {
                    n._vy = slotCounter;
                    slotCounter += 1;
                    return { min: n._vy, max: n._vy };
                }
                var k, r, minY = Infinity, maxY = -Infinity;
                for (k = 0; k < kids.length; k++) {
                    r = layoutNode(kids[k]);
                    if (r.min < minY) minY = r.min;
                    if (r.max > maxY) maxY = r.max;
                    if (k < kids.length - 1) slotCounter += SUBTREE_GAP;
                }
                n._vy = (minY + maxY) / 2;
                return { min: minY, max: maxY };
            }
            var layoutRange = layoutNode(root);

            // v46：紧凑主干——主链沿 next 拉直，浅叶兄弟贴到父节点附近，
            // 避免深链旁浅兄弟被推到上下远端形成大梯形。
            function compactBackbone(n) {
                if (!n || !n.children.length) return;
                var kids = sortedKids(n);
                for (var kc = 0; kc < kids.length; kc++) compactBackbone(kids[kc]);
                var mainKid = (n.next && n.children.indexOf(n.next) >= 0 &&
                    !n.next.invalid && !n.next.exhausted) ? n.next : kids[0];
                if (!mainKid) return;
                n._vy = mainKid._vy;
                var side = 0;
                for (var sc = 0; sc < kids.length; sc++) {
                    var sideKid = kids[sc];
                    if (sideKid === mainKid) continue;
                    if (sideKid.children.length === 0 && !sideKid.invalid && !sideKid.exhausted) {
                        var dir = (side % 2 === 0) ? -1 : 1;
                        var dist = 0.9 + Math.floor(side / 2) * 0.9;
                        sideKid._vy = n._vy + dir * dist;
                        side++;
                    }
                }
            }
            compactBackbone(root);

            var layoutMinY = Infinity, layoutMaxY = -Infinity;
            for (i = 0; i < nodes.length; i++) {
                if (nodes[i]._vy < layoutMinY) layoutMinY = nodes[i]._vy;
                if (nodes[i]._vy > layoutMaxY) layoutMaxY = nodes[i]._vy;
            }

            // ---- 坐标变换 ----
            function px(t) { return TV_PAD_X + (t - v.viewX) * v.scale; }
            function ypx(y) { return TV_PAD_Y + (y - v.viewY) * v.yScale; }
            function segVisible(x0, y0, x1, y1) {
                return !(Math.max(x0, x1) < TV_PAD_X || Math.min(x0, x1) > W ||
                         Math.max(y0, y1) < TV_PAD_Y || Math.min(y0, y1) > H);
            }
            function nodeVisible(n) {
                var X = px(n._vx), Y = ypx(n._vy);
                return X >= TV_PAD_X - 24 && X <= W + 24 && Y >= TV_PAD_Y - 24 && Y <= H + 24;
            }

            // ---- 跟随：X 窗口 + Y 自适应缩放并中心跟随金线当前段 ----
            if (v.follow) {
                v.viewX = tNow - (v.followLeftSec || 0.25);
                var availH = H - 2 * TV_PAD_Y;
                var targetYScale = Math.max(3, Math.min(80,
                    availH / Math.max(1.0, (layoutMaxY - layoutMinY) + 1.5)));
                if (!_tv._yScaleInit) {
                    v.yScale = targetYScale;          // 首帧直接采用自适应值
                    _tv._yScaleInit = true;
                } else {
                    v.yScale = v.yScale * 0.7 + targetYScale * 0.3;   // 后续平滑跟随
                }
                var targetY = root._vy;
                if (tr.commitNode && tr.commitNode !== root) {
                    targetY = (root._vy + tr.commitNode._vy) / 2;
                }
                v.viewY = targetY - availH / (2 * v.yScale);
            }

            // 时间网格 0.25s
            ctx.strokeStyle = '#1e1e2e';
            ctx.fillStyle = '#585b70';
            ctx.font = '9px Consolas';
            var tG = Math.floor(v.viewX / 0.25) * 0.25;
            for (; px(tG) < W; tG += 0.25) {
                var gx = px(tG);
                if (gx < TV_PAD_X - 2) continue;
                ctx.beginPath();
                ctx.moveTo(gx, TV_PAD_Y);
                ctx.lineTo(gx, H - TV_PAD_Y);
                ctx.stroke();
                ctx.fillText(tG.toFixed(2) + 's', gx + 2, H - 3);
            }

            // 历史 execTrail / doomedSnaps 的 Y：优先对齐当前根层同操作子节点。
            var rootChildY = {};
            (function() {
                var rk = sortedKids(root);
                for (var ri = 0; ri < rk.length; ri++) {
                    if (rk[ri].opName) rootChildY[rk[ri].opName] = rk[ri]._vy;
                }
            })();
            function fallbackY(opName) {
                if (opName && rootChildY[opName] !== undefined) return rootChildY[opName];
                var li = opName ? TV_OP_ORDER.indexOf(opName) : 4;
                if (li < 0) li = 4;
                return root._vy + (li - 4) * 1.6;
            }

            var showHistory = !v.follow;
            if (showHistory && trail.length) {
                ctx.fillStyle = '#585b70';
                ctx.globalAlpha = 0.8;
                for (i = 0; i < trail.length; i++) {
                    var tn2 = trail[i];
                    var hx = px(tn2.tEnd), hy = ypx(fallbackY(tn2.opName));
                    if (hx < TV_PAD_X - 6 || hx > W + 6 || hy < TV_PAD_Y - 6 || hy > H + 6) continue;
                    ctx.beginPath();
                    ctx.arc(hx, hy, 3, 0, 6.2832);
                    ctx.fill();
                }
                ctx.globalAlpha = 1;
            }
            for (i = 0; i < doomed.length; i++) {
                var dn = doomed[i];
                var dx2 = px(dn.tEnd), dy2 = ypx(fallbackY(dn.opName));
                if (dx2 < TV_PAD_X - 6 || dx2 > W + 6 || dy2 < TV_PAD_Y - 6 || dy2 > H + 6) continue;
                ctx.fillStyle = dn.dead ? '#7a4a5a' : '#585b70';
                ctx.globalAlpha = 0.55;
                ctx.beginPath();
                ctx.arc(dx2, dy2, 3.5, 0, 6.2832);
                ctx.fill();
                ctx.globalAlpha = 1;
            }

            // 父子边（只画与视口相交的线段）
            ctx.strokeStyle = '#45475a';
            ctx.beginPath();
            for (i = 0; i < nodes.length; i++) {
                nd = nodes[i];
                if (!nd.parent) continue;
                var ex0 = px(nd.parent._vx), ey0 = ypx(nd.parent._vy);
                var ex1 = px(nd._vx), ey1 = ypx(nd._vy);
                if (!segVisible(ex0, ey0, ex1, ey1)) continue;
                ctx.moveTo(ex0, ey0);
                ctx.lineTo(ex1, ey1);
            }
            ctx.stroke();

            // 75 帧尾迹幽灵点：先裁剪；节点多时只画金线尾迹。
            var GHOST_ALL_MAX = 70;
            var ghostSrc = nodes.length > GHOST_ALL_MAX ? (tr.commitPath || []) : nodes;
            ctx.strokeStyle = '#7f849c';
            ctx.globalAlpha = 0.5;
            for (i = 0; i < ghostSrc.length; i++) {
                nd = ghostSrc[i];
                var rl = nd.rolloutSamples ? nd.rolloutSamples.length - 1 : 0;
                if (rl <= nd.segmentFrames) continue;
                var ty = ypx(nd._vy);
                if (ty < TV_PAD_Y - 8 || ty > H + 8) continue;
                var tailStart = nd.tEndSec;
                var tailEnd = nd.tEndSec + (rl - nd.segmentFrames) * 0.02;
                var tx0 = px(tailStart), tx1 = px(tailEnd);
                if (tx1 < TV_PAD_X - 2 || tx0 > W) continue;
                ctx.beginPath();
                ctx.moveTo(Math.max(tx0, TV_PAD_X - 2), ty);
                ctx.lineTo(Math.min(tx1, W), ty);
                ctx.stroke();
                for (var gk = nd.segmentFrames + 15; gk <= rl; gk += 15) {
                    var gx2 = px(nd.tEndSec + (gk - nd.segmentFrames) * 0.02);
                    if (gx2 < TV_PAD_X - 2 || gx2 > W) continue;
                    ctx.beginPath();
                    ctx.arc(gx2, ty, 1.8, 0, 6.2832);
                    ctx.stroke();
                }
                if (tx1 >= TV_PAD_X - 2 && tx1 <= W) {
                    ctx.beginPath();
                    ctx.arc(tx1, ty, 2.4, 0, 6.2832);
                    ctx.stroke();
                }
            }
            ctx.globalAlpha = 1;

            // 节点圆点（只画视口内）
            var pts = [];
            for (i = 0; i < nodes.length; i++) {
                nd = nodes[i];
                if (!nodeVisible(nd)) continue;
                var X = px(nd._vx), Y = ypx(nd._vy);
                pts.push({ n: nd, x: X, y: Y });
                // v46：死亡颜色按 fullDeathFrame 分档，不连续过渡。
                var fd2 = nd.fullDeathFrame;
                var col;
                if (nd.exhausted) col = '#cba6f7';
                else if (nd.invalid) col = '#6c7086';
                else if (fd2 === -1) col = '#a6e3a1';          // 存活绿
                else if (fd2 <= 1) col = '#f43f5e';           // 真死最红
                else if (fd2 <= 3) col = '#f97316';           // 2~3 橙红
                else if (fd2 <= 6) col = '#f59e0b';           // 4~6 橙
                else if (fd2 <= 15) col = '#eab308';          // 7~15 黄
                else col = '#84cc16';                         // >15 近存活绿但保留色差
                ctx.fillStyle = col;
                ctx.globalAlpha = (fd2 >= 1 && fd2 <= 3) ? 0.9 : 0.95;
                ctx.beginPath();
                ctx.arc(X, Y, 4, 0, 6.2832);
                ctx.fill();
                ctx.globalAlpha = 1;
            }

            // 金线=预定路线（只画与视口相交的段）
            var cp = tr.commitPath;
            if (cp && cp.length > 1) {
                ctx.strokeStyle = '#f9e2af';
                ctx.lineWidth = 3;
                ctx.globalAlpha = 0.95;
                ctx.beginPath();
                var prevX = null, prevY = null, penDown = false;
                for (var p = 0; p < cp.length; p++) {
                    var cn = cp[p];
                    var cxp = px(cn._vx), cyp = ypx(cn._vy);
                    if (prevX !== null) {
                        if (segVisible(prevX, prevY, cxp, cyp)) {
                            if (!penDown) { ctx.moveTo(prevX, prevY); penDown = true; }
                            ctx.lineTo(cxp, cyp);
                        } else {
                            penDown = false;
                        }
                    }
                    prevX = cxp; prevY = cyp;
                }
                ctx.stroke();
                ctx.globalAlpha = 1;
                ctx.lineWidth = 1;
            }

            // now 竖线
            var nx = px(tNow);
            if (nx >= TV_PAD_X - 1 && nx <= W) {
                ctx.strokeStyle = '#66f7ff';
                ctx.globalAlpha = 0.85;
                ctx.beginPath();
                ctx.moveTo(nx, TV_PAD_Y);
                ctx.lineTo(nx, H - TV_PAD_Y);
                ctx.stroke();
                ctx.globalAlpha = 1;
                ctx.fillStyle = '#66f7ff';
                ctx.fillText('now', nx + 3, TV_PAD_Y + 9);
            }

            var stMsg = '';
            if (tr.commitSlice) stMsg = '提交切片计算中…';
            else if (tr.growSkip) stMsg = '生长跳过(性能闸)';
            if (stMsg) {
                ctx.fillStyle = '#f9e2af';
                ctx.font = '11px Consolas';
                ctx.fillText(stMsg, TV_PAD_X + 4, TV_PAD_Y + 26);
            }

            // 事件标记（顶带，按新事件类型给颜色与简称）
            var evs = tr.events || [];
            ctx.font = '9px Consolas';
            for (var e2 = 0; e2 < evs.length; e2++) {
                var ev = evs[e2];
                var ex = px(ev.t);
                if (ex < TV_PAD_X - 2 || ex > W) continue;
                var em = treeEventMeta(ev.type);
                ctx.strokeStyle = em.c;
                ctx.globalAlpha = 0.8;
                ctx.beginPath();
                ctx.moveTo(ex, TV_PAD_Y);
                ctx.lineTo(ex, TV_PAD_Y + 7);
                ctx.stroke();
                ctx.globalAlpha = 1;
                ctx.fillStyle = em.c;
                ctx.fillText(em.s, ex - 2, TV_PAD_Y + 17);
            }

            // 高亮圈
            for (i = 0; i < nodes.length; i++) {
                nd = nodes[i];
                if (!nodeVisible(nd)) continue;
                var Xc = px(nd._vx), Yc = ypx(nd._vy);
                if (nd === tr.commitNode) {
                    ctx.strokeStyle = '#66f7ff';
                    ctx.lineWidth = 2;
                    ctx.beginPath(); ctx.arc(Xc, Yc, 7, 0, 6.2832); ctx.stroke();
                }
                if (nd === root) {
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 2;
                    ctx.beginPath(); ctx.arc(Xc, Yc, 9, 0, 6.2832); ctx.stroke();
                }
                if (_tv.selected === nd) {
                    ctx.strokeStyle = '#f9e2af';
                    ctx.lineWidth = 2;
                    ctx.beginPath(); ctx.arc(Xc, Yc, 11, 0, 6.2832); ctx.stroke();
                }
                ctx.lineWidth = 1;
            }
            _tv.layout = pts;

            // 摘要 + 图例
            ctx.fillStyle = '#6c7086';
            ctx.fillText('节点' + nodes.length + ' 弃' + doomed.length +
                ' 视界' + tr.horizonSec.toFixed(2) + 's 深度' + (cp ? cp.length - 1 : 0), TV_PAD_X, 11);
            ctx.fillStyle = '#fab387';
            ctx.fillText(treePathBreakReason(tr), TV_PAD_X, 24);
            ctx.fillStyle = '#f38ba8';
            ctx.fillText(treeLastResetText(tr), TV_PAD_X, 37);
            ctx.fillStyle = '#585b70';
            ctx.fillText('绿=活 红=1帧死 橙红=2~3 橙=4~6 黄=7~15 浅绿=>15 | C=坍缩 R/F=重建 复=复用 役=退役', W - 520, 11);

            // 空树诊断（原逻辑保留）
            if (nodes.length <= 3) {
                var dg2 = tr.diag || {};
                var lines = [];
                var gh2 = dg2.growHistory || [], sh2 = dg2.structureHistory || [];
                var gi, sx;
                for (gi = gh2.length - 1; gi >= 0 && lines.length < 3; gi--) {
                    sx = gh2[gi];
                    lines.push('生长停: ' + sx.code + ' @' + sx.t.toFixed(1) + 's n=' + sx.nodeCount);
                }
                for (gi = sh2.length - 1; gi >= 0 && lines.length < 4; gi--) {
                    sx = sh2[gi];
                    lines.push('结构: ' + sx.code + ' @' + sx.t.toFixed(1) + 's n=' + sx.nodeCount);
                }
                ctx.font = '10px Consolas';
                var ly = H - 12;
                for (var li2 = lines.length - 1; li2 >= 0; li2--) {
                    ctx.fillStyle = '#fab387';
                    ctx.fillText(lines[li2], TV_PAD_X, ly);
                    ly -= 11;
                }
            }
        } catch (eD) {
            try {
                _tv.ctx.fillStyle = '#f38ba8';
                _tv.ctx.fillText('树视图异常: ' + (eD && eD.message), 8, 14);
            } catch (eW) {}
        }
    }

    // ============================================================
    // 五、DOM 面板（标题栏可拖动 + 鼠标按钮常驻 + 分区折叠）
    // ============================================================

    var _panel = null;
    var _panelBody = null;
    var _btnRefs = {};
    var _aiCtrl = null;   // v6.1 持久 AI 操控控件引用（永不重建）
    var _expCtrl = null;  // v7.4 持久实验模式控件引用（永不重建）
    var _drag = null;

    function ensurePanel() {
        if (_panel) return _panel;
        var el = document.createElement('div');
        el.id = 'vt-bench-panel';
        el.style.cssText = [
            'position:fixed', 'top:8px', 'right:8px', 'z-index:99999',
            'width:360px',
            'background:rgba(20,22,34,0.92)', 'color:#cdd6f4',
            'font:11px/1.6 Consolas,monospace',
            'border:1px solid #6c7086', 'border-radius:6px',
            'pointer-events:auto', 'display:none',
            'flex-direction:column', 'overflow:hidden'
        ].join(';');

        // —— 标题栏（持久，可拖动）——
        var head = document.createElement('div');
        head.id = 'vt-bench-head';
        head.style.cssText = 'flex:0 0 auto;cursor:default;user-select:none;padding:6px 10px;border-bottom:1px solid #45475a;background:rgba(30,32,48,0.95);border-radius:6px 6px 0 0';
        head.innerHTML = '<b style="color:#f5c2e7">Vantage 调试工作台</b>' +
            '<span id="vt-status" style="float:right;color:#a6e3a1">运行中</span>';
        el.appendChild(head);

        // —— 按钮行（持久，鼠标操作）——
        var bar = document.createElement('div');
        bar.style.cssText = 'flex:0 0 auto;padding:4px 8px;border-bottom:1px solid #45475a;display:flex;gap:4px;flex-wrap:wrap';
        var defs = [
            ['pause', '⏸ 暂停'],
            ['step1', '+1帧'],
            ['step10', '+10帧'],
            ['viz', '标注:开'],
            ['tree', '树图:关'],
            ['export', '导出']
        ];
        for (var i = 0; i < defs.length; i++) {
            var b = document.createElement('button');
            b.dataset.act = defs[i][0];
            b.textContent = defs[i][1];
            b.style.cssText = 'cursor:pointer;background:#45475a;color:#cdd6f4;border:1px solid #6c7086;border-radius:4px;padding:2px 8px;font:inherit';
            bar.appendChild(b);
            _btnRefs[defs[i][0]] = b;
        }
        el.appendChild(bar);

        // —— AI 操控区（v6.1 持久控件层：只建一次，永不重建——
        //     v6 曾随数据区每帧 innerHTML 重建，下拉一打开就被销毁）——
        var ctrl = document.createElement('div');
        ctrl.style.cssText = 'flex:0 0 auto;padding:4px 8px;border-bottom:1px solid #45475a';
        ctrl.innerHTML = '<b style="color:#f5c2e7">AI 操控</b> ' +
            '<button data-act="aiop-toggle" style="cursor:pointer;background:#45475a;color:#cdd6f4;border:1px solid #6c7086;border-radius:4px;padding:2px 8px;font:inherit">已静止（点击启用）</button>' +
            ' <label style="cursor:pointer;color:#89b4fa"><input type="checkbox" data-act="aiop-auto"> 自动（每轮最高分）</label> ' +
            '<select data-act="aiop-select" style="background:#181825;color:#cdd6f4;border:1px solid #6c7086;border-radius:4px;padding:2px 6px;font:inherit;cursor:pointer"></select>' +
            ' <span id="vt-aiop-now" style="color:#a6e3a1"></span>';
        el.appendChild(ctrl);
        var sel = ctrl.querySelector('select');
        var optAuto = document.createElement('option');
        optAuto.value = '-1';
        optAuto.textContent = '（自动：最高分）';
        sel.appendChild(optAuto);
        // 树模式（阶段③）：AI 决策内核换预测树（段末 MPC 心跳驱动）
        var optTree = document.createElement('option');
        optTree.value = '-2';
        optTree.textContent = '（树：预测树循环）';
        sel.appendChild(optTree);
        var ops = (typeof VantageSandbox !== 'undefined') ? VantageSandbox.OPERATIONS : [];
        for (var oi = 0; oi < ops.length; oi++) {
            var o = document.createElement('option');
            o.value = String(oi);
            o.textContent = ops[oi].name;
            sel.appendChild(o);
        }
        _aiCtrl = {
            toggleBtn: ctrl.querySelector('[data-act="aiop-toggle"]'),
            autoChk: ctrl.querySelector('[data-act="aiop-auto"]'),
            select: sel,
            // ⚠ 不能用 document.getElementById：此刻面板尚未 appendChild 进文档树，
            //   getElementById 只搜文档树 → 返回 null → syncAiControl 里
            //   nowSpan.textContent 抛 TypeError → updatePanel 必炸（v9 死机/
            //   v10 面板全空的真凶，2026-08-15 e2e 定位）。querySelector 对
            //   未入文档的子树同样有效。
            nowSpan: ctrl.querySelector('span[id="vt-aiop-now"]')
        };

        // —— 实验模式区（v7.4→v7.6 持久控件层：固定帧勾选+滑块、轨迹距离评分、软死）——
        var expRow = document.createElement('div');
        expRow.id = 'vt-exp-rows';
        expRow.style.cssText = 'flex:0 0 auto;padding:4px 8px;border-bottom:1px solid #45475a;display:flex;flex-direction:column;gap:3px';
        function expItem(html) {
            return '<span style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap">' + html + '</span>';
        }
        function expLine(label, color, id, html) {
            return '<div id="' + id + '" style="display:flex;flex-direction:column;gap:3px;line-height:1.7;color:' + color + ';border-top:1px solid #45475a;margin-top:4px;padding-top:3px">' +
                '<div style="text-align:center;font-weight:bold">' + label + '</div>' +
                '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:3px 8px">' + html + '</div>' +
                '</div>';
        }
        expRow.innerHTML =
            // 评分/死亡：所有模式通用
            expLine('评分', '#f5c2e7', 'vt-exp-scoreRow',
                expItem('<label style="cursor:pointer;"><input type="checkbox" data-act="exp-fixed75"> 固定帧数评估</label>') +
                expItem('<input type="range" data-act="exp-frames" min="1" max="300" step="1" value="75" style="width:86px;cursor:pointer;background:#313244"> <span id="vt-exp-frames" style="">75帧</span>') +
                expItem('<label style="cursor:pointer;"><input type="checkbox" data-act="exp-lane"> 轨迹距离评分</label>') +
                expItem('<span id="vt-exp-springItem" style="display:inline-flex"><label style="cursor:pointer;"><input type="checkbox" data-act="exp-springRope"> 弹簧绳评分</label></span>') +
                expItem('<label style="cursor:pointer;"><input type="checkbox" data-act="exp-nodeath"> 死亡不扣分</label>')
            ) +
            // Rust 模式：Rust 物理预测是全局执行开关，弹簧绳评分不支持的提示放这里
            expLine('Rust', '#89b4fa', 'vt-exp-rustRow',
                expItem('<label style="cursor:pointer;"><input type="checkbox" data-act="exp-rustPhysics"> Rust 物理预测</label>') +
                expItem('<span id="vt-exp-rustNote" style="color:#6c7086;display:none">Rust不支持的评分项会自动回退JS；弹簧绳评分已隐藏</span>')
            ) +
            // 生长/节点：只在“树”模式显示
            expLine('生长', '#f9e2af', 'vt-exp-treeRow',
                expItem('<label style="cursor:pointer;"><input type="checkbox" data-act="exp-growWithoutThreats"> 无子弹时预热</label>') +
                expItem('每帧生长层数 <input type="range" data-act="exp-growLayers" min="1" max="6" step="1" value="1" style="width:66px;cursor:pointer;background:#313244"> <span id="vt-exp-growLayers">1层</span>') +
                expItem('节点数量上限 <input type="range" data-act="exp-maxNodes" min="100" max="3000" step="50" value="500" style="width:86px;cursor:pointer;background:#313244"> <span id="vt-exp-maxNodes">500</span> <label style="cursor:pointer;"><input type="checkbox" data-act="exp-nodeCap"> 启用</label>') +
                expItem('预热上限 <input type="range" data-act="exp-warmupMaxNodes" min="100" max="3000" step="50" value="500" style="width:86px;cursor:pointer;background:#313244"> <span id="vt-exp-warmupMaxNodes">500</span>') +
                expItem('预测时长上限 <input type="range" data-act="exp-horizonSec" min="1" max="15" step="0.5" value="8" style="width:86px;cursor:pointer;background:#313244"> <span id="vt-exp-horizonSec">8秒</span> <label style="cursor:pointer;"><input type="checkbox" data-act="exp-horizonCap"> 启用</label>') +
                expItem('<label style="cursor:pointer;"><input type="checkbox" data-act="exp-refineBeyond"> 超上限细化长路径</label>') +
                expItem('<label style="cursor:pointer;"><input type="checkbox" data-act="exp-continuousRefine"> 细化长路径</label>') +
                expItem('剪枝补偿层数 <input type="range" data-act="exp-pruneCompensateLayers" min="0" max="9" step="1" value="0" style="width:66px;cursor:pointer;background:#313244"> <span id="vt-exp-pruneCompensateLayers">0层</span>') +
                expItem('补偿持续帧数 <input type="range" data-act="exp-pruneCompensateFrames" min="1" max="60" step="1" value="1" style="width:76px;cursor:pointer;background:#313244"> <span id="vt-exp-pruneCompensateFrames">1帧</span>')
            ) +
            // 回退：只在“树”模式显示
            expLine('回退', '#cba6f7', 'vt-exp-retreatRow',
                expItem('回退节点数 <input type="range" data-act="exp-retreatNodes" min="1" max="32" step="1" value="3" style="width:66px;cursor:pointer;background:#313244"> <span id="vt-exp-retreatNodes" style="">3点</span>') +
                expItem('回退帧数 <input type="range" data-act="exp-retreatFrames" min="10" max="600" step="10" value="200" style="width:96px;cursor:pointer;background:#313244"> <span id="vt-exp-retreatFrames" style="">200帧</span>')
            ) +
            // 选路：只在“树”模式显示
            expLine('选路', '#a6e3a1', 'vt-exp-routeRow',
                expItem('<label style="cursor:pointer;"><input type="checkbox" data-act="exp-rustMinimal"> Rust 简化选路</label>') +
                expItem('<label style="cursor:pointer;"><input type="checkbox" data-act="exp-deepSelect"> 全局选路</label>') +
                expItem('<button data-act="exp-presetStrong" style="cursor:pointer;background:#45475a;color:inherit;border:1px solid #6c7086;border-radius:4px;padding:1px 6px;font:inherit">重置配置</button>')
            ) +
            '<div id="vt-exp-treeHint" style="display:none;color:#6c7086;padding-left:48px">选择 AI 操控「树」后显示生长、回退、选路参数</div>';
        el.appendChild(expRow);
        _expCtrl = {
            f75: expRow.querySelector('[data-act="exp-fixed75"]'),
            nd: expRow.querySelector('[data-act="exp-nodeath"]'),
            lane: expRow.querySelector('[data-act="exp-lane"]'),
            springRope: expRow.querySelector('[data-act="exp-springRope"]'),
            rustMinimal: expRow.querySelector('[data-act="exp-rustMinimal"]'),
            rustPhysics: expRow.querySelector('[data-act="exp-rustPhysics"]'),
            deepSelect: expRow.querySelector('[data-act="exp-deepSelect"]'),
            growWithoutThreats: expRow.querySelector('[data-act="exp-growWithoutThreats"]'),
            growLayers: expRow.querySelector('[data-act="exp-growLayers"]'),
            growLayersSpan: expRow.querySelector('span[id="vt-exp-growLayers"]'),
            maxNodes: expRow.querySelector('[data-act="exp-maxNodes"]'),
            maxNodesSpan: expRow.querySelector('span[id="vt-exp-maxNodes"]'),
            warmupMaxNodes: expRow.querySelector('[data-act="exp-warmupMaxNodes"]'),
            warmupMaxNodesSpan: expRow.querySelector('span[id="vt-exp-warmupMaxNodes"]'),
            nodeCap: expRow.querySelector('[data-act="exp-nodeCap"]'),
            horizonCap: expRow.querySelector('[data-act="exp-horizonCap"]'),
            horizonSec: expRow.querySelector('[data-act="exp-horizonSec"]'),
            horizonSecSpan: expRow.querySelector('span[id="vt-exp-horizonSec"]'),
            pruneCompensateLayers: expRow.querySelector('[data-act="exp-pruneCompensateLayers"]'),
            pruneCompensateLayersSpan: expRow.querySelector('span[id="vt-exp-pruneCompensateLayers"]'),
            pruneCompensateFrames: expRow.querySelector('[data-act="exp-pruneCompensateFrames"]'),
            pruneCompensateFramesSpan: expRow.querySelector('span[id="vt-exp-pruneCompensateFrames"]'),
            refineBeyond: expRow.querySelector('[data-act="exp-refineBeyond"]'),
            continuousRefine: expRow.querySelector('[data-act="exp-continuousRefine"]'),
            retreatNodes: expRow.querySelector('[data-act="exp-retreatNodes"]'),
            retreatNodesSpan: expRow.querySelector('span[id="vt-exp-retreatNodes"]'),
            retreatFrames: expRow.querySelector('[data-act="exp-retreatFrames"]'),
            retreatFramesSpan: expRow.querySelector('span[id="vt-exp-retreatFrames"]'),
            slider: expRow.querySelector('[data-act="exp-frames"]'),
            framesSpan: expRow.querySelector('span[id="vt-exp-frames"]'),
            // 分类行/条件显示引用
            scoreRow: expRow.querySelector('#vt-exp-scoreRow'),
            rustRow: expRow.querySelector('#vt-exp-rustRow'),
            treeRow: expRow.querySelector('#vt-exp-treeRow'),
            retreatRow: expRow.querySelector('#vt-exp-retreatRow'),
            routeRow: expRow.querySelector('#vt-exp-routeRow'),
            treeHint: expRow.querySelector('#vt-exp-treeHint'),
            springItem: expRow.querySelector('#vt-exp-springItem'),
            rustNote: expRow.querySelector('#vt-exp-rustNote')
        };

        // v90：给实验项挂悬浮说明。停 0.5s 后显示，不打断操作。
        (function bindExpTooltips() {
            if (!expRow || expRow._vtTipBound) return;
            expRow._vtTipBound = true;
            var tips = {
                'exp-fixed75': '开启后，不管真实帧率怎么变，都按固定帧数评估每个操作，便于复现实验结果。',
                'exp-frames': '固定帧数评估使用的帧数。数值越大，看得越远，但计算量也越大。',
                'exp-lane': '轨迹距离评分。开启后，会评估坦克路线与子弹轨迹的距离，靠得太近就额外扣分。',
                'exp-springRope': '弹簧绳评分。开启后，距离墙太近或路线太贴边会被额外扣分，用来鼓励更舒展的走位。Rust 物理路径不支持这项。',
                'exp-nodeath': '死亡不扣分。实验用：死亡帧不再立刻扣分，只停止后续计分，便于观察软死路线。',
                'exp-rustPhysics': '默认开启。用 Rust/WASM 做更快的物理预测；失败或遇到不支持的配置时会自动回退到 JS 融合世界。',
                'exp-growWithoutThreats': '无子弹时预热。没有子弹时也让树继续生长，用来提前准备路线；会占更多内存和计算量。',
                'exp-growLayers': '每个游戏帧最多新增多少层树节点。默认 1 层最稳；数值越大，生长越快，但计算压力也越大。',
                'exp-maxNodes': '预测树最多保留多少个节点。数值越大，记得越远，但也会更耗内存和计算。',
                'exp-warmupMaxNodes': '没有子弹时，预热阶段最多保留多少节点，防止开局等待过久导致卡顿。',
                'exp-nodeCap': '节点数量上限。是否启用这个上限。关闭后，战斗中可以超过它，但无弹药预热仍受“预热上限”限制。',
                'exp-horizonSec': '预测时长上限，单位秒，范围 1~15 秒。数值越大，树看得越远，但计算量也越大。',
                'exp-horizonCap': '是否启用预测时长上限。开启后，超过设定秒数就不再继续往前生长。',
                'exp-refineBeyond': '达到节点或时长上限后，不再直接停止，而是继续把长操作拆得更细，寻找更多分叉。',
                'exp-continuousRefine': '不等到达上限，每帧都额外拆一次长操作，让树更细腻；计算量和节点增长都会明显变大。',
                'exp-pruneCompensateLayers': '新子弹出现导致节点被大量剪掉后，接下来几帧每帧额外多长多少层树节点。默认 0 层，等于关闭。',
                'exp-pruneCompensateFrames': '剪枝补偿持续多少帧。默认 1 帧，范围 1~60。',
                'exp-retreatNodes': '预测到必死时，最多向上退多少个树节点再找替代路线。',
                'exp-retreatFrames': '预测到必死时，最多向上退多少帧的操作时间。和回退节点数谁先到，就从哪里开始找替代路线。',
                'exp-rustMinimal': '实验开关：只让 Rust 参与最终选路，不参与物理模拟和树结构。适合单独测试 Rust 的选路效果。',
                'exp-deepSelect': '全局选路。实验功能：当前版本开启后 AI 会明显变弱，暂不建议开启，后续会重做。',
                'exp-presetStrong': '将配置重置为作者L_Shy_P实测出的AI较强且性能不错的配置。'
            };
            Object.keys(tips).forEach(function(k) {
                var el = expRow.querySelector('[data-act="' + k + '"]');
                if (el) el.dataset.tip = tips[k];
            });
            var tip = document.createElement('div');
            tip.style.cssText = 'position:fixed;z-index:100000;display:none;max-width:280px;padding:5px 8px;' +
                'background:#11111b;color:#cdd6f4;border:1px solid #6c7086;border-radius:4px;' +
                'font:11px/1.5 Consolas,monospace;pointer-events:none;white-space:normal;';
            document.body.appendChild(tip);
            var timer = null, current = null;
            function placeTip(x, y) {
                tip.style.left = Math.max(8, Math.min((window.innerWidth || 1920) - 292, x + 12)) + 'px';
                tip.style.top = Math.max(8, Math.min((window.innerHeight || 1080) - 80, y + 14)) + 'px';
            }
            function showTip(el, x, y) {
                tip.textContent = el.dataset.tip || '';
                tip.style.display = 'block';
                placeTip(x, y);
            }
            expRow.addEventListener('mouseover', function(e) {
                var t = e.target;
                while (t && t !== expRow && !(t.dataset && t.dataset.tip)) t = t.parentNode;
                if (!t || t === expRow) return;
                current = t;
                clearTimeout(timer);
                timer = setTimeout(function() {
                    if (current === t) showTip(t, e.clientX || 0, e.clientY || 0);
                }, 500);
            });
            expRow.addEventListener('mouseout', function() {
                current = null;
                clearTimeout(timer);
                tip.style.display = 'none';
            });
            expRow.addEventListener('mousemove', function(e) {
                if (tip.style.display === 'block') placeTip(e.clientX || 0, e.clientY || 0);
            });
        })();

        // 滑块 input：实时数字（change 委托落值+重跑，防抖不叠加）
        if (_expCtrl.slider) {
            _expCtrl.slider.addEventListener('input', function() {
                state.exp.evalFrames = Math.max(1, Math.min(300, parseInt(_expCtrl.slider.value, 10) || 75));
                if (_expCtrl.framesSpan) {
                    _expCtrl.framesSpan.textContent = state.exp.evalFrames + '帧';
                }
            });
        }
        if (_expCtrl.growLayers) {
            _expCtrl.growLayers.addEventListener('input', function() {
                state.exp.growLayers = Math.max(1, Math.min(6, parseInt(_expCtrl.growLayers.value, 10) || 1));
                if (_expCtrl.growLayersSpan) {
                    _expCtrl.growLayersSpan.textContent = state.exp.growLayers + '层';
                }
            });
        }
        if (_expCtrl.maxNodes) {
            _expCtrl.maxNodes.addEventListener('input', function() {
                state.exp.maxNodes = Math.max(100, Math.min(3000, parseInt(_expCtrl.maxNodes.value, 10) || 500));
                if (_expCtrl.maxNodesSpan) {
                    _expCtrl.maxNodesSpan.textContent = String(state.exp.maxNodes);
                }
            });
        }
        // v89：预热上限 + 回退量两个滑块也走 input 实时落值，
        // 否则拖动过程中 updatePanel 的 syncExpControls 会把滑块弹回旧值。
        if (_expCtrl.warmupMaxNodes) {
            _expCtrl.warmupMaxNodes.addEventListener('input', function() {
                state.exp.warmupMaxNodes = Math.max(100, Math.min(3000, parseInt(_expCtrl.warmupMaxNodes.value, 10) || 500));
                if (_expCtrl.warmupMaxNodesSpan) {
                    _expCtrl.warmupMaxNodesSpan.textContent = String(state.exp.warmupMaxNodes);
                }
            });
        }
        if (_expCtrl.retreatNodes) {
            _expCtrl.retreatNodes.addEventListener('input', function() {
                state.exp.retreatNodes = Math.max(1, Math.min(32, parseInt(_expCtrl.retreatNodes.value, 10) || 3));
                if (_expCtrl.retreatNodesSpan) {
                    _expCtrl.retreatNodesSpan.textContent = String(state.exp.retreatNodes) + '点';
                }
            });
        }
        if (_expCtrl.retreatFrames) {
            _expCtrl.retreatFrames.addEventListener('input', function() {
                state.exp.retreatFrames = Math.max(10, Math.min(600, parseInt(_expCtrl.retreatFrames.value, 10) || 200));
                if (_expCtrl.retreatFramesSpan) {
                    _expCtrl.retreatFramesSpan.textContent = String(state.exp.retreatFrames) + '帧';
                }
            });
        }
        if (_expCtrl.horizonSec) {
            _expCtrl.horizonSec.addEventListener('input', function() {
                var v = parseFloat(_expCtrl.horizonSec.value);
                state.exp.horizonSec = Math.max(1, Math.min(15, isFinite(v) ? v : 8));
                if (_expCtrl.horizonSecSpan) {
                    _expCtrl.horizonSecSpan.textContent = state.exp.horizonSec + '秒';
                }
            });
        }
        if (_expCtrl.pruneCompensateLayers) {
            _expCtrl.pruneCompensateLayers.addEventListener('input', function() {
                state.exp.pruneCompensateLayers = Math.max(0, Math.min(9, parseInt(_expCtrl.pruneCompensateLayers.value, 10) || 0));
                if (_expCtrl.pruneCompensateLayersSpan) {
                    _expCtrl.pruneCompensateLayersSpan.textContent = state.exp.pruneCompensateLayers + '层';
                }
            });
        }
        if (_expCtrl.pruneCompensateFrames) {
            _expCtrl.pruneCompensateFrames.addEventListener('input', function() {
                state.exp.pruneCompensateFrames = Math.max(1, Math.min(60, parseInt(_expCtrl.pruneCompensateFrames.value, 10) || 1));
                if (_expCtrl.pruneCompensateFramesSpan) {
                    _expCtrl.pruneCompensateFramesSpan.textContent = state.exp.pruneCompensateFrames + '帧';
                }
            });
        }

        // —— 数据区（每帧刷新，无交互控件，重建无害）——
        var body = document.createElement('div');
        body.id = 'vt-data';
        body.style.cssText = 'flex:1 1 auto;min-height:120px;padding:6px 10px;overflow:visible';
        el.appendChild(body);
        _panelBody = body;

        // —— 图例（静态，只建一次）——
        var legend = document.createElement('div');
        legend.style.cssText = 'padding:4px 10px 6px;color:#6c7086;font-size:10px;border-top:1px solid #45475a';
        legend.innerHTML = '弹道:红急/橙近/灰远 黄圈=基准 | 遮蔽红扇 剩余绿扇<br>' +
            '树:蓝→绿=分高 红=死 灰=执行过/弃 青圈=提交 金线=预定路线';
        el.appendChild(legend);

        // change 事件委托（AI 操控下拉/勾选，change 也冒泡）
        el.addEventListener('change', function(e) {
            var t = e.target;
            if (t && t.dataset && t.dataset.act) {
                handlePanelAction(t.dataset.act, t.dataset, t);
            }
        });

        document.body.appendChild(el);
        _panel = el;

        // v91：允许从面板任意空白处拖动，不再只能抓标题栏。
        // 输入框、按钮、下拉、标签、画布和带 data-act 的折叠行仍然走原有交互。
        function isPanelInteractive(t) {
            var n = t;
            while (n && n !== el) {
                if (n.dataset && n.dataset.act) return true;
                var tag = (n.tagName || '').toLowerCase();
                if (tag === 'button' || tag === 'input' || tag === 'select' ||
                    tag === 'textarea' || tag === 'label' || tag === 'canvas' || tag === 'a') {
                    return true;
                }
                n = n.parentNode;
            }
            return false;
        }
        el.addEventListener('mousedown', function(e) {
            if (e.button !== 0) return;
            if (isPanelInteractive(e.target)) return;
            var rect = el.getBoundingClientRect();
            _drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
            e.preventDefault();
        });
        // v79：拖动功能保留，但不再改变鼠标样式；面板各处保持默认光标。
        document.addEventListener('mousemove', function(e) {
            if (!_drag) return;
            // v90：面板不再限制在屏幕内，允许拖出视口。
            el.style.left = (e.clientX - _drag.dx) + 'px';
            el.style.top = (e.clientY - _drag.dy) + 'px';
            el.style.right = 'auto';
        });
        document.addEventListener('mouseup', function() {
            _drag = null;
            if (_tv && state.treeViewOn && !_tv.userMoved) placeTreeView();
        });

        // 事件委托（内容区 + 按钮行）。
        // v7.3 关键：用 mousedown 不用 click——运行态数据区每帧 innerHTML 重建，
        // mousedown→mouseup 之间元素被替换 → click（要求两事件同元素）不触发
        // = 主人实测"不暂停时无法展开沙箱模拟"的根因。mousedown 单事件完成，
        // 不受重建影响；对按钮无副作用（面板无需文本选择/右键交互）。
        el.addEventListener('mousedown', function(e) {
            var t = e.target;
            var tag = t && t.tagName;
            // select/input/label 保持原生行为（preventDefault 会杀下拉展开/勾选）
            if (tag === 'SELECT' || tag === 'OPTION' || tag === 'INPUT' || tag === 'LABEL') return;
            while (t && t !== el) {
                if (t.dataset && t.dataset.act) {
                    e.preventDefault();   // 防按钮焦点抢占
                    handlePanelAction(t.dataset.act, t.dataset);
                    return;
                }
                t = t.parentNode;
            }
        });
        return el;
    }

    function handlePanelAction(act, ds, srcEl) {
        if (act === 'pause') { togglePause(); return; }
        if (act === 'step1') { requestStep(1); return; }
        if (act === 'step10') { requestStep(10); return; }
        if (act === 'viz') { state.vizOn = !state.vizOn; renderViz(); syncButtonLabels(); return; }
        if (act === 'tree') { toggleTreeView(); return; }   // v7.8 树视图
        if (act === 'export') { exportSnapshots(); return; }
        // —— v6 AI 操控 ——
        if (act === 'aiop-toggle') { state.aiControl.enabled = !state.aiControl.enabled; syncAiControl(); return; }
        if (act === 'aiop-select') {
            var v = parseInt(srcEl.value, 10);
            if (v === -1) {
                state.aiControl.auto = true;    // 选「自动」项
                state.aiControl.tree = false;
            } else if (v === -2) {
                state.aiControl.tree = true;    // 选「树」项（阶段③ 树循环）
                state.aiControl.auto = false;
                if (typeof VantageTree !== 'undefined') VantageTree.reset();  // 换模式重开树
                if (!state.treeViewOn) toggleTreeView();   // v7.8 选树模式自动开树图
            } else {
                state.aiControl.opIndex = Math.max(0, v || 0);
                state.aiControl.auto = false;   // 手选具体操作 = 退出自动
                state.aiControl.tree = false;
            }
            if (!state.aiControl.enabled) state.aiControl.enabled = true;   // 选中即启用
            syncAiControl();
            return;
        }
        if (act === 'aiop-auto') {
            state.aiControl.enabled = true;
            state.aiControl.auto = srcEl.checked;
            if (srcEl.checked) state.aiControl.tree = false;
            syncAiControl();
            return;
        }
        // —— v7.4 实验模式（A/B 对比）——
        if (act === 'exp-fixed75') {
            state.exp.fixed75 = srcEl.checked;
            if (state.paused) { runNineOps(); renderViz(); }   // 暂停态立即按新模式重跑
            updatePanel();
            return;
        }
        if (act === 'exp-nodeath') {
            state.exp.noDeath = srcEl.checked;
            if (state.paused) { runNineOps(); renderViz(); }
            updatePanel();
            return;
        }
        // —— v7.6 车道压分开关（主人 2026-08-16 要求）——
        if (act === 'exp-lane') {
            state.exp.lane = srcEl.checked;
            // v47：树内 lane 开关真正接到树配置；testbench 只做 UI 与手动评分。
            if (typeof VantageTree !== 'undefined') VantageTree.setLaneEnabled(state.exp.lane);
            if (state.paused) { runNineOps(); renderViz(); }
            updatePanel();
            return;
        }
        // —— v49 弹簧绳开关（配合树 v53）——
        if (act === 'exp-springRope') {
            state.exp.springRope = srcEl.checked;
            if (typeof VantageTree !== 'undefined') VantageTree.setSpringRopeEnabled(state.exp.springRope);
        if (typeof VantageTree !== 'undefined') VantageTree.setRustMinimalEnabled(state.exp.rustMinimal);
        if ((state.exp.rustMinimal || state.exp.rustPhysics) && typeof VantageRustBridge !== 'undefined') {
            VantageRustBridge.init().catch(function(e) { console.warn('[Testbench] Rust init:', e); });
        }
            if (state.paused) { runNineOps(); renderViz(); }
            updatePanel();
            return;
        }
        // —— v52 Rust 最小决策开关（配合树 v69）——
        if (act === 'exp-rustMinimal') {
            state.exp.rustMinimal = srcEl.checked;
            if (typeof VantageTree !== 'undefined') VantageTree.setRustMinimalEnabled(state.exp.rustMinimal);
            if ((state.exp.rustMinimal || state.exp.rustPhysics) && typeof VantageRustBridge !== 'undefined') {
                VantageRustBridge.init().catch(function(e) {
                    console.warn('[Testbench] VantageRustBridge init failed:', e);
                });
            }
            updatePanel();
            return;
        }
        // —— v54 Rust 物理预测开关（配合 VantageSandbox v30 / Rust ABI v2+v3）——
        // 开启后树 rollouts 走 vt_rollout_batch 预测，stale 层刷新还会优先走
        // vt_rescore_nodes（adapter.rescoreTankSamples）增量重评分。
        if (act === 'exp-rustPhysics') {
            state.exp.rustPhysics = srcEl.checked;
            // v90：Rust 路径不支持弹簧绳；开启 Rust 物理时自动关掉弹簧绳，
            // 避免隐藏的复选框还在偷偷影响评分路径。
            if (state.exp.rustPhysics && state.exp.springRope) {
                state.exp.springRope = false;
                if (typeof VantageTree !== 'undefined') VantageTree.setSpringRopeEnabled(false);
            }
            if (typeof VantageSandbox !== 'undefined') {
                try { VantageSandbox.setRustPhysicsEnabled(state.exp.rustPhysics); } catch (eRustPhys) {}
            }
            if (state.exp.rustPhysics && typeof VantageRustBridge !== 'undefined') {
                VantageRustBridge.init().catch(function(e) {
                    console.warn('[Testbench] VantageRustBridge init failed:', e);
                });
            }
            updatePanel();
            return;
        }
        // —— v60 无弹生长开关（配合树 v77）：无子弹时也把树长满做性能实验 ——
        if (act === 'exp-growWithoutThreats') {
            state.exp.growWithoutThreats = srcEl.checked;
            if (typeof VantageTree !== 'undefined') {
                VantageTree.setGrowWithoutThreatsEnabled(state.exp.growWithoutThreats);
            }
            updatePanel();
            return;
        }
        // —— v81 深层选路实验开关 ——
        if (act === 'exp-deepSelect') {
            state.exp.deepSelect = srcEl.checked;
            if (typeof VantageTree !== 'undefined') {
                VantageTree.setDeepSelectEnabled(state.exp.deepSelect);
            }
            updatePanel();
            return;
        }
        // —— v87/v91 重置配置：恢复到作者实测较强且性能不错的实验项组合 ——
        if (act === 'exp-presetStrong') {
            state.exp.growLayers = 1;
            state.exp.nodeCap = false;
            state.exp.horizonCap = true;
            state.exp.horizonSec = 8;
            state.exp.refineBeyond = true;
            state.exp.continuousRefine = false;
            state.exp.pruneCompensateLayers = 0;
            state.exp.pruneCompensateFrames = 1;
            state.exp.retreatNodes = 3;
            state.exp.retreatFrames = 200;
            state.exp.warmupMaxNodes = 500;
            state.exp.growWithoutThreats = true;
            state.exp.deepSelect = false;
            if (state.exp.rustPhysics) state.exp.springRope = false;
            if (typeof VantageTree !== 'undefined') {
                VantageTree.setGrowLayersPerTick(state.exp.growLayers);
                VantageTree.setNodeCapEnabled(state.exp.nodeCap);
                VantageTree.setHorizonCapEnabled(state.exp.horizonCap);
                VantageTree.setHorizonSec(state.exp.horizonSec);
                VantageTree.setRefineBeyondLimits(state.exp.refineBeyond);
                VantageTree.setContinuousRefine(state.exp.continuousRefine);
                VantageTree.setPruneCompensateLayers(state.exp.pruneCompensateLayers);
                VantageTree.setPruneCompensateFrames(state.exp.pruneCompensateFrames);
                VantageTree.setRetreatNodes(state.exp.retreatNodes);
                VantageTree.setRetreatFrames(state.exp.retreatFrames);
                VantageTree.setWarmupMaxNodes(state.exp.warmupMaxNodes);
                VantageTree.setGrowWithoutThreatsEnabled(state.exp.growWithoutThreats);
                VantageTree.setDeepSelectEnabled(state.exp.deepSelect);
            }
            syncExpControls();
            updatePanel();
            return;
        }
        // —— v85 三个生长限制开关 ——
        if (act === 'exp-nodeCap') {
            state.exp.nodeCap = srcEl.checked;
            if (typeof VantageTree !== 'undefined') VantageTree.setNodeCapEnabled(state.exp.nodeCap);
            updatePanel();
            return;
        }
        if (act === 'exp-horizonCap') {
            state.exp.horizonCap = srcEl.checked;
            if (typeof VantageTree !== 'undefined') VantageTree.setHorizonCapEnabled(state.exp.horizonCap);
            updatePanel();
            return;
        }
        // —— v91 预测时长上限滑块（1~15 秒）——
        if (act === 'exp-horizonSec') {
            var hv = parseFloat(srcEl.value);
            state.exp.horizonSec = Math.max(1, Math.min(15, isFinite(hv) ? hv : 8));
            if (typeof VantageTree !== 'undefined') VantageTree.setHorizonSec(state.exp.horizonSec);
            if (_expCtrl.horizonSecSpan) _expCtrl.horizonSecSpan.textContent = state.exp.horizonSec + '秒';
            updatePanel();
            return;
        }
        // —— v91 剪枝补偿滑块（0~9 层 / 1~60 帧）——
        if (act === 'exp-pruneCompensateLayers') {
            state.exp.pruneCompensateLayers = Math.max(0, Math.min(9, parseInt(srcEl.value, 10) || 0));
            if (typeof VantageTree !== 'undefined') VantageTree.setPruneCompensateLayers(state.exp.pruneCompensateLayers);
            if (_expCtrl.pruneCompensateLayersSpan) _expCtrl.pruneCompensateLayersSpan.textContent = state.exp.pruneCompensateLayers + '层';
            updatePanel();
            return;
        }
        if (act === 'exp-pruneCompensateFrames') {
            state.exp.pruneCompensateFrames = Math.max(1, Math.min(60, parseInt(srcEl.value, 10) || 1));
            if (typeof VantageTree !== 'undefined') VantageTree.setPruneCompensateFrames(state.exp.pruneCompensateFrames);
            if (_expCtrl.pruneCompensateFramesSpan) _expCtrl.pruneCompensateFramesSpan.textContent = state.exp.pruneCompensateFrames + '帧';
            updatePanel();
            return;
        }
        if (act === 'exp-refineBeyond') {
            state.exp.refineBeyond = srcEl.checked;
            if (typeof VantageTree !== 'undefined') VantageTree.setRefineBeyondLimits(state.exp.refineBeyond);
            updatePanel();
            return;
        }
        // —— v88 持续细化：不依赖“无普通叶”，每 tick 主动拆一次长操作 ——
        if (act === 'exp-continuousRefine') {
            state.exp.continuousRefine = srcEl.checked;
            if (typeof VantageTree !== 'undefined') VantageTree.setContinuousRefine(state.exp.continuousRefine);
            updatePanel();
            return;
        }
        // —— v89 回退节点数：真死回退最多向上多少节点（1~32）——
        if (act === 'exp-retreatNodes') {
            state.exp.retreatNodes = Math.max(1, Math.min(32, parseInt(srcEl.value, 10) || 3));
            if (typeof VantageTree !== 'undefined') VantageTree.setRetreatNodes(state.exp.retreatNodes);
            if (_expCtrl.retreatNodesSpan) _expCtrl.retreatNodesSpan.textContent = String(state.exp.retreatNodes) + '点';
            updatePanel();
            return;
        }
        // —— v89 回退帧数：真死回退最多向上多少帧（10~200）——
        if (act === 'exp-retreatFrames') {
            state.exp.retreatFrames = Math.max(10, Math.min(600, parseInt(srcEl.value, 10) || 200));
            if (typeof VantageTree !== 'undefined') VantageTree.setRetreatFrames(state.exp.retreatFrames);
            if (_expCtrl.retreatFramesSpan) _expCtrl.retreatFramesSpan.textContent = String(state.exp.retreatFrames) + '帧';
            updatePanel();
            return;
        }
        // —— v89 预热上限（100~3000）——
        if (act === 'exp-warmupMaxNodes') {
            state.exp.warmupMaxNodes = Math.max(100, Math.min(3000, parseInt(srcEl.value, 10) || 500));
            if (typeof VantageTree !== 'undefined') VantageTree.setWarmupMaxNodes(state.exp.warmupMaxNodes);
            if (_expCtrl.warmupMaxNodesSpan) _expCtrl.warmupMaxNodesSpan.textContent = String(state.exp.warmupMaxNodes);
            updatePanel();
            return;
        }
        // —— v84 节点数上限滑块（100~3000）——
        if (act === 'exp-maxNodes') {
            state.exp.maxNodes = Math.max(100, Math.min(3000, parseInt(srcEl.value, 10) || 500));
            if (typeof VantageTree !== 'undefined') {
                VantageTree.setMaxNodes(state.exp.maxNodes);
            }
            if (_expCtrl.maxNodesSpan) _expCtrl.maxNodesSpan.textContent = String(state.exp.maxNodes);
            updatePanel();
            return;
        }
        // —— v80 每帧生长层数滑块（1~6，完整9候选/层）——
        if (act === 'exp-growLayers') {
            state.exp.growLayers = Math.max(1, Math.min(6, parseInt(srcEl.value, 10) || 1));
            if (typeof VantageTree !== 'undefined') {
                VantageTree.setGrowLayersPerTick(state.exp.growLayers);
            }
            if (_expCtrl.growLayersSpan) _expCtrl.growLayersSpan.textContent = state.exp.growLayers + '层';
            updatePanel();
            return;
        }
        // —— v7.6 固定帧滑块落值（1~300，树评估深度联动）——
        if (act === 'exp-frames') {
            var fv = Math.max(1, Math.min(300, parseInt(srcEl.value, 10) || 75));
            state.exp.evalFrames = fv;
            if (typeof VantageTree !== 'undefined') VantageTree.setEvalFrames(fv);
            if (state.paused) { runNineOps(); renderViz(); }
            updatePanel();
            return;
        }
        if (act === 'fold') {
            // v7.7 通用折叠（多开互不干扰）
            var fk = ds.key;
            if (fk) state.expandedSet[fk] = !state.expandedSet[fk];
            updatePanel();
        } else if (act === 'op') {
            enterSandboxOp(parseInt(ds.idx, 10));
        } else if (act === 'threat') {
            var idx = parseInt(ds.idx, 10);
            state.expandedThreat = state.expandedThreat === idx ? null : idx;
            updatePanel();
        } else if (act === 'sb-exit') {
            sbExit();
        } else if (act === 'sb-step') {
            sbStep(1);
        } else if (act === 'sb-step10') {
            sbStep(10);
        } else if (act === 'sb-back') {
            sbStep(-1);
        } else if (act === 'sb-home') {
            sbStep(-state.sandbox.frameIdx);
        }
    }

    function syncButtonLabels() {
        if (!_btnRefs.pause) return;
        _btnRefs.pause.textContent = state.paused ? '▶ 继续' : '⏸ 暂停';
        _btnRefs.viz.textContent = '标注:' + (state.vizOn ? '开' : '关');
        if (_btnRefs.tree) _btnRefs.tree.textContent = '树图:' + (state.treeViewOn ? '开' : '关');
        var st = document.getElementById('vt-status');
        if (st) {
            st.textContent = state.paused ? '已暂停 · 帧 ' + state.frameCount : '运行中';
            st.style.color = state.paused ? '#f38ba8' : '#a6e3a1';
        }
    }

    function fmt(n, digits) {
        return (typeof n === 'number' && isFinite(n)) ? n.toFixed(digits === undefined ? 2 : digits) : '-';
    }

    function shortId(id) {
        return String(id).length > 14 ? String(id).slice(0, 12) + '…' : String(id);
    }

    function bestOpLine(results, bestIdx, frames) {
        if (!results || bestIdx < 0) return '最优操作: -';
        var b = results[bestIdx];
        return '最优操作: <b style="color:#a6e3a1">' + b.opName + '</b>（总分 ' + fmt(b.totalScore, 1) +
            (b.dead ? '，死亡帧 ' + b.deathFrame : '') + '，基准 ' + frames + ' 帧）';
    }

    /** 基准时间中间值展开区（v7.1：最早威胁候选 → 钳制） */
    function baseTimeDetailHtml(bt) {
        var d = bt.details;
        if (!d) return '<span style="color:#6c7086">（无中间值数据）</span>';
        var h = [];
        if (d.defaultUsed) {
            h.push('① 危险圈判定（半径 ' + fmt(d.hitRadius, 0) + 'm，画面青色圈）：' +
                d.perBullet.length + ' 颗子弹无一威胁<br>');
            h.push('② 无威胁弹 → 走位自由期 = 上限 ' + fmt(bt.baseTimeSec) + 's = ' + bt.baseTimeFrames + ' 帧（无死亡可能，粗精度长窗）');
            return h.join('');
        }
        var incC = 0, outC = 0;
        for (var i = 0; i < d.perBullet.length; i++) {
            if (d.perBullet[i].tIn !== null && d.perBullet[i].tIn !== undefined) incC++; else outC++;
        }
        h.push('① 危险圈判定（半径 ' + fmt(d.hitRadius, 0) + 'm）：' + d.perBullet.length +
            ' 颗子弹，' + incC + ' 颗威胁' + (outC ? '，' + outC + ' 颗无关（视界外/掠过）' : '') + '<br>');
        var kindTxt = d.baseKind === 'tEnd(已入圈)'
            ? '已在圈内 → 候选 = 穿出圈时刻 tEnd（出圈后弹速&gt;车速追不上=安全；弹快走完→窗口缩到 1 帧）'
            : '将入圈 → 候选 = t_in + K_post ' + fmt(d.kPostSec) + 's（弹到后再看余量，防躲进弹道延长线）';
        h.push('② 最早候选 = ★' + shortId(bt.baseBulletId) + '：' + kindTxt +
            ' = ' + fmt(d.minCandidate) + 's<br>');
        var clampNote = d.clampedLow ? '（触底 ↑ 1帧）' : (d.clampedHigh ? '（触顶 ↓）' : '（未触钳制）');
        h.push('③ 钳制 [1帧, 1.5s] → 终值 ' + fmt(bt.baseTimeSec) + 's = ' +
            bt.baseTimeFrames + ' 帧' + clampNote + '<br>');
        h.push('<span style="color:#6c7086">密集权重（仅供参考，不进公式）：W=' +
            fmt(bt.densityWeightSum, 3) + '</span>');
        return h.join('');
    }

    /** v7 每轮死亡统计（NN 调参数据源：死亡操作数 / 死亡帧相对窗尾位置） */
    function deathStats(results) {
        if (!results || !results.length) return null;
        var deaths = 0, edgeSum = 0, edgeN = 0;
        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            if (r.dead && r.deathFrame >= 0) {
                deaths++;
                edgeSum += Math.min(1, r.deathFrame / Math.max(1, r.frameCount));
                edgeN++;
            }
        }
        return { deaths: deaths, total: results.length, edgeMean: edgeN ? edgeSum / edgeN : null };
    }

    function deathStatsHtml(results) {
        var st = deathStats(results);
        if (!st) return '';
        var edgeTxt = st.edgeMean === null ? '-' : fmt(st.edgeMean, 2);
        var col = st.deaths <= 3 ? '#a6e3a1' : '#f9e2af';
        return '<span style="color:' + col + '">死亡操作 ' + st.deaths + '/' + st.total +
            '（目标≤3）| 死亡位置均值 ' + edgeTxt + '（越贴窗尾 1.0 越好）</span><br>';
    }

    function threatDetailHtml(th, consts) {
        var dHit = (th && th._dHit) || 10;
        var h = [];
        h.push('<div style="margin:2px 0 4px;padding:4px 6px;background:#181825;border:1px solid #45475a;border-radius:4px">');
        if (th.tIn === null || th.tIn === undefined) {
            h.push('<span style="color:#6c7086">不入圈弹：1.5s 视界内沿整条折线 d(t) 始终 &gt; ' + dHit +
                'm（危险圈）——弹速(≥18m/s)恒大于坦克最大速(15.95)，圈外坦克永远追不上，不可能相撞</span>');
        } else {
            h.push('危险圈：以坦克当前位置为圆心、半径 ' + dHit + 'm 的固定圆（画面青色圈）<br>');
            h.push('折线采样：' + (th.path ? th.path.length : 0) + ' 个折点，弹速 ' + fmt(th.speed, 1) + ' m/s<br>');
            h.push('v7 首入圈时刻 t_in = ' + fmt(th.tIn) + 's（穿入段插值；已在圈内 = 0）——' +
                '基准时间取最早者 +K_post<br>');
            if (th.tEnd !== null) {
                h.push('首窗结束 tEnd = ' + fmt(th.tEnd) + 's（首窗锁定：出圈即定，折返段不追踪）<br>');
            } else {
                h.push('视界末端仍在圈内（tEnd 未定）<br>');
            }
            h.push('折线离坦克当前位置最近 ' + fmt(th.closestDist, 2) + 'm');
        }
        h.push('</div>');
        return h.join('');
    }

    function drawSparkline(canvas, history) {
        if (!canvas || !canvas.getContext) return;
        var ctx2 = canvas.getContext('2d');
        var w = canvas.width, h = canvas.height;
        ctx2.clearRect(0, 0, w, h);
        if (history.length < 2) return;
        var max = -Infinity, min = Infinity;
        var i;
        for (i = 0; i < history.length; i++) {
            var v = history[i].score;
            if (v > max) max = v;
            if (v < min) min = v;
        }
        if (max - min < 1e-6) { max += 1; min -= 1; }
        ctx2.strokeStyle = '#a6e3a1';
        ctx2.lineWidth = 1.5;
        ctx2.beginPath();
        for (i = 0; i < history.length; i++) {
            var x = i / (history.length - 1) * (w - 4) + 2;
            var y = h - 3 - (history[i].score - min) / (max - min) * (h - 6);
            if (i === 0) ctx2.moveTo(x, y); else ctx2.lineTo(x, y);
        }
        ctx2.stroke();
    }

    function updatePanel() {
        // 最后防线：面板刷新自身的任何 bug 只降级为红字，绝不炸调用链
        // （updatePanel 被 perfTick/afterStep/键鼠 handler 多处调用，入口统一兜底）
        try {
            updatePanelInner();
        } catch (eU) {
            console.error('[Testbench] updatePanel 异常:', eU);
            try {
                if (_panelBody) _panelBody.innerHTML =
                    '<div style="color:#f38ba8">⛔ 面板渲染异常: ' +
                    (eU && eU.message ? eU.message : eU) + '</div>';
            } catch (eW) {}
        }
    }

    function updatePanelInner() {
        var el = ensurePanel();
        if (!state.panelOn) { el.style.display = 'none'; return; }
        el.style.display = 'flex';
        syncButtonLabels();
        syncAiControl();
        syncExpControls();
        syncExpVisibility();
        if (!_panelBody) return;

        var html = [];
        // 异常显形（v6.1：不再静默吞掉——主人能直接看到计算挂在哪一步）
        if (state.errRun) html.push('<div style="color:#f38ba8">⛔ ' + state.errRun + '</div>');
        if (state.errLight) html.push('<div style="color:#f38ba8">⚠ ' + state.errLight + '</div>');
        if (state.errNine) html.push('<div style="color:#f38ba8">⚠ ' + state.errNine + '</div>');
        // v7.1：双态统一布局（暂停/运行只差数据源与沙箱交互性）
        html = html.concat(renderBody());
        // v6.1：AI 操控与图例已移入持久结构层，此处只刷数据区
        _panelBody.innerHTML = html.join('');
        var spark = document.getElementById('vt-spark');
        if (spark) drawSparkline(spark, state.history);
        drawTree();   // v7.8 树视图随面板节流刷新（独立 try 在内）
    }

    /** v6.1 同步持久 AI 操控控件显示（只改属性/文本，不重建 DOM） */
    function syncAiControl() {
        if (!_aiCtrl || !_aiCtrl.toggleBtn || !_aiCtrl.select) return;
        var c = state.aiControl;
        _aiCtrl.toggleBtn.textContent = c.enabled ? '已启用（点击关闭）' : '已静止（点击启用）';
        _aiCtrl.toggleBtn.style.background = c.enabled ? '#4a6a4a' : '#45475a';
        if (_aiCtrl.autoChk && _aiCtrl.autoChk.checked !== c.auto) _aiCtrl.autoChk.checked = c.auto;
        var wantVal = c.tree ? '-2' : (c.auto ? '-1' : String(c.opIndex));
        if (_aiCtrl.select.value !== wantVal) _aiCtrl.select.value = wantVal;
        var txt = '';
        if (c.enabled) {
            if (c.tree) {
                var tr = (typeof VantageTree !== 'undefined') ? VantageTree.getTree() : null;
                txt = tr && tr.commitNode
                    ? '执行: 树·' + (tr.commitNode.opName || '?') + ' ' + tr.commitFrame + '/' + tr.commitNode.segmentFrames + '帧'
                    : '执行: 树（初始化…）';
            } else if (c.auto) {
                var best = '等待首轮 9 操作…';
                var src = state.paused ? state.sandbox : state.live;
                if (src && src.bestIdx >= 0 && src.results && src.results[src.bestIdx]) {
                    best = src.results[src.bestIdx].opName;
                }
                txt = '执行: ' + best;
            } else {
                var ops = VantageSandbox.OPERATIONS;
                txt = '执行: ' + ops[Math.max(0, Math.min(ops.length - 1, c.opIndex))].name;
            }
        }
        if (_aiCtrl.nowSpan && _aiCtrl.nowSpan.textContent !== txt) _aiCtrl.nowSpan.textContent = txt;
        syncExpVisibility();
    }

    /** v90：按当前 AI 模式 / Rust 模式显示对应的实验参数，避免无关项挤在一起。
     *  树模式：显示生长、回退、选路；非树模式隐藏并给一行提示。
     *  Rust物理：Rust 路径不支持弹簧绳，直接隐藏弹簧绳并显示提示。 */
    function syncExpVisibility() {
        if (!_expCtrl) return;
        var treeMode = !!(state.aiControl && state.aiControl.tree);
        var treeRows = [_expCtrl.treeRow, _expCtrl.retreatRow, _expCtrl.routeRow];
        for (var i = 0; i < treeRows.length; i++) {
            if (treeRows[i]) treeRows[i].style.display = treeMode ? 'flex' : 'none';
        }
        if (_expCtrl.treeHint) _expCtrl.treeHint.style.display = treeMode ? 'none' : 'block';
        var rustOn = !!state.exp.rustPhysics;
        if (_expCtrl.springItem) _expCtrl.springItem.style.display = rustOn ? 'none' : 'inline-flex';
        if (_expCtrl.rustNote) _expCtrl.rustNote.style.display = rustOn ? 'inline-flex' : 'none';
    }

    /** v7.4→v7.6 同步持久实验模式控件（只改属性，不重建 DOM） */
    function syncExpControls() {
        if (!_expCtrl) return;
        if (_expCtrl.f75 && _expCtrl.f75.checked !== state.exp.fixed75) _expCtrl.f75.checked = state.exp.fixed75;
        if (_expCtrl.nd && _expCtrl.nd.checked !== state.exp.noDeath) _expCtrl.nd.checked = state.exp.noDeath;
        if (_expCtrl.lane && _expCtrl.lane.checked !== state.exp.lane) _expCtrl.lane.checked = state.exp.lane;
        if (_expCtrl.springRope && _expCtrl.springRope.checked !== state.exp.springRope) _expCtrl.springRope.checked = state.exp.springRope;
        if (_expCtrl.rustMinimal && _expCtrl.rustMinimal.checked !== state.exp.rustMinimal) _expCtrl.rustMinimal.checked = state.exp.rustMinimal;
        if (_expCtrl.rustPhysics && _expCtrl.rustPhysics.checked !== state.exp.rustPhysics) _expCtrl.rustPhysics.checked = state.exp.rustPhysics;
        if (_expCtrl.deepSelect && _expCtrl.deepSelect.checked !== state.exp.deepSelect) _expCtrl.deepSelect.checked = state.exp.deepSelect;
        if (_expCtrl.growWithoutThreats && _expCtrl.growWithoutThreats.checked !== state.exp.growWithoutThreats) _expCtrl.growWithoutThreats.checked = state.exp.growWithoutThreats;
        if (_expCtrl.growLayers && parseInt(_expCtrl.growLayers.value, 10) !== state.exp.growLayers) _expCtrl.growLayers.value = String(state.exp.growLayers);
        if (_expCtrl.growLayersSpan && _expCtrl.growLayersSpan.textContent !== state.exp.growLayers + '层') _expCtrl.growLayersSpan.textContent = state.exp.growLayers + '层';
        if (_expCtrl.maxNodes && parseInt(_expCtrl.maxNodes.value, 10) !== state.exp.maxNodes) _expCtrl.maxNodes.value = String(state.exp.maxNodes);
        if (_expCtrl.maxNodesSpan && _expCtrl.maxNodesSpan.textContent !== String(state.exp.maxNodes)) _expCtrl.maxNodesSpan.textContent = String(state.exp.maxNodes);
        if (_expCtrl.warmupMaxNodes && parseInt(_expCtrl.warmupMaxNodes.value, 10) !== state.exp.warmupMaxNodes) _expCtrl.warmupMaxNodes.value = String(state.exp.warmupMaxNodes);
        if (_expCtrl.warmupMaxNodesSpan && _expCtrl.warmupMaxNodesSpan.textContent !== String(state.exp.warmupMaxNodes)) _expCtrl.warmupMaxNodesSpan.textContent = String(state.exp.warmupMaxNodes);
        if (_expCtrl.nodeCap && _expCtrl.nodeCap.checked !== state.exp.nodeCap) _expCtrl.nodeCap.checked = state.exp.nodeCap;
        if (_expCtrl.horizonCap && _expCtrl.horizonCap.checked !== state.exp.horizonCap) _expCtrl.horizonCap.checked = state.exp.horizonCap;
        if (_expCtrl.horizonSec && parseFloat(_expCtrl.horizonSec.value) !== state.exp.horizonSec) _expCtrl.horizonSec.value = String(state.exp.horizonSec);
        if (_expCtrl.horizonSecSpan && _expCtrl.horizonSecSpan.textContent !== state.exp.horizonSec + '秒') _expCtrl.horizonSecSpan.textContent = state.exp.horizonSec + '秒';
        if (_expCtrl.pruneCompensateLayers && parseInt(_expCtrl.pruneCompensateLayers.value, 10) !== state.exp.pruneCompensateLayers) _expCtrl.pruneCompensateLayers.value = String(state.exp.pruneCompensateLayers);
        if (_expCtrl.pruneCompensateLayersSpan && _expCtrl.pruneCompensateLayersSpan.textContent !== state.exp.pruneCompensateLayers + '层') _expCtrl.pruneCompensateLayersSpan.textContent = state.exp.pruneCompensateLayers + '层';
        if (_expCtrl.pruneCompensateFrames && parseInt(_expCtrl.pruneCompensateFrames.value, 10) !== state.exp.pruneCompensateFrames) _expCtrl.pruneCompensateFrames.value = String(state.exp.pruneCompensateFrames);
        if (_expCtrl.pruneCompensateFramesSpan && _expCtrl.pruneCompensateFramesSpan.textContent !== state.exp.pruneCompensateFrames + '帧') _expCtrl.pruneCompensateFramesSpan.textContent = state.exp.pruneCompensateFrames + '帧';
        if (_expCtrl.refineBeyond && _expCtrl.refineBeyond.checked !== state.exp.refineBeyond) _expCtrl.refineBeyond.checked = state.exp.refineBeyond;
        if (_expCtrl.continuousRefine && _expCtrl.continuousRefine.checked !== state.exp.continuousRefine) _expCtrl.continuousRefine.checked = state.exp.continuousRefine;
        if (_expCtrl.retreatNodes && parseInt(_expCtrl.retreatNodes.value, 10) !== state.exp.retreatNodes) _expCtrl.retreatNodes.value = String(state.exp.retreatNodes);
        if (_expCtrl.retreatNodesSpan && _expCtrl.retreatNodesSpan.textContent !== state.exp.retreatNodes + '点') _expCtrl.retreatNodesSpan.textContent = state.exp.retreatNodes + '点';
        if (_expCtrl.retreatFrames && parseInt(_expCtrl.retreatFrames.value, 10) !== state.exp.retreatFrames) _expCtrl.retreatFrames.value = String(state.exp.retreatFrames);
        if (_expCtrl.retreatFramesSpan && _expCtrl.retreatFramesSpan.textContent !== state.exp.retreatFrames + '帧') _expCtrl.retreatFramesSpan.textContent = state.exp.retreatFrames + '帧';
        // v47/v49/v60：UI 与树配置保持一致；初始化/同步时都同步一次。
        if (typeof VantageTree !== 'undefined') VantageTree.setLaneEnabled(state.exp.lane);
        if (typeof VantageTree !== 'undefined') VantageTree.setSpringRopeEnabled(state.exp.springRope);
        if (typeof VantageTree !== 'undefined') VantageTree.setGrowWithoutThreatsEnabled(state.exp.growWithoutThreats);
        if (typeof VantageTree !== 'undefined') VantageTree.setGrowLayersPerTick(state.exp.growLayers);
        if (typeof VantageTree !== 'undefined') VantageTree.setMaxNodes(state.exp.maxNodes);
        if (typeof VantageTree !== 'undefined') VantageTree.setWarmupMaxNodes(state.exp.warmupMaxNodes);
        if (typeof VantageTree !== 'undefined') VantageTree.setNodeCapEnabled(state.exp.nodeCap);
        if (typeof VantageTree !== 'undefined') VantageTree.setHorizonCapEnabled(state.exp.horizonCap);
        if (typeof VantageTree !== 'undefined') VantageTree.setHorizonSec(state.exp.horizonSec);
        if (typeof VantageTree !== 'undefined') VantageTree.setRefineBeyondLimits(state.exp.refineBeyond);
        if (typeof VantageTree !== 'undefined') VantageTree.setContinuousRefine(state.exp.continuousRefine);
        if (typeof VantageTree !== 'undefined') VantageTree.setPruneCompensateLayers(state.exp.pruneCompensateLayers);
        if (typeof VantageTree !== 'undefined') VantageTree.setPruneCompensateFrames(state.exp.pruneCompensateFrames);
        if (typeof VantageTree !== 'undefined') VantageTree.setRetreatNodes(state.exp.retreatNodes);
        if (typeof VantageTree !== 'undefined') VantageTree.setRetreatFrames(state.exp.retreatFrames);
        if (typeof VantageTree !== 'undefined') VantageTree.setDeepSelectEnabled(state.exp.deepSelect);
        if (typeof VantageSandbox !== 'undefined') {
            try { VantageSandbox.setRustPhysicsEnabled(state.exp.rustPhysics); } catch (eRustPhysSync) {}
        }
        if (_expCtrl.slider && parseInt(_expCtrl.slider.value, 10) !== state.exp.evalFrames) {
            _expCtrl.slider.value = String(state.exp.evalFrames);
        }
        if (_expCtrl.framesSpan) {
            var txt = state.exp.evalFrames + '帧';
            if (_expCtrl.framesSpan.textContent !== txt) _expCtrl.framesSpan.textContent = txt;
        }
    }

    /** v84：生长停滞原因摘要。 */
    function growStallText(stalls) {
        if (!stalls) return '-';
        var keys = Object.keys(stalls);
        if (!keys.length) return '-';
        keys.sort(function(a, b) { return stalls[b] - stalls[a]; });
        var out = [];
        for (var i = 0; i < keys.length && i < 4; i++) {
            out.push(keys[i] + ':' + stalls[keys[i]]);
        }
        return out.join(' ');
    }

    /** v7.7 配色：耗时/帧率分档（绿=健康 黄=注意 红=紧张） */
    function colMs(ms) { return ms < 5 ? '#a6e3a1' : (ms < 15 ? '#f9e2af' : '#f38ba8'); }
    function colFps(fps) { return fps >= 50 ? '#a6e3a1' : (fps >= 30 ? '#f9e2af' : '#f38ba8'); }

    /** v7.7 折叠行（多开互不干扰，标题带摘要） */
    function foldRow(key, labelHtml, bodyHtml) {
        var open = !!state.expandedSet[key];
        var h = '<div data-act="fold" data-key="' + key + '" style="cursor:pointer;padding:2px 0;color:#89b4fa">' +
            (open ? '▾' : '▸') + ' ' + labelHtml + '</div>';
        if (open && bodyHtml) {
            h += '<div style="padding:3px 6px;margin:2px 0 4px;background:#181825;border:1px solid #45475a;border-radius:4px">' +
                bodyHtml + '</div>';
        }
        return h;
    }

    /** v7.7 面板：主页六项（帧率/用时/基准/操作+分/树节点/视界）+ 全折叠区 */
    /** v90：面板内嵌的新人速查。完整版在 docs/Vantage躲弹实现/面板使用指南-新人版.md */
    function panelGuideHtml() {
        var h = [];
        h.push('<div style="line-height:1.7">');
        h.push('<b style="color:#f5c2e7">按键</b> T 面板 / P 暂停 / Y 树图 / V 标注 / E 导出<br>');
        h.push('<b style="color:#89b4fa">模式</b> AI 操控选“自动”=9 操作最高分；选“树”=预测树。只有树模式才显示生长/回退/选路。<br>');
        h.push('<b style="color:#89dceb">评分类</b> 固定帧数评估、轨迹距离评分、弹簧绳评分、死亡不扣分。<br>');
        h.push('<b style="color:#89b4fa">Rust类</b> Rust 物理预测默认开；Rust 不支持的配置会自动回退 JS。开启 Rust 时弹簧绳评分会隐藏并关闭。<br>');
        h.push('<b style="color:#f9e2af">生长类</b> 无子弹时预热、每帧生长层数、节点数量上限、预热上限、预测时长上限（1~15 秒）、超上限细化长路径、细化长路径、剪枝补偿层数/持续帧数。<br>');
        h.push('<b style="color:#cba6f7">回退类</b> 回退节点数 1~32、回退帧数 10~600；谁先到就从哪里找替代路线。<br>');
        h.push('<b style="color:#a6e3a1">选路类</b> Rust 简化选路、全局选路、重置配置（回到作者 L_Shy_P 实测较强且性能不错的配置）。<br>');
        h.push('<b style="color:#a6e3a1">树图</b> 默认贴在地图右侧边缘，不遮地图；标题栏可拖，双击标题栏回到默认位置，滚轮缩放，点节点看详情。<br>');
        h.push('<b style="color:#fab387">最稳起手（默认）</b> Rust 物理预测开、每帧生长层数 1、节点数量上限 500、预热上限 500、预测时长 8 秒、剪枝补偿 0 层/1 帧、回退节点数 3、回退帧数 200、细化长路径关。');
        h.push('</div>');
        return h.join('');
    }

    function renderBody() {
        var html = [];
        // 新人速查放在最上面；即使还没进入对局也能打开看
        html.push(foldRow('guide', '📖 新人上手指南（点开）', panelGuideHtml()));
        var paused = state.paused;
        var src = paused ? state.lastSnapshot : state.live;
        var aiDead = false;
        if (!src || !src.tankState) {
            if (!paused && state.lastLive && state.lastLive.tankState) {
                src = state.lastLive;
                aiDead = true;
            } else {
                html.push('<span style="color:#6c7086">等待对局数据…</span>');
                return html;
            }
        }
        var bt = src.baseTime;
        var results = paused ? (state.sandbox && state.sandbox.results) : src.results;
        var bestIdx = paused ? (state.sandbox && state.sandbox.bestIdx) : src.bestIdx;
        var frames = paused ? (state.sandbox ? state.sandbox.frames : bt.baseTimeFrames)
            : (src.frames || bt.baseTimeFrames);
        var tr = (typeof VantageTree !== 'undefined') ? VantageTree.getTree() : null;
        var seg = paused ? (state.sandbox && state.sandbox.segment) : src.segment;

        // —— 主页 ① 运行 + 性能合成一行，去掉默认状态的冗余文字 ——
        var expBadge = (state.exp.fixed75 ? '<span style="color:#fab387">[固' + state.exp.evalFrames + '帧]</span>' : '') +
            (state.exp.noDeath ? '<span style="color:#fab387">[软死]</span>' : '');
        var stTag;
        if (aiDead) stTag = '<span style="color:#f38ba8">☠ 阵亡</span>';
        else if (paused) stTag = '<span style="color:#f38ba8">⏸ 帧' + state.frameCount + '</span>';
        else stTag = '<span style="color:#a6e3a1">▶</span>';
        html.push('<div style="margin:2px 0 1px;color:#6c7086">── 运行 / 性能 ──</div>');
        html.push('<div style="padding:1px 0">' + stTag +
            ' <b style="font-size:14px;color:' + colFps(state.fps) + '">' + (state.fps > 0 ? Math.round(state.fps) : '-') + ' FPS</b>' +
            ' <span style="color:#6c7086">|</span> 轻算 <b style="color:' + colMs(state.perfLightMs) + '">' +
            fmt(state.perfLightMs, 1) + 'ms</b>' +
            ' <span style="color:#6c7086">|</span> 9op <b style="color:' + colMs(state.perfNineMs) + '">' +
            fmt(state.perfNineMs, 1) + 'ms</b> ×' + state.perfNineCount +
            ' ' + expBadge + '</div>');
        // —— 主页 ② 操作 + 分数 ——
        html.push('<div style="margin:2px 0 1px;color:#6c7086">── 当前决策 ──</div>');
        var bestHtml;
        if (tr && tr.commitNode) {
            bestHtml = '<b style="color:#94e2d5">树·' + tr.commitNode.opName + '</b>';
        } else if (results && bestIdx >= 0 && results[bestIdx]) {
            bestHtml = '<b style="color:#a6e3a1">★' + results[bestIdx].opName + '</b>' +
                ' <b style="color:#f9e2af">' + fmt(results[bestIdx].totalScore, 0) + '</b>';
        } else {
            bestHtml = '<span style="color:#6c7086">计算中…</span>';
        }
        html.push('<div style="padding:1px 0;font-size:12px">执行 ' + bestHtml + '</div>');
        // —— 主页 ⑤ 树节点 + ⑥ 视界 ——
        html.push('<div style="margin:2px 0 1px;color:#6c7086">── 树 / 节点 ──</div>');
        if (tr) {
            var capTxt = (tr.cfg && tr.cfg.nodeCapEnabled === false)
                ? (' | 预热≤' + ((tr.cfg.warmupMaxNodes) || 500))
                : ('/' + ((tr.cfg && tr.cfg.maxNodes) || 500));
            html.push('<div style="padding:1px 0;color:#94e2d5">树 节点 <b>' + tr.nodeCount +
                capTxt +
                '</b> | 储备 <b>' + (tr.reserveCount || 0) +
                '</b> | 视界 <b style="color:#94e2d5">' + fmt(tr.horizonSec, 2) + 's</b>' +
                (tr.stats.refineSplits ? ' | 细化 <b style="color:#94e2d5">' + tr.stats.refineSplits + '</b>' : '') +
                '</div>');
        } else {
            html.push('<div style="padding:1px 0;color:#585b70">树未开（AI操控下拉选「树」）</div>');
        }

        // ================= 折叠区（默认全收起）=================
        // 基准详情
        html.push(foldRow('base', '基准详情', baseTimeDetailHtml(bt)));
        // 评分详情（单帧分/车道/剩余角/朝向/坐标对照）
        var fs = src.frameScore;
        var scoreDetail = '单帧分 <b style="color:#f9e2af">' + fmt(fs.frameScore) + '</b>' +
            (fs.dead ? ' <span style="color:#f38ba8">判死</span>' : '') +
            ' | 遮蔽 ' + fmt(fs.occludedRad) + ' rad | 区间 ' + fs.freeIntervals.length + '<br>';
        if (!state.exp.lane) {
            scoreDetail += '轨迹距离评分: <span style="color:#6c7086">关</span><br>';
        } else {
            var laneNow = (typeof VantageScoring.lanePenaltyFrame === 'function')
                ? VantageScoring.lanePenaltyFrame(src.tankState, src.threats, 0) : null;
            if (laneNow) {
                var nCross = 0;
                for (var li = 0; li < laneNow.perBullet.length; li++) {
                    if (laneNow.perBullet[li].p > 0) nCross++;
                }
                scoreDetail += '轨迹距离评分 <b style="color:' + (laneNow.penalty > 0 ? '#fab387' : '#a6e3a1') + '">' +
                    fmt(laneNow.penalty, 1) + '</b>（' + nCross + '弹穿车）<br>';
            }
        }
        var fis = [];
        for (var fi = 0; fi < fs.freeIntervals.length; fi++) {
            var ivf = fs.freeIntervals[fi];
            fis.push('[' + fmt(ivf.start * 180 / Math.PI, 0) + '°,' +
                fmt((ivf.start + ivf.width) * 180 / Math.PI, 0) + '°]');
        }
        scoreDetail += '剩余角 ' + (fis.length ? fis.join(' ') : '无') + '<br>';
        var headingOk = fs.dead ? true
            : VantageScoring.headingInFreeIntervals(src.tankState.rot, fs.freeIntervals);
        scoreDetail += '朝向 ' + (headingOk
            ? '<span style="color:#a6e3a1">✓</span>' : '<span style="color:#f38ba8">✗</span>');
        if (paused) {
            var tk0 = src.tankState;
            var geo = VantageScoring.exactGeom();
            var gcx = tk0.x + Math.sin(tk0.rot) * geo.GEO_OFFSET;
            var gcy = tk0.y - Math.cos(tk0.rot) * geo.GEO_OFFSET;
            scoreDetail += '<br>几何中心 (' + fmt(gcx, 2) + ',' + fmt(gcy, 2) + ') rot ' +
                fmt(tk0.rot * 180 / Math.PI, 1) + '°';
        }
        html.push(foldRow('score', '评分详情', scoreDetail));
        // 树详情
        if (tr) {
            var cs = tr.commitNode;
            var treeDetail = cs
                ? '提交 ' + cs.opName + ' ' + tr.commitFrame + '/' + cs.segmentFrames + '帧<br>' : '';
            treeDetail += '叶 ' + tr.leaves.length +
                ' | 展开' + tr.stats.expands +
                ' 提交' + tr.stats.commits +
                ' 重建' + tr.stats.rebuilds + ' 回退' + (tr.stats.retreats || 0) +
                (tr.stats.retreatReroutes ? ' 改道' + tr.stats.retreatReroutes : '') +
                ' 对齐败' + tr.stats.alignFails + '<br>' +
                '生长 ' + fmt(tr.stats.growMs, 1) + 'ms' +
                (tr.stats.growSkips ? '（跳' + tr.stats.growSkips + '帧）' : '') +
                (tr.stats.nodeCountFixes ? ' 计数修复' + tr.stats.nodeCountFixes : '') +
                '<br>生长停 ' + growStallText(tr.stats.growStalls) +
                '<br>Rust评分 ' + (tr.stats.rustScoredBatches || 0) +
                ' 回退' + (tr.stats.rustScoredFallbacks || 0) +
                ' | JS确认 ' + (tr.stats.jsConfirmCount || 0) +
                ' 提前' + (tr.stats.jsConfirmEarlier || 0) +
                ' 延后' + (tr.stats.jsConfirmLater || 0) +
                ' 清除' + (tr.stats.jsConfirmCleared || 0) +
                (tr.stats.deepSelects ? ' | 深层改选' + tr.stats.deepSelects : '') +
                (tr.stats.pruneCompensations ? ' | 剪枝补偿' + tr.stats.pruneCompensations + '次' : '');
            if (tr.diag) {
                var lastDesync = tr.diag.bulletDesyncs.length
                    ? tr.diag.bulletDesyncs[tr.diag.bulletDesyncs.length - 1] : null;
                var lastMissing = tr.diag.missingBullets.length
                    ? tr.diag.missingBullets[tr.diag.missingBullets.length - 1] : null;
                var trackIds = tr.diag.bulletTracks ? Object.keys(tr.diag.bulletTracks.actual || {}) : [];
                treeDetail += '<br>诊断 弹差 ' + fmt(tr.diag.lastBulletError, 2) + 'm' +
                    ' 车差 ' + fmt(tr.diag.lastTankError, 2) + 'm' +
                    (lastDesync ? ' 最近弹差 ' + fmt(lastDesync.error, 2) + 'm@' + lastDesync.id : '') +
                    (lastMissing ? ' 缺弹 ' + lastMissing.ids.length + '颗' : '') +
                    ' 轨迹已录 ' + trackIds.length + '弹';
            }
            // 事件流（v3：坍缩/重建/对齐败，最近 3 条倒序）
            if (tr.events && tr.events.length) {
                var evs = tr.events.slice(-3).reverse();
                var evHtml = [];
                for (var ei = 0; ei < evs.length; ei++) {
                    var ev = evs[ei];
                    var em2 = treeEventMeta(ev.type);
                    evHtml.push('<span style="color:' + em2.c + '">' + em2.n + ' ' + ev.info + '</span>');
                }
                treeDetail += '<br>' + evHtml.join(' | ');
            }
            if (seg) {
                treeDetail += '<br>t_div=' + (seg.tDivFound ? seg.tDiv : '无') +
                    ' spread峰 ' + fmt(seg.spreadPeak, 1) +
                    ' ε=' + fmt(seg.epsilon, 1) + ' T∈[' + seg.tMin + ',' + seg.tMax + ']';
            }
            html.push(foldRow('tree', '树详情', treeDetail));
        }
        // 沙箱 9 操作
        var sbLabel = '沙箱·9操作（' + frames + '帧' + (paused ? ' 可交互' : ' 只读') + '）';
        var sbBody = paused ? renderSandboxSection() : renderOpsTable(results, bestIdx, frames, false);
        html.push(foldRow('sandbox', sbLabel, sbBody));
        // 威胁表
        var ths = src.threats.slice().sort(function(a, b) {
            var aIn = a.tIn !== null && a.tIn !== undefined, bIn = b.tIn !== null && b.tIn !== undefined;
            if (aIn !== bIn) return aIn ? -1 : 1;
            return (a.tIn || 0) - (b.tIn || 0);
        });
        var thBody = '';
        for (var i = 0; i < ths.length && i < 6; i++) {
            var th = ths[i];
            var willIn = th.tIn !== null && th.tIn !== undefined;
            var tCol = !willIn ? '#6c7086'
                : (th.tIn <= 0.5 ? '#f38ba8' : (th.tIn <= 1.5 ? '#fab387' : '#a6adc8'));
            var mark = !willIn ? '○' : (th.id === bt.baseBulletId ? '★' : '　');
            var idx = src.threats.indexOf(th);
            var open = state.expandedThreat === idx;
            thBody += '<div data-act="threat" data-idx="' + idx + '" style="cursor:pointer;padding:0 2px;color:' +
                tCol + (open ? ';background:#313244' : '') + '">' +
                mark + (willIn ? fmt(th.tIn) + 's' : '外') +
                ' ' + fmt(th.closestDist, 1) + 'm ' + shortId(th.id) + '</div>';
            if (open) thBody += threatDetailHtml(th, snapConstants());
        }
        if (!ths.length) thBody = '<span style="color:#6c7086">无子弹</span>';
        html.push(foldRow('threat', '威胁（' + ths.length + '）', thBody));
        // 分数曲线
        html.push(foldRow('curve', '分数曲线',
            '<canvas id="vt-spark" width="300" height="46" style="background:#181825;border:1px solid #45475a"></canvas>'));
        return html;
    }

    function snapConstants() {
        var m = findVantageManager();
        if (m && m.ai && m.ai._vantageAdapter) return m.ai._vantageAdapter.constants;
        return { TANK_FORWARD_SPEED: 8, TANK_BACK_SPEED: 6 };
    }

    /** 9 操作对比表（v7.1 双态共用：暂停态可点击进虚影沙箱，运行态只读） */
    function renderOpsTable(results, bestIdx, frames, clickable) {
        var h = [];
        h.push('<div style="padding:4px 6px;margin:2px 0 4px;background:#181825;border:1px solid #45475a;border-radius:4px">');
        if (!results || !results.length) {
            h.push('<span style="color:#6c7086">首轮 9 操作计算中…</span>');
            h.push('</div>');
            return h.join('');
        }
        h.push('★=最优' + (clickable ? '，点行进虚影' : '') + '（视界 ' + frames + ' 帧）:<br>');
        h.push('<table style="width:100%;border-collapse:collapse">');
        h.push('<tr style="color:#6c7086"><td>操作</td><td>总分</td><td>死亡</td><td>死亡帧</td></tr>');
        var sorted = results.slice().sort(function(a, b) { return b.totalScore - a.totalScore; });
        for (var i = 0; i < sorted.length; i++) {
            var r = sorted[i];
            var star = r.opIndex === bestIdx ? '★' : '';
            var dead = r.dead ? '<span style="color:#f38ba8">✓</span>' : '';
            var scoreCol = r.dead ? '#f38ba8' : '#a6e3a1';
            h.push('<tr ' + (clickable ? 'data-act="op" data-idx="' + r.opIndex + '" style="cursor:pointer;' : 'style="') +
                'border-top:1px solid #313244">' +
                '<td>' + star + r.opName + '</td>' +
                '<td style="color:' + scoreCol + '">' + fmt(r.totalScore, 1) + '</td>' +
                '<td>' + dead + '</td><td>' + (r.deathFrame >= 0 ? r.deathFrame : '-') + '</td></tr>');
        }
        h.push('</table>');
        h.push('</div>');
        return h.join('');
    }

    /** 沙箱折叠区内容（暂停态专用：9 操作对比表 / 单操作步进面板） */
    function renderSandboxSection() {
        var sb = state.sandbox;
        // 表格态：直接用双态共用组件（自带外壳 div，避免双重包裹）
        if (sb && sb.activeOp === null) {
            return renderOpsTable(sb.results, sb.bestIdx, sb.frames, true);
        }
        var h = [];
        h.push('<div style="padding:4px 6px;margin:2px 0 4px;background:#181825;border:1px solid #45475a;border-radius:4px">');
        if (!sb) {
            h.push('<span style="color:#f38ba8">尚未计算</span>');
            if (state.errNine) {
                h.push('<br><span style="color:#f38ba8">原因: ' + state.errNine + '</span>');
            } else {
                h.push('<br><span style="color:#6c7086">（重新暂停即自动跑）</span>');
            }
        } else {
            var r2 = sb.results[sb.activeOp];
            var k = sb.frameIdx;
            var cap = sbMaxIdx();
            var frameScoreStr = '起始态（父末态，不计分）';
            var cum = 0;
            if (k > 0) {
                var pfs = r2.perFrameScores;
                frameScoreStr = fmt(pfs[Math.min(k, pfs.length) - 1]);
                for (var j = 0; j < Math.min(k, pfs.length); j++) cum += pfs[j];
            }
            h.push('<b style="color:#94e2d5">虚影沙箱 · 操作「' + r2.opName + '」</b><br>');
            h.push('沙箱帧 <b>' + k + '</b> / ' + cap +
                (r2.dead ? ' <span style="color:#f38ba8">(死亡帧 ' + r2.deathFrame + ')</span>' : '') + '<br>');
            h.push('本帧分(含车道压): <b>' + frameScoreStr + '</b> | 累计分: <b>' + fmt(cum, 1) + '</b>' +
                ' | 总分: ' + fmt(r2.totalScore, 1) + '<br>');
            // 鼠标步进按钮（沙箱全鼠标操作，键位 →/←/Home/Esc 等效）
            h.push('<div style="display:flex;gap:4px;margin:4px 0">');
            h.push('<button data-act="sb-home" style="cursor:pointer;background:#45475a;color:#cdd6f4;border:1px solid #6c7086;border-radius:4px;padding:2px 8px;font:inherit">⏮ 起点</button>');
            h.push('<button data-act="sb-back" style="cursor:pointer;background:#45475a;color:#cdd6f4;border:1px solid #6c7086;border-radius:4px;padding:2px 8px;font:inherit">◀ −1</button>');
            h.push('<button data-act="sb-step" style="cursor:pointer;background:#45475a;color:#cdd6f4;border:1px solid #6c7086;border-radius:4px;padding:2px 8px;font:inherit">▶ +1</button>');
            h.push('<button data-act="sb-step10" style="cursor:pointer;background:#45475a;color:#cdd6f4;border:1px solid #6c7086;border-radius:4px;padding:2px 8px;font:inherit">▶▶ +10</button>');
            h.push('<button data-act="sb-exit" style="cursor:pointer;background:#45475a;color:#cdd6f4;border:1px solid #6c7086;border-radius:4px;padding:2px 8px;font:inherit">⏏ 退出</button>');
            h.push('</div>');
            h.push('<span style="color:#89b4fa;font-size:10px">键位等效：→ 单帧 ⇧→ ×10 ← 回退 Home 起点 Esc 退出</span><br>');
        }
        h.push('</div>');
        return h.join('');
    }

    // ---------------- 快照导出 ----------------

    function exportTreeDiagnostics() {
        if (typeof VantageTree === 'undefined' || !VantageTree.dumpDiagnostics) return;
        var diag = VantageTree.dumpDiagnostics();
        if (!diag) return;
        var data = JSON.stringify(diag, null, 2);
        var blob = new Blob([data], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'vantage_tree_diag_' + Date.now() + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function() { URL.revokeObjectURL(a.href); }, 1000);
    }

    function exportSnapshots() {
        var data = JSON.stringify({
            exportedAt: new Date().toISOString(),
            frameCount: state.frameCount,
            perf: { last: state.perf.last, avg: state.perf.avg, max: state.perf.max, n: state.perf.n },
            liveBest: state.live && state.live.bestIdx >= 0 ? state.live.results[state.live.bestIdx].opName : null,
            snapshots: state.snapshots,
            sandbox: state.sandbox ? state.sandbox.results.map(function(r) {
                return {
                    opName: r.opName,
                    totalScore: r.totalScore,
                    dead: r.dead,
                    deathFrame: r.deathFrame,
                    perFrameScores: r.perFrameScores
                };
            }) : null
        }, null, 1);
        var blob = new Blob([data], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'vantage_bench_' + Date.now() + '.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(function() {
            URL.revokeObjectURL(a.href);
            a.remove();
        }, 500);
        console.log('[Testbench] 已导出 ' + state.snapshots.length + ' 个快照');
    }

    // ---------------- 键位 ----------------

    function onKeyDown(e) {
        var tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if (!inGameState()) return;
        var sb = state.sandbox;
        // 沙箱步进键（单操作沙箱激活时）
        if (sb && sb.activeOp !== null) {
            if (e.key === 'ArrowRight') { e.preventDefault(); sbStep(e.shiftKey ? 10 : 1); return; }
            if (e.key === 'ArrowLeft') { e.preventDefault(); sbStep(e.shiftKey ? -10 : -1); return; }
            if (e.key === 'Home') { e.preventDefault(); sbStep(-sb.frameIdx); return; }
            if (e.key === 'Escape') { e.preventDefault(); sbExit(); return; }
        }
        var k = e.key;
        if (k === 'p' || k === 'P') { e.preventDefault(); togglePause(); return; }
        // v3：V/T/E 任意时刻可用（T 运行中开面板 = 性能测试模式；Y 树图）
        if (k === 't' || k === 'T') {
            e.preventDefault();
            state.panelOn = !state.panelOn;
            if (state.panelOn) { _perfDead = false; state.errRun = null; }   // 重开面板重试
            try { updatePanel(); } catch (eB) { console.error('[Testbench] 面板刷新异常:', eB); }
            if (_tv && state.treeViewOn && !_tv.userMoved) placeTreeView();
            return;
        }
        if (k === 'v' || k === 'V') { e.preventDefault(); state.vizOn = !state.vizOn; renderViz(); syncButtonLabels(); return; }
        if (k === 'y' || k === 'Y') { e.preventDefault(); toggleTreeView(); return; }   // v93：树图改 Y 键
        if (k === 'e' || k === 'E') { e.preventDefault(); exportSnapshots(); return; }
        if (!state.paused) return;
        if (k === 'n' || k === 'N') { e.preventDefault(); requestStep(e.shiftKey ? 10 : 1); return; }
    }

    global.addEventListener('keydown', onKeyDown);

    // ---------------- 补丁挂载 ----------------

    var _patchTries = 0;
    function tryPatch() {
        _patchTries++;
        var ok = patchGameController() && patchUIGameState();
        if (ok) {
            console.log('[Testbench] 时间钩已挂上: GameController + UIGameState (Classy __methods)');
        } else if (_patchTries <= 600) {
            setTimeout(tryPatch, 100);
            if (_patchTries === 600) {
                console.warn('[Testbench] 时间钩挂载失败（600 次重试）：' +
                    'GameController=' + (typeof GameController !== 'undefined') +
                    ' UIGameState=' + (typeof Game !== 'undefined' && !!Game.UIGameState));
            }
        }
    }
    setTimeout(tryPatch, 200);

    // ---------------- 对外接口 ----------------

    global.VantageTestbench = {
        VERSION: TB_VERSION,
        togglePause: togglePause,
        step: requestStep,
        captureSnapshot: captureSnapshot,
        runNineOps: runNineOps,
        enterSandboxOp: enterSandboxOp,
        toggleTreeView: toggleTreeView,
        renderTreeViz: renderTreeViz,
        exportSnapshots: exportSnapshots,
        exportTreeDiagnostics: exportTreeDiagnostics,
        getState: function() { return state; },
        /**
         * v6 AI 操控：取当前应执行的操作（供 ai_vantage 每帧调用）
         * @returns {Object|null} {inputs:{forward,back,left,right}, opName} 或 null（静止）
         */
        getControlOperation: function() {
            var c = state.aiControl;
            if (!c.enabled) return null;
            if (c.tree) {
                // 树模式：inputs 由 ai_vantage 侧 tick 后经 getDesiredOperation 提供
                return { mode: 'tree', inputs: null, opName: '树' };
            }
            if (c.auto) {
                var src = state.paused ? state.sandbox : state.live;
                if (src && src.bestIdx >= 0 && src.results && src.results[src.bestIdx]) {
                    var r = src.results[src.bestIdx];
                    return { inputs: VantageSandbox.OPERATIONS[r.opIndex].inputs, opName: r.opName };
                }
                return null;   // 暂无计算结果 → 静止
            }
            var ops = VantageSandbox.OPERATIONS;
            var i = Math.max(0, Math.min(ops.length - 1, c.opIndex));
            return { inputs: ops[i].inputs, opName: ops[i].name };
        },
        help: function() {
            console.log([
                'P 暂停/恢复 | N 递进一帧 | Shift+N ×10 | V 标注 | T 面板 | Y 树图 | E 导出',
                'B 运行中开面板 = 每帧自动计算的性能测试模式（关面板即零开销）',
                '沙箱内: → 单帧 | Shift+→ ×10 | ← 回退 | Home 起点 | Esc 退出',
                '暂停后 9 操作自动算；面板按钮可全鼠标操作；标题栏可拖动',
                '红/橙/灰虚线=子弹折线 暗灰=已过子弹 黄圈=基准 十字=折线最近点',
                '红扇=遮蔽角 绿扇=剩余角(精确矩形遮蔽) 蓝线=坦克朝向',
                '沙箱: 青框=坦克虚影 白圆=子弹虚影 淡青线=尾迹 红✕=死亡点'
            ].join('\n'));
        }
    };

    // v41/v49/v60：模块加载时同步一次树内车道/弹簧绳/无弹生长开关，保证 UI 与树初始一致。
    if (typeof VantageTree !== 'undefined') {
        try { VantageTree.setLaneEnabled(state.exp.lane); } catch (eLaneInit) {}
        try { VantageTree.setSpringRopeEnabled(state.exp.springRope); } catch (eSpringInit) {}
        try { VantageTree.setRustMinimalEnabled(state.exp.rustMinimal); } catch (eRustMinInit) {}
        try { VantageTree.setGrowWithoutThreatsEnabled(state.exp.growWithoutThreats); } catch (eGrowInit) {}
        try { VantageTree.setGrowLayersPerTick(state.exp.growLayers); } catch (eLayersInit) {}
        try { VantageTree.setMaxNodes(state.exp.maxNodes); } catch (eMaxNodesInit) {}
        try { VantageTree.setNodeCapEnabled(state.exp.nodeCap); } catch (eNodeCapInit) {}
        try { VantageTree.setHorizonCapEnabled(state.exp.horizonCap); } catch (eHorizonCapInit) {}
        try { VantageTree.setHorizonSec(state.exp.horizonSec); } catch (eHorizonSecInit) {}
        try { VantageTree.setRefineBeyondLimits(state.exp.refineBeyond); } catch (eRefineInit) {}
        try { VantageTree.setContinuousRefine(state.exp.continuousRefine); } catch (eContRefineInit) {}
        try { VantageTree.setPruneCompensateLayers(state.exp.pruneCompensateLayers); } catch (ePruneLayersInit) {}
        try { VantageTree.setPruneCompensateFrames(state.exp.pruneCompensateFrames); } catch (ePruneFramesInit) {}
        try { VantageTree.setWarmupMaxNodes(state.exp.warmupMaxNodes); } catch (eWarmupInit) {}
        try { VantageTree.setRetreatNodes(state.exp.retreatNodes); } catch (eRetreatNodesInit) {}
        try { VantageTree.setRetreatFrames(state.exp.retreatFrames); } catch (eRetreatFramesInit) {}
        try { VantageTree.setDeepSelectEnabled(state.exp.deepSelect); } catch (eDeepInit) {}
    }
    // v54：Rust 物理预测初始值同步；任意 Rust 实验开关打开时初始化桥。
    if (typeof VantageSandbox !== 'undefined') {
        try { VantageSandbox.setRustPhysicsEnabled(state.exp.rustPhysics); } catch (eRustPhysInit) {}
    }
    if ((state.exp.rustMinimal || state.exp.rustPhysics) && typeof VantageRustBridge !== 'undefined') {
        VantageRustBridge.init().catch(function(e) {
            console.warn('[Testbench] VantageRustBridge init failed:', e);
        });
    }

    // v90：窗口尺寸变化时，未手动移动过树图就重新贴到面板左侧/屏幕右侧；
    // 手动移动过则只保证标题栏还在视口内。
    window.addEventListener('resize', function() {
        if (!_tv || _tv.userMoved) return;
        placeTreeView();
    });

    console.log('[Testbench] Vantage 调试工作台 ' + TB_VERSION +
        ' 已加载：T 开面板（运行中=性能测试）P 暂停后自动 9 操作');

})(typeof window !== 'undefined' ? window : this);
