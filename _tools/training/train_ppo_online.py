# -*- coding: utf-8 -*-
"""train_ppo_online.py —— 近线 PPO 训练器（Vantage 阶段3「躲弹」，`G4`/`P0-3`）

════════════════════════════════════════════════════════════════════════════
⚠️⚠️ 本文件里所有【超参默认值】都是【无出处、待定】的工程默认值
     （量级来源 = `tools/nn/stage1p_ppo.py:122,139-141,193-199` 与
      `docs/.../今晚训练循环-G4盘点与设计-2026-10-17.md` §2.3 表；
      ⛔ `stage1p_ppo.py` 是 `AGENTS.md:363` 点名的**陷阱文件**，只能"抄式子"、不能当基线）。
     父代理 `2026-10-17` 派单给的数值：`gamma=0.99 · gae_lambda=0.95 · clip=0.2 · lr=3e-4 ·
     epochs=4 · entropy=0.01 · value_coef=0.5 · max_grad_norm=0.5` ——
     全量写进 `ckpt['cfg']` + 每行 `metrics.jsonl`，见 `CFG_CITE`。
════════════════════════════════════════════════════════════════════════════

【口径（父代理 `2026-10-17` 拍定）】
  1. 动作 = 在**前 `N` 个 node token** 上选 1 个 ⟹ `vb.CTX_TOKENS`（= `85`：`opp8/bullet64/item8/global1/mem4`）个上下文 token
     **不是候选**。实现 = 取 `out[3][:, :nmax]` 后**再做一次 `log_softmax`**（重归一化），
     这与服务端 `policy_server_graph.py:99-100` 的做法逐字一致（`softmax` 平移不变 ⟹ 等价于只在前 `N` 个原始分数上做 softmax）。
  2. `logp` **必须用当前策略重算**（不是直接用采集时的 `lp`）；同时记 `ratio` 的 `mean/max/min/KL`（"训练有没有生效"的判据）。
  3. 价值头 = `out[0]`（`head_node` 池化标量）—— 父代理 `2026-10-17` 拍定；服务端 `policy_server_graph.py:107` 同取 `out[0]`。
  4. 记忆段（`mem`）：见 `MEM_MODE_NOTE`（**服务端恒喂零** ⟹ 训练侧必须也喂零，否则 `ratio` 失真）。
  5. `mask`：**只有 `[N, nmax)` 的 node 行置 `True`**（=填充/无效），其余 5 段全 `False`（有效）——
     与服务端 `mk()` 的容量与语义对齐（`policy_server_graph.py:18-23`）。

【输入 / 输出】
  输入：近线 buffer（路线 `C`，父代理裁定）—— 接口在 `_tools/training/vt_buffer.py`（`append_episode`）
  输出：`<out>/ckpt/last.pt`（原子写）+ `<out>/metrics/metrics.jsonl` + `<out>/buffer_samples/cycle_*.jsonl`（抽样小记录）
        `<out>/crash.log`（未捕获异常逐字落盘）

【三种入口】
  A) 采集器喂（默认）：`py -3.13 _tools/training/train_ppo_online.py --mode stdin --min-episodes 20`
     · `stdin`：每行 = 一局 JSON（格式见 `vt_buffer` 头注释）
     · `stdout`：每行 = 一个事件 JSON（`{"ev":...}`）⟹ ⛔ 人类日志一律走 `stderr`（`1e`：别污染协议）
  B) 离线重放：`... --mode episodes --episodes-json D:/vt_run/buffer_samples/cycle_00001.jsonl`
  C) 烟测：`... --mode smoke`（假数据也走真代码路径：`append_episode` → 校验 → 前向/反向 → 存 `ckpt` → 读回 → 再更新一次）
"""
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import time
import traceback

import numpy as np
import torch
import torch.nn.functional as F

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.join(ROOT, "_tools", "training")
sys.path.insert(0, HERE)
import vt_buffer as vb  # noqa: E402  （同目录，采集器接口）

NET_PATH = os.path.join(HERE, "net_v2_fixed.py")
SERVER_PATH = os.path.join(HERE, "policy_server_graph.py")
CKPT_FORMAT = "vantage-ppo-v1"

# ⭐⭐ 超参默认值（【无出处、待定】）+ 出处标注
CFG_CITE = {
    "gamma": "【无出处、待定】父代理派单 2026-10-17；量级同 tools/nn/stage1p_ppo.py:122",
    "gae_lambda": "【无出处、待定】父代理派单 2026-10-17；量级同 tools/nn/stage1p_ppo.py:122",
    "clip": "【无出处、待定】父代理派单 2026-10-17；量级同 stage1p_ppo.py:193（0.8/1.2 ⟹ ±0.2）",
    "lr": "【无出处、待定】父代理派单 2026-10-17；量级同 stage1p_ppo.py:141",
    "epochs": "【无出处、待定】父代理派单 2026-10-17；量级同 stage1p_ppo.py:139(--epochs 4)",
    "entropy_coef": "【无出处、待定】父代理派单 2026-10-17；量级同 stage1p_ppo.py:196",
    "value_coef": "【无出处、待定】父代理派单 2026-10-17；量级同 stage1p_ppo.py:193(0.5)",
    "max_grad_norm": "【无出处、待定】父代理派单 2026-10-17；量级同 stage1p_ppo.py:199",
    "minibatch": "有出处：AGENTS.md:1357-1373 实测『本机甜点 32~64、≥128 掉崖 49×』（同构 d=256/L=3）",
    "min_episodes": "【无出处、待定】G4 文档 §2.3 建议 20~60【估计值】",
    "value_head": "有出处：父代理 2026-10-17 裁定 out[0]（head_node 池化标量）；服务端 policy_server_graph.py:107 同",
    "mem_mode": "zeros | net；net = 局内按帧序重算记忆（与服务端 phase=B 同序），见《记忆槽-数据格式设计-2026-10-15》",
    "reward_mode": "有出处（方向）：今晚持续训练方案-2026-10-17.md §三 三分项；权重数值【无出处、待定】",
    "w_result": "【无出处、待定】今晚持续训练方案 §三（结果项：胜 +1/负 -1/双死 -0.25/超时 0）",
    "w_survive": "【无出处、待定】今晚持续训练方案 §三（『存活小权重』，具体数未给）",
    "w_legal": "【无出处、待定】今晚持续训练方案 §三（重/中/轻罚，具体数未给）",
    "w_spawn": "【无出处、待主人拍】2026-10-17 父代理裁定（B）初始值 0.02：每真发射一发奖励⇒直接教它松扳机",
    "w_hit": "【无出处、待主人拍】2026-10-17 父代理裁定（B）初始值 0.2；口径=推断（对手 alive 位 1→0），见文档§十一",
    "w_aim": "【无出处、待主人拍】2026-10-17 父代理裁定（B-2）初始值 0.01；口径=刚发射的子弹速度方向与\"我方→最近存活对手\"方位夹角 ≤30°（离散、非势函数），由桥在页面内计算",    "w_aim": "【无出处、待主人拍】2026-10-17 父代理裁定（B-2）初始值 0.01；口径=刚发射的子弹速度方向与\"我方→最近存活对手\"方位夹角 ≤30°（离散、非势函数），由桥在页面内计算",
    "w_kill": "【无出处、待主人拍】2026-10-17 主人 10 条规格：我方子弹击杀对手 +1.0（TANK_KILLED killer/victim）",
    "w_selfkill": "【无出处、待主人拍】自己子弹打自己 -1.5（比死亡更重）",
    "w_death": "【无出处、待主人拍】被他人子弹打死 -1.0",
    "w_death_storm": "【无出处、待主人拍】被毒雾杀死 -1.5；⚠️口径=【推断】TANK_KILLED 且 killer 缺失",
    "w_kill_storm": "【无出处、待主人拍】对手被毒雾杀死 +1.0；⚠️同上推断口径",
    "w_crate": "【无出处、待主人拍】拿到道具 +0.05（可按训练轮次线性衰减，本轮未接衰减）",
    "w_draw": "【无出处、待主人拍】1v1 平局 -0.5",
    "w_empty_fire": "【有出处（主人 2026-10-17 原话）】没子弹仍扣扳机 = 纯错、惩罚量比真实对局更大 ⟹ -0.10（出处线索：决策源接口架构:973）",
    "w_win": "【有出处（主人 2026-10-17 原话）】胜利的奖励绝对需要最大 ⟹ +3.0（所有奖励项里最大）",
    "w_lose": "【无出处、待主人拍】负 -1.0",
    "w_legal_pen": "【无出处、待主人拍】重罚：每次被拒（no-output / 炮口贴墙 / 不在路线上 / 节点编号不存在）-0.05；⛔ 不罚“树自身变化导致引用失效”（那类单独计数）",
    "max_updates": "【无出处、待主人拍】每个 cycle 最多多少个 minibatch 更新（0=不限）",
    "adv_norm": "【无出处、待定】工程默认；量级同 stage1p_ppo.py:135（优势全局标准化）",
    "bootstrap": "截断局末帧的 V(s')：`error`=缺 `v_next` 就抛错（⛔ 不静默当 0）；`zero`=显式当终止并计数",
}

DEFAULTS = dict(gamma=0.99, gae_lambda=0.95, clip=0.2, lr=3e-4, epochs=4,
                entropy_coef=0.01, value_coef=0.5, max_grad_norm=0.5,
                minibatch=32, min_episodes=20,
                value_head="out[0]", mem_mode="zeros", reward_mode="parts",
                w_result=1.0, w_survive=1.0, w_legal=1.0, adv_norm=True,
                w_spawn=0.02, w_hit=0.2, w_aim=0.01, max_updates=0,
                w_kill=1.0, w_selfkill=-1.5, w_death=-1.0, w_death_storm=-1.5, w_kill_storm=1.0,
                w_crate=0.05, w_draw=-0.5, w_empty_fire=-0.10,
                w_win=3.0, w_lose=-1.0, w_legal_pen=0.05,
                fire_ent_coef=0.1,   # ⭐【无出处、待实验】=10×entropy_coef；目的把 head_fire 从饱和（p≈0.94）拉出来   # ⭐（无出处、待实验）单独给 head_fire 的熵权重；-1 = 随 entropy_coef（用于把 fire 头从饱和里拉出）   # ⭐ 奖惩 v2（主人 10 条）：权重全部【无出处、待主人拍】   # ⭐ 2026-10-17 父代理裁定 (B)+(A)2：真发射/命中奖励 + 小窗口更新上限（0=不限）
                bootstrap="error")

MEM_MODE_NOTE = (
    "服务端 `policy_server_graph.py:18-23` 的 `mk()` 把 `mem` 段建成**全零**，且 `:68-71` 只覆盖载荷里出现的段 "
    "⟹ 只要采集器不发 `mem`，**推理侧恒为全零**。`train_loop_v1.py:13-27` 那套『由网络逐帧生成、局首清零、detach』"
    "需要网络多一个 `mem_writer` 头 + 服务端同步生成，**`net_v2_fixed.py` 没有这个头**（`:10-32` 只有 4 个输出）⟹ "
    "⚠️ 若训练侧生成而推理侧喂零，**同一帧的输入分布就变了 ⟹ ratio/advantage 全是错的**。"
    "故今晚 `mem_mode=zeros`（train/infer 一致）；`net` 模式**显式报错不实现**（⛔ 不静默降级）。"
)

ENV_LOCK = {"torch.threads": None}


# ---------------------------------------------------------------- 基础设施
def log(msg):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), msg), file=sys.stderr, flush=True)


def emit(obj):
    """stdout = 事件协议（每行一个 JSON），给采集器/外层重启壳看。"""
    obj = dict(obj)
    obj.setdefault("ts", time.time())
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def md5file(path):
    try:
        with open(path, "rb") as fh:
            return hashlib.md5(fh.read()).hexdigest()
    except OSError:
        return None


def code_fingerprint():
    git = None
    try:
        r = subprocess.run(["git", "-C", ROOT, "rev-parse", "HEAD"],
                           capture_output=True, text=True, timeout=20)
        if r.returncode == 0:
            git = r.stdout.strip()
    except Exception as e:  # ⛔ 不静默：记下来
        git = "ERR:%s" % str(e)[:60]
    return {"git": git, "md5": {
        "train_ppo_online.py": md5file(os.path.abspath(__file__)),
        "vt_buffer.py": md5file(os.path.join(HERE, "vt_buffer.py")),
        "net_v2_fixed.py": md5file(NET_PATH),
        "policy_server_graph.py": md5file(SERVER_PATH),
    }}


def np_rng_pack():
    """`np.random.get_state()` 的字段顺序是 (name, keys[], pos, has_gauss, cached_gaussian) ——
    ⚠️ 早先按 (name,pos,...) 写错过一次（真跑才炸），此处逐字对齐。"""
    s = np.random.get_state()
    return {"keys": str(s[0]), "arr": np.asarray(s[1]).tolist(), "pos": int(s[2]),
            "has_gauss": int(s[3]), "cached_gaussian": float(s[4])}


def np_rng_unpack(p):
    np.random.set_state((p["keys"], np.array(p["arr"], dtype=np.uint32),
                         int(p["pos"]), int(p["has_gauss"]), float(p["cached_gaussian"])))


def disk_free_gb(path):
    try:
        return round(shutil.disk_usage(path).free / 1e9, 2)
    except Exception:
        return None


def prune_dir(d, keep_files=30, max_bytes=250 * 1e6):
    """`P2-2`：抽样小记录滚动上限（`D:` 只有 17G）。"""
    try:
        items = sorted((os.path.join(d, f) for f in os.listdir(d) if f.endswith(".jsonl")),
                       key=os.path.getmtime, reverse=True)
    except OSError:
        return
    total = 0
    for i, p in enumerate(items):
        total += os.path.getsize(p)
        if i >= keep_files or total > max_bytes:
            try:
                os.remove(p)
                log("prune 删除抽样记录 %s" % os.path.basename(p))
            except OSError:
                pass
    # 顺带清掉可能残留的半截文件
    for f in os.listdir(d):
        if f.endswith(".tmp"):
            try:
                os.remove(os.path.join(d, f))
            except OSError:
                pass


def append_jsonl(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(obj, ensure_ascii=False) + "\n")


def crash_log(out_dir, argv):
    tb = traceback.format_exc()
    path = os.path.join(out_dir, "crash.log")
    os.makedirs(out_dir, exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write("\n===== %s  argv=%s\n%s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), argv, tb))
    log("!! 未捕获异常，逐字落盘到 %s（尾部 1200 字）：\n%s" % (path, tb[-1200:]))
    return path


# ---------------------------------------------------------------- 网络
def load_net_module():
    spec = importlib.util.spec_from_file_location("nv2", NET_PATH)
    m = importlib.util.module_from_spec(spec)
    with contextlib.redirect_stdout(io.StringIO()):
        spec.loader.exec_module(m)
    return m


def build_net_split(device):
    # D8: A 网 d=128,L=4（不继承、全随机）；B 网 d=256,L=3（继承单份 ckpt）
    nv2 = load_net_module()
    net_b = nv2.NetV2().to(device)
    net_a = nv2.NetV2Small(d=128, layers=4).to(device)
    return net_a, net_b, nv2


def build_net(device):
    nv2 = load_net_module()
    if dict(nv2.SEG) != dict(vb.SEG_DIM):
        raise AssertionError("段维度不一致：net=%s buffer=%s（⛔ 不静默：先用 `阶段2-3观测字段表-定稿` 对齐）"
                             % (nv2.SEG, vb.SEG_DIM))
    got = (nv2.N_OPP, nv2.N_BUL, nv2.N_ITM, nv2.N_GLB, nv2.N_MEM)
    want = (vb.CAP["opp"], vb.CAP["bullet"], vb.CAP["item"], vb.CAP["global"], vb.CAP["mem"])
    if got != want:
        raise AssertionError("段容量不一致：net=%s buffer=%s" % (got, want))
    if vb.CTX_TOKENS != vb.CAP["opp"] + vb.CAP["bullet"] + vb.CAP["item"] + vb.CAP["global"] + vb.CAP["mem"] + vb.CAP["plan"]:   # ⭐ +plan
        raise AssertionError("%d 个上下文 token 的求和自检失败" % vb.CTX_TOKENS)
    net = nv2.NetV2().to(device)
    return net, nv2


# ---------------------------------------------------------------- 批构造（一个逻辑一个入口）
def build_batch(frames, idx, device):
    """把若干帧拼成一个 minibatch。

    统一约定（与 `net_v2_fixed.forward` 及服务端 `mk()` 对齐）：
      · node 段裁到**本批真实最大 N**（`nmax`），行 `[N, nmax)` 的 mask 置 True
      · 其余 5 段一律**固定容量**（8/64/8/1/4）且 mask=False（服务端也是这么喂的）
      · mask 长度 = nmax + `vb.CTX_TOKENS`（= `85`）
    """
    B = len(idx)
    nmax = max(frames[i]["N"] for i in idx)
    node = torch.zeros(B, nmax, vb.SEG_DIM["node"], device=device)
    mask = torch.zeros(B, nmax + vb.CTX_TOKENS, dtype=torch.bool, device=device)
    act = torch.zeros(B, dtype=torch.int64, device=device)
    grow_ok = torch.zeros(B, nmax, device=device)          # ⭐ A 相：可生长掩码（叶）
    grow_row = torch.zeros(B, dtype=torch.int64, device=device)
    lp_grow_old = torch.zeros(B, device=device)
    grow_missing = 0
    plan_t = torch.zeros(B, vb.CAP["plan"], vb.SEG_DIM["plan"], device=device)   # ⭐ 事实直传（plan 段）
    plan_missing = 0
    fire_bit = torch.zeros(B, device=device)
    fire_valid = torch.zeros(B, device=device)
    lp_fire_old = torch.zeros(B, device=device)
    fire_missing = 0
    lp_old = torch.zeros(B, device=device)
    v_old = torch.zeros(B, device=device)
    rew = torch.zeros(B, device=device)
    Ns = []
    for j, i in enumerate(idx):
        f = frames[i]
        n = f["N"]
        node[j, :n] = torch.from_numpy(f["node"].astype(np.float32))
        if n < nmax:
            mask[j, n:nmax] = True
        act[j] = f["act"]["nodeId"]
        # ⭐ 叶规则（与桥 `grow_ok` 同一口径）：行 i 是叶 ⇔ 没有任何行 parentIdx == i（排除根行 0）
        nd = f["node"]
        isPar = np.zeros(n, dtype=np.int64)
        for _i in range(1, n):
            _pp = int(nd[_i][1])
            if 0 < _pp < n: isPar[_pp] = 1
        for _i in range(1, n):
            if isPar[_i] == 0: grow_ok[j, _i] = 1.0
        _pl = f.get("plan")
        if isinstance(_pl, list) and len(_pl) == vb.SEG_DIM["plan"]:
            plan_t[j, 0] = torch.tensor([float(x) for x in _pl], device=device)
        else:
            plan_missing += 1
        _fb = (f["act"] or {}).get("fire")
        if isinstance(_fb, (int, float)) and not isinstance(_fb, bool):
            fire_bit[j] = 1.0 if int(_fb) == 1 else 0.0; fire_valid[j] = 1.0
        else:
            fire_missing += 1
        _lpf = (f["act"] or {}).get("lp_fire")
        if isinstance(_lpf, (int, float)):
            lp_fire_old[j] = float(_lpf)
        g = (f["act"] or {}).get("grow")
        if isinstance(g, dict) and "lp_grow" in g:
            uid = int(g["nodeId"])
            row = -1
            for _i in range(n):
                if int(nd[_i][0]) == uid: row = _i; break
            if row >= 0: grow_row[j] = row; lp_grow_old[j] = float(g["lp_grow"])
            else: grow_missing += 1
        else:
            grow_missing += 1
        lp_old[j] = f["lp"]
        v_old[j] = f["v"]
        rew[j] = f["_rew"]
        Ns.append(n)
    segs = {"node": node,
            "opp": torch.from_numpy(np.stack([frames[i]["opp"] for i in idx])).to(device),
            "bullet": torch.from_numpy(np.stack([frames[i]["bullet"] for i in idx])).to(device),
            "item": torch.from_numpy(np.stack([frames[i]["item"] for i in idx])).to(device),
            "global": torch.from_numpy(np.stack([frames[i]["global"] for i in idx])).to(device),
            "mem": torch.from_numpy(np.stack([frames[i].get("_mem", frames[i]["mem"]) for i in idx])).to(device)}   # ⭐ mem_mode=net 时用局内重算的记忆
    segs["plan"] = plan_t
    return {"segs": segs, "mask": mask, "act": act, "lp_old": lp_old, "v_old": v_old, "plan_missing": plan_missing,
            "grow_ok": grow_ok, "grow_row": grow_row, "lp_grow_old": lp_grow_old, "grow_missing": grow_missing,
            "fire_bit": fire_bit, "fire_valid": fire_valid, "lp_fire_old": lp_fire_old, "fire_missing": fire_missing,
            "rew": rew, "Ns": Ns, "nmax": nmax}


def node_dist(out3, nmax):
    """⭐⭐ 动作分布：只在前 `nmax`（本批 node 行）上重归一化 —— 与 `policy_server_graph.py:99-100` 同一口径。

    返回 (logp_nodes (B,nmax), ent (B,))
    """
    sliced = out3[:, 1:nmax]   # ⭐ D11：候选范围 [1,nmax)，与服务端同批对齐
    lp = torch.log_softmax(sliced, dim=-1)
    p = lp.exp()
    ent = -(p * torch.where(p > 0, lp, torch.zeros_like(lp))).sum(-1)
    return lp, ent, p


def precompute_mem(buffer, net, device):
    """⭐⭐ mem_mode=net：局内按帧序重算记忆（no_grad）。
    口径与服务端完全一致（phase=B）：本帧喂 `mem = cat(zeros(2,256), B_prev)`；帧后 `B_now = write_mem(...)`
    ⏔t 乱序（记忆是序列依赖的）。
    """
    CTX = vb.CTX_TOKENS
    zeroA = np.zeros((2, 256), np.float32)
    n_done = 0
    for e in buffer.episodes:
        mem = np.zeros((4, 256), np.float32)   # ⭐ 每局清零 M_0 = 0
        for f in e["frames"]:
            f["_mem"] = mem
            N = int(f["N"])
            # ⭐ 与服务端同样的档位 padding（让核形状一致 ⇒ 数值差更小）
            _t = 64
            for _tt in (64, 256, 512, 1008):
                _t = _tt
                if N <= _tt: break
            segs = {}
            node = np.zeros((_t, 10), np.float32); node[:N] = np.asarray(f["node"], np.float32)
            segs["node"] = torch.tensor(node, device=device).unsqueeze(0)
            for k in ("opp", "bullet", "item", "global"):
                segs[k] = torch.tensor(np.asarray(f[k], np.float32), device=device).unsqueeze(0)
            segs["mem"] = torch.tensor(mem, device=device).unsqueeze(0)
            mask = torch.zeros(1, _t + CTX, dtype=torch.bool, device=device)
            mask[0, N:_t] = True   # ⭐ 与服务端 mk()/forward 同一掩码语义
            w = net.write_mem(segs, mask)
            mem = np.concatenate([zeroA, w[0].detach().cpu().numpy().astype(np.float32)], 0)
            n_done += 1
    return n_done

def grow_forward(net, b):
    """⭐⭐ A 相：用 `head_grow` 在【可生长掩码】上重归一化，返回 (lp_at_action, ent)。
    口径 = 服务端 A 相：`log_softmax(where(grow_ok>0, logits, -inf))`
    """
    gs = net.grow_scores(b["segs"], b["mask"])[:, :b["nmax"]].float()
    _ok = b["grow_ok"] > 0
    _has = _ok.any(-1)
    # ⭐ 没候选的样本：不能全 -inf（会 NaN）⇒ 用未掩码分布占位，它们在 loss 里会被排除
    gm = torch.where(_ok, gs, torch.full_like(gs, float("-inf")))
    if not bool(_has.all()):
        gm = torch.where(_has.view(-1, 1), gm, gs)
    lp = torch.log_softmax(gm, dim=-1)
    p = lp.exp()
    ent = -(p * torch.where(p > 0, lp, torch.zeros_like(lp))).sum(-1)
    picked = lp.gather(1, b["grow_row"].view(-1, 1)).squeeze(1)
    return picked, ent


def forward_batch(net, b):
    out = net(b["segs"], b["mask"])
    if len(out) != 4:
        raise AssertionError("期望 4 个输出（含动作分布头 out[3]），实际 %d" % len(out))
    if out[3].shape[1] != b["nmax"] + vb.CTX_TOKENS:
        raise AssertionError("out[3] 长度 %d != nmax(%d)+CTX(%d) —— 口径漂了" % (out[3].shape[1], b["nmax"], vb.CTX_TOKENS))
    lp_nodes, ent, p = node_dist(out[3], b["nmax"])
    lp = lp_nodes.gather(1, (b["act"] - 1).clamp(min=0).view(-1, 1)).squeeze(1)   # ⭐ act 是行号，但候选从行 1 开始 ⇒ 下标 -1
    v = out[0].view(-1)          # ⭐ out[0] = 价值头（父代理 2026-10-17 裁定）
    _fire_logit = out[1].view(-1).float()   # ⭐ head_fire 的 logit（第 5 个返回值，前 4 个不变）
    return lp, v, ent, p, _fire_logit


# ---------------------------------------------------------------- GAE / 更新
def compute_gae_episode(rew, val, done, gamma, lam, v_next_last=None, ctx=""):
    """⭐ 参考实现：`tools/nn/stage1p_ppo.py:122-131`（⚠️ 参考、⛔ 不当基线）—— 逐局截断。

    ⭐ 末帧的 `V(s_{t+1})`（bootstrap）语义【显式】定义：
      · `done=True`（局真的结束）        ⟹ `next_v = 0`
      · `done=False` + 有 `v_next`      ⟹ `next_v = v_next`（采集器给的"下一帧价值"）
      · `done=False` + 无 `v_next`      ⟹ 由调用方决定（默认**抛错**，`--bootstrap zero` 才显式当 0）
    """
    T = len(rew)
    adv = np.zeros(T, dtype=np.float32)
    last = 0.0
    for t in range(T - 1, -1, -1):
        if t == T - 1:
            if done[t]:
                nv, nonterm = 0.0, 0.0
            elif v_next_last is not None:
                nv, nonterm = float(v_next_last), 1.0
            else:
                raise AssertionError("%s: 最后一帧 done=False 且没有 v_next ⟹ 截断局的 bootstrap 未定义" % ctx)
        else:
            nv = 0.0 if done[t] else float(val[t + 1])
            nonterm = 0.0 if done[t] else 1.0
        delta = float(rew[t]) + gamma * nv - float(val[t])
        last = delta + gamma * lam * last * nonterm
        adv[t] = last
    return adv, adv + val.astype(np.float32)


def reward_of(f, cfg):
    # ⭐ 2026-10-17 子代理：奖励合成【唯一入口】已抽到 `_tools/training/rewards.py`
    #    （主人 10 条奖惩全部落地 + 零 double-count；`legal` 双权重 / `hit`+`kill` 双计 /
    #     `result`+`win|lose|draw` 双计都在那个文件里修掉，并由 `rewards_selftest.py` 逐位验算）
    #    ⛔ 本函数体内不再保留任何权重乘法（否则就又是一处"同一字段两个权重"）。
    import os as _os
    import sys as _sys
    _d = _os.path.dirname(_os.path.abspath(__file__))
    if _d not in _sys.path:
        _sys.path.insert(0, _d)
    import rewards as _rewards
    return _rewards.reward_of(f, cfg)



def prepare_targets(buffer, cfg):
    """帧级 reward / GAE / return（按局截断）。"""
    frames = buffer.all_frames()
    for f in frames:
        f["_rew"] = reward_of(f, cfg)
    adv_l, ret_l = [], []
    tails = {"done": 0, "v_next_used": 0, "zeroed": 0, "truncated": 0}
    for e in buffer.episodes:
        fr = e["frames"]
        rew = np.array([f["_rew"] for f in fr], dtype=np.float32)
        val = np.array([f["v"] for f in fr], dtype=np.float32)
        done = np.array([bool(f["done"]) for f in fr], dtype=bool)
        v_next_last = None
        if done[-1]:
            tails["done"] += 1
        else:
            tails["truncated"] += 1
            vn = fr[-1].get("v_next")
            if vn is not None:
                v_next_last = float(vn)
                tails["v_next_used"] += 1
            elif cfg["bootstrap"] == "zero":
                v_next_last = 0.0            # 显式当终止：nv=0（与 done=True 等价）
                tails["zeroed"] += 1
            else:
                raise AssertionError(
                    "局 ep=%s 的最后一帧 done=False（截断局），且帧里没有 `v_next` ⟹ bootstrap 未定义。"
                    "⛔ 拒绝静默当 0（会污染 advantage）。两条路：①采集器在该帧补 `v_next`（= 下一帧服务端返回的 v）；"
                    "②显式 `--bootstrap zero`（当终止处理，会在 metrics 里记 zeroed 计数）。"
                    "帧键：%s" % (e["ep"], sorted(fr[-1].keys())))
        a, r = compute_gae_episode(rew, val, done, cfg["gamma"], cfg["gae_lambda"],
                                   v_next_last=v_next_last, ctx="ep=%s" % e["ep"])
        adv_l.append(a)
        ret_l.append(r)
    adv = np.concatenate(adv_l)
    ret = np.concatenate(ret_l)
    adv_std_raw = float(adv.std())
    if cfg["adv_norm"]:
        adv = (adv - adv.mean()) / (adv.std() + 1e-8)
    return frames, adv.astype(np.float32), ret.astype(np.float32), adv_std_raw, tails


def ppo_update(buffer, net, opt, cfg, device, step, net_a=None, opt_a=None):   # ⭐ net_a/opt_a 非 None ⇒ D8 双网
    frames, adv, ret, adv_std_raw, tails = prepare_targets(buffer, cfg)
    T = len(frames)
    Ns = np.array([f["N"] for f in frames], dtype=np.int64)
    rew = np.array([f["_rew"] for f in frames], dtype=np.float32)
    lp_old_np = np.array([f["lp"] for f in frames], dtype=np.float32)
    n = T
    k = int(cfg["minibatch"])
    m = {}
    t0 = time.time()
    sse = 0.0
    s_ret = 0.0
    s_ret2 = 0.0
    n_ev = 0
    _maxupd = int(cfg.get("max_updates", 0) or 0)   # ⭐ (A)2 小窗口：每次 ppo_update 最多更新几个 minibatch（0=不限）
    _nupd = 0
    for ep_i in range(int(cfg["epochs"])):
        _ok = np.array([i for i in range(n) if int(frames[i]["N"]) >= 2], dtype=np.int64)   # ⭐ N<2：候选只有 1 个 ⇒ ent≡0、无梯度 ⇒ 不进 batch
        order = _ok[np.random.permutation(len(_ok))] if len(_ok) else np.array([], dtype=np.int64)
        if _maxupd > 0:
            pass   # ⭐ 小窗口：不按 N 排序（否则只训最短的 8 帧）
        else:
            order = order[np.argsort(Ns[order], kind="stable")]        # 按长度装桶（净减少 pos 编码的批间偏差）
        for s0 in range(0, n, k):
            idx = order[s0:s0 + k]
            b = build_batch(frames, idx, device)
            lp, v, ent, p, fire_logit = forward_batch(net, b)
            ratio = torch.exp(lp - b["lp_old"])
            A = torch.as_tensor(adv[idx], device=device)
            ret_t = torch.as_tensor(ret[idx], device=device)
            pg = -torch.min(ratio * A,
                            torch.clamp(ratio, 1.0 - cfg["clip"], 1.0 + cfg["clip"]) * A).mean()
            vloss = F.mse_loss(v, ret_t)
            ent_m = ent.mean()
            # ⭐⭐ A 相梯度：pg_grow = -(logp_grow(a_t) × A_t)；ent_grow = 可生长分布的熵
            lp_grow, ent_grow_b = grow_forward(net_a if net_a is not None else net, b)   # ⭐ 双网 ⇒ A 网
            _gv = ((b["grow_ok"] > 0).any(-1) & (b["grow_row"] > 0)).float()   # ⭐ 只对「有候选且有动作」的样本算梯度
            _gn = _gv.sum().clamp(min=1.0)
            _term = torch.where(_gv > 0, lp_grow * A, torch.zeros_like(lp_grow))   # ⭐ 先置零再求和（避免 -inf×0 ⇒ NaN）
            pg_grow = -_term.sum() / _gn
            ent_grow = torch.where(_gv > 0, ent_grow_b, torch.zeros_like(ent_grow_b)).sum() / _gn
            # ⭐⭐ head_fire 梯度：逐帧 Bernoulli 的 logp × A_t
            _fec = cfg["entropy_coef"] if float(cfg.get("fire_ent_coef", -1.0)) < 0 else float(cfg["fire_ent_coef"])
            _pf = torch.sigmoid(fire_logit).clamp(1e-6, 1 - 1e-6)
            _bit = b["fire_bit"].float()
            lp_fire_new = torch.where(_bit > 0.5, torch.log(_pf), torch.log(1.0 - _pf))
            _fv = b["fire_valid"].float()
            _fn = _fv.sum().clamp(min=1.0)
            pg_fire = -(torch.where(_fv > 0, lp_fire_new * A, torch.zeros_like(lp_fire_new)).sum()) / _fn
            ent_fire = torch.where(_fv > 0, -(_pf * torch.log(_pf) + (1 - _pf) * torch.log(1 - _pf)), torch.zeros_like(_pf)).sum() / _fn
            loss = pg + pg_grow + pg_fire + cfg["value_coef"] * vloss - cfg["entropy_coef"] * (ent_m + ent_grow) - _fec * ent_fire
            opt.zero_grad(set_to_none=True)
            loss.backward()
            gn = torch.nn.utils.clip_grad_norm_(net.parameters(), cfg["max_grad_norm"])
            if not torch.isfinite(loss).all() or not torch.isfinite(gn).all():
                # 品质闸门：非有限 ⟹ 显式抛错（`--on-nan skip` 可改成跳过）
                if cfg.get("_on_nan", "abort") == "abort":
                    raise FloatingPointError(
                        "非有限 loss/grad：loss=%r grad_norm=%r epoch=%d idx0=%d N=%d"
                        % (loss.item(), float(gn), ep_i, int(idx[0]), int(Ns[idx[0]])))
                m["nan_skipped"] = m.get("nan_skipped", 0) + 1
                opt.zero_grad(set_to_none=True)
                continue
            opt.step()
            if net_a is not None: opt_a.step()   # ⭐ D8 双网：A 网自己 step
            _nupd += 1   # ⭐ 计数（供 max_updates 截断）
            with torch.no_grad():
                sse += float(((v - ret_t) ** 2).sum())
                s_ret += float(ret_t.sum())
                s_ret2 += float((ret_t ** 2).sum())
                n_ev += int(ret_t.numel())
            kl = float((b["lp_old"] - lp).detach().mean())
            rec = {"pg": float(pg.detach()), "v": float(vloss.detach()), "ent": float(ent_m.detach()),
                   "ratio_mean": float(ratio.mean().detach()), "ratio_max": float(ratio.max().detach()),
                   "ratio_min": float(ratio.min().detach()),
                   "clip_frac": float(((ratio - 1.0).abs() > cfg["clip"]).float().mean().detach()),
                   "kl": kl, "gn": float(gn), "v_mean": float(v.mean().detach()), "bs": len(idx),
                   "pg_grow": float(pg_grow.detach()), "ent_grow": float(ent_grow.detach()),
                   "pg_fire": float(pg_fire.detach()), "ent_fire": float(ent_fire.detach())}
            for kk, vv in rec.items():
                m.setdefault(kk, []).append(vv)
            # 动作分布口径自证：前 N 个 node token 的概率和 == 1
            psum = p.sum(-1)
            m.setdefault("prob_sum_max_dev", []).append(float((psum - 1.0).abs().max()))
            if _maxupd > 0 and _nupd >= _maxupd: break   # ⭐ (A)2 小窗口：到上限就停
        if _maxupd > 0 and _nupd >= _maxupd: break
    out = {}
    for kk in ("pg", "v", "ent", "ratio_mean", "clip_frac", "kl", "gn", "v_mean", "bs", "pg_grow", "ent_grow", "pg_fire", "ent_fire"):
        if kk in m:
            out["grad_norm" if kk == "gn" else kk] = float(np.mean(m[kk]))
    if "ratio_max" in m:
        out["ratio_max"] = float(np.max(m["ratio_max"]))
    if "ratio_min" in m:
        out["ratio_min"] = float(np.min(m["ratio_min"]))
    out["prob_sum_max_dev"] = float(max(m.get("prob_sum_max_dev", [0.0])))
    out["dropped_n1_frames"] = int(n - len(_ok))   # ⭐ 被跳过的 N<2 帧数（显式计数）
    out["updates"] = int(_nupd)   # ⭐ 本次实际更新次数（供小窗口可见）
    out["nan_skipped"] = int(m.get("nan_skipped", 0))
    if n_ev > 0:
        var_ret = s_ret2 / n_ev - (s_ret / n_ev) ** 2
        out["explained_var"] = float(1.0 - (sse / n_ev) / max(var_ret, 1e-12))
    out.update({"frames": n, "episodes": len(buffer.episodes), "adv_std_raw": adv_std_raw,
                "adv_mean": float(adv.mean()), "bootstrap_tails": tails,
                "reward_mean": float(rew.mean()), "lp_old_unique": int(len(np.unique(lp_old_np))),
                "update_s": round(time.time() - t0, 2), "n_minibatches_total": int(len(m.get("pg", [])))})
    return out


# ---------------------------------------------------------------- ckpt（`P2-1` 断点续训）
def make_opt(net, lr):
    """⭐ 记忆头单独一个 param group（老参数动量照常恢复）。
    理由：`mem_writer` 是后加的新头，它的 Adam 状态在老 ckpt 里不存在 ⇒ 单独一组便于"老参数动量原样恢复、新头从零开始。
    """
    old_p = [p for n, p in net.named_parameters() if not n.startswith("mem_writer")]
    new_p = [p for n, p in net.named_parameters() if n.startswith("mem_writer")]
    groups = [{"params": old_p, "lr": lr, "name": "trunk"}]
    if new_p: groups.append({"params": new_p, "lr": lr, "name": "mem_writer"})
    opt = torch.optim.Adam(groups, lr=lr)
    return opt


def log_opt_groups(opt, logf):
    for i, g in enumerate(opt.param_groups):
        logf("   opt group[%d] name=%-10s params=%d lr=%g" % (i, g.get("name", "?"), len(g["params"]), g["lr"]))


def save_ckpt(path, net, opt, step, episodes, cfg, extra=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    obj = {"format": CKPT_FORMAT,
           "model": net.state_dict(),          # ⛔ 原地 load_state_dict 回填（CUDA Graph 烘焙的是指针）
           "model_a": (extra or {}).get("model_a"),   # ⭐ D8 双网：A 网权重（单网时 None）
           "opt": opt.state_dict(),
           "step": int(step), "episodes": int(episodes),
           "rng": torch.get_rng_state().cpu(), "np_rng": np_rng_pack(),
           "cfg": dict(cfg), "code": code_fingerprint(), "ts": time.time()}
    if extra:
        obj.update(extra)
    tmp = path + ".tmp"
    torch.save(obj, tmp)
    os.replace(tmp, path)                       # ⭐ 先写 .tmp 再 os.replace（防半截文件）
    return os.path.getsize(path)


def save_model_only(path, net, step, cfg):
    """给服务端 `VT_CKPT` 用的纯权重件（另一个子代理在做加载器）。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    torch.save({"format": CKPT_FORMAT + "-model", "model": net.state_dict(),
                "step": int(step), "cfg": dict(cfg), "ts": time.time()}, tmp)
    os.replace(tmp, path)
    return os.path.getsize(path)


def load_ckpt(path, net, opt, device):
    obj = torch.load(path, map_location=device, weights_only=True)
    if obj.get("format") != CKPT_FORMAT:
        raise AssertionError("ckpt 格式不符：%r（期望 %r）—— ⛔ 不许猜着读" % (obj.get("format"), CKPT_FORMAT))
    _r = net.load_state_dict(obj["model"], strict=False)   # ⭐ 记忆头新增 ⇒ strict=False
    log("⭐ ckpt 对齐：missing=%s unexpected=%s（missing 应只有 mem_writer.*）" % (list(_r.missing_keys), list(_r.unexpected_keys)))   # ⏔t 不静默
    if list(_r.unexpected_keys): raise AssertionError("ckpt 多余键 %s ⇒ 不匹配" % list(_r.unexpected_keys))           # ⛔ 不用 assign=True（保持张量指针 ⟹ CUDA Graph 有效）
    if "opt" in obj:
        _old = obj["opt"]; _ng_new = len(opt.param_groups); _ng_old = len(_old.get("param_groups", []))
        try:
            opt.load_state_dict(_old); log("⭐ optimizer 状态已整体恢复（组数 %d）" % _ng_new)
        except Exception as _e:
            log("⭐ optimizer 组数不一致（old=%d new=%d）⇒ 按参数顺序前缀重映射旧动量（⏔t 整体重建）" % (_ng_old, _ng_new))
            _params = [p for g in opt.param_groups for p in g["params"]]
            _ns = {}
            for _k, _v in (_old.get("state") or {}).items():
                _i = int(_k)
                if _i < len(_params): _ns[_params[_i]] = _v
            _pgs = []
            _base = dict(_old["param_groups"][0]) if _old.get("param_groups") else {}
            _base.pop("params", None)
            for g in opt.param_groups:
                _ng = dict(g); _ng.update({k2: v2 for k2, v2 in _base.items() if k2 in ("lr", "betas", "eps", "weight_decay", "amsgrad")})
                _pgs.append(_ng)
            _drop = 0
            for _p, _stt in list(_ns.items()):
                for _key in ("exp_avg", "exp_avg_sq", "max_exp_avg_sq"):
                    _v = _stt.get(_key)
                    if _v is not None and tuple(_v.shape) != tuple(_p.shape):
                        _ns.pop(_p); _drop += 1; break
            if _drop: log("⭐ 丢弃 %d 项形状不匹配的旧动量（新增段导致，如 plan）" % _drop)
            opt.load_state_dict({"state": _ns, "param_groups": _pgs})
            log("⭐ 老参数动量已恢复 %d 项；mem_writer 从零开始" % len(_ns))
    if "rng" in obj:
        torch.set_rng_state(obj["rng"].cpu())
    if "np_rng" in obj:
        np_rng_unpack(obj["np_rng"])
    return obj


# ---------------------------------------------------------------- 配置解析
def add_args(ap):
    ap.add_argument("--mode", choices=["stdin", "episodes", "smoke"], default="stdin")
    ap.add_argument("--out", default="D:/vt_run", help="产出根目录（⛔ 不许写 C:）")
    ap.add_argument("--episodes-json", default=None, help="--mode episodes：每行一局的 JSONL")
    ap.add_argument("--cycles", type=int, default=0, help="最多跑几个 cycle（0=不限，stdin 模式跑完就退）")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--resume", default=None, help="恢复用的 ckpt 路径（给了就【权重+超参】一起读回）")
    ap.add_argument("--no-auto-resume", action="store_true", help="不自动读 <out>/ckpt/last.pt")
    ap.add_argument("--allow-cfg-override", action="store_true", help="允许命令行覆盖 ckpt 里的超参（默认禁止）")
    ap.add_argument("--on-nan", choices=["abort", "skip"], default="abort")
    ap.add_argument("--keep-buffer", action="store_true", help="调试用：cycle 后不清空 buffer")
    ap.add_argument("--sample-frames", type=int, default=20, help="每 cycle 抽样落盘的帧数")
    # 超参（默认 None ⟹ 从 DEFAULTS / ckpt 解析；显式给值才覆盖）
    for k, v in DEFAULTS.items():
        if k == "adv_norm":
            ap.add_argument("--adv-norm", dest="adv_norm", action="store_true", default=None)
            ap.add_argument("--no-adv-norm", dest="adv_norm", action="store_false", default=None)
        elif isinstance(v, bool):
            ap.add_argument("--" + k.replace("_", "-"), dest=k, action="store_true", default=None)
        else:
            ap.add_argument("--" + k.replace("_", "-"), dest=k, type=type(v), default=None)
    return ap


def resolve_cfg(args, ckpt_cfg):
    cfg = dict(DEFAULTS)
    source = "defaults【无出处、待定】"
    if ckpt_cfg:
        unknown = [k for k in ckpt_cfg if k not in DEFAULTS and not k.startswith("_")]
        for k in DEFAULTS:
            if k in ckpt_cfg:
                cfg[k] = ckpt_cfg[k]
        source = "ckpt(%s)" % ckpt_cfg.get("_path", "?")
        diffs = []
        for k in DEFAULTS:
            cli = getattr(args, k)
            if cli is not None and cli != cfg[k]:
                diffs.append("%s: ckpt=%r cli=%r" % (k, cfg[k], cli))
        if diffs and not args.allow_cfg_override:
            raise SystemExit(
                "⛔ 拒绝用命令行默认值『接着跑』：以下超参与 ckpt 不一致（要改请显式加 --allow-cfg-override）：\n  "
                + "\n  ".join(diffs))
        if diffs:
            log("⚠️ --allow-cfg-override：用命令行覆盖 ckpt 超参：%s" % "; ".join(diffs))
        if unknown:
            log("⚠️ ckpt 里有本训练器不认识的配置键（已忽略但记下）：%s" % unknown)
    for k in DEFAULTS:
        cli = getattr(args, k)
        if cli is not None:
            cfg[k] = cli
    cfg["_source"] = source
    cfg["_on_nan"] = args.on_nan
    return cfg


# ---------------------------------------------------------------- 一个 cycle
def run_cycle(state, buffer, cfg, args, net, opt, device):
    t0 = time.time()
    st = buffer.stats()
    emit({"ev": "cycle_start", "cycle": state["cycle"] + 1, "buffer": st})
    log("cycle %d 开始：局 %d / 帧 %d（N p50=%s max=%s, RAM %.1f MB）"
        % (state["cycle"] + 1, st["episodes"], st["frames"], st.get("N_p50"), st.get("N_max"),
           st.get("ram_MB", 0)))
    if cfg.get("mem_mode") == "net":
        _n = precompute_mem(buffer, net, device)   # ⭐ mem_mode=net：局内按帧序重算记忆
        log("⭐ 记忆已按帧序重算：%d 帧（每局 M_0=0）" % _n)
    _net_a = state.get("net_a"); _opt_a = state.get("opt_a")
    def _sig(m):
        import hashlib as _h
        _w = m.proj["node"].weight.detach().cpu().numpy()
        return (float(_w.__abs__().sum()), _h.md5(_w.tobytes()).hexdigest()[:8])
    _before = (_sig(net), _sig(_net_a)) if _net_a is not None else None
    res = ppo_update(buffer, net, opt, cfg, device, state["step"], net_a=_net_a, opt_a=_opt_a)
    if _net_a is not None:
        _after = (_sig(net), _sig(_net_a))
        log("⭐ 两网权重（proj.node）前 B=%s A=%s → 后 B=%s A=%s" % (_before[0], _before[1], _after[0], _after[1]))
    state["step"] += 1
    state["cycle"] += 1
    state["trained_frames"] += res["frames"]
    state["trained_episodes"] += res["episodes"]
    res["samples_per_s"] = round(res["frames"] / max(res["update_s"], 1e-9), 1)

    ckpt = os.path.join(args.out, "ckpt", "last.pt")
    size = save_ckpt(ckpt, net, opt, state["step"], state["episodes"], cfg, extra=({"model_a": state["net_a"].state_dict()} if state.get("net_a") is not None else None))
    msize = save_model_only(os.path.join(args.out, "ckpt", "model_latest.pt"), net, state["step"], cfg)

    line = {"kind": "cycle", "ts": time.time(), "cycle": state["cycle"], "step": state["step"],
            "episodes": state["episodes"], "frames_total": state["frames"],
            "frames_collected_total": state["frames"],
            "frames_trained_total": state["trained_frames"],
            "episodes_trained_total": state["trained_episodes"],
            "buffer": st, "train": res, "cfg": dict(cfg), "code": code_fingerprint(),
            "ckpt_bytes": size, "ckpt_model_bytes": msize,
            "disk_free_gb": {"C:": disk_free_gb("C:/"), "D:": disk_free_gb("D:/")},
            "wall_s": round(time.time() - t0, 2)}
    append_jsonl(os.path.join(args.out, "metrics", "metrics.jsonl"), line)
    log("cycle %d 完成：loss_pg=%.4f loss_v=%.4f ent=%.3f kl=%.4f ratio[%.3f,%.3f] clip=%.3f "
        "ev=%s gn=%.2f %.1f 帧/s（%.1fs）"
        % (state["cycle"], res["pg"], res["v"], res["ent"], res["kl"], res["ratio_min"],
           res["ratio_max"], res["clip_frac"], res.get("explained_var"), res["grad_norm"],
           res["samples_per_s"], res["update_s"]))
    emit({"ev": "cycle_done", "cycle": state["cycle"], "step": state["step"],
          "metrics": {k: res[k] for k in ("pg", "v", "ent", "kl", "ratio_mean", "ratio_max",
                                          "clip_frac", "grad_norm", "explained_var",
                                          "samples_per_s", "frames")},
          "ckpt": ckpt, "model_latest": os.path.join(args.out, "ckpt", "model_latest.pt")})

    # `P2-2`：抽样小记录（可 `--mode episodes` 回灌复盘）+ 滚动清理
    sd = os.path.join(args.out, "buffer_samples")
    sp = os.path.join(sd, "cycle_%05d.jsonl" % state["cycle"])
    n_ep = buffer.dump_sample(sp, keep_frames=args.sample_frames, seed=state["cycle"])
    pruned = prune_dir(sd)
    log("抽样落盘 %s（%d 局，%d B）；prune=%s" % (os.path.basename(sp), n_ep, os.path.getsize(sp), pruned))
    if not args.keep_buffer:
        dropped = buffer.clear()
        log("buffer 已清空（路线 C：RAM 只留一个窗口），丢弃 %d 帧" % dropped)
    return res


def stdin_loop(args, cfg, state, buffer, net, opt, device):
    log("等待 stdin 每行一局 JSON（采集器 → 训练器）；stdout 输出事件 JSON")
    n_ep_seen = 0
    while True:
        line = sys.stdin.readline()
        if not line:
            log("stdin EOF：采集端结束")
            break
        line = line.strip()
        if not line:
            continue
        try:
            ep = json.loads(line)
        except Exception as e:
            emit({"ev": "error", "where": "json", "err": str(e)[:200]})
            log("!! 这一行不是合法 JSON（已跳过并计数）：%s" % str(e)[:200])
            buffer.rejected += 1
            continue
        try:
            dec = buffer.append_episode(ep)
        except vb.BufferSchemaError as e:
            buffer.rejected += 1
            emit({"ev": "episode_rejected", "ep": ep.get("ep"), "err": str(e)[:300]})
            log("!! 局面被拒（⛔ 不带坏数据跑）：%s" % str(e)[:400])
            continue
        n_ep_seen += 1
        state["episodes"] += 1
        state["frames"] += len(dec["frames"])
        emit({"ev": "episode_accepted", "ep": dec["ep"], "frames": len(dec["frames"]),
              "buf_episodes": len(buffer.episodes), "total_frames": state["frames"],
              "rejected": buffer.rejected})
        if len(buffer.episodes) >= int(cfg["min_episodes"]):
            run_cycle(state, buffer, cfg, args, net, opt, device)
            if args.cycles and state["cycle"] >= args.cycles:
                log("到达 --cycles=%d，退出" % args.cycles)
                break
    if buffer.episodes:
        log("EOF 后还剩 %d 局未更新 ⟹ 跑最后一个【不满窗】cycle（不丢数据）" % len(buffer.episodes))
        if not (args.cycles and state["cycle"] >= args.cycles):
            run_cycle(state, buffer, cfg, args, net, opt, device)
    return n_ep_seen


# ---------------------------------------------------------------- 烟测（假数据走真代码路径）
def make_fake_episode(ep, rng, players=2, n_frames=30, n_lo=40, n_hi=300, win=None, storm=False):
    """构造一局【合法】的假 buffer 数据。⚠️ 只造假观测/奖励，其余（校验/前向/更新/存盘）全走真代码。"""
    import base64 as _b64  # noqa: F401   （保留：说明该文件可用 b64 快路）
    frames = []
    for t in range(n_frames):
        N = int(rng.randint(n_lo, n_hi + 1))
        node_id = int(rng.randint(0, N))
        obs = {
            "node": rng.randn(N, vb.SEG_DIM["node"]).astype(np.float32),
            "opp": rng.randn(vb.CAP["opp"], 15).astype(np.float32),
            "bullet": rng.randn(64, 7).astype(np.float32),   # ⭐ 6→7 对齐 net_v2_fixed.SEG / 定稿
            "item": rng.randn(8, 6).astype(np.float32),
            "global": rng.randn(1, 38).astype(np.float32),
            "mem": np.zeros((4, 256), np.float32),
        }
        done = (t == n_frames - 1)
        res = float(win) if (done and win is not None) else 0.0
        if ep % 2 == 0:            # ⭐ 偶数局【不发 mem】⟹ 走"mem 缺省补零"那条路（服务端恒喂零）
            obs.pop("mem")
        frames.append({"t": t, "N": N, "obs": obs,
                       "act": {"nodeId": node_id, "fire": int(rng.randint(0, 2)),
                               "picks": [{"nodeId": node_id, "back": 0}]},
                       "lp": float(-np.log(N) + 0.3 * rng.normal()),
                       "v": float(0.3 * rng.normal()),
                       "r": {"total": 1.0 + res, "result": res,
                             "survive": 1.0 if not done else 0.0, "legal": 0.0},
                       "done": done})
    return {"ep": ep, "scene": {"players": players, "mapW": 8, "mapH": 6,
                                "storm": bool(storm), "crates": [0, 1, 2]},
            "win": win, "frames": frames}


def smoke(args, cfg, state, net, opt, device):
    """⭐⭐ 烟测：造假 buffer（2~3 局）→ 真代码路径跑 2 个 cycle → 存 ckpt → 读回 → 再更新一次。"""
    rng = np.random.RandomState(args.seed + 1)
    buffer = vb.EpisodeBuffer()
    args.keep_buffer = True          # 烟测要在同一批数据上看"更新前后"的变化
    cfg = dict(cfg)
    cfg["min_episodes"] = 3
    cfg["epochs"] = int(cfg["epochs"]) if int(cfg["epochs"]) <= 2 else 2
    cfg["minibatch"] = min(int(cfg["minibatch"]), 8)
    cfg["_on_nan"] = "abort"
    log("SMOKE 配置：epochs=%d minibatch=%d min_episodes=%d（其余照 cfg）"
        % (cfg["epochs"], cfg["minibatch"], cfg["min_episodes"]))

    for ep in (1, 2, 3):
        buffer.append_episode(make_fake_episode(ep, rng, players=2, n_frames=22,
                                                n_lo=40, n_hi=300, win=1 if ep != 2 else 0))
        state["episodes"] += 1
        state["frames"] += 22
    st = buffer.stats()
    log("SMOKE 假 buffer：%d 局 / %d 帧 / N p50=%s max=%s / RAM %.1f MB / node dtype=fp16"
        % (st["episodes"], st["frames"], st["N_p50"], st["N_max"], st["ram_MB"]))
    emit({"ev": "smoke_buffer", "stats": st})

    p0 = {k: v.detach().clone() for k, v in net.state_dict().items()}
    r1 = run_cycle(state, buffer, cfg, args, net, opt, device)
    l2_first = r1["kl"]
    for ep in (4, 5, 6):
        buffer.append_episode(make_fake_episode(ep, rng, players=4, n_frames=18,
                                                n_lo=120, n_hi=220, win=1 if ep != 5 else 0, storm=True))
        state["episodes"] += 1
        state["frames"] += 18
    r2 = run_cycle(state, buffer, cfg, args, net, opt, device)
    delta = max(float((net.state_dict()[k] - v).abs().max()) for k, v in p0.items())
    log("SMOKE 两个 cycle 跑完：step=%d cycle=%d 权重的最大改动=%.3e（>0 ⟹ 训练真的在动）"
        % (state["step"], state["cycle"], delta))
    if not (delta > 0):
        raise AssertionError("权重没变 ⟹ 训练没生效")

    # ---- ckpt 读回（`P2-1`）----
    ckpt = os.path.join(args.out, "ckpt", "last.pt")
    if os.path.exists(ckpt + ".tmp"):
        raise AssertionError("ckpt 目录残留 .tmp ⟹ 原子写有问题")
    net2, _ = build_net(device)
    opt2 = make_opt(net2, cfg["lr"])
    obj = load_ckpt(ckpt, net2, opt2, device)
    same = all(torch.equal(net2.state_dict()[k].cpu(), net.state_dict()[k].cpu())
               for k in net.state_dict())
    cfg_back = obj["cfg"]
    log("SMOKE ckpt 读回：step=%d episodes=%d 权重逐张量相等=%s cfg 键=%d 个 md5=%s"
        % (obj["step"], obj["episodes"], same, len(cfg_back),
           md5file(ckpt)[:10]))
    if not same:
        raise AssertionError("读回的权重与存盘前不一致")
    if int(obj["step"]) != int(state["step"]):
        raise AssertionError("读回 step=%s != 内存 step=%s" % (obj["step"], state["step"]))
    for k in DEFAULTS:
        if cfg_back.get(k) != cfg[k]:
            raise AssertionError("读回的 cfg[%s]=%r != %r" % (k, cfg_back.get(k), cfg[k]))

    # ---- 读回后再更新一次（续训判据）----
    torch.manual_seed(999)
    r3 = ppo_update(buffer, net2, opt2, cfg, device, state["step"])
    log("SMOKE 续训：读回权重上再跑一次更新 ⟹ loss_pg=%.4f kl=%.4f ratio_max=%.3f lp_finite=1.000"
        % (r3["pg"], r3["kl"], r3["ratio_max"]))
    save_ckpt(ckpt, net2, opt2, state["step"] + 1, state["episodes"], cfg)
    obj2 = torch.load(ckpt, map_location="cpu", weights_only=True)
    log("SMOKE 再存一次：step=%d（应 = %d）" % (obj2["step"], state["step"] + 1))
    if int(obj2["step"]) != state["step"] + 1:
        raise AssertionError("第二次存盘的 step 不对")

    # ---- 负例：越界动作必须被拦（`P0-0` 体检闸门）----
    bad = make_fake_episode(99, rng, n_frames=2, n_lo=5, n_hi=5)
    bad["frames"][1]["act"]["nodeId"] = 5
    try:
        vb.EpisodeBuffer().append_episode(bad)
        raise AssertionError("越界 nodeId 没被拦住（`P0-0` 体检闸门失效）")
    except vb.BufferSchemaError as e:
        log("SMOKE 负例 OK：越界动作被拦：%s" % str(e)[:120])

    # ---- 截断局（局末帧 done=False）的 bootstrap 契约：默认【抛错】，给了 v_next 才放行 ----
    tb = vb.EpisodeBuffer()
    cut = make_fake_episode(77, rng, n_frames=4, n_lo=5, n_hi=5)
    cut["frames"][-1]["done"] = False
    tb.append_episode(cut)
    try:
        prepare_targets(tb, cfg)
        raise AssertionError("截断局缺 v_next 却没报错")
    except AssertionError as e:
        if "bootstrap 未定义" not in str(e):
            raise
        log("SMOKE 截断局 OK①：缺 v_next ⟹ 显式抛错（⛔ 不静默当 0）")
    tb.episodes[0]["frames"][-1]["v_next"] = 0.25
    _a, _r, _s, _sd, _t = prepare_targets(tb, cfg)
    log("SMOKE 截断局 OK②：给了 v_next=0.25 ⟹ 放行，tails=%s" % _t)
    cfg_zero = dict(cfg)
    cfg_zero["bootstrap"] = "zero"
    tb.episodes[0]["frames"][-1]["v_next"] = None     # 把 v_next 拿掉，才轮到 `zero` 兜底
    _a, _r, _s, _sd, _t0 = prepare_targets(tb, cfg_zero)
    log("SMOKE 截断局 OK③：无 v_next + `--bootstrap zero` ⟹ 显式当终止，tails=%s" % _t0)
    if _t0["zeroed"] != 1:
        raise AssertionError("--bootstrap zero 的计数不对：%s" % _t0)

    # ---- 口径自证 ----
    log("SMOKE 口径自证：动作只在前 N 个 node token 上（重归一化后概率和最大偏差=%.2e，"
        "out[3] 长度 = nmax+CTX(%d)）；mem=%s；value=head out[0]；mask 只标 [N,nmax) 的 node 行"
        % (r2.get("prob_sum_max_dev", float("nan")), vb.CTX_TOKENS, cfg["mem_mode"]))
    print("SMOKE_OK step=%d cycles=%d frames_trained=%d kl_first=%.4f delta_max=%.3e ckpt=%s"
          % (state["step"], state["cycle"], state["trained_frames"], l2_first, delta, ckpt))
    return 0


# ---------------------------------------------------------------- 主入口
def main(argv=None):
    ap = argparse.ArgumentParser(description="近线 PPO 训练器（Vantage 阶段3）")
    add_args(ap)
    args = ap.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)

    try:
        if args.device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        else:
            device = args.device
        log("设备 DEVICE=%s%s（合法但不同的默认值必须打印，遵 `子代理通用背景.md` 铁律二）"
            % (device, " " + torch.cuda.get_device_name(0) if device == "cuda" else ""))
        log("torch=%s numpy=%s cudnn=%s tf32(matmul)=%s threads=%s"
            % (torch.__version__, np.__version__, torch.backends.cudnn.version(),
               torch.backends.cuda.matmul.allow_tf32, torch.get_num_threads()))
        torch.manual_seed(args.seed)
        np.random.seed(args.seed)

        # ---- 网络 ----
        net, nv2 = build_net(device)
        nparam = sum(p.numel() for p in net.parameters())
        opt = make_opt(net, DEFAULTS["lr"])
        log_opt_groups(opt, log)   # ⭐ 打印各 param group 参数量（验证 mem_writer 单独一组）
        log("网络 net_v2_fixed.NetV2 参数=%d（%.4f M）段=%s 容量(opp,bul,itm,glb,mem)=(%d,%d,%d,%d,%d) node<=%d"
            % (nparam, nparam / 1e6, nv2.SEG, nv2.N_OPP, nv2.N_BUL, nv2.N_ITM, nv2.N_GLB, nv2.N_MEM, nv2.N_NODE))

        # ---- 续训 ----
        resume_path = args.resume
        if resume_path is None and not args.no_auto_resume and args.mode != "smoke":
            cand = os.path.join(args.out, "ckpt", "last.pt")
            resume_path = cand if os.path.exists(cand) else None
        elif resume_path is None and args.mode == "smoke":
            log("SMOKE：默认【不自动续训】（烟测要可复现）；要试续训请显式 `--resume <ckpt>`")
        ckpt_cfg = None
        if resume_path:
            if not os.path.exists(resume_path):
                raise SystemExit("--resume 指向的 ckpt 不存在：%s" % resume_path)
            obj = load_ckpt(resume_path, net, opt, device)
            ckpt_cfg = dict(obj["cfg"])
            ckpt_cfg["_path"] = resume_path
        cfg = resolve_cfg(args, ckpt_cfg)
        if ckpt_cfg:
            opt = make_opt(net, cfg["lr"])
            load_ckpt(resume_path, net, opt, device)   # 二次加载：opt 用【读回的超参 lr】重建
        log("超参分辨率 cfg[_source]=%s" % cfg["_source"])
        for k in DEFAULTS:
            log("   %-14s = %-8r   %s" % (k, cfg[k], CFG_CITE.get(k, "")))

        state = {"step": int(obj["step"]) if ckpt_cfg else 0,
                 "episodes": int(obj["episodes"]) if ckpt_cfg else 0,
                 "cycle": 0, "frames": 0, "trained_frames": 0, "trained_episodes": 0}
        # ⭐⭐ D8 双网（VT_NET_SPLIT=1）：A 网 d=128,L=4 随机起步；B 网继承单份 ckpt
        if os.environ.get("VT_NET_SPLIT", os.environ.get("VT_NET_SPLIT", "0")) == "1" or bool(cfg.get("_net_split")):
            net_a, _nb2, _nv2b = build_net_split(device)
            _pa = sum(p.numel() for p in net_a.parameters())
            log("⭐ D8 双网：A 网(d=128,L=4) 参数=%d（%.3fM）、B 网(d=256,L=3) 参数=%d" % (_pa, _pa / 1e6, nparam))
            _ca = None
            if resume_path:
                try:
                    _o = torch.load(resume_path, map_location=device, weights_only=True)
                    _ca = _o.get("model_a")
                except Exception as _e:
                    _ca = None
            if _ca is not None:
                _ra = net_a.load_state_dict(_ca, strict=False)
                log("⭐ CKPT_A_LOADED missing=%s unexpected=%s" % (list(_ra.missing_keys), list(_ra.unexpected_keys)))
            else:
                log("⭐ CKPT_A_RANDOM（A 网不继承、全随机）")
            _opt_a = make_opt(net_a, cfg["lr"])
            state["net_a"] = net_a; state["opt_a"] = _opt_a
        if ckpt_cfg:
            log("▶ 从 ckpt 续训：step=%d episodes=%d（超参随 ckpt 读回，⛔ 不靠命令行默认值）"
                % (state["step"], state["episodes"]))

        log("口径：动作=前 N 个 node token（重归一化，同服务端 :99-100）；%d 个上下文 token 不是候选" % vb.CTX_TOKENS)
        log("      v=%s；mem_mode=%s；mask=只标 [N,nmax) 的 node 行；minibatch=%d；pos 编码按批内 max 归一"
            % (cfg["value_head"], cfg["mem_mode"], cfg["minibatch"]))
        log("      mask/mem 的理由：%s" % MEM_MODE_NOTE)

        if args.mode == "smoke":
            return smoke(args, cfg, state, net, opt, device)

        if args.mode == "episodes":
            if not args.episodes_json:
                raise SystemExit("--mode episodes 需要 --episodes-json")
            buffer = vb.EpisodeBuffer()
            n = 0
            with open(args.episodes_json, encoding="utf-8") as fh:
                for ln, line in enumerate(fh, 1):
                    line = line.strip()
                    if not line:
                        continue
                    dec = buffer.append_episode(json.loads(line))
                    state["episodes"] += 1
                    state["frames"] += len(dec["frames"])
                    n += 1
                    if len(buffer.episodes) >= int(cfg["min_episodes"]):
                        run_cycle(state, buffer, cfg, args, net, opt, device)
            if buffer.episodes and not (args.cycles and state["cycle"] >= args.cycles):
                run_cycle(state, buffer, cfg, args, net, opt, device)
            log("离线重放完成：读了 %d 局，跑了 %d 个 cycle" % (n, state["cycle"]))
            return 0

        buffer = vb.EpisodeBuffer()
        stdin_loop(args, cfg, state, buffer, net, opt, device)
        save_ckpt(os.path.join(args.out, "ckpt", "last.pt"), net, opt, state["step"],
                  state["episodes"], cfg)
        log("收工：step=%d cycle=%d episodes=%d frames=%d" % (state["step"], state["cycle"],
                                                             state["episodes"], state["frames"]))
        emit({"ev": "trainer_exit", "step": state["step"], "cycle": state["cycle"],
              "episodes": state["episodes"], "frames": state["frames"]})
        return 0
    except SystemExit:
        raise
    except BaseException:
        crash_log(args.out, " ".join(sys.argv))
        return 3


if __name__ == "__main__":
    sys.exit(main())
