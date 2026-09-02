# Tank Trouble 游戏核心（离线本地版）

精简、可离线运行的 Tank Trouble 本地包。已内置本地 Ajax 模拟，无需联网账号即可 **1 人对战 AI**。

**版本基准:** CDN `RELEASE-2026-05-11-01`

---

## 快速开始

### 环境

- Windows / macOS / Linux
- **Python 3.7+**（仅用标准库，无需 `pip install`）

### 启动

**Windows:** 双击 `启动游戏.bat`

**命令行:**

```bash
python server.py
```

浏览器会自动打开 `http://127.0.0.1:8000/`。若未自动打开，请手动访问该地址。

> 不要直接双击 `index.html`。浏览器 CORS 限制会导致 JS/CSS 无法加载。

### 推荐游戏流程

1. 主菜单选 **1 player**
2. 选择操作方式（WASD / 方向键 / 鼠标）
3. 点 **Local game** 开始（会自动加入 AI 对手 Laika）
4. 对局下方 **Player Panel** 右侧 **「+」** 可 **Play as guest** 添加本地游客账号

修改后请 **Ctrl+Shift+R** 强制刷新，避免旧 JS 缓存。

---

## 目录结构

```
├── index.html          游戏入口（已注入本地变量、隐藏商店/论坛等）
├── server.py           本地 HTTP 服务器 + /ajax/ JSON-RPC 回退
├── 启动游戏.bat         Windows 一键启动
├── js/
│   ├── ai_strength_config.js ★ AI 决策强度/性格配置（不改物理数据）
│   ├── local_patch.js  ★ 本地模式核心补丁（Ajax 拦截、AI、游客）
│   ├── vantage_sandbox.js / vantage_scoring.js / ai_vantage.js ★ Vantage 躲弹 AI 原型（物理沙箱/评分与基准时间/AI 壳）
│   ├── vantage_testbench.js ★ Vantage 调试工作台（P 暂停游戏+AI、N 单帧递进、基准时间中间值、9 操作沙箱虚影；指引页 test_vantage_bench.html）
│   └── *.js            PageSpeed 打包后的运行时代码
├── css/                样式
├── assets/             图片、音频、图集等
├── original_js/        可读源码参考（魔改时对照用，不参与运行）
├── download_assets.py  从 CDN 补缺失资源
├── restore_from_full.py 对比并恢复缺失 JS/资源
└── copy_missing_files.py 从上级 cache 复制缺失文件
```

---

## 本地补丁做了什么

`js/local_patch.js` 在 `ajax.js` 之后加载，主要功能：

| 功能 | 说明 |
|------|------|
| Ajax 拦截 | Mock `account.createGuests`、`getAIs`、`getPlayerDetails` 等 |
| 单人 AI | 重写 `createLocalGame`，1 人局自动加 AI |
| 游客账号 | 返回完整 `playerDetails`（含颜色 `"0x427fff"` 字符串格式） |
| UI 精简 | 隐藏 Login/SignUp 弹层；AddUserBox 仅保留 Play as guest |
| 全屏模式 | 全屏按钮位于**左上角**（fixed 定位），容器使用 `position: fixed; 100vw/100vh` 铺满窗口，按窗口尺寸驱动 Phaser 重布局 |

服务端 `server.py` 的 POST `/ajax/` 与 `local_patch.js` 逻辑保持一致，作为双重保障。

---

## 常见魔改入口

| 目标 | 文件 |
|------|------|
| 改 AI 决策强度 | `js/ai_strength_config.js` ★ |
| 改 AI 性格/数量 | `js/local_patch.js` → `LOCAL_AIS`（已由 ai_strength_config 接管） |
| 改 AI/游客颜色 | `local_patch.js` / `server.py` → `AI_PLAYER_DETAILS`、`_colour_hex` |
| 改 UI 隐藏项 | `index.html` 头部 `<style>` 注入块 |
| 改游戏逻辑 | 先读 `original_js/`，再定位对应 `js/*.js` 打包文件 |
| 补缺失图片 | `python download_assets.py` 或 `python restore_from_full.py` |

### 关键 original_js 模块

| 文件 | 内容 |
|------|------|
| `ais.js+aimanager.js+ai.js...` | AI 行为 |
| `gamecontroller.js+gamemodel.js...` | 对局控制 |
| `uigamestate.js...` | 对局 UI |
| `uimenustate.js+uilobbystate.js...` | 菜单 / 大厅 |
| `ajax.js...` | 后端通信 |
| `errorbox.js+adduserbox.js...` | 游客 / 登录框 |

---

## 故障排查

| 现象 | 处理 |
|------|------|
| 页面空白 | 确认用 `server.py` 启动，看控制台 `[Local Patch]` 日志 |
| 操作图标空白 | 运行 `python download_assets.py` 补 `@2x` 输入图标 |
| Player Panel 无坦克 | 强刷缓存；检查颜色是否为 `"0x......"` 字符串 |
| 端口占用 | 修改 `server.py` 中 `PORT = 8000` |

---

## 相关文档

- **[AI 原理](../docs/AI原理.md)** — 架构、性格维度、目标/动作系统、魔改入口

---

游戏资源版权归 Tank Trouble 官方所有。本包仅供学习、本地娱乐，请勿用于商业或公开再分发官方资源。
