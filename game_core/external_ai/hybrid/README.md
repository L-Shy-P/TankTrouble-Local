# 外接 AI：Hybrid（来自 killfield-main 工程）

## 来源与"先拷贝再改"的规矩
- 原始工程：`game_core/参考AI/Hybrid/killfield-main/`（**别人写的游戏，只读、不动原件**）。
- 本目录是拷出来的**工作副本**（主人 2026-09-07 定的规矩：先拷贝一份再改）：

| 文件 | 原路径 | 说明 |
| --- | --- | --- |
| `hybrid.js` | `viewer/src/hybrid.js` | 纯 JS 推理（157 行，零依赖） |
| `hybrid.json` | `viewer/assets/hybrid.json` | 模型清单（schema 24 / 观测 1028 / 动作 18 / 228280 floats） |
| `hybrid.bin` | `viewer/assets/hybrid.bin` | 权重（913KB float32） |
| `hybrid-parity.json` | `viewer/assets/hybrid-parity.json` | PyTorch↔JS 对拍样本（obs/mask/dodge/logits/action） |

修改只改本目录副本；原件保持原样，便于随时对照。

## 接口契约（硬约束）
- 观测 `obs`：**1028 个 float**
  | 区间 | 内容 |
  | --- | --- |
  | `[0, 840)` | 12×10×7 地图网格（推理内部转 CHW） |
  | `[840, 900)` | 60 个标量 |
  | `[900, 1000)` | 10 个子弹槽 × 每个 10 个 float |
  | `[1000, 1028)` | 28 个尾部标量 |
- `mask`：10 个子弹槽是否有效
- `dodge`：**9 个**先验值（每个移动方向一个，来自他们引擎 `score::dodge_safety`）
- 输出：18 个 logits = 9 移动 ×（不开火 / 开火）；`action = argmax`
- 推理里**直接用到**的观测下标（必须逐位对齐）：

| 下标 | 含义 |
| --- | --- |
| 863 | 弹药量 `ammo` |
| 890 | 命中质量 `hit` |
| 891 | 自杀风险 `suicide` |
| 893 | 抵达时间 `eta`（×3 截到 0~1） |
| 1027 | 闲置压力来源（×25 − 8 再除 17） |

## 已做的验证
`game_core/rust/diff_external_hybrid.js`：把本目录当"外接 AI"加载，跑对拍样本，
断言 `action=14`、最大 logits 误差 < 2e-5（实测 9.5e-7）。
