# 临时施工计划（弹簧绳 + 新弹性能）2026-08-23

> 临时文件：施工完成后归档/删除。只记录已确认口径，防止多波施工丢语义。

## 总原则
- 角度遮蔽拷贝区成品代码一行不改；只存每弹单独遮蔽区间，在缓存层重算并集。
- 每次选新路/commit/回退前，候选层必须先更新到该节点时间线上的真实子弹集合。
- 节点几乎不删；时间线真实不可达才随探索作废。缓存挂在节点上，内存换速度。
- 子弹消失（打死对手/弹种提前停用）与新增弹同等处理：标 stale，增量更新。

## 第一波：弹簧绳评分 + 开关（已完成）
- 墙距定义：坦克样本 A 与同帧弹位 B 的可见图最短路；直线不穿墙=欧氏。
- 墙整理成轴对齐矩形并按 maze 缓存；候选点=A/B + 30m 内矩形角点；
  任意候选对连线不进入墙内部则连边，A* 求最短路。
- 分数：w=clamp((d_ref-d)/(d_ref-d_near),0,1)；多弹 p=1-Π(1-w)；
  单帧距离分=clearanceCap*p。参数 d_near=4 / d_ref=30 / cap=8 进 cfg。
- 接入 scorePath / scoreRollout / scorePaths 三条路径，死亡/车道/卡墙不变。
- 开关默认开启：VantageTree.setSpringRopeEnabled + tree.cfg.springRopeEnabled +
  treeScoringCfg 透传 + testbench 面板开关。
- 版本：scoring v25/?v=26；tree v53/?v=61；testbench v49/?v=49。

## 第二波：节点帧缓存 + 惰性金线刷新
- 节点保存 75 帧窗口内应含子弹 id 集合；比对实际应有集合判断新增/删除。
- 每帧缓存：每弹遮蔽区间、弹簧绳乘积 p、车道压分、帧净分。
- 新弹增量：
  - 空间/时间粗筛；帧内离坦克超过影响半径直接跳过；
  - 角度并集：直接用“更新前并集结果”与“新弹单独遮蔽区间”做 1 次并集；
  - 弹簧绳：p_new=1-(1-p_old)(1-w_new)；
  - 车道：只算新弹后取 max；
  - 死亡：只在与轨迹可能接触的帧 checkDeath。
- 删弹增量：删区间重算并集；p 重算；若死亡帧由该弹造成，剩余弹重判。
- 金线刷新前沿：从根沿金线找到首个 stale 节点；该点前不动；
  此后逐层更新候选→选 next→前沿前进。
- 节奏（已定稿）：
  - 金线所在路线最外层层数 <=5：每 tick 1 更新 + 1 延伸；
  - 最外层层数 >5：每 tick 3 更新 + 0 延伸；
  - 金线外：需要用到时主动更新；主线刷完后空闲时缓慢更新，
    每 tick 9 个节点（约1层）。
- 更新不重新模拟坦克，只做已有 rollout 帧上的增量评分；死亡剪枝仍全局空间+时间粗筛。

## 第三波：父子 75 帧重叠复用
- 父节点同操作 actual 帧后继续预测；子节点同操作直接复用父 75 帧尾部
  (75-actual) 帧缓存与样本，只补缺的 actual 帧。
- 其余 8 操作：坦克模拟重新做，但子弹逐帧位置/墙图/轨迹盒共享。
- 展开切片期间新弹仍作废旧切片重开，只在稳定威胁集合内复用。

## 第四波：动态预测窗口
- 预测窗口 = 当前时刻 → 最后一颗活跃子弹消失；上限 cfg.horizonSec。
- 只有短弹：短窗口；混普通弹：按最晚消失继续；无弹：不深预测不空转。
- 不是按最短寿命截断；窗口内任意时刻仍有至少一颗弹就继续。

## 第五波：校验
- 离线对照：惰性增量 vs 全量重评分，选路结果必须一致。
- 场景：新弹/同帧多弹/连续多弹/弹消失/回退金线外/父子重叠复用。
- 运行期 verifyFreshness 沿金线报告 stale。

## 之后（另立计划）
- 高性能语言重写 + 神经网络评分/选路，参考文档再议。

## 波次拆分与接口细节（2026-08-23 补充）

### 第一波检查点（完成后必须验证）
- `VantageScoring.springRopeLength` 与 `springRopeFrameScore` 存在；
- `VantageTree.setSpringRopeEnabled(true/false)` 生效；
- 评分三条路径 frameNet 均含距离分；关闭时帧分与旧版逐位一致（用开关关掉后对照旧公式测试）；
- 墙环境按 maze 缓存；角度拷贝区未改。

### 第二波：评分模块增量缓存接口（第1部分已完成，在 vantage_scoring.js 内，不动树决策）
新增 `scoreRolloutCached(adapter, samples, tGlobalStart, inputs, frames, threats, cfg, prevCache)`：
- 返回 `{ result, cache }`；result 与 scoreRollout 完全同构。
- cache 挂在节点上，结构：
  ```
  cache = {
    sig: "bulletId,....",          // 该节点 75 帧窗口内实际有效的威胁 id 排序签名
    frames: [                      // 下标 k=1..75（0 为起点帧无评分）
      {
        bulletArcs: {id:[{start,end},...]},   // 每颗弹单独遮蔽区间（成品函数单弹输出）
        freeIntervals: [{start,end,width}],   // 合并后的剩余角
        springWeights: {id:w},                // 每弹墙距权重
        springSurvivor: 1-Π(1-w),
        laneByBullet: {id:penalty},
        lanePenalty: max,
        net: number,
        dead: bool/undefined
      }
    ]
  }
  ```
- 初始无 prevCache：全量算，并把每帧中间量写入 cache。
- 有 prevCache：
  1. 比较 threats 当前应包含 id 集合与 cache.sig，得出 added/removed；
  2. 对每个帧 k，先由 threatBulletPos 判断 added/removed 子弹在该帧是否有位置；
  3. 帧级快跳：
     - 角度/死亡影响半径 = exactGeom().R_SEMI（约3.06m）；
     - 车道影响半径 = 3.5m；
     - 弹簧绳影响半径 = d_ref=30m（先欧氏粗判）；
  4. added：
     - 新弹遮蔽区间 = occlusionIntervals(tank,[pos]) 单弹调用；用
       “旧 freeIntervals 减去新弹遮蔽区间”得到新 freeIntervals（一次区间差）；
       同时把新弹区间存入 bulletArcs 供将来移除后重算；
     - springWeights[id]=w；springSurvivor*=(1-w)；
     - laneByBullet[id]=penalty；lanePenalty=max(旧,新)；
     - death：仅当该帧新弹 pos 进入 DEATH_PREFILTER_RADIUS 才重跑
       adapter.checkDeath(全量当前位置)；其余帧沿用旧死亡结论；
  5. removed：
     - 从 bulletArcs 删该 id，用剩余区间重新并集得到 freeIntervals；
     - 从 springWeights 删 id，重算 survivor 乘积；
     - 从 laneByBullet 删 id；若旧 lanePenalty 由该弹贡献，重算 max；
     - 若旧 deathFrame 所在帧依赖 removed 弹（帧缓存有该弹且近），
       重跑该帧 checkDeath 剩余弹；若原死亡帧不再死，沿后续帧重扫。
  6. 逐帧 net 重算 = 角分 + springScore - lanePenalty - stuckPenalty；
     重新累加 totalScore/deathFrame/perFrameScores。
- 死亡帧只在 affected 帧与“原死亡帧因删弹复活”时重查，不整段重查。
- 该函数不模拟坦克，samples 永远来自节点已有 rolloutSamples。

### 第二波树层（在 vantage_tree.js，替换全量 reroute）
- 节点新增：
  - `n.scoreCache = null`；
  - `n.windowThreatIds = []`（本节点 rollout 时间窗内应含子弹 id 排序）；
  - `n.dataVersion`（缓存数据版本，随增量更新递增）。
- 新弹/弹消失 tick：
  - 先更新 `tree.threats`/`_pendingThreats`；
  - 仍跑全局死亡粗筛 `invalidateStaleNodes`（负责正在执行节点提前死的立即反应）；
  - 不再跑 v52 `rerouteTreeForCurrentThreats` 全量评分；改为把增量事件
    记入 `tree._dirtyThreatQueue`（added/removed id 列表，同一 tick 合并一次）；
  - `tree._lazyFrontier` 从“沿 commitPath 第一个 stale 节点”开始。
- 每个普通 tick 刷新节奏（用户最终口径）：
  - 金线所在路线最外层层数 <=5：1 更新层 + 1 延伸层；
  - 最外层层数 >5：3 更新层 + 0 延伸层；
  - 更新层：对该层所有候选调用 scoreRolloutCached（有 cache 走增量），
    更新 rolloutTotal/status/死亡帧，再重算父层 next；金线前沿前进一层；
  - 延伸层：现有 expandLeaf/切片照旧；
  - 前沿追上金线末端后恢复正常延伸。
- 金线外主动更新：commit fallback / 3层回退 / pickRetreatLeaf 搜索到哪层
  就先 ensure 哪层（调用 scoreRolloutCached），再参与比较。
- 金线外空闲更新：主线刷完且预算允许时，每 tick 更新 9 个节点（一层），
  优先更新离前沿最近的可选层；只更新，不延伸。
- 选路不变量：pickBestChildByRolloutTotal / attachResults 比较之前，
  被比较候选必须是 fresh（见 verifyFreshness）。

### 第三波：父子 75 帧重叠复用
- 在第二波 cache 之后实现，避免冲突。
- 父节点 p 同操作实际执行 actualFrames；子节点同操作 samples[0..75-actual]
  直接指向父 samples[actual..75]（分数/中间量同源），只补模拟尾部 actualFrames。
- 必须检查父节点死亡帧：若父 deathFrame <= actual，同操作子节点不可从该父延伸
  （现有 dead 叶不可生长已挡住）。
- 其他 8 候选：模拟新轨迹，但 threatBulletPos 帧序列、墙环境、laneBox 共享。

### 第四波：动态预测窗口
- 在树层计算 `threatHorizonEndSec = max(th.track 最后 alive 帧时间 + anchorOffset)`
  对全部 threats；无 ballistic threats=0。
- 树有效视界 = min(cfg.horizonSec, threatHorizonEndSec)；无弹时不延伸；
  混弹按最晚消失的弹；不是按最短寿命。
- `trackFramesForTree` 用有效视界；bullet-only 模拟在 active 弹全部结束后
  提前 break（不空转 Box2D Step）。

## 第二波第2部分：树层惰性刷新（已完成，不含金线外空闲更新）
（等评分模块 scoreRolloutCached 完成后发送给子代理）

- 节点新增：`n.scoreCache = null`、`n.freshSig = ''`、`n.dataVersion = 0`。
- 新增 `nodeWindowSig(tree, adapter, n)`：
  - 节点 rollout 时间窗 = [n.rolloutStartT+FRAME_DT, n.rolloutStartT+maxK*FRAME_DT]，
    maxK=min(75, samples.length-1)；
  - 每颗 threat 的时间跨度 = [anchorOffset, anchorOffset + track长度*dt]
    （track 为空则用 path 长度/speed）；
  - 与节点时间窗有交集的 id 排序后 join 成 sig。
- `nodeIsStale(adapter,n)` = !n.scoreCache || n.scoreCache.sig !== nodeWindowSig(...)
  或 tree 有 dirty 事件导致 cache 版本落后（以 sig 为准即可）。
- `ensureLayerFresh(tree, adapter, parent)`：
  - 对 parent.children 每个可选候选调用 `VantageScoring.scoreRolloutCached(..., prevCache=c.scoreCache)`
    （威胁传 tree.threats 全量；cfg 传 treeScoringCfg(tree)）；
  - 把返回 result 通过现有 `applyRolloutScore` 写回节点（会更新 rolloutTotal/status/
    deathFrame/segmentScore/subtreeBest），并把 cache 存回 n.scoreCache、n.freshSig=result.sig；
  - 全部候选更新后调用 `backpropBest(parent)`；
  - 若 parent.next 不 fresh 或已失效，用 `pickBestChildByRolloutTotal(parent.children)` 重选 next。
- `findFirstStaleLayerOnPath(tree, adapter)`：
  - path = commitPathOf(tree.root, tree.commitNode)；
  - 从 path[0] 开始，检查 path[i] 的 children 层是否含任一 stale 可选节点；
  - 命中返回 parent=path[i]；全 fresh 返回 null。
- tick 刷新节奏（用户最终口径，不再变）：
  - pathDepth = commitPath.length - 1；
  - pathDepth <= 5：本 tick 最多推进 1 层 `ensureLayerFresh`，然后照常 growStep 1 层；
  - pathDepth > 5：本 tick 最多推进 3 层 `ensureLayerFresh`，不 growStep；
  - ensureLayerFresh 推进到叶子后若 leaf 可选且可生长，允许同 tick 走 growStep。
- 新弹 emergency：
  - attachNewThreats + invalidateStaleNodes 照旧；
  - commitHit/freshRoot 分支照旧；
  - 否则只设置 `tree._lazyDirty = true`，**删除对 rerouteTreeForCurrentThreats 的全量调用**；
  - 下一普通 tick 由上面的节奏沿金线更新。
- 弹消失：
  - 在 tick 检测 `oldSig !== sig && !addedId` 时设置 `tree._lazyDirty = true`；
  - 不 freshRoot，交给同一 lazy 机制；死亡剪枝照旧可跑。
- 金线外：
  - 主动使用（commit fallback / pickRetreatLeaf / pickBestGrowLeaf 比较之前）：
    对即将比较的 parent 调用 ensureLayerFresh，再参与比较；
  - 空闲更新：主线 fresh 后，每 tick 最多更新 1 层金线外 stale 层（9 个节点），
    只更新不延伸；优先选离 commitPath 近、时间深度浅的 stale 层。
- `refreshCandidateScores` 与 `commit` 内刷新全部改为调用 ensureLayerFresh 当前比较层；
  不得再直接调 scoreRollout 全量而绕过 cache。
- 校验：新增只读 `VantageTree.verifyFreshness()`，遍历 commitPath 与当前比较层，
  返回 stale 列表；正常应 0。
- 事件：`lazy-layer-updated`（父id、更新数、耗时ms）、`lazy-frontier`（pathDepth、预算）。

## 第二波第3部分：树层收尾（已完成）

- 子弹提前消失会从 `tree.threats` / `_pendingThreats` 中移除 threat，与新增弹同等处理；新增 `removedIdsBetween`。
- 金线外空闲更新：主线 fresh 后每 tick 最多更新 1 层金线外 stale 层，只更新不延伸；新增 `findFirstOutsideStaleLayer`。
- 新增只读 `verifyFreshness()`。
- `pickRetreatLeaf` / `bestRouteLeafInSubtree` 比较前先 `ensureLayerFresh`。

## 第二波第4部分：恢复延伸修正（已完成）

- 修复 `pathDepth>5` 且主线全部 fresh 后树停止延伸的问题。
- tick 尾部 growStep 条件改为：
  `pathDepth<=5 || !mainlineHasStale || lazyReachedGrowableLeaf`。
- testbench 增加 lazy 系列事件标签（v50）。

## 第四波：已完成（弹簧绳修复+无弹不预测+轨迹提前停）

- 弹簧绳距离分改为扣分；可见图角点可见性预计算；默认关闭。
- 无子弹时树不预测、不延伸；首次提交仍建根层 9 候选。
- `simulateBulletTracks` 在所有子弹停用后提前 break，不再空转 Step。

## 踩坑与待议归档
- 详见 `docs/Vantage躲弹实现/踩坑记录-时间轴与真死回退.md`。
- 已确认待修：时间轴单位错位；刷新后真死回退缺失。
- 弹簧绳：性能优化思路只记录，暂不施工；符号已修，默认关。

## 修复波：已完成（tree v58）

- 新弹死亡剪枝时间轴统一为绝对时间。
- 刷新后重新判定真死回退。
- 死亡更新审计与 prune detail 修正。

## 语义回退（v68，已完成）
- 备份：`game_core/_rollback_backup_v67/`。
- v54~v67 的惰性刷新/复杂回退已撤销；恢复 v52 全树 reroute + 正常延伸。
- 保留融合死亡权威、时间轴修复、无弹不预测、诊断快照。
