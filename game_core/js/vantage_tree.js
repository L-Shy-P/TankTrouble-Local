/**
 * Vantage Tree · 阶段③ 树结构（段制，docs/Vantage躲弹实现/03-树结构.md 第二版）
 *
 * 2026-09-07 v100（杀戮场地形引导）：
 *   ① 静态地形杀戮场：死路/出口少/边界格子分低，开阔格分高；
 *   ② 没有用户目标且有子弹时，目标分用杀戮场安全分；
 *   ③ 用户点击或 / 寻路时，目标分优先，杀戮场不抢方向；
 *   ④ 无弹无目标时仍优先静止，不受杀戮场影响。
 * 2026-09-07 v98（点击后全树刷新重选 + 仅操作时长评分）：
 *   ① 点击目标变化后标记 dirty，tick 里 reroute 全树、逐层重选并提前结束当前段；
 *   ② scoreOnlyPlanned 开关：选路时只累计操作时长内帧分，不再固定看 75 帧。
 * 2026-09-07 v97（无弹无目标时优先静止）：
 *   安全分完全相同时，如果真实世界没有子弹且没有点击目标，优先选静止操作；
 *   避免无弹期反复选前进/转向、在墙角空转和触发反复提交。
 * 2026-09-07 v96（预热上限改为看真实子弹数）：
 *   warmupCapReached 不再只看 tree.threats；tick 每帧记录真实 projectile 数，
 *   避免树 threats 暂时为空时把“有子弹”误判成“无子弹预热”，
 *   导致树卡在 10 节点、反复 reuse 不生长。
 * 2026-09-07 v95（混合选路 + 新弹改道提前结束 + 混合安全底线）：
 *   ① 混合选路开关与目标分系数：目标分按系数缩放后直接进安全总分；
 *   ② 混合模式下只要还有非 dead 候选，就不为了目标去选 soft-dead 候选；
 *   ③ 新弹导致树的 next 改道时，提前结束当前执行段，避免沿旧分支跑完。
 * 2026-09-07 v93（无弹点击走真实寻路 + 树目标平局裁决）：
 *   无子弹时点击目标由 AI 走迷宫最短路（会绕墙）；有子弹时忽略直接寻路，
 *   只让树在安全分平局时使用末端姿态目标分。
 * 2026-09-07 v92（点击目标只做平局裁决 + 跨局缓存清理）：
 *   ① 点击地面不再直接接管 AI 驾驶；目标只作为安全分完全相同时的
 *      末端姿态平局裁决（位置越近、朝向越准分越高）；
 *   ② VantageTree.reset() 清空点击目标，并调用 VantageSandbox.clearCaches()
 *      清掉融合/克隆世界缓存，防止跨局旧缓存拖弱 AI。
 * 2026-09-07 v91（预测时长滑块 + 剪枝补偿）：
 *   ① horizonSec 可在 1~15 秒调；② 新弹剪枝后可临时增加每帧生长层数，
 *   由 pruneCompensateLayers（0~9）与 pruneCompensateFrames（1~60）控制。
 * 2026-09-07 v90（回退帧上限 600 + 面板交互整理）：
 *   回退帧范围从 10~200 扩到 10~600，默认仍为 200。
 * 2026-09-07 v89（无弹预热上限 + 回退量双单位）：
 *   ① 新增 warmupMaxNodes（默认 500）：无子弹预热阶段独立节点上限，
 *      即使关闭“节点限”或开启“超限细化”也不能无限预热；有子弹后解除；
 *   ② 真死回退量拆成两个单位：retreatNodes（1~32，默认 3）与
 *      retreatFrames（10~600，默认 200）；每向上爬一层同时累计段长，
 *      先碰到哪个上限就从哪里开始找替代路线；
 *   ③ 旧 setRetreatDepth/retreatDepth 保留为 retreatNodes 的兼容别名。
 *
 * 2026-09-07 v88（持续细化独立开关 + 回退深度可调）：
 *   ① TREE_DEFAULTS.continuousRefine=false；开启后不依赖“无普通叶”触发，
 *      每 tick 在正常生长之外追加一次“拆长操作→展开前缀”，可与节点限/
 *      视界限/超限细化分别组合；
 *   ② 同一长叶只拆一次（_refineSplit 标记），避免反复在同一操作中间
 *      重复插入前缀；真死叶不再参与细化；
 *   ③ TREE_DEFAULTS.retreatDepth=3，setRetreatDepth(1~8) 控制真死回退
 *      向上搜索的起始层数，testbench 新增“回退层”滑块。
 *
 * 2026-09-07 v78（vt_score_paths 九操作 Rust 评分接入 rolloutNine）：
 *   rolloutNine 优先走 adapter.simulateTankBatchScored（Rust 融合模拟 + f64
 *   遮蔽角评分，lane=0/弹簧绳关闭才启用）；任何失败或不支持静默回退
 *   VantageScoring.scorePaths。Rust 死亡帧仍只作 rust-candidate。
 * 2026-09-07 v77（增量死亡验证只看新子弹 + JS 权威确认 + 无弹生长开关）：
 *   ① tryRustRescoreLayer/Batch 对 stale 完全由新增子弹引起的节点传
 *      previousDeathFrame；Rust 死亡验证只跑 isNew 新弹，旧弹死亡帧
 *      沿用上一轮结论；JS 侧合并旧死亡帧与 Rust 新候选死亡帧取更早者。
 *   ② Rust 死亡帧只作为候选（deathAuthority='rust-candidate'）；最终
 *      被选中执行/当前 commitNode 的死亡结论在写入执行状态前由 JS
 *      融合世界确认（只确认执行路线，不全树复核）。
 *   ③ TREE_DEFAULTS.growWithoutThreats=false；setGrowWithoutThreatsEnabled
 *      开启后 growStep 在无 threats 时继续生长（默认关闭，保持 v57 行为）。
 * 2026-09-07 v87（超强配置诊断）：
 *   新增 stats.refineSplits，记录超限细化发生次数。
 * 2026-09-07 v86（节点上限开关真正穿透所有加节点路径）：
 *   修复 attachResults/expandLeaf/startExpandSlice/commit 仍硬用 maxNodes
 *   导致“关了节点限也只能长到 420~500”的问题；
 *   现在统一由 canAddTreeNodes 判断，关限或超限细化时真正允许超出 maxNodes。
 * 2026-09-07 v85（节点/视界上限开关 + 超限细化）：
 *   ① TREE_DEFAULTS.nodeCapEnabled/horizonCapEnabled 默认开启，
 *      可分别关闭节点上限与时间视界限制；
 *   ② TREE_DEFAULTS.refineBeyondLimits 默认关闭，开启后
 *      即使视界/节点上限触发也会把长操作叶拆成
 *      更短的同操作前缀叶，并从中间帧继续展开 9 候选。
 * 2026-09-07 v84（节点上限可调 + 到视界后继续长兄弟叶）：
 *   ① TREE_DEFAULTS.maxNodes 默认 500，新增 setMaxNodes(100~3000)
 *      与 testbench “节点上限”滑块；
 *   ② 路径到达视界不再直接停止生长，改为
 *      全局 fallback 继续生长尚未到视界的兄弟叶；
 *   ③ 新增 growStalls 统计，面板可看 maxnodes/no-leaf/skip 原因。
 * 2026-09-07 v83（软死叶子可继续生长）：
 *   ① 修复 status=dead 但 fd>=2 被当成不可生长的结构性问题；
 *   ② 软死叶子从安全执行末帧继续展开 9 候选；
 *   ③ 只有 1 帧真死才禁止生长；金线与 leaves 同步允许软死叶。
 * 2026-09-07 v82（真死回退真正改道）：
 *   ① applyRetreatAfterExpand 把 retreat target 写回祖先 next；
 *   ② 当前执行节点的下一层全真死时同 tick
 *      强制提前结束当前段重新选路；
 *   ③ 新增 retreatReroutes 统计与 retreat-reroute 结构事件。
 * 2026-09-07 v81（深层选路实验开关）：
 *   ① TREE_DEFAULTS.deepSelectEnabled=false；开启后 next/commit
 *      优先按 subtreeBest（含后代路线）选择根层孩子；
 *   ② 路线平均分在开关开启时改用 segmentFrames 作分母；
 *   ③ commit-deep-select 事件与 deepSelects 统计可观测。
 * 2026-09-07 v80（软死执行时长≤死亡帧一半 + 每帧多层生长实验）：
 *   ① TREE_DEFAULTS.deathDurationRatio=0.5；safeFramesForDeath 对 fd>=2
 *      限制实际执行帧数 ≤ floor(fd×ratio)，AI 更频繁换路；
 *   ② TREE_DEFAULTS.growLayersPerTick=1；setGrowLayersPerTick 与
 *      testbench 层/帧滑块（1~6）可一次生长多层完整 9 候选。
 * 2026-09-07 v79（修复执行段死亡边界 + 权威标记漏洞 + 重摆后失效）：
 *   ① 统一 safeFramesForDeath 口径，修掉 invalidateStaleNodes 差一帧执行到死；
 *   ② 当前执行节点即时死亡扫描优先走 JS 融合权威，并写全死亡帧/结束时间；
 *   ③ applyLayerResults 识别 rustPhysics，不再把 Rust 物理候选误标 fused；
 *   ④ 全树更新后立即确认当前 commitNode；
 *   ⑤ 刚性重摆后清空子树 freshSig/scoreCache，旧死亡结论不再保鲜；
 *   ⑥ 最终路线确认提前到 recordCommitInfo/reserve 拓扑变更之前。
 * 2026-09-07 v78（rolloutNine 接入 vt_score_paths Rust 评分）：
 *   ① rolloutNine 优先走 adapter.simulateTankBatchScored（Rust 融合模拟 +
 *      f64 遮蔽角评分）；lane>0/弹簧绳/异常一律静默回退 JS scorePaths。
 * 2026-09-07 v77（增量死亡验证只看新子弹 + JS 执行路线死亡确认 + 无弹生长）：
 *   ① 新增 previousDeathFrame，Rust 增量死亡验证只跑 isNew 新弹；
 *   ② Rust 死亡帧只作候选；最终执行路线由 JS 融合世界确认；
 *   ③ 新增 growWithoutThreats 实验开关，默认关闭。
 * 2026-09-07 v76（修复批处理节点计数负数 + Rust 粗筛跨帧跳跃）：
 *   ① detachChild 幂等：摘除子树时断开内部 parent 链；invalidateDescendants
 *      对已摘除残留只清理不二次扣数；applyLayerResults 写回前校验节点仍
 *      挂在当前父层；批量写回后按真实拓扑 recountActiveNodes，杜绝
 *      nodeCount 被扣成负数、绕过 maxNodes 上限的问题。
 *   ② Rust danger/affected 粗筛增加 COARSE_BLOCK_FRAMES=16 的时空块跳跃：
 *      坦克块盒直接使用存储样本（天然包含前进+旋转），威胁块盒覆盖 track
 *      的取整边界；块盒距离大于安全半径时整块跳过，否则逐帧精确回退。
 *      路径弹与 lane 开启时保持原精确逐帧路径，确保无损。
 * 2026-09-05 v75（Rust 帧级增量评分 ABI v4）：
 *   tryRustRescoreLayer/Batch 在 onlyPending 且节点已有 perFrameScores 时
 *   传 previousScores 给 adapter.rescoreTankSamples(nodes,threats,cfg,pending)，
 *   Rust 只重算新弹能影响的帧；未受影响帧复制上一轮 perFrameScores。
 *   节点新增 n.perFrameScores 并在 buildCandidate/applyRolloutScore 中保存。
 * 2026-09-05 v74（回退 v73 异步分片；保持 v72 同步批量语义）：
 *   v73 的“先执行旧节点再后台更新”会浪费根层未来树叉，
 *   主人判定方向错误，已整体回退。
 * 2026-09-05 v72（v68 多层 Rust 重评分合并为一次 WASM 调用）：
 *   tryRustRescoreBatch 收集所有受影响父层节点后按 512 分块，
 *   一次/少数几次调用 rescoreTankSamples；失败回退逐层刷新。
 * 2026-09-05 v71（新弹全树重路由增加无损时空粗过滤）：
 *   只对“新弹轨迹 × 节点完整 rollout 包围盒”重叠的节点重评分；
 *   4m 余量覆盖死亡/遮蔽(3.06m)/车道(3.5m)全部影响半径，
 *   未重叠节点直接刷新签名，跳过 Rust/JS 重算。
 * 2026-09-05 v70（Rust vt_rescore_nodes 增量层刷新）：
 *   refreshFusedLayer 先尝试 adapter.rescoreTankSamples（仅 Rust 物理开关
 *   开启、非弹簧绳、且 stale 节点已有有效 rolloutSamples 时）；成功则
 *   用存储样本重评分，不再重跑坦克物理；失败/不可用回退原 scorePaths。
 *
 * 2026-08-23 v52（75帧全累积总分选路 + next 重定向 + 新弹全局 reroute）：
 *   ① 最新一层选路改按节点自身 75 帧全累积总分（rolloutTotal）自然比较，
 *      不再用“本段平均分”；软死仍自然参与，死亡帧停算。
 *   ② refreshCandidateScores 刷新当前比较层后重算 commitNode.next；
 *      invalidateStaleNodes 剪枝后修复受影响父节点 next。
 *   ③ 新弹 emergency 触发 rerouteTreeForCurrentThreats：全树既有 rollout
 *      按新威胁重评分，并逐层重算所有 next，再一次性回传 subtreeBest。
 *   ④ 删除 pickBestWithThreatBias 人工“静止/旋转死则强制前后”兜底，
 *      新鲜根层与新根层回退均使用自然 75 帧总分比较。
 * 2026-08-23 v53（弹簧绳开关接树）：
 *   TREE_DEFAULTS 增加 springRopeEnabled:true；treeScoringCfg 透传四个
 *   弹簧绳参数；新增 VantageTree.setSpringRopeEnabled 写入模块变量与
 *   当前树 cfg，testbench 面板开关可实时切换。
 * 2026-08-23 v54（树层惰性金线刷新）：
 *   新弹/弹消失不再触发全树 reroute；改为沿 commitPath 找到第一个 stale
 *   层，用 scoreRolloutCached 增量刷新，节奏 pathDepth<=5 刷1层+延伸1层、
 *   >5 刷3层不延伸。refreshCandidateScores/commit fallback 均先 ensureLayerFresh。
 *   全量 rerouteTreeForCurrentThreats 保留但已从 tick 调用中退役。
 * 2026-08-23 v55（弹消失移除 + 金线外空闲更新 + verifyFreshness）：
 *   ① 子弹提前消失会从 tree.threats/_pendingThreats 中移除对应 threat，
 *      与新增弹同等处理，不 freshRoot；
 *   ② 主线刷完后每 tick 最多更新 1 层金线外 stale 层；
 *   ③ 新增只读 verifyFreshness()；pickRetreatLeaf/bestRouteLeafInSubtree
 *      比较前先 ensureLayerFresh。
 * 2026-08-23 v56（深度>5 主线 fresh 后恢复延伸）：
 *   修复深树主线全部 fresh 后仍不 growStep 的问题；growStep 条件改为
 *   pathDepth<=5 || !mainlineHasStale || lazyReachedGrowableLeaf。
 * 2026-08-23 v57（弹簧绳默认关 + 无子弹不预测）：
 *   弹簧绳修复后暂默认关闭；growStep 在无威胁时不延伸不切片，
 *   首次提交仍可建立根层 9 候选并选静止。
 * 2026-09-05 v69（Rust 最小决策实验开关）：
 *   TREE_DEFAULTS.rustMinimalEnabled=false；setRustMinimalEnabled 可切换；
 *   attachResults 在开关开启且 WASM 就绪时用 VantageRustBridge.minimalDecide
 *   选 next；失败自动回退 JS 选路。
 * 2026-08-23 v68（语义回退到 v52 强基线 + 保留融合死亡权威）：
 *   ① 撤销 v54 以后的惰性金线/金线外更新/复杂回退改动，恢复正常 growStep；
 *   ② 新弹恢复全树 reroute，但逐层用 scorePaths 融合世界重算；
 *   ③ 真死回退恢复 v48/v52 只读搜索，不在 DFS 中刷新结构；
 *   ④ 保留时间轴单位修复、融合死亡权威、无弹不预测、死亡诊断快照。
 * 2026-08-23 v67（死亡快照增加 projectileSightLog 滚动历史）：
 *   记录最近 120 tick 每帧真实 getProjectiles 集合与树威胁集合，
 *   判定普通子弹“从未出现”还是“出现过又被移除”。
 * 2026-08-23 v66（死亡快照增加 killInfo 击杀事件）：
 *   noteDeath(kill) 由 ai_vantage 在 TANK_KILLED 时调用，记录凶器
 *   projectileId/type，用于确定“看不见的子弹”是哪个弹种。
 * 2026-08-23 v65（死亡快照增加 lastProjectileSight）：
 *   记录每次 tick 通过 adapter.getProjectiles 真实看到的弹 id 集合与签名，
 *   用于判定 AI 是在哪一环看不见致命子弹。
 * 2026-08-23 v64（死亡快照增加 staleAtDeath/windowSig/threatIds）：
 *   getLastResetSnapshot 直接显示死亡瞬间 commitNode 是否被判定 stale、
 *   窗口签名与树威胁签名，用于判定“漏刷新”还是“融合世界漏判”。
 * 2026-08-23 v63（死亡瞬间预测快照 getLastResetSnapshot）：
 *   AI 死亡导致 VantageTree.reset() 前，保存当前 commitNode 的
 *   fullDeathFrame/status/planned/segment/tEndSec 与事件尾，
 *   供控制台定位“绿节点但实际死亡”。
 * 2026-08-23 v62（新弹即时融合扫描只查当前执行节点）：
 *   invalidateStaleNodes 粗筛命中后，只有 commitNode 立即跑融合死亡扫描；
 *   其余候选标 stale，沿金线在选路前融合重算，性能不再随候选数爆炸。
 * 2026-08-23 v61（精确死亡判定全面改用融合世界；静态checkDeath仅最后回退）：
 *   ① ensureLayerFresh 对 stale 候选一次调用 scorePaths（融合传感器+CCD）
 *      重模拟，不再用 scoreRolloutCached 的静态 checkDeath 覆盖死亡结论。
 *   ② invalidateStaleNodes.scanNodeDeath 改为单操作融合批量模拟，
 *      只把静态路径留作 fused 不可用时的保命回退。
 * 2026-08-23 v60（融合死亡权威不被静态重算覆盖）：
 *   ① scorePaths 产物标 deathAuthority='fused'；单路径回退标 'check'。
 *   ② 刚出生且威胁签名未变的 fused 节点，scoreCache 为 null 也视为 fresh，
 *      不再用 scoreRolloutCached 的静态 checkDeath 覆盖传感器/CCD 死亡结论。
 *   ③ 一旦因威胁变化重算，deathAuthority 改为 'computed'。
 * 2026-08-23 v59（回退语义修正：只回退当前路线层 + 金线在祖先层重选）：
 *   ① ensureLayerFresh 只有刷新当前路线层才判定真死回退；金线外更新不标紫。
 *   ② evaluateTrueDeadLayer 把回退目标写回祖先 next（retreat-reroute），
 *      真死节点自身 next 置 null。
 *   ③ 修复整层真死后父层仍带旧 next、金线继续走进死层的问题。
 * 2026-08-23 v58（时间轴单位统一 + 刷新后真死回退 + 死亡审计）：
 *   ① threatCoarseBox 增加 rootAbsT 参数，与 nodeCoarseBox 同为绝对时间；
 *   ② ensureLayerFresh 刷新后调用 evaluateTrueDeadLayer 重新判定整层真死；
 *   ③ 新增 death-update-audit / tree.diag.deathAudit；prune detail 用旧段长。
 * 2026-08-23 v51（最终软死/真死执行语义 + 3层范围回退 + 平均分选路）：
 *   ① plannedFrames 永不变；fullDeathFrame=-1/1/>=2 决定实际执行帧数；
 *      分数只累加实际执行帧，死亡帧不加分，平均分分母用 plannedFrames。
 *   ② 选路只跳过 invalid/exhausted；soft dead 照常参与；
 *      pickBestByRouteAvg 不偏向 alive，只跳过有非真死候选时的 1 帧真死。
 *   ③ 真死回退统一 pickRetreatLeaf：从死节点向根走 3 条边搜索可选叶子，
 *      不足 3 层到根；允许 soft dead 叶子。
 * 2026-08-23 v50（死亡候选执行时长缩短 / 1帧死 next 不提交）：
 *   ① applyRolloutScore/rebaseNodeFromReal 在候选段内死亡时缩短
 *      segmentFrames、更新 simState/tEndSec，并把旧后代 invalid 移除；
 *      plannedFrames 不变，平均分仍按计划帧数计算。
 *   ② 正常提交不再盲从 fullDeathFrame===1 的 prev.next；有其他候选
 *      可苟时走 commit-global-route 全局路线平均分回退。
 *   ③ 结构事件新增 death-shorten。
 * 2026-08-23 v49（正常沿当前路线延伸 + 平均每帧得分选路）：
 *   ① 节点新增 plannedFrames / next；buildCandidate 写 plannedFrames=探段结果。
 *   ② attachResults 在最新 9 个叶子里按“本段平均分”选 next；
 *      commitPathOf 根层第一跳仍优先 commitNode，之后只沿 next 走。
 *   ③ 正常提交直接采用 prev.next；next 无效才在其余孩子子树里
 *      DFS 找路线平均分最高的可生长叶子；pickGrowLeaf 回退同样按路线平均分。
 *   ④ recordCommitInfo candidates 增加 planned/avg。
 * 2026-08-23 v48（当前路线优先延伸 + 1 帧真死回退）：
 *   ① pickGrowLeaf 恢复“金线优先”：先沿 commitPath 找可生长叶子；
 *      找不到再从叶端向根回退，在路径外兄弟子树里选最优叶子；
 *      仍没有才全局 fallback。避免预算摊给大量兄弟分支后段末全退役。
 *   ② 真死判定改为“所有 active 子节点 fullDeathFrame<=1”；
 *      pickBest 在有可苟候选时跳过 fullDeathFrame===1 的立即真死候选。
 *   ③ applyRetreatAfterExpand 只对 1 帧全死节点标记 exhausted，
 *      且在 commitPath 上时记录 retreat 并清空 _expandSlice 以换兄弟。
 * 2026-08-23 v47（价值回传口径修正 + reserve/reuse + 多叶生长 + 融合死亡权威 + lane 开关接树）：
 *   ① refreshCandidateScores/rebaseNodeFromReal 不再用 totalScore 直接覆盖
 *      subtreeBest：先更新 segmentScore/baseExt/status/fullDead/fullDeathFrame，
 *      再按 subtreeBest = segmentScore + max(baseExt, max(active子节点.subtreeBest))
 *      回传父链。
 *   ② 换道时新根层未选中候选转入 reserve，不再删除 + 补位重算；旧根 8 兄弟
 *      仍按正常坍缩退役。reserve 节点满足父状态/威胁签名/墙体有效性时
 *      可 reactivate 复用。
 *   ③ pickGrowLeaf 改为从所有 active 且可生长的叶子中选最优（subtreeBest
 *      最高，并列取时间深度更浅，再按 id 升序），不再只长金线 tip。
 *   ④ 树内评分调用统一传 tree.cfg（lanePenaltyRatio 默认 0）；
 *      setLaneEnabled 可切换 0/0.5。
 *   ⑤ 配合 vantage_sandbox v24：融合世界共享子弹 + 传感器 + CCD 死亡权威；
 *      scorePaths 批量死亡结果不再回退旧 checkDeath。
 * 2026-08-16 v27（威胁锚点诊断）：
 *   ① 树每次真正换 threats 时快照每颗弹的 anchorT/path0/speed/
 *      totalLen/pointCount 到 tree.threatAnchors；
 *   ② runDiagnostics 每帧回填 path0Now/path0Drift（活引用未断时这里会
 *      看到 path0 漂移）与 anchorAge；
 *   ③ dumpDiagnostics 返回 threatAnchors。
 * 配合 vantage_sandbox v17 的 path 深拷贝：path0Drift 应恒为 0。
 * 2026-08-16 v28（Box2D 子弹轨迹接入 + 旧路径生长提速）：
 *   ① commit 真正换 threats 后调用 adapter.simulateBulletTracks，
 *      把每颗弹道型子弹的 track 挂到 threat.track；之后 growStep 的
 *      9×75 滚动评分走 Box2D 轨迹（scoring v18 threatBulletPos）。
 *   ② runDiagnostics 有 track 时优先用 track 作为预测轨迹记录。
 *   ③ 旧路径（融合关闭）生长：GROW_MIN_INTERVAL_MS 30→0、
 *      TREE_OPS_PER_TICK 2→3——短段 3 帧也能在提交前完成一层展开。
 * 2026-08-16 v30（正常坍缩 + 按弹种生命周期传参 + 500 上限）：
 *   ① 坍缩恢复原语义：段末保留选中子树、删除未来 8 兄弟。
 *      配合融合世界每 tick 同步扩一层，增长(+9/层)远快于坍缩(-8/段)，
 *      节点数总体锯齿上行，不再依赖 history/retired。
 *   ② maxNodes 500（主人定）。
 *   ③ 子弹 track 帧数不再硬编码 500：tree 先按 horizon+EVAL 算
 *      基准帧数，再调 adapter.getBulletTrackFrames(horizonFrames)，
 *      由沙箱按“当前场上各弹种的真实剩余寿命”返回 max(horizon,寿命)
 *      帧；每颗弹在自己的 lifetime 处截断。
 *   ④ recordShape 每次 commit 记 {t,nodeCount,activeDepth}，导出 JSON
 *      可核对增长斜率 > 坍缩斜率。
 * 2026-08-16 v31（新弹局部失效，不再整树清零）：
 *   ① 新弹出现只把新 threat 以 anchorOffset 追加进 tree.threats；
 *   ② invalidateStaleNodes 逐节点重扫“现有 threats 下是否更早死亡”，
 *      只剪受影响节点及其子树；只有 commitNode 本身提前死亡才根层重选；
 *   ③ 段末心跳也执行一次局部失效，处理“远弹后来逼近”的迟到影响。
 * 2026-08-16 v32（新弹即时换操作，恢复老版预判反应）：
 *   新弹无提前死亡时，refreshCandidateScores 用已有 rolloutSamples 对
 *   当前 commitNode 的下一段 9 候选重算 75 帧总分并刷新 subtreeBest，
 *   随后强制当前段提前结束（跳过段末对齐），下一 tick 立即按新弹评分
 *   换操作。结构剪枝仍只按“提前死亡”执行。
 * 2026-08-16 v41（时间轴与真实世界同源）：
 *   根因：Phaser 给 AIs.update 的 physicsElapsedMS 是固定 desiredFps
 *   （默认 60fps），而 GameController/RoundModel 的 Box2D Step 用的是
 *   Date.now 墙钟 delta（含本帧 AI 树计算耗时）。两者长期漂移会让
 *   _timeAcc 与坦克真实运动错轴 → 段末出现 2~5m 假偏差 → alignHard
 *   反复 freshRoot（树只剩 2 节点）。
 *   修复：训练模式在 RoundModel.update（权威步长表，GameController 包装层
 *   兜底）记录每步实际 dt；tick 用同一 dt 推进 _timeAcc，树图竖线与
 *   真实世界步长时间轴同源。段末对齐也
 *   改为按“真实已过时间”取最近 rollout 样本，不再强制比较名义段末。
 *   软超差时不再 preserve 从预测位姿长出的旧预览层，而是从真实位姿
 *   重算下一层（保留当前根节点结构）；树图不再与坦克操作状态脱节。
 * 2026-08-21 v46（坍缩补位 + 威胁偏置收窄 + id 唯一化）：
 *   正常坍缩仍按主人语义删掉新根层未选中的 8 兄弟，但删完立即从新根
 *   真实位姿补 rollout 缺失的 8 个操作候选——旧代码只删不补，根层只剩
 *   1 个候选，树每段末被“几乎删完”。补位后根层恒为 9 候选比较集，
 *   选中者的深链保留，树不再塌成 2 节点。
 *   威胁偏置收窄：只有自然 argmax 选出的静止/纯旋转候选在本段已死亡，
 *   才从存活 mover 兜底；远弹只要静止候选还活着，不再禁用静止——
 *   实测中“超远子弹就抽搐”的直接原因。
 *   node id 改为 nextNodeId 单调分配（旧代码坍缩后用 nodeCount 续发 id，
 *   提升节点 id 会与根重复）；子树提升后 depth 按新拓扑重算。
 *   attachNewThreats/reanchorThreatsAtCommit 只重模拟缺轨迹的弹。
 *   性能修复集中在 checkDeath/评分的“不可能命中快跳”与轨迹增量模拟，
 *   融合世界每帧同步扩层的 v28 架构保持不动。
 * 2026-08-19 v45（时间轴平移死代码根修）：
 *   shiftSubtreeTime 的递归首步调用 rec(tree.root)，而守卫
 *   "n === tree.root → return" 直接让整轮递归在第一步退出——时间轴
 *   平移函数自 v42 起从未真正执行过。后果：
 *   ① 保留子树 tGlobal 沿层数无限累积（每 commit +0.18s），提交节点
 *      tEndSec 越滚越远 → 段末判定错乱、对齐照错样本 → alignHard
 *      连环 → 重建风暴、树长期只剩个位数节点；
 *   ② 深层节点按错误 tGlobal 查子弹轨迹（弹道时间错位），评分与死亡
 *      判定系统性失真 → 深层树"无视子弹"、树图 X 轴与实际时间对不上。
 *   修正：根节点只跳过自身字段平移，继续递归子节点。离线断言：
 *   提交节拍恒定 0.18s、对齐 0.000m、0 重建、60 tick 深度 20+。
 * 2026-08-19 v43（低帧率一层节点根修）：
 *   ① 撤销 v41“段末提前一步量化提交”：dt≈0.06s 时它会让 3~4 帧段
 *      每 1 步就提交，生长 tick 永远轮不到，坍缩后深度恒为 1。
 *   ② 新增 minGrowTicks=3：探段 tMin 按上一真实帧长换算（如 dt=0.06
 *      → tMin≥9 帧），保证每段至少有 3 个真实帧给 growStep，
 *      生长速度重新大于坍缩速度。
 *   ③ 子树刚性重摆的旧坐标系改为 prev.simState（子树实际生长起点），
 *      不再误用 root.simState——修掉 JSON 里恒定 0.512m 的段末偏移。
 * 2026-08-18 v42（提交原子化 + 保留子树刚性重摆 + 结构留档）：
 *   ① 提交重选 9 操作必须同一 tick 完成。旧 heavy 路径 perTick=1 跨
 *      9 tick，slice.realTankState 过期 0.2~0.3s，是 v41 JSON 中
 *      alignHard 连环触发/被单弹打死的直接原因。
 *   ② 正常坍缩保留子树时，把整棵子树从旧根位姿刚性变换到真实根位姿
 *      （平移+旋转），同时 rootAbsT/threats 每次 commit 重挂到当前
 *      真实时刻、子节点 tGlobal 同步平移——时间锚不再沿保留层数累积
 *      漂移，也不再因软超差删子树重算。
 *   ③ 即时威胁下，只有 forward/back 才算“可动候选”；纯左/右原地摆头
 *      不再压制静止（v41 实测贴墙连转 2 秒）。
 *   ④ diag.structureHistory/growHistory 完整记录所有结构变化与生长停滞；
 *      lastCommitInfo 在删除 8 兄弟前记录完整 9 候选（opKey 用 ASCII）。
 *   ⑤ 树图/地图在跟随模式下也画 doomedSnaps（上次坍缩的 8 兄弟），
 *      提交切片状态也显示在时间线上。
 * 2026-08-16 v40（有即时威胁时静止不得压过存活可动候选）：
 *   新增 pickBestWithThreatBias；commit 前记录 lastCommitInfo 供诊断。
 * 2026-08-16 v39（静止长段遇新弹提前结束）：
 *   仅静止 commitNode 且新弹即将进入威胁圈时提前结束该段，
 *   防止空旷期刚重建出的长静止段被下一波子弹贴脸打死。
 * 2026-08-16 v38（软对齐：小幅偏差不再清树）：
 *   段末偏差<3m/20°只记录 align 事件，保留整棵树继续跑；
 *   只有大幅偏差才 freshRoot。发射源坦克与玩家坦克取消物理推挤。
 * 2026-08-16 v37（取消新弹强制提前提交，稳定树结构）：
 *   新弹只追加 threat + 剪真正提前死亡的节点 + 刷新下一段候选分数；
 *   当前段自然跑完才提交。强制提前提交是树图频闪/结构混乱的根因。
 * 2026-08-16 v36（高频死亡恢复 + 弹消失不清树）：
 *   ① 子弹消失不再设置 threatDirty，旧轨迹自然耗尽；
 *   ② 九候选全被剪光时只重建当前根层，不再整树 freshRoot；
 *   ③ attach/expand 因节点满失败时走 freshRoot 兜底，避免永久卡同一操作。
 * 2026-08-16 v35（无损高性能新弹过滤 + 轨迹按需长度）：
 *   ① 只扫后补新弹，节点先做时空包围盒相交；
 *   ② bulletCannotReach：直线也够不到的节点直接跳过（坦克按半径4m圆）；
 *   ③ 命中才逐帧 checkDeath，且绝不因“子弹路过”判死；
 *   ④ track 长度 = 最深节点结束时刻 + EVAL，不再预生成未来无节点的轨迹。
 * 2026-08-16 v33（分数回传 + 提前提交轨迹重摆）：
 *   ① refreshCandidateScores 改完子分数后 backpropBest 回传父链，
 *      消除“静止上万、其他两千”的旧链分数残留；
 *   ② 新弹导致半途提前提交时，rebaseNodeFromReal 把选中节点从真实
 *      位姿重新模拟（只重算该节点 rolloutSamples/末态，不重建树），
 *      地图金线、节点虚影与 AI 实际执行一致。
 *
 * 沿用 v26~v32：8s视界；正常坍缩；500上限；track 帧数按弹种寿命接口化。
 *
 * 循环（tick 每游戏帧调一次）：
 *   1. 新增弹 → 局部失效 + 必要时根层重选；段末 → 对齐检查 + commit
 *   2. 提交重选 9 操作同 tick 原子完成（v42 起不再跨帧切片）
 *   3. 预览生长每 tick 扩一层 9 子节点（性能闸门隔帧跳过）
 *   4. 真死 → 剪掉当前节点，回父节点换存活兄弟继续模拟
 */
(function (global) {
    'use strict';

    var FRAME_DT = 0.02;            // 与沙箱/评分同源（0.02s/帧）
    var CONTACT_MARGIN = 4.0;       // v34：坦克按圆粗滤（半对角~2.5 + 弹径余量）
    var EVAL_FRAMES = 75;           // 评估深度（默认 75=1.5s；面板滑块可调 1~300）
    var _lanePenaltyRatio = 0;      // v47：树内车道压分开关状态（跨树保持）
    var _springRopeEnabled = false; // v57：弹簧绳修复后暂默认关，面板可开
    var _rustMinimalEnabled = false; // v69：Rust 最小决策实验开关（默认关）
    var _growWithoutThreatsEnabled = false; // v77：无子弹也生长树实验开关（默认关）
    var _deathDurationRatio = 0.5;            // v80：软死节点执行时长不超过死亡帧的一半
    var _growLayersPerTick = 1;               // v80：每 tick 最多生长多少层（完整9候选）
    var _deepSelectEnabled = false;           // v81：深层选路实验开关（默认关）
    var _maxNodes = 500;                     // v84：节点数上限，可由 testbench 滑块调整
    var _nodeCapEnabled = true;              // v85：节点数上限开关
    var _horizonCapEnabled = true;           // v85：时间视界上限开关
    var _horizonSec = 8.0;                   // v91：预测时长上限（秒，1~15）
    var _pruneCompensateLayers = 0;          // v91：新弹剪枝后每帧额外补偿层数（0~9）
    var _pruneCompensateFrames = 1;          // v91：补偿持续帧数（1~60）
    var _refineBeyondLimits = false;         // v85：达到上限后继续细化长操作
    var _continuousRefine = false;           // v88：不等上限，每 tick 主动细化一次
    var _moveTarget = null;                  // v92：点击地面后的末端姿态目标（格子坐标）
    var _liveProjectilesNow = 0;             // v97：真实世界当前子弹数（无弹时优先静止）
    var _moveTargetDirty = false;            // v98：点击目标变化后，触发全树刷新重选
    var _scoreOnlyPlanned = false;           // v98：评分范围仅限操作时长（false=固定75帧）
    var _killfieldEnabled = true;            // v100：杀戮场地形引导
    var _killfieldWeight = 0.5;              // v100：杀戮场权重（0~1）
    var _killfieldGrid = null;               // v100：静态地形安全分格子表
    var _killfieldMazeRef = null;
    var _killfieldW = 0, _killfieldH = 0;
    var _targetMixEnabled = false;           // v94：混合选路——目标分直接参与总分
    var _targetMixRatio = 0.5;               // v95：目标分占比系数（0~3 = 0~300%，仅混合模式生效）
    var _retreatNodes = 3;                   // v89：真死回退最多向上多少节点
    var _retreatFrames = 200;                // v90：真死回退最多向上多少帧（10~600）
    var _warmupMaxNodes = 500;               // v89：无子弹预热阶段的节点上限
    var _retreatDepth = 3;                   // v88 旧接口别名：等价于 retreatNodes
    var MAX_RESERVE_ANCHOR_DELTA = 1.0;  // v47：reserve 跨时间锚复用的最大锚差（秒）

    /** 树参数（03 九节，待实测标定） */
    var TREE_DEFAULTS = {
        epsilon: Math.PI * Math.PI,       // ≈9.87 = 0.25×遮蔽满分（v5：旧 39.5 实测
                                          // spread峰仅 8.4 永不触发→段长恒 30 帧
                                          // 上限→"一直按住前进"真凶；调至 1/4 档）
        tMin: 3,                          // 段长下限
        tMax: 30,                         // 段长上限
        horizonSec: 8.0,                  // v31：Box2D 轨迹已验证<0.5m，恢复长视界；
        pruneCompensateLayers: 0,        // v91：新弹剪枝后每帧额外补偿层数（0~9）
        pruneCompensateFrames: 1,        // v91：补偿持续帧数（1~60）
                                          // 节点数=视界/段长×每层候选：远弹段长30帧→
                                          // 层数少；近弹段长3帧→层数多，直到 maxNodes。
        maxNodes: 500,                    // 节点数上限（v84 起可调，默认仍 500）
        nodeCapEnabled: true,             // v85：节点数上限是否生效
        horizonCapEnabled: true,          // v85：时间视界是否生效
        refineBeyondLimits: false,        // v85：达到上限后继续细化长操作
        continuousRefine: false,          // v88：持续细化（不依赖无叶触发）
        retreatNodes: 3,                  // v89：真死回退最多向上多少节点（1~32）
        retreatFrames: 200,               // v90：真死回退最多向上多少帧（10~600）
        warmupMaxNodes: 500,              // v89：无子弹预热阶段节点上限（100~3000）
        retreatDepth: 3,                  // v88 旧接口兼容；新代码优先读 retreatNodes
        deathDurationRatio: 0.5,          // v80：软死执行时长上限 = 死亡帧的一半
        growLayersPerTick: 1,             // v80：每 tick 最多生长层数（1=原行为）
        scoreOnlyPlanned: false,          // v98：评分范围仅限操作时长（默认固定75帧）
        killfieldEnabled: true,           // v100：杀戮场地形引导
        killfieldWeight: 0.5,             // v100：杀戮场权重（0~1）
        targetMixEnabled: false,          // v94：目标分直接混入选路总分
        targetMixRatio: 0.5,              // v95：目标分占比系数（0~3）
        deepSelectEnabled: false,         // v81：深层子树价值参与 next/commit 选路（默认关）
        minGrowTicks: 3,                  // v43：每段至少给 3 个真实帧用于生长。
                                          // 帧率低时 3~4 帧段实际只有 1 步，树每段
                                          // 只能长 1 层、坍缩又删 8 条，深度永远 1。
                                          // tMin 会按 _lastWorldDt 换算成最小帧数。
        lanePenaltyRatio: 0,              // v47：树内车道压分默认关；setLaneEnabled
                                          // 会把 0/0.5 写入 tree.cfg。
        springRopeEnabled: false,         // v57：弹簧绳修复后暂默认关；setSpringRopeEnabled
        rustMinimalEnabled: false,         // v69：Rust 最小决策选择 next；默认关。
                                          // 会写入 tree.cfg。
        growWithoutThreats: false,        // v77：无子弹也生长树实验开关；默认关，
                                          // 保持 v57 grow-no-threat 行为。
        alignPosTol: 0.5,                 // 段末软对齐提示阈值（米）
        alignRotTol: 5 * Math.PI / 180,   // 段末软对齐提示阈值（弧度）
        alignHardPosTol: 3.0,             // 超过才整树重建；软超差只保留结构继续跑
        alignHardRotTol: 20 * Math.PI / 180
        // fullDepthSec 已随"带内全分叉"退役（v4 只沿金线延伸）
    };

    function mergeCfg(cfg) {
        var out = {}, k;
        for (k in TREE_DEFAULTS) out[k] = TREE_DEFAULTS[k];
        if (cfg) for (k in cfg) out[k] = cfg[k];
        // v77：无弹生长模块开关跨树保持；显式传 cfg 时仍以调用方为准。
        if (!cfg || cfg.growWithoutThreats === undefined) {
            out.growWithoutThreats = _growWithoutThreatsEnabled;
        }
        return out;
    }

    /** v47：树内评分统一传这套配置；死亡软判定口径 = 死帧停表不倒扣。 */
    function treeScoringCfg(tree) {
        var cfg = {
            deathPenalty: 0,
            lanePenaltyRatio: (tree && tree.cfg && typeof tree.cfg.lanePenaltyRatio === 'number')
                ? tree.cfg.lanePenaltyRatio
                : 0
        };
        // v53：树配置有数字/布尔就透传给评分模块，缺省让评分模块用默认值。
        if (tree && tree.cfg) {
            if (typeof tree.cfg.springRopeEnabled === 'boolean') {
                cfg.springRopeEnabled = tree.cfg.springRopeEnabled;
            }
            if (typeof tree.cfg.springRopeDNear === 'number') {
                cfg.springRopeDNear = tree.cfg.springRopeDNear;
            }
            if (typeof tree.cfg.springRopeDRef === 'number') {
                cfg.springRopeDRef = tree.cfg.springRopeDRef;
            }
            if (typeof tree.cfg.springRopeClearanceCap === 'number') {
                cfg.springRopeClearanceCap = tree.cfg.springRopeClearanceCap;
            }
        }
        return cfg;
    }

    // ============================================================
    // 一、Node / Tree 数据结构（03 二节段制）
    // ============================================================

    function createTreeNode(parent, inputs, simState) {
        var n = VantageScoring.createNodeValues();
        n.parent = parent || null;
        n.inputs = inputs || null;
        n.simState = simState || null;
        n.children = [];
        n.segmentFrames = 0;      // 本段实际执行帧数（段内死亡会缩短）
        n.plannedFrames = 0;      // v49：本段计划帧数 = 探段结果，死亡不缩短
        n.segmentScore = 0;       // 本段累计净分（软死：死处停算不倒扣）
        n.subtreeBest = 0;        // 头段分 + max(链延伸分, baseExt 恒定基线)
        n.baseExt = 0;            // 恒定延伸基线 = totalScore − 头段分（v4 口径）
        n.rolloutTotal = 0;       // v52：本节点 75 帧全累积总分（死亡帧停算；选路用）
        n.deathAuthority = '';    // v60：'fused'=融合传感器/CCD权威；'computed'=静态checkDeath重算
        // tEndSec = 绝对结束时刻（只用于段末调度/树图 X 轴）；
        // simState.tGlobal = 相对当前 threats 折线起点的时间（用于弹道采样）。
        n.tEndSec = 0;
        n.samples = null;         // 本段的 rollout 采样（现实对齐/渲染用）
        n.exhausted = false;      // 真死回退标记：此节点的 9 候选全部死亡，不再沿它生长
        n.fullDead = false;       // 完整75帧 rollout 是否死亡（即使死亡帧晚于段长）
        n.fullDeathFrame = -1;
        n.invalid = false;        // v47：结构失效（重摆穿墙/威胁局部失效剪枝）
        n.next = null;            // v49：本节点已经选定的下一个路线节点
        n.scoreCache = null;      // v54：scoreRolloutCached 的缓存
        n.perFrameScores = null;  // v75：最近一次 75 帧净分（Rust 增量评分用）
        n.freshSig = '';          // v54：当前 scoreCache 对应的威胁窗口签名
        n.dataVersion = 0;        // v54：缓存数据版本，随增量更新递增
        n.status = 'pending';
        if (parent) {
            n.depth = parent.depth + 1;
            n.parentId = parent.id;
        }
        return n;
    }

    // —— v3 连续时间轴 + 事件日志（模块级，跨树存续）——
    var _timeAcc = 0;        // 绝对累计时间（秒）：树图 X 轴/竖线锚点，坍缩重建均不归零
    var _lastWorldDt = FRAME_DT;   // 上一帧真实世界实际走过的秒数（v41 时间轴同源）
    var _lastSeenWorldStep = null; // v41：已消费的 RoundModel 真实步数（暂停/倒计时不前进）
    var _events = [];        // [{t, type:'commit'|'rebuild'|'align', info}]
    var MAX_EVENTS = 24;

    function pushEvent(type, info) {
        _events.push({ t: _timeAcc, type: type, info: info || '' });
        if (_events.length > MAX_EVENTS) _events.shift();
    }

    function maxDeltaSec() {
        if (typeof Constants !== 'undefined' && typeof Constants.MAX_DELTA_TIME === 'number') {
            return Constants.MAX_DELTA_TIME;
        }
        return 0.1;
    }

    /**
     * v41：解析“当前 tick 应推进多少秒”。训练模式里 GameController.update
     * 已记录 _ttLastWorldDt（上一帧 RoundModel.b2dworld.Step 实际使用的墙钟
     * delta），下一 tick 开始时真实坦克已经按它走完一步，所以树时间轴也按
     * 它推进。普通模式没有该记录时回退 physicsElapsedMS（固定60fps）或
     * lastUpdate 差值，不再继续制造两类时间轴的慢性漂移。
     */
    function resolveWorldDt(ai, fallbackDt) {
        var sec = (fallbackDt > 0 && fallbackDt < 1) ? fallbackDt : FRAME_DT;
        var gc = ai && ai.gameController;
        if (!gc) return sec;

        // 训练模式有精确步数计数（RoundModel 步长表优先，GameController
        // 包装层记录作兜底）：世界没 Step 的 tick（暂停/倒计时/提交切片
        // 跨帧）时间轴不得前进，否则坦克没动树却以为动了。
        var rm = gc.roundController && gc.roundController.model;
        var seen = null, lastDt = null;
        if (rm && typeof rm._ttStepCount === 'number') {
            seen = rm._ttStepCount;
            lastDt = rm._ttLastStepDt;
        } else if (typeof gc._ttWorldStepCount === 'number') {
            seen = gc._ttWorldStepCount;
            lastDt = gc._ttLastWorldDt;
        }
        if (seen !== null) {
            if (_lastSeenWorldStep === null) {
                // 首 tick：以当前步数对齐，取最近一步时长建立节奏。
                _lastSeenWorldStep = seen;
                if (typeof lastDt === 'number' && lastDt > 0) {
                    return Math.min(lastDt, maxDeltaSec());
                }
                return sec;
            }
            if (seen === _lastSeenWorldStep) return 0;
            _lastSeenWorldStep = seen;
            if (typeof lastDt === 'number' && lastDt > 0) {
                return Math.min(lastDt, maxDeltaSec());
            }
            return sec;
        }

        // 非训练模式回退：先吃 GameController 记录（若有），再吃墙钟。
        // 暂停递进（testbench N 键）时 gc 可能几秒没 update，raw 会巨大；
        // 那种情况必须相信调用方传的 physicsElapsedMS（步进已强制 20ms），
        // 否则树会为一次步进跳 0.1s。
        var w = null;
        var cap = maxDeltaSec();
        if (typeof gc._ttLastWorldDt === 'number' && gc._ttLastWorldDt > 0) {
            w = gc._ttLastWorldDt;
        } else if (typeof gc.lastUpdate === 'number') {
            var raw = (Date.now() - gc.lastUpdate) / 1000.0;
            if (raw > 0 && raw <= cap * 1.5) w = Math.min(raw, cap);
        }
        if (w !== null && w > 0 && isFinite(w)) {
            sec = Math.min(Math.max(w, 0.001), maxDeltaSec());
        }
        return sec;
    }

    /**
     * v41：段末判定也按“真实步长量化”。名义段长 = frames×0.02，
     * 但真实世界每步是墙钟 delta（16~50ms）。当前真实已过时间与再走
     * 一步之后哪个更接近名义段末，就选哪个触发——避免 30fps 下固定
     * “必须过 tEndSec”导致晚一步提交、真实位移比预测多半个身位。
     */
    /**
     * v43：段末判定恢复为“真实时间到达名义段末才提交”。
     * v41 的“提前一步量化提交”在 dt≈0.06s 时会让 4 帧段每 1 步就提交，
     * 生长 tick 一次都轮不到——这是一层节点持续好久的直接原因。
     * 对齐误差由最近样本比较兜底，不再用提前提交换误差。
     */
    function segmentEndDue(tree, estNextDt) {
        var cmt = tree.commitNode;
        if (!cmt) return false;
        return _timeAcc >= cmt.tEndSec;
    }

    // 性能闸门：霰弹枪一类会同时出现大量子弹。
    // 树决策只保留最紧迫的若干颗参与 rollout/死亡检测；新弹检测仍用完整 id 签名。
    var MAX_EVAL_BULLETS = 64;   // 与 sandbox checkDeath 子弹池 64 对齐；只保留最紧迫的 64 颗，超过再截断
    var GROW_MIN_INTERVAL_MS = 0;    // v28：完成一层立即开下一层（30ms 节流 + 短段 = 树只有1层）
    var TREE_OPS_PER_TICK = 3;       // v28：预览展开切片每 tick 3 操作（1层=3tick，短段也能完成）
    var TREE_OPS_PER_TICK_HEAVY = 1; // 多弹时每 tick 只算 1 个操作
    var TREE_COMMIT_OPS_PER_TICK = 3; // 提交重选切片：每 tick 最多算 3 个操作

    /** 从 projectiles 列表直接构造 id 签名（不跑折线计算，轻量） */
    function projectileSignature(projectiles) {
        if (!projectiles || !projectiles.length) return '';
        var ids = [];
        for (var i = 0; i < projectiles.length; i++) {
            if (projectiles[i] && projectiles[i].id !== undefined) ids.push(projectiles[i].id);
        }
        ids.sort();
        return ids.join(',');
    }

    /** 保留最紧迫的 max 颗子弹：先按入圈时间，再按最近距离。 */
    function limitThreats(threats, max) {
        if (!threats || threats.length <= max) return threats;
        var sorted = threats.slice().sort(function(a, b) {
            var at = (a.tIn !== null && a.tIn !== undefined) ? a.tIn : 999;
            var bt = (b.tIn !== null && b.tIn !== undefined) ? b.tIn : 999;
            if (at !== bt) return at - bt;
            return ((a.closestDist !== undefined ? a.closestDist : 999) -
                    (b.closestDist !== undefined ? b.closestDist : 999));
        });
        return sorted.slice(0, max);
    }

    /** 融合批量路径是否真的可用（开关开 + 适配器有批量模拟）。 */
    function fusedBatchReady(adapter) {
        return !!(VantageSandbox && VantageSandbox.fusedEnabled
            && VantageSandbox.fusedEnabled() && adapter && adapter.simulateTankBatch);
    }

    /** 新弹判定：newSig 里有 oldSig 没有的弹 id → 返回该 id（truthy）。
     *  出圈/爆炸（id 减少）不算——树内对已消失弹的预测只是保守悲观方向，
     *  段末提交用新 threats 自然刷新，无需推倒整树 */
    function threatAdded(oldSig, newSig) {
        if (!oldSig) return newSig ? newSig : null;
        var old = oldSig.split(','), map = {}, i;
        for (i = 0; i < old.length; i++) map[old[i]] = 1;
        var fresh = newSig ? newSig.split(',') : [];
        for (i = 0; i < fresh.length; i++) {
            if (fresh[i] && !map[fresh[i]]) return fresh[i];
        }
        return null;
    }

    /** v55：返回 oldSig 有但 newSig 没有的 id 数组。 */
    function removedIdsBetween(oldSig, newSig) {
        var oldArr = oldSig ? String(oldSig).split(',') : [];
        var newMap = {};
        var out = [];
        var i, id;
        if (newSig) {
            var newArr = String(newSig).split(',');
            for (i = 0; i < newArr.length; i++) newMap[newArr[i]] = true;
        }
        for (i = 0; i < oldArr.length; i++) {
            id = oldArr[i];
            if (id && !newMap[id]) out.push(id);
        }
        return out;
    }

    /** v55：按 id 从 tree.threats 与 _pendingThreats 中移除 threat 对象。 */
    function removeThreatsByIds(tree, ids) {
        if (!tree || !ids || !ids.length) return false;
        var idSet = {};
        var i, id;
        for (i = 0; i < ids.length; i++) idSet[ids[i]] = true;
        var removedAny = false;
        if (tree.threats && tree.threats.length) {
            var kept = [];
            for (i = 0; i < tree.threats.length; i++) {
                var th = tree.threats[i];
                if (th && th.id !== undefined && idSet[th.id]) {
                    removedAny = true;
                    continue;
                }
                kept.push(th);
            }
            tree.threats = kept;
        }
        if (tree._pendingThreats && tree._pendingThreats.length) {
            var keptP = [];
            for (i = 0; i < tree._pendingThreats.length; i++) {
                var pth = tree._pendingThreats[i];
                if (pth && pth.id !== undefined && idSet[pth.id]) {
                    removedAny = true;
                    continue;
                }
                keptP.push(pth);
            }
            tree._pendingThreats = keptP;
        }
        return removedAny;
    }

    function createTree(rootTankState, cfg) {
        // tGlobal 必须从 0 开始：它表示相对“当前这批 threats 折线起点”的时间。
        // 若用绝对时间，后续每 tick 重算 threats 会把子弹再往前平移一次，
        // 新弹会被误判成还远在天边 → 所有操作同分 → 永远静止。
        var rootState = { tank: { x: rootTankState.x, y: rootTankState.y, rot: rootTankState.rot }, tGlobal: 0 };
        var tree = {
            root: null,
            leaves: [],
            nodeCount: 0,
            nextNodeId: 1,          // v46：节点 id 唯一分配器。旧代码在正常坍缩
                                    // 后用“当前节点数”续发 id，被提升的根节点
                                    // id 恰好等于 nodeCount 时，新子节点会拿到与
                                    // 根相同的 id（如 root=10、child=10）。
            cfg: mergeCfg(cfg),
            tNow: _timeAcc,          // 树内绝对时间（只用于调度/渲染，不用于弹道采样）
            rootAbsT: _timeAcc,      // 当前根对应的真实绝对时刻：节点绝对结束时间 = rootAbsT + tGlobal
            commitNode: null,        // 执行中节点
            threatIds: '',           // 建树时的威胁弹 id 签名（新增弹→重建）
            threatDirty: false,      // 弹 id 集合变化（新增/消失）后，下次提交必须 freshRoot
            threats: null,           // 本根展开时锚定的 threats；预览链用它做时间平移
            _hasOffsetThreats: false,// v31：是否含“后补新弹”（带 anchorOffset），决定段末是否重扫
            _pendingThreats: [],     // v34：后补新弹列表，只扫这些弹（旧弹建节点时已计）
            _forcedReselect: false,  // v32：新弹刷新分数后强制提前提交，跳过段末对齐
            _lazyDirty: false,       // v54：有新增/消失弹待惰性刷新（仅提示，stale 仍按 sig）
            _lazyFrontier: null,     // v54：暂保留字段，后续金线外更新使用
            _lastLazyUpdateTick: -1, // v54：内部计数用
            _evaluatingTrueDead: false, // v58：真死回退递归保护
            threatAnchors: [],       // v27：换 threats 时的锚点快照（anchorT/path0/speed/…）
            reserve: [],             // v47：换道保留的未选中节点及子树（reserve/reuse）
            reserveCount: 0,         // v47：reserve 保留节点总数（含子树）
            reuseCount: 0,           // v47：reactivate 复用次数
            active: false,           // tick 驱动中（面板树模式开启）
            stats: { expands: 0, extends: 0, commits: 0, rebuilds: 0, freshRoots: 0, alignFails: 0, retreats: 0, growMs: 0, growSkips: 0, nodeCountFixes: 0, rustScoredBatches: 0, rustScoredFallbacks: 0, jsConfirmCount: 0, jsConfirmEarlier: 0, jsConfirmLater: 0, jsConfirmCleared: 0, deepSelects: 0, retreatReroutes: 0, refineSplits: 0, growStalls: {} },
            doomedSnaps: [],     // v6 上次坍缩被弃的 8 兄弟快照（灰显到下次 commit）
            execTrail: [],       // v6 执行过的节点轨迹快照（灰链渲染，上限 200）
            _expandSlice: null,  // 预览展开切片：{leaf, adapter, threats, idx, results}
            _commitSlice: null,  // 提交重选切片：{adapter, threats, realTankState, idx, results}
            _lastGrowAt: 0,
            _lastDesyncAt: 0,
            diag: {              // 同步诊断（主人要求：找出AI世界与真实世界的数据差异）
                bulletDesyncs: [],   // 锚定折线 vs 真实子弹位置偏差
                missingBullets: [],  // 真实存在但树threats里没有的弹 id
                lastTankError: 0,
                maxTankError: 0,
                lastBulletError: 0,
                lastCheckAt: 0,
                projectileCount: 0,
                sig: '',
                lastWorldDt: FRAME_DT,
                worldDtMin: Infinity,
                worldDtMax: 0,
                alignChecks: [],     // v41：每次段末对齐的 actual/pred/elapsed/op 原始留档
                structureHistory: [],// v42：所有结构变化（坍缩/重建/剪枝/失败）完整留档
                growHistory: [],      // v42：生长被跳过/无叶/上限（解释时间线不延伸）
                bulletTracks: { actual: {}, predicted: {} }
            }
        };
        tree.cfg.lanePenaltyRatio = _lanePenaltyRatio;   // v47：跨树保持开关状态
        tree.cfg.springRopeEnabled = _springRopeEnabled; // v53：跨树保持弹簧绳开关状态
        tree.cfg.rustMinimalEnabled = _rustMinimalEnabled; // v69：Rust 最小决策
        tree.cfg.deathDurationRatio = _deathDurationRatio; // v80
        tree.cfg.growLayersPerTick = _growLayersPerTick;   // v80
        tree.cfg.scoreOnlyPlanned = _scoreOnlyPlanned;   // v98
        tree.cfg.killfieldEnabled = _killfieldEnabled;   // v100
        tree.cfg.killfieldWeight = _killfieldWeight;     // v100
        tree.cfg.targetMixEnabled = _targetMixEnabled;     // v94
        tree.cfg.targetMixRatio = _targetMixRatio;         // v94
        tree.cfg.deepSelectEnabled = _deepSelectEnabled;   // v81
        tree.cfg.maxNodes = _maxNodes;                     // v84
        tree.cfg.nodeCapEnabled = _nodeCapEnabled;         // v85
        tree.cfg.horizonCapEnabled = _horizonCapEnabled;   // v85
        tree.cfg.horizonSec = _horizonSec;                 // v91
        tree.cfg.pruneCompensateLayers = _pruneCompensateLayers; // v91
        tree.cfg.pruneCompensateFrames = _pruneCompensateFrames; // v91
        tree.cfg.refineBeyondLimits = _refineBeyondLimits; // v85
        tree.cfg.continuousRefine = _continuousRefine;     // v88
        tree.cfg.retreatNodes = _retreatNodes;             // v89
        tree.cfg.retreatFrames = _retreatFrames;           // v89
        tree.cfg.warmupMaxNodes = _warmupMaxNodes;         // v89
        tree.cfg.retreatDepth = _retreatNodes;             // v88 旧字段保持可读
        tree.cfg.growWithoutThreats = _growWithoutThreatsEnabled; // v77：无弹生长
        tree.root = createTreeNode(null, null, rootState);
        tree.root.status = 'alive';
        tree.root.id = 0;
        tree.nodeCount = 1;
        tree.leaves = [tree.root];
        return tree;
    }

    /**
     * v27：树真正换 threats 时，给每颗弹拍一张“锚定快照”。
     * 之后 runDiagnostics 每帧回填 path0Now/path0Drift，专门验证
     * path[0] 是否还是活引用（v17 深拷贝后 drift 应恒为 0）。
     */
    function snapshotThreatAnchors(tree, threats, anchorT) {
        var anchors = [];
        if (threats) {
            for (var i = 0; i < threats.length; i++) {
                var th = threats[i];
                if (!th) continue;
                var path = th.path || [];
                var p0 = path.length ? path[0] : null;
                var totalLen = 0;
                for (var pi = 0; pi < path.length - 1; pi++) {
                    var dx = path[pi + 1].x - path[pi].x;
                    var dy = path[pi + 1].y - path[pi].y;
                    totalLen += Math.sqrt(dx * dx + dy * dy);
                }
                anchors.push({
                    id: th.id,
                    anchorT: anchorT + (th.anchorOffset || 0),
                    anchorAge: 0,
                    path0: p0 ? { x: p0.x, y: p0.y } : null,
                    path0Now: p0 ? { x: p0.x, y: p0.y } : null,
                    path0Drift: 0,
                    speed: th.speed,
                    totalLen: totalLen,
                    pointCount: path.length,
                    trackLen: th.track ? th.track.length : 0,
                    trackSource: th.trackSource || 'path'
                });
            }
        }
        tree.threatAnchors = anchors;
    }

    /**
     * v42：正常坍缩时重挂威胁时间锚，但优先复用旧弹的 Box2D 轨迹。
     * 旧 track[0] 对应旧 rootAbsT；新 rootAbsT = 当前 _timeAcc，因此
     * 每条旧轨迹的 anchorOffset 减去 (now-oldRootAbsT)。只有新出现且
     * 没有旧轨迹的弹才触发一次完整 track 模拟——正常保留子树时不会
     * 每 0.1s 都重跑 480 帧全弹模拟。
     */
    function reanchorThreatsAtCommit(tree, adapter, threats, oldRootAbsT) {
        var shift = Math.max(0, _timeAcc - oldRootAbsT);
        var oldMap = {}, i, th, old;
        for (i = 0; i < (tree.threats || []).length; i++) {
            th = tree.threats[i];
            if (th && th.id !== undefined) oldMap[th.id] = th;
        }
        var missing = false;
        var missingIds = [];
        var needFrames = trackFramesForTree(tree);
        for (i = 0; i < threats.length; i++) {
            th = threats[i];
            old = oldMap[th.id];
            // 旧轨迹最多只复用到 1.0s 偏移内：track 总长 480 帧=9.6s，
            // 若 shift 累积过大，最深未来查询会越界得到 null（子弹被
            // 误判为提前消失），此时必须整批重模拟。
            if (old && old.track && old.track.length >= needFrames && shift <= 1.0) {
                th.track = old.track;
                th.trackSource = old.trackSource || 'box2d';
                th.anchorOffset = (old.anchorOffset || 0) - shift;
            } else {
                th.track = null;
                th.anchorOffset = 0;
                missing = true;
                if (th.id !== undefined) missingIds.push(th.id);
            }
        }
        tree.threats = threats;
        tree._hasOffsetThreats = false;
        tree._pendingThreats = [];
        if (missing) {
            ensureThreatTracks(tree, adapter, threats, missingIds);
        }
        snapshotThreatAnchors(tree, threats, tree.rootAbsT);
    }

    /**
     * v28：给锚定 threats 挂 bullet-only Box2D 逐帧轨迹。
     * 调用时机 = commit 刚把 rootAbsT/threats 定为当前真实时刻，
     * 因此 track[0] 与 rootAbsT 同帧，后续 growStep 查询无需时间偏移。
     */
    /**
     * v34：轨迹只算到“当前最深节点的结束时刻 + EVAL”为止；
     * 树还没有的节点不需要轨迹，未来弹与旧节点的相交检测也只需要这个长度。
     */
    function trackFramesForTree(tree) {
        var base = Math.ceil((tree.cfg.horizonSec + EVAL_FRAMES * FRAME_DT) / FRAME_DT) + 5;
        var deepest = _timeAcc;
        (function rec(n) {
            if (!n) return;
            if (n.tEndSec > deepest) deepest = n.tEndSec;
            for (var i = 0; i < n.children.length; i++) rec(n.children[i]);
        })(tree.root);
        var extra = Math.ceil((deepest - _timeAcc + EVAL_FRAMES * FRAME_DT) / FRAME_DT) + 5;
        return Math.max(base, extra);
    }

function ensureThreatTracks(tree, adapter, threats, onlyIds) {
        if (!adapter || !adapter.simulateBulletTracks || !threats || !threats.length) return;
        // v30：track 帧数由两个参数共同决定，不硬编码任何弹种寿命：
        //   基准 = horizon + EVAL（树本轮滚动需要的最短长度）；
        //   上限 = 沙箱按当前场上各弹种真实 lifetime/timeAlive 算出的
        //         max(基准, 最长剩余寿命)。
        // 沙箱接口：adapter.getBulletTrackFrames(horizonFrames) ——
        // 后续新增弹种只需在沙箱内部改寿命表，树层零改动。
        // v46：onlyIds 只重模拟缺轨迹的弹；旧弹轨迹按 anchorOffset 复用。
        var needFrames = trackFramesForTree(tree);
        var tracks = null;
        try {
            tracks = adapter.simulateBulletTracks(needFrames, onlyIds || null);
        } catch (eTracks) {
            if (global.console && console.warn) {
                console.warn('[VantageTree] bullet tracks 预测失败，回退折线:', eTracks);
            }
            tracks = null;
        }
        if (!tracks) return;
        var byId = {}, i, t;
        for (i = 0; i < tracks.length; i++) {
            if (tracks[i] && tracks[i].id !== undefined) {
                byId[tracks[i].id] = tracks[i];
            }
        }
        var count = 0;
        for (t = 0; t < threats.length; t++) {
            var th = threats[t];
            if (!th || th.id === undefined || !byId[th.id]) continue;
            th.track = byId[th.id].frames || [];
            th.trackSource = 'box2d';
            // 新生成的 track[0] 永远对应“本次调用时的当前时刻”，
            // 调用方锚点若已推进到新 rootAbsT，偏移必须归零。
            th.anchorOffset = 0;
            if (th.track.length) count++;
        }
        tree.diag.trackCount = count;
        tree.diag.trackFrames = needFrames;
    }

    /**
     * v27：runDiagnostics 每帧回填锚点诊断。
     * path0Drift>0 = path[0] 仍被真实 body 改写（活引用未切断）。
     */
    function refreshThreatAnchors(tree) {
        var anchors = tree.threatAnchors || [];
        if (!tree.threats) return;
        for (var i = 0; i < anchors.length; i++) {
            var a = anchors[i];
            var th = null;
            for (var j = 0; j < tree.threats.length; j++) {
                if (tree.threats[j] && tree.threats[j].id === a.id) {
                    th = tree.threats[j];
                    break;
                }
            }
            a.anchorAge = Math.max(0, _timeAcc - a.anchorT);
            if (!th || !th.path || !th.path.length) {
                a.path0Now = null;
                continue;
            }
            var p0 = th.path[0];
            var now = { x: p0.x, y: p0.y };
            a.path0Now = now;
            a.path0Drift = a.path0 ? Math.sqrt(
                (now.x - a.path0.x) * (now.x - a.path0.x) +
                (now.y - a.path0.y) * (now.y - a.path0.y)
            ) : 0;
        }
    }

    /** v28/v31：Box2D 轨迹按帧索引取位（不插值）。track[0] 与 rootAbsT 同帧；
     *  新弹后补的 threat 带 anchorOffset，查询时间要扣掉偏移。 */
    function trackPosAt(th, relT) {
        if (!th || !th.track || !th.track.length) return null;
        var q = relT - (th.anchorOffset || 0);
        if (q < 0) return null;
        var idx = Math.round(q / FRAME_DT);
        if (idx < 0 || idx >= th.track.length) return null;
        var s = th.track[idx];
        if (!s || s.alive === false) return null;
        return { x: s.x, y: s.y };
    }

    /** v31：树内统一取某威胁在 tGlobal（相对 rootAbsT）的预测位置。 */
    function threatPosAtTree(adapter, th, tGlobal) {
        if (!th) return null;
        var q = tGlobal - (th.anchorOffset || 0);
        if (q < 0) return null;
        if (th.track && th.track.length) {
            var idx = Math.round(q / FRAME_DT);
            if (idx < 0 || idx >= th.track.length) return null;
            var s = th.track[idx];
            if (!s || s.alive === false) return null;
            return { x: s.x, y: s.y };
        }
        if (th.path && th.speed && adapter && adapter.bulletPosAt) {
            return adapter.bulletPosAt(th.path, th.speed, q);
        }
        return null;
    }

    /** v31：把“现在”算出的新威胁克隆成可挂到旧根时间轴的锚定威胁。 */
    function cloneThreatWithOffset(th, nowT, rootAbsT) {
        var c = {};
        var k;
        for (k in th) {
            if (th.hasOwnProperty(k)) c[k] = th[k];
        }
        c.anchorOffset = Math.max(0, nowT - rootAbsT);
        return c;
    }

    /**
     * v31：新弹局部失效第一步——把新弹追加进 tree.threats，
     * 不推倒旧树。track 以“现在”为 0 帧，anchorOffset 负责时间换算。
     */
    function attachNewThreats(tree, adapter, freshThreats) {
        if (!tree || !freshThreats || !freshThreats.length) return;
        var oldMap = {}, i, th, newOnes = [];
        for (i = 0; i < (tree.threats || []).length; i++) {
            if (tree.threats[i] && tree.threats[i].id !== undefined) {
                oldMap[tree.threats[i].id] = 1;
            }
        }
        for (i = 0; i < freshThreats.length; i++) {
            th = freshThreats[i];
            if (th && th.id !== undefined && !oldMap[th.id]) {
                newOnes.push(cloneThreatWithOffset(th, _timeAcc, tree.rootAbsT));
            }
        }
        if (!newOnes.length) return;

        // 只给新弹补到当前最深节点 + EVAL 的轨迹；不再为未来节点预生成全长。
        // v46 性能：只 roll 新弹自己的轨迹。旧弹轨迹在上次 commit 已生成并
        // 沿 anchorOffset 复用，全场重模拟会让连续射击期每颗新弹都卡 40~70ms。
        var needFrames = trackFramesForTree(tree);
        var onlyNewIds = [];
        for (i = 0; i < newOnes.length; i++) onlyNewIds.push(newOnes[i].id);
        var tracks = null;
        try {
            tracks = adapter.simulateBulletTracks(needFrames, onlyNewIds);
        } catch (eT) {
            tracks = null;
        }
        var byId = {};
        if (tracks) {
            for (i = 0; i < tracks.length; i++) {
                if (tracks[i] && tracks[i].id !== undefined) byId[tracks[i].id] = tracks[i];
            }
        }
        for (i = 0; i < newOnes.length; i++) {
            th = newOnes[i];
            if (byId[th.id]) {
                th.track = byId[th.id].frames || [];
                th.trackSource = 'box2d';
            }
        }

        tree.threats = (tree.threats || []).concat(newOnes);
        tree.threats = limitThreats(tree.threats, MAX_EVAL_BULLETS);
        tree._pendingThreats = (tree._pendingThreats || []).concat(newOnes);
        tree._hasOffsetThreats = true;   // 后续段末继续重扫，处理“远弹后来逼近”
        snapshotThreatAnchors(tree, tree.threats, tree.rootAbsT);
        pushEvent('threat', '局部追加新弹' + newOnes.length);
    }

    /** v31/v78：扫描单节点在“后补新弹”下是否比建节点时更早死亡。
     *  v61 起精确判定改融合世界；v78 起优先使用 JS 融合世界
     *  simulateTankBatchJsFused，只有 JS 融合不可用时才回退
     *  adapter.simulateTankBatch（并明确标记是否为 Rust 候选）。
     *  返回 {death, authority, confirmed}；death<0 表示无更早死亡。 */
    function scanNodeDeath(tree, adapter, node, pending) {
        if (!node || !node.rolloutSamples || !node.rolloutSamples.length) return null;
        if (!adapter) return null;
        var segF = Math.max(1, node.segmentFrames || 0);
        if (!node.inputs) return null;
        var startSample = node.rolloutSamples[0];
        var startPose = { x: startSample.x, y: startSample.y, rot: startSample.rot };
        var opt = {
            startPose: startPose,
            threats: tree.threats || [],
            tGlobal: node.rolloutStartT || 0
        };
        var op = [{ name: node.opName || '?', inputs: node.inputs }];

        // 第一优先：JS 融合世界单操作模拟，游戏同源死亡权威。
        var jsBatch = null;
        if (typeof adapter.simulateTankBatchJsFused === 'function') {
            try {
                jsBatch = adapter.simulateTankBatchJsFused(startPose, op, segF, opt);
            } catch (eJsFused) {
                jsBatch = null;
            }
        }
        if (jsBatch && jsBatch.length) {
            var j0 = jsBatch[0];
            if (j0 && j0.dead && j0.deathFrame != null) {
                var absDeathJs = tree.rootAbsT + (node.rolloutStartT || 0) + j0.deathFrame * FRAME_DT;
                if (absDeathJs < _timeAcc - FRAME_DT) return null;
                return { death: j0.deathFrame, authority: 'fused', confirmed: true };
            }
            return { death: -1, authority: 'fused', confirmed: true };
        }

        // 回退：普通模拟批次；Rust 物理预测只作候选。
        if (typeof adapter.simulateTankBatch !== 'function') return null;
        var batch = null;
        try {
            batch = adapter.simulateTankBatch(startPose, op, segF, opt);
        } catch (eFused) {
            batch = null;
        }
        if (!batch || !batch.length) return null;
        var b0 = batch[0];
        if (!b0 || !b0.dead || b0.deathFrame == null) return null;
        var death = b0.deathFrame;
        var absDeath = tree.rootAbsT + (node.rolloutStartT || 0) + death * FRAME_DT;
        if (absDeath < _timeAcc - FRAME_DT) return null;
        return {
            death: death,
            authority: b0.rustPhysics ? 'rust-candidate' : (b0.deathAuthority || 'check'),
            confirmed: false
        };
    }
    /** v34：后补弹的粗包围盒（轨迹坐标 + 绝对时间范围；rootAbsT 用于把 anchorOffset 平移到绝对时间）。 */
    function threatCoarseBox(th, rootAbsT) {
        var absBase = rootAbsT || 0;
        var box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, t0: absBase + (th.anchorOffset || 0), t1: 0 };
        var arr = th.track && th.track.length ? th.track : (th.path || []);
        var i, p;
        for (i = 0; i < arr.length; i++) {
            p = arr[i];
            if (!p || p.alive === false) break;
            if (p.x < box.minX) box.minX = p.x;
            if (p.x > box.maxX) box.maxX = p.x;
            if (p.y < box.minY) box.minY = p.y;
            if (p.y > box.maxY) box.maxY = p.y;
        }
        if (th.track && th.track.length) {
            box.t1 = box.t0 + th.track.length * FRAME_DT;
        } else {
            var len = 0;
            for (i = 0; i < arr.length - 1; i++) {
                len += Math.sqrt((arr[i + 1].x - arr[i].x) * (arr[i + 1].x - arr[i].x) + (arr[i + 1].y - arr[i].y) * (arr[i + 1].y - arr[i].y));
            }
            box.t1 = box.t0 + (th.speed > 0 ? len / th.speed : 0);
        }
        return box;
    }

    /** v34：节点粗包围盒（rolloutSamples 位置 + 节点时间段）。 */
    function nodeCoarseBox(tree, node) {
        var box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, t0: tree.rootAbsT + (node.rolloutStartT || 0), t1: 0 };
        var samples = node.rolloutSamples || [];
        var segF = Math.max(1, node.segmentFrames || 0);
        var maxK = Math.min(segF, samples.length - 1);
        var step = Math.max(1, Math.floor(maxK / 16));
        var k, s;
        for (k = 0; k <= maxK; k += step) {
            s = samples[k];
            if (!s) continue;
            if (s.x < box.minX) box.minX = s.x;
            if (s.x > box.maxX) box.maxX = s.x;
            if (s.y < box.minY) box.minY = s.y;
            if (s.y > box.maxY) box.maxY = s.y;
        }
        box.t1 = box.t0 + maxK * FRAME_DT;
        return box;
    }

    function pointBoxDistance(px, py, b) {
        var dx = 0, dy = 0;
        if (px < b.minX) dx = b.minX - px;
        else if (px > b.maxX) dx = px - b.maxX;
        if (py < b.minY) dy = b.minY - py;
        else if (py > b.maxY) dy = py - b.maxY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * v34 无损粗滤：即便子弹从当前位置“直线”冲向节点包围盒，
     * 到节点结束时刻也够不到，就绝不可能是这颗弹造成提前死亡。
     * （不依赖反弹；真实轨迹只会更长，直线距离是最小可行距离。）
     */
    function threatStartPoint(th) {
        if (th && th.track && th.track.length && th.track[0]) return { x: th.track[0].x, y: th.track[0].y };
        if (th && th.path && th.path.length && th.path[0]) return { x: th.path[0].x, y: th.path[0].y };
        return null;
    }

    function bulletCannotReach(th, p0, nb) {
        if (!p0 || !(th.speed > 0)) return false;
        var maxTravel = th.speed * Math.max(0, nb.t1 - _timeAcc);
        return pointBoxDistance(p0.x, p0.y, nb) - maxTravel > CONTACT_MARGIN;
    }

    function boxesOverlap(a, b, margin) {
        return a.t0 <= b.t1 && b.t0 <= a.t1 &&
            a.minX - margin <= b.maxX && b.minX - margin <= a.maxX &&
            a.minY - margin <= b.maxY && b.minY - margin <= a.maxY;
    }

    /** v91：记录新弹剪枝损失，并按配置给接下来几帧加生长补偿。
     *  默认补偿层数=0、持续=1，等于不改变默认行为。 */
    function notePruneLoss(tree, beforeCount, reason) {
        if (!tree || !tree.cfg) return 0;
        var lost = (beforeCount || 0) - (tree.nodeCount || 0);
        if (lost <= 0) return 0;
        var layers = Math.max(0, Math.min(9,
            Math.floor(tree.cfg.pruneCompensateLayers || 0)));
        if (layers <= 0) return lost;
        var frames = Math.max(1, Math.min(60,
            Math.floor(tree.cfg.pruneCompensateFrames || 1)));
        tree._growBoost = {
            layers: layers,
            framesLeft: frames,
            totalFrames: frames,
            lost: lost,
            reason: reason || ''
        };
        tree.stats.pruneCompensations = (tree.stats.pruneCompensations || 0) + 1;
        tree.stats.pruneLostNodes = (tree.stats.pruneLostNodes || 0) + lost;
        recordStructure(tree, 'grow-compensate',
            'lost=' + lost + ' layers=' + layers + ' frames=' + frames +
            (reason ? ' ' + reason : ''));
        return lost;
    }

    /**
     * v31/v34：局部失效核心。只扫后补新弹；先用时空粗包围盒过滤节点，
     * 命中的节点才逐帧 checkDeath。不会“子弹路过位置就算死亡”。
     */
    function invalidateStaleNodes(tree, adapter) {
        if (!tree || !tree.root || !tree.threats || !tree.threats.length) return false;
        if (!tree._hasOffsetThreats) return false;
        var pending = tree._pendingThreats || [];
        if (!pending.length) {
            tree._hasOffsetThreats = false;
            return false;
        }
        var boxes = [];
        var i;
        for (i = 0; i < pending.length; i++) {
            var tb = threatCoarseBox(pending[i], tree.rootAbsT);
            if (tb.minX < Infinity) boxes.push(tb);
        }
        if (!boxes.length) return false;

        var nodes = [];
        (function collect(n) {
            nodes.push(n);
            for (var cj = 0; cj < n.children.length; cj++) collect(n.children[cj]);
        })(tree.root);
        var commitHit = false;
        var prunedCount = 0;
        for (i = nodes.length - 1; i >= 0; i--) {
            var node = nodes[i];
            if (!node || node === tree.root || node.exhausted || node.invalid || !node.rolloutSamples) continue;
            var nb = nodeCoarseBox(tree, node);
            if (nb.minX >= Infinity) continue;
            var hit = false;
            for (var bi = 0; bi < boxes.length; bi++) {
                var tb2 = boxes[bi];
                if (!boxesOverlap(nb, tb2, CONTACT_MARGIN)) continue;
                var p0 = threatStartPoint(pending[bi]);
                if (p0 && bulletCannotReach(pending[bi], p0, nb)) continue;
                hit = true;
                break;
            }
            if (!hit) continue;
            // v62：即时融合死亡扫描只对“正在执行的节点”做。
            // 其余节点先标 stale，由金线刷新在真正参与比较前融合重算，
            // 避免一颗新弹对几十上百个候选各自开一个融合世界导致掉帧。
            if (node !== tree.commitNode) continue;
            var scan = scanNodeDeath(tree, adapter, node, pending);
            if (!scan || scan.death < 0) continue;
            var oldSeg = node.segmentFrames || 0;
            // v78：统一口径。死亡帧 k 表示第 k 帧是死态，安全执行到 k-1 帧。
            // 只有实际缩短当前段才触发 commitHit；off-by-one 不再漏判。
            var safeFrames = safeFramesForDeath(tree, scan.death, oldSeg);
            if (safeFrames >= oldSeg) continue;
            // 提前死亡：本节点及全部子节点作废。
            while (node.children.length) detachChild(tree, node.children[0]);
            node.status = 'dead';
            node.fullDead = true;
            node.segmentFrames = safeFrames;
            node.fullDeathFrame = scan.death;
            node.deathAuthority = scan.authority;
            node.rolloutDeathFrame = scan.death;
            node.tEndSec = tree.rootAbsT + (node.rolloutStartT || 0) + safeFrames * FRAME_DT;
            node.exhausted = true;
            prunedCount++;
            pushEvent('prune', 'n' + (node.id || '?') + '@' + scan.death + '/' + oldSeg +
                ' safe=' + safeFrames + ' ' + scan.authority);
            if (node === tree.commitNode) commitHit = true;
            // v52：剪掉的分支如果正是父节点 planned next，父节点必须重选 next，
            // 否则金线/正常提交会指向一个 exhausted 节点。
            if (node.parent && node.parent.next === node) {
                var prunedNext = pickBestChildByRolloutTotal(node.parent.children);
                node.parent.next = prunedNext;
                recordStructure(tree, 'next-pruned-retarget',
                    'n' + (node.parent.id || '?') + ' next→' +
                    (prunedNext ? ('n' + prunedNext.id) : 'null'));
            }
            if (node.parent) backpropBest(node.parent);
        }
        if (prunedCount) {
            recordStructure(tree, 'prune-new-threat', 'pruned=' + prunedCount);
        }
        if (commitHit) pushEvent('prune', 'commitNode提前死亡，根层重选');
        return commitHit;
    }

    /** 取 active 子节点中最大的 subtreeBest（无子节点时为 0，与 backpropBest 同口径）。 */
    function maxActiveChildBest(node) {
        var best = -Infinity;
        if (!node) return 0;
        for (var i = 0; i < node.children.length; i++) {
            var c = node.children[i];
            if (c && !c.exhausted && !c.invalid && c.subtreeBest > best) best = c.subtreeBest;
        }
        return best > -Infinity ? best : 0;
    }

    /** v50：把 node 的全部后代标记 invalid 并从活动树移除。 */
    function invalidateDescendants(tree, node) {
        if (!node || !node.children.length) return 0;
        var removed = 0;
        function markInvalid(n) {
            n.invalid = true;
            for (var i = 0; i < n.children.length; i++) markInvalid(n.children[i]);
        }
        while (node.children.length) {
            var child = node.children[0];
            markInvalid(child);
            if (child.parent === node) {
                detachChild(tree, child);
            } else {
                // v76：已被祖先 detach 的残留后代不得二次扣 nodeCount。
                node.children.shift();
            }
            removed++;
        }
        return removed;
    }

    /**
     * v51：把 scoreRollout/scorePath 的返回值写回节点数值。
     * 实际执行帧数：fd=-1 计划；fd=1 真死保持1；fd>=2 死亡帧-1 且不超过计划。
     * 分数只累加实际执行帧；死亡帧不加分。plannedFrames 永不变。
     */
    function applyRolloutScore(tree, node, r) {
        if (!node || !r || !r.perFrameScores) return false;
        node.perFrameScores = r.perFrameScores.slice();
        var planned = plannedFramesOf(node);
        var actual = r.dead
            ? safeFramesForDeath(tree, r.deathFrame, planned)
            : planned;
        if (actual < planned) {
            recordStructure(tree, 'death-shorten',
                'n' + (node.id || '?') + ' planned=' + planned + ' death=' + r.deathFrame + ' actual=' + actual);
        }
        node.segmentFrames = actual;
        if (node.rolloutSamples && node.rolloutSamples[actual]) {
            var ds = node.rolloutSamples[actual];
            node.simState.tank = { x: ds.x, y: ds.y, rot: ds.rot };
        }
        if (typeof node.rolloutStartT === 'number') {
            node.simState.tGlobal = node.rolloutStartT + actual * FRAME_DT;
        }
        node.tEndSec = tree.rootAbsT + node.simState.tGlobal;
        if (actual < planned && node.children.length) invalidateDescendants(tree, node);
        var sum = 0;
        var upto = Math.min(actual, r.perFrameScores.length);
        for (var k = 0; k < upto; k++) sum += r.perFrameScores[k];
        node.segmentScore = sum;
        node.baseExt = (r.totalScore || 0) - node.segmentScore;
        node.rolloutTotal = (r.totalScore || 0);   // v52：75帧全累积总分
        node.status = (r.dead && r.deathFrame >= 0 && r.deathFrame <= planned) ? 'dead' : 'alive';
        node.fullDead = !!r.dead;
        node.fullDeathFrame = r.dead ? r.deathFrame : -1;
        node.subtreeBest = node.segmentScore + Math.max(node.baseExt || 0, maxActiveChildBest(node));
        return true;
    }

    /**
     * v32：新弹出现后，不重建节点，只对“当前 commitNode 的下一段候选”
     * 用已有 rolloutSamples 重算 75 帧总分并刷新 subtreeBest。
     * 这样新弹一出现 AI 就能在下一次提交换操作（恢复老版预判反应），
     * 而树结构仍按“提前死亡才剪枝”的局部失效规则走。
     */
    /** v71：节点完整 rollout 包围盒（75 帧评分口径，不是只覆盖当前段）。 */
    function nodeScoringCoarseBox(tree, node) {
        var box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity,
            t0: tree.rootAbsT + (node.rolloutStartT || 0), t1: 0 };
        var samples = node.rolloutSamples || [];
        if (!samples.length) return box;
        var maxK = samples.length - 1;
        var k, s;
        for (k = 0; k <= maxK; k++) {
            s = samples[k];
            if (!s) continue;
            if (s.x < box.minX) box.minX = s.x;
            if (s.x > box.maxX) box.maxX = s.x;
            if (s.y < box.minY) box.minY = s.y;
            if (s.y > box.maxY) box.maxY = s.y;
        }
        box.t1 = box.t0 + maxK * FRAME_DT;
        return box;
    }

    /**
     * v71：节点是否可能被后补新弹影响（评分或死亡）。
     * CONTACT_MARGIN=4m 覆盖死亡/遮蔽(3.06m)/车道(3.5m)全部影响半径。
     * 没有 pending 新弹时返回 true，保持旧刷新语义。
     */
    function nodePossiblyAffectedByPending(tree, node, pending, boxes) {
        if (!pending || !pending.length || !boxes || !boxes.length) return true;
        var nb = nodeScoringCoarseBox(tree, node);
        if (!(nb.minX < Infinity)) return false;
        for (var bi = 0; bi < boxes.length; bi++) {
            if (!boxesOverlap(nb, boxes[bi], CONTACT_MARGIN)) continue;
            var p0 = threatStartPoint(pending[bi]);
            if (p0 && bulletCannotReach(pending[bi], p0, nb)) continue;
            return true;
        }
        return false;
    }

    /**
     * v71：节点 stale 是否只可能由“当前 pending 新弹”引起。
     * 只要旧签名里有任何当前已消失的弹，就禁止粗滤跳过（弹消失会增分，
     * 粗盒不重叠也不能跳）。同样，新增签名里若存在非 pending 弹，也保守
     * 不跳。这样粗过滤在增/删混合场景下仍然无损。
     */
    function nodeStaleOnlyByPending(oldSig, newSig, pending) {
        if (!pending || !pending.length) return false;
        var oldIds = oldSig ? oldSig.split(',') : [];
        var newIds = newSig ? newSig.split(',') : [];
        var oldSet = {}, newSet = {}, pendingSet = {};
        var i, id;
        for (i = 0; i < oldIds.length; i++) oldSet[oldIds[i]] = true;
        for (i = 0; i < newIds.length; i++) newSet[newIds[i]] = true;
        for (i = 0; i < pending.length; i++) {
            id = pending[i] && pending[i].id;
            if (id !== undefined && id !== null) pendingSet[String(id)] = true;
        }
        for (i = 0; i < oldIds.length; i++) {
            if (!newSet[oldIds[i]]) return false;   // 有弹消失
        }
        for (i = 0; i < newIds.length; i++) {
            if (!oldSet[newIds[i]] && !pendingSet[newIds[i]]) return false;
        }
        return true;
    }

    /** v71：构建当前后补新弹的粗包围盒（与 invalidateStaleNodes 同口径）。 */
    function pendingThreatCoarseBoxes(tree) {
        var pending = tree._pendingThreats || [];
        var boxes = [];
        for (var i = 0; i < pending.length; i++) {
            var tb = threatCoarseBox(pending[i], tree.rootAbsT);
            if (tb.minX < Infinity) boxes.push(tb);
        }
        return { pending: pending, boxes: boxes };
    }

    /** v70：判断操作是否会产生位移/旋转（与评分模块口径一致）。 */
    function isMovingInputs(inputs) {
        return !!(inputs && (inputs.forward || inputs.back || inputs.left || inputs.right));
    }

    /**
     * v70：尝试用 Rust vt_rescore_nodes 重算一父层 stale 候选。
     * 仅在适配器提供 rescoreTankSamples、未启用弹簧绳、且所有 stale 节点
     * 都有有效 rolloutSamples 时返回结果；任何不可用都返回 null，
     * 由 refreshFusedLayer 回退原 VantageScoring.scorePaths。
     */
    function validRescoreNode(c) {
        if (!c || !Array.isArray(c.rolloutSamples) ||
                c.rolloutSamples.length < 2 || c.rolloutSamples.length > 76) {
            return false;
        }
        for (var k = 0; k < c.rolloutSamples.length; k++) {
            var s = c.rolloutSamples[k];
            if (!s || typeof s !== 'object' ||
                    !isFinite(Number(s.x)) || !isFinite(Number(s.y)) ||
                    !isFinite(Number(s.rot))) {
                return false;
            }
        }
        return true;
    }

    /** v77：构造单个节点的 rescore 输入；onlyPending 节点携带增量缓存。 */
    function buildRescoreNodeInput(tree, adapter, c) {
        var onlyPending = nodeStaleOnlyByPending(
            c.freshSig || '',
            nodeWindowSig(adapter, c, tree.threats || []),
            tree._pendingThreats || []
        );
        var nodeInput = {
            samples: c.rolloutSamples,
            moving: isMovingInputs(c.inputs),
            startT: (typeof c.rolloutStartT === 'number') ? c.rolloutStartT : 0,
            frames: EVAL_FRAMES
        };
        if (onlyPending && Array.isArray(c.perFrameScores)) {
            nodeInput.previousScores = c.perFrameScores;
            if (typeof c.fullDeathFrame === 'number') {
                nodeInput.previousDeathFrame = c.fullDeathFrame;
            }
        }
        return nodeInput;
    }

    function callRescoreAdapter(adapter, tree, nodes) {
        var results;
        try {
            results = adapter.rescoreTankSamples(
                nodes,
                tree.threats || [],
                treeScoringCfg(tree),
                tree._pendingThreats || []
            );
        } catch (eRust) {
            return null;
        }
        if (!results || results.length !== nodes.length) return null;
        return results;
    }

    function tryRustRescoreLayer(tree, adapter, stale) {
        if (!adapter || typeof adapter.rescoreTankSamples !== 'function') return null;
        if (!tree || (tree.cfg && tree.cfg.springRopeEnabled === true)) return null;
        if (!stale || !stale.length) return null;

        var incNodes = [], incIdx = [];
        var fullNodes = [], fullIdx = [];
        var i, c, nodeInput;
        for (i = 0; i < stale.length; i++) {
            c = stale[i];
            if (!validRescoreNode(c)) return null;
            nodeInput = buildRescoreNodeInput(tree, adapter, c);
            if (nodeInput.previousScores !== undefined && nodeInput.previousScores !== null) {
                incNodes.push(nodeInput);
                incIdx.push(i);
            } else {
                fullNodes.push(nodeInput);
                fullIdx.push(i);
            }
        }

        var results = new Array(stale.length);
        var j, groupResults;
        if (incNodes.length) {
            groupResults = callRescoreAdapter(adapter, tree, incNodes);
            if (!groupResults) return null;
            for (j = 0; j < groupResults.length; j++) {
                groupResults[j].rustCandidate = true;
                groupResults[j].rustIncremental = true;
                results[incIdx[j]] = groupResults[j];
            }
        }
        if (fullNodes.length) {
            groupResults = callRescoreAdapter(adapter, tree, fullNodes);
            if (!groupResults) return null;
            for (j = 0; j < groupResults.length; j++) {
                groupResults[j].rustCandidate = true;
                groupResults[j].rustIncremental = false;
                results[fullIdx[j]] = groupResults[j];
            }
        }
        return { results: results, usedRust: true };
    }

    /** v71：收集一父层需要重算的 stale 候选（含无损粗过滤）。 */
    function collectStaleForLayer(tree, adapter, parent) {
        var stale = [];
        var ops = [];
        var i, c;
        var pendingFilter = pendingThreatCoarseBoxes(tree);
        for (i = 0; i < parent.children.length; i++) {
            c = parent.children[i];
            if (!isOptionalNode(c)) continue;
            if (!nodeIsStale(adapter, c, tree.threats || [])) continue;
            var staleNewSig = nodeWindowSig(adapter, c, tree.threats || []);
            if (nodeStaleOnlyByPending(c.freshSig || '', staleNewSig,
                    pendingFilter.pending) &&
                    !nodePossiblyAffectedByPending(tree, c,
                        pendingFilter.pending, pendingFilter.boxes)) {
                c.freshSig = staleNewSig;
                tree.stats.filteredStaleSkip = (tree.stats.filteredStaleSkip || 0) + 1;
                continue;
            }
            stale.push(c);
            ops.push({ name: c.opName || '?', inputs: c.inputs });
        }
        return { stale: stale, ops: ops };
    }

    /**
     * v77：JS 侧合并旧死亡帧与 Rust 新候选死亡帧。
     * 旧结论 = 上一轮 fullDeathFrame + 上一轮 perFrameScores；
     * Rust 新候选 = 只验证新弹得到的 deathFrame。取更早者；旧结论胜出时
     * 沿用旧 perFrameScores（长度=旧死亡帧），避免 Rust 全长分数把已截断
     * 的死亡帧分数又拉长。
     */
    function mergeIncrementalRescoreDeath(c, r) {
        var oldFd = (typeof c.fullDeathFrame === 'number') ? c.fullDeathFrame : -1;
        var newFd = (r && typeof r.deathFrame === 'number') ? r.deathFrame : -1;
        var mergedFd = oldFd;
        if (newFd > 0 && (oldFd <= 0 || newFd < oldFd)) mergedFd = newFd;

        var pfs = null;
        if (mergedFd === oldFd && oldFd > 0 && Array.isArray(c.perFrameScores)) {
            pfs = c.perFrameScores;
        } else if (mergedFd === newFd && newFd > 0 && Array.isArray(r.perFrameScores)) {
            pfs = r.perFrameScores;
        } else if (Array.isArray(r.perFrameScores)) {
            pfs = r.perFrameScores;
        } else if (Array.isArray(c.perFrameScores)) {
            pfs = c.perFrameScores;
        } else {
            return null;
        }

        var total = 0;
        for (var k = 0; k < pfs.length; k++) total += Number(pfs[k]) || 0;
        return {
            samples: r.samples,
            perFrameScores: pfs.slice(),
            totalScore: total,
            dead: mergedFd > 0,
            deathFrame: mergedFd,
            frameCount: pfs.length,
            rustCandidate: true,
            rustIncremental: true
        };
    }

    /** v70：把已算好的 results 写回一父层候选节点；返回更新数。 */
    function applyLayerResults(tree, adapter, parent, stale, results) {
        if (!results || results.length !== stale.length) return 0;
        if (!tree || !parent || parent.invalid || !isActiveTreeNode(tree, parent)) return 0;
        var updated = 0;
        for (var i = 0; i < stale.length; i++) {
            var c = stale[i];
            var r = results[i];
            if (!c || !r) continue;
            // v76：同批写回中，祖先 death-shorten 可能已把后序候选整棵摘除。
            // 已失效/已脱离当前父层的候选一律跳过，防止二次写回、二次扣数。
            if (c.invalid || c.parent !== parent || !isActiveTreeNode(tree, c)) continue;
            var oldFd = c.fullDeathFrame;
            if (r.rustIncremental) {
                r = mergeIncrementalRescoreDeath(c, r);
                if (!r) continue;
            }
            if (r.samples && r.samples.length) c.rolloutSamples = r.samples;
            applyRolloutScore(tree, c, r);
            c.scoreCache = null;
            c.freshSig = nodeWindowSig(adapter, c, tree.threats || []);
            // v77：Rust rescore 只产出候选死亡帧；最终执行路线会由 JS
            // 融合世界确认后改写为 'fused'。此处仅标记候选，不冒充权威。
            // v78：Rust rescore 与 Rust 物理预测都只算候选；JS 融合才是权威。
            c.deathAuthority = (r.rustCandidate || r.rustPhysics)
                ? 'rust-candidate'
                : (r.deathAuthority || 'fused');
            c.dataVersion++;
            updated++;
            if (c.fullDeathFrame !== oldFd) {
                recordStructure(tree, 'death-update-audit',
                    'n' + c.id + ' fd ' + oldFd + '→' + c.fullDeathFrame);
                tree.diag.deathAudit = tree.diag.deathAudit || [];
                tree.diag.deathAudit.push({ t: _timeAcc, detail: 'n' + c.id + ' fd ' + oldFd + '→' + c.fullDeathFrame });
                if (tree.diag.deathAudit.length > 100) tree.diag.deathAudit.shift();
            }
        }
        if (updated) backpropBest(parent);
        if (tree.nodeCount < 0) recountActiveNodes(tree);
        return updated;
    }

    /** v68：用融合世界重算一父层 stale 候选；返回更新数。 */
    function refreshFusedLayer(tree, adapter, parent) {
        if (!tree || !parent || !parent.children || !parent.children.length) return 0;
        if (!adapter || !VantageScoring || !VantageScoring.scorePaths || !parent.simState) return 0;

        var collected = collectStaleForLayer(tree, adapter, parent);
        var stale = collected.stale;
        var ops = collected.ops;
        if (!stale.length) return 0;

        var rustLayer = tryRustRescoreLayer(tree, adapter, stale);
        var results = null;
        if (rustLayer) {
            results = rustLayer.results;
        } else {
            try {
                results = VantageScoring.scorePaths(
                    adapter,
                    parent.simState,
                    ops,
                    EVAL_FRAMES,
                    tree.threats || [],
                    treeScoringCfg(tree)
                );
            } catch (eLayer) {
                results = null;
            }
        }
        var updated = applyLayerResults(tree, adapter, parent, stale, results);
        if (rustLayer) {
            recordStructure(tree, 'rust-rescore-layer',
                'stale=' + stale.length + ' updated=' + updated);
        }
        return updated;
    }

    /**
     * v72：把 v68 全树所有受影响父层合并成一次（或少数几次）
     * vt_rescore_nodes 调用。
     */
    function tryRustRescoreBatch(tree, adapter, parents) {
        if (!tree || !adapter || typeof adapter.rescoreTankSamples !== 'function') return null;
        if (tree.cfg && tree.cfg.springRopeEnabled === true) return null;
        if (!parents || !parents.length) return { used: true, updated: 0 };

        var incAllNodes = [], fullAllNodes = [];
        var incJobs = [], fullJobs = [];
        var i, j, c;
        for (i = 0; i < parents.length; i++) {
            var parent = parents[i];
            if (!parent || parent.invalid || parent.exhausted) continue;
            var collected = collectStaleForLayer(tree, adapter, parent);
            if (!collected.stale.length) continue;
            var incStale = [], fullStale = [];
            for (j = 0; j < collected.stale.length; j++) {
                c = collected.stale[j];
                if (!validRescoreNode(c)) return null;
                var nodeInput = buildRescoreNodeInput(tree, adapter, c);
                if (nodeInput.previousScores !== undefined && nodeInput.previousScores !== null) {
                    incStale.push(c);
                    incAllNodes.push(nodeInput);
                } else {
                    fullStale.push(c);
                    fullAllNodes.push(nodeInput);
                }
            }
            if (incStale.length) {
                incJobs.push({ parent: parent, stale: incStale, offset: incAllNodes.length - incStale.length });
            }
            if (fullStale.length) {
                fullJobs.push({ parent: parent, stale: fullStale, offset: fullAllNodes.length - fullStale.length });
            }
        }
        if (!incJobs.length && !fullJobs.length) return { used: true, updated: 0 };

        var cfg = treeScoringCfg(tree);
        var threats = tree.threats || [];
        var CHUNK = 512;
        function runRescoreChunked(nodes) {
            var allResults = [];
            for (var start = 0; start < nodes.length; start += CHUNK) {
                var chunk = nodes.slice(start, start + CHUNK);
                var chunkResults;
                try {
                    chunkResults = adapter.rescoreTankSamples(
                        chunk,
                        threats,
                        cfg,
                        tree._pendingThreats || []
                    );
                } catch (eBatch) {
                    return null;
                }
                if (!chunkResults || chunkResults.length !== chunk.length) return null;
                allResults = allResults.concat(chunkResults);
            }
            if (allResults.length !== nodes.length) return null;
            return allResults;
        }

        var incResults = incAllNodes.length ? runRescoreChunked(incAllNodes) : [];
        if (incResults === null) return null;
        var fullResults = fullAllNodes.length ? runRescoreChunked(fullAllNodes) : [];
        if (fullResults === null) return null;

        var updated = 0;
        var job, jobResults, jj;
        for (i = 0; i < incJobs.length; i++) {
            job = incJobs[i];
            jobResults = incResults.slice(job.offset, job.offset + job.stale.length);
            for (jj = 0; jj < jobResults.length; jj++) {
                jobResults[jj].rustCandidate = true;
                jobResults[jj].rustIncremental = true;
            }
            updated += applyLayerResults(tree, adapter, job.parent, job.stale, jobResults);
        }
        for (i = 0; i < fullJobs.length; i++) {
            job = fullJobs[i];
            jobResults = fullResults.slice(job.offset, job.offset + job.stale.length);
            for (jj = 0; jj < jobResults.length; jj++) {
                jobResults[jj].rustCandidate = true;
                jobResults[jj].rustIncremental = false;
            }
            updated += applyLayerResults(tree, adapter, job.parent, job.stale, jobResults);
        }
        // v76：批量写回后强制按真实拓扑重数一次。任何多重摘除/计数漂移
        // 都在这里被当场纠正，绝不带着错误计数进入下一轮生长调度。
        recountActiveNodes(tree);
        recordStructure(tree, 'rust-rescore-batch',
            'parents=' + (incJobs.length + fullJobs.length) +
            ' nodes=' + (incAllNodes.length + fullAllNodes.length) +
            ' inc=' + incAllNodes.length + ' updated=' + updated);
        return { used: true, updated: updated };
    }

    /**
     * v77：用 JS 融合世界确认单节点死亡结论。
     * 只用于最终执行路线上的节点；通过临时适配器把 simulateTankBatch
     * 强制替换为 adapter.simulateTankBatchJsFused，确保绝不走 Rust 物理。
     * 返回 scorePaths 口径结果；JS 融合不可用时自动回退 scorePath（check）。
     */
    function confirmNodeDeathWithJsFused(tree, adapter, node) {
        if (!tree || !node || !node.inputs || !node.rolloutSamples || !node.rolloutSamples.length) return null;
        if (!adapter || typeof adapter.simulateTankBatchJsFused !== 'function') return null;
        if (!VantageScoring || !VantageScoring.scorePaths) return null;
        var frames = Math.min(EVAL_FRAMES, node.rolloutSamples.length - 1);
        if (frames < 1) return null;
        var startSample = node.rolloutSamples[0];
        var simState = {
            tank: { x: startSample.x, y: startSample.y, rot: startSample.rot },
            tGlobal: (typeof node.rolloutStartT === 'number') ? node.rolloutStartT : 0
        };
        var jsAdapter = Object.create(adapter);
        var fusedBatchOk = false;
        jsAdapter.simulateTankBatch = function(state, operations, durationFrames, opt) {
            var b = adapter.simulateTankBatchJsFused(state, operations, durationFrames, opt);
            if (b) fusedBatchOk = true;
            return b;
        };
        var results = VantageScoring.scorePaths(jsAdapter, simState,
            [{ name: node.opName || 'confirm', inputs: node.inputs }], frames,
            tree.threats || [], treeScoringCfg(tree));
        var r = results && results[0];
        if (!r) return null;
        r.deathAuthority = fusedBatchOk ? 'fused' : 'check';
        return r;
    }

    /**
     * v77：把 JS 融合世界确认结果写回节点。只有 deathAuthority 为
     * 'rust-candidate' 的节点才需要确认；确认后改标 'fused'（或回退
     * 'check'），并同步分数/死亡帧/回传父链。
     */
    function confirmExecutionNodeDeath(tree, adapter, node) {
        if (!tree || !node) return false;
        if (node.deathAuthority !== 'rust-candidate') return false;
        var r = confirmNodeDeathWithJsFused(tree, adapter, node);
        if (!r) {
            recordStructure(tree, 'js-death-confirm-fail',
                'n' + (node.id || '?') + ' authority=' + node.deathAuthority);
            return false;
        }
        var oldFd = node.fullDeathFrame;
        if (r.samples && r.samples.length) node.rolloutSamples = r.samples;
        applyRolloutScore(tree, node, r);
        tree.stats.jsConfirmCount = (tree.stats.jsConfirmCount || 0) + 1;
        if (node.fullDeathFrame > 0 && (oldFd <= 0 || node.fullDeathFrame < oldFd)) {
            tree.stats.jsConfirmEarlier = (tree.stats.jsConfirmEarlier || 0) + 1;
        } else if (oldFd > 0 && node.fullDeathFrame > oldFd) {
            tree.stats.jsConfirmLater = (tree.stats.jsConfirmLater || 0) + 1;
        } else if (oldFd > 0 && node.fullDeathFrame <= 0) {
            tree.stats.jsConfirmCleared = (tree.stats.jsConfirmCleared || 0) + 1;
        }
        node.deathAuthority = r.deathAuthority || 'fused';
        node.scoreCache = null;
        node.freshSig = nodeWindowSig(adapter, node, tree.threats || []);
        node.dataVersion++;
        if (node.parent) backpropBest(node.parent);
        recordStructure(tree, 'js-death-confirm',
            'n' + (node.id || '?') + ' fd ' + oldFd + '→' + node.fullDeathFrame +
            ' authority=' + node.deathAuthority);
        return true;
    }

    /**
     * v77：确认最终执行路线的死亡结论，并处理“Rust 候选 alive、JS 实为
     * 1 帧真死”的罕见翻转：只要父层还有其他非 1 帧死候选就重选一次。
     */
    function confirmExecutionRoutePick(tree, adapter, chosen, parent) {
        if (!chosen || !parent) return chosen;
        var guard = 0;
        while (chosen && guard < parent.children.length) {
            if (chosen.deathAuthority !== 'rust-candidate') break;
            confirmExecutionNodeDeath(tree, adapter, chosen);
            if (chosen.fullDeathFrame !== 1) break;
            var alt = pickBestChildByRolloutTotal(parent.children, chosen);
            if (!alt || alt.fullDeathFrame === 1) break;
            chosen = alt;
            guard++;
        }
        return chosen;
    }

    /** v68：当前提交层重评分。只做本层，不做惰性链。 */
    function refreshCandidateScores(tree, adapter) {
        if (!tree || !tree.commitNode || !tree.commitNode.children.length) return;
        if (!VantageScoring) return;
        var parent = tree.commitNode;
        var oldNext = parent.next;
        refreshFusedLayer(tree, adapter, parent);
        var newNext;
        if (tree.cfg.deepSelectEnabled) {
            recomputeSubtreeBestPostOrder(tree);
            newNext = pickBest(parent.children);
        } else {
            newNext = pickBestChildByRolloutTotal(parent.children);
        }
        // v77：Rust rescore 的死亡帧只是候选；被选中为 next 的节点在写入
        // 执行路线前，必须由 JS 融合世界确认死亡结论。
        newNext = confirmExecutionRoutePick(tree, adapter, newNext, parent);
        parent.next = newNext;
        if (oldNext !== newNext) {
            recordStructure(tree, 'next-retarget',
                (oldNext ? (oldNext.opName || ('n' + oldNext.id)) : '-') + ' → ' +
                (newNext ? (newNext.opName || ('n' + newNext.id)) : '-'));
        }
    }

    /** v52：后序一次性回传 subtreeBest（全树 reroute 用，避免逐节点 backpropBest）。 */
    function recomputeSubtreeBestPostOrder(tree) {
        if (!tree || !tree.root) return;
        (function rec(n) {
            if (!n) return;
            var i, best = -Infinity;
            for (i = 0; i < n.children.length; i++) {
                var c = n.children[i];
                if (!c || c.invalid || c.exhausted) continue;
                rec(c);
                if (c.subtreeBest > best) best = c.subtreeBest;
            }
            var ext = (best > -Infinity) ? best : 0;
            n.subtreeBest = n.segmentScore + Math.max(ext, n.baseExt || 0);
        })(tree.root);
    }

    /**
     * v52 全局重选（v54 已退役，仅诊断/对照使用；tick 不再调用）。
     * 新弹可能让任意深度的旧 rollout 更早死亡或重排，因此：
     *   ① 对全部活动节点用既有 rolloutSamples 按新 threats 重评分；
     *   ② 逐层重算所有 next（只比较每个父节点自己的候选 75 帧总分）；
     *   ③ 一次后序回传 subtreeBest。
     * 返回 {rescored, nextChanged} 供诊断/测试。
     */
    /**
     * v68 全树融合重选（恢复 v52 语义，但精确死亡来自融合世界）。
     * 新弹出现后全树旧 rollout 统一按当前威胁重评分；不使用惰性链。
     */
    function rerouteTreeForCurrentThreats(tree, adapter) {
        if (!tree || !tree.root || !adapter ||
            !VantageScoring || !VantageScoring.scorePaths) {
            return { rescored: 0, nextChanged: 0 };
        }

        // 先序收集活动父层；applyRolloutScore 若缩短某候选，会自动摘除其后代。
        var parents = [];
        (function collect(n) {
            if (!n || n.invalid || n.exhausted) return;
            if (n.children && n.children.length) parents.push(n);
            for (var i = 0; i < n.children.length; i++) collect(n.children[i]);
        })(tree.root);

        var rescored = 0, i, p;
        var rustBatch = tryRustRescoreBatch(tree, adapter, parents);
        if (rustBatch && rustBatch.used) {
            rescored = rustBatch.updated;
        } else {
            for (i = 0; i < parents.length; i++) {
                p = parents[i];
                if (!p || p.invalid || p.exhausted) continue;
                rescored += refreshFusedLayer(tree, adapter, p);
            }
        }

        // 重新收集活动父层，统一重选 next。
        var activeParents = [];
        (function recollect(n) {
            if (!n || n.invalid || n.exhausted) return;
            if (n.children && n.children.length) activeParents.push(n);
            for (var ci = 0; ci < n.children.length; ci++) recollect(n.children[ci]);
        })(tree.root);

        // v81：深层选路开启时先做后序回传，再按 subtreeBest 选 next。
        if (tree.cfg.deepSelectEnabled) recomputeSubtreeBestPostOrder(tree);

        var nextChanged = 0;
        for (i = 0; i < activeParents.length; i++) {
            p = activeParents[i];
            var oldNext = p.next;
            var newNext = tree.cfg.deepSelectEnabled
                ? pickBest(p.children)
                : pickBestChildByRolloutTotal(p.children);
            p.next = newNext;
            if (oldNext !== newNext) nextChanged++;
        }

        recomputeSubtreeBestPostOrder(tree);
        recountActiveNodes(tree);
        recordStructure(tree, 'global-reroute',
            'rescored=' + rescored + ' nextChanged=' + nextChanged);
        return { rescored: rescored, nextChanged: nextChanged };
    }

    /**
     * v33：新弹强制提前提交时，当前段是半途结束的，旧 rolloutSamples 从
     * 预测段末出发，和真实位姿对不上。这里把被选中节点重新从真实位姿
     * 模拟一次（只 sim 坦克，不重建树），让地图轨迹/节点虚影与实际一致。
     */
    function rebaseNodeFromReal(tree, adapter, node, realTankState, tGlobal) {
        if (!node || !VantageScoring || !VantageScoring.scorePath) return;
        var r = VantageScoring.scorePath(
            adapter,
            { tank: { x: realTankState.x, y: realTankState.y, rot: realTankState.rot }, tGlobal: tGlobal },
            node.inputs,
            EVAL_FRAMES,
            tree.threats || [],
            treeScoringCfg(tree)
        );
        if (!r || !r.samples || !r.samples.length) return;
        var segF = Math.max(1, node.segmentFrames || 0);
        var endIdx = (r.dead && r.deathFrame >= 0 && r.deathFrame <= segF)
            ? r.deathFrame : Math.min(segF, r.samples.length - 1);
        var endS = r.samples[endIdx];
        node.rolloutSamples = r.samples;
        node.rolloutStartT = tGlobal;
        node.simState = {
            tank: { x: endS.x, y: endS.y, rot: endS.rot },
            tGlobal: tGlobal + endIdx * FRAME_DT
        };
        node.tEndSec = tree.rootAbsT + node.simState.tGlobal;
        // v47：先更新节点自身数值，再按不变量重算 subtreeBest，不直接覆盖。
        applyRolloutScore(tree, node, r);
    }

    /** v33/v34：强制提前提交后，只重摆前几段（默认3段）。
     *  深链后续会在自然段末提交时逐步重摆，避免每颗新弹都重算整条链。 */
    function rebaseCommitPath(tree, adapter, maxDepth) {
        var path = commitPathOf(tree.root, tree.commitNode);
        if (!path || path.length < 2) return;
        maxDepth = Math.max(1, maxDepth || 3);
        var parentState = tree.root.simState;
        for (var i = 1; i < path.length && i <= maxDepth; i++) {
            var n = path[i];
            if (!n || !n.inputs) continue;
            rebaseNodeFromReal(tree, adapter, n, parentState.tank, parentState.tGlobal);
            parentState = n.simState;
        }
    }

    /** subtreeBest 回传（v4 max 口径）：p = 段分 + max(最优子链, 恒定基线)——
     *  金线延伸只增强不减弱（组合解劣于恒定时保持恒定评估），防链分偏置 */
    function backpropBest(p) {
        while (p) {
            var best = -Infinity;
            for (var i = 0; i < p.children.length; i++) {
                var c = p.children[i];
                if (c.exhausted || c.invalid) continue;   // 真死回退/结构失效的分支不参与回传
                if (c.subtreeBest > best) best = c.subtreeBest;
            }
            var ext = (best > -Infinity) ? best : 0;
            var next = p.segmentScore + Math.max(ext, p.baseExt || 0);
            if (p.subtreeBest === next) break;
            p.subtreeBest = next;
            p = p.parent;
        }
    }

    // ============================================================
    // v47：reserve/reuse —— 换道保留未选中路线
    // ============================================================

    function countSubtreeNodes(n) {
        if (!n) return 0;
        var c = 1;
        for (var i = 0; i < n.children.length; i++) c += countSubtreeNodes(n.children[i]);
        return c;
    }

    function cloneSimState(ss) {
        if (!ss) return null;
        return {
            tank: ss.tank ? { x: ss.tank.x, y: ss.tank.y, rot: ss.tank.rot } : null,
            tGlobal: ss.tGlobal
        };
    }

    function angleDiff(a) {
        return Math.atan2(Math.sin(a), Math.cos(a));
    }

    /** 父状态一致性：位置/朝向/相对时间都足够接近才可复用。 */
    function simStateClose(a, b) {
        if (!a || !b || !a.tank || !b.tank) return false;
        if (typeof a.tGlobal === 'number' && typeof b.tGlobal === 'number') {
            if (Math.abs(a.tGlobal - b.tGlobal) > 0.001) return false;
        }
        var dx = a.tank.x - b.tank.x;
        var dy = a.tank.y - b.tank.y;
        if (Math.sqrt(dx * dx + dy * dy) > 0.02) return false;
        if (Math.abs(angleDiff(a.tank.rot - b.tank.rot)) > 0.02) return false;
        return true;
    }

    /** 从活动树拆下整棵子树，转入 reserve（节点对象与 rollout 结果全部保留）。 */
    function detachChildIntoReserve(tree, child) {
        var parent = child.parent;
        if (!parent) return false;
        var ci = parent.children.indexOf(child);
        if (ci >= 0) parent.children.splice(ci, 1);
        child.parent = null;
        child.parentId = null;
        child._reserveParentSimState = cloneSimState(parent.simState);
        child._reserveParentId = parent.id;
        child._reserveThreatSig = threatSignature(tree.threats || []);
        child._reserveRetiredAt = _timeAcc;
        child._reserveRootAbsT = tree.rootAbsT;   // v47：detach 时的根时间锚

        var size = countSubtreeNodes(child);
        tree.nodeCount -= size;
        tree.reserveCount += size;
        tree.reserve.push(child);
        enforceReserveCap(tree);
        (function dropLeaves(n) {
            var li = tree.leaves.indexOf(n);
            if (li >= 0) tree.leaves.splice(li, 1);
            for (var j = 0; j < n.children.length; j++) dropLeaves(n.children[j]);
        })(child);
        backpropBest(parent);
        pushEvent('retire', 'n' + (child.id || '?') + '→reserve');
        return true;
    }

    /** reserve 上限：与 maxNodes 对齐，防止“保留”变成无限增长。 */
    function enforceReserveCap(tree) {
        var cap = (tree.cfg && tree.cfg.maxNodes) ? tree.cfg.maxNodes : 500;
        if (tree.reserveCount <= cap) return 0;
        var list = tree.reserve.slice();
        list.sort(function(a, b) {
            return ((a && a._reserveRetiredAt) || 0) - ((b && b._reserveRetiredAt) || 0);
        });
        var pruned = 0;
        for (var i = 0; i < list.length && tree.reserveCount > cap; i++) {
            var node = list[i];
            if (!node || tree.reserve.indexOf(node) < 0) continue;
            pushEvent('retire', 'reserve超限 n' + (node.id || '?'));
            discardReserveSubtree(tree, node);
            pruned++;
        }
        return pruned;
    }

    /** 永久丢弃 reserve 子树（过期/结构失效）。 */
    function discardReserveSubtree(tree, node) {
        if (!node) return false;
        var size = countSubtreeNodes(node);
        (function drop(n) {
            for (var j = 0; j < n.children.length; j++) drop(n.children[j]);
            n.children = [];
            n.parent = null;
            n.parentId = null;
        })(node);
        var idx = tree.reserve.indexOf(node);
        if (idx >= 0) tree.reserve.splice(idx, 1);
        tree.reserveCount -= size;
        return true;
    }

    /** 结构失效：标记 invalid 并删除未来子树。 */
    function markReserveInvalid(tree, node) {
        if (!node) return;
        node.invalid = true;
        pushEvent('invalid', 'n' + (node.id || '?') + ' 结构失效');
        discardReserveSubtree(tree, node);
    }

    /** v47：对 reserve 子树做时间轴平移（等价 shiftSubtreeTime 的 reserve 版）。 */
    function shiftReserveSubtreeTime(node, shift, rootAbsT) {
        if (!node) return 0;
        var count = 0;
        (function rec(n) {
            if (n.simState && typeof n.simState.tGlobal === 'number') {
                n.simState.tGlobal += shift;
            }
            if (typeof n.rolloutStartT === 'number') {
                n.rolloutStartT += shift;
            }
            if (n.simState && typeof n.simState.tGlobal === 'number') {
                n.tEndSec = rootAbsT + n.simState.tGlobal;
            }
            count++;
            for (var j = 0; j < n.children.length; j++) rec(n.children[j]);
        })(node);
        return count;
    }

    function reactivateReserveNode(tree, parent, node) {
        var idx = tree.reserve.indexOf(node);
        if (idx >= 0) tree.reserve.splice(idx, 1);
        var size = countSubtreeNodes(node);
        node.parent = parent;
        node.parentId = parent.id;
        parent.children.push(node);
        tree.nodeCount += size;
        tree.reserveCount -= size;
        tree.reuseCount++;
        (function rec(n, dep) {
            n.depth = dep;
            if (!n.children.length) {
                if (n.status !== 'dead') tree.leaves.push(n);
            } else {
                for (var j = 0; j < n.children.length; j++) rec(n.children[j], dep + 1);
            }
        })(node, parent.depth + 1);
        var pi = tree.leaves.indexOf(parent);
        if (pi >= 0) tree.leaves.splice(pi, 1);
        delete node._reserveParentSimState;
        delete node._reserveParentId;
        delete node._reserveThreatSig;
        delete node._reserveRetiredAt;
        delete node._reserveRootAbsT;
        pushEvent('reuse', 'n' + (node.id || '?') + ' reactivated');
        backpropBest(parent);
        return true;
    }

    /**
     * 把与 parent 当前 simState 且威胁签名一致的 reserve 节点重新挂回活动树。
     * 三个条件：父状态一致 / 威胁锚签名一致 / 节点 simState 没有穿墙。
     */
    function reactivateMatchingReserves(tree, adapter, parent, threats) {
        if (!tree || !parent || !tree.reserve || !tree.reserve.length) return 0;
        var sig = threatSignature(threats || []);
        // 当前父节点已有同操作 active 子节点时，reserve 里同操作旧节点是
        // 被取代的重复候选，直接退役，避免根层出现重复操作候选。
        var activeOps = {};
        for (var ai = 0; ai < parent.children.length; ai++) {
            var ac = parent.children[ai];
            if (!ac || ac.exhausted || ac.invalid) continue;
            var aOp = operationIndexOf(ac.inputs);
            if (aOp >= 0) activeOps[aOp] = true;
        }
        var n = 0;
        for (var i = tree.reserve.length - 1; i >= 0; i--) {
            var node = tree.reserve[i];
            if (!node || !node._reserveParentSimState) continue;
            if (!simStateClose(node._reserveParentSimState, parent.simState)) continue;
            if ((node._reserveThreatSig || '') !== sig) continue;
            // v47：锚点时间差必须在可复用范围内，否则该 reserve 已过期。
            var anchorDelta = tree.rootAbsT -
                ((typeof node._reserveRootAbsT === 'number') ? node._reserveRootAbsT : tree.rootAbsT);
            if (Math.abs(anchorDelta) > MAX_RESERVE_ANCHOR_DELTA) {
                pushEvent('retire', 'reserve锚差过期 n' + (node.id || '?'));
                discardReserveSubtree(tree, node);
                continue;
            }
            if (adapter && adapter.checkWall && parent.simState && node.simState &&
                parent.simState.tank && node.simState.tank) {
                if (adapter.checkWall(parent.simState.tank, node.simState.tank)) {
                    markReserveInvalid(tree, node);
                    continue;
                }
            }
            var opIdx = operationIndexOf(node.inputs);
            if (opIdx >= 0 && activeOps[opIdx]) {
                // 同操作已有更新的 active 子节点：reserve 旧节点继续保留，
                // 等未来该操作缺失时再复用，不删除也不重复挂载。
                continue;
            }
            // 确定要复用后才做时间平移：相对父节点的时间偏移保持不变，
            // tEndSec 用新 rootAbsT 重算。
            var reserveShift = 0;
            if (parent.simState && node._reserveParentSimState &&
                typeof parent.simState.tGlobal === 'number' &&
                typeof node._reserveParentSimState.tGlobal === 'number') {
                reserveShift = parent.simState.tGlobal - node._reserveParentSimState.tGlobal;
            }
            shiftReserveSubtreeTime(node, reserveShift, tree.rootAbsT);
            reactivateReserveNode(tree, parent, node);
            if (opIdx >= 0) activeOps[opIdx] = true;
            n++;
        }
        return n;
    }

    /** 清理父状态不再与任何活动节点一致的过期 reserve（防止无限增长）。 */
    function pruneExpiredReserves(tree) {
        if (!tree || !tree.reserve || !tree.reserve.length) return 0;
        var activeStates = [];
        (function collect(n) {
            if (n.simState) activeStates.push(n.simState);
            for (var j = 0; j < n.children.length; j++) collect(n.children[j]);
        })(tree.root);
        var pruned = 0;
        for (var i = tree.reserve.length - 1; i >= 0; i--) {
            var node = tree.reserve[i];
            if (!node || !node._reserveParentSimState) {
                discardReserveSubtree(tree, node);
                pruned++;
                continue;
            }
            var anchorDelta = tree.rootAbsT -
                ((typeof node._reserveRootAbsT === 'number') ? node._reserveRootAbsT : tree.rootAbsT);
            if (Math.abs(anchorDelta) > MAX_RESERVE_ANCHOR_DELTA) {
                pushEvent('retire', 'reserve锚差过期 n' + (node.id || '?'));
                discardReserveSubtree(tree, node);
                pruned++;
                continue;
            }
            var match = false;
            for (var a = 0; a < activeStates.length; a++) {
                if (simStateClose(node._reserveParentSimState, activeStates[a])) { match = true; break; }
            }
            if (!match) {
                pushEvent('retire', 'reserve过期 n' + (node.id || '?'));
                markReserveInvalid(tree, node);
                pruned++;
            }
        }
        pruned += enforceReserveCap(tree);
        return pruned;
    }

    function attachChild(tree, parent, child) {
        child.id = (typeof tree.nextNodeId === 'number') ? tree.nextNodeId++ : tree.nodeCount;
        tree.nodeCount++;   // 计数仍随挂节点 +1；nextNodeId 只保证 id 永不复用
        child.parent = parent;
        child.parentId = parent.id;
        parent.children.push(child);
        var pi = tree.leaves.indexOf(parent);
        if (pi >= 0) tree.leaves.splice(pi, 1);
        if (!isTerminalDead(child)) tree.leaves.push(child);
        backpropBest(parent);
        return child;
    }

    function detachChild(tree, child) {
        var parent = child.parent;
        if (!parent) return;
        var ci = parent.children.indexOf(child);
        if (ci < 0) {
            // v76：parent 链已经断开/不一致时只清理，绝不递减 nodeCount。
            child.parent = null;
            child.parentId = null;
            return;
        }
        parent.children.splice(ci, 1);
        child.parent = null;
        child.parentId = null;
        // 递减子树计数 + 清 leaves；同时断开整个被摘除子树的 parent 链，
        // 让后续重复 detach/invalidate 变成无副作用操作（幂等）。
        (function drop(n) {
            tree.nodeCount--;
            n.parent = null;
            n.parentId = null;
            var li = tree.leaves.indexOf(n);
            if (li >= 0) tree.leaves.splice(li, 1);
            for (var j = 0; j < n.children.length; j++) drop(n.children[j]);
        })(child);
        backpropBest(parent);
    }

    /** v76：节点是否仍挂在当前活动树上（排除 invalid/已摘除）。 */
    function isActiveTreeNode(tree, n) {
        if (!tree || !n || n.invalid) return false;
        if (n === tree.root) return true;
        var p = n.parent;
        var guard = 0;
        var seen = {};
        while (p) {
            if (p === tree.root) return true;
            if (seen[p.id] || ++guard > 200) return false;
            seen[p.id] = true;
            p = p.parent;
        }
        return false;
    }

    /** v76：沿真实拓扑重数活动节点并修复 leaves/计数。返回是否发生修复。 */
    function recountActiveNodes(tree) {
        if (!tree || !tree.root) return false;
        var count = 0;
        var leaves = [];
        (function rec(n, depth) {
            if (!n) return;
            count++;
            n.depth = depth;
            if (!n.children.length) {
                if (!isTerminalDead(n)) leaves.push(n);
            } else {
                for (var j = 0; j < n.children.length; j++) rec(n.children[j], depth + 1);
            }
        })(tree.root, 0);
        var changed = tree.nodeCount !== count || tree.leaves.length !== leaves.length;
        if (changed) {
            tree.stats.nodeCountFixes = (tree.stats.nodeCountFixes || 0) + 1;
            recordStructure(tree, 'node-count-audit',
                'count=' + count + ' leaves=' + leaves.length +
                ' oldCount=' + tree.nodeCount + ' oldLeaves=' + tree.leaves.length);
        }
        tree.nodeCount = count;
        tree.leaves = leaves;
        return changed;
    }

    /** v76：负数计数保护——防止负数绕过 maxNodes 上限继续生长。 */
    function ensureNonNegativeNodeCount(tree) {
        if (tree && tree.root && tree.nodeCount < 0) {
            return recountActiveNodes(tree);
        }
        return false;
    }

    /** v89：无子弹预热阶段是否已经到上限。
     *  这是独立于“节点限”开关的硬上限：即使关了节点上限，
     *  没有子弹时也不能无限预热；有子弹后该上限自动解除。 */
    function warmupCapReached(tree, count) {
        if (!tree || !tree.cfg) return false;
        if (tree.cfg.growWithoutThreats !== true) return false;
        // v96：预热上限只在“真实世界确实没有子弹”时生效。
        // 不能只看 tree.threats——它只是树当前锚定的威胁，可能暂时为空。
        var liveCount = (typeof tree._liveProjectileCount === 'number')
            ? tree._liveProjectileCount
            : null;
        var hasProjectiles = (liveCount !== null)
            ? (liveCount > 0)
            : !!(tree.threats && tree.threats.length);
        if (hasProjectiles) return false;
        var cap = Math.max(100, Math.min(3000,
            Math.floor(tree.cfg.warmupMaxNodes || 500)));
        return tree.nodeCount + (count || 0) > cap;
    }

    /** v86：统一的节点数上限判断。
     *  v89：无弹预热上限优先于“节点限关闭/超限细化”，防止无限预热。
     *  有子弹时，关闭节点上限或开启超限细化仍允许继续加节点。 */
    function canAddTreeNodes(tree, count) {
        if (!tree || !tree.cfg) return false;
        if (warmupCapReached(tree, count)) return false;
        if (tree.cfg.nodeCapEnabled === false) return true;
        if (tree.cfg.refineBeyondLimits === true) return true;
        return tree.nodeCount + count <= tree.cfg.maxNodes;
    }

    /** v30：每次 commit 后记录节点数曲线（正常坍缩下应为锯齿上行）。 */
    function recordShape(tree, label) {
        var maxDepth = 0;
        (function rec(n, depth) {
            if (!n) return;
            if (depth > maxDepth) maxDepth = depth;
            for (var i = 0; i < n.children.length; i++) rec(n.children[i], depth + 1);
        })(tree.root, 0);
        var hist = tree.diag.shapeHistory || (tree.diag.shapeHistory = []);
        hist.push({
            t: _timeAcc,
            label: label,
            nodeCount: tree.nodeCount,
            activeDepth: maxDepth
        });
        if (hist.length > 300) hist.shift();
    }

    // ============================================================
    // 二、probeSegment 段长探测（03 一.2 节，纯后处理零物理）
    // ============================================================

    function probeSegment(results, cfg) {
        cfg = mergeCfg(cfg);
        var evaluatedFrames = 0;
        var i, k;
        for (i = 0; i < results.length; i++) {
            var len = results[i] && results[i].perFrameScores
                ? results[i].perFrameScores.length : 0;
            if (len > evaluatedFrames) evaluatedFrames = len;
        }
        if (evaluatedFrames <= 0) {
            return { segmentFrames: cfg.tMax, tDiv: -1, tDivFound: false,
                spreadCurve: [], spreadPeak: 0, evaluatedFrames: 0, cum: null,
                epsilon: cfg.epsilon, tMin: cfg.tMin, tMax: cfg.tMax };
        }
        var cum = [];
        for (i = 0; i < results.length; i++) {
            var pfs = (results[i] && results[i].perFrameScores) || [];
            var row = new Array(evaluatedFrames + 1);
            row[0] = 0;
            for (k = 1; k <= evaluatedFrames; k++) {
                row[k] = row[k - 1] + (k <= pfs.length ? pfs[k - 1] : 0);
            }
            cum.push(row);
        }
        var spreadCurve = new Array(evaluatedFrames + 1);
        spreadCurve[0] = 0;
        var tDiv = -1, tDivFound = false, spreadPeak = 0;
        for (k = 1; k <= evaluatedFrames; k++) {
            var mx = -Infinity, mn = Infinity;
            for (i = 0; i < cum.length; i++) {
                if (cum[i][k] > mx) mx = cum[i][k];
                if (cum[i][k] < mn) mn = cum[i][k];
            }
            var sp = mx - mn;
            spreadCurve[k] = sp;
            if (sp > spreadPeak) spreadPeak = sp;
            if (!tDivFound && sp > cfg.epsilon) { tDiv = k; tDivFound = true; }
        }
        var segSrc = tDivFound ? tDiv : evaluatedFrames;
        var segmentFrames = Math.max(cfg.tMin, Math.min(cfg.tMax, segSrc));
        return {
            segmentFrames: segmentFrames,
            tDiv: tDiv,
            tDivFound: tDivFound,
            spreadCurve: spreadCurve,
            spreadPeak: spreadPeak,
            evaluatedFrames: evaluatedFrames,
            cum: cum,                    // 各操作前缀和（子节点段分 = cum[i][segmentFrames]）
            epsilon: cfg.epsilon,
            tMin: cfg.tMin,
            tMax: cfg.tMax
        };
    }

    // ============================================================
    // 三、展开 = 探测（一次 9×scorePath 两用）
    // ============================================================

    /** 9 操作 rollout（软死口径，deathPenalty=0）。
     *  v78：优先走 Rust vt_score_paths（adapter.simulateTankBatchScored）；
     *  任何失败/lane>0/弹簧绳/样本数不匹配都静默回退 JS scorePaths。
     *  融合世界关闭/不可用时 scorePaths 内部回退旧路径。 */
    function rolloutNine(tree, adapter, simState, threats) {
        var ops = VantageSandbox.OPERATIONS;
        var cfg = treeScoringCfg(tree);
        if (adapter && typeof adapter.simulateTankBatchScored === 'function') {
            try {
                var rustScored = adapter.simulateTankBatchScored(simState.tank, ops,
                    EVAL_FRAMES, {
                        startPose: simState.tank,
                        threats: threats,
                        tGlobal: simState.tGlobal,
                        cfg: cfg
                    });
                if (rustScored && rustScored.length === ops.length) {
                    tree.stats.rustScoredBatches = (tree.stats.rustScoredBatches || 0) + 1;
                    var okAll = true;
                    for (var ri = 0; ri < rustScored.length; ri++) {
                        if (!rustScored[ri] || !rustScored[ri].perFrameScores ||
                                !rustScored[ri].samples) {
                            okAll = false;
                            break;
                        }
                        rustScored[ri].opIndex = ri;
                        rustScored[ri].opName = ops[ri].name;
                        // Rust 死亡帧只作候选；最终执行路线仍由 JS 融合世界确认。
                        rustScored[ri].deathAuthority = 'rust-candidate';
                    }
                    if (okAll) {
                        return rustScored;
                    }
                }
                tree.stats.rustScoredFallbacks = (tree.stats.rustScoredFallbacks || 0) + 1;
            } catch (eRustScored) {
                // 静默回退 JS scorePaths。
                tree.stats.rustScoredFallbacks = (tree.stats.rustScoredFallbacks || 0) + 1;
            }
        }
        if (VantageScoring.scorePaths) {
            return VantageScoring.scorePaths(adapter, simState, ops,
                EVAL_FRAMES, threats, cfg);
        }
        var results = [];
        for (var i = 0; i < ops.length; i++) {
            results.push(VantageScoring.scorePath(adapter, simState,
                ops[i].inputs, EVAL_FRAMES, threats, cfg));
        }
        return results;
    }

    /** 由单个 rollout 结果装配子节点（v4：候选初值=totalScore 恒定基线口径） */
    function buildCandidate(tree, parent, opIdx, r, probe, threats) {
        var ops = VantageSandbox.OPERATIONS;
        var segF = probe.segmentFrames;
        var childDead = r.dead && r.deathFrame >= 0 && r.deathFrame <= segF;
        var plannedEnd = segF;
        var actualEnd = r.dead ? safeFramesForDeath(tree, r.deathFrame, segF) : plannedEnd;
        var endIdx = actualEnd;
        var s = r.samples && r.samples[endIdx];
        if (!s) s = r.samples ? r.samples[r.samples.length - 1] : parent.simState.tank;
        var childState = {
            tank: { x: s.x, y: s.y, rot: s.rot },
            tGlobal: parent.simState.tGlobal + endIdx * FRAME_DT
        };
        var child = createTreeNode(parent, ops[opIdx].inputs, childState);
        child.plannedFrames = segF;   // v49：计划帧数永远等于探段结果，死亡不缩短
        // v51：实际执行帧数 —— v78 统一 safeFramesForDeath 口径。
        var actualFrames = r.dead ? safeFramesForDeath(tree, r.deathFrame, segF) : segF;
        child.segmentFrames = actualFrames;
        child.segmentScore = probe.cum
            ? probe.cum[opIdx][Math.min(actualFrames, probe.cum[opIdx].length - 1)]
            : r.totalScore;
        child.baseExt = (r.totalScore || 0) - child.segmentScore;   // 恒定延伸基线
        child.rolloutTotal = (r.totalScore || 0);                 // v52：75帧全累积总分
        child.perFrameScores = r.perFrameScores ? r.perFrameScores.slice() : null; // v75
        child.deathAuthority = r.deathAuthority ||
            (r.rustPhysics ? 'rust-candidate' : 'fused');   // v78：Rust物理只作候选，JS融合为权威
        child.subtreeBest = child.segmentScore + Math.max(0, child.baseExt);  // = totalScore
        child.status = childDead ? 'dead' : 'alive';
        child.fullDead = !!r.dead;                    // 完整75帧是否死亡
        child.fullDeathFrame = r.dead ? r.deathFrame : -1;
        // 绝对结束时间 = 根真实时刻 + 相对威胁折线的未来偏移。
        // 绝对时间只用于段末调度/树图 X 轴；simState.tGlobal 保持相对值供弹道采样。
        child.tEndSec = tree.rootAbsT + childState.tGlobal;
        child.opName = ops[opIdx].name;
        child.threats = threats || null;             // 节点预览/虚影渲染用
        child.rolloutStartT = parent.simState.tGlobal; // rollout 第0帧对应的弹道相对时间
        child.rolloutFrames = child.segmentFrames;   // 提交后执行帧数
        child.rolloutSamples = r.samples;
        child.rolloutDeathFrame = r.deathFrame;      // 完整75帧内的死亡帧（-1=活满）
        return child;
    }

    /**
     * v43：展开/探段用的有效配置。tMin 按“上一真实帧长”换算，
     * 保证低帧率下每段仍有 minGrowTicks 个真实帧可以生长。
     */
    function effectiveExpandCfg(tree) {
        var cfg = {};
        var k;
        for (k in tree.cfg) cfg[k] = tree.cfg[k];
        var estDt = (_lastWorldDt > 0 && _lastWorldDt < 1) ? _lastWorldDt : FRAME_DT;
        var minFrames = Math.ceil(((tree.cfg.minGrowTicks || 3) * estDt) / FRAME_DT);
        cfg.tMin = Math.max(cfg.tMin, Math.min(cfg.tMax, minFrames));
        return cfg;
    }

    /** v49：本段计划帧数（取不到 plannedFrames 的旧节点回退到实际帧数）。 */
    function plannedFramesOf(n) {
        return Math.max(1, n.plannedFrames || n.segmentFrames || 0);
    }

    /** v78/v80：统一“实际执行帧数”口径。
     *  fd<0 → 执行完整计划段；
     *  fd=1 → 只执行 1 帧（真死候选）；
     *  fd>=2 → 不超过“死亡帧的一半”，也绝不超过死亡帧前 1 帧。
     *  v80 起软死操作时长上限 = floor(fd × deathDurationRatio)，
     *  让 AI 更频繁换路，而不是按住一个操作直到接近死亡。 */
    function safeFramesForDeath(tree, fd, planned) {
        if (!(fd >= 0)) return planned;
        if (fd === 1) return 1;
        var ratio = (tree && tree.cfg && typeof tree.cfg.deathDurationRatio === 'number')
            ? tree.cfg.deathDurationRatio : 0.5;
        if (!(ratio > 0) || ratio >= 1) return Math.min(fd - 1, planned);
        return Math.min(fd - 1, Math.max(1, Math.floor(fd * ratio)), planned);
    }

    /** v52：节点自身 75 帧全累积总分；旧节点无字段时按 segmentScore+baseExt 还原。 */
    function fullRolloutTotalOf(n) {
        if (!n) return -Infinity;
        // v98：仅操作时长评分——只累计节点实际计划/执行段内的帧分，
        // 不再把同一个操作的 75 帧远视总分全部算进去。
        if (_scoreOnlyPlanned) {
            var limit = Math.max(1, plannedFramesOf(n));
            if (Array.isArray(n.perFrameScores) && n.perFrameScores.length) {
                var upto = Math.min(limit, n.perFrameScores.length);
                var sum = 0;
                for (var si = 0; si < upto; si++) sum += Number(n.perFrameScores[si]) || 0;
                return sum;
            }
            return (n.segmentScore || 0) + (n.baseExt || 0);
        }
        if (typeof n.rolloutTotal === 'number') return n.rolloutTotal;
        return (n.segmentScore || 0) + (n.baseExt || 0);
    }

    /** v81：路线评估用实际执行帧数还是计划帧数。深层选路开启时，
     *  v80 半死亡时长节点按实际执行帧评估，避免软死分支被低估。 */
    function effectiveFramesOf(n) {
        if (_deepSelectEnabled && n && n.segmentFrames > 0) return n.segmentFrames;
        return plannedFramesOf(n);
    }

    /** v49：本段平均分。 */
    function segmentAvgOf(n) {
        if (!n) return -Infinity;
        return (n.segmentScore || 0) / effectiveFramesOf(n);
    }

    /** v49：叶路径平均分 = 路径上（不含 root）所有节点累计得分之和 ÷ 有效帧数之和。 */
    function routeAvgOfLeaf(tree, leaf) {
        var sumScore = 0, sumFrames = 0;
        var n = leaf;
        while (n && n !== tree.root) {
            sumScore += (n.segmentScore || 0);
            sumFrames += effectiveFramesOf(n);
            n = n.parent;
        }
        return sumFrames > 0 ? sumScore / sumFrames : -Infinity;
    }

    /** v51：可选节点 = 非 invalid、非 exhausted；soft dead 仍可选。 */
    function isOptionalNode(n) {
        return !!n && !n.invalid && !n.exhausted;
    }

    /** v82：终局叶 = 1 帧真死。软死（fd>=2）不是终局：
     *  该节点仍可从安全执行末帧继续展开下一层。 */
    function isTerminalDead(n) {
        return !!n && n.fullDeathFrame >= 0 && n.fullDeathFrame <= 1;
    }

    // ============================================================
    // v54：惰性金线刷新 —— stale 判定 / 层更新 / 前沿查找 / 预算
    // ============================================================

    /** 节点 rollout 时间窗内应包含的威胁 id 排序签名。 */
    function nodeWindowSig(adapter, n, threats) {
        if (!n || !n.rolloutSamples || !n.rolloutSamples.length) return '';
        var maxK = Math.min(EVAL_FRAMES, n.rolloutSamples.length - 1);
        if (maxK < 1) return '';
        var startT = n.rolloutStartT || 0;
        var w0 = startT + FRAME_DT;
        var w1 = startT + maxK * FRAME_DT;
        var ids = [];
        var i, j, th, t0, t1, pathLen, dx, dy;
        for (i = 0; i < (threats ? threats.length : 0); i++) {
            th = threats[i];
            if (!th || th.id === undefined || th.id === null) continue;
            t0 = th.anchorOffset || 0;
            if (th.track && th.track.length) {
                t1 = t0 + th.track.length * FRAME_DT;
            } else if (th.path && th.speed > 0) {
                pathLen = 0;
                for (j = 0; j < th.path.length - 1; j++) {
                    dx = th.path[j + 1].x - th.path[j].x;
                    dy = th.path[j + 1].y - th.path[j].y;
                    pathLen += Math.sqrt(dx * dx + dy * dy);
                }
                t1 = t0 + pathLen / th.speed;
            } else {
                continue;
            }
            if (w0 <= t1 && t0 <= w1) ids.push(th.id);
        }
        ids.sort(function(a, b) {
            return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
        });
        return ids.join(',');
    }

    /** 节点是否 stale：没有缓存或缓存签名与当前威胁窗口签名不一致。 */
    function nodeIsStale(adapter, n, threats) {
        if (!n) return false;
        if (!n.scoreCache) {
            // v60：刚由融合世界算出的节点，威胁集合未变时视为 fresh，
            // 不得马上用静态 checkDeath 覆盖融合传感器/CCD 的死亡结论。
            var curSig = nodeWindowSig(adapter, n, threats);
            if ((n.deathAuthority === 'fused' || n.deathAuthority === 'rust-candidate') &&
                n.freshSig && n.freshSig === curSig) {
                return false;
            }
            return true;
        }
        return n.freshSig !== nodeWindowSig(adapter, n, threats);
    }

    /** v68：ensureLayerFresh 仅作为 refreshFusedLayer 的别名，供旧调用兼容。 */
    function ensureLayerFresh(tree, adapter, parent) {
        return refreshFusedLayer(tree, adapter, parent);
    }

    /** 沿 commitPath 找第一个含 stale 可选候选的父层；找不到返回 null。 */
    function findFirstStaleLayer(tree, adapter) {
        if (!tree || !tree.root) return null;
        var path = commitPathOf(tree.root, tree.commitNode);
        if (!path || path.length < 2) return null;
        var i, j, p, c;
        for (i = 0; i < path.length - 1; i++) {
            p = path[i];
            if (!p || !p.children) continue;
            for (j = 0; j < p.children.length; j++) {
                c = p.children[j];
                if (isOptionalNode(c) && nodeIsStale(adapter, c, tree.threats || [])) {
                    return p;
                }
            }
        }
        return null;
    }

    /** v54：惰性刷新预算。pathDepth<=5 刷1层，>5 刷3层；0/1 按1处理。 */
    function lazyUpdateBudgetForPathDepth(pathDepth) {
        if (pathDepth <= 1) return 1;
        return pathDepth <= 5 ? 1 : 3;
    }



    /** v55：金线外第一个含 stale 可选候选的父层；不在 commitPath 上，按时间深度浅/id 小优先。 */
    function findFirstOutsideStaleLayer(tree, adapter) {
        if (!tree || !tree.root) return null;
        var path = commitPathOf(tree.root, tree.commitNode);
        var pathIds = {};
        var i, j, n, c;
        for (i = 0; i < path.length; i++) pathIds[path[i].id] = true;
        var best = null;
        var bestTime = Infinity;
        var bestId = Infinity;
        (function dfs(node) {
            if (!node) return;
            if (node !== tree.root && !pathIds[node.id] &&
                node.children && node.children.length) {
                var hasStale = false;
                for (j = 0; j < node.children.length; j++) {
                    c = node.children[j];
                    if (isOptionalNode(c) && nodeIsStale(adapter, c, tree.threats || [])) {
                        hasStale = true;
                        break;
                    }
                }
                if (hasStale) {
                    var time = node.tEndSec - tree.root.tEndSec;
                    if (!best || time < bestTime ||
                        (time === bestTime && node.id < bestId)) {
                        best = node;
                        bestTime = time;
                        bestId = node.id;
                    }
                }
            }
            for (var ci = 0; ci < node.children.length; ci++) dfs(node.children[ci]);
        })(tree.root);
        return best;
    }

    /** v55：只读新鲜度校验。返回主线/金线外 stale 父层列表与 stale 节点总数。 */
    function verifyFreshness(tree, adapter) {
        var result = {
            pathStaleParents: [],
            outsideStaleParents: [],
            totalStaleNodes: 0
        };
        if (!tree || !tree.root) return result;
        var path = commitPathOf(tree.root, tree.commitNode);
        var pathIds = {};
        var i, j, p, c;
        for (i = 0; i < path.length; i++) pathIds[path[i].id] = true;

        function hasStaleChild(parent) {
            if (!parent || !parent.children) return false;
            for (var k = 0; k < parent.children.length; k++) {
                var ch = parent.children[k];
                if (isOptionalNode(ch) && nodeIsStale(adapter, ch, tree.threats || [])) return true;
            }
            return false;
        }

        for (i = 0; i < path.length - 1; i++) {
            p = path[i];
            if (hasStaleChild(p)) result.pathStaleParents.push(p.id);
        }

        (function rec(node) {
            if (!node) return;
            if (node.children && node.children.length) {
                var stale = false;
                for (j = 0; j < node.children.length; j++) {
                    c = node.children[j];
                    if (isOptionalNode(c) && nodeIsStale(adapter, c, tree.threats || [])) {
                        result.totalStaleNodes++;
                        stale = true;
                    }
                }
                if (stale && !pathIds[node.id]) result.outsideStaleParents.push(node.id);
            }
            for (var ci = 0; ci < node.children.length; ci++) rec(node.children[ci]);
        })(tree.root);

        return result;
    }

    /** v51：可选路线叶子 = 可选节点且没有孩子。 */
    function isOptionalLeaf(n) {
        return isOptionalNode(n) && n.children.length === 0;
    }

    /** v51：DFS 某子树，返回可选路线叶子里路线平均分最高者；允许 soft dead 叶子。 */
    function bestRouteLeafInSubtree(tree, n, adapter) {
        var bestLeaf = null, bestAvg = -Infinity;
        (function dfs(x) {
            if (!x || x.invalid || x.exhausted) return;
            if (x.children.length === 0) {
                var avg = routeAvgOfLeaf(tree, x);
                if (avg > bestAvg) { bestAvg = avg; bestLeaf = x; }
                return;
            }
            // v68：回退搜索不再在 DFS 内刷新层，避免结构性副作用。
            for (var i = 0; i < x.children.length; i++) dfs(x.children[i]);
        })(n);
        if (!bestLeaf) return null;
        return { leaf: bestLeaf, avg: bestAvg };
    }

    /**
     * v69：Rust 最小决策实验。使用 VantageRustBridge.minimalDecide 对
     * 当前最新 9 候选的 75 帧评分做选择；只决定 next，不改变候选节点。
     * WASM 未就绪/关闭/出错时返回 null，由 JS 既有选择继续工作。
     */
    function tryRustMinimalSelect(tree, newKids, results) {
        if (!tree || !tree.cfg || !tree.cfg.rustMinimalEnabled) return null;
        if (!newKids || !results || newKids.length !== results.length || !results.length) return null;
        if (typeof global === 'undefined' || !global.VantageRustBridge) return null;
        var bridge = global.VantageRustBridge;
        if (!bridge.isAvailable || !bridge.isAvailable()) return null;
        if (!bridge.minimalDecide || typeof bridge.minimalDecide !== 'function') return null;

        var ops = VantageSandbox.OPERATIONS || [];
        var candidates = [];
        var i, r;
        for (i = 0; i < results.length; i++) {
            r = results[i];
            if (!r) return null;
            candidates.push({
                opName: (ops[i] && ops[i].name) || ('op' + i),
                totalScore: (typeof r.totalScore === 'number') ? r.totalScore : 0,
                dead: !!r.dead,
                deathFrame: (typeof r.deathFrame === 'number') ? r.deathFrame : -1,
                perFrameScores: r.perFrameScores || []
            });
        }
        var decision = null;
        try {
            decision = bridge.minimalDecide(candidates, {
                epsilon: tree.cfg.epsilon,
                tMin: tree.cfg.tMin,
                tMax: tree.cfg.tMax
            });
        } catch (eRust) {
            if (global.console && console.warn) {
                console.warn('[VantageTree] Rust 最小决策失败，回退 JS:', eRust);
            }
            return null;
        }
        if (!decision || decision.ok !== true ||
            typeof decision.selectedIndex !== 'number') return null;
        var idx = decision.selectedIndex;
        if (idx < 0 || idx >= newKids.length) return null;
        return { kid: newKids[idx], decision: decision };
    }

    /**
     * 展开叶子（全建 9 候选）：根子层/建树第一层用——下段提交的比较集。
     * @returns {number} 新增节点数（0=失败/上限）
     */
    function attachResults(tree, leaf, results, threats) {
        if (!leaf || isTerminalDead(leaf) || leaf.children.length > 0) return 0;
        ensureNonNegativeNodeCount(tree);
        if (!canAddTreeNodes(tree, results.length)) return 0;
        var ecfg = effectiveExpandCfg(tree);
        tree.diag.lastEffTMin = ecfg.tMin;
        tree.diag.lastEffDt = _lastWorldDt;
        var probe = probeSegment(results, ecfg);
        var newKids = [];
        for (var i = 0; i < results.length; i++) {
            var kid = buildCandidate(tree, leaf, i, results[i], probe, threats);
            attachChild(tree, leaf, kid);
            // v54：新层由当前 threats 直接算出，天然 fresh；scoreCache 下一波再复用。
            kid.scoreCache = null;
            kid.freshSig = nodeWindowSig(null, kid, threats || []);
            kid.dataVersion = 0;
            newKids.push(kid);
        }
        // v69：开启 Rust 最小决策时，next 由 WASM 选择；
        // 否则继续 v52 JS 自然比较。Rust 失败自动回退。
        var rustPick = tryRustMinimalSelect(tree, newKids, results);
        if (rustPick) {
            leaf.next = rustPick.kid;
            recordStructure(tree, 'rust-minimal-select',
                'n' + (leaf.id || '?') + ' next→n' + (rustPick.kid.id || '?') +
                ' seg=' + (rustPick.decision.segmentFrames || 0));
        } else if (leaf && tree.cfg.deepSelectEnabled) {
            // v81：深层选路实验：next 按 subtreeBest（含后代路线）选。
            leaf.next = pickBest(newKids);
        } else {
            // v52：最新 9 个叶子按“75 帧全累积总分”自然比较选 next；
            // 不比较祖先历史累计，只看每个候选自己未来 75 帧的总分。
            leaf.next = pickBestChildByRolloutTotal(newKids);
        }
        leaf.probe = probe;   // 段长探测结果留档（渲染/调参）
        tree.stats.expands++;
        return results.length;
    }

    function expandLeaf(tree, leaf, adapter, threats) {
        if (!leaf || isTerminalDead(leaf) || leaf.children.length > 0) return 0;
        ensureNonNegativeNodeCount(tree);
        if (!canAddTreeNodes(tree, 9)) return 0;
        var results = rolloutNine(tree, adapter, leaf.simState, threats);
        return attachResults(tree, leaf, results, threats);
    }

    /** v92：点击目标评分只在“安全分完全相同”时作为平局裁决。
     *  只看节点末状态：位置越近、朝向越接近目标方向，分越高。 */
    function moveTargetScore(node) {
        if (!_moveTarget || !node || !node.simState || !node.simState.tank) return -Infinity;
        var tile = (typeof Constants !== 'undefined' && Constants.MAZE_TILE_SIZE && Constants.MAZE_TILE_SIZE.m)
            ? Constants.MAZE_TILE_SIZE.m : 10;
        var tx = (_moveTarget.x + 0.5) * tile;
        var ty = (_moveTarget.y + 0.5) * tile;
        var tk = node.simState.tank;
        var dx = tx - tk.x, dy = ty - tk.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var desiredRot = Math.atan2(dx, -dy);   // 游戏朝向：sin(rot), -cos(rot)
        var diff = tk.rot - desiredRot;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        var angleScore = 1 - Math.abs(diff) / Math.PI;   // 0~1，朝向越准越高
        var distScore = 1 / (1 + dist / tile);           // 0~1，越近越高
        // 先鼓励真的往目标靠近（距离权重更高），朝向作为次要因素，
        // 避免 AI 在远处只原地转向、不移动。
        return distScore * 0.7 + angleScore * 0.3;
    }

    /** v97：无子弹且没有点击目标时，所有安全分相同的候选里优先静止。 */
    function isStaticInputs(inputs) {
        return !inputs || (!inputs.forward && !inputs.back && !inputs.left && !inputs.right);
    }

    /** v100：构建静态地形杀戮场。迷宫换一次重建一次，节点只做 O(1) 查表。 */
    function ensureKillfield(maze) {
        if (!_killfieldEnabled || !maze || !maze.getWidth || !maze.getHeight) return;
        if (_killfieldGrid && _killfieldMazeRef === maze) return;
        var w = maze.getWidth(), h = maze.getHeight();
        var grid = new Array(w * h);
        var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        var maxDead = (typeof Constants !== 'undefined' && Constants.AI &&
            typeof Constants.AI.MAZE_MAX_DEAD_END_PENALTY === 'number')
            ? Constants.AI.MAZE_MAX_DEAD_END_PENALTY : 5;
        for (var i = 0; i < w; i++) {
            for (var j = 0; j < h; j++) {
                var tile = { x: i, y: j };
                if (!maze.isPositionInsideMaze(tile)) { grid[j * w + i] = 0; continue; }
                var open = 0;
                for (var d = 0; d < dirs.length; d++) {
                    var nb = { x: i + dirs[d][0], y: j + dirs[d][1] };
                    if (nb.x < 0 || nb.y < 0 || nb.x >= w || nb.y >= h) continue;
                    if (maze.isPositionInsideMaze(nb)) open++;
                }
                var dead = (maze.getDeadEndPenalty ? (maze.getDeadEndPenalty(tile) || 0) : 0);
                var deadScore = 1 - Math.min(1, dead / maxDead);
                var openScore = open / 4;
                var score = deadScore * 0.6 + openScore * 0.4;
                if (i === 0 || j === 0 || i === w - 1 || j === h - 1) score -= 0.15;
                if ((i === 0 || i === w - 1) && (j === 0 || j === h - 1)) score -= 0.1;
                grid[j * w + i] = Math.max(0, Math.min(1, score));
            }
        }
        _killfieldGrid = grid;
        _killfieldMazeRef = maze;
        _killfieldW = w;
        _killfieldH = h;
    }

    function killfieldScoreAtTank(tank) {
        if (!_killfieldGrid || !_killfieldMazeRef || !tank) return -Infinity;
        var tileSize = (typeof Constants !== 'undefined' && Constants.MAZE_TILE_SIZE && Constants.MAZE_TILE_SIZE.m)
            ? Constants.MAZE_TILE_SIZE.m : 10;
        var tx = Math.floor(tank.x / tileSize);
        var ty = Math.floor(tank.y / tileSize);
        if (tx < 0 || ty < 0 || tx >= _killfieldW || ty >= _killfieldH) return -Infinity;
        return _killfieldGrid[ty * _killfieldW + tx];
    }

    /** v100：统一目标分：
     *  用户指定目标时，目标优先，杀戮场不抢方向；
     *  没有用户目标且有子弹时，才用杀戮场引导去更安全的地形。 */
    function objectiveScore(node) {
        if (!node || !node.simState || !node.simState.tank) return -Infinity;
        if (_moveTarget) return moveTargetScore(node);
        if (!_killfieldEnabled || _liveProjectilesNow <= 0) return -Infinity;
        var kf = killfieldScoreAtTank(node.simState.tank);
        if (!isFinite(kf)) return -Infinity;
        return kf * _killfieldWeight;
    }

    /** v94：混合模式下，把目标分按系数放大到安全分同量级后直接加进总分。 */
    function targetMixBonus(node, scale) {
        if (!_targetMixEnabled) return 0;
        var fit = objectiveScore(node);
        if (!isFinite(fit) || fit < 0) return 0;
        return _targetMixRatio * scale * fit;
    }

    /** argmax 平局裁定：alive > dead；双 dead 取段长长者（活最久）。
     *  v8 撤除 v4.1 的"动优于静"——那轮"一直静止"的真凶后来证实是
     *  提交丢失 bug（ai_vantage v5 修复），动优于静属于误诊补丁：
     *  无威胁期 9 操作全 0 分时它恒选"前"→ 一直前进撞墙（主人实测
     *  "怎么默认前进"）。恢复自然 argmax：无信息=静止（与自动模式
     *  一致），有威胁评分分化后接管 */
    function pickBest(children) {
        var best = null;
        var i, c;
        // v48：除非所有 active 候选都是 1 帧内必死，否则跳过 fullDeathFrame===1 的立即真死候选。
        var onlyImmediateDead = true;
        var anyActive = false;
        for (i = 0; i < children.length; i++) {
            c = children[i];
            if (!c || c.exhausted || c.invalid) continue;
            anyActive = true;
            if (!(c.fullDeathFrame === 1)) { onlyImmediateDead = false; break; }
        }
        if (!anyActive) onlyImmediateDead = false;
        // v94：混合选路的安全底线——只要还有非 dead 候选，就不选 dead 候选去换目标。
        var anyNotDead = false;
        if (_targetMixEnabled) {
            for (i = 0; i < children.length; i++) {
                c = children[i];
                if (!c || c.exhausted || c.invalid) continue;
                if (c.status !== 'dead') { anyNotDead = true; break; }
            }
        }
        // v94：混合选路开启时，目标分按最大安全分缩放后直接加到每个候选上。
        var targetScale = 0;
        if (_targetMixEnabled && _moveTarget) {
            for (i = 0; i < children.length; i++) {
                c = children[i];
                if (!c || c.exhausted || c.invalid) continue;
                var absVal = Math.abs(c.subtreeBest || 0);
                if (absVal > targetScale) targetScale = absVal;
            }
            if (targetScale <= 0) targetScale = 1;
        }
        for (i = 0; i < children.length; i++) {
            c = children[i];
            if (!c || c.exhausted || c.invalid) continue;   // 真死回退/结构失效的分支不参与 argmax
            if (!onlyImmediateDead && c.fullDeathFrame === 1) continue;   // 有可苟候选时跳过立即真死
            if (_targetMixEnabled && anyNotDead && c.status === 'dead') continue; // 混合模式安全底线
            var cScore = c.subtreeBest + targetMixBonus(c, targetScale);
            var bScore = best ? (best.subtreeBest + targetMixBonus(best, targetScale)) : -Infinity;
            if (!best || cScore > bScore) { best = c; continue; }
            if (cScore === bScore) {
                var cDead = c.status === 'dead', bDead = best.status === 'dead';
                if (cDead !== bDead) {
                    if (!cDead) best = c;
                    continue;
                }
                if (cDead && c.segmentFrames > best.segmentFrames) {
                    best = c;
                    continue;
                }
                if (!cDead || c.segmentFrames === best.segmentFrames) {
                    // v97：无弹且无点击目标时，平局优先静止，避免根层反复选前进/转向。
                    if (_liveProjectilesNow === 0 && !_moveTarget) {
                        var cStatic = isStaticInputs(c.inputs), bStatic = isStaticInputs(best.inputs);
                        if (cStatic !== bStatic) {
                            if (cStatic) best = c;
                            continue;
                        }
                    }
                    var ctFit = objectiveScore(c), btFit = objectiveScore(best);
                    if (ctFit > btFit) best = c;
                }
            }
        }
        return best;
    }

    /**
     * v52：自然选路比较器。只在同一父节点的候选里比“节点自身 75 帧全累积总分”。
     * 仅排除 invalid/exhausted；有非真死候选时跳过 fullDeathFrame===1 的真死候选。
     * 软死不额外偏置，靠总分自然排序。
     */
    function pickBestChildByRolloutTotal(children, exclude) {
        var i, c;
        var anyActive = false, allTrueDead = true, anyNotDead = false;
        for (i = 0; i < children.length; i++) {
            c = children[i];
            if (!c || c.invalid || c.exhausted || c === exclude) continue;
            anyActive = true;
            if (c.status !== 'dead') anyNotDead = true;
            if (c.fullDeathFrame !== 1) allTrueDead = false;
        }
        if (!anyActive) allTrueDead = false;
        // v94：混合选路开启时，目标分按最大安全分缩放后直接加到每个候选上。
        var targetScale2 = 0;
        if (_targetMixEnabled && _moveTarget) {
            for (i = 0; i < children.length; i++) {
                c = children[i];
                if (!c || c.invalid || c.exhausted || c === exclude) continue;
                if (!allTrueDead && c.fullDeathFrame === 1) continue;
                if (_targetMixEnabled && anyNotDead && c.status === 'dead') continue;
                var absTotal = Math.abs(fullRolloutTotalOf(c));
                if (absTotal > targetScale2) targetScale2 = absTotal;
            }
            if (targetScale2 <= 0) targetScale2 = 1;
        }
        var best = null, bestTotal = -Infinity;
        for (i = 0; i < children.length; i++) {
            c = children[i];
            if (!c || c.invalid || c.exhausted || c === exclude) continue;
            if (!allTrueDead && c.fullDeathFrame === 1) continue;
            if (_targetMixEnabled && anyNotDead && c.status === 'dead') continue; // 混合模式安全底线
            var rawTotal = fullRolloutTotalOf(c);
            var total = rawTotal + targetMixBonus(c, targetScale2);
            if (!best || total > bestTotal) {
                best = c; bestTotal = total;
                continue;
            }
            if (total === bestTotal) {
                var cDead = c.status === 'dead', bDead = best.status === 'dead';
                if (cDead !== bDead) {
                    if (!cDead) { best = c; bestTotal = total; }
                    continue;
                }
                if (cDead && c.segmentFrames > best.segmentFrames) {
                    best = c; bestTotal = total;
                    continue;
                }
                if (!cDead || c.segmentFrames === best.segmentFrames) {
                    // v97：无弹且无点击目标时，平局优先静止，避免无弹期乱选操作。
                    if (_liveProjectilesNow === 0 && !_moveTarget) {
                        var cStatic2 = isStaticInputs(c.inputs), bStatic2 = isStaticInputs(best.inputs);
                        if (cStatic2 !== bStatic2) {
                            if (cStatic2) { best = c; bestTotal = total; }
                            continue;
                        }
                    }
                    var ctFit = objectiveScore(c), btFit = objectiveScore(best);
                    if (ctFit > btFit) {
                        best = c; bestTotal = total;
                        continue;
                    }
                }
                if ((c.id || Infinity) < (best.id || Infinity)) {
                    best = c; bestTotal = total;
                }
            }
        }
        return best;
    }

    /** 预览路线选择：只沿存活且未回退剪枝的子节点走，正常按高分选择。 */
    function pickRouteChild(children) {
        var alive = [], i;
        for (i = 0; i < children.length; i++) {
            var c = children[i];
            if (c && !c.exhausted && !c.invalid && !isTerminalDead(c)) alive.push(c);
        }
        if (alive.length) return pickBest(alive);
        return null;
    }

    /** inputs → 9 操作下标；找不到返回 -1。 */
    function operationIndexOf(inputs) {
        if (!inputs) return -1;
        var ops = VantageSandbox.OPERATIONS;
        for (var oi = 0; oi < ops.length; oi++) {
            var o = ops[oi];
            if (!!o.inputs.forward === !!inputs.forward &&
                !!o.inputs.back === !!inputs.back &&
                !!o.inputs.left === !!inputs.left &&
                !!o.inputs.right === !!inputs.right) {
                return oi;
            }
        }
        return -1;
    }

    // ============================================================
    // 四、生长调度（v6：金线叶端全展开 9 候选——主人定下的规矩）
    // ============================================================

    /** 预定路线（主人基本架构：从根沿 argmax 到叶的链）。树视图金线/地图路线用。
     *  v46：根层的下一跳必须优先等于 commitNode（当前实际执行的操作）。
     *  v52 起威胁人工偏置已删除，提交与金线都按自然比较口径走。
     *  根层第一跳仍优先等于 commitNode，保证树图和实际操作一致。 */
    function commitPathOf(root, commitNode) {
        var path = [root], n = root;
        // 根层第一跳仍优先等于 commitNode（当前实际执行的操作）。
        if (n.children.length) {
            var first = null;
            if (commitNode && n.children.indexOf(commitNode) >= 0 &&
                !commitNode.exhausted && !commitNode.invalid) {
                first = commitNode;
            } else if (n.next && n.children.indexOf(n.next) >= 0 &&
                !n.next.exhausted && !n.next.invalid) {
                first = n.next;
            } else {
                first = pickRouteChild(n.children);
            }
            if (!first) return path;
            path.push(first);
            n = first;
        }
        // v49：之后只沿 next 走，不再按 subtreeBest 重新 argmax。
        while (n.next) {
            var nx = n.next;
            if (nx.parent === n && n.children.indexOf(nx) >= 0 &&
                !nx.exhausted && !nx.invalid) {
                path.push(nx);
                n = nx;
            } else {
                break;
            }
        }
        return path;
    }

    /** v59：节点是否在当前执行/计划路线（commitPath）上。 */
    function nodeOnCommitPath(tree, node) {
        if (!tree || !node) return false;
        var path = commitPathOf(tree.root, tree.commitNode);
        for (var pi = 0; pi < path.length; pi++) {
            if (path[pi] === node) return true;
        }
        return false;
    }

    /** 延伸目标=金线叶端（v6：延伸=全展开 9 候选——"每层都预测 9 种选 1 个
     *  作为路线"是主人早期定下的架构规矩；金线在 9 条候选中穿行、新层
     *  评分回传后 argmax 链可随时换道，不再是 v4 的单线"只延伸前"） */
    /** v48：可生长叶子条件。 */
    function isGrowableLeaf(tree, n) {
        if (!n || isTerminalDead(n) || n.exhausted || n.invalid) return false;
        if (n.children.length > 0) return false;
        if (tree.cfg.horizonCapEnabled === false) return true;
        return n.tEndSec - tree.root.tEndSec < tree.cfg.horizonSec;
    }

    /** v49：在一组候选叶子中选最优：路线平均分降序 → 时间深度浅 → id 升序。 */
    function pickBestGrowLeaf(tree, candidates) {
        var best = null, bestAvg = -Infinity;
        for (var i = 0; i < candidates.length; i++) {
            var leaf = candidates[i];
            if (!isGrowableLeaf(tree, leaf)) continue;
            var avg = routeAvgOfLeaf(tree, leaf);
            if (!best || avg > bestAvg) { best = leaf; bestAvg = avg; continue; }
            if (avg === bestAvg) {
                var dLeaf = leaf.tEndSec - tree.root.tEndSec;
                var dBest = best.tEndSec - tree.root.tEndSec;
                if (dLeaf < dBest) { best = leaf; bestAvg = avg; continue; }
                if (dLeaf === dBest && leaf.id < best.id) { best = leaf; bestAvg = avg; continue; }
            }
        }
        return best;
    }

    /** v49：收集某棵子树里的所有可生长叶子；不穿过 dead 内部节点。 */
    function collectGrowableLeaves(tree, n, out) {
        if (!n || n.invalid || n.exhausted || isTerminalDead(n)) return;
        if (isGrowableLeaf(tree, n)) { out.push(n); return; }
        for (var i = 0; i < n.children.length; i++) collectGrowableLeaves(tree, n.children[i], out);
    }

    /**
     * v48：当前路线优先延伸 + 回退时换兄弟。
     * ① 沿 commitPath 从根到叶找第一个可生长叶子；
     * ② 找不到则从叶端向根回退，在路径外兄弟子树里选最优叶子；
     * ③ 仍没有才全局 fallback（tree.leaves）。
     */
    function pickGrowLeaf(tree, adapter) {
        var path = commitPathOf(tree.root, tree.commitNode);
        var i, d, j, anc, kids, leaf;
        var tip = path[path.length - 1];

        // v84：路径 tip 到达视界时不再直接停止生长。树会继续走全局
        // fallback，把预算用于尚未到视界的兄弟叶子；只有所有可选叶子
        // 都到视界/不可生长时才真正停止。
        // ① 当前路线优先（tip 健康且未到视界时会在这里命中）
        for (i = 0; i < path.length; i++) {
            if (isGrowableLeaf(tree, path[i])) {
                recordStructure(tree, 'grow-priority', 'path n' + (path[i].id || '?'));
                return path[i];
            }
        }

        // ② tip 死/失效：3 层范围回退（pickRetreatLeaf），不再逐层随机散开。
        if (tip && (!isOptionalNode(tip) || tip.status === 'dead')) {
            var rt = pickRetreatLeaf(tree, tip, adapter);
            if (rt) {
                recordStructure(tree, 'grow-priority',
                    'retreat n' + (rt.leaf.id || '?') + ' depth=' + rt.depth);
                return rt.leaf;
            }
            recordStructure(tree, 'grow-priority', 'retreat-none');
            return null;
        }

        // ③ 全局 fallback（tip 健康但路径上无可生长叶等少数情况）
        leaf = pickBestGrowLeaf(tree, tree.leaves || []);
        if (leaf) {
            recordStructure(tree, 'grow-priority', 'global fallback n' + (leaf.id || '?'));
        }
        return leaf;
    }

    /**
     * 预览展开改为跨帧切片（v12 核心性能修正）：
     * 以前 growStep 每 30ms 同步跑 9×75 帧 rollout，一次尖峰等于自动模式
     * 一整轮；现在把 9 个操作摊到 5 个 tick（每 tick 1~2 个），
     * 与 testbench 自动模式的切片口径一致。
     */
    function startExpandSlice(tree, leaf, adapter, threats) {
        if (!leaf || isTerminalDead(leaf) || leaf.children.length > 0) return false;
        ensureNonNegativeNodeCount(tree);
        if (!canAddTreeNodes(tree, 9)) return false;
        tree._expandSlice = {
            leaf: leaf,
            adapter: adapter,
            threats: threats,
            idx: 0,
            results: [],
            computeMs: 0
        };
        return true;
    }

    /** 推进一步切片；返回 true 表示本轮展开完成。 */
    function stepExpandSlice(tree, adapter) {
        var slice = tree._expandSlice;
        if (!slice) return false;
        var ops = VantageSandbox.OPERATIONS;
        var heavy = slice.threats && slice.threats.length > 6;
        var perTick = heavy ? TREE_OPS_PER_TICK_HEAVY : TREE_OPS_PER_TICK;
        var t0 = performance.now();
        var take = Math.min(perTick, ops.length - slice.idx);
        if (take > 0) {
            var subOps = ops.slice(slice.idx, slice.idx + take);
            var partial = VantageScoring.scorePaths
                ? VantageScoring.scorePaths(slice.adapter, slice.leaf.simState,
                    subOps, EVAL_FRAMES, slice.threats, treeScoringCfg(tree))
                : null;
            if (partial) {
                for (var pj = 0; pj < partial.length; pj++) {
                    partial[pj].opIndex = slice.idx + pj;
                    partial[pj].opName = ops[slice.idx + pj].name;
                    partial[pj].deathAuthority = partial[pj].deathAuthority ||
                        (partial[pj].rustPhysics ? 'rust-candidate' : 'fused');   // v60/v77/v78
                    slice.results.push(partial[pj]);
                }
                slice.idx += partial.length;
            } else {
                // 极端兜底：逐个旧路径
                for (var n = 0; n < take && slice.idx < ops.length; n++, slice.idx++) {
                    var r = VantageScoring.scorePath(slice.adapter, slice.leaf.simState,
                        ops[slice.idx].inputs, EVAL_FRAMES, slice.threats, treeScoringCfg(tree));
                    r.opIndex = slice.idx;
                    r.opName = ops[slice.idx].name;
                    r.deathAuthority = 'check';   // v60：单路径回退=静态checkDeath
                    slice.results.push(r);
                }
            }
        }
        slice.computeMs += performance.now() - t0;

        if (slice.idx < ops.length) return false;

        // 9 操作齐了：探段长、挂节点、回传分数
        var leaf = slice.leaf;
        attachResults(tree, leaf, slice.results, slice.threats);
        tree.stats.growMs = tree.stats.growMs * 0.8 + slice.computeMs * 0.2;
        // v43：同上，旧路径也只在 60ms 级才熔断。
        if (slice.computeMs > 60) tree._growSkip = true;
        tree._expandSlice = null;
        tree._lastGrowAt = performance.now();

        applyRetreatAfterExpand(tree, leaf, adapter);
        return true;
    }

    /** v51：从 leaf 向上找 parent 的直属孩子。 */
    function childUnderParent(leaf, parent) {
        if (!leaf || !parent) return null;
        if (leaf === parent) return null;
        var n = leaf;
        while (n && n.parent !== parent) n = n.parent;
        return (n && n.parent === parent) ? n : null;
    }

    /**
     * v51：3 层范围真死回退。
     * 从 deadNode 向根走 3 条边得到祖先 A（不足 3 层则 A=根）；
     * 在 A 的 active 孩子子树里找可选路线叶子，允许 soft dead；
     * A 无候选则逐级向根上移，直到根仍无候选返回 null。
     */
    function pickRetreatLeaf(tree, deadNode, adapter) {
        if (!tree || !deadNode) return null;
        var A = deadNode;
        var depth = 0;
        var framesBack = 0;
        // v89：回退量同时受“节点数”和“帧数”两个单位限制：
        //   每向上爬一层，累计这一层要撤销的段长；
        //   先碰到节点上限或帧上限就先停，再从这里向上找替代路线。
        var nodeLimit = Math.max(1, Math.min(32,
            Math.floor((tree.cfg && (tree.cfg.retreatNodes != null
                ? tree.cfg.retreatNodes : tree.cfg.retreatDepth)) || 3)));
        var frameLimit = Math.max(10, Math.min(600,
            Math.floor((tree.cfg && tree.cfg.retreatFrames) || 200)));
        var i;
        while (A && A !== tree.root && A.parent && depth < nodeLimit) {
            if (depth > 0 && framesBack >= frameLimit) break;
            framesBack += Math.max(1, A.segmentFrames || A.plannedFrames || 0);
            A = A.parent;
            depth++;
        }
        if (!A) A = tree.root;
        while (A) {
            var bestLeaf = null, bestAvg = -Infinity, bestTime = Infinity, bestId = Infinity;
            var kids = A.children || [];
            for (i = 0; i < kids.length; i++) {
                var info = bestRouteLeafInSubtree(tree, kids[i], adapter);
                if (!info) continue;
                var time = info.leaf.tEndSec - tree.root.tEndSec;
                if (!bestLeaf || info.avg > bestAvg ||
                    (info.avg === bestAvg && (time < bestTime || (time === bestTime && info.leaf.id < bestId)))) {
                    bestLeaf = info.leaf; bestAvg = info.avg; bestTime = time; bestId = info.leaf.id;
                }
            }
            if (bestLeaf) return { leaf: bestLeaf, depth: depth, ancestor: A, framesBack: framesBack };
            if (A === tree.root) return null;
            A = A.parent;
            depth++;
        }
        return null;
    }

    /** v48：真死 = 所有 active 子节点都在 1 帧内死亡。 */
    function isTrueDeadNode(node) {
        if (!node || !node.children.length) return false;
        var anyActive = false;
        for (var ki = 0; ki < node.children.length; ki++) {
            var c = node.children[ki];
            if (!c || c.exhausted || c.invalid) continue;
            anyActive = true;
            if (!(c.fullDeathFrame >= 0 && c.fullDeathFrame <= 1)) return false;
        }
        return anyActive;
    }

    /**
     * v48/v68：真死回退。只有 9 候选全部 1 帧内死亡才标记 exhausted；
     * 回退搜索只读，不在搜索过程中刷新/改结构。
     */
    function applyRetreatAfterExpand(tree, leaf, adapter) {
        if (!leaf.parent || !leaf.children.length) return null;
        if (!isTrueDeadNode(leaf)) return null;
        leaf.exhausted = true;
        tree.stats.retreats++;
        var rt = pickRetreatLeaf(tree, leaf, adapter);
        var onPath = false;
        var path = commitPathOf(tree.root, tree.commitNode);
        for (var pi = 0; pi < path.length; pi++) {
            if (path[pi] === leaf) { onPath = true; break; }
        }
        if (leaf === tree.commitNode || onPath) {
            pushEvent('retreat', '真死回退@' + (leaf.opName || leaf.id));
            if (tree._expandSlice && tree._expandSlice.leaf === leaf) tree._expandSlice = null;
        }

        // v81 修复：回退结果必须写回祖先 next，否则只标 exhausted、
        // 丢掉了 retreat target，下一次 commitPath/grow 仍会往死枝走。
        if (rt) {
            var retreatChild = childUnderParent(rt.leaf, rt.ancestor);
            if (retreatChild && rt.ancestor.children.indexOf(retreatChild) >= 0) {
                var oldRetreatNext = rt.ancestor.next;
                if (oldRetreatNext !== retreatChild) {
                    rt.ancestor.next = retreatChild;
                    tree.stats.retreatReroutes = (tree.stats.retreatReroutes || 0) + 1;
                    recordStructure(tree, 'retreat-reroute',
                        (oldRetreatNext ? (oldRetreatNext.opName || ('n' + oldRetreatNext.id)) : '-') +
                        ' → ' + (retreatChild.opName || ('n' + retreatChild.id)) +
                        ' ancestor=' + (rt.ancestor.opName || ('n' + rt.ancestor.id)));
                }
            }
            recordStructure(tree, 'retreat-depth',
                'nodes=' + rt.depth + ' frames=' + (rt.framesBack || 0) +
                ' target=' + (rt.leaf.id || '?'));
        }

        // 当前执行节点已经真死（下一层全 1 帧死），不能等自然段末；
        // 同 tick 强制结束当前段，让 commit 回退/重选。
        if (leaf === tree.commitNode ||
            (rt && rt.ancestor === tree.root &&
             (!tree.commitNode || rt.ancestor.next !== tree.commitNode))) {
            if (tree.commitNode) {
                tree.commitNode.tEndSec = _timeAcc;
                tree._forcedReselect = true;
                pushEvent('force', '真死回退提前结束@' + (leaf.opName || leaf.id));
            }
        }

        recordStructure(tree, 'true-dead-retreat',
            'leaf=' + (leaf.opName || leaf.id) + ' onPath=' + onPath +
            ' target=' + (rt ? (rt.leaf.id || '?') : 'none'));
        backpropBest(leaf.parent);
        return rt ? rt.leaf : null;
    }

    /**
     * v85：把一个长操作叶拆成“更短的同操作前缀叶”。
     * 这不是延长视界，而是在原操作中间插入一个可分叉节点；
     * 原长操作保留为兄弟，新短叶从中间帧继续展开 9 候选。
     */
    function splitLongSegmentLeaf(tree, threats) {
        if (!tree || !tree.root || !tree.leaves || !tree.leaves.length) return null;
        var best = null, bestFrames = 0;
        for (var i = 0; i < tree.leaves.length; i++) {
            var leaf = tree.leaves[i];
            if (!leaf || !leaf.parent || leaf.children.length > 0) continue;
            if (leaf._refineSplit) continue;   // v88：同一长叶只拆一次
            if (isTerminalDead(leaf)) continue; // v88：真死叶拆了也没用
            if (leaf.invalid || leaf.exhausted) continue;
            if (!leaf.rolloutSamples || leaf.rolloutSamples.length < 3) continue;
            var frames = Math.max(1, leaf.segmentFrames || 0);
            if (frames > bestFrames) { best = leaf; bestFrames = frames; }
        }
        if (!best || bestFrames < 6) return null;
        var splitAt = Math.max(3, Math.floor(bestFrames / 2));
        if (splitAt >= bestFrames || splitAt >= best.rolloutSamples.length) return null;
        var sample = best.rolloutSamples[splitAt];
        if (!sample) return null;
        var newNode = createTreeNode(best.parent, best.inputs, {
            tank: { x: sample.x, y: sample.y, rot: sample.rot },
            tGlobal: (best.rolloutStartT || 0) + splitAt * FRAME_DT
        });
        newNode.plannedFrames = splitAt;
        newNode.segmentFrames = splitAt;
        newNode.rolloutSamples = best.rolloutSamples.slice(0, splitAt + 1);
        newNode.perFrameScores = Array.isArray(best.perFrameScores)
            ? best.perFrameScores.slice(0, splitAt) : null;
        var sum = 0;
        if (newNode.perFrameScores) {
            for (var k = 0; k < newNode.perFrameScores.length; k++) {
                sum += Number(newNode.perFrameScores[k]) || 0;
            }
        }
        newNode.segmentScore = sum;
        newNode.rolloutTotal = sum;
        newNode.baseExt = 0;
        newNode.subtreeBest = sum;
        newNode.status = 'alive';
        newNode.fullDead = false;
        newNode.fullDeathFrame = -1;
        newNode.rolloutDeathFrame = -1;
        newNode.deathAuthority = best.deathAuthority || 'fused';
        newNode.rolloutStartT = best.rolloutStartT;
        newNode.tEndSec = tree.rootAbsT + (best.rolloutStartT || 0) + splitAt * FRAME_DT;
        newNode.opName = best.opName;
        newNode.threats = threats || best.threats || null;
        newNode.freshSig = nodeWindowSig(null, newNode, threats || tree.threats || []);
        newNode._refineSplit = false;
        best._refineSplit = true;   // v88：原长叶不再重复拆，前缀叶可继续拆
        attachChild(tree, best.parent, newNode);
        return newNode;
    }

    function growStep(tree, adapter, threats) {
        if (tree._expandSlice) {
            stepExpandSlice(tree, adapter);
            return;
        }
        // v57：无子弹不预测。没有威胁时树不延伸、不开展开切片；
        // 首次提交仍可建立根层 9 候选并选静止。
        // v77：实验开关 growWithoutThreats 开启时，无威胁也继续生长，
        // 用于无子弹场景的纯数据搬运/更新性能实验；默认关闭保持 v57 行为。
        if (!tree.threats || !tree.threats.length) {
            if (!tree.cfg.growWithoutThreats) {
                recordGrowStall(tree, 'grow-no-threat', 'no-threats');
                return;
            }
        }
        ensureNonNegativeNodeCount(tree);
        if (!canAddTreeNodes(tree, 9)) {
            if (warmupCapReached(tree, 9)) {
                recordGrowStall(tree, 'grow-warmup-cap',
                    'nodeCount=' + tree.nodeCount +
                    ' warmupCap=' + (tree.cfg.warmupMaxNodes || 500));
            } else {
                recordGrowStall(tree, 'grow-maxnodes', 'nodeCount=' + tree.nodeCount);
            }
            return;
        }
        if (tree._growSkip) {
            tree._growSkip = false;
            tree.stats.growSkips++;
            recordGrowStall(tree, 'grow-skip', 'perf-gate');
            return;
        }
        var leaf = pickGrowLeaf(tree, adapter);
        var leafFromRefine = false;
        if (!leaf && tree.cfg.refineBeyondLimits === true) {
            leaf = splitLongSegmentLeaf(tree, threats);
            if (leaf) {
                leafFromRefine = true;
                tree.stats.refineSplits = (tree.stats.refineSplits || 0) + 1;
                recordStructure(tree, 'refine-split',
                    'from=' + (leaf.opName || leaf.id) + ' frames=' + leaf.segmentFrames);
            }
        }
        // v88：没有普通可生长叶时，持续细化自己也能顶上，不依赖超限细化开关。
        if (!leaf && tree.cfg.continuousRefine === true && canAddTreeNodes(tree, 10)) {
            leaf = splitLongSegmentLeaf(tree, threats);
            if (leaf) {
                leafFromRefine = true;
                tree.stats.refineSplits = (tree.stats.refineSplits || 0) + 1;
                recordStructure(tree, 'refine-continuous',
                    'from=' + (leaf.opName || leaf.id) + ' frames=' + leaf.segmentFrames);
            }
        }
        if (!leaf) {
            recordGrowStall(tree, 'grow-no-leaf', 'tip=none');
            return;
        }

        // 融合世界可用：每 tick 最多同步扩 growLayersPerTick 层（v80），
        // 默认 1 层保持原节奏；每层仍是完整 9 候选分叉。
        if (fusedBatchReady(adapter)) {
            var layersPerTick = Math.max(1, Math.min(6,
                Math.floor(tree.cfg.growLayersPerTick || 1)));
            // v91：新弹剪枝后的临时生长补偿，叠加在正常层数上。
            if (tree._growBoost && tree._growBoost.framesLeft > 0) {
                var boostLayers = Math.max(0, Math.min(9, Math.floor(tree._growBoost.layers || 0)));
                layersPerTick = Math.min(15, layersPerTick + boostLayers);
                tree.stats.growBoostLayers = (tree.stats.growBoostLayers || 0) + boostLayers;
                tree._growBoost.framesLeft--;
                if (tree._growBoost.framesLeft <= 0) tree._growBoost = null;
            }
            var t0 = performance.now();
            var grown = 0;
            while (grown < layersPerTick && canAddTreeNodes(tree, 9)) {
                // 第一次用前面已选/细化出来的 leaf；后续再重新选。
                var growLeaf = (grown === 0) ? leaf : pickGrowLeaf(tree, adapter);
                if (!growLeaf) {
                    if (grown === 0) {
                        recordGrowStall(tree, 'grow-no-leaf', 'tip=none');
                    }
                    break;
                }
                if (!expandLeaf(tree, growLeaf, adapter, threats)) {
                    recordStructure(tree, 'expand-fail',
                        'leaf=' + (growLeaf.opName || growLeaf.id) + ' nodes=' + tree.nodeCount);
                    break;
                }
                applyRetreatAfterExpand(tree, growLeaf, adapter);
                grown++;
            }
            // v88：持续细化 = 正常生长之外，每 tick 追加一次“拆长操作→展开前缀”。
            // 不依赖 pickGrowLeaf 返回 null，也不要求视界限开启。
            if (tree.cfg.continuousRefine === true && leafFromRefine === false &&
                tree.stats.growMs <= 60 && canAddTreeNodes(tree, 10)) {
                var cRef = splitLongSegmentLeaf(tree, threats);
                if (cRef) {
                    tree.stats.refineSplits = (tree.stats.refineSplits || 0) + 1;
                    recordStructure(tree, 'refine-continuous',
                        'from=' + (cRef.opName || cRef.id) + ' frames=' + cRef.segmentFrames);
                    if (expandLeaf(tree, cRef, adapter, threats)) {
                        applyRetreatAfterExpand(tree, cRef, adapter);
                    } else {
                        recordStructure(tree, 'expand-fail',
                            'leaf=' + (cRef.opName || cRef.id) + ' nodes=' + tree.nodeCount);
                    }
                }
            }
            var ms = performance.now() - t0;
            tree.stats.growMs = tree.stats.growMs * 0.8 + ms * 0.2;
            // 门槛只留作 60ms 级熔断保护；多层生长同样共用。
            if (tree.stats.growMs > 60) tree._growSkip = true;
            return;
        }

        // 旧单路径回退：保留 30ms 节流 + 跨帧切片
        var nowMs = performance.now();
        if (tree._lastGrowAt && nowMs - tree._lastGrowAt < GROW_MIN_INTERVAL_MS) return;
        if (startExpandSlice(tree, leaf, adapter, threats)) {
            stepExpandSlice(tree, adapter);   // 本帧先切第一片
        }
    }

    // ============================================================
    // 五、提交与坍缩（v8：提交前新鲜重选，旧链只作预览/执行轨迹）
    // ============================================================

    /**
     * 提交（段末/首次/新弹突发）：
     *   1. 上一段真正执行的节点进 execTrail；
     *   2. 根重置为当前真实位姿，旧子链全部作废；
     *   3. 用当前 threats 从真实位姿展开公平 9 候选；
     *   4. argmax 选 best（平局 pickBest），8 兄弟快照灰显；
     *   5. best 作为 commitNode 执行，其 simState 保留为预测段末态。
     */
    /** v40：每次提交记录候选层，便于定位“为什么全选静止”。 */
    function recordCommitInfo(tree, children, reason, selected) {
        var info = {
            t: _timeAcc,
            reason: reason,
            selectedId: selected ? selected.id : null,
            selectedKey: selected ? (selected.opKey || selected.opName || '?') : null,
            threatCount: (tree.threats || []).length,
            threatIds: (tree.threats || []).map(function(th) { return th.id; }).join(','),
            candidates: []
        };
        var opKeys = ['still', 'forward', 'back', 'left', 'right',
            'forward-left', 'forward-right', 'back-left', 'back-right'];
        function keyOf(inputs) {
            if (!inputs) return '?';
            for (var oi2 = 0; oi2 < 9; oi2++) {
                var o2 = VantageSandbox.OPERATIONS[oi2];
                if (!o2) continue;
                if (!!o2.inputs.forward === !!inputs.forward &&
                    !!o2.inputs.back === !!inputs.back &&
                    !!o2.inputs.left === !!inputs.left &&
                    !!o2.inputs.right === !!inputs.right) {
                    return opKeys[oi2];
                }
            }
            return '?';
        }
        for (var i = 0; i < children.length; i++) {
            var c = children[i];
            var opId = -1;
            if (c.inputs) {
                for (var oi = 0; oi < 9; oi++) {
                    var o = VantageSandbox.OPERATIONS[oi];
                    if (!o) continue;
                    if (!!o.inputs.forward === !!c.inputs.forward &&
                        !!o.inputs.back === !!c.inputs.back &&
                        !!o.inputs.left === !!c.inputs.left &&
                        !!o.inputs.right === !!c.inputs.right) {
                        opId = oi;
                        break;
                    }
                }
            }
            info.candidates.push({
                id: c.id,
                op: c.opName,
                opId: opId,
                opKey: opId >= 0 ? opKeys[opId] : '?',
                status: c.status,
                seg: c.segmentFrames,
                planned: c.plannedFrames || c.segmentFrames || 0,
                avg: +(segmentAvgOf(c).toFixed(3)),
                total: fullRolloutTotalOf(c),
                score: c.subtreeBest,
                death: c.fullDeathFrame
            });
        }
        info.selectedKey = selected && selected.inputs ? keyOf(selected.inputs) : info.selectedKey;
        tree.diag.lastCommitInfo = info;
    }

    function recordStructure(tree, code, detail) {
        var h = tree.diag.structureHistory || (tree.diag.structureHistory = []);
        var maxDepth = 0;
        (function rec(n, depth) {
            if (!n) return;
            if (depth > maxDepth) maxDepth = depth;
            for (var i = 0; i < n.children.length; i++) rec(n.children[i], depth + 1);
        })(tree.root, 0);
        h.push({
            t: _timeAcc,
            code: code,
            detail: detail || '',
            nodeCount: tree.nodeCount,
            depth: maxDepth
        });
        if (h.length > 600) h.shift();
    }

    /**
     * v42：刚性重摆整棵保留子树。
     * 正常坍缩保留的是“从上一根位姿”长出来的预览子树。真实坦克一旦
     * 实际走完一段，子树所有 rolloutSamples 的起点还是上一根位姿；
     * 继续 preserve 会让下一段从旧起点出发（v41 JSON 实测：真实在
     * (76.63,44.27)，下一段预测却从 (77.05,44.48) 出发，随后连续
     * 0.47m 固定偏差 → alignHard 循环）。用真实根位姿对旧根位姿做一次
     * 刚性变换（平移+旋转），把整棵子树位姿同步到真实根，拓扑/分数/
     * 时间不变。墙碰撞差异留给下一次段末对齐校正。
     */
    function recordGrowStall(tree, code, detail) {
        var h = tree.diag.growHistory || (tree.diag.growHistory = []);
        h.push({ t: _timeAcc, code: code, detail: detail || '', nodeCount: tree.nodeCount });
        if (h.length > 120) h.shift();
        tree.stats.growStalls = tree.stats.growStalls || {};
        tree.stats.growStalls[code] = (tree.stats.growStalls[code] || 0) + 1;
    }

    /**
     * v42：保留子树的时间轴重挂。
     * 旧子树所有 tGlobal 都是相对 oldRootAbsT 的；把根重挂到当前
     * _timeAcc 后，子节点 tGlobal 统一减去旧根的 tGlobal（保持相对
     * 未来时长不变），tEndSec 重新按新 rootAbsT 计算。配合每次
     * commit 重新锚定 threats，子弹轨迹查询时间不会随层数累积漂移。
     */
    function shiftSubtreeTime(tree, oldRootTg) {
        if (!tree || !tree.root || !(oldRootTg > 0)) return 0;
        var count = 0;
        // v45 根修：旧版 rec(tree.root) 首步命中 "n === tree.root" 直接 return，
        // 连根的子节点都没来得及递归——整个时间轴平移函数从未真正执行过。
        // 后果：子树 tGlobal 沿保留层数无限累积（每 commit +0.18s），
        //   ① 提交节点段长翻倍跳变（tEndSec 越滚越远）→ 段末永远等不到、
        //      对齐照不到正确样本 → alignHard 循环 → 重建风暴；
        //   ② 深层节点按错误 tGlobal 查子弹轨迹（弹道时间错位 0.36s+），
        //      评分/死亡判定系统性失真——深层树"无视子弹"的直接原因。
        // 修正：只跳过"根节点本身的字段平移"，但必须继续递归它的子节点。
        (function rec(n) {
            if (!n) return;
            if (n !== tree.root) {
                if (n.simState && typeof n.simState.tGlobal === 'number') {
                    n.simState.tGlobal = Math.max(0, n.simState.tGlobal - oldRootTg);
                }
                if (typeof n.rolloutStartT === 'number') {
                    n.rolloutStartT = Math.max(0, n.rolloutStartT - oldRootTg);
                }
                if (n.simState && typeof n.simState.tGlobal === 'number') {
                    n.tEndSec = tree.rootAbsT + n.simState.tGlobal;
                }
                count++;
            }
            for (var i = 0; i < n.children.length; i++) rec(n.children[i]);
        })(tree.root);
        return count;
    }

    function rebaseSubtreeRigid(tree, oldPose, newPose) {
        if (!tree || !tree.root || !oldPose || !newPose) return 0;
        var dx = newPose.x - oldPose.x;
        var dy = newPose.y - oldPose.y;
        var dr = newPose.rot - oldPose.rot;
        dr = Math.atan2(Math.sin(dr), Math.cos(dr));
        if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6 && Math.abs(dr) < 1e-6) return 0;
        var cos = Math.cos(dr), sin = Math.sin(dr), count = 0;

        function txPose(p) {
            if (!p) return;
            var ox = p.x - oldPose.x, oy = p.y - oldPose.y;
            p.x = newPose.x + ox * cos - oy * sin;
            p.y = newPose.y + ox * sin + oy * cos;
            if (typeof p.rot === 'number') {
                p.rot += dr;
                p.rot = Math.atan2(Math.sin(p.rot), Math.cos(p.rot));
            }
        }

        function txNode(n) {
            if (!n || n === tree.root) return;
            if (n.simState && n.simState.tank) txPose(n.simState.tank);
            var arr = n.rolloutSamples || n.samples || null;
            if (arr) {
                for (var i = 0; i < arr.length; i++) {
                    if (arr[i]) txPose(arr[i]);
                }
            }
            // v78：刚性重摆改变了节点轨迹相对子弹/墙的几何关系；
            // 旧死亡结论与旧分数不能继续视为有效。清空新鲜度标记，
            // 由后续 refresh/rescore 按新几何重算。
            n.freshSig = '';
            n.scoreCache = null;
            count++;
            for (var c = 0; c < n.children.length; c++) txNode(n.children[c]);
        }

        for (var k = 0; k < tree.root.children.length; k++) txNode(tree.root.children[k]);

        // 上次坍缩的灰点也同步到新根坐标系，树图/地图灰点才落在正确位置。
        var ds = tree.doomedSnaps || [];
        for (var d = 0; d < ds.length; d++) {
            if (ds[d]) txPose(ds[d]);
        }
        return count;
    }

    function commit(tree, adapter, threats, realTankState, precomputed) {
        if (!realTankState) {
            realTankState = adapter.getTankState();
        }
        if (!realTankState) return false;

        var root = tree.root;
        var prev = tree.commitNode;
        var freshRoot = !precomputed || precomputed.freshRoot;
        var results = precomputed && precomputed.results;

        tree.doomedSnaps = [];

        if (prev && !freshRoot && prev.parent === root) {
            // —— 正常段末坍缩：只删旧根的兄弟，保留 prev 及其子树 ——
            var oldRootAbsT = tree.rootAbsT;
            // v43 根因：prev 的子树是从 prev.simState（它的预测末态）长
            // 出来的，不是从 root.simState 长出来的。重摆必须用 prev 的
            // 旧 simState 作为旧坐标系；v42 误用 root.simState，导致
            // 新 commitNode 永远带上一段预测末态偏差（JSON 恒定 0.512m）。
            var oldPrevTk = prev.simState && prev.simState.tank
                ? { x: prev.simState.tank.x, y: prev.simState.tank.y, rot: prev.simState.tank.rot }
                : null;
            tree.execTrail.push({
                opName: prev.opName, tEnd: _timeAcc,
                // 执行轨迹记录真实段末时间与位姿：树图“执行过的部分”
                // 必须与坦克实际走到的位置一致，不再记预测位姿。
                x: realTankState.x, y: realTankState.y,
                dead: prev.status === 'dead'
            });
            if (tree.execTrail.length > 200) tree.execTrail.shift();

            // 旧根除 prev 外的兄弟：灰显 + 删除（正常坍缩唯一允许的大块
            // 减节点路径，对应 doomedSnaps 渲染）。
            var oldSiblings = root.children.slice();
            var beforeSibsCount = tree.nodeCount;
            var removedRootSibs = 0;
            for (var si = 0; si < oldSiblings.length; si++) {
                if (oldSiblings[si] === prev) continue;
                var sib = oldSiblings[si];
                var stk = sib.simState && sib.simState.tank;
                tree.doomedSnaps.push({
                    opName: sib.opName, tEnd: sib.tEndSec,
                    x: stk ? stk.x : 0, y: stk ? stk.y : 0,
                    dead: sib.status === 'dead'
                });
                detachChild(tree, sib);
                removedRootSibs++;
            }
            if (removedRootSibs) {
                recordStructure(tree, 'collapse-root-siblings',
                    'removed=' + removedRootSibs +
                    ' loss=' + (beforeSibsCount - tree.nodeCount));
            }

            // prev 升级为新根：父链断开，真实位姿对齐。rootAbsT 一律
            // 重挂到当前真实时刻，旧子树的 tGlobal 同步减去旧根 tGlobal，
            // 避免“旧锚点时间”沿保留层数累积漂移（弹道查询会越查越远）。
            var hasKids = prev.children.length > 0;
            var prevTg = hasKids ? (prev.simState ? prev.simState.tGlobal : 0) : 0;
            prev.parent = null;
            prev.parentId = null;
            prev.depth = 0;
            tree.root = prev;
            tree.rootAbsT = _timeAcc;
            prev.simState = {
                tank: { x: realTankState.x, y: realTankState.y, rot: realTankState.rot },
                tGlobal: 0
            };
            prev.tEndSec = _timeAcc;
            if (hasKids) {
                var shifted = shiftSubtreeTime(tree, prevTg);
                if (shifted) {
                    recordStructure(tree, 'rebase-time',
                        'nodes=' + shifted + ' oldRootTg=' + prevTg.toFixed(3));
                }
            }
            if (hasKids && oldPrevTk) {
                var rebased = rebaseSubtreeRigid(tree, oldPrevTk,
                    { x: realTankState.x, y: realTankState.y, rot: realTankState.rot });
                if (rebased) {
                    recordStructure(tree, 'rebase-subtree',
                        'nodes=' + rebased + ' oldPrev=(' + oldPrevTk.x.toFixed(2) + ',' +
                        oldPrevTk.y.toFixed(2) + ') new=(' + realTankState.x.toFixed(2) + ',' +
                        realTankState.y.toFixed(2) + ')');
                }
            }
            tree._expandSlice = null;
            tree._lastGrowAt = 0;

            // 每次 commit 都用本 tick 新算的 threats 重挂弹道锚点；
            // 保留子树只保留拓扑/位姿，不保留会过期的旧时间锚。
            // 旧弹轨迹能复用就复用（只平移 anchorOffset），新弹才重模拟。
            if (hasKids) {
                reanchorThreatsAtCommit(tree, adapter, threats,
                    oldRootAbsT !== undefined ? oldRootAbsT : _timeAcc);
            } else {
                tree.threats = threats;
                tree._hasOffsetThreats = false;
                tree._pendingThreats = [];
                ensureThreatTracks(tree, adapter, threats);
                snapshotThreatAnchors(tree, threats, tree.rootAbsT);
            }

            if (prev.children.length === 0) {
                if (results && results.length) {
                    if (!attachResults(tree, prev, results, threats)) {
                        recordStructure(tree, 'attach-fail',
                            'nodeCount=' + tree.nodeCount + ' max=' + tree.cfg.maxNodes);
                        // 节点满等极端情况：不要卡死在旧 commitNode 上。
                        return commit(tree, adapter, threats, realTankState,
                            { freshRoot: true, results: results });
                    }
                } else if (!expandLeaf(tree, prev, adapter, threats)) {
                    recordStructure(tree, 'expand-fail',
                        'nodeCount=' + tree.nodeCount + ' max=' + tree.cfg.maxNodes);
                    return commit(tree, adapter, threats, realTankState,
                        { freshRoot: true, results: results });
                }
            }

            // v47 reserve/reuse：先把与当前根状态/威胁签名一致的 reserve
            // 节点挂回来，再在新根层选路；旧根 8 兄弟仍按正常坍缩删除。
            reactivateMatchingReserves(tree, adapter, prev, tree.threats);

            // v47：reactivate 后统一用当前 threats 刷新候选分数与死亡状态，
            // 再参与 pickBest；旧节点不会携带旧分数/旧 status。
            refreshCandidateScores(tree, adapter);

            // v49：正常提交直接采用 planned next，不再用 subtreeBest 全局重选。
            // v81：深层选路实验开启时，优先按 subtreeBest（含后代）选根层孩子。
            var keepBest = null;
            if (tree.cfg.deepSelectEnabled && prev.children.length) {
                keepBest = pickBest(prev.children);
                if (keepBest && keepBest !== prev.next) {
                    tree.stats.deepSelects = (tree.stats.deepSelects || 0) + 1;
                    recordStructure(tree, 'commit-deep-select',
                        (prev.next ? (prev.next.opName || ('n' + prev.next.id)) : '-') +
                        ' → ' + (keepBest.opName || ('n' + keepBest.id)));
                }
            }
            if (!keepBest && prev.next && prev.children.indexOf(prev.next) >= 0 &&
                !prev.next.exhausted && !prev.next.invalid &&
                prev.next.fullDeathFrame !== 1) {
                keepBest = prev.next;
                recordStructure(tree, 'commit-follow-next',
                    'n' + (keepBest.id || '?') + ' ' + (keepBest.opName || '?'));
            } else if (!keepBest) {
                // v54：next 失效进入 fallback 前，先确保当前比较层 fresh。
                ensureLayerFresh(tree, adapter, prev);
                // next 无效或 1 帧真死：先做 3 层范围回退。
                if (prev.next && prev.next.fullDeathFrame === 1) {
                    var rtNext = pickRetreatLeaf(tree, prev.next, adapter);
                    if (rtNext) {
                        var retreatChild = childUnderParent(rtNext.leaf, prev);
                        if (retreatChild) {
                            keepBest = retreatChild;
                            recordStructure(tree, 'commit-global-route',
                                'retreat child n' + (keepBest.id || '?') + ' leaf n' + (rtNext.leaf.id || '?') +
                                ' depth=' + rtNext.depth + ' avg=' + routeAvgOfLeaf(tree, rtNext.leaf).toFixed(3));
                        }
                    }
                }
                if (!keepBest) {
                    // next 无效：在 prev 的其余孩子子树里找路线平均分最高的可选叶子。
                    var bestRouteChild = null, bestRouteInfo = null;
                    for (var bi = 0; bi < prev.children.length; bi++) {
                        var bc = prev.children[bi];
                        if (!bc || bc === prev.next || bc.exhausted || bc.invalid) continue;
                        var info = bestRouteLeafInSubtree(tree, bc, adapter);
                        if (!info) continue;
                        var infoTime = info.leaf.tEndSec - tree.root.tEndSec;
                        if (!bestRouteInfo || info.avg > bestRouteInfo.avg ||
                            (info.avg === bestRouteInfo.avg &&
                             (infoTime < (bestRouteInfo.leaf.tEndSec - tree.root.tEndSec) ||
                              (infoTime === (bestRouteInfo.leaf.tEndSec - tree.root.tEndSec) &&
                               info.leaf.id < bestRouteInfo.leaf.id)))) {
                            bestRouteInfo = info;
                            bestRouteChild = bc;
                        }
                    }
                    if (bestRouteChild) {
                        keepBest = bestRouteChild;
                        recordStructure(tree, 'commit-global-route',
                            'child n' + (keepBest.id || '?') + ' leaf n' + (bestRouteInfo.leaf.id || '?') +
                            ' avg=' + bestRouteInfo.avg.toFixed(3));
                    }
                }
            }
            if (!keepBest) {
                // v36：九候选全被高频死亡剪光时，只重建“当前根层”，
                // 不再整树 freshRoot。保留深层未受影响分支。
                // v48：真死回退记录，先尝试根层存活兄弟重选，再退化 freshRoot。
                recordStructure(tree, 'true-dead-retreat',
                    'children=' + prev.children.length + ' no-argmax');
                recordStructure(tree, 'root-layer-reselect',
                    'children=' + prev.children.length + ' no-argmax');
                while (prev.children.length) detachChild(tree, prev.children[0]);
                tree.rootAbsT = _timeAcc;
                tree.threats = threats;
                tree._pendingThreats = [];
                ensureThreatTracks(tree, adapter, threats);
                snapshotThreatAnchors(tree, threats, tree.rootAbsT);
                if (results && results.length) {
                    if (!attachResults(tree, prev, results, threats)) {
                        recordStructure(tree, 'attach-fail',
                            'root-layer nodeCount=' + tree.nodeCount);
                        return commit(tree, adapter, threats, realTankState,
                            { freshRoot: true, results: results });
                    }
                } else if (!expandLeaf(tree, prev, adapter, threats)) {
                    recordStructure(tree, 'expand-fail',
                        'root-layer nodeCount=' + tree.nodeCount);
                    return commit(tree, adapter, threats, realTankState,
                        { freshRoot: true, results: results });
                }
                ensureLayerFresh(tree, adapter, prev);
                keepBest = pickBestChildByRolloutTotal(prev.children);
                if (!keepBest) {
                    return commit(tree, adapter, threats, realTankState,
                        { freshRoot: true, results: results });
                }
            }
            // v78：最终执行路线必须在记录提交信息、退休兄弟、转入 reserve
            // 之前确认完毕，避免诊断记录与 reserve 拓扑建立在未确认候选上。
            keepBest = confirmExecutionRoutePick(tree, adapter, keepBest, prev);

            // v47 reserve/reuse：新根层未选中候选转入 reserve，不删除不补位。
            // 旧根 8 兄弟（prev 的兄弟）仍按正常坍缩删除，语义不变。
            recordCommitInfo(tree, prev.children, tree._lastFreshReason || 'commit', keepBest);
            var newRootDoomed = [];
            for (var ri = 0; ri < prev.children.length; ri++) {
                if (prev.children[ri] !== keepBest) newRootDoomed.push(prev.children[ri]);
            }
            var beforeChooseCount = tree.nodeCount;
            for (ri = 0; ri < newRootDoomed.length; ri++) {
                var rdn = newRootDoomed[ri];
                // v47：这些节点是转入 reserve 的未来候选，不灰显；
                // 只有正常坍缩删除的旧根兄弟才进 doomedSnaps。
                detachChildIntoReserve(tree, rdn);
            }
            if (newRootDoomed.length) {
                recordStructure(tree, 'retire-new-root-siblings',
                    'retired=' + newRootDoomed.length +
                    ' activeLoss=' + (beforeChooseCount - tree.nodeCount));
            }
            // v47 reserve/reuse：刚转入 reserve 的未选中节点，在父状态/威胁
            // 签名一致时立即 reactivate 回新根层，恢复 9 候选比较集。
            // 这样既不删除节点、也不靠 refill-root-candidates 重算，
            // 活动树不会因为换道只剩 root+commitNode 两个节点。
            reactivateMatchingReserves(tree, adapter, prev, tree.threats);
            pruneExpiredReserves(tree);

            // 极端兜底：reserve 全部失效时，若根层只有被选中者且它是叶子，
            // 扩一层保证下一段有候选可比较（growStep 仍是每 tick 只扩一个叶子）。
            if (prev.children.length < 2 &&
                keepBest.status === 'alive' && keepBest.children.length === 0) {
                if (canAddTreeNodes(tree, 9)) {
                    expandLeaf(tree, keepBest, adapter, tree.threats);
                } else {
                    recordGrowStall(tree, 'commit-grow-maxnodes', 'keepBest leaf');
                }
            }

            recordStructure(tree, 'commit-select',
                'selected=' + (keepBest.opName || keepBest.id) +
                ' rootChildren=' + prev.children.length +
                ' reserve=' + tree.reserveCount + ' reused=' + tree.reuseCount);

            // v37：自然段末提交，不再有“半途提前提交”的轨迹重摆。

            // 重核树计数（prev 子树保留）；同时按新拓扑重算 depth——
            // 节点提升后子树的 depth 字段若沿用旧值，诊断/渲染会看到
            // root(0)->child(3) 这种错位层级。
            tree.leaves = [];
            tree.nodeCount = 0;
            (function collect(n, dep) {
                tree.nodeCount++;
                n.depth = dep;
                if (!n.children.length) {
                    if (n.status !== 'dead') tree.leaves.push(n);
                } else {
                    for (var cj = 0; cj < n.children.length; cj++) collect(n.children[cj], dep + 1);
                }
            })(tree.root, 0);
            recordShape(tree, tree._lastFreshReason
                ? 'commit:' + tree._lastFreshReason : 'commit');

            tree.commitNode = keepBest;
            tree.commitStartT = _timeAcc;
            tree.threatDirty = false;
            tree._forcedReselect = false;
            tree.stats.commits++;
            pushEvent('commit', (keepBest.opName || '?') + '·' + keepBest.segmentFrames + '帧');
            return true;
        }

        // —— 首次提交 / 新弹 / 对齐失败：整根新鲜重选 ——
        tree.stats.freshRoots = (tree.stats.freshRoots || 0) + 1;
        recordStructure(tree, 'fresh-root',
            (tree._lastFreshReason || (freshRoot ? 'fresh' : 'initial')) +
            ' before=' + tree.nodeCount);
        if (prev) {
            tree.execTrail.push({
                opName: prev.opName, tEnd: _timeAcc,
                // 执行轨迹记录真实段末时间与位姿，而不是预测位姿。
                x: realTankState.x, y: realTankState.y,
                dead: prev.status === 'dead'
            });
            if (tree.execTrail.length > 200) tree.execTrail.shift();
        }

        root.children = [];
        root.parent = null;
        root.parentId = null;
        root.depth = 0;
        root.id = 0;
        tree.nextNodeId = 1;   // 整树重建：id 分配器随新根一起归零
        root.inputs = null;
        root.opName = null;
        root.status = 'alive';
        root.exhausted = false;
        root.invalid = false;
        root.fullDead = false;
        root.fullDeathFrame = -1;
        root.segmentFrames = 0;
        root.segmentScore = 0;
        root.baseExt = 0;
        root.subtreeBest = 0;
        root.rolloutFrames = 0;
        root.rolloutSamples = null;
        root.probe = null;
        root.samples = null;
        root.simState = {
            tank: { x: realTankState.x, y: realTankState.y, rot: realTankState.rot },
            tGlobal: 0
        };
        root.tEndSec = _timeAcc;
        tree.rootAbsT = _timeAcc;
        tree.threats = threats;
        tree._hasOffsetThreats = false;   // 全新锚定，所有 threat 相对本根，无偏移
        tree._pendingThreats = [];
        ensureThreatTracks(tree, adapter, threats);
        snapshotThreatAnchors(tree, threats, tree.rootAbsT);
        tree.leaves = [root];
        tree.nodeCount = 1;
        tree.reserve = [];       // v47：整树重建，旧 reserve 全部作废
        tree.reserveCount = 0;
        tree._expandSlice = null;
        tree._lastGrowAt = 0;

        if (results && results.length) {
            if (!attachResults(tree, root, results, threats)) {
                recordStructure(tree, 'attach-fail',
                    'fresh nodeCount=' + tree.nodeCount + ' max=' + tree.cfg.maxNodes);
                return false;
            }
        } else if (!expandLeaf(tree, root, adapter, threats)) {
            recordStructure(tree, 'expand-fail',
                'fresh nodeCount=' + tree.nodeCount + ' max=' + tree.cfg.maxNodes);
            return false;
        }
        var best = tree.cfg.deepSelectEnabled
            ? pickBest(root.children)
            : pickBestChildByRolloutTotal(root.children);
        if (!best) return false;
        // v77：freshRoot 若走了 Rust 物理预测，选中节点仍需 JS 融合世界确认。
        best = confirmExecutionRoutePick(tree, adapter, best, root);

        // v46 根修：完整 9 候选留档，但不再删 8 兄弟——它们就是下一段
        // 提交的比较集和根层活预览。旧逻辑让首次提交后树立刻只剩 2 节点。
        recordCommitInfo(tree, root.children, tree._lastFreshReason || (freshRoot ? 'fresh' : 'initial'), best);
        recordShape(tree, tree._lastFreshReason || (freshRoot ? 'fresh' : 'initial'));

        tree.commitNode = best;
        tree.commitStartT = _timeAcc;
        tree.threatDirty = false;
        tree._forcedReselect = false;
        tree.stats.commits++;
        pushEvent('commit', (best.opName || '?') + '·' + best.segmentFrames + '帧');
        return true;
    }

    // ============================================================
    // 五点五、提交重选（v42：9 操作同一 tick 原子完成，不再跨帧切片）
    // ============================================================

    function startCommitSlice(tree, adapter, threats, realTankState, opts) {
        if (!realTankState || tree._commitSlice) return false;
        opts = opts || {};
        tree._commitSlice = {
            adapter: adapter,
            threats: threats,
            realTankState: realTankState,
            freshRoot: !!opts.freshRoot,
            idx: 0,
            results: [],
            computeMs: 0
        };
        return true;
    }

    /** 推进一步提交切片；返回 true 表示本次提交已完成。 */
    function stepCommitSlice(tree) {
        var slice = tree._commitSlice;
        if (!slice) return false;
        var ops = VantageSandbox.OPERATIONS;
        // v42：提交重选必须在一个 tick 内完成。跨 tick 切片时真实世界
        // 仍在 Step，而 slice.realTankState 是切片开始时的旧位姿——弹多
        // 时 perTick=1 需要 9 tick，提交完成时坦克已多走 0.2~0.3s，新根
        // 从旧位姿出发，下一段固定偏差 0.5~2m，正是 v41 JSON 里
        // alignHard 连环触发的原因。性能让位于正确性：9 操作一次算完。
        var perTick = ops.length;
        var t0 = performance.now();
        var take = Math.min(perTick, ops.length - slice.idx);
        if (take > 0) {
            var subOps = ops.slice(slice.idx, slice.idx + take);
            var partial = VantageScoring.scorePaths
                ? VantageScoring.scorePaths(slice.adapter,
                    { tank: { x: slice.realTankState.x, y: slice.realTankState.y, rot: slice.realTankState.rot }, tGlobal: 0 },
                    subOps, EVAL_FRAMES, slice.threats, treeScoringCfg(tree))
                : null;
            if (partial) {
                for (var pj = 0; pj < partial.length; pj++) {
                    partial[pj].opIndex = slice.idx + pj;
                    partial[pj].opName = ops[slice.idx + pj].name;
                    partial[pj].deathAuthority = partial[pj].deathAuthority ||
                        (partial[pj].rustPhysics ? 'rust-candidate' : 'fused');   // v60/v77/v78
                    slice.results.push(partial[pj]);
                }
                slice.idx += partial.length;
            } else {
                for (var n = 0; n < take && slice.idx < ops.length; n++, slice.idx++) {
                    var r = VantageScoring.scorePath(slice.adapter,
                        { tank: { x: slice.realTankState.x, y: slice.realTankState.y, rot: slice.realTankState.rot }, tGlobal: 0 },
                        ops[slice.idx].inputs, EVAL_FRAMES, slice.threats, treeScoringCfg(tree));
                    r.opIndex = slice.idx;
                    r.opName = ops[slice.idx].name;
                    r.deathAuthority = 'check';   // v60：单路径回退=静态checkDeath
                    slice.results.push(r);
                }
            }
        }
        slice.computeMs += performance.now() - t0;
        if (slice.idx < ops.length) return false;

        var ok = commit(tree, slice.adapter, slice.threats, slice.realTankState,
            { results: slice.results, freshRoot: slice.freshRoot });
        tree._commitSlice = null;
        return ok;
    }

    // ============================================================
    // 六、树循环 tick（挂 ai_vantage.update，每游戏帧一次）
    // ============================================================

    var _tree = null;        // 当前活树（模块级单例，AI 一局一棵）
    var _rebuildCount = 0;   // 跨树累计重建数（KPI）

    function threatSignature(threats) {
        if (!threats || !threats.length) return '';
        var ids = [];
        for (var i = 0; i < threats.length; i++) ids.push(threats[i].id);
        ids.sort();
        return ids.join(',');
    }

    /** 同步诊断：比较“树锚定折线预测的子弹位置”与“真实子弹位置”。 */
    function runDiagnostics(tree, adapter, tankState) {
        var d = tree.diag;
        d.lastCheckAt = _timeAcc;
        if (!tree.threats || !tree.threats.length) return;

        var actual = adapter.getProjectiles ? adapter.getProjectiles() : [];
        d.projectileCount = actual.length;
        d.sig = projectileSignature(actual);
        var byId = {}, i;
        for (i = 0; i < actual.length; i++) {
            if (actual[i] && actual[i].id !== undefined) byId[actual[i].id] = actual[i];
        }

        // 子弹轨迹记录：真实位置/速度 + 折线预测位置，逐帧留档。
        var tracks = d.bulletTracks || (d.bulletTracks = { actual: {}, predicted: {} });
        for (i = 0; i < actual.length; i++) {
            var ap = actual[i];
            var arrA = tracks.actual[ap.id] || (tracks.actual[ap.id] = []);
            arrA.push({
                t: _timeAcc,
                x: ap.x, y: ap.y,
                vx: ap.speedX !== undefined ? ap.speedX : 0,
                vy: ap.speedY !== undefined ? ap.speedY : 0
            });
            if (arrA.length > 600) arrA.shift();
        }

        // 真实存在但树没锚定的弹
        var anchored = {}, th;
        for (i = 0; i < tree.threats.length; i++) {
            th = tree.threats[i];
            if (th && th.id !== undefined) anchored[th.id] = 1;
        }
        var missing = [];
        for (var id in byId) {
            if (byId.hasOwnProperty(id) && !anchored[id]) missing.push(id);
        }
        if (missing.length) {
            d.missingBullets.push({ t: _timeAcc, ids: missing.slice(0, 12) });
            if (d.missingBullets.length > 30) d.missingBullets.shift();
        }

        // 锚定折线预测位置 vs 真实位置
        var relT = Math.max(0, _timeAcc - tree.rootAbsT);
        var worst = 0, worstId = null;
        for (i = 0; i < tree.threats.length; i++) {
            th = tree.threats[i];
            var act = byId[th.id];
            if (!act) continue;
            var hasTrack = !!(th.track && th.track.length);
            var pred = trackPosAt(th, relT);
            if (!hasTrack && !pred && th.path && th.speed) {
                pred = adapter.bulletPosAt(th.path, th.speed, relT);
            }
            if (!pred) continue;
            var arrP = tracks.predicted[th.id] || (tracks.predicted[th.id] = []);
            arrP.push({ t: _timeAcc, x: pred.x, y: pred.y });
            if (arrP.length > 600) arrP.shift();
            var dx = pred.x - act.x, dy = pred.y - act.y;
            var err = Math.sqrt(dx * dx + dy * dy);
            if (err > worst) { worst = err; worstId = th.id; }
        }
        refreshThreatAnchors(tree);   // v27：回填 path0Now/path0Drift/anchorAge
        d.lastBulletError = worst;
        if (worst > 0.5) {
            d.bulletDesyncs.push({ t: _timeAcc, id: worstId, error: worst });
            if (d.bulletDesyncs.length > 30) d.bulletDesyncs.shift();
            if (!tree._lastDesyncAt || _timeAcc - tree._lastDesyncAt > 0.5) {
                tree._lastDesyncAt = _timeAcc;
                pushEvent('desync', '弹差' + worst.toFixed(2) + 'm');
            }
        }

        // 执行中的 commitNode：预测位姿 vs 真实位姿
        var cmt = tree.commitNode;
        if (cmt && cmt.rolloutSamples && cmt.rolloutSamples.length) {
            var idx = Math.round((_timeAcc - tree.commitStartT) / FRAME_DT);
            idx = Math.max(0, Math.min(idx, cmt.rolloutSamples.length - 1,
                cmt.segmentFrames || cmt.rolloutSamples.length - 1));
            var ps = cmt.rolloutSamples[idx];
            if (ps) {
                var tx = tankState.x - ps.x, ty = tankState.y - ps.y;
                var terr = Math.sqrt(tx * tx + ty * ty);
                d.lastTankError = terr;
                if (terr > d.maxTankError) d.maxTankError = terr;
            }
        }
    }

    /**
     * @param {Object} ai - VantageAI 实例（取 _vantageAdapter / gameController / aiId）
     * @param {number} dt - 游戏帧时长（秒；ai_vantage 已把 Phaser 毫秒÷1000）
     */
    function tick(ai, dt) {
        var adapter = ai._vantageAdapter;
        if (!adapter) return;
        var tankState = adapter.getTankState();
        if (!tankState) return;
        // v100：杀戮场静态地形表；迷宫不变只构建一次，节点只查表。
        if (_killfieldEnabled && ai && ai.gameController && ai.gameController.getMaze) {
            try { ensureKillfield(ai.gameController.getMaze()); } catch (eKf) {}
        }
        if (_moveTarget) {
            var tile = (typeof Constants !== 'undefined' && Constants.MAZE_TILE_SIZE && Constants.MAZE_TILE_SIZE.m)
                ? Constants.MAZE_TILE_SIZE.m : 10;
            var tcx = (_moveTarget.x + 0.5) * tile;
            var tcy = (_moveTarget.y + 0.5) * tile;
            var tdx = tankState.x - tcx, tdy = tankState.y - tcy;
            if (tdx * tdx + tdy * tdy < tile * tile * 0.25) {
                clearMoveTarget();
                if (ai && typeof ai.clearDebugTarget === 'function') {
                    try { ai.clearDebugTarget(); } catch (eClearTarget) {}
                }
            }
        }

        // v41：树时间轴必须用“真实世界刚走完的那一步”的时长推进。
        // Phaser 的 physicsElapsedMS 固定 60fps，而 GameController 的
        // Box2D Step 用墙钟 delta（含 AI 计算耗时）。训练模式下
        // training_mode 在 RoundModel.update 记录了真实 _ttLastStepDt；
        // 这里直接消费它，树图竖线才与坦克实际轨迹同轴。
        var worldDt = resolveWorldDt(ai, dt);
        _lastWorldDt = worldDt;
        _timeAcc += worldDt;    // 绝对时间轴推进（跨树连续，树图竖线不归零）
        if (worldDt <= 0) {
            // 世界这一帧没有 Step（暂停/倒计时/同一真实步的重复 tick）：
            // 坦克没动，树也不长、不提交，避免“时间没走但树在长”的错轴。
            return;
        }

        // 性能：新弹检测只用 projectiles 的 id 签名，不每帧跑完整折线。
        // computeThreats 只在 建树/新弹/首次提交/段末 这些需要新鲜决策时计算。
        var sig = projectileSignature(adapter.getProjectiles ? adapter.getProjectiles() : []);
        // v65：记录每一 tick 真实看到的 projectile 集合，供死亡快照区分
        // “getProjectiles 为空”还是“computeThreats 丢失了它”。
        if (_tree) {
            var rawSight = null;
            try { rawSight = adapter.getProjectiles ? adapter.getProjectiles() : []; }
            catch (eSight) { rawSight = []; }
            // v96：预热上限用它判断“真实世界还有没有子弹”，不再被 tree.threats 暂时为空误导。
            _tree._liveProjectileCount = rawSight ? rawSight.length : 0;
            setLiveProjectilesNow(_tree._liveProjectileCount);   // v97：无弹时优先静止
            _tree.diag.lastProjectileSight = {
                t: _timeAcc,
                count: rawSight ? rawSight.length : 0,
                ids: rawSight ? rawSight.map(function(p) { return p ? p.id : null; }) : [],
                sig: sig
            };
            // v67：滚动记录每一 tick 的真实弹集合与树威胁集合，定位
            // “子弹曾经出现过又被移除”还是“从未出现”。
            _tree.diag.projectileSightLog = _tree.diag.projectileSightLog || [];
            _tree.diag.projectileSightLog.push({
                t: _timeAcc,
                count: rawSight ? rawSight.length : 0,
                ids: rawSight ? rawSight.map(function(p) { return p ? p.id : null; }) : [],
                threatCount: (_tree.threats || []).length,
                threatIds: (_tree.threats || []).map(function(t) { return t.id; })
            });
            if (_tree.diag.projectileSightLog.length > 120) {
                _tree.diag.projectileSightLog.shift();
            }
        }

        var emergency = false;
        if (_tree && _tree.active) {
            var oldSig = _tree.threatIds;
            var addedId = threatAdded(oldSig, sig);
            // v55：子弹提前消失与新增弹同等处理——先从树锚定 threats 中移除。
            var removedIds = removedIdsBetween(oldSig, sig);
            var removedAny = false;
            if (removedIds.length) {
                removedAny = removeThreatsByIds(_tree, removedIds);
                if (removedAny) {
                    _tree._lazyDirty = true;
                    pushEvent('threat', '弹消失-移除 ' + removedIds.join(','));
                }
            }
            if (addedId) {
                pushEvent('rebuild', '新弹' + (addedId || '').slice(-4));
                emergency = true;
            } else if (oldSig !== sig && !removedAny) {
                // v36：其余签名变化（理论上少弹已被上面处理）不整树重建。
                pushEvent('threat', '弹消失(保留树)');
                _tree._lazyDirty = true;
            }
            // 无论是否突发，都必须推进签名；否则同一颗新弹会让
            // emergency 每帧为真 → 每帧 commit → 只剩一根节点且 AI 不动
            _tree.threatIds = sig;
        }

        var needFresh = !_tree || !_tree.active || emergency
            || (_tree && !_tree.commitNode && !_tree._commitSlice)
            || (_tree && _tree.commitNode && !_tree._commitSlice
                && segmentEndDue(_tree, worldDt));
        var threats = null;
        if (needFresh) {
            threats = VantageScoring.computeThreats(adapter, tankState);
            threats = limitThreats(threats, MAX_EVAL_BULLETS);
        }

        if (!_tree) {
            _tree = createTree(tankState);
            _tree.active = true;
            _tree.threatIds = sig;
            _rebuildCount++;
            _tree.stats.rebuilds = _rebuildCount;
            // v96：新建树的第一个生长 tick 也要先知道真实世界有没有子弹。
            try {
                var psNew = adapter.getProjectiles ? adapter.getProjectiles() : [];
                _tree._liveProjectileCount = psNew ? psNew.length : 0;
                setLiveProjectilesNow(_tree._liveProjectileCount);
            } catch (eLive) { _tree._liveProjectileCount = 0; setLiveProjectilesNow(0); }
        }
        var tree = _tree;
        tree.tNow = _timeAcc;
        tree.diag.lastWorldDt = worldDt;
        if (worldDt < tree.diag.worldDtMin) tree.diag.worldDtMin = worldDt;
        if (worldDt > tree.diag.worldDtMax) tree.diag.worldDtMax = worldDt;
        runDiagnostics(tree, adapter, tankState);

        // v98：点击目标变化后，立刻刷新全树分数并逐层重选；然后提前结束当前段，
        // 让坦克马上开始按新目标行动，而不是等段末提交。
        if (_tree && (_moveTargetDirty || _tree._moveTargetDirty)) {
            _moveTargetDirty = false;
            _tree._moveTargetDirty = false;
            try {
                rerouteTreeForCurrentThreats(_tree, adapter);
                if (_tree.commitNode) {
                    _tree.commitNode.tEndSec = _timeAcc;
                    _tree._forcedReselect = true;
                }
                recordStructure(_tree, 'move-target-refresh',
                    _moveTarget ? (_moveTarget.x + ',' + _moveTarget.y) : 'clear');
            } catch (eTargetRefresh) {
                console.warn('[Vantage] 点击目标全树刷新失败:', eTargetRefresh);
            }
        }

        // 决策/展开统一用限流后的 threats；没有新鲜需求时沿用锚定 threats。
        var evalThreats = threats || tree.threats || [];

        // 提交切片进行中：继续推进；新弹出现则作废旧切片、用新 threats 重开。
        if (tree._commitSlice) {
            if (emergency) tree._commitSlice = null;
            else {
                stepCommitSlice(tree);
                return;
            }
        }

        if (emergency) {
            // v31/v32：新弹不整树清零。先局部追加 + 只剪“更早死亡”的节点；
            // 再用 scoreRollout 刷新下一段 9 候选分数，并提前结束当前段，
            // 让 AI 下一 tick 立即按含新弹的评分换操作（恢复老版预判反应）。
            // v46：进行中的预览切片是基于旧 threats 的，必须作废；growStep
            // 随后会用已追加新弹的 tree.threats 重开切片，避免新弹被旧切片
            // 忽略一层。
            tree._expandSlice = null;
            var nodeCountBeforePrune = tree.nodeCount;
            attachNewThreats(tree, adapter, evalThreats);
            var commitHit = invalidateStaleNodes(tree, adapter);
            if (commitHit || !tree.commitNode) {
                // 只有当前执行节点本身提前死亡（=受影响链就是整条活链）才根层重选。
                notePruneLoss(tree, nodeCountBeforePrune, 'new-bullet-root-reselect');
                pushEvent('fresh', commitHit ? 'newBulletCommitDead' : 'noCommitNode');
                tree._lastFreshReason = commitHit ? 'newBulletCommitDead' : 'noCommitNode';
                startCommitSlice(tree, adapter, evalThreats, tankState, { freshRoot: true });
                stepCommitSlice(tree);
                return;
            }
            // v68：恢复 v52 全树重选语义；但精确死亡来自融合世界。
            rerouteTreeForCurrentThreats(tree, adapter);
            // v91：新弹导致的全树剪枝在这里结束后统一结算一次补偿。
            notePruneLoss(tree, nodeCountBeforePrune, 'new-bullet-reroute');
            // v78：全树更新可能用 Rust 候选改写了当前执行节点；同 tick
            // 先由 JS 融合确认，再让后续 segmentEndDue 消费其结束时间。
            if (tree.commitNode && tree.commitNode.deathAuthority === 'rust-candidate') {
                confirmExecutionNodeDeath(tree, adapter, tree.commitNode);
            }
            tree.threatDirty = false;
            // v95：新弹改道后，如果当前执行分支已经不是树的 next，就提前结束
            // 当前段，避免 AI 明知道要换路却还沿着旧操作跑完整段。
            var cmt = tree.commitNode;
            var routeChanged = false;
            if (cmt) {
                // 找出 commitNode 所属的根层分支：从 commitNode 向上走到根的孩子。
                var oldFirst = cmt;
                while (oldFirst && oldFirst.parent && oldFirst.parent !== tree.root) {
                    oldFirst = oldFirst.parent;
                }
                if (oldFirst && oldFirst.parent !== tree.root) oldFirst = null;
                if (tree.root.next && oldFirst && tree.root.next !== oldFirst) {
                    routeChanged = true;
                }
            }
            // v39：静止段且新弹很快进入威胁圈时也提前结束。
            var staticSoon = false;
            if (!routeChanged && cmt && cmt.inputs &&
                !cmt.inputs.forward && !cmt.inputs.back &&
                !cmt.inputs.left && !cmt.inputs.right) {
                var remain = Math.max(0, cmt.tEndSec - _timeAcc);
                for (var pi = 0; pi < tree._pendingThreats.length; pi++) {
                    var pth = tree._pendingThreats[pi];
                    if (pth.tIn == null) continue;
                    var absIn = tree.rootAbsT + (pth.anchorOffset || 0) + pth.tIn;
                    if (absIn <= _timeAcc + Math.min(0.5, remain + 0.2)) { staticSoon = true; break; }
                }
            }
            if (cmt && (routeChanged || staticSoon)) {
                cmt.tEndSec = _timeAcc;
                tree._forcedReselect = true;
                pushEvent('force', routeChanged ? '新弹改道提前结束' : '静止段提前结束');
            }
        }

        // 提交心跳：无 commitNode → 首次提交；段末 → 对齐检查 + 坍缩
        if (!tree.commitNode || segmentEndDue(tree, worldDt)) {
            var nodeCountBeforeEndPrune = tree.nodeCount;
            if (tree._hasOffsetThreats) refreshCandidateScores(tree, adapter);
            var commitHit = invalidateStaleNodes(tree, adapter);
            notePruneLoss(tree, nodeCountBeforeEndPrune, 'segment-end');
            var freshRoot = !tree.commitNode || !!tree.threatDirty || commitHit;   // 首次/弹消失/当前链提前死亡
            tree._lastFreshReason = !tree.commitNode ? 'initial'
                : commitHit ? 'commitDead'
                : (tree.threatDirty ? 'threatDirty' : '');
            var forced = !!tree._forcedReselect;
            var softMisaligned = false;
            if (tree.commitNode && segmentEndDue(tree, worldDt) && !forced) {
                // 现实对齐 ②：真实位姿 vs 预测轨迹上“真实已过时间”最近样本。
                // v41：真实帧长是墙钟（16~50ms 都见过），不能拿名义段末
                // （frames×0.02）的样本硬比；用 commitStartT 以来的真实
                // elapsed 在 rolloutSamples 里取最近帧，消除固定帧长采样误差。
                var cmt0 = tree.commitNode;
                var pred = cmt0.simState && cmt0.simState.tank;
                var dPos = 0, dRot = 0;
                var elapsed = Math.max(0, _timeAcc - tree.commitStartT);
                var sampleIdx = -1;
                if (pred && cmt0.rolloutSamples && cmt0.rolloutSamples.length) {
                    sampleIdx = Math.round(elapsed / FRAME_DT);
                    var maxIdx = Math.min(
                        cmt0.rolloutSamples.length - 1,
                        cmt0.segmentFrames || cmt0.rolloutSamples.length - 1);
                    sampleIdx = Math.max(0, Math.min(sampleIdx, maxIdx));
                    var s0 = cmt0.rolloutSamples[sampleIdx];
                    if (s0) pred = { x: s0.x, y: s0.y, rot: s0.rot };
                }
                if (pred) {
                    var dx = tankState.x - pred.x;
                    var dy = tankState.y - pred.y;
                    dPos = Math.sqrt(dx * dx + dy * dy);
                    dRot = Math.abs(tankState.rot - pred.rot);
                    dRot = Math.atan2(Math.sin(dRot), Math.cos(dRot));
                }
                var ac = tree.diag.alignChecks;
                var tankObj = ai.gameController && ai.gameController.getTank
                    ? ai.gameController.getTank(ai.aiId) : null;
                var actualInputs = tankObj ? {
                    forward: !!tankObj.forward, back: !!tankObj.back,
                    left: !!tankObj.left, right: !!tankObj.right,
                    locked: !!tankObj.locked
                } : null;
                var desiredInputs = cmt0.inputs ? {
                    forward: !!cmt0.inputs.forward, back: !!cmt0.inputs.back,
                    left: !!cmt0.inputs.left, right: !!cmt0.inputs.right
                } : null;
                var inputMismatch = false;
                if (actualInputs && desiredInputs && !actualInputs.locked) {
                    inputMismatch = actualInputs.forward !== desiredInputs.forward ||
                        actualInputs.back !== desiredInputs.back ||
                        actualInputs.left !== desiredInputs.left ||
                        actualInputs.right !== desiredInputs.right;
                }
                ac.push({
                    t: _timeAcc,
                    op: cmt0.opName || '?',
                    segFrames: cmt0.segmentFrames,
                    elapsed: +elapsed.toFixed(4),
                    sampleIdx: sampleIdx,
                    frameDt: +worldDt.toFixed(4),
                    actual: { x: +tankState.x.toFixed(3), y: +tankState.y.toFixed(3), rot: +tankState.rot.toFixed(4) },
                    pred: pred ? { x: +pred.x.toFixed(3), y: +pred.y.toFixed(3), rot: +pred.rot.toFixed(4) } : null,
                    actualInputs: actualInputs,
                    desiredInputs: desiredInputs,
                    inputMismatch: inputMismatch,
                    dPos: +dPos.toFixed(4),
                    dRot: +dRot.toFixed(4)
                });
                if (ac.length > 120) ac.shift();
                if (inputMismatch) {
                    pushEvent('control', '实际输入≠树指令 ' + (cmt0.opName || '?'));
                }
                if (dPos > tree.cfg.alignPosTol || Math.abs(dRot) > tree.cfg.alignRotTol) {
                    tree.stats.alignFails++;
                    softMisaligned = true;
                    pushEvent('align', '偏差' + dPos.toFixed(2) + 'm/' +
                        (dRot * 180 / Math.PI).toFixed(1) + '°@' + sampleIdx);
                }
                if (dPos > tree.cfg.alignHardPosTol || Math.abs(dRot) > tree.cfg.alignHardRotTol) {
                    pushEvent('fresh', 'alignHard');
                    tree._lastFreshReason = 'alignHard';
                    freshRoot = true;   // 只有大幅偏差才整树重建
                }
            }
            // 正常坍缩且被选中节点已有预览子树：直接 preserve。
            // v42：commit 内部会把保留子树刚性重摆到真实根位姿，
            // 所以软超差也不再需要删子树重算（那会制造额外节点塌缩）。
            if (!freshRoot && tree.commitNode && tree.commitNode.children.length > 0) {
                if (softMisaligned) tree._lastFreshReason = 'softAlign';
                commit(tree, adapter, evalThreats, tankState, { freshRoot: false });
                return;
            }
            startCommitSlice(tree, adapter, evalThreats, tankState, { freshRoot: freshRoot });
            stepCommitSlice(tree);
            return;
        }

        // 生长一步（金线叶端延伸 1 节；v68 恢复 v52 的正常延伸节奏）。
        // 预览链必须用 commit 时锚定的 tree.threats，不能用本 tick 新 threats。
        growStep(tree, adapter, tree.threats || evalThreats);
    }

    /** 操控消费：当前应执行的操作（commitNode 整段恒定） */
    function getDesiredOperation() {
        if (!_tree || !_tree.active || !_tree.commitNode) return null;
        return {
            inputs: _tree.commitNode.inputs,
            opName: '树:' + (_tree.commitNode.opName || '?')
        };
    }

    /** 树况（testbench 树况行/渲染用） */
    function getTree() {
        if (!_tree || !_tree.active) return null;
        var t = _tree;
        var deepest = 0;
        for (var i = 0; i < t.leaves.length; i++) {
            var d = t.leaves[i].tEndSec - t.root.tEndSec;
            if (d > deepest) deepest = d;
        }
        var cmt = t.commitNode;
        var segStart = cmt ? cmt.tEndSec - cmt.segmentFrames * FRAME_DT : 0;
        return {
            root: t.root,
            leaves: t.leaves,
            nodeCount: t.nodeCount,
            reserveCount: t.reserveCount || 0,
            reuseCount: t.reuseCount || 0,
            totalNodeCount: (t.nodeCount || 0) + (t.reserveCount || 0),
            tNow: _timeAcc,
            horizonSec: deepest,
            commitNode: cmt,
            commitFrame: cmt ? Math.max(0, Math.round((_timeAcc - segStart) / FRAME_DT)) : -1,
            commitProgress: cmt ? Math.min(1, Math.max(0, (_timeAcc - segStart) / (cmt.segmentFrames * FRAME_DT))) : 0,
            stats: t.stats,
            probe: t.root.probe || null,
            cfg: t.cfg,
            commitPath: commitPathOf(t.root, t.commitNode),
            doomedSnaps: t.doomedSnaps,
            execTrail: t.execTrail,
            commitSlice: !!t._commitSlice,
            expandSlice: !!t._expandSlice,
            growSkip: !!t._growSkip,
            diag: t.diag,
            events: _events.slice(-MAX_EVENTS),
            walk: function (fn) {
                (function rec(n) {
                    fn(n);
                    for (var j = 0; j < n.children.length; j++) rec(n.children[j]);
                })(t.root);
            },
            walkAll: function (fn) {
                (function rec(n) {
                    fn(n);
                    for (var j = 0; j < n.children.length; j++) rec(n.children[j]);
                })(t.root);
                var seen = {};
                (function recReserve(list) {
                    for (var ri = 0; ri < list.length; ri++) {
                        (function recN(n) {
                            if (seen[n.id]) return;
                            seen[n.id] = 1;
                            fn(n);
                            for (var j = 0; j < n.children.length; j++) recN(n.children[j]);
                        })(list[ri]);
                    }
                })(t.reserve || []);
            }
        };
    }

    function dumpDiagnostics() {
        if (!_tree || !_tree.active) return null;
        var maxDepth = 0;
        (function walkDepth(n, depth) {
            if (!n) return;
            if (depth > maxDepth) maxDepth = depth;
            for (var di = 0; di < n.children.length; di++) walkDepth(n.children[di], depth + 1);
        })(_tree.root, 0);
        return {
            tNow: _timeAcc,
            rootAbsT: _tree.rootAbsT,
            threatIds: _tree.threatIds,
            threatDirty: !!_tree.threatDirty,
            shape: { nodeCount: _tree.nodeCount, maxDepth: maxDepth },
            totalNodeCount: (_tree.nodeCount || 0) + (_tree.reserveCount || 0),
            reserveCount: _tree.reserveCount || 0,
            reuseCount: _tree.reuseCount || 0,
            threats: (_tree.threats || []).map(function(th) {
                return { id: th.id, speed: th.speed, x: th.x, y: th.y, tIn: th.tIn };
            }),
            threatAnchors: _tree.threatAnchors || [],
            diag: _tree.diag,
            bulletTracks: _tree.diag.bulletTracks,
            stats: _tree.stats,
            events: _events.slice(-MAX_EVENTS)
        };
    }

    /** 只取某颗弹的真实/预测轨迹，便于控制台观察运动规律。 */
    function getBulletTracks(projectileId) {
        if (!_tree || !_tree.active || !_tree.diag || !_tree.diag.bulletTracks) return null;
        if (projectileId !== undefined && projectileId !== null) {
            return {
                id: projectileId,
                actual: _tree.diag.bulletTracks.actual[projectileId] || [],
                predicted: _tree.diag.bulletTracks.predicted[projectileId] || []
            };
        }
        return _tree.diag.bulletTracks;
    }

    var _lastResetSnapshot = null;   // v63：AI 死亡 reset 前的预测快照（诊断用）
    var _lastKillInfo = null;         // v66：最近一次本 AI 被击杀的击杀事件信息

    function reset() {
        if (_tree && _tree.active) {
            var cmt = _tree.commitNode;
            var eventsTail = _events.slice(-30).map(function(e) {
                return { t: e.t, type: e.type, info: e.info };
            });
            _lastResetSnapshot = {
                tNow: _timeAcc,
                rootAbsT: _tree.rootAbsT,
                threatCount: (_tree.threats || []).length,
                threatIds: _tree.threatIds,
                lastProjectileSight: _tree.diag.lastProjectileSight || null,
                projectileSightLogTail: (_tree.diag.projectileSightLog || []).slice(-50),
                killInfo: _lastKillInfo,
                threatIdList: (_tree.threats || []).map(function(t) { return t.id; }),
                commitNode: cmt ? {
                    id: cmt.id,
                    opName: cmt.opName,
                    fullDeathFrame: cmt.fullDeathFrame,
                    status: cmt.status,
                    plannedFrames: cmt.plannedFrames,
                    segmentFrames: cmt.segmentFrames,
                    tEndSec: cmt.tEndSec,
                    rolloutStartT: cmt.rolloutStartT,
                    deathAuthority: cmt.deathAuthority || '',
                    freshSig: cmt.freshSig || '',
                    windowSig: nodeWindowSig(null, cmt, _tree.threats || []),
                    staleAtDeath: nodeIsStale(null, cmt, _tree.threats || []),
                    hasCache: !!cmt.scoreCache,
                    simState: cmt.simState
                } : null,
                eventsTail: eventsTail,
                diagDeathAuditTail: (_tree.diag && _tree.diag.deathAudit || []).slice(-20)
            };
        }
        _tree = null;
        _rebuildCount = 0;
        _timeAcc = 0;
        _lastWorldDt = FRAME_DT;
        _lastSeenWorldStep = null;
        _events = [];
        _moveTarget = null;   // v92：换局/重生不保留旧点击目标
        _moveTargetDirty = false;
        _liveProjectilesNow = 0;
        if (typeof VantageSandbox !== 'undefined' && VantageSandbox.clearCaches) {
            try { VantageSandbox.clearCaches(); } catch (eCache) {}
        }
    }

    function getLastResetSnapshot() {
        return _lastResetSnapshot;
    }

    /** v66：AI 被击杀时由 ai_vantage 调用，记录凶器信息。 */
    function noteDeath(kill) {
        if (!kill) return;
        _lastKillInfo = {
            killerPlayerId: typeof kill.getKillerPlayerId === 'function' ? kill.getKillerPlayerId() : null,
            victimPlayerId: typeof kill.getVictimPlayerId === 'function' ? kill.getVictimPlayerId() : null,
            projectileId: typeof kill.getDeadlyId === 'function' ? kill.getDeadlyId() : null,
            projectileType: typeof kill.getDeadlyType === 'function' ? kill.getDeadlyType() : null
        };
    }

    /** 评估深度可调（testbench 固定帧滑块联动，1~300） */
    function setEvalFrames(v) {
        var n = Math.max(1, Math.min(300, Math.round(v || 75)));
        EVAL_FRAMES = n;
        return n;
    }

    /** v47：树内车道压分开关。true=0.5，false=0；跨树保持，并同步当前活树。 */
    function setLaneEnabled(v) {
        _lanePenaltyRatio = v ? 0.5 : 0;
        if (_tree && _tree.cfg) _tree.cfg.lanePenaltyRatio = _lanePenaltyRatio;
        return _lanePenaltyRatio;
    }

    /** v53：树内弹簧绳距离评分开关；跨树保持，并同步当前活树。 */
    function setSpringRopeEnabled(v) {
        _springRopeEnabled = !!v;
        if (_tree && _tree.cfg) _tree.cfg.springRopeEnabled = _springRopeEnabled;
        return _springRopeEnabled;
    }

    /** v69：Rust 最小决策实验开关；跨树保持，并同步当前活树。 */
    function setRustMinimalEnabled(v) {
        _rustMinimalEnabled = !!v;
        if (_tree && _tree.cfg) _tree.cfg.rustMinimalEnabled = _rustMinimalEnabled;
        return _rustMinimalEnabled;
    }

    /** v77：无子弹也生长树实验开关；跨树保持，并同步当前活树。 */
    function setGrowWithoutThreatsEnabled(v) {
        _growWithoutThreatsEnabled = !!v;
        if (_tree && _tree.cfg) _tree.cfg.growWithoutThreats = _growWithoutThreatsEnabled;
        return _growWithoutThreatsEnabled;
    }

    /** v80：软死节点执行时长上限比例（死亡帧 × ratio，向下取整）。 */
    function setDeathDurationRatio(v) {
        var n = Number(v);
        if (!isFinite(n)) n = 0.5;
        _deathDurationRatio = Math.max(0.1, Math.min(1.0, n));
        if (_tree && _tree.cfg) _tree.cfg.deathDurationRatio = _deathDurationRatio;
        return _deathDurationRatio;
    }

    /** v85：节点数上限开关。 */
    function setNodeCapEnabled(v) {
        _nodeCapEnabled = !!v;
        if (_tree && _tree.cfg) _tree.cfg.nodeCapEnabled = _nodeCapEnabled;
        return _nodeCapEnabled;
    }

    /** v85：时间视界开关。 */
    function setHorizonCapEnabled(v) {
        _horizonCapEnabled = !!v;
        if (_tree && _tree.cfg) _tree.cfg.horizonCapEnabled = _horizonCapEnabled;
        return _horizonCapEnabled;
    }

    /** v91：预测时长上限（秒，1~15）。 */
    function setHorizonSec(v) {
        var n = Number(v);
        if (!isFinite(n)) n = 8.0;
        n = Math.round(n * 10) / 10;
        _horizonSec = Math.max(1.0, Math.min(15.0, n));
        if (_tree && _tree.cfg) _tree.cfg.horizonSec = _horizonSec;
        return _horizonSec;
    }

    /** v91：新弹剪枝后每帧额外补偿层数（0~9）。 */
    function setPruneCompensateLayers(v) {
        var n = Math.round(Number(v));
        if (!isFinite(n)) n = 0;
        _pruneCompensateLayers = Math.max(0, Math.min(9, n));
        if (_tree && _tree.cfg) _tree.cfg.pruneCompensateLayers = _pruneCompensateLayers;
        return _pruneCompensateLayers;
    }

    /** v91：剪枝补偿持续帧数（1~60）。 */
    function setPruneCompensateFrames(v) {
        var n = Math.round(Number(v));
        if (!isFinite(n)) n = 1;
        _pruneCompensateFrames = Math.max(1, Math.min(60, n));
        if (_tree && _tree.cfg) _tree.cfg.pruneCompensateFrames = _pruneCompensateFrames;
        return _pruneCompensateFrames;
    }

    /** v92：点击地面设置“末端姿态目标”。只作为安全分平局时的裁决，
     *  不再直接接管 AI 驾驶。 */
    function setMoveTarget(tileX, tileY) {
        var x = Math.round(Number(tileX));
        var y = Math.round(Number(tileY));
        if (!isFinite(x) || !isFinite(y)) return null;
        _moveTarget = { x: x, y: y };
        _moveTargetDirty = true;   // v98：点击后全树重选
        if (_tree) {
            recordStructure(_tree, 'move-target', x + ',' + y);
            _tree._moveTargetDirty = true;
        }
        return _moveTarget;
    }

    function clearMoveTarget() {
        _moveTarget = null;
        _moveTargetDirty = true;
        if (_tree) {
            recordStructure(_tree, 'move-target-clear', '');
            _tree._moveTargetDirty = true;
        }
        return null;
    }

    function getMoveTarget() {
        return _moveTarget ? { x: _moveTarget.x, y: _moveTarget.y } : null;
    }

    /** v88：持续细化开关；开启后每 tick 主动拆一次长操作。 */
    function setContinuousRefine(v) {
        _continuousRefine = !!v;
        if (_tree && _tree.cfg) _tree.cfg.continuousRefine = _continuousRefine;
        return _continuousRefine;
    }

    /** v89：真死回退最多向上多少节点（1~32）。 */
    function setRetreatNodes(v) {
        var n = Math.round(Number(v));
        if (!isFinite(n)) n = 3;
        _retreatNodes = Math.max(1, Math.min(32, n));
        _retreatDepth = _retreatNodes;   // 旧别名同步
        if (_tree && _tree.cfg) {
            _tree.cfg.retreatNodes = _retreatNodes;
            _tree.cfg.retreatDepth = _retreatNodes;
        }
        return _retreatNodes;
    }

    /** v90：真死回退最多向上多少帧（10~600）。 */
    function setRetreatFrames(v) {
        var n = Math.round(Number(v));
        if (!isFinite(n)) n = 200;
        _retreatFrames = Math.max(10, Math.min(600, n));
        if (_tree && _tree.cfg) _tree.cfg.retreatFrames = _retreatFrames;
        return _retreatFrames;
    }

    /** v89：无子弹预热阶段的节点上限（100~3000）。 */
    function setWarmupMaxNodes(v) {
        var n = Math.round(Number(v));
        if (!isFinite(n)) n = 500;
        _warmupMaxNodes = Math.max(100, Math.min(3000, n));
        if (_tree && _tree.cfg) _tree.cfg.warmupMaxNodes = _warmupMaxNodes;
        return _warmupMaxNodes;
    }

    /** v88 旧接口：真死回退向上搜索层数，等价于 setRetreatNodes。 */
    function setRetreatDepth(v) {
        return setRetreatNodes(v);
    }

    /** v85：达到上限后继续细化长操作。 */
    function setRefineBeyondLimits(v) {
        _refineBeyondLimits = !!v;
        if (_tree && _tree.cfg) _tree.cfg.refineBeyondLimits = _refineBeyondLimits;
        return _refineBeyondLimits;
    }

    /** v84：调整活动节点数上限（100~3000）。 */
    function setMaxNodes(v) {
        var n = Math.round(Number(v));
        if (!isFinite(n)) n = 500;
        _maxNodes = Math.max(100, Math.min(3000, n));
        if (_tree && _tree.cfg) _tree.cfg.maxNodes = _maxNodes;
        return _maxNodes;
    }

    /** v98：评分范围开关；true=只算操作时长内帧分，false=固定 75 帧。 */
    function setScoreOnlyPlanned(v) {
        _scoreOnlyPlanned = !!v;
        if (_tree && _tree.cfg) _tree.cfg.scoreOnlyPlanned = _scoreOnlyPlanned;
        return _scoreOnlyPlanned;
    }

    /** v100：供 tick 和测试设置“真实子弹数”；无弹时优先静止。 */
    function setLiveProjectilesNow(v) {
        var n = Math.floor(Number(v));
        if (!isFinite(n) || n < 0) n = 0;
        _liveProjectilesNow = n;
        return _liveProjectilesNow;
    }

    /** v100：杀戮场地形引导开关。 */
    function setKillfieldEnabled(v) {
        _killfieldEnabled = !!v;
        if (!_killfieldEnabled) { _killfieldGrid = null; _killfieldMazeRef = null; }
        if (_tree && _tree.cfg) _tree.cfg.killfieldEnabled = _killfieldEnabled;
        return _killfieldEnabled;
    }

    /** v100：杀戮场权重（0~1）。 */
    function setKillfieldWeight(v) {
        var n = Number(v);
        if (!isFinite(n)) n = 0.5;
        n = Math.round(n * 100) / 100;
        _killfieldWeight = Math.max(0, Math.min(1, n));
        if (_tree && _tree.cfg) _tree.cfg.killfieldWeight = _killfieldWeight;
        return _killfieldWeight;
    }

    /** v94：混合选路开关——目标分直接进入总分，可能牺牲一点安全换靠近目标。 */
    function setTargetMixEnabled(v) {
        _targetMixEnabled = !!v;
        if (_tree && _tree.cfg) _tree.cfg.targetMixEnabled = _targetMixEnabled;
        return _targetMixEnabled;
    }

    /** v95：目标分占比系数（0~3，对应 0~300%），只在混合选路开启时生效。 */
    function setTargetMixRatio(v) {
        var n = Number(v);
        if (!isFinite(n)) n = 0.5;
        n = Math.round(n * 100) / 100;
        _targetMixRatio = Math.max(0, Math.min(3, n));
        if (_tree && _tree.cfg) _tree.cfg.targetMixRatio = _targetMixRatio;
        return _targetMixRatio;
    }

    /** v81：深层选路实验开关；默认关闭，开启后 subtreeBest 参与 next/commit。 */
    function setDeepSelectEnabled(v) {
        _deepSelectEnabled = !!v;
        if (_tree && _tree.cfg) _tree.cfg.deepSelectEnabled = _deepSelectEnabled;
        return _deepSelectEnabled;
    }

    /** v80：每 tick 最多生长的完整节点层数（1~6）。 */
    function setGrowLayersPerTick(v) {
        var n = Math.round(Number(v));
        if (!isFinite(n)) n = 1;
        _growLayersPerTick = Math.max(1, Math.min(6, n));
        if (_tree && _tree.cfg) _tree.cfg.growLayersPerTick = _growLayersPerTick;
        return _growLayersPerTick;
    }

    // ============================================================
    // 导出（03 七节接口契约）
    // ============================================================
    global.VantageTree = {
        FRAME_DT: FRAME_DT,
        EVAL_FRAMES: EVAL_FRAMES,
        TREE_DEFAULTS: TREE_DEFAULTS,
        createTreeNode: createTreeNode,
        createTree: createTree,
        attachChild: attachChild,
        detachChild: detachChild,
        probeSegment: probeSegment,
        expandLeaf: expandLeaf,
        growStep: growStep,
        pickGrowLeaf: pickGrowLeaf,
        commit: commit,
        commitPathOf: commitPathOf,
        tick: tick,
        getDesiredOperation: getDesiredOperation,
        getTree: getTree,
        dumpDiagnostics: dumpDiagnostics,
        getBulletTracks: getBulletTracks,
        reset: reset,
        getLastResetSnapshot: getLastResetSnapshot,
        noteDeath: noteDeath,
        setEvalFrames: setEvalFrames,
        setLaneEnabled: setLaneEnabled,
        setSpringRopeEnabled: setSpringRopeEnabled,
        setRustMinimalEnabled: setRustMinimalEnabled,
        setGrowWithoutThreatsEnabled: setGrowWithoutThreatsEnabled,
        setDeathDurationRatio: setDeathDurationRatio,
        setGrowLayersPerTick: setGrowLayersPerTick,
        setScoreOnlyPlanned: setScoreOnlyPlanned,
        setKillfieldEnabled: setKillfieldEnabled,
        setKillfieldWeight: setKillfieldWeight,
        ensureKillfield: ensureKillfield,
        killfieldScoreAtTank: killfieldScoreAtTank,
        setLiveProjectilesNow: setLiveProjectilesNow,
        setTargetMixEnabled: setTargetMixEnabled,
        setTargetMixRatio: setTargetMixRatio,
        setDeepSelectEnabled: setDeepSelectEnabled,
        setMaxNodes: setMaxNodes,
        setNodeCapEnabled: setNodeCapEnabled,
        setHorizonCapEnabled: setHorizonCapEnabled,
        setHorizonSec: setHorizonSec,
        setPruneCompensateLayers: setPruneCompensateLayers,
        setPruneCompensateFrames: setPruneCompensateFrames,
        notePruneLoss: notePruneLoss,
        setRefineBeyondLimits: setRefineBeyondLimits,
        setContinuousRefine: setContinuousRefine,
        setMoveTarget: setMoveTarget,
        clearMoveTarget: clearMoveTarget,
        getMoveTarget: getMoveTarget,
        setRetreatNodes: setRetreatNodes,
        setRetreatFrames: setRetreatFrames,
        setWarmupMaxNodes: setWarmupMaxNodes,
        warmupCapReached: warmupCapReached,
        setRetreatDepth: setRetreatDepth,
        reactivateMatchingReserves: reactivateMatchingReserves,
        invalidateStaleNodes: invalidateStaleNodes,
        threatCoarseBox: threatCoarseBox,
        nodeCoarseBox: nodeCoarseBox,
        pruneExpiredReserves: pruneExpiredReserves,
        detachChildIntoReserve: detachChildIntoReserve,
        applyRolloutScore: applyRolloutScore,
        nodeWindowSig: nodeWindowSig,
        nodeIsStale: nodeIsStale,
        ensureLayerFresh: ensureLayerFresh,
        findFirstStaleLayer: findFirstStaleLayer,
        findFirstOutsideStaleLayer: findFirstOutsideStaleLayer,
        verifyFreshness: verifyFreshness,
        lazyUpdateBudgetForPathDepth: lazyUpdateBudgetForPathDepth,
        removedIdsBetween: removedIdsBetween,
        refreshCandidateScores: refreshCandidateScores,
        rerouteTreeForCurrentThreats: rerouteTreeForCurrentThreats,
        fullRolloutTotalOf: fullRolloutTotalOf,
        pickBestChildByRolloutTotal: pickBestChildByRolloutTotal,
        backpropBest: backpropBest,
        pickBest: pickBest,
        routeAvgOfLeaf: routeAvgOfLeaf,
        bestRouteLeafInSubtree: bestRouteLeafInSubtree,
        applyRetreatAfterExpand: applyRetreatAfterExpand,
        pickRetreatLeaf: pickRetreatLeaf
    };

    console.log('[Vantage Tree] 模块已加载（段制 v100：杀戮场地形引导 + 点击全树刷新 + 混合选路 + 无弹优先静止 + Rust评分）');
})(typeof window !== 'undefined' ? window : this);
