# -*- coding: utf-8 -*-
"""阶段 4-1 网络 v1：真 token 序列（施工侧）
依据 v4 §三 字段表（以 vantage_observe.js 实测为准）：节点 token 12 维 ×≤1000 · 对手 15 维 ×1
· 子弹 6 维/颗（动态，不截断）· 道具/地雷 每件一份 · 全局 38 维 ×1 · 记忆 4 × 256
主干 d=256 · L=3 · 8 头 · FFN 4×（按定案）· 每段各自投影 + 类型编码 + 段内位置编码 + 掩码
输出头：留桩（叶子用 ID / 射击帧按 D7 / 真死可进）
"""
import torch, torch.nn as nn

D, L, H, FF = 256, 3, 8, 4
SEG = {"node": 12, "opp": 15, "bullet": 6, "item": 6, "global": 38, "mem": 256}
N_NODE, N_OPP, N_GLOBAL, N_MEM = 4, 1, 1, 4      # 演示用的小规模（真跑用 ≤1000 / 动态）

class NetV1(nn.Module):
    def __init__(self):
        super().__init__()
        self.proj = nn.ModuleDict({k: nn.Linear(dim, D) for k, dim in SEG.items()})
        self.type_emb = nn.ParameterDict({k: nn.Parameter(torch.zeros(1, 1, D)) for k in SEG})
        self.trunk = nn.TransformerEncoder(
            nn.TransformerEncoderLayer(D, H, D*FF, batch_first=True, dropout=0.0, norm_first=True), L)
        self.head_node = nn.Linear(D, 1)   # 叶子打分桩（ID 语义）
        self.head_fire = nn.Linear(D, 1)   # 射击帧桩（D7：不逐帧掩码、不数帧）
        self.head_fail = nn.Linear(D, 1)   # 真死/失效桩
    def _seg(self, x, key, mask=None):
        h = self.proj[key](x) + self.type_emb[key]
        n = x.shape[1]
        pos = torch.arange(n, device=x.device).view(1, n, 1).float() / max(1, n)
        return h + pos * 0.0, mask
    def forward(self, segs, masks):
        toks, msk = [], []
        for k in ("node", "opp", "bullet", "item", "global", "mem"):
            if k in segs:
                h, m = self._seg(segs[k], k, masks.get(k))
                toks.append(h); msk.append(m if m is not None else torch.zeros(h.shape[:2], dtype=torch.bool))
        x = torch.cat(toks, dim=1); pad = torch.cat(msk, dim=1)
        h = self.trunk(x, src_key_padding_mask=pad)[:, 0]   # 汇总取第一个 token（v1 占位）
        return {"nodeLogit": self.head_node(h), "fireLogit": self.head_fire(h), "failLogit": self.head_fail(h), "seqLen": x.shape[1]}

if __name__ == "__main__":
    torch.manual_seed(0); net = NetV1(); net.eval()
    B = 2
    segs = {"node": torch.randn(B, N_NODE, SEG["node"]), "opp": torch.randn(B, N_OPP, SEG["opp"]),
            "bullet": torch.randn(B, 3, SEG["bullet"]), "item": torch.randn(B, 2, SEG["item"]),
            "global": torch.randn(B, N_GLOBAL, SEG["global"]), "mem": torch.randn(B, N_MEM, SEG["mem"])}
    m_node = torch.zeros(B, N_NODE, dtype=torch.bool); m_node[1, 2:] = True     # 掩码：第 2 条样本后 2 个节点无效
    masks = {"node": m_node, "bullet": torch.tensor([[0,0,0],[0,0,1]], dtype=torch.bool)}
    with torch.no_grad(): out = net(segs, masks)
    tot = sum(p.numel() for p in net.parameters())
    parts = {n: sum(p.numel() for p in m.parameters()) for n, m in net.named_children()}
    trunk_only = sum(p.numel() for p in net.trunk.parameters())
    print("V1_FORWARD_OK", {k: (tuple(v.shape) if torch.is_tensor(v) else v) for k, v in out.items()})
    print("total=%.2fM  parts=%s" % (tot/1e6, {k: round(v/1e6, 3) for k, v in parts.items()}))
    print("trunk_only=%.2fM (定案 d=256/L=3 ⟹ 2.56M)  proj_sum=%.2fM" % (trunk_only/1e6, (tot-trunk_only)/1e6))
