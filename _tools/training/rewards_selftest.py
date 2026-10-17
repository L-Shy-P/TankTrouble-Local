# -*- coding: utf-8 -*-
"""`rewards.py` 的**手算对拍**（铁律零 ④：实际生效值验算 —— `==` 逐位相等，⛔ 不用 `approx`）。

三层证据：
  L1 `rewards.explain()` 直接喂**训练器内部帧**（顶层 `global/item/opp`）⟹ 覆盖全部 18 个分项（含 `t_min` 通路）
  L2 `JSON → vt_buffer.decode_episode → EpisodeBuffer → train_ppo_online.prepare_targets()`
     ⟹ **真代码路径**（校验 + reward_of + GAE）跑一遍，`_rew` 与手算逐位相等
  L3 反例：`hit < kill` 必须抛错、`crate_decay` 配了但没传轮次必须抛错（⛔ 不静默降级）

跑法（磁盘纪律：日志写 `D:`）：
    PYTHONIOENCODING=utf-8 py -3.13 _tools/training/rewards_selftest.py
"""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import rewards as RW          # noqa: E402
import vt_buffer as vb        # noqa: E402

LOG = "D:/vt_run/rewards_selftest.log"
_OUT = []


def say(s=""):
    print(s)
    _OUT.append(s)


def flush_log():
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "w", encoding="utf-8") as fh:
        fh.write("\n".join(_OUT) + "\n")


# ---------------------------------------------------------------- 造帧
def mk_global(mapW=8.0, mapH=5.0, maxplayers=2.0, selfx=12.0, selfy=22.0):
    """⚠️ `mapW/mapH` 是【格数】（`vantage_observe.js:324` `g.push(ms.tilesW, ms.tilesH)`）；`selfx/selfy` 是米。"""
    g = [0.0] * 38
    g[RW.G_MAPW], g[RW.G_MAPH] = float(mapW), float(mapH)
    g[RW.G_MAXPLAYERS] = float(maxplayers)
    g[RW.G_SELFX], g[RW.G_SELFY] = float(selfx), float(selfy)
    return g


def mk_opp(opps=((-1.0, -1.0, 1.0),)):
    """`opps` = 每个真对手的 (x, y, alive)；其余槽位全零（= `oppRows()` 的空槽填充）。"""
    rows = []
    for (x, y, alive) in opps:
        r = [-1.0] * 15
        r[0], r[1], r[RW.OPP_ALIVE] = float(x), float(y), float(alive)
        r[RW.OPP_FIRE] = 0.0
        rows.append(r)
    while len(rows) < 8:
        rows.append([0.0] * 15)
    return rows


def mk_opp_fire(opps, fire):
    rows = mk_opp(opps)
    for r in rows:
        if any(v != 0.0 for v in r):
            r[RW.OPP_FIRE] = float(fire)
    return rows


def mk_item(crates=()):
    """`crates` = ((x,y,type), ...) —— 正好对应 `itemRows()` 的 `[cx,cy,cType,mx,my,mState]`。"""
    rows = []
    for c in crates:
        rows.append([float(c[0]), float(c[1]), float(c[2]), 0.0, 0.0, 0.0])
    while len(rows) < 8:
        rows.append([0.0] * 6)
    return rows


def mk_frame(t, r=None, g=None, opp=None, item=None, fire=0, done=False):
    """训练器**内部**帧（= `vt_buffer.decode_frame()` 的返回形状）。"""
    rr = {"total": 0.0, "result": 0.0, "survive": 0.0, "legal": 0.0}
    rr.update(r or {})
    return {"t": int(t), "N": 4,
            "node": np.zeros((4, 10), np.float32),
            "opp": np.asarray(mk_opp() if opp is None else opp, np.float32),
            "bullet": np.zeros((64, 7), np.float32),
            "item": np.asarray(mk_item() if item is None else item, np.float32),
            "global": np.asarray([mk_global() if g is None else g], np.float32),
            "act": {"nodeId": 0, "fire": int(fire), "picks": [{"nodeId": 0, "back": 0}], "grow": None},
            "lp": -1.0, "v": 0.1, "v_next": None, "r": rr, "done": bool(done)}


def to_json(f):
    """内部帧 → 采集器 JSON（`obs.<seg>` + `r`）。"""
    return {"t": f["t"], "N": f["N"],
            "obs": {"node": f["node"].tolist(), "opp": f["opp"].tolist(),
                    "bullet": f["bullet"].tolist(), "item": f["item"].tolist(),
                    "global": f["global"].tolist()},
            "act": {"nodeId": f["act"]["nodeId"], "fire": f["act"]["fire"],
                    "picks": f["act"]["picks"]},
            "lp": f["lp"], "v": f["v"], "r": dict(f["r"]), "done": f["done"]}


# ---------------------------------------------------------------- 手算核对工具
def check(tag, got_parts, hand, cfg_note=""):
    """`hand` = 手写的**逐项贡献**（已乘好权重）；总和按 `rewards.ITEMS` 同序累加 ⟹ 可判"逐位相等"。"""
    ok = True
    for k in RW.ITEMS:
        exp = float(hand.get(k, 0.0))
        act = float(got_parts[k][2])
        if not (act == exp):
            ok = False
            say("   ❌ 项 %-14s 手算=%r (%s)  代码=%r (%s)" % (k, exp, float(exp).hex(), act, float(act).hex()))
    exp_total = 0.0
    for k in RW.ITEMS:            # ⭐ 与 `explain()` 完全同序
        exp_total += float(hand.get(k, 0.0))
    act_total = 0.0
    for k in RW.ITEMS:
        act_total += float(got_parts[k][2])
    if not (act_total == exp_total):
        ok = False
        say("   ❌ 总和 手算=%r (%s)  代码=%r (%s)" % (exp_total, exp_total.hex(), act_total, act_total.hex()))
    say("  [%s] %s 逐位相等=%s  手算总和=%r  代码总和=%r  hex=%s%s"
        % ("OK" if ok else "FAIL", tag, ok, exp_total, act_total, act_total.hex(),
           ("  " + cfg_note) if cfg_note else ""))
    if not ok:
        raise AssertionError("手算与代码不一致：%s" % tag)
    return act_total


def run_episode(frames, cfg, tag):
    """L1：按训练器同样顺序喂一局，返回每帧 (parts, total)。"""
    RW.reset_stats()
    RW._ST.reset()
    out = []
    for f in frames:
        parts, total = RW.explain(f, cfg)
        out.append((parts, total))
    return out


# ---------------------------------------------------------------- 主流程
def main():
    import train_ppo_online as T
    cfg = dict(T.DEFAULTS)
    say("== 权重（真值来自 train_ppo_online.DEFAULTS；EXTRA 来自 rewards.EXTRA_DEFAULTS）==")
    for k in ("w_result", "w_survive", "w_legal_pen", "w_legal", "w_kill", "w_kill_storm", "w_hit",
              "w_selfkill", "w_death", "w_death_storm", "w_win", "w_lose", "w_draw", "w_crate",
              "w_empty_fire", "w_spawn", "w_aim"):
        say("  %-14s = %r   %s" % (k, cfg.get(k), RW.WEIGHT_SRC.get(k, ("", ""))[1]))
    for k, v in RW.EXTRA_DEFAULTS.items():
        say("  %-14s = %r   %s" % (k, v, RW.WEIGHT_SRC.get(k, ("", ""))[1]))
    say("")

    # ============================================================ 主样本（一局 5 帧，覆盖 11 项）
    say("== ① 手算样本（ep 9001，5 帧；权重见上）==")
    main_frames = [
        # t=0：存活 + 真发射 1 发 + 场上 1 个道具在**我方格**（12,22 → 格(1,2)；道具 15,25 → 格(1,2)）
        mk_frame(0, {"survive": 1.0, "spawn": 1.0}, opp=mk_opp(((-1.0, -1.0, 1.0),)),
                 item=mk_item(((15.0, 25.0, 0.0),)), fire=1, done=False),
        # t=1：该道具消失（我方格内）⇒ crate；被拒 1 次 ⇒ legal=-1；没子弹扣扳机 ⇒ empty_fire
        mk_frame(1, {"survive": 1.0, "legal": -1.0, "empty_fire": 1.0}, opp=mk_opp(((-1.0, -1.0, 1.0),)),
                 item=mk_item(()), fire=0, done=False),
        # t=2：击杀 1 次（采集器同时把 hit 也 +1 ⟹ 旧口径会多给 0.2）+ 瞄准命中
        mk_frame(2, {"survive": 1.0, "kill": 1.0, "hit": 1.0, "aim": 1.0}, opp=mk_opp(((-1.0, -1.0, 1.0),)),
                 item=mk_item(()), fire=0, done=False),
        # t=3：对手被毒雾杀死（推断口径）⇒ kill_storm
        mk_frame(3, {"survive": 1.0, "kill_storm": 1.0}, opp=mk_opp(((-1.0, -1.0, 1.0),)),
                 item=mk_item(()), fire=0, done=False),
        # t=4 终局：自杀死（selfkill）+ 1v1 双方皆死 ⇒ draw；result=-0.25 那一路必须置 0
        mk_frame(4, {"survive": 0.0, "selfkill": 1.0, "result": -0.25}, opp=mk_opp(((-1.0, -1.0, 0.0),)),
                 item=mk_item(()), fire=0, done=True),
    ]
    hand_main = [
        {"survive": 1.0 * 1.0, "spawn": 0.02 * 1.0},
        {"crate": 0.05 * 1.0, "survive": 1.0 * 1.0, "legal": 0.05 * (-1.0), "empty_fire": -0.10 * 1.0},
        {"kill": 1.0 * 1.0, "hit_nonlethal": 0.2 * 0.0, "survive": 1.0 * 1.0, "aim": 0.01 * 1.0},
        {"kill_storm": 1.0 * 1.0, "survive": 1.0 * 1.0},
        {"selfkill": -1.5 * 1.0, "draw": -0.5 * 1.0, "result": 1.0 * 0.0},
    ]
    got = run_episode(main_frames, cfg, "main")
    tot = []
    for i, (parts, total) in enumerate(got):
        tot.append(check("ep9001 t=%d" % i, parts, hand_main[i]))
    say("  ⇒ 逐帧 _rew = %r" % (tot,))
    st = RW.stats()
    say("  计数（证明“没生效的项”是显式的、不是悄悄 0）：")
    for k in ("hit_all_lethal_suppressed", "speed_blocked_no_tmin", "crate_attr_mine", "crate_vanished",
              "draw_structural", "result_suppressed_draw", "legal_events", "crate_decay_unavailable_frames"):
        say("    %-32s = %d" % (k, st.get(k, 0)))
    assert st.get("hit_all_lethal_suppressed", 0) == 1, "t=2 的 hit=1 必须被识别成“致命击杀”并计数"
    assert st.get("speed_blocked_no_tmin", 0) == 1, "t=2 的击杀必须走到 speed 且因缺 t_min 被计数"
    assert st.get("crate_attr_mine", 0) == 1, "t=1 的 crate 必须按“我方格内消失”记 1 次"
    assert st.get("draw_structural", 0) == 1 and st.get("result_suppressed_draw", 0) == 1
    say("")

    # ============================================================ 三个"必须证明"的断言
    say("== ② 证明 A：legal=1 次 ⟹ legal 贡献正好 -0.05（不是 -1.05）==")
    ep = [mk_frame(0, {"legal": -1.0}, done=True)]
    (parts, _t) = run_episode(ep, cfg, "legal")[0]
    v = check("ep9002 legal=-1", parts, {"legal": 0.05 * (-1.0)})
    old = 1.0 * (-1.0) + 0.05 * (-1.0)
    say("  实得 _rew=%r (%s)；旧口径（w_legal=1.0 与 w_legal_pen=0.05 各乘一次）会是 %r ⟹ 修复量 %r"
        % (v, v.hex(), old, old - v))
    assert v == -0.05, "legal=1 次必须正好 -0.05"
    say("")

    say("== ③ 证明 B：一次击杀 ⟹ 总贡献正好 1.0（不是 1.2）==")
    ep = [mk_frame(0, {"kill": 1.0, "hit": 1.0}, done=True)]   # 采集器真实行为：同一事件 hit 也 +1
    (parts, _t) = run_episode(ep, cfg, "kill")[0]
    v = check("ep9003 kill=1 hit=1", parts, {"kill": 1.0 * 1.0, "hit_nonlethal": 0.2 * 0.0})
    say("  实得 _rew=%r (%s)；旧口径（kill 1.0 + hit 0.2）会是 1.2" % (v, v.hex()))
    assert v == 1.0, "一次击杀必须正好 1.0"
    say("")

    say("== ④ 证明 C：双死 1v1 ⟹ 只算 draw，result 贡献为 0 ==")
    ep = [mk_frame(0, {"death": 1.0}, done=False),                                     # 我被别人打死
          mk_frame(1, {"result": -0.25}, opp=mk_opp(((-1.0, -1.0, 0.0),)), done=True)]  # 对手也死 + 回合结束
    got = run_episode(ep, cfg, "draw")
    check("ep9004 t=0 death", got[0][0], {"death": -1.0 * 1.0})
    v = check("ep9004 t=1 双死平局", got[1][0], {"draw": -0.5 * 1.0, "result": 1.0 * 0.0})
    say("  t=1: parts['result']=(value=%r, weight=%r, contrib=%r)  ⟹ result 那一路被 draw 抑制"
        % (got[1][0]["result"][0], got[1][0]["result"][1], got[1][0]["result"][2]))
    say("  t=1: parts['draw']  =(value=%r, weight=%r, contrib=%r)" % got[1][0]["draw"])
    assert got[1][0]["result"][2] == 0.0 and got[1][0]["draw"][2] == -0.5 and v == -0.5
    say("")

    # ============================================================ 其余分项（互斥的终局项/需 t_min 的项）
    say("== ⑤ 其余分项逐项（每个一局，全部 done=True）==")
    cases = [
        ("win",        {"win": 1.0, "result": 1.0},  {"win": 3.0 * 1.0},                        3.0),
        ("lose",       {"lose": 1.0, "result": -1.0}, {"lose": -1.0 * 1.0},                   -1.0),
        ("death",      {"death": 1.0},                {"death": -1.0 * 1.0},                  -1.0),
        ("death_storm", {"death_storm": 1.0},         {"death_storm": -1.5 * 1.0},            -1.5),
        ("hit_nonlethal", {"kill": 1.0, "hit": 2.0},  {"kill": 1.0, "hit_nonlethal": 0.2 * 1.0}, 1.2),
        ("empty_fire", {"empty_fire": 1.0},           {"empty_fire": -0.10 * 1.0},            -0.10),
        ("spawn+aim",  {"spawn": 2.0, "aim": 1.0},    {"spawn": 0.02 * 2.0, "aim": 0.01 * 1.0}, 0.05),
        ("survive",    {"survive": 1.0},              {"survive": 1.0 * 1.0},                  1.0),
    ]
    for tag, r, hand, exp in cases:
        ep = [mk_frame(0, r, opp=mk_opp(((-1.0, -1.0, 1.0),)), done=True)]
        parts, _ = run_episode(ep, cfg, tag)[0]
        v = check("ep %s" % tag, parts, hand)
        assert v == exp, "%s 手算值 %r != %r" % (tag, exp, v)
    say("")

    say("== ⑤b 平局的三个边界（⛔ 不许“我赢了却给平局扣分”）==")
    # b1：我赢了、对手已死（oAlive=0）、result=+1 ⟹ 只给 win=+3.0，draw 必须为 0
    ep = [mk_frame(0, {"win": 1.0, "result": 1.0}, opp=mk_opp(((-1.0, -1.0, 0.0),)), done=True)]
    parts, v = run_episode(ep, cfg, "win_oppdead")[0]
    check("ep9014 我赢且对手死（不是平局）", parts, {"win": 3.0 * 1.0, "result": 1.0 * 0.0})
    assert parts["draw"][2] == 0.0 and v == 3.0
    # b2：双方皆死但采集器没给 -0.25 信号（result=0）⟹ 不给 draw（计数 draw_structural_no_result_signal）
    ep = [mk_frame(0, {"selfkill": 1.0, "result": 0.0}, opp=mk_opp(((-1.0, -1.0, 0.0),)), done=True)]
    parts, v = run_episode(ep, cfg, "dead_no_signal")[0]
    check("ep9015 双方皆死但 result=0 ⟹ 不给 draw", parts, {"selfkill": -1.5 * 1.0})
    assert parts["draw"][2] == 0.0 and RW.stats().get("draw_structural_no_result_signal", 0) == 1
    # b3：采集器直供 draw=1 ⟹ 用采集器的（本文件不再自己算），result 仍置 0
    ep = [mk_frame(0, {"draw": 1.0, "result": -0.25}, opp=mk_opp(((-1.0, -1.0, 0.0),)), done=True)]
    parts, v = run_episode(ep, cfg, "draw_direct")[0]
    check("ep9016 采集器直供 draw=1", parts, {"draw": -0.5 * 1.0, "result": 1.0 * 0.0})
    assert v == -0.5
    say("")
    extra_cases = [
        ("ep9014 我赢且对手死", [mk_frame(0, {"win": 1.0, "result": 1.0},
                                       opp=mk_opp(((-1.0, -1.0, 0.0),)), done=True)], [3.0]),
        ("ep9015 双死但无 -0.25 信号", [mk_frame(0, {"selfkill": 1.0, "result": 0.0},
                                             opp=mk_opp(((-1.0, -1.0, 0.0),)), done=True)], [-1.5]),
        ("ep9016 直供 draw", [mk_frame(0, {"draw": 1.0, "result": -0.25},
                                    opp=mk_opp(((-1.0, -1.0, 0.0),)), done=True)], [-0.5]),
    ]

    say("== ⑥ 速通 / 死亡过快（需要采集侧 t_min；本层直接对内部帧喂 t_min 验证公式）==")
    ep = [mk_frame(0, {"spawn": 1.0}, fire=1, done=False),
          mk_frame(1, {"kill": 1.0, "t_min": 1.0}, done=True)]
    parts, v = [(x[0], x[1]) for x in run_episode(ep, cfg, "speed")][1]
    check("ep9009 速通 T_kill=1 T_min=1 Δ=60", parts,
          {"kill": 1.0 * 1.0, "speed": 0.5 * (1.0 - (1.0 - 1.0) / 60.0)})
    say("  speed 原始量=%r 权重=%r 贡献=%r" % parts["speed"])
    ep = [mk_frame(0, {"survive": 0.0}, opp=mk_opp_fire(((-1.0, -1.0, 1.0),), 1), done=False),
          mk_frame(1, {"death": 1.0, "t_min_death": 1.0}, opp=mk_opp(((-1.0, -1.0, 1.0),)), done=True)]
    parts, v2 = [(x[0], x[1]) for x in run_episode(ep, cfg, "fast_death")][1]
    check("ep9010 死亡过快 T_death=1 T_min'=1 Δ=60", parts,
          {"death": -1.0 * 1.0, "fast_death": -0.5 * (1.0 - (1.0 - 1.0) / 60.0)})
    say("  fast_death 原始量=%r 权重=%r 贡献=%r" % parts["fast_death"])
    ep = [mk_frame(0, {"spawn": 1.0}, fire=1, done=False),
          mk_frame(1, {"kill": 1.0, "t_min": 61.0}, done=True)]        # T_kill=1 << T_min ⟹ x<0 截顶
    parts, v3 = [(x[0], x[1]) for x in run_episode(ep, cfg, "speed")][1]
    check("ep9011 速通越界(x<0 截顶=1.0)", parts, {"kill": 1.0, "speed": 0.5 * 1.0})
    ep = [mk_frame(0, {"spawn": 1.0}, fire=1, done=False),
          mk_frame(1, {"kill": 1.0, "t_min": 1.0}, done=False),
          mk_frame(2, {"kill": 1.0, "t_min": 1.0}, done=True)]         # T_kill=2 ⟹ (2-1)/60
    parts, v4 = [(x[0], x[1]) for x in run_episode(ep, cfg, "speed")][2]
    check("ep9012 速通 T_kill=2 T_min=1 Δ=60", parts,
          {"kill": 1.0 * 1.0, "speed": 0.5 * (1.0 - (2.0 - 1.0) / 60.0)})
    assert v3 == 1.5 and v4 == parts["kill"][2] + parts["speed"][2]
    say("")

    say("== ⑦ 道具奖励的线性衰减（钩子：cfg['crate_decay_train_rounds'] + cfg['train_progress01']）==")
    for prog, exp_c in ((0.0, 0.05), (0.5, 0.025), (1.0, 0.0)):
        c2 = dict(cfg)
        c2["crate_decay_train_rounds"] = 100
        c2["train_progress01"] = prog
        ep = [mk_frame(0, {"crate": 1.0}, done=True)]
        parts, v = run_episode(ep, c2, "crate_decay")[0]
        check("ep9013 crate 衰减 progress=%.2f" % prog, parts, {"crate": 0.05 * 1.0 * (1.0 - prog)})
        assert v == exp_c, "衰减后 %r != %r" % (v, exp_c)
    say("")
    say("== ⑦b 道具“我方格”在【归一化坐标】下也要对（`norm=true` ⟹ 位置是 [0,1] 比例）==")
    g_n = mk_global(selfx=0.15, selfy=0.44)          # 12m/80m、22m/50m ⟹ 格 (1,2)
    ep_n = [mk_frame(0, {"survive": 0.0}, g=g_n, item=mk_item(((0.1875, 0.5, 0.0),)), done=False),
            mk_frame(1, {"survive": 0.0}, g=g_n, item=mk_item(()), done=True)]
    parts, v = run_episode(ep_n, cfg, "crate_norm")[1]
    check("ep9017 归一化坐标 crate", parts, {"crate": 0.05 * 1.0})
    assert v == 0.05 and RW.stats().get("crate_attr_mine", 0) == 1
    extra_cases.append(("ep9017 归一化坐标 crate", ep_n, [0.0, 0.05]))
    say("")

    # ============================================================ L3 反例（⛔ 不许静默）
    say("== ⑧ 反例（必须抛错，⛔ 不静默降级）==")
    ep = [mk_frame(0, {"kill": 2.0, "hit": 1.0}, done=True)]     # hit < kill ⟹ 采集器口径已变
    try:
        run_episode(ep, cfg, "bad_hit")
        raise AssertionError("hit<kill 竟然没抛错（⛔ 会静默少算）")
    except AssertionError as e:
        if "hit<kill 竟然没抛错" in str(e):
            raise
        say("  [OK] hit<kill 抛错：%s" % str(e).splitlines()[0][:150])
    c2 = dict(cfg)
    c2["crate_decay_train_rounds"] = 100       # 配了衰减但没传进度
    c2.pop("train_progress01", None)
    try:
        run_episode([mk_frame(0, {"crate": 1.0}, done=True)], c2, "bad_decay")
        raise AssertionError("配了 crate 衰减却没传轮次，竟然没抛错")
    except AssertionError as e:
        if "竟然没抛错" in str(e):
            raise
        say("  [OK] 缺 train_progress01 抛错：%s" % str(e).splitlines()[0][:150])
    say("")

    # ============================================================ L2 真代码路径（JSON → buffer → prepare_targets）
    say("== ⑨ 真代码路径：JSON → vt_buffer.decode_episode → prepare_targets → _rew ==")
    eps_json = []
    for i, (frames, _hand) in enumerate([(main_frames, hand_main)]):
        eps_json.append({"ep": 9001 + i, "scene": {"players": 2, "mapW": 80, "mapH": 50,
                                                   "storm": False, "crates": [0, 1, 2]},
                         "win": None, "frames": [to_json(f) for f in frames]})
    for tag, r, _hand, _exp in cases:
        eps_json.append({"ep": 9100 + len(eps_json),
                         "scene": {"players": 2, "mapW": 80, "mapH": 50, "storm": False, "crates": []},
                         "win": None,
                         "frames": [to_json(mk_frame(0, r, opp=mk_opp(((-1.0, -1.0, 1.0),)), done=True))]})
    for tag, frames_x, _exp_x in extra_cases:
        eps_json.append({"ep": 9200 + len(eps_json),
                         "scene": {"players": 2, "mapW": 80, "mapH": 50, "storm": False, "crates": []},
                         "win": None, "frames": [to_json(f) for f in frames_x]})
    buf = vb.EpisodeBuffer()
    for e in eps_json:
        buf.append_episode(e)          # ⭐ 走真校验（BufferSchemaError 会当场炸）
    RW.reset_stats()
    RW._ST.reset()
    _f, _a, _r, _sd, tails = T.prepare_targets(buf, cfg)
    say("  buffer 局数=%d 帧数=%d  tails=%s" % (len(buf.episodes), len(_f), tails))
    allf = buf.all_frames()
    rew = [f["_rew"] for f in allf]
    say("  _rew（真路径）= %r" % (rew,))
    exp_all = list(tot) + [c[3] for c in cases] + [v for x in extra_cases for v in x[2]]
    say("  _rew（手算）  = %r" % (exp_all,))
    ok = all(a == b for a, b in zip(rew, exp_all)) and len(rew) == len(exp_all)
    say("  逐位相等 = %s（长度 %d vs %d）" % (ok, len(rew), len(exp_all)))
    if not ok:
        for i, (a, b) in enumerate(zip(rew, exp_all)):
            if a != b:
                say("    ❌ i=%d 真路径=%r(%s) 手算=%r(%s)" % (i, a, float(a).hex(), b, float(b).hex()))
    assert ok

    # 幂等：再跑一遍必须一模一样（状态机不能留脏）
    RW.reset_stats()
    RW._ST.reset()
    T.prepare_targets(buf, cfg)
    rew2 = [f["_rew"] for f in buf.all_frames()]
    say("  幂等复跑逐位相等 = %s" % (rew2 == rew,))
    assert rew2 == rew

    # ============================================================ ⑩ 稠密项 progress（从 obs 自己算）
    say("== ⑩ progress：`distNear` 在训练侧从 obs 算出来（采集器不提供）==")
    # 对手固定 (20,10)；自车 10→10.5 ⟹ dist 10 → 9.5 ⟹ Δ=0.5（可精确表示）⟹ prog=0.5 ⟹ 0.02*0.5=0.01
    ep = [mk_frame(0, {}, g=mk_global(selfx=10.0, selfy=10.0), opp=mk_opp(((20.0, 10.0, 1.0),)), done=False),
          mk_frame(1, {}, g=mk_global(selfx=10.5, selfy=10.0), opp=mk_opp(((20.0, 10.0, 1.0),)), done=True)]
    got = run_episode(ep, cfg, "progress")
    check("ep9020 t=0 局首帧（无上一帧）", got[0][0], {"progress": 0.02 * 0.0})
    v = check("ep9020 t=1 靠近 0.5m", got[1][0], {"progress": 0.02 * 0.5})
    assert v == 0.01 and RW.stats().get("progress_no_prev", 0) == 1
    say("  distNear 手算: t=0 |(20,10)-(10,10)|=10.0  t=1 |(20,10)-(10.5,10)|=9.5  Δ=0.5 ⟹ prog=%r"
        % (got[1][0]["progress"][0],))
    # 远离不罚：dist 10 → 12（Δ=-2）⟹ prog=0
    ep = [mk_frame(0, {}, g=mk_global(selfx=10.0, selfy=10.0), opp=mk_opp(((20.0, 10.0, 1.0),)), done=False),
          mk_frame(1, {}, g=mk_global(selfx=8.0, selfy=10.0), opp=mk_opp(((20.0, 10.0, 1.0),)), done=True)]
    v = run_episode(ep, cfg, "progress_away")[1][1]
    check("ep9021 远离 2m ⟹ 0（只奖靠近）", run_episode(ep, cfg, "progress_away")[1][0], {"progress": 0.02 * 0.0})
    assert v == 0.0
    # 触顶：dist 10 → 8（Δ=2 > clamp=1）⟹ prog=1.0 ⟹ 0.02，且计 progress_clamped
    ep = [mk_frame(0, {}, g=mk_global(selfx=10.0, selfy=10.0), opp=mk_opp(((20.0, 10.0, 1.0),)), done=False),
          mk_frame(1, {}, g=mk_global(selfx=12.0, selfy=10.0), opp=mk_opp(((20.0, 10.0, 1.0),)), done=True)]
    got = run_episode(ep, cfg, "progress_clamp")
    v = check("ep9022 靠近 2m ⟹ clamp 到 1.0", got[1][0], {"progress": 0.02 * 1.0})
    assert v == 0.02 and RW.stats().get("progress_clamped", 0) == 1
    # 无存活对手 ⟹ prog=0 且计 progress_no_opp
    ep = [mk_frame(0, {}, g=mk_global(selfx=10.0, selfy=10.0), opp=mk_opp(((20.0, 10.0, 0.0),)), done=True)]
    v = run_episode(ep, cfg, "progress_noopp")[0][1]
    check("ep9023 没有存活对手 ⟹ 0", run_episode(ep, cfg, "progress_noopp")[0][0], {"progress": 0.02 * 0.0})
    assert v == 0.0 and RW.stats().get("progress_no_opp", 0) == 1
    # 局边界重置：A(t=0,1) 之后紧接着 B(t=0,1) ⟹ B 的第一帧不得与 A 的末帧相减
    epA = [mk_frame(0, {}, g=mk_global(selfx=10.0, selfy=10.0), opp=mk_opp(((20.0, 10.0, 1.0),)), done=False),
           mk_frame(1, {}, g=mk_global(selfx=10.5, selfy=10.0), opp=mk_opp(((20.0, 10.0, 1.0),)), done=True)]
    epB = [mk_frame(0, {}, g=mk_global(selfx=30.0, selfy=10.0), opp=mk_opp(((20.0, 10.0, 1.0),)), done=False),
           mk_frame(1, {}, g=mk_global(selfx=29.5, selfy=10.0), opp=mk_opp(((20.0, 10.0, 1.0),)), done=True)]
    RW.reset_stats()
    RW._ST.reset()
    a0 = RW.explain(epA[0], cfg)[1]
    a1 = RW.explain(epA[1], cfg)[1]
    b0 = RW.explain(epB[0], cfg)[1]
    b1 = RW.explain(epB[1], cfg)[1]
    say("  局A t=0/1 = %r/%r   局B t=0/1 = %r/%r" % (a0, a1, b0, b1))
    check("ep9024 局B t=0（跨局不算差分）", RW.explain(epB[0], cfg)[0], {"progress": 0.02 * 0.0})
    assert b0 == 0.0 and a1 == 0.01
    # B 的 t=1 用的是 B 自己的 t=0（dist 10 → 9.5）⟹ 0.01；若跨局相减会得到 (10-9.5)=0.5 也行，
    #   所以用"B 的 t=0 距离与 A 的末帧距离不同"来区分：这里 A 末帧 dist=9.5、B t=0 dist=10.0
    #   ⟹ 若真跨局相减则 B t=1 的 Δ = 9.5-9.5 = 0；正确实现 Δ = 10.0-9.5 = 0.5
    check("ep9024 局B t=1（用 B 自己的上一帧）", RW.explain(epB[1], cfg)[0], {"progress": 0.02 * 0.5})
    assert b1 == 0.01, "局边界没清干净：b1=%r（应 0.01）" % (b1,)
    # 跳帧（t: 0 → 2）⟹ 差分无意义 ⟹ 0 且计数
    ep = [mk_frame(0, {}, g=mk_global(selfx=10.0, selfy=10.0), opp=mk_opp(((20.0, 10.0, 1.0),)), done=False),
          mk_frame(2, {}, g=mk_global(selfx=10.5, selfy=10.0), opp=mk_opp(((20.0, 10.0, 1.0),)), done=True)]
    v = run_episode(ep, cfg, "progress_gap")[1][1]
    check("ep9025 跳帧 t=0→2 ⟹ 0", run_episode(ep, cfg, "progress_gap")[1][0], {"progress": 0.02 * 0.0})
    assert v == 0.0 and RW.stats().get("progress_frame_gap", 0) == 1
    say("")

    RW.log_summary(prefix="收尾")
    say("")
    say("ALL_OK")

    # 逐项贡献总表（给文档抄）
    say("")
    say("== 主样本 ep9001 逐项贡献表（weight × value = contrib）==")
    say("| 项 | value | weight | contrib |")
    say("|---|---|---|---|")
    RW.reset_stats()
    RW._ST.reset()
    for i, f in enumerate(main_frames):
        parts, total = RW.explain(f, cfg)
        for k in RW.ITEMS:
            val, wgt, c = parts[k]
            if val != 0.0 or c != 0.0:
                say("| t=%d %s | %r | %r | %r |" % (i, k, val, wgt, c))
        say("| t=%d **合计** | | | **%r** |" % (i, total))
    flush_log()


if __name__ == "__main__":
    RW._reset_announce_for_test()
    main()
