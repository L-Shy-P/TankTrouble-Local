# -*- coding: utf-8 -*-
"""同帧 LP 对拍（临时只读工具，2026-10-17 夜）

目的：把"训练侧重算 logprob ≠ 推理侧给的 lp"这件事定位到【具体哪一环】。
⛔ 只读：不改 `train_ppo_online.py` / `policy_server_graph.py` / `net_v2_fixed.py` / `vt_buffer.py`
（`import` 它们、照抄它们的口径重算，不算改）。

三条口径同时算：
  ① `trainer`：`train_ppo_online.build_batch([fr], [0]) + forward_batch`（B=1, nmax=N）—— 训练侧真入口
  ② `repl`   ：照抄 `policy_server_graph.mk()` + 主循环的 `logits=sc[:N]; log_softmax`（B=1, 档位=tier）
  ③ `sub`    ：真起 `policy_server_graph.py` 子进程喂同一载荷（**证 ② 的复刻是忠实的**）

判据：同一帧 + 同一权重 ⟹ ①②③ 的 lp 差 < 1e-4。
产出：`D:/vt_run/parity/`（报告 json + 文本表）。
"""
import os, sys, json, argparse, subprocess, importlib.util, io, contextlib, time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
import numpy as np
import torch

import vt_buffer as vb
import train_ppo_online as T

TIERS = (64, 256, 512, 1008)          # ⭐ 服务端档表（policy_server_graph.py:36 `TIERS=(64,256,512,1008)`）
OUT = "D:/vt_run/parity"


def pick_tier(n):
    for t in TIERS:
        if n <= t:
            return t
    return TIERS[-1]


def log(msg):
    sys.stdout.write(str(msg) + "\n")
    sys.stdout.flush()


def load_episodes(path):
    eps = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                eps.append(json.loads(line))
    return eps


def seg_report(name, a, b):
    """逐位比较两段的 max|a-b| 与形状。a/b 是 np 或 张量。"""
    a = a.detach().cpu().numpy() if torch.is_tensor(a) else np.asarray(a)
    b = b.detach().cpu().numpy() if torch.is_tensor(b) else np.asarray(b)
    if a.shape != b.shape:
        return {"shape_a": list(a.shape), "shape_b": list(b.shape), "shape_eq": False}
    d = float(np.max(np.abs(a - b))) if a.size else 0.0
    return {"shape": list(a.shape), "max_abs_diff": d, "equal": bool(d == 0.0)}


# ---------------------------------------------------------------- ② 服务端口径复刻
def server_repl(net, fr, tier, dev):
    N = int(fr["N"])
    segs = {"node": torch.zeros(1, tier, vb.SEG_DIM["node"], device=dev),
            "opp": torch.zeros(1, vb.CAP["opp"], vb.SEG_DIM["opp"], device=dev),   # ⭐ 1→8 行：与服务端 mk() 同源
            "bullet": torch.zeros(1, 64, vb.SEG_DIM["bullet"], device=dev),
            "item": torch.zeros(1, 8, vb.SEG_DIM["item"], device=dev),
            "global": torch.zeros(1, 1, vb.SEG_DIM["global"], device=dev),
            "mem": torch.zeros(1, 4, vb.SEG_DIM["mem"], device=dev)}
    mask = torch.zeros(1, tier + vb.CTX_TOKENS, dtype=torch.bool, device=dev)
    mask[0, N:tier] = True                       # ⭐ 服务端 mk():103 `mask[0,N:mask.shape[1]-78]=True`
    parts = {"node": fr["node"], "opp": fr["opp"], "bullet": fr["bullet"],
             "item": fr["item"], "global": fr["global"], "mem": fr["mem"]}
    for k, v in parts.items():
        src = torch.tensor(np.asarray(v), device=dev)
        segs[k][0, :src.shape[0], :src.shape[1]] = src
    with torch.no_grad():
        out = net(segs, mask)
    sc = out[3][0]
    logits = sc[:N].float()
    lp = torch.log_softmax(logits, dim=-1)
    return {"lp": lp, "v": float(out[0].mean()), "mask_true": int(mask.sum().item()),
            "pos_denom": int((~mask).sum().item()), "segs": segs, "mask": mask}


def trainer_path(net, frames, idx, dev):
    b = T.build_batch(frames, idx, dev)
    with torch.no_grad():
        out = net(b["segs"], b["mask"])
    lp_nodes, ent, p = T.node_dist(out[3], b["nmax"])
    return {"lp_nodes": lp_nodes, "p": p, "v": out[0].view(-1), "b": b,
            "mask_true": int(b["mask"].sum().item()),
            "pos_denom": int((~b["mask"]).sum(dim=1)[0].item())}


# ---------------------------------------------------------------- ③ 真服务端子进程
class Srv(object):
    def __init__(self, ckpt, dev="cuda"):
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        if ckpt:
            env["VT_CKPT"] = ckpt
        self.p = subprocess.Popen(["py", "-3.13", "_tools/training/policy_server_graph.py"],
                                  cwd=REPO, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1)
        self.boot, self.err = [], []
    def readline(self, timeout=180):
        # ⚠️ 只按行读 stdout（协议：一行一个 JSON）；stderr 单独线程收集（⛔ 不许 DEVNULL）
        import threading
        def drain():
            for l in self.p.stderr:
                l = l.rstrip("\n")
                if l.strip():
                    self.err.append(l)
                    log("SRV_STDERR " + l)
        t = threading.Thread(target=drain, daemon=True)
        t.start()
        self._drain = t
        return self.p.stdout.readline()
    def boot_until(self, mark, max_lines=20):
        for i in range(max_lines):
            l = self.readline()
            if not l:
                raise RuntimeError("服务端 stdout 提前 EOF（stderr 见上）")
            self.boot.append(l.rstrip("\n"))
            log("SRV_BOOT " + l.rstrip("\n")[:140])
            if mark in l:
                return i + 1
        raise RuntimeError("开机 %d 行里没出现 %s" % (max_lines, mark))
    def ask(self, obj):
        self.p.stdin.write(json.dumps(obj) + "\n")
        self.p.stdin.flush()
        l = self.readline()
        return json.loads(l.strip())
    def close(self):
        try:
            self.p.stdin.close()
        except Exception:
            pass
        try:
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--episodes", default="D:/vt_run/collect/episodes.jsonl")
    ap.add_argument("--ckpt", default="D:/vt_run/run1/ckpt/model_latest.pt")
    ap.add_argument("--ep", type=int, default=1, help="第几局（1 基）")
    ap.add_argument("--frame", type=int, default=300, help="局内第几帧（0 基）")
    ap.add_argument("--seed", type=int, default=12345)
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--skip-sub", action="store_true")
    ap.add_argument("--batch-probe", type=int, default=8, help="混合批（B>1）漂移探针的批大小（0=关）")
    ap.add_argument("--probe-firstrun-init", type=int, default=0, help=">0：用训练器真首轮初始化（torch.manual_seed(0)+NetV2 ⟹ train_ppo_online.py:800）复算 ratio，验证首轮异常值")
    ap.add_argument("--probe-fp16", type=int, default=0, help="1：量一下『node 段 fp16 存储 vs 原始 fp32』对 lp 的影响")
    ap.add_argument("--probe-random-init", type=int, default=0, help=">0：抽 N 帧，验证『文件里的 lp 来自另一套权重』（随机初始化 vs ckpt 权重）")
    ap.add_argument("--v-match", default="", help="逗号分隔的若干 ckpt：用『记录里的 v』指认当时服务端到底用的哪套权重")
    ap.add_argument("--samples", default="", help="改从训练器抽样文件（D:/vt_run/run1/buffer_samples/*.jsonl = 首轮真数据）取帧")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    dev = a.device

    eps_raw = load_episodes(a.episodes)
    log("EPISODES 文件=%s 局数=%d" % (a.episodes, len(eps_raw)))
    ep_raw = eps_raw[a.ep - 1]
    dec = vb.decode_episode(ep_raw)          # ⭐ 走训练器自己的解码（所有闸门都在这里）
    frames = dec["frames"]
    for fr in frames:
        fr["_rew"] = float(fr["r"]["total"])
    k = min(a.frame, len(frames) - 1)
    fr = frames[k]
    if a.samples:
        # ⭐ 首轮真数据：训练器自己的抽样 dump（`buffer_samples/cycle_*.jsonl`）
        sfr = []
        for line in open(a.samples, encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            d = vb.decode_episode(json.loads(line))
            for f_ in d["frames"]:
                f_["_rew"] = float(f_["r"]["total"])
                sfr.append(f_)
        log("SAMPLES %s 帧数=%d（来自首轮真 buffer 的抽样 dump）" % (a.samples, len(sfr)))
        frames = sfr
        for fr in frames:
            fr["_rew"] = float(fr["r"]["total"])
        k = min(a.frame, len(frames) - 1)
        fr = frames[k]
        a.ep = 0
    N = int(fr["N"])
    tier = pick_tier(N)
    log("FRAME  ep=%d k=%d/%d  N=%d  tier=%d  act.nodeId=%d  lp_file=%.6f  v_file=%.6f"
        % (a.ep, k, len(frames), N, tier, fr["act"]["nodeId"], fr["lp"], fr["v"]))

    # ---------- 权重：两边【同一份】 ----------
    ck = torch.load(a.ckpt, map_location=dev, weights_only=True)
    log("CKPT %s keys=%s step=%s" % (a.ckpt, sorted(ck.keys())[:6], ck.get("step")))
    net, nv2 = T.build_net(dev)
    net.load_state_dict(ck["model"], strict=True)
    net.eval()
    md5_net = None
    import hashlib
    md5_net = hashlib.md5(open(os.path.join(HERE, "net_v2_fixed.py"), "rb").read()).hexdigest()[:8]
    log("NET 已载入同一权重（net_v2_fixed.py md5=%s）" % md5_net)

    # ---------- ① 训练侧路径 ----------
    tr = trainer_path(net, [fr], [0], dev)
    lp_tr = tr["lp_nodes"][0]

    # ---------- ② 服务端口径复刻 ----------
    rp = server_repl(net, fr, tier, dev)
    lp_rp = rp["lp"]

    # ---------- ③ 真服务端 ----------
    sub_res, l_sub = None, None
    if not a.skip_sub:
        srv = Srv(a.ckpt, dev)
        try:
            srv.boot_until("WARMUP_SAMPLE")
            payload = {"N": N, "seed": a.seed,
                       "segs": {"node": np.asarray(fr["node"], dtype=np.float32).tolist(),
                                "bullet": np.asarray(fr["bullet"], dtype=np.float32).tolist(),
                                "global": np.asarray(fr["global"], dtype=np.float32).tolist()}}
            t0 = time.time()
            sub_res = srv.ask(payload)
            log("SRV_ASK ms=%d -> %s" % ((time.time() - t0) * 1000, json.dumps(sub_res)[:200]))
            l_sub = float(sub_res["lp"])
        finally:
            srv.close()

    # ---------- 对拍 ----------
    d = torch.abs(lp_tr - lp_rp)
    rep = {"frame": {"ep": a.ep, "k": k, "N": N, "tier": tier, "act_idx": int(fr["act"]["nodeId"]),
                     "lp_file": float(fr["lp"]), "v_file": float(fr["v"]),
                     "lp_trainer_at_act": float(lp_tr[fr["act"]["nodeId"]]),
                     "lp_repl_at_act": float(lp_rp[fr["act"]["nodeId"]]),
                     "v_trainer": float(tr["v"][0]), "v_repl": rp["v"],
                     "ckpt": a.ckpt, "net_md5": md5_net},
           "lp_trainer_vs_repl": {"max_abs_diff": float(d.max()),
                                  "max_abs_diff_at_act": float(d[fr["act"]["nodeId"]]),
                                  "mean_abs_diff": float(d.mean())},
           "prob_trainer_vs_repl": {"max_abs_diff": float(torch.abs(tr["p"][0] - torch.exp(lp_rp)).max())},
           "mask": {"trainer_len": int(tr["b"]["mask"].shape[1]), "trainer_true": tr["mask_true"],
                    "repl_len": int(rp["mask"].shape[1]), "repl_true": rp["mask_true"],
                    "trainer_pos_denom": tr["pos_denom"], "repl_pos_denom": rp["pos_denom"],
                    "trainer_nmax": int(tr["b"]["nmax"])},
           "seg_inputs_trainer_vs_payload": {},
           "raw_vs_decoded": {}}
    # ⭐ 真·输入差异：采集器当时上行给服务端的【原始 JSON 数值】(fp32 文本) vs 训练器实际吃的【fp16 解码值】
    try:
        raw_fr = ep_raw["frames"][k]
        for name in ("node", "opp", "bullet", "item", "global"):
            ra = np.asarray(raw_fr["obs"][name], dtype=np.float64)
            da = np.asarray(fr[name], dtype=np.float64)
            if ra.shape != da.shape:
                rep["raw_vs_decoded"][name] = {"shape_raw": list(ra.shape), "shape_dec": list(da.shape)}
            else:
                ad = np.abs(ra - da)
                rep["raw_vs_decoded"][name] = {
                    "dtype_stored": str(np.asarray(fr[name]).dtype), "max_abs_diff": float(ad.max() if ad.size else 0.0),
                    "max_rel": float((ad / np.maximum(np.abs(ra), 1e-12)).max() if ad.size else 0.0)}
    except Exception as e_raw:
        rep["raw_vs_decoded"] = {"err": str(e_raw)}

    for name in ("node", "opp", "bullet", "item", "global", "mem"):
        rep["seg_inputs_trainer_vs_payload"][name] = seg_report(name, tr["b"]["segs"][name][0], rp["segs"][name][0])
    if l_sub is not None:
        rep["sub"] = {"lp": l_sub, "nodeId": sub_res.get("nodeId"), "v": sub_res.get("v"),
                      "mode": sub_res.get("mode"), "payload": sub_res.get("payload"),
                      "repl_lp_at_sub_idx": float(lp_rp[sub_res["nodeId"]]),
                      "repl_vs_sub_abs_diff": abs(float(lp_rp[sub_res["nodeId"]]) - l_sub),
                      "trainer_lp_at_sub_idx": float(lp_tr[sub_res["nodeId"]]),
                      "trainer_vs_sub_abs_diff": abs(float(lp_tr[sub_res["nodeId"]]) - l_sub),
                      "ratio_if_that_idx": float(np.exp(float(lp_tr[sub_res["nodeId"]]) - l_sub))}

    # ---------- 混合批（B>1）漂移探针：nmax 归一 vs 逐帧 B=1 ----------
    if a.batch_probe and a.batch_probe > 1:
        j0 = max(0, min(k, len(frames) - a.batch_probe))
        idx = list(range(j0, min(len(frames), j0 + a.batch_probe)))
        bp = trainer_path(net, frames, idx, dev)
        rows = []
        for j, i in enumerate(idx):
            ai = int(frames[i]["act"]["nodeId"])
            sg = trainer_path(net, [frames[i]], [0], dev)          # 同权重、同帧、B=1（= 服务端口径）
            d_act = float(torch.abs(bp["lp_nodes"][j, ai] - sg["lp_nodes"][0, ai]))
            d_all = float(torch.abs(bp["lp_nodes"][j, :int(frames[i]["N"])]
                                    - sg["lp_nodes"][0, :int(frames[i]["N"])]).max())
            rows.append({"i": i, "N": int(frames[i]["N"]), "d_lp_at_act": d_act,
                         "d_lp_max_any_node": d_all,
                         "ratio_if_that_idx": float(np.exp(d_act))})
        rep["mixed_batch"] = {"nmax": int(bp["b"]["nmax"]), "nmin": int(min(frames[i]["N"] for i in idx)),
                              "pos_denom": bp["pos_denom"], "rows": rows,
                              "max_d_lp_at_act": float(max(r["d_lp_at_act"] for r in rows)),
                              "max_d_lp_any_node": float(max(r["d_lp_max_any_node"] for r in rows))}
        log("MIXED_BATCH nmax=%d nmin=%d pos_denom=%d  max|Δlp@act|(B=%d vs B=1)=%.4f  ⟹ ratio 最大 %.3f"
            % (rep["mixed_batch"]["nmax"], rep["mixed_batch"]["nmin"], bp["pos_denom"], a.batch_probe,
               rep["mixed_batch"]["max_d_lp_at_act"],
               float(np.exp(rep["mixed_batch"]["max_d_lp_at_act"]))))
        log("   （逐帧明细 N / Δlp@act / ratio）: " + "; ".join(
            "%d:%.3f/%.3f" % (r["N"], r["d_lp_at_act"], r["ratio_if_that_idx"]) for r in rows))

    # ---------- 指认：记录里的 v 是哪套权重给的（v 对权重极敏感，可直接当指纹） ----------
    if a.v_match:
        cands = [("seed0_init", None)] + [(os.path.basename(os.path.dirname(p)) + "/" + os.path.basename(p), p)
                                          for p in a.v_match.split(",") if p.strip()]
        out = {}
        for name, path in cands:
            if path is None:
                torch.manual_seed(0)
                nn, _ = T.build_net(dev)
            else:
                if not os.path.isfile(path):
                    out[name] = {"err": "文件不存在"}
                    continue
                ck2 = torch.load(path, map_location=dev, weights_only=True)
                nn, _ = T.build_net(dev)
                try:
                    nn.load_state_dict(ck2["model"], strict=True)
                except RuntimeError as eLoad:
                    out[name] = {"err": "载不进（段维度不匹配）: " + str(eLoad)[:160]}
                    continue
            nn.eval()
            dv, dlp = [], []
            for f_ in frames:
                t_ = trainer_path(nn, [f_], [0], dev)
                ai = int(f_["act"]["nodeId"])
                dv.append(abs(float(t_["v"][0]) - float(f_["v"])))
                dlp.append(abs(float(t_["lp_nodes"][0, ai]) - float(f_["lp"])))
            out[name] = {"median_|dv|": float(np.median(dv)), "max_|dv|": float(max(dv)),
                         "median_|dlp|": float(np.median(dlp)), "max_|dlp|": float(max(dlp)),
                         "step": (None if path is None else int(ck2.get("step", -1)))}
        rep["v_match"] = out
        log("V_MATCH（记录里的 v / lp 与各候选权重的偏差，越小 = 越像当时服务端那套）:")
        for k2, v2 in out.items():
            if "err" in v2:
                log("   %-40s %s" % (k2, v2["err"]))
            else:
                log("   %-40s median|Δv|=%.4f  median|Δlp|=%.4f  (step=%s)" % (k2, v2["median_|dv|"],
                                                                              v2["median_|dlp|"], v2["step"]))

    # ---------- 首轮异常值复现：训练器真首轮初始化（seed 0）vs 文件里的 lp（服务端随机初始化） ----------
    if a.probe_firstrun_init:
        n_probe = min(a.probe_firstrun_init, len(frames))
        step_ = max(1, len(frames) // n_probe)
        idxs = list(range(0, len(frames), step_))[:n_probe]
        if a.samples:
            idxs = list(range(len(frames)))      # 抽样文件本来就小 ⟹ 全用
        torch.manual_seed(0)                    # ⭐ 与 train_ppo_online.main():800 逐字一致（默认 --seed 0）
        net0, _ = T.build_net(dev)
        net0.eval()
        res = {}
        for tag, nn in (("seed0_init", net0), ("ckpt", net)):
            ratios, kls, zeros = [], [], 0
            for i in idxs:
                f_i = frames[i]
                ai = int(f_i["act"]["nodeId"])
                lp_new = float(trainer_path(nn, [f_i], [0], dev)["lp_nodes"][0, ai])
                lp_old = float(f_i["lp"])
                if lp_old == 0.0 and lp_new != 0.0:
                    zeros += 1
                    ratios.append(float("inf"))
                else:
                    ratios.append(float(np.exp(lp_new - lp_old)))
                kls.append(lp_old - lp_new)
            fin = np.array([r for r in ratios if np.isfinite(r)], dtype=np.float64)
            res[tag] = {"n": len(idxs), "n_lp_zero": zeros,
                        "ratio_min": float(np.min(fin)) if fin.size else None,
                        "ratio_median": float(np.median(fin)) if fin.size else None,
                        "ratio_max": float(np.max(fin)) if fin.size else None,
                        "clip_frac": float(np.mean(np.abs(fin - 1.0) > 0.2)) if fin.size else None,
                        "kl_mean": float(np.mean(kls))}
        rep["firstrun_repro"] = res
        rep["firstrun_repro"]["firstrun_metrics"] = {"ratio_max": 47.26476287841797,
                                                     "ratio_min": 1.0758742329644729e-26,
                                                     "kl": 8.605041564404964, "clip_frac": 0.93125}
        for tag in ("seed0_init", "ckpt"):
            r0 = res[tag]
            log("FIRSTRUN_REPRO[%s] 抽 %d 帧: ratio min/median/max = %.3e / %.4f / %.3e  clip_frac=%.4f  kl_mean=%.4f  lp==0 帧=%d"
                % (tag, r0["n"], r0["ratio_min"] if r0["ratio_min"] is not None else -1,
                   r0["ratio_median"] if r0["ratio_median"] is not None else -1,
                   r0["ratio_max"] if r0["ratio_max"] is not None else -1,
                   r0["clip_frac"] if r0["clip_frac"] is not None else -1, r0["kl_mean"], r0["n_lp_zero"]))
        log("   首轮 metrics 原值: ratio_max=47.2648 ratio_min=1.0759e-26 kl=8.6050 clip_frac=0.9313")

    # ---------- fp16 探针：采集器上行给服务端的是 fp32 文本，训练器吃的是 vt_buffer 存的 fp16 ----------
    if a.probe_fp16:
        raw_fr = ep_raw["frames"][k]
        f32 = dict(fr)
        f32["node"] = np.asarray(raw_fr["obs"]["node"], dtype=np.float32)
        lp32 = trainer_path(net, [f32], [0], dev)["lp_nodes"][0]
        ai = int(fr["act"]["nodeId"])
        rep["fp16_probe"] = {
            "max_abs_diff_all": float(torch.abs(lp32 - lp_tr).max()),
            "at_act": float(torch.abs(lp32[ai] - lp_tr[ai])),
            "ratio_at_act": float(np.exp(float(lp32[ai] - lp_tr[ai]))),
            "node_max_abs_diff": float(np.max(np.abs(np.asarray(raw_fr["obs"]["node"], dtype=np.float64)
                                                     - np.asarray(fr["node"], dtype=np.float64))))}
        log("FP16_PROBE node 段 fp16 存储对 lp 的影响：max|Δlp@act|=%.3e ratio=%.6f（node 数值最大偏差 %.3e）"
            % (rep["fp16_probe"]["at_act"], rep["fp16_probe"]["ratio_at_act"],
               rep["fp16_probe"]["node_max_abs_diff"]))

    # ---------- 权重假设探针：文件里的 lp 是不是【另一套权重】给的 ----------
    if a.probe_random_init:
        n_probe = min(a.probe_random_init, len(frames))
        idxs = list(range(0, len(frames), max(1, len(frames) // n_probe)))[:n_probe]
        rnd, _ = T.build_net(dev)
        torch.manual_seed(1234)
        for p_ in rnd.parameters():
            if p_.dim() > 1:
                torch.nn.init.xavier_uniform_(p_)
            else:
                torch.nn.init.zeros_(p_)
        rnd.eval()
        rows = []
        for i in idxs:
            f_i = frames[i]
            ai = int(f_i["act"]["nodeId"])
            lp_a = trainer_path(net, [f_i], [0], dev)["lp_nodes"][0, ai]         # ckpt 权重
            lp_r = trainer_path(rnd, [f_i], [0], dev)["lp_nodes"][0, ai]         # 另一套权重
            rows.append({"i": i, "N": int(f_i["N"]), "lp_file": float(f_i["lp"]),
                         "lp_ckpt": float(lp_a), "lp_randinit": float(lp_r),
                         "d_ckpt": abs(float(lp_a) - float(f_i["lp"])),
                         "d_randinit": abs(float(lp_r) - float(f_i["lp"]))})
        rep["weight_probe"] = {"n": len(rows), "rows": rows,
                               "median_d_ckpt": float(np.median([r["d_ckpt"] for r in rows])),
                               "median_d_randinit": float(np.median([r["d_randinit"] for r in rows])),
                               "max_d_randinit": float(max(r["d_randinit"] for r in rows)),
                               "n_lp_zero_in_file": int(sum(1 for r in rows if r["lp_file"] == 0.0))}
        log("WEIGHT_PROBE 抽 %d 帧：median|lp_file - lp(ckpt权重)|=%.4f  vs  median|lp_file - lp(另一套权重)|=%.4f"
            % (len(rows), rep["weight_probe"]["median_d_ckpt"], rep["weight_probe"]["median_d_randinit"]))
        zero_all = int(sum(1 for f_ in frames if float(f_["lp"]) == 0.0))
        log("   本局 lp==0 的帧数 = %d/%d（采集器 `_collect_tmp.js:44` 用 `lp:(lpOkF?p.lp:0)` ⟹ 非有限被【静默记 0】）"
            % (zero_all, len(frames)))

    with open(os.path.join(a.out, "parity_report.json"), "w", encoding="utf-8") as fh:
        json.dump(rep, fh, ensure_ascii=False, indent=2)

    log("")
    log("================== LP 对拍表（同一帧 / 同一权重） ==================")
    log("判据列（|Δlp|）           trainer vs repl = %.3e   （阈值 1e-4）" % rep["lp_trainer_vs_repl"]["max_abs_diff"])
    log("实际动作位 (idx=%d)        trainer=%.8f repl=%.8f  |Δ|=%.3e"
        % (rep["frame"]["act_idx"], rep["frame"]["lp_trainer_at_act"], rep["frame"]["lp_repl_at_act"],
           rep["lp_trainer_vs_repl"]["max_abs_diff_at_act"]))
    log("概率最大偏差（整条分布）   = %.3e" % rep["prob_trainer_vs_repl"]["max_abs_diff"])
    log("v: trainer=%.6f  repl=%.6f  |Δ|=%.3e   （.json 里的记录 v=%.6f）"
        % (rep["frame"]["v_trainer"], rep["frame"]["v_repl"],
           abs(rep["frame"]["v_trainer"] - rep["frame"]["v_repl"]), rep["frame"]["v_file"]))
    log("mask: trainer len=%d true=%d (nmax=%d) | repl len=%d true=%d | pos 分母 trainer=%d repl=%d"
        % (tr["b"]["mask"].shape[1], tr["mask_true"], int(tr["b"]["nmax"]),
           rp["mask"].shape[1], rp["mask_true"], tr["pos_denom"], rp["pos_denom"]))
    log("逐段输入（trainer 张量 vs 服务端载荷）:")
    for name, r in rep["seg_inputs_trainer_vs_payload"].items():
        if r.get("shape_eq") is False:
            log("   %-7s 形状不一致 %s vs %s" % (name, r["shape_a"], r["shape_b"]))
        else:
            log("   %-7s shape=%-12s max|Δ|=%.3e %s" % (name, r["shape"], r["max_abs_diff"],
                                                       "EQUAL" if r["equal"] else ""))
    if l_sub is not None:
        log("真服务端: lp=%.8f idx=%d v=%.6f mode=%s payload=%s" % (l_sub, sub_res["nodeId"], sub_res["v"],
                                                                  sub_res["mode"], sub_res["payload"]))
        log("   复刻 vs 真服务端 |Δ|=%.3e（应 ~0 ⟹ 复刻忠实）" % rep["sub"]["repl_vs_sub_abs_diff"])
        log("   trainer vs 真服务端 |Δ|=%.3e ⟹ ratio=%.6f" % (rep["sub"]["trainer_vs_sub_abs_diff"],
                                                        rep["sub"]["ratio_if_that_idx"]))
    log("REPORT " + os.path.join(a.out, "parity_report.json"))


if __name__ == "__main__":
    main()
