# -*- coding: utf-8 -*-
"""阶段 4-1 网络骨架 v0（施工侧）· 前向跑通为目标
依据：阶段4-0训练环境方案-2026-10-13.md（4-1 两个独立网络 + Transformer 骨架）
      v4 §三 字段表（观测 10,540 维/帧 + 记忆 1,024 维）
主干：d=256 · L=3 · 8 头 · FFN 4×（按定案）
输出头：**留桩**（叶子用 ID；射击帧按 D7；甲每次只选 1 帧）
工程默认（可被主人推翻）：C2 不给"长度"字段（10-07 已废弃"时长/段长"语义）；C5 按节点唯一编号升序
"""
import torch, torch.nn as nn

OBS_DIM   = 10540   # v4 §三 实测（vantage_observe.js 为准）
MEM_DIM   = 1024    # 记忆段：2 份 × K=2 × 256
D_MODEL   = 256
N_LAYER   = 3
N_HEAD    = 8
FFN_MULT  = 4
N_NODE_SLOT = 1000  # maxNodes（主人原话"先改成1000个吧"）；节点 token 12 维

class NetSkeleton(nn.Module):
    def __init__(self, d=D_MODEL, L=N_LAYER, H=N_HEAD):
        super().__init__()
        self.obs_proj = nn.Linear(OBS_DIM, d)          # 观测 → token（简化：先整段投一个 token）
        self.mem_proj = nn.Linear(MEM_DIM, d)          # 记忆段（2 份 × K=2 × 256 ⟹ 4 个 token，v0 先投成 1 个）
        self.cls      = nn.Parameter(torch.zeros(1, 1, d))   # 汇总 token（v0 占位）
        enc = nn.TransformerEncoderLayer(d_model=d, nhead=H, dim_feedforward=d*FFN_MULT,
                                         batch_first=True, dropout=0.0, norm_first=True)
        self.trunk = nn.TransformerEncoder(enc, num_layers=L)
        # —— 输出头（**留桩**）——
        self.node_score = nn.Linear(d, 1)              # 甲/乙：给每个叶子打分（叶子用 ID ⟹ 拿 nodeId 去查）
        self.fire_frame = nn.Linear(d, 1)              # B：射击帧桩（D7：别逐帧掩码、别让它数帧）
        self.fail_head  = nn.Linear(d, 1)              # 真死叶子可进（C 系列）：失效/失败桩
    def forward(self, obs, mem):
        b = obs.shape[0]
        x = torch.stack([self.obs_proj(obs), self.mem_proj(mem)], dim=1)  # (B,2,d)
        x = torch.cat([self.cls.expand(b, -1, -1), x], dim=1)            # (B,3,d)
        h = self.trunk(x)[:, 0]                                          # 取汇总 token
        return {"nodeLogit": self.node_score(h),        # (B,1)：叶子选择桩（ID 语义）
                "fireLogit": self.fire_frame(h),        # (B,1)：射击帧桩
                "failLogit": self.fail_head(h)}         # (B,1)：真死/失效桩

if __name__ == "__main__":
    torch.manual_seed(0)
    net = NetSkeleton()
    n_par = sum(p.numel() for p in net.parameters())
    obs = torch.randn(2, OBS_DIM); mem = torch.randn(2, MEM_DIM)
    with torch.no_grad():
        out = net(obs, mem)
    print("FORWARD_OK", {k: tuple(v.shape) for k, v in out.items()},
          "params=%.2fM" % (n_par/1e6), "obs=%d mem=%d d=%d L=%d H=%d" % (OBS_DIM, MEM_DIM, D_MODEL, N_LAYER, N_HEAD))
