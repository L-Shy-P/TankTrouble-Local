# -*- coding: utf-8 -*-
"""近线 buffer（路线 C）—— 采集器 → 训练器 的【唯一接口】。

【出处】
  · 父代理裁定 `2026-10-17`（派单原文）：「定义并实现"近线 buffer"（父代理已裁定：走路线 `C`）」
  · `docs/Vantage躲弹实现/02-实现/实施方案/今晚训练循环-G4盘点与设计-2026-10-17.md`
      §2.1（数据流）· §2.3（参数表）· §四 `P0-1`（观测上行）/`P2-2`（小记录落盘）/`C1~C6` 契约
  · 段维度 `SEG` 出处：`_tools/training/net_v2_fixed.py:7`（`node 10 / opp 15 / bullet 6 / item 6 / global 38 / mem 256`）
    与 `docs/.../阶段2-3观测字段表-定稿-2026-10-12.md`
  · 段容量 `N_NODE/N_OPP/N_BUL/N_ITM/N_GLB/N_MEM = 1000/1/64/8/1/4` 出处：`net_v2_fixed.py:8`
  · 动作口径「只在前 `N` 个节点 token 里选 1 个」出处：父代理派单 `2026-10-17`
    （依据是父代理实测的推理侧越界缺陷：`今晚持续训练方案-2026-10-17.md:105-147`）

⚠️ 本模块【只做两件事】：① 严格校验字段（⛔ 不许静默降级，遵 `子代理通用背景.md` 铁律二）
   ② 把一局帧存进 `RAM`（`float16/float32`，不落全量）。
⛔ 这里【不】写采集器（`P0-1`/`P0-2` 归别的子代理）、⛔【不】写训练逻辑（在 `train_ppo_online.py`）。

谁写谁读：
    写 = 采集器（页面 `VantageObserve.encode` → Node 侧 `rollout_loop.js` → 本模块 `append_episode`）
    读 = 训练器 `_tools/training/train_ppo_online.py`
传输（见 §"传输"）：stdin 每行 = 一局 JSON；本模块 `decode_episode()` 负责解码后再校验。
"""
import json
import os

import numpy as np

# ---------------------------------------------------------------- 段定义（与网络对齐）
SEG_DIM = {"node": 10, "opp": 15, "bullet": 6, "item": 6, "global": 38, "mem": 256}
CAP = {"node": None, "opp": 1, "bullet": 64, "item": 8, "global": 1, "mem": 4}  # node 容量 = N（不填）
SEG_ORDER = ("node", "opp", "bullet", "item", "global", "mem")
CTX_TOKENS = CAP["opp"] + CAP["bullet"] + CAP["item"] + CAP["global"] + CAP["mem"]  # = 78
assert CTX_TOKENS == 78, "上下文 token 数必须 = 78（opp1+bullet64+item8+global1+mem4）"

# 帧内 dtype（fp16 只给 node：省 RAM；其余段只有 ~1.5k 个数）
DTYPE = {"node": np.float16, "opp": np.float32, "bullet": np.float32,
         "item": np.float32, "global": np.float32, "mem": np.float32}

REQUIRED_FRAME_KEYS = ("t", "N", "obs", "act", "lp", "v", "r", "done")
REQUIRED_EP_KEYS = ("ep", "frames")
REWARD_KEYS = ("total", "result", "survive", "legal")
SCENE_KEYS = ("players", "mapW", "mapH", "storm", "crates")


class BufferSchemaError(ValueError):
    """字段不合法 ⟹ 带上诊断信息抛错（⛔ 不静默裁剪/不静默降级）。"""


def _need(d, key, ctx):
    if not isinstance(d, dict):
        raise BufferSchemaError("%s: 期望 dict，实际 %s" % (ctx, type(d).__name__))
    if key not in d:
        raise BufferSchemaError("%s: 缺字段 %r —— 实际有这些键: %s"
                                % (ctx, key, sorted(d.keys())))


def _as_int(x, ctx):
    if isinstance(x, bool) or not isinstance(x, (int, np.integer)):
        if isinstance(x, float) and float(x).is_integer():
            return int(x)
        raise BufferSchemaError("%s: 期望 int，实际 %r (%s)" % (ctx, x, type(x).__name__))
    return int(x)


def _as_float(x, ctx):
    if isinstance(x, bool) or not isinstance(x, (int, float, np.floating, np.integer)):
        raise BufferSchemaError("%s: 期望 float，实际 %r (%s)" % (ctx, x, type(x).__name__))
    f = float(x)
    if not np.isfinite(f):
        raise BufferSchemaError("%s: 非有限值 %r（品质闸门 lp_finite=100%% 要求有限）" % (ctx, x))
    return f


def decode_seg(val, name, ctx):
    """把一帧的某一段解成 (rows, dim) 的 np 数组。

    允许两种编码（显式二选一，⛔ 不混用）：
      · 嵌套 list                     —— 小 `N`/烟测用
      · {"b64":..., "dtype":..., "shape":[r,c]} —— 采集器快路（fp16 原始字节，C 序、小端）
    """
    dim = SEG_DIM[name]
    if isinstance(val, dict):
        _need(val, "b64", ctx)
        raw = np.frombuffer(__import__("base64").b64decode(val["b64"]),
                            dtype=np.dtype(val.get("dtype", "float16")))
        shape = tuple(int(x) for x in val["shape"])
        if raw.size != shape[0] * shape[1]:
            raise BufferSchemaError("%s: b64 字节数 %d 与 shape %s 不匹配（元素数 %d）"
                                    % (ctx, raw.size, shape, shape[0] * shape[1]))
        arr = raw.reshape(shape)
    elif isinstance(val, (list, np.ndarray)):
        arr = np.asarray(val)
    else:
        raise BufferSchemaError("%s: 段 %r 期望 list 或 {'b64',...}，实际 %s" % (ctx, name, type(val).__name__))
    if arr.ndim != 2 or arr.shape[1] != dim:
        raise BufferSchemaError("%s: 段 %r 形状应为 (rows,%d)，实际 %s" % (ctx, name, dim, arr.shape))
    return arr.astype(DTYPE[name], copy=False)


def decode_frame(fr, ctx):
    """一帧 JSON → 内部表示（严格校验，越界/非法一律抛错）。"""
    _need(fr, "t", ctx)
    _need(fr, "N", ctx)
    _need(fr, "obs", ctx)
    _need(fr, "act", ctx)
    N = _as_int(fr["N"], ctx + ".N")
    if N < 1:
        raise BufferSchemaError("%s.N=%d 非法（动作候选数必须 >= 1）" % (ctx, N))
    if N > 1000:
        raise BufferSchemaError("%s.N=%d 超上限 1000（出处：AGENTS.md:1153-1162 主人裁定②；"
                                "网络 `N_NODE=1000`，`net_v2_fixed.py:8`）" % (ctx, N))
    obs = fr["obs"]
    if not isinstance(obs, dict):
        raise BufferSchemaError("%s.obs: 期望 dict，实际 %s" % (ctx, type(obs).__name__))
    segs = {}
    mem_absent = False
    for name in SEG_ORDER:
        if name == "mem" and name not in obs:
            # ⭐ `mem` 可省：服务端恒喂零（`policy_server_graph.py:18-23`）⟹ 采集器不发的段一律补零，
            #    并【显式计数】`mem_absent_frames`（⛔ 不静默：在 metrics/stats 里能看到）。
            segs["mem"] = np.zeros((CAP["mem"], SEG_DIM["mem"]), dtype=DTYPE["mem"])
            mem_absent = True
            continue
        _need(obs, name, ctx + ".obs")
        arr = decode_seg(obs[name], name, ctx + ".obs")
        cap = CAP[name]
        if cap is not None and arr.shape[0] != cap:
            raise BufferSchemaError(
                "%s.obs.%s: 行数必须 = %d（与服务端 `mk()` 的固定容量一致：`policy_server_graph.py:18-23`），"
                "实际 %d —— 采集器请补零到固定容量" % (ctx, name, cap, arr.shape[0]))
        segs[name] = arr
    nrows = segs["node"].shape[0]
    if nrows != N:
        raise BufferSchemaError(
            "%s: `N`=%d 与 node 段行数 %d 不一致 ⟹ 必须【只发真实 N 行】，"
            "⛔ 不许发档位填充（这是 `P0-0` 越界缺陷的另一面）" % (ctx, N, nrows))

    act = fr["act"]
    _need(act, "nodeId", ctx + ".act")
    node_id = _as_int(act["nodeId"], ctx + ".act.nodeId")
    if not (0 <= node_id < N):
        raise BufferSchemaError(
            "%s: act.nodeId=%d 越界（真实 N=%d）⟹ 脏数据（`P0-0`：推理侧候选集=档位大小）。"
            "出处：`今晚持续训练方案-2026-10-17.md:105-147`。⛔ 训练器拒绝吃这种帧"
            % (ctx, node_id, N))
    fire = _as_int(act.get("fire", 0), ctx + ".act.fire")
    if fire not in (0, 1):
        raise BufferSchemaError("%s.act.fire=%r 非法（应为 0/1）" % (ctx, fire))
    picks = act.get("picks", [])
    if not isinstance(picks, list):
        raise BufferSchemaError("%s.act.picks: 期望 list，实际 %s" % (ctx, type(picks).__name__))
    if picks and isinstance(picks[0], dict) and "nodeId" in picks[0]:
        p0 = _as_int(picks[0]["nodeId"], ctx + ".act.picks[0].nodeId")
        if p0 != node_id:
            raise BufferSchemaError("%s: `act.nodeId`=%d 与 `picks[0].nodeId`=%d 不一致"
                                    "（契约 `C2`：`picks[0]`=路线目标）" % (ctx, node_id, p0))

    r = fr["r"]
    if not isinstance(r, dict):
        raise BufferSchemaError("%s.r: 期望 dict，实际 %s" % (ctx, type(r).__name__))
    rw = {}
    for k in REWARD_KEYS:
        _need(r, k, ctx + ".r")
        rw[k] = _as_float(r[k], ctx + ".r." + k)
    if not isinstance(fr["done"], bool):
        raise BufferSchemaError("%s.done: 期望 bool，实际 %r" % (ctx, fr["done"]))

    return {
        "t": _as_int(fr["t"], ctx + ".t"),
        "N": N,
        "node": segs["node"], "opp": segs["opp"], "bullet": segs["bullet"],
        "item": segs["item"], "global": segs["global"], "mem": segs["mem"],
        "act": {"nodeId": node_id, "fire": fire, "picks": picks},
        "lp": _as_float(fr["lp"], ctx + ".lp"),
        "v": _as_float(fr["v"], ctx + ".v"),
        # ⭐ 可选字段：**截断局**（局末帧仍 done=False）的 bootstrap 值 = 该帧之后"下一帧"的服务端 v。
        #    完整局（done=True）不需要；缺了且真出现截断局 ⟹ 训练器【显式抛错】（`--bootstrap zero` 才当 0）。
        "v_next": (None if fr.get("v_next") is None else _as_float(fr["v_next"], ctx + ".v_next")),
        "r": rw,
        "done": bool(fr["done"]),
        "_mem_absent": bool(mem_absent),
    }


def _check_scene(scene, ctx):
    if not isinstance(scene, dict):
        raise BufferSchemaError("%s: 期望 dict，实际 %s" % (ctx, type(scene).__name__))
    for k in SCENE_KEYS:
        _need(scene, k, ctx)
    p = _as_int(scene["players"], ctx + ".players")
    if not (2 <= p <= 8):
        raise BufferSchemaError("%s.players=%d 非法（今晚范围 2~8，出处：今晚持续训练方案 §二）" % (ctx, p))
    _as_int(scene["mapW"], ctx + ".mapW")
    _as_int(scene["mapH"], ctx + ".mapH")
    if not isinstance(scene["storm"], bool):
        raise BufferSchemaError("%s.storm: 期望 bool，实际 %r" % (ctx, scene["storm"]))
    if not isinstance(scene["crates"], list):
        raise BufferSchemaError("%s.crates: 期望 list，实际 %s" % (ctx, type(scene["crates"]).__name__))
    return {"players": p, "mapW": int(scene["mapW"]), "mapH": int(scene["mapH"]),
            "storm": bool(scene["storm"]), "crates": list(scene["crates"])}


def decode_episode(ep_dict):
    """一局 JSON → 内部表示。逐帧走 `decode_frame`（所有闸门都在这里）。"""
    if not isinstance(ep_dict, dict):
        raise BufferSchemaError("episode: 期望 dict，实际 %s" % type(ep_dict).__name__)
    _need(ep_dict, "ep", "episode")
    _need(ep_dict, "frames", "episode")
    ep = _as_int(ep_dict["ep"], "episode.ep")
    frames_in = ep_dict["frames"]
    if not isinstance(frames_in, list) or not frames_in:
        raise BufferSchemaError("episode.ep=%d: frames 必须是非空 list，实际 %r" % (ep, frames_in))
    scene = None
    for src, tag in ((("scene", ep_dict.get("scene")), "episode.scene"),
                     (("scene", frames_in[0].get("scene")), "episode.frames[0].scene")):
        if src[1] is not None:
            scene = _check_scene(src[1], tag)
            break
    if scene is None:
        raise BufferSchemaError("episode.ep=%d: 缺 `scene`（照格式应放【局级】；帧级也接受）—— "
                                "实际局级键: %s" % (ep, sorted(ep_dict.keys())))

    frames, last_t = [], None
    for i, fr in enumerate(frames_in):
        ctx = "episode.ep=%d.frames[%d]" % (ep, i)
        if not isinstance(fr, dict):
            raise BufferSchemaError("%s: 期望 dict，实际 %s" % (ctx, type(fr).__name__))
        f = decode_frame(fr, ctx)
        if last_t is not None and f["t"] <= last_t:
            raise BufferSchemaError("%s: 局内帧号必须严格递增，实际 %d 紧跟在 %d 之后"
                                    % (ctx, f["t"], last_t))
        last_t = f["t"]
        frames.append(f)
    return {"ep": ep, "scene": scene, "frames": frames,
            "win": ep_dict.get("win", None), "extra": ep_dict.get("extra", None)}


class EpisodeBuffer(object):
    """`RAM` 窗口（路线 `C`）。⛔ 不落全量观测（`D:` 只有 `17 G`）。"""

    def __init__(self):
        self.episodes = []
        self.num_frames = 0
        self.accepted = 0
        self.rejected = 0
        self.node_rows_hist = None

    def append_episode(self, ep_dict):
        ep = decode_episode(ep_dict)
        self.episodes.append(ep)
        self.num_frames += len(ep["frames"])
        self.accepted += 1
        return ep

    def clear(self):
        n = self.num_frames
        self.episodes = []
        self.num_frames = 0
        return n

    def all_frames(self):
        out = []
        for e in self.episodes:
            out.extend(e["frames"])
        return out

    def node_lengths(self):
        return np.array([f["N"] for f in self.all_frames()], dtype=np.int64)

    def stats(self):
        N = self.node_lengths()
        if N.size == 0:
            return {"episodes": 0, "frames": 0}
        wins = [e["win"] for e in self.episodes]
        return {
            "episodes": len(self.episodes), "frames": int(self.num_frames),
            "N_min": int(N.min()), "N_p25": int(np.percentile(N, 25)),
            "N_p50": int(np.percentile(N, 50)), "N_p75": int(np.percentile(N, 75)),
            "N_max": int(N.max()), "ram_MB": round(self.ram_bytes() / 1e6, 1),
            "mem_absent_frames": int(sum(1 for f in self.all_frames() if f.get("_mem_absent"))),
            "win": int(sum(1 for w in wins if w == 1)),
            "loss": int(sum(1 for w in wins if w == 0)),
            "unknown": int(sum(1 for w in wins if w not in (0, 1))),
        }

    def ram_bytes(self):
        b = 0
        for f in self.all_frames():
            for name in SEG_ORDER:
                b += f[name].nbytes
        return b

    # ---------- `P2-2` 小记录：抽样若干帧落盘（可用 `--episodes-json` 回灌复盘）----------
    def dump_sample(self, path, keep_frames=20, seed=0):
        """把 buffer 的头若干帧（按局抽样）写成【采集器输入格式】的 JSONL（每行一局）。

        ⚠️ 抽样帧号是**跳的**（不是连续帧）⟹ 只用于【复盘】与【回灌烟测】，⛔ 不能当训练数据。
        ⭐ 为保证文件能被 `train_ppo_online.py --mode episodes` 直接回灌：
           局末帧若 `done=False`，补 `v_next` = 该局**下一帧**的 `v`（值本来就存在 buffer 里）。
        """
        rng = np.random.RandomState(seed)
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        out_lines = []
        for e in self.episodes:
            n_fr = max(1, int(round(keep_frames * len(e["frames"]) / max(1, self.num_frames))))
            idx = sorted(rng.choice(len(e["frames"]), size=min(n_fr, len(e["frames"])), replace=False))
            out = []
            for i in idx:
                f = dict(e["frames"][i])
                if not f["done"] and i + 1 < len(e["frames"]):
                    f["v_next"] = float(e["frames"][i + 1]["v"])
                out.append(encode_frame(f))
            out_lines.append(json.dumps({"ep": e["ep"], "scene": e["scene"], "win": e["win"],
                                         "frames": out}, ensure_ascii=False))
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(out_lines) + "\n")
        return len(out_lines)


def encode_seg(arr):
    import base64
    return {"b64": base64.b64encode(np.ascontiguousarray(arr).tobytes()).decode("ascii"),
            "dtype": str(arr.dtype), "shape": [int(arr.shape[0]), int(arr.shape[1])]}


def encode_frame(f):
    """内部表示 → JSON（`obs` 走 b64/fp16 快路）。`dump_sample` 用它。

    若该帧原本就没发 `mem`（`_mem_absent`）⟹ 编码时也**省掉** `mem`（忠实还原 + 省 4 KB/帧）。
    """
    obs = {name: encode_seg(f[name]) for name in SEG_ORDER}
    if f.get("_mem_absent"):
        obs.pop("mem", None)
    return {
        "t": f["t"], "N": f["N"], "obs": obs,
        "act": {"nodeId": f["act"]["nodeId"], "fire": f["act"]["fire"], "picks": f["act"]["picks"]},
        "lp": f["lp"], "v": f["v"], "v_next": f.get("v_next"), "r": f["r"], "done": f["done"],
    }


# ---------------------------------------------------------------- 采集器入口（可被 import）
_DEFAULT = EpisodeBuffer()


def append_episode(ep_dict, buffer=None):
    """⭐⭐ 采集器唯一入口：一局结束 ⟹ 把【该局所有帧】作为一个 dict 交进来。

    采集器（`P0-1`/`P0-2`）应当：
        import importlib.util
        spec = importlib.util.spec_from_file_location("vt_buffer", "<repo>/_tools/training/vt_buffer.py")
        vb = importlib.util.module_from_spec(spec); spec.loader.exec_module(vb)
        vb.append_episode(ep_dict)        # 或先 vb.decode_episode(ep_dict) 自检
    """
    buf = _DEFAULT if buffer is None else buffer
    return buf.append_episode(ep_dict)


def default_buffer():
    return _DEFAULT


if __name__ == "__main__":
    # 自检（⛔ 不放任何训练逻辑）：拿一局最小合法帧走一遍 + 反例
    import sys
    rng = np.random.RandomState(0)
    N = 7

    def mkframe(t, node_id, done):
        obs = {"node": rng.randn(N, 10), "opp": rng.randn(1, 15), "bullet": rng.randn(64, 6),
               "item": rng.randn(8, 6), "global": rng.randn(1, 38), "mem": np.zeros((4, 256), np.float32)}
        return {"t": t, "N": N, "obs": obs,
                "act": {"nodeId": node_id, "fire": 0, "picks": [{"nodeId": node_id, "back": 0}]},
                "lp": -1.5, "v": 0.1,
                "r": {"total": 1.0, "result": 0.0, "survive": 1.0, "legal": 0.0}, "done": done}

    ep = {"ep": 1, "scene": {"players": 2, "mapW": 6, "mapH": 4, "storm": False, "crates": [0]},
          "win": 1, "frames": [mkframe(0, 3, False), mkframe(1, 5, True)]}
    buf = EpisodeBuffer()
    f = buf.append_episode(ep)["frames"]
    print("BUFFER_OK frames=%d N=%d node_dtype=%s ram_bytes=%d"
          % (len(f), f[0]["N"], f[0]["node"].dtype, buf.ram_bytes()))
    jep = {"ep": 1, "scene": ep["scene"], "win": 1, "frames": [encode_frame(f) for f in f]}
    bad = json.loads(json.dumps(jep))
    bad["frames"][1]["act"]["nodeId"] = N + 3
    try:
        EpisodeBuffer().append_episode(bad)
        print("NEGATIVE_TEST_FAILED: 越界 nodeId 没被拦住")
        sys.exit(1)
    except BufferSchemaError as e:
        print("NEGATIVE_TEST_OK: 越界被拦：%s" % str(e)[:110])
    print("CTX_TOKENS=%d SEG_DIM=%s" % (CTX_TOKENS, SEG_DIM))
