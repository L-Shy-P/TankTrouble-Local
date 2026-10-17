# -*- coding: utf-8 -*-
"""curve_report.py —— 把"胜率曲线"做成可复现报告（**只读**已有产物）

【输入】多个 `scenes.jsonl`（每行一个 `RUN_CONTRACT` 结果，见 `_tools/eval/evaluate_30.py`）
        每个配一个标签，如 `step0/step3/step6/step10`；可选 `--scenes` 清单用于补元数据。
【输出】一份 Markdown（默认 `D:/vt_run/eval/curve.md`）：
        ① 总表：`标签 | 胜 | 负 | 未决 | 胜率 | Wilson95% | 局均帧数`
        ② 分场景拆解：人数(`2/4/8`) · 毒雾开/关 · 道具开/关，每格 `胜/负/未决 + 胜率(+Wilson)`
        ③ 一条 ASCII 曲线（胜率 vs 检查点，**同时画出 Wilson 区间**）
        ④ 统计警告：每档 `unknown` 占比 + CI 半宽 + **两档差异是否显著**
           （判据双打：Wilson 区间是否重叠 + 两比例 z 检验 `p`；另附 Fisher 精确检验作小样本补充）
        ⑤ 数据质量（`lp_finite` / `nodeid_oob` / `server_errors` / `opp_input` 分布 / 截断数）
        ⑥ 逐场景明细（附录，可 `--no-per-scene` 关掉）

【口径（⛔ 不可偷偷改）】
  · `win=1` 胜 · `win=0` 负 · 其余（`timeout/dbl_death/err`）= **未决**，**⛔ 不算负**
  · `胜率 = 胜 / (胜+负)`（未决不入分母）—— 与 `evaluate_30.py --ingest` 完全一致
  · 未决数**单独报**，且给"未决占比"，避免"分母被 unknown 吃掉看着像涨了"

【纪律】
  · ⛔ 只读：本文件**不跑局、不改任何产物**；数字全部来自输入 jsonl（每张表都能回溯到行）
  · ⛔ 不静默：缺字段 / 空文件 / 未知 `scene_id` 一律显式报错并带诊断
  · ⛔ 不编数：`n=0` 的格子写 `—`，不写 `0%`

用法：
  py -3.13 _tools/eval/curve_report.py \
     --run step0=D:/vt_run/eval_run/step0/scenes.jsonl \
     --run step3=D:/vt_run/eval_run/step3/scenes.jsonl \
     --run step6=D:/vt_run/eval_run/step6/scenes.jsonl \
     --run step10=D:/vt_run/eval_run/step10/scenes.jsonl \
     --out D:/vt_run/eval/curve.md
"""
import argparse
import hashlib
import io
import json
import math
import os
import sys
import time

DEFAULT_SCENES = "D:/vt_run/eval/scenes_30.json"
DEFAULT_OUT = "D:/vt_run/eval/curve.md"
Z95 = 1.959963984540054
ALPHA = 0.05


# ----------------------------------------------------------------------------- 基础
def die(msg):
    raise SystemExit("⛔ " + str(msg))


def md5file(path):
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for blk in iter(lambda: fh.read(1 << 20), b""):
            h.update(blk)
    return h.hexdigest()


def read_jsonl(path):
    if not os.path.exists(path):
        die("输入不存在：%s" % path)
    rows, bad = [], 0
    with io.open(path, encoding="utf-8") as fh:
        for ln, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception as e:
                bad += 1
                sys.stderr.write("⚠️ %s:%d 不是合法 JSON（%s），已跳过\n" % (path, ln, e))
    if bad:
        die("%s 有 %d 行坏 JSON —— 先修数据再出报告（⛔ 不静默丢行）" % (path, bad))
    if not rows:
        die("%s 是空的（0 行）" % path)
    return rows


def wilson(k, n, z=Z95):
    """Wilson score 95% 区间（与 `evaluate_30.py::wilson` 同口径）。n=0 ⟹ (nan, nan)。"""
    if n <= 0:
        return (float("nan"), float("nan"))
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - h) / d, (c + h) / d)


def norm_sf(z):
    """标准正态上尾 P(Z > z)。"""
    return 0.5 * math.erfc(z / math.sqrt(2.0))


def two_prop_z(x1, n1, x2, n2):
    """两比例 z 检验（合并方差，双侧）。返回 (z, p)。n 为"已决"数。"""
    if n1 <= 0 or n2 <= 0:
        return (float("nan"), float("nan"))
    p1, p2 = x1 / n1, x2 / n2
    pp = (x1 + x2) / (n1 + n2)
    se = math.sqrt(pp * (1 - pp) * (1.0 / n1 + 1.0 / n2))
    if se < 1e-12:                       # 两边都全胜 / 全负 ⟹ 退化，p 无定义
        return (float("nan"), float("nan"))
    z = (p1 - p2) / se
    return (z, 2.0 * norm_sf(abs(z)))


def _hypergeom(a, b, c, d, n):
    """2x2 表 [[a,b],[c,d]] 的超几何概率（行/列固定）。"""
    try:
        return (math.comb(a + b, a) * math.comb(c + d, c)) / math.comb(n, a + c)
    except (ValueError, ZeroDivisionError):
        return 0.0


def fisher_2x2(a, b, c, d):
    """Fisher 精确检验（双侧，按概率 <= 观测概率求和）—— 小样本时比 z 检验诚实。"""
    n = a + b + c + d
    if n == 0:
        return float("nan")
    p_obs = _hypergeom(a, b, c, d, n)
    tot, r1, c1 = 0.0, a + b, a + c
    for x in range(0, min(r1, c1) + 1):
        y, z2, w = r1 - x, c1 - x, n - r1 - c1 + x
        if y < 0 or z2 < 0 or w < 0:
            continue
        p = _hypergeom(x, y, z2, w, n)
        if p <= p_obs * (1 + 1e-9):
            tot += p
    return min(1.0, tot)


# ----------------------------------------------------------------------------- 统计
def summarize(rows):
    """单档汇总。`unknown` 单独计、不入胜率分母。"""
    n = len(rows)
    win = sum(1 for r in rows if r.get("win") == 1)
    lose = sum(1 for r in rows if r.get("win") == 0)
    unk = n - win - lose
    dec = win + lose
    lo, hi = wilson(win, dec)
    frames = [r["frames"] for r in rows if isinstance(r.get("frames"), (int, float))]
    frames_sorted = sorted(frames)
    med = None
    if frames_sorted:
        m = len(frames_sorted) // 2
        med = frames_sorted[m] if len(frames_sorted) % 2 else 0.5 * (frames_sorted[m - 1] + frames_sorted[m])
    res = {}
    for r in rows:
        k = str(r.get("result"))
        res[k] = res.get(k, 0) + 1
    return {
        "n": n, "win": win, "lose": lose, "unknown": unk, "decided": dec,
        "rate": (win / dec) if dec else None,
        "wilson": (lo, hi) if dec else None,
        "half": ((hi - lo) / 2.0) if dec else None,
        "unknown_share": (unk / n) if n else None,
        "frames_mean": (sum(frames) / len(frames)) if frames else None,
        "frames_median": med,
        "frames_n": len(frames),
        "results": res,
    }


def bucket(rows, keyfn):
    """按 keyfn 分组 ⟹ {key: [rows]}（保持插入顺序）。"""
    d = {}
    for r in rows:
        k = keyfn(r)
        if k is None:
            continue
        d.setdefault(k, []).append(r)
    return d


def group_key_players(r):
    v = r.get("players")
    return None if v is None else int(v)


def group_key_storm(r):
    v = r.get("storm")
    return None if v is None else ("开" if v else "关")


def group_key_crates(r):
    v = r.get("crates_on")
    return None if v is None else ("开" if v else "关")


def pct(x, nd=1):
    return "—" if x is None else ("%.*f%%" % (nd, 100.0 * x))


def fmt_ci(ci, nd=0):
    if not ci:
        return "—"
    lo, hi = ci
    if lo != lo:                                       # nan
        return "—"
    return "[%.*f, %.*f]" % (nd, 100 * lo, nd, 100 * hi)


def sig_verdict(p):
    if p is None or p != p:
        return "无法判定（退化）"
    return "显著" if p < ALPHA else "不显著"


# ----------------------------------------------------------------------------- 渲染
def render_total_table(runs):
    out = ["| 标签 | 胜 | 负 | 未决 | 胜率（胜/已决） | Wilson95% | 局均帧数 | 未决占比 |",
           "|---|---|---|---|---|---|---|---|"]
    for r in runs:
        s = r["stats"]
        out.append("| `%s` | %d | %d | %d | %s | %s | %s | %s |" % (
            r["label"], s["win"], s["lose"], s["unknown"],
            (pct(s["rate"]) + " (%d/%d)" % (s["win"], s["decided"])) if s["decided"] else "—",
            fmt_ci(s["wilson"]),
            "—" if s["frames_mean"] is None else "%.0f" % s["frames_mean"],
            pct(s["unknown_share"])))
    return "\n".join(out)


def render_curve(runs, height=20):
    """ASCII 曲线：横轴 = 检查点，纵轴 = 胜率(0~100%)；`o` = 点估计，`+` = Wilson 端点，`|` = 区间内部。"""
    colw = max([8] + [len(r["label"]) + 2 for r in runs])
    half = 100.0 / height / 2.0
    lines = []
    for i in range(height, -1, -1):
        y = 100.0 * i / height
        row = ""
        for r in runs:
            s = r["stats"]
            ch = " "
            if s["rate"] is not None:
                p = 100.0 * s["rate"]
                lo, hi = 100.0 * s["wilson"][0], 100.0 * s["wilson"][1]
                if abs(p - y) <= half:
                    ch = "o"
                elif abs(lo - y) <= half or abs(hi - y) <= half:
                    ch = "+"
                elif lo < y < hi:
                    ch = "|"
            row += ("{:%d}" % colw).format(ch)
        axis = "|" if abs(y - 50.0) > half else "+"
        lines.append("%5.1f%% %s%s" % (y, axis, row))
    lines.append("       " + "-" * (colw * len(runs)))
    lines.append("       " + "".join(("{:%d}" % colw).format(r["label"]) for r in runs))
    lines.append(" 胜率  " + "".join(("{:%d}" % colw).format(pct(r["stats"]["rate"])) for r in runs))
    lines.append(" 区间  " + "".join(("{:%d}" % colw).format(
        "—" if r["stats"]["wilson"] is None else "%.0f~%.0f" % (
            100 * r["stats"]["wilson"][0], 100 * r["stats"]["wilson"][1])) for r in runs))
    return "\n".join(lines)


def render_group_table(runs, keyfn, key_name, order=None):
    buckets = {r["label"]: bucket(r["rows"], keyfn) for r in runs}
    keys = set()
    for b in buckets.values():
        keys |= set(b.keys())
    if order is not None:
        keys = [k for k in order if k in keys] + sorted([k for k in keys if k not in order])
    else:
        keys = sorted(keys)
    head = "| %s | " % key_name + " | ".join("`%s`" % r["label"] for r in runs) + " |"
    out = [head, "|---" * (len(runs) + 1) + "|"]
    for k in keys:
        cells = []
        for r in runs:
            rows = buckets[r["label"]].get(k)
            if not rows:
                cells.append("—")
                continue
            s = summarize(rows)
            cells.append("%d/%d/%d · %s%s" % (
                s["win"], s["lose"], s["unknown"],
                pct(s["rate"]),
                ("" if s["rate"] is None else " " + fmt_ci(s["wilson"]))))
        out.append("| `%s` | " % k + " | ".join(cells) + " |")
    return "\n".join(out)


def render_pairwise(runs):
    """两两比较：Wilson 是否重叠 + 两比例 z 检验 p + Fisher 精确 p（小样本补充）。"""
    n_pair = len(runs) * (len(runs) - 1) // 2
    bonf = ALPHA / n_pair if n_pair else ALPHA
    out = ["| 对比 | Δ胜率 | Wilson 95%% 是否重叠 | z | p(z) | p(Fisher) | 结论（α=0.05） | 结论（Bonferroni α=%.4f） |" % bonf,
           "|---|---|---|---|---|---|---|---|"]
    details = []
    for i in range(len(runs)):
        for j in range(i + 1, len(runs)):
            a, b = runs[i], runs[j]
            sa, sb = a["stats"], b["stats"]
            if not sa["decided"] or not sb["decided"]:
                out.append("| `%s` vs `%s` | — | — | — | — | — | 无法判定（有一档 0 已决） | — |" % (a["label"], b["label"]))
                continue
            la, ha = sa["wilson"]
            lb, hb = sb["wilson"]
            overlap = not (ha < lb or hb < la)
            z, p = two_prop_z(sa["win"], sa["decided"], sb["win"], sb["decided"])
            pf = fisher_2x2(sa["win"], sa["lose"], sb["win"], sb["lose"])
            delta = 100.0 * (sa["rate"] - sb["rate"])
            v = sig_verdict(p)
            vb = ("显著" if (p == p and p < bonf) else "不显著") if p == p else "无法判定（退化）"
            # Wilson 重叠是"保守"判据：重叠 ⟹ 一定不显著
            if overlap and v == "显著":
                v = "不显著（Wilson 重叠）"
            out.append("| `%s` vs `%s` | %+.1f pp | %s | %s | %s | %s | %s | %s |" % (
                a["label"], b["label"], delta,
                "**重叠**" if overlap else "不重叠",
                "—" if z != z else "%.2f" % z,
                "—" if p != p else "%.3f" % p,
                "—" if pf != pf else "%.3f" % pf,
                v, vb))
            details.append((a["label"], b["label"], delta, overlap, p, pf, v, vb))
    return "\n".join(out), details, bonf


def render_quality(runs):
    out = ["| 标签 | 行数 | 已决 | `lp_finite` 合计 | `nodeid_oob` | `server_errors` | 截断(`timeout`) | `dbl_death` | `opp_input` 分布 |",
           "|---|---|---|---|---|---|---|---|---|"]
    for r in runs:
        rows = r["rows"]
        lp_ok = lp_tot = 0
        for x in rows:
            v = x.get("lp_finite")
            if isinstance(v, str) and "/" in v:
                a, b = v.split("/", 1)
                try:
                    lp_ok += int(a)
                    lp_tot += int(b)
                except ValueError:
                    pass
        oob = sum(int(x.get("nodeid_oob") or 0) for x in rows)
        serr = sum(int(x.get("server_errors") or 0) for x in rows)
        opp = {}
        for x in rows:
            k = str(x.get("opp_input"))
            opp[k] = opp.get(k, 0) + 1
        opp_s = " · ".join("%s×%d" % (k, v) for k, v in sorted(opp.items())) if opp else "—"
        out.append("| `%s` | %d | %d | %s | %d | %d | %d | %d | %s |" % (
            r["label"], len(rows), r["stats"]["decided"],
            ("%d/%d" % (lp_ok, lp_tot)) if lp_tot else "—",
            oob, serr,
            r["stats"]["results"].get("timeout", 0),
            r["stats"]["results"].get("dbl_death", 0), opp_s))
    return "\n".join(out)


def render_map_consistency(runs):
    """同一 `scene_id` 跨档的地图尺寸是否一致 ⟹ 直接检验"清单 `seed` 有没有钉死地图"。"""
    by = {r["label"]: {x.get("scene_id"): (x.get("mapW"), x.get("mapH")) for x in r["rows"]} for r in runs}
    ids = []
    for r in runs:
        for x in r["rows"]:
            if x.get("scene_id") not in ids:
                ids.append(x.get("scene_id"))
    same, diff, examples = 0, 0, []
    for sid in ids:
        vals = [by[r["label"]].get(sid) for r in runs]
        vals = [v for v in vals if v and v[0] is not None]
        if not vals:
            continue
        if len(set(vals)) == 1:
            same += 1
        else:
            diff += 1
            if len(examples) < 3:
                examples.append("`%s`：" % sid + " / ".join(
                    "%s=%sx%s" % (r["label"], (by[r["label"]].get(sid) or ("—", "—"))[0],
                                  (by[r["label"]].get(sid) or ("—", "—"))[1]) for r in runs))
    out = ["| 项 | 数 |", "|---|---|",
           "| 同一 `scene_id` 跨档地图尺寸**完全一致** | %d / %d |" % (same, same + diff),
           "| 同一 `scene_id` 跨档地图尺寸**不一致** | **%d / %d** |" % (diff, same + diff)]
    if examples:
        out.append("")
        out.append("> 例：" + "；".join(examples))
    return "\n".join(out)


def render_per_scene(runs, scene_order):
    sym = {"victory": "W", "defeat": "L", "timeout": "T", "dbl_death": "D"}
    head = "| 场景 | " + " | ".join("`%s`" % r["label"] for r in runs) + " |"
    out = [head, "|---" * (len(runs) + 1) + "|"]
    idx = {r["label"]: {x.get("scene_id"): x for x in r["rows"]} for r in runs}
    for sid in scene_order:
        cells = []
        for r in runs:
            x = idx[r["label"]].get(sid)
            if x is None:
                cells.append("—")
                continue
            c = sym.get(str(x.get("result")), "?")
            fr = x.get("frames")
            cells.append("%s %s" % (c, "—" if fr is None else int(fr)))
        out.append("| `%s` | " % sid + " | ".join(cells) + " |")
    out.append("")
    out.append("> 图例：`W` 胜 · `L` 负 · `T` 截断未决（帧数用满 `cap`） · `D` 双亡未决 · `?` 其他未决；数字 = 该局帧数。")
    return "\n".join(out)


# ----------------------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser(description="胜率曲线报告（只读已有 scenes.jsonl）")
    ap.add_argument("--run", action="append", required=True,
                    help="`标签=路径`，可重复（顺序即曲线顺序）")
    ap.add_argument("--scenes", default=DEFAULT_SCENES, help="评测清单（只为补元数据/校核）")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--title", default=None)
    ap.add_argument("--height", type=int, default=20, help="ASCII 曲线行数（默认 20 ⟹ 每行 5%%）")
    ap.add_argument("--no-per-scene", action="store_true")
    a = ap.parse_args()

    runs = []
    seen = set()
    for spec in a.run:
        if "=" not in spec:
            die("--run 要写成 `标签=路径`，收到：%s" % spec)
        label, path = spec.split("=", 1)
        label, path = label.strip(), path.strip()
        if not label:
            die("标签为空：%s" % spec)
        if label in seen:
            die("标签重复：%s（曲线横轴必须唯一）" % label)
        seen.add(label)
        rows = read_jsonl(path)
        runs.append({"label": label, "path": path, "rows": rows, "md5": md5file(path)})

    # ---- 元数据校核（⛔ 不静默：缺字段就报错并列出实际字段名）----
    scenes_obj = None
    if os.path.exists(a.scenes):
        with io.open(a.scenes, encoding="utf-8") as fh:
            scenes_obj = json.load(fh)
        scene_ids = [s["id"] for s in scenes_obj.get("scenes", [])]
        scene_by_id = {s["id"]: s for s in scenes_obj.get("scenes", [])}
    else:
        scene_ids, scene_by_id = [], {}
        sys.stderr.write("⚠️ 没有清单 %s ⟹ 跳过覆盖率校核/附录排序\n" % a.scenes)

    for r in runs:
        missing = [k for k in ("win", "frames") if k not in r["rows"][0]]
        if missing:
            die("%s 的第一行缺字段 %s；实际字段：%s" % (r["path"], missing, sorted(r["rows"][0].keys())))
        if scene_ids:
            unknown = sorted({x.get("scene_id") for x in r["rows"]} - set(scene_ids))
            if unknown:
                die("%s 里有不属于清单的 scene_id：%s" % (r["path"], unknown[:3]))
        # 元数据回填（人数/毒雾/道具）：行里有就用行里的，没有就查清单，都没有则报错
        for x in r["rows"]:
            for k in ("players", "storm", "crates_on"):
                if x.get(k) is None:
                    s = scene_by_id.get(x.get("scene_id"))
                    if s is None:
                        die("%s 的行 %s 既无 `%s`、清单里也查不到" % (r["path"], x.get("scene_id"), k))
                    x[k] = bool(s.get("crates")) if k == "crates_on" else s.get(k)
        r["stats"] = summarize(r["rows"])
        r["ckpts"] = sorted({str(x.get("ckpt")) for x in r["rows"] if x.get("ckpt")})
        r["ckpt_md5s"] = sorted({str(x.get("ckpt_md5")) for x in r["rows"] if x.get("ckpt_md5")})
        if len(r["ckpt_md5s"]) > 1:
            die("%s 的行里混了 %d 份不同 ckpt（%s）⟹ 这一档不是同一套权重跑出来的，⛔ 不能上图"
                % (r["label"], len(r["ckpt_md5s"]), r["ckpt_md5s"]))
        r["missing_ids"] = [s for s in scene_ids if s not in {x.get("scene_id") for x in r["rows"]}]

    order = scene_ids if scene_ids else [x.get("scene_id") for x in runs[0]["rows"]]

    # ---- 自动结论（全部来自上面算出的量）----
    ranked = [r for r in runs if r["stats"]["decided"]]
    best = max(ranked, key=lambda r: r["stats"]["rate"]) if ranked else None
    worst = min(ranked, key=lambda r: r["stats"]["rate"]) if ranked else None
    lines = []
    title = a.title or "胜率曲线报告（`step` 检查点 vs 30 场景胜率）"
    lines.append("# " + title)
    lines.append("")
    lines.append("> **生成**：`%s` · 由 `_tools/eval/curve_report.py` 自动产出（**只读**输入 jsonl，⛔ 不含任何手写数字）"
                 % time.strftime("%Y-%m-%d %H:%M:%S"))
    lines.append("> **口径**：`win=1` 胜 · `win=0` 负 · 其余（`timeout`/`dbl_death`/`err`）= **未决**；"
                 "**胜率 = 胜/(胜+负)**，未决不入分母（与 `evaluate_30.py --ingest` 一致）；未决占比单列。")
    lines.append("")
    if scenes_obj:
        lines.append("> **场景清单**：`%s` md5 `%s`（`%d` 场景）" % (
            a.scenes, md5file(a.scenes), len(scene_ids)))
    for r in runs:
        s = r["stats"]
        lines.append("> **`%s`**：`%s`（`%d` 行，md5 `%s`）%s%s" % (
            r["label"], r["path"], s["n"], r["md5"][:12],
            "" if not r["missing_ids"] else " ⚠️ **缺 %d 个场景**" % len(r["missing_ids"]),
            "" if not r["ckpts"] else " · 权重 `%s` md5 `%s`" % (
                r["ckpts"][0], (r["ckpt_md5s"][0][:12] if r["ckpt_md5s"] else "—"))))
    lines.append("")
    lines.append("## 〇 一句话结论（脚本自动判定）")
    lines.append("")
    if best and worst and best is not worst:
        sa, sb = best["stats"], worst["stats"]
        z, p = two_prop_z(sa["win"], sa["decided"], sb["win"], sb["decided"])
        pf = fisher_2x2(sa["win"], sa["lose"], sb["win"], sb["lose"])
        la, ha = sa["wilson"]
        lb, hb = sb["wilson"]
        overlap = not (ha < lb or hb < la)
        lines.append("- 点估计最高 `%s` %s（%d/%d），最低 `%s` %s（%d/%d），差 **%+.1f pp**。" % (
            best["label"], pct(sa["rate"]), sa["win"], sa["decided"],
            worst["label"], pct(sb["rate"]), sb["win"], sb["decided"],
            100 * (sa["rate"] - sb["rate"])))
        lines.append("- Wilson 95%% 区间 `%s` %s vs `%s` %s ⟹ **%s**；两比例 z 检验 `p=%.3f`、Fisher `p=%.3f` ⟹ **%s**。" % (
            best["label"], fmt_ci(sa["wilson"]), worst["label"], fmt_ci(sb["wilson"]),
            "重叠（保守判据 ⟹ 不显著）" if overlap else "不重叠",
            p if p == p else float("nan"), pf,
            "差异显著" if (p == p and p < ALPHA and not overlap) else "差异不显著"))
        lines.append("- ⟹ **最高与最低之间都站不住 ⟹ 「曲线在涨」这一说法在本批数据上【不成立】。**"
                     if not (p == p and p < ALPHA and not overlap) else
                     "- ⟹ 最高与最低之间差异显著，但**仍要看相邻档是否显著**（见 §四）。")
    elif best:
        lines.append("- 只有一档有已决局（`%s` %s），**无法比较**。" % (best["label"], pct(best["stats"]["rate"])))
    lines.append("")

    lines.append("## 一 总表")
    lines.append("")
    lines.append(render_total_table(runs))
    lines.append("")
    lines.append("> `Wilson95%` = 胜/已决 的 Wilson 95% 区间（百分点）。`局均帧数` = 该档**所有**行的 `frames` 均值"
                 "（含未决的满 `cap` 行 ⟹ 偏大，见 `frames_median` 在脚本 stdout）。")
    lines.append("")

    lines.append("## 二 ASCII 曲线（含 Wilson 95% 区间）")
    lines.append("")
    lines.append("```")
    lines.append(render_curve(runs, height=a.height))
    lines.append("```")
    lines.append("")
    lines.append("> `o` = 点估计 · `+` = Wilson 区间端点 · `|` = 区间内部 ⟹ **同一水平线上出现两个 `o`、"
                 "而竖条互相有重叠 ⟹ 这两档的差在 95% 置信度下说不清**（这就是「噪声有多大」）。")
    lines.append("")

    lines.append("## 三 分场景拆解")
    lines.append("")
    lines.append("### 3.1 按人数（`2/4/8`）")
    lines.append("")
    lines.append(render_group_table(runs, group_key_players, "人数", order=[2, 4, 8]))
    lines.append("")
    lines.append("### 3.2 按毒雾（开/关）")
    lines.append("")
    lines.append(render_group_table(runs, group_key_storm, "毒雾", order=["关", "开"]))
    lines.append("")
    lines.append("### 3.3 按道具（开/关）")
    lines.append("")
    lines.append(render_group_table(runs, group_key_crates, "道具", order=["关", "开"]))
    lines.append("")
    lines.append("> 每格 = `胜/负/未决 · 胜率 [Wilson95%]`；`胜率 = 胜/(胜+负)`，未决不入分母；`—` = 该格没有行。")
    lines.append("")

    lines.append("## 四 ⚠️ 统计警告：这些差到底显不显著")
    lines.append("")
    lines.append("### 4.1 每档的「噪声底」：`unknown` 占比 + 置信区间半宽")
    lines.append("")
    lines.append("| 标签 | 行数 | 未决 | 未决占比 | 已决 | 胜率 | Wilson 半宽（±pp） |")
    lines.append("|---|---|---|---|---|---|---|")
    for r in runs:
        s = r["stats"]
        lines.append("| `%s` | %d | %d | %s | %d | %s | %s |" % (
            r["label"], s["n"], s["unknown"], pct(s["unknown_share"]), s["decided"], pct(s["rate"]),
            "—" if s["half"] is None else "%.1f" % (100 * s["half"])))
    lines.append("")
    tot_unk = sum(r["stats"]["unknown"] for r in runs)
    tot_n = sum(r["stats"]["n"] for r in runs)
    lines.append("> 合计 **%d/%d 行未决（%s）**。未决 = 打了 `cap` 帧还没分出胜负（`timeout`）或双亡（`dbl_death`）"
                 "⟹ **它们既不是胜也不是负，只让分母变小、让区间变宽**。"
                 % (tot_unk, tot_n, pct(tot_unk / tot_n if tot_n else None)))
    lines.append("")
    pw, details, bonf = render_pairwise(runs)
    lines.append("### 4.2 两两比较（Wilson 重叠 + 两比例 z 检验，附 Fisher 精确检验）")
    lines.append("")
    lines.append(pw)
    lines.append("")
    lines.append("> 判据：**① Wilson 95%% 区间不重叠** 且 **② 两比例 z 检验 `p < 0.05`** ⟹ 才算显著；"
                 "两者冲突时按**保守**（不显著）算。`Fisher` 是小样本精确补充（`z` 检验在 `n≈10` 时并不可靠）。"
                 "`Bonferroni` 列把 `α` 除以本次比较对数 `%d` ⟹ `α=%.4f`，用来防「比来比去总有一个显著」。" % (
                     len(details), bonf))
    lines.append("")
    sig = [d for d in details if d[6] == "显著"]
    lines.append("**自动判定**：本次共 `%d` 对比较，按 `α=0.05` 双判据 **显著的有 `%d` 对**%s。" % (
        len(details), len(sig),
        ("：" + "、".join("`%s` vs `%s`" % (d[0], d[1]) for d in sig)) if sig else " ⟹ **没有任何一对能说「真的变好了」**"))
    lines.append("")

    lines.append("## 五 数据质量（跨档必须同口径）")
    lines.append("")
    lines.append(render_quality(runs))
    lines.append("")
    lines.append("> `lp_finite` = 策略服务端返回有限 `lp` 的帧数 / 询问帧数（不足 100% ⟹ 那些帧动作用的是上一帧 `nodeId`）；"
                 "`nodeid_oob` = 候选集越界次数（应恒 `0`）；`server_errors` = 服务端拒绝次数；"
                 "`opp_input` = 多对手时喂进网络 `opp` 槽的实际内容（`native(1)` = 1v1 原生；"
                 "`nearestAlive(n->1)` = **只喂最近一个对手**，⛔ 不是权威观测口径）。")
    lines.append("")
    lines.append("### 5.1 跨档地图一致性（直接检验「清单 `seed` 有没有钉死地图」）")
    lines.append("")
    lines.append(render_map_consistency(runs))
    lines.append("")
    lines.append("> 清单里的 `seed` 只被跑局器当作**动作采样种子**（`run_scenes_30.js:181`），**没有传给 `match.open()`** "
                 "⟹ 地图每局随机。上表「不一致」越多 ⟹ **越不能做「同图对拍」，只能看趋势**。")
    lines.append("")

    if not a.no_per_scene:
        lines.append("## 六 附录：逐场景明细")
        lines.append("")
        lines.append(render_per_scene(runs, order))
        lines.append("")

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    md = "\n".join(lines) + "\n"
    with io.open(a.out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(md)
    print("WROTE %s (%d bytes) md5=%s" % (a.out, len(md.encode("utf-8")), md5file(a.out)))
    for r in runs:
        s = r["stats"]
        print("  %-8s n=%2d win=%2d lose=%2d unk=%2d rate=%s wilson=%s frames_mean=%s median=%s" % (
            r["label"], s["n"], s["win"], s["lose"], s["unknown"], pct(s["rate"]), fmt_ci(s["wilson"]),
            "—" if s["frames_mean"] is None else "%.0f" % s["frames_mean"],
            "—" if s["frames_median"] is None else "%.0f" % s["frames_median"]))
    print("  pairwise: %s" % ("; ".join("%s vs %s: %+.1fpp p=%.3f fisher=%.3f -> %s" % (
        d[0], d[1], d[2], d[4] if d[4] == d[4] else float("nan"), d[5], d[6]) for d in details)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
