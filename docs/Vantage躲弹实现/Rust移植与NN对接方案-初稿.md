# Rust 移植与 NN 对接方案（初稿，2026-09-05）

> 状态：按主人最新方向记录。本稿只定义架构，不实施代码。
> 核心原则：**凡是不调用原游戏接口的代码，都可以考虑移植 Rust；
> 凡是死亡/碰撞/物理权威，必须留在游戏 JS 侧。**

## 一、边界定义

### 1.1 永远留在 JS / 游戏侧（原游戏接口，禁止 Rust 接管）

| 内容 | 原因 |
|---|---|
| `gameController.getTank` / `getTanks` / `getProjectiles` / `getMaze` / `getB2DWorld` | 游戏本体接口 |
| `gameController.setInputState` / `InputState` | 操作输出接口 |
| 真实世界 Box2D Step、子弹飞行、撞墙、CCD | 游戏同源物理 |
| 融合世界 `simulateFusedBatch` 的传感器 × 子弹死亡判定 | 文档规定唯一死亡权威 |
| `VantageAIManager` / `VantageAI.update` 的输入输出壳 | 换芯不换壳的边界 |

### 1.2 可以移植 Rust 的内容（目前不调用原游戏接口的纯计算）

| 模块 | 现文件 | Rust 目标 |
|---|---|---|
| 遮蔽角 / 剩余角 / 精确解析几何 | `vantage_scoring.js` 拷贝区 | 候选特征计算 |
| 车道压分 | `vantage_scoring.js` | 候选特征计算 |
| 弹簧绳墙距 | `vantage_scoring.js` | 候选特征计算 |
| 节点分数 / subtreeBest / route argmax | `vantage_tree.js` | 树价值与选路 |
| 节点存储、树拓扑、reserve/reuse | `vantage_tree.js` | 可整树存 Rust 侧 |
| NN 前向推理 | 新模块 | Rust/WASM |
| 新弹后的全局重评估 | 新模块 | Rust/WASM |
| 死亡粗筛（空间+时间包围盒） | 新模块 | Rust |
| 轨迹/弹道查表 | 新模块 | Rust（数据由 JS 喂入） |

### 1.3 一句话边界

```text
JS 负责：取游戏状态、提交输入、最终死亡确认。
Rust 负责：树、NN、特征、评分、选路、死亡粗筛。
JS ↔ Rust 之间只有数据缓冲区和明确接口，不共享对象。
```

---

## 二、主流程：NN 选路 + 选中节点才做游戏权威死亡检查

### 2.1 每帧流程

```text
1. JS 从游戏读取：
   tank pose
   projectiles（id/pose/velocity/type/lifetime）
   maze walls
   当前输入状态

2. JS 把状态序列化成扁平缓冲区，传给 Rust/WASM。

3. Rust 生成固定形状 NN 输入：
   当前决策层候选 × 候选特征
   子弹集合 × 子弹特征
   全局状态特征
   当前节点特征

4. NN 前向：
   输出当前决策层每个候选的 logits/分数
   Rust 取 argmax，得到 selected_node

5. Rust 对 selected_node 的 75 帧 rollout 做死亡粗筛：
   - 空间粗筛：子弹轨迹包围盒 vs 坦克轨迹包围盒
   - 时间粗筛：时间窗是否相交
   - 输出：需要权威确认的帧号集合

6. Rust 把 selected_node 的：
   - 起点位姿
   - 操作
   - 需要确认的帧列表
   - 对应子弹轨迹
   返回给 JS。

7. JS 只在 selected_node 的需要确认帧上跑融合世界确认。
   安全 → 提交 selected_node
   不安全 → 用 NN 的排名取下一个候选，重复 6~7；
   所有候选都失败 → 按既有回退规则重规划。
```

### 2.2 “重要死亡”的定义

```text
重要 = 当前要提交/执行的那个节点
不是 9 个候选全部检查，也不是整棵树检查
```

唯一额外需要即时检查的是：

```text
当前 commitNode 段内出现新弹
→ 只检查当前 commitNode 剩余帧
→ 死了立即重规划
```

---

## 三、新弹处理：NN 全局重评估，不再做普通评分的增量失效

按主人方向，新弹出现后：

```text
1. JS 发现 projectile id 集合变化。
2. JS 把新弹轨迹数据推给 Rust。
3. Rust 更新子弹集合特征。
4. NN 立即对当前决策层重新前向。
5. Rust 更新当前路线 next / commitNode 选择。
6. JS 只对最终选中路线做融合世界确认。
```

不再维护 v54~v67 那套复杂增量失效机制。

已有 rollout 结果、节点拓扑、子弹轨迹按“可复用资产”保留；
NN 负责在新的全局状态下重新评估，不逐节点手工传播。

---

## 四、NN 与动态树的对接

### 4.1 树动态，NN 输入必须固定

树节点数随时间变化，但 NN 每次只处理一个决策层：

```text
候选批次大小固定 = 9
子弹槽位固定 = B（例如 16 或 32）
全局标量固定
```

因此 NN 输入形状固定，树再大也不影响模型结构。

### 4.2 每个候选节点的特征草案

```text
候选操作 one-hot
当前位姿
预测末态位姿
段长
滚动 75 帧的生存信息
当前朝向 / 车头方向
与最近子弹的相对向量
被遮蔽角
弹簧绳墙距
死亡粗筛结果
历史选中频率
```

### 4.3 每颗子弹的特征草案

```text
相对位置
相对速度
到坦克距离
到达危险圈时间
是否在墙后
轨迹包围盒
弹种 / 半径 / 寿命
```

子弹用集合编码，顺序无关。

### 4.4 NN 输出

至少输出：

```text
9 个候选的分数排名
```

不输出 one-hot argmax。  
原因：死亡检查失败时，JS 可以直接按排名试下一个候选，无需重新推理。

---

## 五、死亡检查优化：Rust 粗筛 + 游戏融合世界确认

```text
Rust 粗筛目标：
  绝不允许把“可能致死”误判为“不可能致死”
  允许把“不可能致死”的帧扔掉
```

粗筛只做保守几何：

```text
子弹轨迹通道 vs 坦克轨迹通道
时间窗重叠
膨胀半径 = 坦克最大碰撞半径 + 子弹半径 + 安全余量
```

只有粗筛命中的帧，才发送给 JS 融合世界确认。

这样：

```text
没有子弹靠近 → 0 帧需要确认
远弹擦过 → 少量帧需要确认
贴脸 → 只确认该候选的少数帧
```

不再每颗新弹、每层、每候选都开一次 75 帧融合世界。

---

## 六、Rust / WASM 接口草案

### 6.1 总体接口

```text
vt_init(config)
vt_reset(round_id)
vt_set_game_state(tank_pose, bullets[], maze[])
vt_set_tree_state(nodes[], current_commit_node)
vt_add_bullet(bullet[])
vt_remove_bullet(id)
vt_decide() -> { selected_op, fallback_ops[], frames_to_verify[] }
vt_feedback(node_id, actual_result)
```

### 6.2 数据格式

```text
全部扁平 f32 / i32 缓冲区
不使用逐帧 JSON
状态描述用 manifest 记录 offset 和 shape
```

### 6.3 线程

```text
第一版：Rust/WASM 同步调用
第二版：Web Worker + SharedArrayBuffer
死亡确认永远在 JS 主线程的融合世界
```

---

## 七、性能预期

参考 killfield Hybrid 实测：

```text
Rust 512 射线密度场：0.285ms
228K 参数 NN 前向：毫秒级
WASM 低于 16.7ms 帧预算
```

Vantage 目标：

```text
Rust NN 前向：< 2ms
Rust 特征/粗筛：< 2ms
JS 死亡确认：只在选中路线上运行
普通帧主线程开销：远低于当前 v68 全树融合 reroute
```

---

## 八、主人答复与已定口径（2026-09-05 更新）

1. **只检查即将选中的路线**。按整条路线上的待检查帧数，把检查分散到多个游戏帧执行；
   从根往叶子检查；一旦检出死亡立即停止，NN 重新选路。
2. **需要排名**。排名形式优先考虑“直接由 NN 输出路线/候选排序”，不写死为节点分数
   + 固定 argmax；NN 处理树的几乎全部工作。
3. **NN 训练前期先模仿树的基本操作**，之后再做自主规划和策略学习。
4. **JS 侧已有死亡粗筛**，必须确认无漏杀；Rust 移植后粗筛仍以“不漏杀”为第一约束。
5. **当前正在执行的 commitNode 必须单独检查**：段内新弹若会让它死亡，立即重规划。
6. Transformer 以后再考虑，先保留 MLP + 子弹集合编码。
7. NN 最终目标是处理树的几乎全部工作，规则树只用于学习前期和兜底。

## 九、NN 死亡粗筛与游戏权威死亡检查的冲突处理

NN 的“死亡判断”不是权威，游戏融合世界才是。

```text
第一层：几何粗筛（Rust/JS）
  只做保守过滤，保证不漏杀

第二层：游戏融合世界
  对粗筛命中的帧做权威确认

第三层：NN 重决策
  权威检查检出死亡后：
    - 死亡结果写入 NN 输入特征
    - NN 从剩余候选/路线中重新输出排名
    - 不需要 NN 自己输出“哪些节点会死”
```

训练前期：NN 不直接学习死亡粗筛，只消费粗筛/权威检查的结果。  
训练后期若确实需要，再讨论是否给 NN 增加风险输出头；当前不增加输出量。

## 十、当前实施边界

- 本阶段只做 Rust 纯计算移植与游戏本体对接，**不实施 NN 模型**。
- NN 如何处理树的全部工作，单独成下一份设计讨论。
- 第一阶段已完成：vantage_core v1（version/wall rects/sweep danger frames/WASM/JS bridge）。


## 十一、全移植实施计划（无 NN，2026-09-05）

分三波，禁止跨波提前改接口：

1. **Rust 评分/几何核心（已完成并推送 92f77ca）**
   - 遮蔽角精确解析、车道压分、弹簧绳墙距、单帧评分；
   - 对照 JS `vantage_scoring.js` 做数值测试；cargo test 26 passed。
2. **Rust 预测树（已完成，本地 commit 03d937e，推送待网络恢复）**
   - Node/Tree、probeSegment、9 候选、next、subtreeBest、
     commit、grow、retreat；reserve/reuse 未实现；
   - 用固定 rollout 快照做确定性测试，cargo test 37 passed。
3. **无 NN AI 最小跑通 + 游戏对接（已完成，待推送）**
   - 只保留：评分、probeSegment 选段长、9 候选选最佳、最简单回退；
   - Rust headless CLI 读 JSON 候选快照并输出决策；
   - JS bridge 暴露 probeSegment / chooseBest，不替换现有树；
   - 死亡权威仍由 JS 融合世界确认；
   - minimal_decide / vantage_headless / JS bridge 最小闭环已通过 cargo test 46、headless 示例与 Node smoke；
   - 跑通后再补完整版树，最后再上 NN。

原则：
- Rust 不实现第二套物理；
- Rust 不做精确死亡判定；
- 每个模块必须有与 JS 行为一致的测试；
- JS 现有逻辑在全部替换完成前保持可回退。

## 十二、物理模拟结论（2026-09-05）

主人确认：坦克运动预测必须完美还原游戏，否则危险帧计算没有意义。
结论：

1. **Rust 不做坦克运动模拟。**
   Rust 只做树、评分、选路、粗筛。
2. **游戏 JS 的融合世界是唯一运动+死亡模拟器。**
   9 候选 rollout 由 JS 融合世界一次生成，作为 RolloutResult 快照交给 Rust。
3. **新弹出现时，坦克轨迹不需要重模拟。**
   坦克运动不依赖子弹；已生成的 rollout samples 继续有效。
   只需要：
   - Rust 用新弹轨迹对已有 samples 做几何粗筛；
   - 对当前 commitNode / 选中路线做融合世界死亡确认；
   - Rust 重新评分和重新选路。
4. **禁止每颗新弹全树融合 reroute。**
   v68 的该行为是当前发弹卡半秒的直接原因，必须移除。

## 十三、Rust 物理模拟的可行路线（2026-09-05，待确认）

目标：Rust 承担尽量多工作，但仍不能出现两套物理互相矛盾。

可选路线：

A. 移植原版 Box2D C++ 到 WASM
   - 优点：和游戏同一物理内核；
   - 难点：需要原版 Box2D 源码，工程量大，且 JS 侧 Box2D 已深度耦合。

B. Rust 使用 Rapier2d 近似物理
   - 优点：Rust 完全承担运动模拟，性能高；
   - 风险：求解器不同，轨迹必有偏差；
   - 缓解：只预测 ≤75 帧；每次 commit 从 JS 真实根位姿重同步；
     最终选中路线仍由 JS 融合世界做死亡确认。

C. JS 精确物理 + Rust 树/评分/NN
   - 优点：轨迹零偏差；
   - Rust 仍承担树、评分、选路、粗筛和未来 NN，作用并不小；
   - 当前性能问题来自全树重算，不是物理引擎本身。

建议：先做 B 的可行性原型：
- 随机 N 个状态；
- 同一操作分别用 Rust Rapier2d 与 JS 融合世界预测 75 帧；
- 统计位置/角度误差分布；
- 误差可接受才继续，否则回到 C。

## 十四、第四波：Box2D 最小子集移植（已完成，主人确认 A 方案）

只移植 Vantage 预测用到的物理功能：

1. Vec2 / Mat22 / Transform；
2. World 与 Step（0.02s、10 velocity / 10 position iterations、gravity=0）；
3. Body / Fixture / 静态墙 body；
4. PolygonShape 与 CircleShape；
5. polygon-polygon、circle-polygon 接触生成与求解器；
6. 坦克 body 速度/角速度驱动；
7. 不移植：joint、sensor、tank-tank collision、护盾、陷阱。

黄金数据来源：`game_core/js/f1a5ef972c273fb89a098cb50b0f22e7.js`（游戏同款 Box2D JS）。
差分测试：同一场景分别由 JS Box2D 与 Rust Box2D 跑 75 帧，逐帧比较位置/角度。

结果：`node rust/diff_box2d.js` 自由/无碰撞场景 **75/75 帧位置误差 0.0、角度误差 0.0，DIFF TEST PASSED**。

注意：当前差分场景未发生碰撞。子代理额外自测矩形撞墙场景，因未实现 `SolveTOI/CCD`，撞击帧附近最大位置误差约 0.0475m。要达到碰撞轨迹 1e-6 级，必须补 `b2TimeOfImpact / GJK / b2SeparationFunction / SolveTOI`。


## 十五、第五波：CCD 连续碰撞检测移植（已完成）

- `box2d.rs` 新增 `b2DistanceProxy`、`b2Simplex`、`b2Distance`、`b2SeparationFunction`、`b2TimeOfImpact`，逐行对齐游戏 JS Box2D（含 `indexA[0]==indexA[0]` 恒真分支、`Number.MIN_VALUE` 比较、TOI 根搜索 50 次/外层 1000 次上限）。
- 世界侧补齐 `Body.Advance`、接触 sensor/continuous/touching/toi 标志、`Contact::ComputeTOI` 与 `World::solve_toi`；`World::step` 按 JS 顺序 collide→solve→solve_toi→inv_dt0。
- `diff_box2d.js` 扩展为 5 个场景：自由矩形、子弹矩形撞墙、子弹圆撞墙、子弹圆贴墙滑行、高速子弹圆穿薄墙；`box2d_trace.rs` 支持 `scenes` 数组与 `shape`/`radius`/`bullet`。
- 差分结果：5/5 场景全部 PASS，位置/角度最大误差 0.0（1e-6 阈值）。

## 十六、第六波 6a：Rust 9×75 融合 rollout 批处理核心（已完成）

- 新增 `rollout.rs` + `vt_rollout_batch`（ABI v2，f64 全量、cacheId 按 AI 隔离缓存、1024 墙多边形/64 弹上限），持久化融合世界：墙、9 个候选坦克（base + bullet turret 实体夹具 + 同形传感器）、子弹槽池、跨调用 warm-starting/接触冲量，完全对齐 JS `simulateFusedBatch`。
- `box2d.rs` 补齐游戏真实设置（maxTranslation=8 / velocityThreshold=0）、夹具 category/mask 过滤、fat AABB 宽相位、SetActive/SetPositionAndAngle、TOI island 的 active/接触顺序；GJK duplicate-support 按 JS 捕获 `old_count`；`orient_pair` 固定 tank-solid×wall 顺序。
- `rollout_trace.rs` + `diff_rollout.js`：在 Node vm 中加载真实 Box2D/Constants/B2DUtils/ai_tactics/vantage_sandbox，与真实 `adapter.simulateTankBatch` 逐 op、逐帧、逐 deathFrame 对比，7 个场景（含持久 warm-start 和旋转坦克撞底墙）位置 1e-9、角度 1e-9、死亡帧完全一致。
- 踩坑：JS `b2TimeOfImpact` 在 separation<=totalRadius 分支的目标值是 `0.02 * totalRadius`，不是 `0.02 * separation`；Rust 首版抄错导致旋转坦克撞墙场景最大误差 7.5e-6m。已修正并新增单元回归测试。
- `cargo test` 60 passed；`node rust/diff_box2d.js`、`node rust/diff_rollout.js` PASS；wasm32 release 构建通过。

## 十七、第六波 6b：Rust 物理 opt-in 接入游戏（已完成核心接线）

- `VantageRustBridge.rolloutBatch` 封装 `vt_rollout_batch`（单块内存、8 字节对齐、输出视图调用后重建；cacheId 由 aiId FNV-1a 生成）。
- `VantageSandbox` v28：`setRustPhysicsEnabled(true)` 后 `adapter.simulateTankBatch` 优先走 Rust；先调用 0 帧 `simulateFusedBatch` 复用游戏真实子弹放置/槽位逻辑，墙多边形取自融合世界缓存，Rust 只做预测；失败/无效一律回退 JS 融合世界。
- 试验工作台 v53 新增“Rust物理”复选框（默认关）；index.html 版本号同步（sandbox v28 / bridge v2 / testbench v53）；wasm 已重编（28KB→124KB）。
- 新增 `diff_rollout_bridge.js`：真实 vm 加载 sandbox+wasm，对同一场次分别走 JS 融合世界与 Rust opt-in 路径，9op×76 样本 + 死亡帧逐项对比，含第二次持久 warm 调用，位置/角度 1e-9 PASS。
- 验证：cargo test 60 passed；diff_box2d / diff_rollout / diff_rollout_bridge 全部 PASS；node --check 通过；wasm32 release 构建通过。

## 十八、第六波 6b 修复：融合世界此前其实一直被静默禁用

- 实测报错 `shape.GetVertex is not a function`。游戏 Box2D 的 `b2PolygonShape` 只有 `GetVertices()/GetVertexCount()`，`cloneFusedShape` 误用 `GetVertex()`。
- 该异常被 `scorePaths` 的 try/catch 吞掉后回退单路径静态检测，因此 JS 融合世界实际上长期没有生效；Rust 路径把它暴露出来。
- v29 修复：clone 多边形改用 `GetVertices()`；`diff_rollout.js` / `diff_rollout_bridge.js` 移除 GetVertex polyfill，防止测试掩盖真实接口问题。
- 修复后 diff_rollout / diff_rollout_bridge 仍 1e-9 PASS。注意：这会让 JS 融合世界真正参与全树重路由，v68 的性能尖峰会比之前更真实，下一步必须撤 v68。

## 十九、第七波 7a：增量重评分 + 死亡验证核心（Rust 侧已完成）

- 新模块 `rescore.rs` + `vt_rescore_nodes`（ABI v3）：输入节点已有 `rolloutSamples` 与新旧威胁 track/path，输出逐帧分数、总分、deathFrame、verifiedFrames。**坦克轨迹不再重跑**。
- 评分精确复刻 JS：track/path 查询语义、遮蔽角 `scoreFrameAlive`、车道惩罚、stuck 惩罚、死亡帧截断；弹簧绳显式返回 unsupported（JS 回退），不做静默降级。
- 危险粗筛：保守 segment-segment 包络过滤，无假阴性；无危险帧时死亡验证 0 次 world.Step。
- 死亡验证：独立单候选融合世界（墙+实体+传感器+子弹），按 cacheId+墙签名持久 warm-start，只对 danger 帧逐帧 Step(0.02,10,10) 并扫描 sensor×PROJECTILE。
- `diff_rescore.js` 7 场景全 PASS（逐帧分数 1e-9、total 1e-9、deathFrame 精确、warm 持久一致、spring unsupported 预期）。
- 性能：9 nodes×76 samples×(1/8 threats) 原生 CLI 0.314ms / 0.736ms。
- `cargo test` 69 passed；diff_rollout / diff_rollout_bridge 仍 PASS；wasm32 release 构建通过（7b 接线时再发布 wasm）。

## 二十、第七波 7b：v68 全量刷新改走存储轨迹增量评分（已完成接线）

- `VantageRustBridge` v3 新增 `rescoreNodes`（ABI v3，平铺缓冲区）；`VantageSandbox` v30 新增 `adapter.rescoreTankSamples`。
- `VantageTree` v70：`refreshFusedLayer` 先尝试 Rust 增量层刷新；仅当 Rust 物理开关开启、非弹簧绳、节点已有有效 `rolloutSamples` 时使用，失败/不支持回退原 `scorePaths`。v68 全量语义不变。
- 新差分 `diff_rescore_bridge.js`：真实 wasm 桥 + 真实 sandbox，逐帧分数 1e-9、总分 1e-9、deathFrame 精确、warm 持久一致、弹簧绳预期回退。
- 版本：sandbox v30 / bridge v3 / tree v70 / testbench v54；wasm 已重编（~174KB，ABI v3）。
- 实测 Node VM：`rescoreTankSamples` 9节点×76样本×1威胁 约 **2.35ms**，JS 融合重算 约 **17.7ms**（约 7.5 倍）。待浏览器实测 v68 全树刷新效果。

## 二十一、第七波 7b 补丁：激光半径 0 与大量子弹回退修复

- 实测发现：激光 `Constants.LASER.RADIUS.m = 0`，桥接层把 radius<=0 判为非法，导致 laser 全部回退 JS 融合世界；这就是单发激光掉帧 >5 的主因。
- 修复：Rust/WASM 与 JS 桥全面允许 `bulletRadius = 0`（游戏合法点弹）；`vt_rollout_batch` 子弹上限 64→256，双管/混战大量子弹不再触发“回退融合世界”。
- 新增 `diff_rollout_rescore_edge.js`：真实 wasm 桥验证 0 半径 180m/s 激光、120 发同时在场、激光增量重评分，轨迹/死亡帧/分数全部 1e-9 PASS。
- bridge 版本 v4（缓存穿透），wasm 重编；其余版本不变。`cargo test` 69 passed，全部 5 个差分 PASS。

## 二十二、第七波 7c：新弹全树刷新无损粗过滤

- v71：`refreshFusedLayer` 在 stale 判断后增加“新弹轨迹 × 节点完整 rollout 包围盒”粗过滤。仅当新弹粗盒与节点 4m 余量时空重叠时才重评分；4m 覆盖死亡/遮蔽(R_SEMI≈3.06m)/车道(3.5m)全部影响半径，不重叠节点只刷新签名。
- 增删混合安全：只有旧签名与当前签名的差异全部落在 `_pendingThreats` 内才允许跳过；只要存在弹消失（删弹会增分）就回退全量刷新，保证无损。
- threat/node 粗盒改为逐点遍历，消除采样漏界风险。
- 目标：双管连发时每颗新弹只触碰其弹道附近的少量节点，打破“刷新工作随新弹累积”的尖峰。

## 二十三、第七波 7d：v68 多层合并为一次 WASM 调用

- `vt_rescore_nodes` node 上限 64→512；bridge v5 / testbench v55。
- Tree v72 新增 `tryRustRescoreBatch`：先收集全树所有受影响父层的 stale 节点，按 512 分块，一次/少数几次调用 `adapter.rescoreTankSamples`，再把结果按父层切回写节点。墙/威胁轨迹拷贝与 JS↔WASM 边界开销从每层一次降为每批一次。
- 任一节点无效或 Rust 失败时整批回退原逐层刷新，语义与 v68 完全一致。

## 二十五、第七波 v75：Rust 帧级增量评分（ABI v4）

- 节点持久保存 `perFrameScores`；新弹刷新时，Rust 只重算新弹能影响的帧（遮蔽 R_SEMI+0.25 / 车道 3.5+offset+0.25 / 尾部未来盒），其余帧直接复制上一轮分数。默认 lane=0/spring=false 下与全量重算逐位一致。
- `vt_rescore_nodes` ABI v4 新增 `prev_per_frame_scores`（可空）与 `threat_is_new`；JS bridge v6/v7、sandbox v31、tree v75、testbench v58。
- 新增 cached far-away / cached crossing 差分场景；全部 5 个差分 PASS，`cargo test` 75 passed。
- 修复 v75 初版误把 rescore 代码贴进 rolloutBatch 导致 Rust 物理回退的问题；diff_rollout_bridge/diff_rescore_bridge 现在会统计 fallback warning 并作为失败。

## 二十六、第八波 v76：节点计数负数修复 + Rust 粗筛跨帧跳跃

### 问题现场
双管连射后期偶发 FPS 骤降；树结构历史出现 `n:-287`，即 `tree.nodeCount` 被扣成负数。
根因不在评分，而在 v72 批量写回：`tryRustRescoreBatch` 一次收集 37 个父层、326 个节点；
写回按先序进行，祖先候选 death-shorten 会 `invalidateDescendants` 摘除整棵子树，
但同批 jobs 仍包含已摘除的后代；后代再次 death-shorten 时对同一批后代二次 `detachChild`，
重复扣减 nodeCount。负数绕过 `maxNodes=500` 上限，树超限扩张，后续每颗新弹全树重路由都更贵。

### 修复（JS tree v76）
- `detachChild` 幂等：摘除子树时递归断开内部 `parent/parentId`；`parent.children` 不一致时只清理不扣数。
- `invalidateDescendants` 对已脱离父节点的残留 child 只 `shift`，不再二次 detach。
- `applyLayerResults` 写回前校验 `c.invalid || c.parent !== parent || !isActiveTreeNode`。
- `tryRustRescoreBatch` / `rerouteTreeForCurrentThreats` 写回后强制 `recountActiveNodes`；
  `growStep/attachResults/expandLeaf/startExpandSlice` 在 maxNodes 判定前先修负数计数。
- `tree.stats.nodeCountFixes` 记录修复次数；结构事件 `node-count-audit` 留痕。
- 回归脚本 `rust/diff_tree_nodecount.js`：祖先+后代同批死亡缩短场景，断言 nodeCount 保持 2 且后代 parent 链已断。

### 粗筛跨帧跳跃（Rust wasm v8 / bridge v8）
- 新增 `COARSE_BLOCK_FRAMES=16`。
- 坦克块盒直接使用存储样本位姿（天然包含前进+旋转）；威胁块盒按 track 索引分块，
  q 时间窗向两侧各扩半帧，块盒额外覆盖 e+1 号 track 点，保守处理 `round(q/dt)` 取整边界。
- `danger_frames_for_samples_with_chunks`：块盒距离 > `envelope + bullet_radius + DANGER_MARGIN + speed*dt` 时整块跳过，
  否则逐帧精确回退。路径弹/无 track 弹走原精确逐帧路径。
- `new_threat_affected_frames`：lane 关闭时，几何中心块盒与 track 块盒距离 > `R_SEMI+0.25` 时整块跳过；
  lane 开启时保持原精确逐帧路径（车道压分使用整条未来尾迹，块盒无法保守）。
- 新增回归测试：`danger_coarse_skip_matches_exact_for_moving_rotating_tank`、
  `affected_mask_coarse_skip_matches_exact_for_occlusion_only`，对远弹/横穿弹/中途死亡 track
  断言粗筛与逐帧精确完全一致。
- 版本：tree v76、bridge v8、testbench v59、index.html 同步；WASM 重新构建。

### 验证
- `cargo test`：77 passed。
- `diff_tree_nodecount.js` PASS。
- `diff_rescore.js / diff_rollout.js / diff_rescore_bridge.js / diff_rollout_bridge.js / diff_rollout_rescore_edge.js` 全部 PASS。

## 二十七、第九波 v77：增量死亡验证只看新子弹 + JS 执行路线死亡确认 + 无弹生长开关

### 问题
v75 已对帧分数做增量缓存，但死亡验证仍会对所有旧子弹重跑：即使节点 stale
完全由新增子弹引起，`danger_frames` 与 `verify_death_for_node` 仍把全部 threats
喂给融合验证世界，旧子弹死亡场景的增量优势被死亡验证吃光。同时 Rust 死亡帧
被直接当成执行权威写入节点，违反“最终死亡结论必须由 JS 游戏同款融合世界确认”的
既定规则。

### 修改（Rust wasm / bridge v9 / sandbox v32 / tree v77 / scoring v30 / testbench v60）
- `vt_rescore_nodes` ABI v5 新增 `node_has_prev_scores` 与 `prev_death_frame`：
  节点可携带上一轮死亡帧。`vt_version()` 返回 5。
- `score_stored_node` 支持两种增量缓存形状：上轮存活（分数长度=scored_frames）或
  上轮死亡（分数长度=旧死亡帧）。旧死亡帧视为旧弹权威，只重算旧死亡帧之前的
  受影响帧；旧死亡帧之后不再补算。
- `rescore_nodes` 在节点携带 previousScores 时进入增量死亡验证：只对
  `is_new` 的新增威胁做 danger 粗筛与融合验证，旧子弹死亡帧由 JS 侧沿用；
  Rust 输出 deathFrame 仅为新弹候选帧（无新弹或新弹不致死时输出 -1）。
- JS `applyLayerResults` 合并旧死亡帧（`c.fullDeathFrame`）与 Rust 新候选帧：
  新弹只可能让死亡更早，取更早者；旧结论胜出时沿用旧 `perFrameScores`（截断到
  旧死亡帧），新结论胜出时用 Rust 截断后的 `perFrameScores`。
- `tryRustRescoreLayer` / `tryRustRescoreBatch` 把 stale 节点按“仅新弹引起”与
  “全量刷新”分组调用 adapter，保证增量节点真的只验新弹；混合批次不再退化为
  整批全量。
- Rust 死亡帧只标 `deathAuthority='rust-candidate'`，不冒充 JS 融合权威。
  `nodeIsStale` 同步承认该标记为 fresh。
- 最终执行路线确认：`confirmNodeDeathWithJsFused` 通过临时适配器强制走
  `adapter.simulateTankBatchJsFused`（sandbox v32 新增，永不经过 Rust 物理开关），
  用 `VantageScoring.scorePaths` 对选中节点重算 JS 融合死亡结论。
  `refreshCandidateScores` 在写 `parent.next` 前确认，`commit` 在写
  `tree.commitNode`/执行状态前对 `keepBest` 确认；只确认最终执行路线，
  不对全树每个节点做 JS 复核。
- `scorePaths` 透传 `rustPhysics` 候选标记（scoring v30）：Rust 物理预测的
  死亡帧同样只作候选，进入执行路线前由 JS 融合确认。
- 新增 `TREE_DEFAULTS.growWithoutThreats=false` 与
  `VantageTree.setGrowWithoutThreatsEnabled(v)`；默认关闭保持 v57
  `grow-no-threat` 行为，开启后 `growStep` 在无 threats 时继续生长，
  供无子弹纯数据搬运/更新性能实验。testbench 实验区新增“无弹生长”复选框，
  模块加载时同步初始状态。
- 版本：tree v77、bridge v9、sandbox v32、scoring v30、testbench v60、
  index.html 同步；WASM 重新构建。

### 新增/更新测试
- Rust：`incremental_death_verification_skips_old_bullets`（旧弹不重验）、
  `incremental_death_new_bullet_moves_death_earlier`（新弹提前）、
  `incremental_death_old_death_carried_when_new_bullet_far`（旧死亡沿用）。
- JS：`rust/diff_incremental_death_merge.js` 覆盖旧死亡沿用、新弹提前、
  执行路线 JS 融合确认三个场景。
- 差分脚本版本检查更新为 ABI v5。

### 验证
- `cargo test`：80 passed。
- `diff_tree_nodecount.js` PASS。
- `diff_rescore.js / diff_rollout.js / diff_rescore_bridge.js / diff_rollout_bridge.js / diff_rollout_rescore_edge.js` 全部 PASS。
- 新增 `rust/diff_incremental_death_merge.js` PASS。


## 九操作评分 Rust CPU 路径（vt_score_paths，ABI v6）

### 目标
- 把树展开 `rolloutNine` 的 9 操作评分从 JS `VantageScoring.scorePaths`
  迁移到 Rust CPU；默认仍安全：Rust 路径只在 `RUST_PHYSICS_ENABLED=true`
  且 bridge 就绪时启用，任何失败/不支持都静默回退 JS。
- Rust 死亡帧只作候选；最终执行路线仍由 JS 融合世界确认，绝不破坏
  v77 的 `deathAuthority='rust-candidate' -> JS 确认` 链条。

### ABI v6：`vt_score_paths`
- 输入：`cache_id`、父位姿 `start_x/y/rot`、`start_t`、9 组
  `(speed, rotation_speed, moving)`、walls、真实子弹
  `(x,y,vx,vy,radius,lifeLeft,active)`、`duration_frames<=75`、
  评分 threats（`track`/`path`/`speed`/`anchorOffset`）与评分配置
  `(deathPenalty, stuckPenalty, stuckDistEps, stuckRotEps,
  lanePenaltyRatio, springRopeEnabled)`。
- 输出：每个操作的 samples（复用 `run_rollout_batch` 的融合世界轨迹）、
  `perFrameScores`（75 帧平铺，零填充）、`totalScore`、`deathFrame`、`ok`。
- 限制：`lanePenaltyRatio > 0` 或 `springRopeEnabled=true` 直接返回失败，
  由 JS `scorePaths` 回退；这保证 Rust 只跑默认安全配置（lane=0、弹簧绳关）。

### 实现路径
- 坦克轨迹与候选死亡帧复用 `rollout::run_rollout_batch`（现有融合世界，
  v2 起已与 JS `simulateFusedBatch` 差分一致）。
- 存活帧评分复用 `rescore::score_stored_node`（其内部调用
  `scoring::score_frame_alive`，f64 精确遮蔽角）。死亡帧按 JS 口径截断：
  `perFrameScores = 前 deathFrame-1 帧净分 + (-deathPenalty)`。
- 遮蔽角评分沿用 `scoring::occlusion_intervals` / `exactOcclusion`，
  与 JS 拷贝区2 同源 f64。
- JS 桥新增 `VantageRustBridge.scorePaths`（bridge v10）。
- sandbox 新增 `adapter.simulateTankBatchScored`（sandbox v33）：
  零帧融合预跑取真实子弹位姿/速度 -> `computeRustOperationSpeeds` ->
  桥接 `scorePaths`；结果映射为 `scorePaths` 口径并打
  `rustPhysics=true` / `deathAuthority='rust-candidate'`。
- tree v78 的 `rolloutNine` 优先走 `adapter.simulateTankBatchScored`；
  lane>0、弹簧绳、样本数不匹配、任何异常都静默回退
  `VantageScoring.scorePaths`。

### 差分测试
- 新增 `rust/diff_score_paths_bridge.js`：远弹、近弹、横穿、激光半径0、
  死亡五个场景，逐个比较 samples、perFrameScores、totalScore、deathFrame；
  45 op / 1533 帧全部 1e-9 内一致。
- 新增 Rust 单元测试：`score_paths_alive_far_bullet_matches_full_circle`、
  `score_paths_rejects_lane_and_spring_config`。

### 版本
- Rust ABI v6、bridge v10、sandbox v33、scoring v31、tree v78、
  testbench v61、index.html `?v=` 同步；WASM 重建。

## 二十八、第十波 v78/v79：九操作评分迁 Rust + 树死亡权威漏洞修复

### v78
- 新增 Rust ABI v6 `vt_score_paths`：复用 `run_rollout_batch` 做九操作融合
  世界轨迹与候选死亡帧，再用 `score_stored_node`/f64 遮蔽角精确评分。
- `adapter.simulateTankBatchScored` 接入 `rolloutNine`；lane>0、弹簧绳开启、
  bridge 不可用、结果不匹配一律静默回退 JS `scorePaths`。
- 离线差分：5 场景、45 操作、1533 帧，样本/每帧分/总分/死亡帧 1e-9 内一致。
- GPU 离线基准：`gpu_occlusion_bench`，只生成单帧遮蔽弧段（f32），
  区间合并与 gap 评分留 CPU；不接游戏决策。

### v79
- 树执行段死亡边界统一为 `safeFramesForDeath`。
- 当前执行节点即时死亡扫描优先 JS 融合权威，并修复差一帧、tEndSec、
  fullDeathFrame、authority 未更新的问题。
- `applyLayerResults` 同时识别 `rustCandidate`/`rustPhysics`，不再把 Rust
  物理候选误标 `fused`。
- 全树 reroute 后确认当前 commitNode；最终路线确认提前到 reserve 拓扑变更前。
- 刚性重摆后清空保留子树 `freshSig`/`scoreCache`，避免旧死亡结论保鲜。
- 新增回归脚本 `rust/diff_tree_death_shorten.js`。

### 已知未决
- GPU 基准需实机 WebGPU 浏览器验证；WGSL 浮点取余已改为加减实现，
  `main.js` 增加 error scope 报错定位。
- 弹簧绳与 lane>0 的 Rust 评分尚未支持，保持 JS 回退。
- Rust 死亡检测差分覆盖普通弹/激光/半径0/120弹；追踪导弹、地雷等
  特殊弹种尚未完全覆盖，暂不取消最终执行路线 JS 确认。

## 二十九、第十一波 v80：执行时长比例与多层生长
- `deathDurationRatio=0.5`：软死节点执行段不超过死亡帧一半；三处死亡缩短
  路径统一。
- `growLayersPerTick`：1~6，testbench 滑块调节每 tick 生长层数。
- GPU 基准修复 MapRead buffer usage 与 WGSL 浮点取余问题。

## 三十、第十二波 v81：深层选路实验
- 修复深层节点不参与常规提交选路的结构断层，提供默认关闭的
  `deepSelectEnabled` 实验开关与 testbench “深层选路”复选框。
- 开启后按子树最优回传值选 next/commit，并统一软死路线平均分口径。

## 三十一、第十三波 v82：真死回退真正改道
- 修复 retreat target 只返回不落地的结构 bug：祖先 next 写回、当前段
  必要时强制提前结束、retreatReroutes 统计。

## 三十二、第十四波 v83：软死叶可续树
- 修复 `status=dead` 被误当作终局导致树停在单层的问题；软死叶从安全
  末帧继续展开 9 候选，只有 1 帧真死才禁止生长。

## 三十三、第十五波 v84：节点上限可调与生长调度修正
- 新增节点上限滑块（100~3000），默认 500。
- 当前路径到达视界后继续生长兄弟叶子，不再直接停止。
- 面板显示节点/上限、reserve、生长停滞原因。
- GPU 基准改为默认 JS-only，WebGPU 手动确认启用。

## 三十四、第十六波 v85：生长限制开关与超限细化
- 节点上限、时间视界、超限细化三个开关独立可调；
- 超限细化会在无可生长叶时拆分长操作叶并在中间帧展开 9 候选。

## 三十五、第十七波 v86：节点上限开关穿透修复
- 四个加节点入口统一改用 canAddTreeNodes，关掉节点上限后真正可超出 maxNodes。

## 三十六、第十八波 v87：超强配置诊断
- 记录 refineSplits，面板显示生效配置与细化次数。
- 结论：超限细化只在“无普通可生长叶”时触发，与视界限耦合；
  后续若要解耦，需要单独的“持续细化”触发策略。

## 三十七、第十九波 v88：持续细化独立开关 + 回退深度可调
- 新增 `continuousRefine`（默认关），与 `refineBeyondLimits` 解耦：
  - 有普通可生长叶时，正常生长之外追加一次“拆最长操作叶→展开前缀”；
  - 无普通可生长叶时也能自己顶上；
  - 节点上限开启且未关时遵守上限，只有超限细化开启才穿透。
- 同一长操作叶用 `_refineSplit` 标记只拆一次，真死叶不再参与细化。
- 新增 `retreatDepth`（1~8，默认 3）与 testbench“回退层”滑块：
  控制真死回退从第几层祖先开始搜索；本层无活路仍继续向根找。
- testbench v72 新增“持续细化”复选框与“回退层”滑块；面板生效配置行
  增加“持续/回退”字段；超强预设会把持续细化关掉、回退层重置为 3，
  保证能复现原来实测最强配置。
- 新增回归：`rust/diff_tree_continuous_refine.js`、
  `rust/diff_tree_retreat_depth.js`。
- 边界：持续细化开启后计算量和节点增速明显上升，默认关闭；未改任何
  默认 AI 行为。

## 三十八、第二十波 v89：Rust 物理默认开 + 预热上限 + 回退双单位
- `VantageSandbox` 的 Rust 物理预测默认开启（`RUST_PHYSICS_ENABLED=true`），
  bridge 未就绪或任何 Rust 路径失败仍回退 JS 融合世界；最终执行路线的
  死亡确认仍留给 JS 融合世界。
- 新增 `warmupMaxNodes`（默认 500，100~3000）：
  - 只约束“无子弹 + 无弹生长开启”的预热阶段；
  - 关节点限/开超限细化都不能突破它；
  - 子弹出现后自动解除；
  - 面板“预热上限”滑块，停滞原因显示 `grow-warmup-cap`。
- 回退量升级为两个独立单位：
  - `retreatNodes`（1~32，默认 3）：最多向上爬多少节点；
  - `retreatFrames`（10~200，默认 200）：最多向上撤销多少帧段长；
  - 每爬一层累计该层段长，先到哪个上限就从哪里开始找替代路线；
    找不到仍继续向根，保留保命行为；
  - 旧 `setRetreatDepth`/`retreatDepth` 作为 `retreatNodes` 兼容别名保留。
- testbench v73：
  - Rust 物理默认勾选；
  - 新增“预热上限”“回退节点”“回退帧”三个滑块；
  - 三个滑块全部监听 `input` 实时写回，修复拖动时被每帧面板同步弹回的问题；
  - 超强预设重置为预热 500、回退节点 3、回退帧 200。
- 新增/重写回归：`rust/diff_tree_warmup_cap.js`、
  `rust/diff_tree_retreat_depth.js`。
- 当前版本：tree v89、sandbox v34、testbench v73、scoring v32、bridge v10、
  Rust ABI v6、index.html `?v=` 同步。

## 三十九、第二十一波 v90：开放仓库前的面板/树图交互整理
- 树图不再写死屏幕左上角：
  - 默认贴在 **地图右侧边缘**，不遮地图；
  - 地图矩形来自 Phaser `gameGroup`，换算成浏览器坐标；
  - 拿不到地图时才退到游戏画布右侧，再拿不到才退到屏幕右侧；
  - 树图和主面板都不做视口夹取，可以拖出屏幕；
  - 双击标题栏复位；手动拖动后窗口变化不强行拉回。
- 实验参数按“评分 / Rust / 生长 / 回退 / 选路”分类成行，
  文字、滑块、数值同一行；每类一种颜色；非树模式隐藏生长/回退/选路并给提示。
- 难懂名字改成直白说法，并给每个实验项加 0.5 秒悬浮说明：
  - 车道压分 → 轨迹距离评分；
  - 层/帧 → 每帧生长层数；
  - Rust最小决策 → Rust 简化选路；
  - 超强预设 → 重置配置。
- Rust 物理开启时隐藏弹簧绳评分并自动关闭，避免隐藏控件继续影响评分路径；
  轨迹距离评分等 Rust 不支持的配置仍允许选择，由沙箱自动回退 JS。
- 数据区加“运行/性能、计分/基准、当前决策、树/节点”小节；
  面板改为自然生长的纵向布局，不再限制在屏幕内。
- 回退帧上限 200 → 600（范围 10~600，默认 200），差分测试同步。
- 新增新人向文档：`docs/Vantage躲弹实现/面板使用指南-新人版.md`，
  面板内嵌“新人上手指南”折叠项。
- 版本：tree v90、testbench v75、sandbox v34、scoring v32、bridge v10、
  Rust ABI v6、index.html `?v=` 同步。

## 四十、第二十二波 v91：预测时长滑块 + 剪枝补偿
- `horizonSec` 新增 1~15 秒滑块，与“预测时长上限”开关放在一起；
- 节点数量上限开关和节点上限滑块放在一起，不再拆散；
- 生长栏整体文字颜色改为淡黄色 `#f9e2af`；
- 新增剪枝补偿：
  - `pruneCompensateLayers`：新弹剪枝后每帧额外补偿层数，0~9，默认 0；
  - `pruneCompensateFrames`：补偿持续帧数，1~60，默认 1；
  - 新弹 emergency 和段末剪枝路径都会调用 `notePruneLoss` 记录损失；
  - 补偿通过 `tree._growBoost` 叠加到 `growStep` 的正常层数上，上限 15 层；
  - 统计进入 `stats.pruneCompensations` / `growBoostLayers`。
- 实验区名字进一步按主人要求统一：
  轨迹距离评分、每帧生长层数、Rust 简化选路、重置配置、无子弹时预热、
  预热上限、节点数量上限、预测时长上限、超上限细化长路径、细化长路径、
  回退节点数/回退帧数、全局选路、弹簧绳评分、死亡不扣分。
- 新增回归：`rust/diff_tree_prune_compensation.js`。
- testbench v77：分类标题居中并加灰色分割线；“推荐预设”改名“重置配置”，
  悬浮描述为“将配置重置为作者L_Shy_P实测出的AI较强且性能不错的配置”；
  面板支持任意空白处拖动；运行/性能合成一行；删除树区重复的灰色配置行。
- testbench v78：默认直接使用重置配置；移除本地 Cookie 同意提示；
  面板/树图空白处支持拖动；树图标题和节点详情文字改成更直白的中文。
- testbench v79：取消拖动光标变化，拖动功能保留，鼠标始终默认样式。
- 版本：tree v91、testbench v78、sandbox v34、local_patch v3、scoring v32、
  bridge v10、Rust ABI v6、index.html `?v=` 同步。
