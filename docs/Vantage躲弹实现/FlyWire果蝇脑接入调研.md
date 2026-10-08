# FlyWire 果蝇脑接入调研（2026-10-02）

> 起因：主人看到"果蝇大脑被完整扫描并开源，有人把它接进各种小游戏，玩得都很好"，
> 想知道怎么下载、怎么接到 Vantage 的树上。
>
> 结论先说：**能下、能跑、而且有一条对躲弹特别对口的通路；但它不是"下载一个
> 神经网络丢进去就能赢"，接法必须自己设计。** 下面是逐条核实过的东西。
>
> ⚠️ **2026-10-02 口径修正**：主人指出树是**数据结构**，要换掉的是
> 评分/选路/生长/回退等**树操作**，树本身只留物理模拟 + 增量预测（对标 Hybrid）。
> 本文 §5~§6 的"接入路线"是按旧口径（把反射层当独立模块）写的，
> **已被《树决策NN接管方案-2026-10-02.md》取代**。
> 本文的 §1~§4（数据是什么、怎么下、数据长什么样、逃逸通路实测）仍然有效。

---

## 0. 三句话结论

1. **FlyWire 给的是接线图，不是训练好的网络。** 没有权重、没有输入输出定义、
   没有"看到子弹就右转"这种东西。所谓"数字大脑玩游戏"，全部是
   **连接图当固定权重 + 自己手写感觉输入和运动输出**两端的产物。
2. **有一条通路天然对口躲弹**：果蝇的**逼近刺激逃逸（looming escape）**。
   实测 LPLC2（小物体逼近探测器）与 DNp01/DNp02/DNp04/DNp09（逃逸下行神经元）
   是**单突触直连**的。抽出来的核心子图只有 **3508 个神经元 / 11.5 万条边
   / 0.4 MB**，浏览器里逐帧跑毫无压力。
3. **对 Vantage 的正确用法不是"替换树"，是"给树补一层反射"。**
   树的强项是搜索未来、弱项是慢（《踩坑记录》里"新弹将命中时卡顿明显"）；
   这条反射通路恰好是反过来的——逐帧、亚毫秒、不需要搜索。两者互补。

---

## 1. 先纠正三个预期（避免走弯路）

### 1.1 它不是神经网络模型

FlyWire 发布的是**连接组（connectome）**：139,255 个神经元、386 万条神经元对、
3415 万个突触（`fafb/783` 的连接表实测求和，见 §3）。每条数据长这样：

```
pre_root_id, post_root_id, neuropil, syn_count, nt_type
720575940629970489, 720575940631267655, AVLP_R, 7, GABA
```

只有"谁连谁、连了几根、是什么递质"。**没有膜电位参数、没有权重学习、
没有视野映射、没有行为标签。**

### 1.2 那些 demo 到底做了什么

调研了三个代表性项目，架构完全一样：

| 项目 | 规模 | "脑"的部分 | "两端"的部分 |
|------|------|-----------|-------------|
| [snedea/flybrain](https://github.com/snedea/flybrain) | 139,255 神经元 / 2.7M 连接 | 全脑 LIF（浏览器 Web Worker，10Hz） | 手工定义的"食物/触摸/风/光/温度"刺激与"食欲/恐惧"读出 |
| [FlyBrain-HalfLife](https://github.com/Yusuftmle/FlyBrain-HalfLife) | 12,260 神经元 / 428,400 突触 | LIF + 突触延迟 + 多巴胺 STDP | **手写 FSM**：战斗反击、虚拟平衡棒、Helmholtz 视觉对准、MDN 解卡 |
| Eon Systems（2026-03 那波新闻） | 声称全脑上传 | 生物物理模型 + MuJoCo 躯体 | 被学界质疑"上传"说法夸大 |

**要点**：连 HalfLife 那种完成度，它的"行为"里很大一部分也是手写反射状态机，
连接组只承担中间一层。别指望"接上就赢"。

### 1.3 果蝇脑的带宽 vs 坦克游戏的需求

果蝇会的东西：走路、转向、逃逸起跳、趋光、觅食、理毛。**它不会"战术规划"。**
坦克游戏需要的是：预判子弹反弹路径（75 帧视界）、选射位、绕墙走位。

所以合理的分工是：

```
        ┌──────────────────────────────────────────┐
        │  Vantage 树（慢、会算未来、管战术）        │
        │   ── 仍然负责"去哪、朝哪打" ──             │
        └───────────────┬──────────────────────────┘
                        │ 安全分 / 候选打分（每帧注入）
        ┌───────────────▼──────────────────────────┐
        │  果蝇反射层（快、不需要搜索、管保命）      │
        │   ── 负责"有东西扑过来时这一下往哪闪" ──   │
        └──────────────────────────────────────────┘
```

---

## 2. 怎么下载（三种路径，全部实测过）

### 路径 A：公开 GCS 桶（★ 推荐，无需账号、无需 token）

Codex 网页应用自己就是从这儿取数的，见
[`murthylab/codex` / `codex/data/local_data_loader.py`](https://github.com/murthylab/codex/blob/main/codex/data/local_data_loader.py)：

```
https://storage.googleapis.com/flywire-data/codex/data/{dataset}/{version}/{filename}
```

实测（2026-10-02）全部匿名 200 OK：

| 文件 | 体积 | 行数 |
|------|------|------|
| `fafb/783/neurons.csv.gz` | 1.6 MB | 139,255 |
| `fafb/783/consolidated_cell_types.csv.gz` | 0.9 MB | 138,327 |
| `fafb/783/classification.csv.gz` | 0.9 MB | 139,255 |
| `fafb/783/connections.csv.gz` | 50.3 MB | 3,869,878 |
| `fafb/783/neuron_db.pickle.gz` | 126.9 MB | —（Codex 预建库，用不上） |
| `banc/888/connections_princeton.csv.gz` | 27.8 MB | 3,990,039 |
| `banc/888/neurons.csv.gz` | 2.9 MB | 158,262 |
| `mcns/1.0/connections_princeton.csv.gz` | 43.0 MB | — |
| `mcns/1.0/connection_rows_min_syn_5.pickle.gz` | 33.2 MB | — |

**本项目已封装成脚本**：`tools/flywire/flywire_fetch.py`（支持断点续传、版本列表）。

### 路径 B：Codex 官方 Download Data 门户

`Info → Download Data`（`https://codex.flywire.ai/api/download?dataset=fafb`）。
官方 FAQ 原话："For bulk analysis, export the static CSV files from Info → Download Data"；
"Copy your Codex API token from your account page and include it as `api_token`"。
**要注册账号 + token，且返回的是需要 JS 渲染的 SPA 页面**，脚本化不方便。
官方明确表态："Codex intentionally does not provide a general programmatic live-query
API for bulk access; use the static downloads instead."

### 路径 C：CAVEclient（查实时库，不是拿连接组）

```bash
pip install caveclient
```
```python
from caveclient import CAVEclient
c = CAVEclient("flywire_fafb_production")   # 需要先 auth
c.materialize.query_table("proofread_neurons")
```
用于拿**最新校对过的**标注/root_id，比静态快照新。做本项目的反射子图用不上。

### 3D 网格？

官方 FAQ 明确："Can I download the 3D meshes of neurons? **Not directly from Codex.**"
网格要走 CloudVolume / 源项目的分片桶。**本项目不需要网格。**

### 数据集怎么选（关键分叉）

| dataset | 是什么 | 神经元 | 运动神经元 | 本项目用途 |
|---------|--------|--------|-----------|-----------|
| **fafb** | 雌蝇**全脑**（v783, 2023-10） | 139,255 | ❌ | **抽反射子图用它** |
| **banc** | 脑 + 腹神经索（v888, 2026-05） | 158,262 | ✅ **805 个** | 想闭环驱动"机体"用这个 |
| **mcns** | MaleCNS v1.0 | 166,700 | ✅ | HalfLife 同款 |
| manc / maol | 神经索 / 右视叶 | — | — | 暂不用 |

> ⚠️ **fafb 是纯脑**。腿和翅的运动神经元在腹神经索里，不在这个数据集里。
> 所以 fafb 的读出层只能到"下行神经元（DN）"——即"脑想干什么"。
> 想直接拿到 leg_motor_neuron 就得换 `banc`（BANC 里 motor 类 805 个、
> descending 1,316 个、VNC intrinsic 12,851 个，实测确认）。

---

## 3. 数据长什么样（实测的列结构）

```
neurons.csv.gz              root_id, group, nt_type, nt_type_score,
                            da_avg, ser_avg, gaba_avg, glut_avg, ach_avg, oct_avg
   → 139,255 行。nt_type 是预测的神经递质（ACH/GABA/GLUT/...），
     这是**把连接图变成可用网络的关键**：给了每条边兴奋/抑制的符号。

consolidated_cell_types.csv.gz   root_id, primary_type, additional_type(s)
   → 138,327 行。primary_type 就是 LPLC2 / DNp01 / T4b 这些名字。

classification.csv.gz       root_id, flow, super_class, class, sub_class,
                            hemilineage, side, nerve
   → side 字段给左右侧，是方向编码的兜底。

connections.csv.gz          pre_root_id, post_root_id, neuropil, syn_count, nt_type
   → 3,869,878 行，突触总数 34,153,566
     按递质：ACH 19.5M / GABA 8.3M / GLUT 5.6M / SER 340K / DA 238K / OCT 96K
```

**递质符号规则**（果蝇中枢神经系统）：ACH = 兴奋（+1），GABA / GLUT = 抑制（−1）。
这个映射直接决定了 LIF 网络能不能正常工作。

---

## 4. 关键发现：逃逸反射通路可以直接抽出来

### 4.1 实测追踪

从 LPLC2（210 个，小物体逼近探测器）出发做前向 BFS：

```
LPLC2 --1 跳--> 346 个神经元，其中直接包含：
        DNp01 × 2   ← giant fiber 一线，最快的逃逸通路
        DNp02 × 2
        DNp04 × 2
        DNp09 × 2   ← 逃逸甩头
        LC4   × 26（横向抑制）
```

**单突触直连**。这条"看到东西扑过来 → 立刻躲"的通路在数据里是几跳之内的短通路，
不需要模拟整个大脑。

### 4.2 抽出来的核心子图

种子（11 类逼近/运动探测器，共 971 个）
+ 下游 1 跳（2537 个）
= **3508 个神经元 / 114,957 条神经元对 / 1,022,907 个突触**

```
递质构成：ACH 74,316 边 / GABA 24,174 / GLUT 16,467
读出层：82 个下行神经元（DN*）
输出体积：0.4 MB（gzip 压缩后的二进制）
```

下游再深一跳会炸到 30,776 个神经元（因为触达了整个视叶），所以 **1 跳是甜蜜点**。

### 4.3 LIF 验证（这条链路真的通）

`tools/flywire/lif_probe.py` 把逼近强度注入种子群，跑 300ms LIF：

| 刺激强度 | 种子群发放 | 下行群发放 | 全网发放 |
|---------|-----------|-----------|---------|
| 0.0 | 0 | 0 | 0 |
| 0.6 | 0 | 0 | 0 |
| **1.0** | **337** | **29** | **448** |
| 1.4 | 1,647 | 197 | 2,373 |
| 1.8 | 2,909 | 346 | 4,337 |

**看那个阈值跳变**：0.6 完全不动，1.0 起爆。这正是逃逸行为的特征
（逼近到一定程度才触发，不然会误触发）。而且——**这个阈值是连接组自带的，
不用手写条件判断**。

---

## 5. 接入 Vantage 的三条路线

### 路线 1：反射层（★ 推荐起步，1~2 周）

用 §4 抽出的 3508 神经元核心子图，做成一个每帧跑一次的小 LIF 网络，
它的下行神经元发放率作为一个**逐帧的反射信号**，注入树的评分或直接覆盖输入。

- **优点**：小（0.4 MB）、快（<0.5 ms/帧）、已经验证跑通、可解释（能画出哪些 DN 在放电）
- **能解决的实际问题**：《踩坑记录》里"新弹将命中时卡顿明显"——树来不及响应时，反射层先动
- **不解决**：战术、绕墙、选射位（还是树的活）

### 路线 2：连接组当结构先验的神经网络（中期，接 Hybrid 那条管线）

不把连接图当"脑"，而是当**网络结构的先验**：

- 用 3508 神经元的连接矩阵做 GNN 的邻接矩阵 / 权重初始化；
- 或者把 DN 群当作"动作头"的特征提取器，后面接一个小 MLP；
- 然后用 `参考AI/killfield-main` 里现成的 **PPO 训练管线**微调，导出成浏览器可跑的权重
  （完全复刻 Hybrid 的 `hybrid.bin` + 纯 JS 推理那套）。

- **优点**：这是唯一一条能"真的变强"的路，因为可以对着胜负做梯度
- **代价**：数据侧要补特征编码，训练侧要新开一摊

### 路线 3：全脑涌现（研究/观赏，不建议当战斗力）

全脑 139K LIF @ 10Hz 在浏览器里跑（snedea/flybrain 已证明可行，12 MB 数据）。
但它产生的是**果蝇行为**，不是坦克战术。要把它接进坦克游戏，得先回答
"60×60 小眼看到的是什么"——那已经把工作量推到另一个量级了。

---

## 6. 路线 1 的详细设计

### 6.1 感觉编码：子弹 → LPLC2 注入电流

已抽出的 `reflex_core.json` 里，327/971 个种子神经元带**方向调谐谱**
（用它的 T4/T5 上游亚型反推：T4a/T4b/T4c/T4d = 前→后 / 后→前 / 上 / 下）：

```json
{ "root_id": "7205759406199...", "type": "LPLC2", "role": "seed",
  "tuning": { "T4b": 0.42, "T5b": 0.31, "T4a": 0.15 } }
```

编码流程（每帧）：

1. 对每颗子弹算 **逼近率**：`size_growth = 速度在"指向本车"方向的分量`，
   再换算成 8 个方向扇区上的强度；
2. 加上 **time-to-impact** 做归一化（越近越强）；
3. 按扇区查表，把强度写成电流注入到该扇区对应的 LPLC2/LC4 神经元群。

> 用不着摄像机。直接**从游戏真值几何算扇区强度**比模拟视网膜更省、更准。

### 6.2 运动读出：DN → 坦克输入

读出这 8 类下行神经元的发放率（滑动窗口 ~100ms 累加）：

| 细胞类型 | 数量 | 生物学含义 | 映射到坦克 |
|---------|------|-----------|-----------|
| `DNp01` | 2 | giant fiber 逃逸（最快） | 紧急后撤 + 反向甩头 |
| `DNp04` | 2 | 逃逸 | 侧闪 |
| `DNp09` | 2 | 逃逸甩头 | 快速转向 |
| `DNp20` | 2 | 双侧转向 | 左右转向（左右差 = 转向方向） |
| `DNpe017` | 2 | 前进驱动 | 油门 |
| `MDN` | 4 | moonwalker 后退（Bidaye 2014） | 倒车 |
| `DNg12_b` | 18 | 翅膀转向 | （预留/不用） |

映射建议先做成**线性解码**（左右对称细胞放电差 → 转向；总放电 → 油门），
别一上来就手搓大状态机——那样又变成写死逻辑了，不如纯算法。

### 6.3 与树的三种耦合方式（按侵入性从低到高）

| 方式 | 做法 | 侵入性 | 建议 |
|------|------|--------|------|
| **A. 打分项** | 把 DN 放电率换成"反射安全分"，作为一个新项加到 `VantageScoring` 的操作分里 | 低 | 先做这个，好回滚 |
| **B. 平局裁决** | 只在树的分差小于阈值时，用反射偏好做裁决 | 中 | 树上已有类似机制，改动小 |
| **C. 反射覆盖** | 当 DNp01 群在 N 帧内爆发超过阈值，**直接覆盖本帧输入**（照 `_vantageManualControl` 那套接管机制） | 高 | 最后做，需要 A/B 的实测数据支撑 |

### 6.4 性能预算

- 每 LIF 步：11.5 万条边 → JS `Float32Array` 上约 **0.3~0.5 ms**
- 游戏帧 60Hz（16.7 ms/帧）→ 只占 2~3%
- 放在 **Web Worker** 里跑，主线程零阻塞（照 snedea/flybrain 的做法）
- 二进制格式与 `flybrain/sim-worker.js` 兼容，**那个 worker 可以直接抄**

---

## 7. 已交付的工具

```
tools/flywire/
├── README.md                      使用说明
├── flywire_fetch.py               下载器（GCS 直连，断点续传，列版本）
├── extract_reflex_subgraph.py     抽「逼近→逃逸」反射子图（实测 16s 跑完）
└── lif_probe.py                   LIF 体检：验证刺激-发放链路（含方向扇区分析）
```

已实测跑通的完整流程：

```bash
cd tools/flywire
python flywire_fetch.py --dataset fafb --files all
python extract_reflex_subgraph.py --data-dir _data/fafb/783 --out _data/reflex_core
python lif_probe.py --bin _data/reflex_core.bin.gz --json _data/reflex_core.json
```

产出 `_data/reflex_core.bin.gz`（0.4 MB）+ `_data/reflex_core.json`（含读出层角色标注）。
`_data/` 已加进 `.gitignore`。

---

## 8. 风险与明确不做的事

| 风险 | 说明 | 对策 |
|------|------|------|
| **语义鸿沟** | 果蝇没有"子弹"概念。"逼近"这一层能对上，"子弹会反弹"对不上 | 只借逃逸反射，不指望它做弹道预测 |
| **可能没用** | 反射层也许还不如现在的手写安全分 | 按 §6.3 的 A→B→C 递进，每步实测胜率再决定 |
| **参数敏感** | LIF 的阈值/权重/延迟都得调；我实测 0.6 不动、1.0 起爆，**太脆** | 加噪声 + 滑动窗口读出；别用单帧判定 |
| **数据集错配** | fafb 没有运动神经元 | 要闭环就换 banc（同一下载器支持） |
| **"数字大脑"新闻有水分** | Eon Systems 的"上传"说法已被学界质疑 | 只信可复现的连接表 + 自己的实测 |

**明确不做**：

- 不下载 3D 网格（用不上，且官方不提供）
- 不模拟全脑 139K（那是观赏项目，不是战斗力项目）
- 不手搓大型反射状态机（那就退化成手写 AI 了，违背"用连接组"的初衷）

---

## 9. 下一步（待主人定方向）

1. **先跑体检**：`tools/flywire/` 三个脚本跑一遍，看 §4.3 那张响应表，确认反射确实成立
2. **接 JS**：把 `sim-worker.js`（flybrain 的 LIF）改造成我们的反射层，
   输入输出按 §6.1/§6.2 接游戏状态
3. **A 方案试水**：只加一个"反射安全分"项到 `VantageScoring`，跑基准局看胜率变化
4. 若有效 → 走 B/C；若无效 → 转路线 2（当 GNN 结构先验，接 PPO 管线）

---

## 附：参考链接

- 论文：Dorkenwald, S., Matsliah, A., Sterling, A.R. et al.
  *Neuronal wiring diagram of an adult brain.* **Nature 634**, 124–138 (2024).
  <https://doi.org/10.1038/s41586-024-07558-y>
- Codex：<https://codex.flywire.ai> ｜ FAQ：<https://codex.flywire.ai/faq>
- Codex 源码：<https://github.com/murthylab/codex>（Apache-2.0）
- 数据地址：`https://storage.googleapis.com/flywire-data/codex/data/{dataset}/{version}/{file}`
- 浏览器全脑 LIF 先例：<https://github.com/snedea/flybrain>
- 连接组接游戏先例：<https://github.com/Yusuftmle/FlyBrain-HalfLife>
- fafbseg（R/Python，FlyWire 连接查询）：<https://natverse.org/fafbseg/>
