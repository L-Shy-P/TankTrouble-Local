# -*- coding: utf-8 -*-
"""奖励合成【唯一入口】（`2026-10-17` 子代理；父代理派单：主人 10 条奖惩全部落地 + 零 double-count）。

为什么单独一个文件：`train_ppo_online.py` 的 `pg_grow`/`ent_grow`/forward 区段同时有**另一个子代理在改**，
本模块把【全部奖励逻辑】搬出来 ⟹ 父文件里只剩 `reward_of()` 一行调用（`train_ppo_online.py` 只改那一处）。

────────────────────────────────────────────────────────────────────────────
【铁律零】本文件的自我约束（交付前逐条对照）
  1. 每个权重都在 `WEIGHT_SRC` 里标了【有出处】/【无出处、待主人拍】；
     `EXTRA_DEFAULTS` 里的键**父文件 DEFAULTS 里没有** ⟹ 用的是本文件的缺省值，且开机即打印（⛔ 不悄悄进默认）。
  2. 每个"推断口径"都在 `INFERRED` 里登记，并在 `stats()` 里**计数**（⛔ 不静默）。
  3. 每个"数据源缺失"都 `STATS[...] += 1` 并把该项贡献**显式置 0**（⛔ 不猜常数糊过去）。
  4. 每一项的【实际生效值】由 `_tools/training/rewards_selftest.py` 的手算样本**逐位验算**（`==`，不是 `approx`）。

────────────────────────────────────────────────────────────────────────────
【零 double-count】本文件修掉/防住的重复计（每条都有计数可核）
  D1 `legal` 被 `w_legal`(1.0) 与 `w_legal_pen`(0.05) 各乘一次（旧 `train_ppo_online.py:412/420`）
     ⟹ 只保留 `w_legal_pen`；`w_legal` 若 != 0 就【一次性打印告警】并计数（⛔ 不静默忽略）
  D2 `hit` 与 `kill` 由**同一个事件**同时 +1（`_collect_tmp.js:111` `rKill++; hitNow++;`）
     ⟹ `hit` 改成"**命中但未致死**" = `hit - kill`；一致性问题（`hit < kill`）**直接抛错**
  D3 终局帧 `result` 与 `win`/`lose` 各给一次（旧口径：胜实得 +4.0、负实得 -2.0）
     ⟹ 终局帧有 `win`/`lose`/`draw` 信号时 `result` 权重项**置 0**
  D4 双死 1v1：旧口径 `result=-0.25`（`_collect_tmp.js:213` `won===-1` 分支）
     ⟹ 双死只走 `draw`，`result` 那一路置 0（父代理派单原文）
  D5 `crate` / `draw`：采集器若已直供（`r["crate"]>0` / `r["draw"]>0`）就用采集器的，本文件**不再自己算**
"""
import math
import sys
from collections import Counter, OrderedDict

import numpy as np

# ---------------------------------------------------------------- 常量（每条都带出处）
# 帧长 0.02 s：出处 `_tools/headless/inject_fire.js:11` `var VT_FRAME_DT = 0.02;`（注释指向 `game_core/js/vantage_tree.js:816`）
FRAME_SEC = 0.02
# 地形格边长（米）：出处 `game_core/js/vantage_observe.js` `mapSizeOf()` 里 `var tile = 10;`
#   （= `Constants.MAZE_TILE_SIZE.m` 的取值；`mapW = getWidth()*tile`、`mapH = getHeight()*tile`）
TILE_M = 10.0

# 段内下标（出处：`game_core/js/vantage_observe.js` `GLOBAL_FIELDS` / `OPP_FIELDS` / `COL_FIELDS`）
# ⚠️⚠️ `global[0]/[1]` 是地图【格数】不是米：`vantage_observe.js:324-325` `g.push(ms.tilesW, ms.tilesH, ...)`
#      （`mapSizeOf()` 返回 `w = getWidth()*tile`、`tilesW = getWidth()`）⟹ 这里只有 `mapW/mapH` 的**格数**可用。
G_MAPW, G_MAPH, G_MAXPLAYERS, G_SELFX, G_SELFY = 0, 1, 5, 6, 7
OPP_ALIVE = 7        # `OPP_FIELDS[7] === 'oAlive'`
OPP_FIRE = 8         # `OPP_FIELDS[8] === 'oFire'`（1/0，-1=取不到）
ITEM_CRATE = slice(0, 3)   # `COL_FIELDS = ['cx','cy','cType']`；item 段每行 = [crate 3 维, mine 3 维]

# ---------------------------------------------------------------- 权重 / 阈值（出处登记）
# ⚠️ 这里只登记**父文件 DEFAULTS 里没有的键**；父文件已有的键（w_kill/w_draw/... ）一律从 `cfg` 取真值。
#    缺省值之所以放在本文件，是因为「⛔ 本任务不许改 `train_ppo_online.py` 除 `reward_of()` 以外的任何地方」
#    ⟹ 父文件 `DEFAULTS` 加不了键；开机 `_announce_once()` 会把"哪些值来自本文件"打到 stderr（⛔ 不悄悄生效）。
EXTRA_DEFAULTS = OrderedDict([
    # 权重全部【无出处、待主人拍】（父代理派单原文："权重（【无出处、待主人拍】）"）
    ("w_speed", 0.5),               # 【无出处、待主人拍】速通奖励上限
    ("w_fast_death", -0.5),         # 【无出处、待主人拍】"死得太快"惩罚（对称负值）
    ("speed_delta_frames", 60.0),   # 出处：父代理 `2026-10-17` 派单「时限 Δ=60 帧」
    # 道具奖励随训练轮次线性衰减到 0：0 = 不衰减（缺省）。
    #   ⚠️ 衰减**已实现并可验算**（见 selftest 的 `crate_decay` 用例），但训练器当前**没有把轮次传进来**
    #      ⟹ 缺省 0（不衰减），并在 `stats()` 里计 `crate_decay_unavailable_frames`（⛔ 不假装已接衰减）。
    ("crate_decay_train_rounds", 0),
])

WEIGHT_SRC = OrderedDict([
    # key → (值从哪来, 出处标注)
    ("w_result",        ("cfg", "【无出处、待主人拍】父文件 DEFAULTS；终局帧被 win/lose/draw 抑制（防重复计 D3/D4）")),
    ("w_survive",       ("cfg", "【无出处、待主人拍】父文件 DEFAULTS；采集器每帧写 survive=0.01")),
    ("w_legal_pen",     ("cfg", "【无出处、待主人拍】父文件 DEFAULTS；每次被拒 -0.05（`_collect_tmp.js` legal 逐帧负计数）")),
    ("w_legal",         ("ignored", "🔴 已退役：与 w_legal_pen 双重乘同一字段（D1）⟹ 只保留 w_legal_pen")),
    ("w_kill",          ("cfg", "【无出处、待主人拍】主人 10 条第 1 条（我方子弹击杀，TANK_KILLED killer/victim）")),
    ("w_kill_storm",    ("cfg", "【无出处、待主人拍】主人 10 条第 9 条；⚠️口径=【推断】(killer 缺失)")),
    ("w_hit",           ("cfg", "【无出处、待主人拍】父代理裁定 (B)；⚠️口径已改「命中但未致死」= hit-kill（D2）")),
    ("w_selfkill",      ("cfg", "【无出处、待主人拍】主人 10 条第 2 条（自己子弹打自己，强于 death）")),
    ("w_death",         ("cfg", "【无出处、待主人拍】主人 10 条第 3 条（被他人子弹打死，弱于 selfkill）")),
    ("w_death_storm",   ("cfg", "【无出处、待主人拍】主人 10 条第 8 条；⚠️口径=【推断】(killer 缺失)")),
    ("w_win",           ("cfg", "【有出处（主人 2026-10-17 原话）】「胜利的奖励绝对需要最大」⟹ +3.0")),
    ("w_lose",          ("cfg", "【无出处、待主人拍】主人 10 条第 5 条")),
    ("w_draw",          ("cfg", "【无出处、待主人拍】主人 10 条第 6 条（1v1 平局扣分）")),
    ("w_crate",         ("cfg", "【无出处、待主人拍】主人 10 条第 7 条（捡道具；可随轮次线性衰减到 0）")),
    ("w_empty_fire",    ("cfg", "【有出处（主人 2026-10-17 原话）】没子弹仍扣扳机 = 纯错 ⟹ -0.10")),
    ("w_spawn",         ("cfg", "【无出处、待主人拍】父代理裁定 (B) 真发射奖励")),
    ("w_aim",           ("cfg", "【无出处、待主人拍】父代理裁定 (B-2) 瞄准奖励（桥侧算，离散）")),
    ("w_speed",         ("EXTRA", "【无出处、待主人拍】主人 10 条第 10 条（速通）⟹ 值在 EXTRA_DEFAULTS")),
    ("w_fast_death",    ("EXTRA", "【无出处、待主人拍】速通的对称项（父代理派单 ② 表）⟹ 值在 EXTRA_DEFAULTS")),
])

INFERRED = OrderedDict([
    ("crate",        "我方格内消失的道具（⚠️不是 `getCollectibles()` 的直接归属；同格判定用 `TILE_M`，见 `TILE_M` 出处）"),
    ("kill_storm",   "`TANK_KILLED` 且 `killer` 缺失 ⇒ 判为毒雾杀（`_collect_tmp.js:110-114` 自认推断）"),
    ("death_storm",  "同上（victim 是我方）"),
    ("draw",         "`done && maxPlayers==2 && 全部对手 alive=0 && 我方本局死过`（+ `result==-0.25` 交叉核对）"),
    ("hit_nonlethal", "`hit - kill`（依据 `_collect_tmp.js:111` `rKill++; hitNow++;` ⟹ hit ⊇ kill）"),
    ("speed",        "`T_kill` = 击杀帧 − 最近一次真发射帧（⚠️起点口径为推断）；`T_min` 需采集侧提供"),
    ("fast_death",   "`T_death` = 我方死亡帧 − 最近一次对手开火帧（`oFire==1`）；`T_min'` 需采集侧提供"),
])

# 报告/验算用的固定求和顺序：⛔ 不许改成 set/dict 的任意顺序（浮点加法不结合，顺序会改末位）
ITEMS = ("result", "kill", "kill_storm", "hit_nonlethal", "selfkill", "death", "death_storm",
         "win", "lose", "draw", "crate", "speed", "fast_death",
         "survive", "legal", "empty_fire", "spawn", "aim",
         "still", "progress")   # ⭐ 稠密两项（新增在末尾 ⇒ 不影响既有求和顺序）

SUMMARY_EVERY = 5000      # 【无出处、工程默认】stderr 摘要的打印节律（只影响日志，不影响数值）

STATS = Counter()         # 进程内计数（`⛔ 不静默`：这些都是"本项为什么是 0 / 为什么是推断"的证据）
_ANNOUNCED = set()


def reset_stats():
    STATS.clear()
    _ANNOUNCED.clear()


def stats():
    return dict(STATS)


def _say(key, msg):
    """同一个 key 只打印一次（stderr），但 `STATS` 每次都计数。"""
    STATS[key] += 1
    if key not in _ANNOUNCED:
        _ANNOUNCED.add(key)
        print("[rewards] " + msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- 取数（⛔ 取不到就报错，带诊断）
def _seg(f, name):
    """段取数：兼容【训练器内部帧】（顶层 `f["<seg>"]`）与【采集器原始 JSON】（`f["obs"]["<seg>"]`）。"""
    v = f.get(name)
    if v is not None:
        return np.asarray(v, dtype=np.float64)
    obs = f.get("obs")
    if isinstance(obs, dict) and name in obs:
        return np.asarray(obs[name], dtype=np.float64)
    raise AssertionError(
        "[rewards] 帧里既没有顶层 %r、也没有 obs[%r] —— 实际键：%s。⛔ 拒绝猜（奖励要读观测就必须真读到）"
        % (name, name, sorted(f.keys())))


def _glb(f):
    g = _seg(f, "global")
    if g.ndim != 2 or g.shape[0] != 1 or g.shape[1] < 38:
        raise AssertionError("[rewards] global 段形状应为 (1,>=38)，实际 %s" % (g.shape,))
    return g[0]


def _opp(f):
    o = _seg(f, "opp")
    if o.ndim != 2 or o.shape[1] < 9:
        raise AssertionError("[rewards] opp 段形状应为 (rows,>=9)，实际 %s" % (o.shape,))
    return o


def _real_opp_rows(opp):
    """挑出"真对手行"：`oppRows()` 用 0 补空槽 ⟹ 全零行是空槽（⛔ 不是"已死的对手"）。

    1v1 里对手行可能整行恰好全零（对手刚死且位置被写成 0）⟹ 兜底：一行都挑不出时**只认第 0 行**并计数。
    """
    nz = np.any(opp != 0.0, axis=1)
    rows = opp[nz]
    if rows.shape[0] == 0:
        STATS["opp_rows_all_zero"] += 1
        return opp[:1]
    return rows


# ---------------------------------------------------------------- 逐局状态（crate 差分 / T_kill / 双死）
class _EpiState(object):
    """⚠️ 奖励要"跨帧"，而 `reward_of(f, cfg)` 每帧只拿一帧 ⟹ 必须留状态。

    局边界=**帧序号 `t` 回到 0**（采集器 `frames.push({t:f})` 每局从 0 起）。
    跳帧/倒序一律**计数**（`frame_t_*`），并把"历史未知"标出来 ⟹ 依赖历史的项（crate/draw）当帧**不编**。
    """
    __slots__ = ("t_prev", "history_known", "item_sig", "me_dead", "me_dead_via",
                 "last_fire_t", "last_spawn_t", "last_opp_fire_t")

    def __init__(self):
        self.reset()

    def reset(self):
        self.t_prev = None
        self.history_known = False
        self.item_sig = None
        self.me_dead = False
        self.me_dead_via = None
        self.last_fire_t = None
        self.last_spawn_t = None
        self.last_opp_fire_t = None

    def begin(self, t):
        if self.t_prev is None:
            self.history_known = (t == 0)
            STATS["episodes"] += 1
            if t != 0:
                _say("episode_starts_midway", "局首帧 t=%d != 0 ⟹ 历史未知（crate/draw 依赖历史的项当帧不编）" % t)
        elif t == 0:
            self.reset()
            self.history_known = True
            STATS["episodes"] += 1
        elif t == self.t_prev + 1:
            pass
        else:
            self.history_known = False
            STATS["frame_t_jump"] += 1
            if t < self.t_prev:
                _say("frame_t_backwards", "帧序号倒序 t=%d <- %d ⟹ 历史作废（该项当帧不编）" % (t, self.t_prev))
                self.reset()
        self.t_prev = t


_ST = _EpiState()


# ---------------------------------------------------------------- 各分项
def _crate_and_draw_parts(f, st, r, glb):
    """返回 (crate_value, draw_value)：采集器**直供**的原始量（`>0` 才用，⛔ 不与本文件的推断重复计）。"""
    crate = float(r.get("crate", 0.0) or 0.0)
    draw = float(r.get("draw", 0.0) or 0.0)
    if crate > 0.0:
        STATS["crate_from_collector"] += 1
    if draw > 0.0:
        STATS["draw_from_collector"] += 1
    return crate, draw


def _crate_diff(f, st, r, glb):
    """道具奖励（推断口径）：我方**格内**消失的道具数。

    口径来源（父代理派单 ②）："我方 `getCollectibles()` 数量差分；归属不清就只算【我方格内消失】并标推断口径"。
    ⛔ 采集器 `_collect_tmp.js` 里 `crate:0` 是字面量（`:187`）⟹ 本函数在训练侧用 item 段自己做差分。
    """
    item = _seg(f, "item")
    if item.ndim != 2 or item.shape[1] < 3:
        raise AssertionError("[rewards] item 段形状应为 (rows,>=3)，实际 %s" % (item.shape,))
    cr = item[:, ITEM_CRATE]
    # `itemRows()` 用 0 补空槽 ⟹ 全零行=空槽（⚠️ x,y,type 全 0 的真道具会被漏掉 ⟹ 显式计数）
    keep = ~np.all(cr == 0.0, axis=1)
    zero_rows = int(cr.shape[0] - int(keep.sum()))
    if zero_rows:
        STATS["item_zero_rows"] += zero_rows
    sig = frozenset((round(float(x), 3), round(float(y), 3), round(float(tp), 3)) for x, y, tp in cr[keep])
    prev = st.item_sig
    st.item_sig = sig
    if not st.history_known or prev is None:
        STATS["crate_baseline_frames"] += 1
        return 0.0
    vanished = prev - sig
    if not vanished:
        return 0.0
    STATS["crate_vanished"] += len(vanished)

    tilesw, tilesh = float(glb[G_MAPW]), float(glb[G_MAPH])   # ⚠️ g[0]/g[1] 是【格数】不是米（见 G_MAPW 注释）
    sx, sy = float(glb[G_SELFX]), float(glb[G_SELFY])
    if not (tilesw >= 1.0 and tilesh >= 1.0 and tilesw == int(tilesw) and tilesh == int(tilesh)):
        _say("crate_geom_bad_tiles",
             "global[0]/global[1] 应是地图【格数】正整数，实际 %r/%r ⟹ 格坐标不可算（道具奖励当帧不给、已计数）"
             % (tilesw, tilesh))
        return 0.0
    # 单位判定：`vantage_observe.js:341-342` `norm && mapW ? x/mapW : x` ⟹ 位置要么是**米**、要么是 **[0,1] 比例**。
    # raw 的格宽 = TILE_M（米）；norm 的格宽 = 1/tilesW（比例）⟹ 两种都能算格号，且**不需要**再知道米制地图宽。
    norm = (max(abs(sx), abs(sy)) <= 1.000001) and (tilesw >= 2.0) and (tilesh >= 2.0)
    span = max([abs(sx), abs(sy)] + [abs(float(v)) for v in cr[keep].ravel()])
    if (not norm) and span <= 1.000001:
        STATS["crate_units_ambiguous"] += 1        # ⛔ 判不出单位就不给奖（不猜）
        return 0.0
    if norm:
        cellx = lambda x: math.floor(float(x) * tilesw)
        celly = lambda y: math.floor(float(y) * tilesh)
    else:
        cellx = lambda x: math.floor(float(x) / TILE_M)
        celly = lambda y: math.floor(float(y) / TILE_M)
    my_cell = (cellx(sx), celly(sy))
    opp_cells = set()
    for row in _real_opp_rows(_opp(f)):
        ox, oy = float(row[0]), float(row[1])
        if (ox, oy) == (0.0, 0.0):
            continue
        opp_cells.add((cellx(ox), celly(oy)))
    n_mine = 0
    for (x, y, tp) in vanished:
        cell = (cellx(x), celly(y))
        if not (0 <= cell[0] < int(tilesw) and 0 <= cell[1] < int(tilesh)):
            STATS["crate_cell_out_of_range"] += 1  # 坐标越界 ⟹ 单位判定错了（计数，⛔ 不静默给奖）
            continue
        if cell != my_cell:
            # 诊断：差一格 ⟹ 可能是"边界上擦过"（⛔ 只计数，不给奖，口径按父代理原文"我方格内"）
            if abs(cell[0] - my_cell[0]) <= 1 and abs(cell[1] - my_cell[1]) <= 1:
                STATS["crate_vanished_adjacent"] += 1
            continue
        n_mine += 1
        if cell in opp_cells:
            STATS["crate_attr_ambiguous"] += 1     # 我和对手同格 ⟹ 归属不清（按派单口径仍记我方、但显式计数）
        else:
            STATS["crate_attr_mine"] += 1
    return float(n_mine)


def _draw_part(f, st, r, glb):
    """`1v1` 双死平局（父代理口径）：`ended && 仅2坦克 && 双方皆死`。

    数据来源：
      · ended        = 帧的 `done`（采集器 `_collect_tmp.js:213` `last.done=(done===true)`）
      · 仅 2 坦克     = `global[G_MAXPLAYERS]`（`GLOBAL_FIELDS` 里 `maxPlayers`）
      · 对手皆死      = `opp` 段每行 `oAlive`（`OPP_FIELDS[7]`）
      · 我方死过      = 本局任一帧 `death|selfkill|death_storm>0`（`TANK_KILLED` 事件）
                       备用：global 死亡段 `dVictimIdx==0`（稳定索引表里**自车=0**，`vantage_observe.js` P4）
    交叉核对（**硬条件**）：采集器 `won===-1`（没有任何一方拿到正分）才写 `result=-0.25`（`_collect_tmp.js:213`）
      ⟹ 结构化判定**必须**同时满足 `result==-0.25` 才给 draw；否则**计数并放弃**（⛔ 宁可少给，不与 win/lose 双记）。
      ⚠️ 反例（已由 `rewards_selftest.py` 守住）：我赢了但对手已死（`oAlive=0`、`result=+1`）**不是**平局。
    """
    if not bool(f.get("done")):
        return 0.0
    if not st.history_known:
        STATS["draw_history_unknown"] += 1
        return 0.0
    maxp = glb[G_MAXPLAYERS]
    if float(maxp) != 2.0:
        return 0.0
    opp_rows = _real_opp_rows(_opp(f))
    alive_any = bool(np.any(opp_rows[:, OPP_ALIVE] > 0.0))
    if alive_any:
        return 0.0
    if float(r.get("win", 0.0) or 0.0) > 0.0 or float(r.get("lose", 0.0) or 0.0) > 0.0:
        _say("draw_conflict_winlose", "采集器同时给了 win/lose 而对手已死 ⟹ 不当平局（⛔ 不加 -0.5 扣）")
        return 0.0
    if not st.me_dead:
        STATS["draw_opp_dead_me_alive"] += 1
        return 0.0
    # ⭐ 第三重确认：采集器 `won===-1`（= 没有任何一方拿到正分）写 `result=-0.25`（`_collect_tmp.js:213`）。
    #    ⛔ 没有这条就不给 draw —— 否则"我赢了对局"会被"对手死了"误判成平局，变成 +3.0 与 -0.5 双记。
    if float(r.get("result", 0.0) or 0.0) != -0.25:
        _say("draw_structural_no_result_signal",
             "结构化判定=双方皆死，但 result=%r（双死应为 -0.25）⟹ 当帧**不给** draw（⛔ 宁可少给，不与 win/lose 双记）"
             % (r.get("result"),))
        return 0.0
    STATS["draw_structural"] += 1
    return 1.0


def _tmin(f, r, key):
    """`T_min`（子弹最短飞行帧数）：**只有采集侧给了才用**（页面内 `AIUtils.checkFiringPath`/`B2DUtils.calculateProjectilePath`）。

    ⛔ 读不到就返回 None ⟹ 调用方把该项贡献置 0 并计数（`⛔ 不许猜一个常数糊过去`）。
    """
    for src, d in (("r", r), ("f", f)):
        v = d.get(key)
        if v is None:
            continue
        try:
            fv = float(v)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(fv) or fv <= 0.0:
            continue
        STATS["tmin_from_" + src] += 1
        return fv
    return None


def _speed_part(f, st, r, cfg):
    """速通（父代理 ②）：`speed = +0.5 × (1 − (T_kill − T_min)/Δ)`，越界为 0。

    `T_kill` = 击杀帧 − 最近一次**真发射**帧（`r["spawn"]>0`；退化到 `act.fire==1`，两条路各自计数）。
    `T_min`  = 采集侧必须提供（`r["t_min"]`），⚠️ 当前采集器**不提供** ⟹ 该项恒 0，计 `speed_blocked_no_tmin_frames`。
    """
    kill_now = float(r.get("kill", 0.0) or 0.0)   # ⛔ 只认"我方子弹击杀"；毒雾杀(`kill_storm`)没有弹道 ⟹ 不进速通
    if kill_now <= 0.0:
        return 0.0
    t = int(f["t"])
    t0 = st.last_spawn_t if st.last_spawn_t is not None else st.last_fire_t
    if t0 is None:
        STATS["speed_no_fire_ref"] += 1
        return 0.0
    if st.last_spawn_t is None:
        STATS["speed_fire_ref_from_intent"] += 1     # 退化了：用"想开火"而不是"真发射"
    t_kill = float(t - t0)
    t_min = _tmin(f, r, "t_min")
    if t_min is None:
        _say("speed_blocked_no_tmin",
             "速通奖励：帧里没有 `t_min`（子弹最短飞行帧数）⟹ 该项贡献 0（T_kill=%r 已知；⛔ 不拿常数顶替）" % t_kill)
        return 0.0
    delta = float(cfg.get("speed_delta_frames", EXTRA_DEFAULTS["speed_delta_frames"]))
    if not (delta > 0.0) or not math.isfinite(delta):
        raise AssertionError("[rewards] speed_delta_frames=%r 非法（必须 >0）" % (delta,))
    x = (t_kill - t_min) / delta
    STATS["speed_evaluated"] += 1
    if x > 1.0:
        STATS["speed_over_window"] += 1
        return 0.0
    if x < 0.0:
        STATS["speed_negative"] += 1
        _say("speed_negative", "T_kill(%r) < T_min(%r) ⟹ 物理上不可能，已计数并按 1.0 截顶" % (t_kill, t_min))
        x = 0.0
    return 1.0 - x


def _fast_death_part(f, st, r, cfg):
    """速通的对称项：`fast_death = −0.5 × (1 − (T_death − T_min')/Δ)`（死得越快罚越重）。

    `T_death` = 我方被**他人子弹**打死那一帧 − 最近一次对手开火帧（`opp` 段 `oFire==1`）。
    ⚠️ `selfkill`/`death_storm` 不算（它们各自有独立且更重的项 ⟹ 避免重复计）。
    """
    if float(r.get("death", 0.0) or 0.0) <= 0.0:
        return 0.0
    t = int(f["t"])
    if st.last_opp_fire_t is None:
        STATS["fast_death_no_opp_fire_ref"] += 1
        return 0.0
    t_death = float(t - st.last_opp_fire_t)
    t_min = _tmin(f, r, "t_min_death")
    if t_min is None:
        _say("fast_death_blocked_no_tmin",
             "死亡过快惩罚：帧里没有 `t_min_death` ⟹ 该项贡献 0（T_death=%r 已知；⛔ 不拿常数顶替）" % t_death)
        return 0.0
    delta = float(cfg.get("speed_delta_frames", EXTRA_DEFAULTS["speed_delta_frames"]))
    if not (delta > 0.0) or not math.isfinite(delta):
        raise AssertionError("[rewards] speed_delta_frames=%r 非法（必须 >0）" % (delta,))
    x = (t_death - t_min) / delta
    STATS["fast_death_evaluated"] += 1
    if x > 1.0:
        STATS["fast_death_over_window"] += 1
        return 0.0
    if x < 0.0:
        STATS["fast_death_negative"] += 1
        x = 0.0
    return 1.0 - x


# ---------------------------------------------------------------- 主入口
def explain(f, cfg):
    """把一帧拆成【逐项：(原始量, 权重, 贡献)】。`reward_of` 就是按 `ITEMS` 顺序把贡献加起来。

    返回 (parts, total)；`parts` 是 `OrderedDict[str] -> (value, weight, contrib)`。
    """
    r = f["r"]
    st = _ST
    st.begin(int(f["t"]))
    glb = _glb(f)
    t = int(f["t"])

    # ── 先"吞事件"（跨帧状态必须在算 draw 之前更新；否则"死亡帧即终局帧"会漏判）──
    if float(r.get("death", 0.0) or 0.0) > 0.0 or float(r.get("selfkill", 0.0) or 0.0) > 0.0 \
            or float(r.get("death_storm", 0.0) or 0.0) > 0.0:
        if not st.me_dead:
            st.me_dead = True
            st.me_dead_via = "kill_event"
    if not st.me_dead:
        # 备用：`stablePlayerIndex` 里**自车=0**（`vantage_observe.js` P4）⟹ 死亡段 victim 索引 0 = 我。
        # ⚠️ 空死亡段是【全零】的（dVictimIdx=0、位置=0、deadlyType=0），长得就像"我死了"。
        #    ⟹ 必须要求"像一条真记录"：位置不为零 且 deadlyType 不为 0（`num(rec.deadlyType,-1)` 缺省是 -1）。
        try:
            _vic, _dx, _dy, _dtp = float(glb[21]), float(glb[22]), float(glb[23]), float(glb[25])
            _age = float(glb[26])
            if _vic == 0.0 and (_dx != 0.0 or _dy != 0.0) and _dtp != 0.0 and math.isfinite(_age) and _age >= 0.0:
                st.me_dead = True
                st.me_dead_via = "death_seg"
                STATS["me_dead_from_death_seg"] += 1
        except (IndexError, ValueError):
            pass
    if int(f["act"].get("fire", 0)) == 1:
        st.last_fire_t = t
    if float(r.get("spawn", 0.0) or 0.0) > 0.0:
        st.last_spawn_t = t
    for row in _real_opp_rows(_opp(f)):
        if float(row[OPP_FIRE]) == 1.0:
            st.last_opp_fire_t = t
            break

    # ── 逐项 ──
    parts = OrderedDict()
    w = cfg.get

    # 1) 终局/胜负/平局（含 D3/D4 的 result 抑制）
    win = float(r.get("win", 0.0) or 0.0)
    lose = float(r.get("lose", 0.0) or 0.0)
    crate_val, draw_val = _crate_and_draw_parts(f, st, r, glb); diff_val = _crate_diff(f, st, r, glb)   # ⭐ 差分基线每帧都更新
    if crate_val <= 0.0:
        crate_val = diff_val          # ⭐ 采集器直供优先（>0 就用它的 ⟹ 零 double-count，D5）
    if draw_val <= 0.0:
        draw_val = _draw_part(f, st, r, glb)
    suppress_result, why = False, None
    if win > 0.0:
        suppress_result, why = True, "win"
    elif lose > 0.0:
        suppress_result, why = True, "lose"
    elif draw_val > 0.0:
        suppress_result, why = True, "draw"
    result_val = float(r.get("result", 0.0) or 0.0)
    if suppress_result:
        STATS["result_suppressed_" + why] += 1
        result_val = 0.0
    parts["result"] = (result_val, float(w("w_result", 1.0)), float(w("w_result", 1.0)) * result_val)

    # 2) 击杀 / 命中 / 死亡（D2：hit 只算"命中但未致死"）
    kill = float(r.get("kill", 0.0) or 0.0)
    hit = float(r.get("hit", 0.0) or 0.0)
    nonlethal = hit - kill
    if hit <= 0.0:
        nonlethal = 0.0
        if kill > 0.0:
            STATS["hit_absent_with_kill"] += 1     # 该帧根本没给 hit（如旧采集器/别的源）⟹ w_hit 该项为 0 且**计数**
    elif hit < kill - 1e-9:
        raise AssertionError(
            "[rewards] hit=%r < kill=%r ⟹ 采集器口径不再是「hit 含致命击杀」（`_collect_tmp.js:111` `rKill++; hitNow++;`）。"
            "⛔ 拒绝静默算错：请先在 `rewards.py` 的 `hit 口径` 处把约定改成新的，再跑训练。" % (hit, kill))
    if nonlethal <= 0.0:
        nonlethal = 0.0
        if hit > 0.0:
            STATS["hit_all_lethal_suppressed"] += int(hit)   # ⭐ 显式计数：这些 hit 全是"致命击杀"，不再另给 w_hit
    else:
        STATS["hit_nonlethal_events"] += int(nonlethal)
    parts["kill"] = (kill, float(w("w_kill", 1.0)), float(w("w_kill", 1.0)) * kill)
    parts["kill_storm"] = (float(r.get("kill_storm", 0.0) or 0.0), float(w("w_kill_storm", 1.0)),
                           float(w("w_kill_storm", 1.0)) * float(r.get("kill_storm", 0.0) or 0.0))
    parts["hit_nonlethal"] = (nonlethal, float(w("w_hit", 0.2)), float(w("w_hit", 0.2)) * nonlethal)
    parts["selfkill"] = (float(r.get("selfkill", 0.0) or 0.0), float(w("w_selfkill", -1.5)),
                         float(w("w_selfkill", -1.5)) * float(r.get("selfkill", 0.0) or 0.0))
    parts["death"] = (float(r.get("death", 0.0) or 0.0), float(w("w_death", -1.0)),
                      float(w("w_death", -1.0)) * float(r.get("death", 0.0) or 0.0))
    parts["death_storm"] = (float(r.get("death_storm", 0.0) or 0.0), float(w("w_death_storm", -1.5)),
                            float(w("w_death_storm", -1.5)) * float(r.get("death_storm", 0.0) or 0.0))

    # 3) 胜负平
    parts["win"] = (win, float(w("w_win", 3.0)), float(w("w_win", 3.0)) * win)
    parts["lose"] = (lose, float(w("w_lose", -1.0)), float(w("w_lose", -1.0)) * lose)
    parts["draw"] = (draw_val, float(w("w_draw", -0.5)), float(w("w_draw", -0.5)) * draw_val)

    # 4) 道具（含线性衰减钩子）
    decay_rounds = int(w("crate_decay_train_rounds", EXTRA_DEFAULTS["crate_decay_train_rounds"]) or 0)
    if crate_val > 0.0:
        if decay_rounds > 0:
            prog = w("train_progress01", None)
            if prog is None:
                raise AssertionError(
                    "[rewards] 已配置 crate_decay_train_rounds=%d（线性衰减到 0），但 cfg 里没有 `train_progress01` "
                    "⟹ 衰减进度未知。⛔ 拒绝静默按 1.0 算：请把当前 训练轮次/总轮次 传进 cfg（父文件加一行）。"
                    % decay_rounds)
            prog = float(prog)
            if not (0.0 <= prog <= 1.0):
                raise AssertionError("[rewards] train_progress01=%r 越界（应在 [0,1]）" % (prog,))
            scale = max(0.0, 1.0 - prog)
            STATS["crate_decayed_frames"] += 1
        else:
            scale = 1.0
            STATS["crate_decay_unavailable_frames"] += 1     # ⭐ 显式：衰减【没在生效】（训练器没传轮次）
    else:
        scale = 1.0
    parts["crate"] = (crate_val * scale, float(w("w_crate", 0.05)), float(w("w_crate", 0.05)) * crate_val * scale)

    # 5) 速通 / 死亡过快
    sp = _speed_part(f, st, r, cfg)
    fd = _fast_death_part(f, st, r, cfg)
    parts["speed"] = (sp, float(w("w_speed", EXTRA_DEFAULTS["w_speed"])), float(w("w_speed", EXTRA_DEFAULTS["w_speed"])) * sp)
    parts["fast_death"] = (fd, float(w("w_fast_death", EXTRA_DEFAULTS["w_fast_death"])),
                           float(w("w_fast_death", EXTRA_DEFAULTS["w_fast_death"])) * fd)

    # 6) 存活 / 合法 / 空射 / 真发射 / 瞄准（D1：legal 只保留 w_legal_pen）
    legal = float(r.get("legal", 0.0) or 0.0)
    if float(w("w_legal", 0.0) or 0.0) != 0.0:
        _say("legal_legacy_w_ignored",
             "⚠️ cfg['w_legal']=%r 被**忽略**：它与 w_legal_pen=%r 乘的是同一个字段 `legal`（旧口径实扣 -1.05）。"
             "⟹ 只保留 w_legal_pen，合法被拒一次 = -%r"
             % (w("w_legal"), w("w_legal_pen", 0.05), float(w("w_legal_pen", 0.05))))
    if legal < 0.0:
        STATS["legal_events"] += int(round(-legal))
    parts["survive"] = (float(r.get("survive", 0.0) or 0.0), float(w("w_survive", 1.0)),
                        float(w("w_survive", 1.0)) * float(r.get("survive", 0.0) or 0.0))
    parts["legal"] = (legal, float(w("w_legal_pen", 0.05)), float(w("w_legal_pen", 0.05)) * legal)
    parts["empty_fire"] = (float(r.get("empty_fire", 0.0) or 0.0), float(w("w_empty_fire", -0.10)),
                           float(w("w_empty_fire", -0.10)) * float(r.get("empty_fire", 0.0) or 0.0))
    parts["spawn"] = (float(r.get("spawn", 0.0) or 0.0), float(w("w_spawn", 0.02)),
                      float(w("w_spawn", 0.02)) * float(r.get("spawn", 0.0) or 0.0))
    parts["aim"] = (float(r.get("aim", 0.0) or 0.0), float(w("w_aim", 0.01)),
                    float(w("w_aim", 0.01)) * float(r.get("aim", 0.0) or 0.0))

    # ⭐⭐ 稠密奖励（主人报告需要；系数【无出处、待拍】）
    _still = 1.0 if (f.get("execStill") is True) else 0.0
    parts["still"] = (_still, float(w("w_still", 0.01)), -float(w("w_still", 0.01)) * _still)
    if _still > 0.0:
        STATS["still_frames"] += 1
    # progress：与最近对手距离的减少量（只奖励靠近）
    _d = f.get("distNear")
    _dp = f.get("_distPrev")
    _prog = 0.0
    if _d is not None and _dp is not None:
        _dd = float(_dp) - float(_d)
        _prog = max(0.0, min(1.0, _dd))
        if _prog > 0.0:
            STATS["progress_frames"] += 1
            STATS["progress_sum"] = STATS.get("progress_sum", 0.0) + _prog
    parts["progress"] = (_prog, float(w("w_progress", 0.02)), float(w("w_progress", 0.02)) * _prog)

    total = 0.0
    for k in ITEMS:                       # ⭐ 固定顺序求和（浮点加法不结合，顺序变了末位就变）
        total += parts[k][2]
    return parts, total


def reward_of(f, cfg):
    """`train_ppo_online.prepare_targets()` 的唯一入口（父文件里只有这一行调用）。"""
    mode = cfg.get("reward_mode", "parts")
    if mode == "total":
        STATS["reward_mode_total_frames"] += 1      # ⚠️ total 模式绕过本文件全部修正（旧口径），显式计数
        _say("reward_mode_total",
             "cfg['reward_mode']='total' ⟹ 直接用采集器的 r.total（本文件的 10 条/零 double-count 修正【不生效】）")
        return float(f["r"]["total"])
    if mode != "parts":
        raise AssertionError("[rewards] 未知 reward_mode=%r（只认 'parts'（逐项）/'total'（采集器直供））" % (mode,))
    _announce_once()
    parts, total = explain(f, cfg)
    STATS["frames"] += 1
    if STATS["frames"] % SUMMARY_EVERY == 0:
        log_summary(prefix="每 %d 帧" % SUMMARY_EVERY)
    return float(total)


def log_summary(prefix=""):
    d = {k: v for k, v in sorted(STATS.items()) if v}
    print("[rewards] 计数%s：%s" % (("（%s）" % prefix) if prefix else "", d), file=sys.stderr, flush=True)


_ANNOUNCE_DONE = [False]


def _announce_once():
    """开机把"哪些值来自本文件缺省"打印出来（铁律二：设备/精度/模式/档位/默认值一律开机就打印）。"""
    if _ANNOUNCE_DONE[0]:
        return
    _ANNOUNCE_DONE[0] = True
    print("[rewards] 缺省来自 rewards.EXTRA_DEFAULTS（父文件 DEFAULTS 里没有这些键）：%s"
          % dict(EXTRA_DEFAULTS), file=sys.stderr, flush=True)


def _reset_announce_for_test():
    _ANNOUNCE_DONE[0] = False
