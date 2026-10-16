# -*- coding: utf-8 -*-
"""evaluate_30.py —— 固定 `30` 场景评测器（`G4`/`P0-4`）

【出处】
  · `docs/.../今晚持续训练方案-2026-10-17.md` §一（目标：总胜率 `>50%`，分档报）· §二（场景定义 + 地图公式）
  · `docs/.../今晚训练循环-G4盘点与设计-2026-10-17.md` §三（`30` 场景 = `3` 档 × `10` 局；§3.4 统计分辨率）
  · 地图尺寸公式（原版 `BootCampGameMode.getMaze`，父代理已独立核实）：
        `W = min(MAX_WIDTH , floor((BASE_WIDTH  + WIDTH_FOR_PLAYERS[n])  × U(1, MAX_RANDOM_WIDTH_MULTIPLIER)))`
        `H = min(MAX_HEIGHT, floor((BASE_HEIGHT + HEIGHT_FOR_PLAYERS[n]) × U(1, MAX_RANDOM_HEIGHT_MULTIPLIER)))`
    常量出处：`game_core/js/b714588dc4621fe104113111ba90b1a7.js`（压缩单行，`Constants.MAZE`）
        `BASE_WIDTH=2 · WIDTH_FOR_PLAYERS=[0,2,4,6,8,9,10,11,12] · MAX_RANDOM_WIDTH_MULTIPLIER=1.5 · MAX_WIDTH=16`
        `BASE_HEIGHT=2 · HEIGHT_FOR_PLAYERS=[0,1,2,3,4,5,5,6,6] · MAX_RANDOM_HEIGHT_MULTIPLIER=1.5 · MAX_HEIGHT=10`
        （`game_core/js/training_mode.js:1789-1795` 是训练模式下的同一套换算）
    ⟹ 推算区间：`2` 人 `6~8 × 4~5` · `4` 人 **`10~14 × 6~8`** · `8` 人 `14~16 × 8~10`
       ⚠️ **更正**：`G4 文档 §3.1` 表里写的 `4` 人 `10~12 × 6` 与该公式不符（漏了 `U(1,1.5)` 的 1.5 倍上界）——
       本文件的区间是**按公式重算的**（见 `derive_ranges()`，逐值可复现）。
  · 胜负信号：`SCORE_TYPES:{KILL:0,VICTORY:1}`（`阶段2-1取数清单-2026-10-12.md:70`）+
    `BootCamp` 终止条（场上坦克数 ≤ 1，`训练数据污染排查-2026-10-10.md:191-193`）

【三种用法】
  · `--write-list`：生成 `D:/vt_run/eval/scenes_30.json`（清单写死 = 保证"同一批场景"的第 1 层）
  · `--check`     ：校验清单（`30` 局 / `12` 组合全覆盖 / 字段齐全）并打印 `md5`
  · `--ingest results.jsonl`：把"跑局结果"汇总成 总胜率 + 分档胜率 + 二项置信区间 + 平均帧数，
                    追加一行 `kind:"eval"` 到 `D:/vt_run/metrics/metrics.jsonl`（每行带清单 `md5`）

⛔ **本文件【不造场景注入】、⛔【不写采集器】** —— `--run` 走"外部跑局器"契约（见 `RUN_CONTRACT`）；
   若 `G2`（场景随机化）/ 多 `Laika` 实例还没落地，`--run` **会显式报错并列出缺什么**（⛔ 不静默降级）。
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_OUT = "D:/vt_run"
DEFAULT_LIST = "D:/vt_run/eval/scenes_30.json"

# ---- 常量（出处见文件头）----
WFP = [0, 2, 4, 6, 8, 9, 10, 11, 12]
HFP = [0, 1, 2, 3, 4, 5, 5, 6, 6]
BASE_W, BASE_H = 2, 2
MAX_W, MAX_H = 16, 10
MULT_W = MULT_H = 1.5
AVAIL_CRATES = [0, 1, 2, 3, 4, 5, 6]        # BOOT_CAMP.DEFAULT_AVAILABLE_CRATES（同文件 Constants.GAME_MODE_INFO）
EPOCH = 1700000000000                        # 【无出处、待定】固定 `Date.now()` 基准：钉死 Phaser 主题 + 第二路 RNG 种子

RUN_CONTRACT = (
    "外部跑局器契约（`--runner-cmd`，给 `G2`/采集器用）：命令里用 `{scene}` 会被替换成该场景的 JSON 串；"
    "它必须对每个场景在 stdout **恰好打印一行** JSON："
    '{"scene_id":str,"ok":bool,"win":1|0|null,"result":"victory|defeat|timeout|dbl_death|unknown",'
    '"frames":int,"players":int,"mapW":int,"mapH":int,"storm":bool,"crates_on":bool,"err":null|str}；'
    "`win` 只能取 1/0/null（null ⟹ 记 `unknown`，⛔ 不许静默当负）。"
)


def derive_ranges(n):
    """按原版公式推算 (宽区间, 高区间)。`U(1,1.5)` ⟹ 上界取 `floor(base*1.5 - eps)` 再被 `MAX` 截断。"""
    def rng(base, mx):
        lo = min(mx, int(base * 1.0))
        hi = min(mx, int((base * MULT_W) - 1e-9))
        return [lo, hi]
    return rng(BASE_W + WFP[n], MAX_W), rng(BASE_H + HFP[n], MAX_H)


def build_scenes():
    """`3` 档 × (`3+3+2+2`) = `30` 局（组合与 `seed` 清单照 `G4 文档 §3.1`）。"""
    combos = [(False, True, 3, 101), (True, True, 3, 102), (False, False, 2, 103), (True, False, 2, 104)]
    scenes = []
    for players, tag in ((2, 1), (4, 2), (8, 3)):
        for storm, crates_on, k, seed_base in combos:
            for j in range(k):
                seed = seed_base * 100 + tag * 10000 + j + 1
                rng_w, rng_h = derive_ranges(players)
                scenes.append({
                    "id": "p%d_%s_%s_%d" % (players, "storm" if storm else "clear",
                                            "crates" if crates_on else "nocrate", seed),
                    "players": players,
                    "storm": bool(storm),
                    "crates_on": bool(crates_on),
                    "crates": list(AVAIL_CRATES) if crates_on else [],
                    "seed": int(seed),
                    "epoch": EPOCH,
                    "expect": {"mapW": rng_w, "mapH": rng_h},
                })
    return scenes


def md5file(path):
    with open(path, "rb") as fh:
        return hashlib.md5(fh.read()).hexdigest()


def write_list(path, scenes):
    obj = {"format": "vantage-eval-scenes-v1",
           "created": time.strftime("%Y-%m-%d %H:%M:%S"),
           "rule": "固定 30 场景：3 档(2/4/8 人) × {毒雾关/开 × 道具开/关}，每组合 3/3/2/2 局",
           "basis": {"formula": "min(MAX, floor((BASE + FOR_PLAYERS[n]) * U(1, MAX_RANDOM_MULTIPLIER)))",
                     "WIDTH_FOR_PLAYERS": WFP, "HEIGHT_FOR_PLAYERS": HFP,
                     "BASE_WIDTH": BASE_W, "BASE_HEIGHT": BASE_H, "MAX_WIDTH": MAX_W, "MAX_HEIGHT": MAX_H,
                     "MAX_RANDOM_WIDTH_MULTIPLIER": MULT_W, "MAX_RANDOM_HEIGHT_MULTIPLIER": MULT_H,
                     "src": "game_core/js/b714588dc4621fe104113111ba90b1a7.js (Constants.MAZE)",
                     "crates_src": "Constants.GAME_MODE_INFO[BOOT_CAMP].DEFAULT_AVAILABLE_CRATES",
                     "epoch_note": "【无出处、待定】固定基准，用来钉死主题/第二路 RNG；正确值应由 G2 录制时给出"},
           "runner_contract": RUN_CONTRACT,
           "unknown_policy": "win=null ⟹ 记 unknown，⛔ 不许当负",
           "scenes": scenes}
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=1)
    return md5file(path)


def check_list(path):
    if not os.path.exists(path):
        raise SystemExit("清单不存在：%s（先跑 `--write-list`）" % path)
    obj = json.load(open(path, encoding="utf-8"))
    scenes = obj["scenes"]
    errs = []
    if len(scenes) != 30:
        errs.append("场景数 %d != 30" % len(scenes))
    need = set()
    for p in (2, 4, 8):
        for s in (False, True):
            for c in (False, True):
                need.add((p, s, c))
    got = {}
    for s in scenes:
        key = (s["players"], s["storm"], s["crates_on"])
        got[key] = got.get(key, 0) + 1
        for k in ("id", "players", "storm", "crates", "seed", "expect"):
            if k not in s:
                errs.append("场景 %s 缺字段 %s" % (s.get("id"), k))
        if len(s.get("expect", {}).get("mapW", [])) != 2 or len(s.get("expect", {}).get("mapH", [])) != 2:
            errs.append("场景 %s 的 expect.mapW/mapH 不是区间" % s.get("id"))
        if s["crates_on"] and not s["crates"]:
            errs.append("场景 %s crates_on=True 但 crates 为空" % s["id"])
        if (not s["crates_on"]) and s["crates"]:
            errs.append("场景 %s crates_on=False 但 crates 非空" % s["id"])
    for k in sorted(need):
        if k not in got:
            errs.append("组合缺失 (players=%s,storm=%s,crates=%s)" % k)
    return obj, errs, got


def wilson(k, n, z=1.96):
    """Wilson 95% 区间（小样本比正态近似稳）；出处：统计学常规，本文件自算。"""
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5)
    return ((c - h) / d, (c + h) / d)


def summarize(results, scenes_md5, scenes):
    """胜率 + 分档 + 二项置信区间 + 平均帧数。⛔ `unknown` 单独报，不算负。"""
    by_id = {s["id"]: s for s in scenes}
    n = len(results)
    win = sum(1 for r in results if r.get("win") == 1)
    lose = sum(1 for r in results if r.get("win") == 0)
    unk = sum(1 for r in results if r.get("win") not in (1, 0))
    dec = win + lose
    lo, hi = wilson(win, dec if dec else 0)
    frames = [r["frames"] for r in results if isinstance(r.get("frames"), (int, float))]
    out = {
        "scenes_md5": scenes_md5, "scenes": len(scenes), "results": n,
        "win": win, "lose": lose, "unknown": unk,
        "win_rate": (win / dec) if dec else None,
        "win_rate_ci95_wilson": [lo, hi] if dec else None,
        "win_rate_ci95_normal_halfwidth": (1.96 * ((win / dec) * (1 - win / dec) / dec) ** 0.5) if dec else None,
        "frames_mean": (sum(frames) / len(frames)) if frames else None,
        "buckets": {},
    }
    def bucket(name, keyfn):
        d = {}
        for r in results:
            s = by_id.get(r.get("scene_id"), {})
            k = keyfn(r, s)
            if k is None:
                continue
            e = d.setdefault(str(k), {"n": 0, "win": 0, "lose": 0, "unknown": 0})
            e["n"] += 1
            if r.get("win") == 1:
                e["win"] += 1
            elif r.get("win") == 0:
                e["lose"] += 1
            else:
                e["unknown"] += 1
        for k, e in d.items():
            dec2 = e["win"] + e["lose"]
            e["win_rate"] = (e["win"] / dec2) if dec2 else None
            e["ci95"] = list(wilson(e["win"], dec2)) if dec2 else None
        out["buckets"][name] = d
    bucket("players", lambda r, s: r.get("players", s.get("players")))
    bucket("storm", lambda r, s: r.get("storm", s.get("storm")))
    bucket("crates", lambda r, s: (r.get("crates_on", s.get("crates_on")) if "crates_on" in r
                                   else ("on" if s.get("crates") else "off")))
    # 地图尺寸联动核对（方案 §二要求"确认联动成立"）
    sizes = {}
    for r in results:
        p = r.get("players", by_id.get(r.get("scene_id"), {}).get("players"))
        if p is None or r.get("mapW") is None:
            continue
        sizes.setdefault(str(p), []).append([r["mapW"], r.get("mapH")])
    out["mapSizes_by_players"] = {k: {"n": len(v),
                                      "W": [min(x[0] for x in v), max(x[0] for x in v)],
                                      "H": [min(x[1] for x in v) if v[0][1] is not None else None,
                                            max(x[1] for x in v) if v[0][1] is not None else None]}
                                 for k, v in sizes.items()}
    return out


def ingest(path, list_path, out_dir):
    obj, errs, got = check_list(list_path)
    if errs:
        raise SystemExit("⛔ 评测清单不合格：\n  " + "\n  ".join(errs))
    res = []
    with open(path, encoding="utf-8") as fh:
        for ln, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            res.append(r)
    ids = {s["id"] for s in obj["scenes"]}
    missing = ids - {r.get("scene_id") for r in res}
    unknown_ids = {r.get("scene_id") for r in res} - ids
    if missing:
        raise SystemExit("⛔ 评测不完整：清单里还有 %d 个场景没有结果（例：%s）"
                         % (len(missing), sorted(missing)[:3]))
    if unknown_ids:
        raise SystemExit("⛔ 结果里有不属于清单的 scene_id：%s" % sorted(unknown_ids)[:3])
    s = summarize(res, md5file(list_path), obj["scenes"])
    s.update({"kind": "eval", "ts": time.time(), "source": os.path.abspath(path),
              "list": os.path.abspath(list_path), "coverage": {str(k): v for k, v in got.items()}})
    mp = os.path.join(out_dir, "metrics", "metrics.jsonl")
    os.makedirs(os.path.dirname(mp), exist_ok=True)
    with open(mp, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(s, ensure_ascii=False) + "\n")
    print(json.dumps(s, ensure_ascii=False, indent=1))
    return s


def run_mode(list_path, runner_cmd, out_dir):
    """`--run`：走外部跑局器（⛔ 本文件不造场景注入）。"""
    if not runner_cmd:
        raise SystemExit(
            "⛔ `--run` 现在【跑不了局】，缺的是（⛔ 不是本文件的活）：\n"
            "  ① `G2`：场景随机化 —— `_tools/headless/match.js:162-180` 的 `open()` 只收 "
            "`{rng,rngSeq,control,waitRound,page,verbose,epoch}`，**没有 players/storm/crates**；\n"
            "     CLI（`match.js:568-580`）也只有 `--frames/--shot/--verbose`；毒雾钩子 = "
            "`gc.gameMode.setStorm(...)`（`training_mode.js:1971,1979`）；\n"
            "  ② 多 `Laika` 实例（`P1-2`）：`ai_strength_config.js` 各档只定义同一个 `6148530`，"
            "8 人局凑不齐 7 个对手（`今晚持续训练方案-2026-10-17.md:82-100`）；\n"
            "  ③ 胜负信号已具备：`gc.getScores()` 的 `VICTORY(type=1)` + `BootCamp` 终止条（坦克数≤1）——"
            "跑局器照 `RUN_CONTRACT` 打一行 JSON 即可。\n"
            "  给 `--runner-cmd` 我就能接上；在此之前 `--ingest` 已经把【汇总/置信区间/分档/落盘】做好了。\n"
            + RUN_CONTRACT)
    obj, errs, _ = check_list(list_path)
    if errs:
        raise SystemExit("⛔ 清单不合格：%s" % errs)
    rows = []
    for s in obj["scenes"]:
        cmd = runner_cmd.replace("{scene}", json.dumps(s, ensure_ascii=False))
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding="utf-8")
        if p.returncode != 0:
            raise SystemExit("⛔ 跑局器失败（scene=%s rc=%d）\nstderr 尾部：\n%s"
                             % (s["id"], p.returncode, (p.stderr or "")[-1500:]))
        lines = [l for l in (p.stdout or "").splitlines() if l.strip().startswith("{")]
        if len(lines) != 1:
            raise SystemExit("⛔ 跑局器必须对每个场景【恰好打印一行】JSON，实际 %d 行（scene=%s）"
                             % (len(lines), s["id"]))
        r = json.loads(lines[0])
        if r.get("scene_id") != s["id"]:
            raise SystemExit("⛔ scene_id 对不上：%s vs %s" % (r.get("scene_id"), s["id"]))
        rows.append(r)
        print("  scene %s win=%s frames=%s" % (s["id"], r.get("win"), r.get("frames")), flush=True)
    rp = os.path.join(out_dir, "eval", "results_%d.jsonl" % int(time.time()))
    os.makedirs(os.path.dirname(rp), exist_ok=True)
    with open(rp, "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    print("结果写到 %s" % rp)
    return ingest(rp, list_path, out_dir)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write-list", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--ingest", default=None, help="跑局结果 JSONL（每场景一行，照 RUN_CONTRACT）")
    ap.add_argument("--run", action="store_true", help="走外部跑局器（需 --runner-cmd）")
    ap.add_argument("--runner-cmd", default=None)
    ap.add_argument("--list", default=DEFAULT_LIST)
    ap.add_argument("--out", default=DEFAULT_OUT)
    a = ap.parse_args()
    if a.write_list:
        scenes = build_scenes()
        md5 = write_list(a.list, scenes)
        print("WROTE %s scenes=%d md5=%s" % (a.list, len(scenes), md5))
        for p in (2, 4, 8):
            w, h = derive_ranges(p)
            print("   %d 人 宽 %s 高 %s" % (p, w, h))
        return 0
    if a.check:
        obj, errs, got = check_list(a.list)
        print("LIST %s scenes=%d md5=%s" % (a.list, len(obj["scenes"]), md5file(a.list)))
        print("COVERAGE %s" % json.dumps({str(k): v for k, v in sorted(got.items())}, ensure_ascii=False))
        if errs:
            print("CHECK_FAILED:\n  " + "\n  ".join(errs))
            return 1
        print("CHECK_OK（30 局 / 12 组合全覆盖 / 字段齐全）")
        return 0
    if a.ingest:
        ingest(a.ingest, a.list, a.out)
        return 0
    if a.run:
        run_mode(a.list, a.runner_cmd, a.out)
        return 0
    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
