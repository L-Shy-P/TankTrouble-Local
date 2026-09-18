# 外接 AI 接入方案：Killfield（把"算法"搬进我们引擎）

> 主人 2026-09-08 定的方向：**转 Killfield**。理由（主人的判断 + 工程事实）：
> Killfield 是**算法**（射线密度场 + 生存展望 + MPC），不是训练好的黑箱；
> 我们可以在**自己的引擎里重写它的思想**，用**我们自己的物理**做前向模拟，
> 于是它天生适应我们的手感，教它用道具也容易。
> 规矩不变：参考工程只读；要改先拷贝一份（副本在 `game_core/external_ai/killfield/`）。

---

## 一、源工程里各文件的耦合面（已核实）

| 文件 | 行数 | 依赖 | 处理 |
| --- | --- | --- | --- |
| `field.js` | 412 | 仅 `constants.js` | **已拷贝**（只改 import） |
| `risk.js` | 114 | 仅 `constants.js` | **已拷贝**（改了视野常量的时间折算） |
| `chain.js` | 96 | `constants.js` + `tuning.js` | **已拷贝**（只改 import） |
| `mirror.js` | 39 | 无 | **已拷贝**（原样） |
| `tuning.js` | 72 | 无 | **已拷贝**（原样） |
| `sandbox.js` | 100 | `game.js`/`laika.js`/`rng.js` | **不搬**：这是我们用**我们引擎**重写的那一层 |
| `score.js` | 377 | 上面全部 + `laika.js` + `sandbox.js` | **改编**：MPC 结构照抄，前向模拟换我们的 |
| `teacher.js` | 347 | 他们的训练管线 | 不需要 |

## 二、我们这一侧新增的两个文件

- `game_core/external_ai/killfield/constants.js`：**量纲折算表**（见下）。
- `game_core/external_ai/killfield/gameView.js`：
  - `buildGameView(maze)`：把我们迷宫翻译成 `field.js` 要的 5 样东西
    （`walls` 墙盒 / `wallHalfT` 墙半厚 / `reachable` 可达格 / `maze` 尺寸 / `scale` 格子大小）
    ＋ 它额外要的 `wallHit(x,y)`（采样点是否在墙里）和 `distMap(x,y)`（BFS 距离二维表，引导场用）。
  - `buildCombatView(state)`：给 `risk.js`/`score.js` 的战场视图（坦克 + 子弹）。
  - `snapshotFromGameController(gc, myId)`：从我们 `gameController` 抓快照（引擎相关的一小段集中在此）。

## 三、单位换算（这类移植最容易翻车的地方）

| | 他们 | 我们 |
| --- | --- | --- |
| 帧率 | 25 fps | **50 fps** |
| 一格 | `scale`（他们按 50 标定） | 10 米 |
| 弹速 | 4.5 px/帧 @SCALE50 → **2.25 格/秒** | 20 米/秒 → **2.0 格/秒** |
| 弹速存法 | 子步（`BULLETHITCHECKINTERVALS = 7` 子步/帧） | 米/秒 → 视图里折成**米/帧** |
| 同时最多子弹 | 5 | 5（一样） |

由此两条铁律：
1. **视图里给"每帧速度"**，并把 `BULLETHITCHECKINTERVALS` 设为 **1**。
2. **所有以"帧"计的常量都要按时间折算**（×2）：
   - `field.js`：`DEFAULT_FLIGHT_FRAMES = 3 × C.FPS` → 自动正确（3 秒）✓
   - `risk.js`：`RISK_HORIZON` 由 `30`（@25fps）改成 `Math.round(1.2 × C.FPS)` = 60 ✓ **已改**
   - `score.js`（待改编时）：`MPC_HORIZON 36 → 72`、`MPC_HOLD 8 → 16`、
     `COMMIT_MOVE_FRAMES 4 → 8`、`COMMIT_TURN_FRAMES 2 → 4`、`OWN_BULLET_GUARD_HORIZON 24 → 48`

## 四、已通过的验证

| 套件 | 验的是什么 | 结果 |
| --- | --- | --- |
| `diff_killfield_field.js` | 逆杀戮场在我们的迷宫上：敌人格不是最佳射击格、视线格有票、**射程外（>6 格）为 0**、瞄准角误差 2.5°、**左右镜像票数完全一致（最大差 0）** | PASS |
| `diff_killfield_risk.js` | 来袭风险：近正对 0.79、视野边缘 0.04、**视野外 0**、飞走 0、斜过 0；**反弹回来命中距离 0.00、风险 0.73**；10 颗弹 **0.025ms** | PASS |

性能（我们 12×10 测试迷宫，JIT 预热后）：

| 逆杀戮场射线数 | 512 | 1024 | 2048 |
| --- | --- | --- | --- |
| 单次耗时 | **3.54ms** | 4.62ms | 7.35ms |

他们的 Rust 版 512 射线只要 0.285ms（原生）——**JS 版不能每帧全量重建**。

## 五、性能设计（关键决定）

逆杀戮场只依赖 **迷宫 + 敌人所在格**（与坦克精确位姿无关！）→
**按"敌人所在格"缓存**，敌人换格才重建。再加：

1. **用 512 条射线**（不是他们的 2048；那是给原生 Rust 的），约 3.5ms/格；
2. **每帧最多建 1 格**（预算内），其余沿用缓存；
3. **开局倒计时/无弹预热阶段**把常见格先算好（我们是本地建局，地图已知）；
4. 风险与弹道是 0.0X ms 级，可以每帧跑。

## 六、还没做（下一步）

1. **`score.js` 的 MPC 改编**（我们的版本）：
   - 18 个计划 = 9 个移动控制 ×（不开火 / 原地先开一枪再走）；
   - **移动轨迹**用我们现成的高性能批量：Rust `vt_score_paths`（9 操作一次算完，≈1.2ms）；
   - **开火收益/自杀风险**用我们自己的弹道（`ai_tactics.js` 的 `checkFiringPath` / 我们融合世界）；
   - 对手模型先用 **L1（冻结对方当前按键）**，不用他们的 LaikaAI；
   - 评估项照抄他们的结构：密度场（导航/瞄准）+ 生存展望 + 射击收益 + 弹药/自杀/闲置惩罚。
2. **"Add Killfield" 大厅按钮**：复用 Hybrid 那套接线（`killfield_` 前缀 → 独立坦克 → 每帧提交输入），
   只换大脑；`dodge` 九项先验正好可以用这里算出的密度场填。
3. **道具**：在候选里加"去捡箱子 / 用道具"，价值项单独给。
