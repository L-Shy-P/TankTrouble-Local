# -*- coding: utf-8 -*-
"""4-1 network v2: real-scale (<=1000 node tokens) + position encoding ON + mean pooling.
Engineering defaults (overridable by master): node order = ascending unique node id; pooling = mean.
"""
import torch, torch.nn as nn, time
D,L,H,FF = 256,3,8,4
PLAN_K = 8   # ⭐【无出处、待实验】「上帧计划」里装几条射击帧（vantage_observe.encodePlan 的 K）
SEG = {"node":10,"opp":15,"bullet":7,"item":6,"global":38,"mem":256,"plan":3+2*PLAN_K}   # ⭐ plan 段：事实直传承载（leafId/stale/nFire + K×(nodeId,back)）   # ⭐ bullet 6→7：对齐 阶段2-3观测字段表-定稿（BULLET_FIELDS=[x,y,vx,vy,theta,type,lifeLeft]）   # node: 10 = 阶段2-3观测字段表定稿（uid·parentIdx·slot·depth·tRel·L·dx·dy·dRot·hasGrown）
N_NODE,N_OPP,N_BUL,N_ITM,N_GLB,N_MEM = 1000,8,64,8,1,4
N_PLAN = 1   # ⭐ plan 段行数（事实直传）   # ⭐ opp 1→8（2026-10-17 派单①）：编码器 oppTok = 每对手15维×N ⟹ 槽位 8 行；上下文 token 78→85
POS_NORM = "per_sample"   # ⭐ 2026-10-17 裁定②：pos = arange(n)/real（逐样本）。改这里 ⟹ 服务端开机打印会跟着变（⛔ 不静默）

class NetV2(nn.Module):
    def __init__(self):
        super().__init__()
        self.proj = nn.ModuleDict({k:nn.Linear(v,D) for k,v in SEG.items()})
        self.type_emb = nn.ParameterDict({k:nn.Parameter(torch.zeros(1,1,D)) for k in SEG})
        self.trunk = nn.TransformerEncoder(nn.TransformerEncoderLayer(D,H,D*FF,batch_first=True,dropout=0.0,norm_first=True),L)
        # 死代码：保留是为了老 ckpt 兼容与 out[] 位置稳定（删了会 unexpected 抛错 + out[3] 语义变）
        self.head_node = nn.Linear(D,1); self.head_fire = nn.Linear(D,1); self.head_fail = nn.Linear(D,1)   # head_fail = 死代码（上行理由）
        self.node_score = nn.Linear(D,1)          # ⭐ 指针头（照 net_full_v0:16 接回）：逐节点打分
        # ⭐⭐ 记忆头（2026-10-17 主人裁定：直接加上）：只写自己那一份 = K=2 token × d=256
        #    出处：`docs/Vantage躲弹实现/01-设计理论/权威与定案/记忆槽-数据格式设计-2026-10-15.md`（K=2×256、两份=A/B）
        #    参数量：256*512 = 131,072（文档口径，含 bias 为 131,584）
        self.mem_writer = nn.Linear(D, 2*256)
        # ⭐⭐ A 相生长头（2026-10-17）：每个 node token 一个 logit（与 node_score 同形）
        #    ⏔t 改 forward 的 4 个返回值（另开 grow_scores() 方法）
        self.head_grow = nn.Linear(D, 1)
    def forward(self,segs,mask):
        real=(~mask).sum(1).float().clamp(min=1).view(-1,1,1)                  # 每样本真实长度（修①配套）
        toks=[]
        for k in SEG:
            x=segs[k]; n=x.shape[1]
            pos=torch.arange(n,device=x.device).view(1,n,1).float()/real                     # ⭐ 2026-10-17 裁定②：逐样本 real（原 real.max() 破坏批不变性 ⟹ 训练/推理对不上）
            toks.append(self.proj[k](x)+self.type_emb[k]+pos)
        x=torch.cat(toks,1)
        h_all=self.trunk(x,src_key_padding_mask=mask)
        valid=(~mask).float().unsqueeze(-1)                                     # 修①：掩码加权池化
        h=(h_all*valid).sum(1)/valid.sum(1).clamp(min=1)
        sc=self.node_score(h_all).squeeze(-1)                                   # 逐 token 打分
        sc=sc.masked_fill(mask,float('-inf'))                                   # ⭐ 填充位不进 softmax
        logp_all=torch.log_softmax(sc,dim=-1)                                   # ⭐ 动作分布的对数（第 4 个输出）
        return self.head_node(h),self.head_fire(h),self.head_fail(h),logp_all   # 位置固定：out[2]=head_fail（死代码，不能拆）

    def write_mem(self, segs, mask):
        """⭐ 记忆写头：返回 (**自己那一份**) K=2 × 256，不参与本帧 policy/value 路径。
        与 `train_loop_v1.py:13-27` 同式：`no_grad` + `.detach()` ⇒ 记忆头的梯度不会回流到本帧输出。
        """
        with torch.no_grad():
            real=(~mask).sum(1).float().clamp(min=1).view(-1,1,1)
            toks=[]
            for k in SEG:
                x=segs[k]; n=x.shape[1]
                pos=torch.arange(n,device=x.device).view(1,n,1).float()/real
                toks.append(self.proj[k](x)+self.type_emb[k]+pos)
            xx=torch.cat(toks,1)
            h_all=self.trunk(xx,src_key_padding_mask=mask)
            valid=(~mask).float().unsqueeze(-1)
            h=(h_all*valid).sum(1)/valid.sum(1).clamp(min=1)
            return self.mem_writer(h).view(-1,2,256).detach()

    def grow_scores(self, segs, mask):
        """⭐ A 相：返回**逐 token** 的生长 logits（形状 (B,T)）。
        与 `forward` 同一套编码器（同 pos/同池化口径），但**不改 forward 的 4 个返回**。
        """
        real=(~mask).sum(1).float().clamp(min=1).view(-1,1,1)
        toks=[]
        for k in SEG:
            x=segs[k]; n=x.shape[1]
            pos=torch.arange(n,device=x.device).view(1,n,1).float()/real
            toks.append(self.proj[k](x)+self.type_emb[k]+pos)
        xx=torch.cat(toks,1)
        h_all=self.trunk(xx,src_key_padding_mask=mask)
        return self.head_grow(h_all).squeeze(-1)      # (B,T)

def NetV2Small(d=128, layers=4):
    """⭐⭐ D8 双网的 A 网：**同一个类**，但临时把模块级 `D/L` 重绑为 128/4 再实例化。
      这样 `NetV2.__init__` 里所有 `nn.Linear(D,..)`/`type_emb`/`trunk` 都自动变成 128 维、四层，而单网路径（默认 256/3）**一个字都不变**。
    """
    global D, L
    _D, _L = D, L
    D, L = int(d), int(layers)
    try:
        return NetV2()
    finally:
        D, L = _D, _L


def make(B,dev):
    segs={"node":torch.randn(B,N_NODE,SEG["node"],device=dev),"opp":torch.randn(B,N_OPP,SEG["opp"],device=dev),
          "bullet":torch.randn(B,N_BUL,SEG["bullet"],device=dev),"item":torch.randn(B,N_ITM,SEG["item"],device=dev),
          "global":torch.randn(B,1,SEG["global"],device=dev),"mem":torch.randn(B,N_MEM,SEG["mem"],device=dev),
          "plan":torch.randn(B,1,SEG["plan"],device=dev)}
    mask=torch.zeros(B,N_NODE+N_OPP+N_BUL+N_ITM+N_GLB+N_MEM,dtype=torch.bool,device=dev)
    return segs,mask

if __name__=="__main__":
    dev="cuda" if torch.cuda.is_available() else "cpu"
    print("DEV",dev, torch.cuda.get_device_name(0) if dev=="cuda" else "")
    net=NetV2().to(dev); print("PARAMS %.2fM"%(sum(p.numel() for p in net.parameters())/1e6))
    torch.cuda.reset_peak_memory_stats() if dev=="cuda" else None
    net.eval(); t=time.time()
    with torch.no_grad(): o=make(1,dev); net(*o)
    print("FWD_B1 shapes",[tuple(x.shape) for x in net(*o)], "ms %.0f"%((time.time()-t)*1000),
          "peakGB %.2f"%(torch.cuda.max_memory_allocated()/1e9) if dev=="cuda" else "")
    opt=torch.optim.Adam(net.parameters(),1e-3); ok=[]
    for B in (1,2,4,8,16,32):
        try:
            if dev=="cuda": torch.cuda.reset_peak_memory_stats()
            s,m=make(B,dev); net.train(); out=net(s,m); loss=sum(x.mean() for x in out)
            loss.backward(); opt.step(); opt.zero_grad()
            pk=torch.cuda.max_memory_allocated()/1e9 if dev=="cuda" else 0
            ok.append((B,round(pk,2))); print("TRAIN_OK batch=%d peakGB=%.2f"%(B,pk))
        except RuntimeError as e:
            print("TRAIN_OOM batch=%d %s"%(B,str(e)[:80])); break
    print("RESULT max_batch=%d peakGB=%.2f"%(ok[-1][0],ok[-1][1]) if ok else "RESULT none")
