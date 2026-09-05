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
3. **无 NN AI 跑通 + 游戏对接**
   - Rust headless 决策循环；
   - JS 桥只负责输入快照/输出决策；
   - 死亡权威仍由 JS 融合世界确认。

原则：
- Rust 不实现第二套物理；
- Rust 不做精确死亡判定；
- 每个模块必须有与 JS 行为一致的测试；
- JS 现有逻辑在全部替换完成前保持可回退。
