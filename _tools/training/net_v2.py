# -*- coding: utf-8 -*-
"""4-1 network v2: real-scale (<=1000 node tokens) + position encoding ON + mean pooling.
Engineering defaults (overridable by master): node order = ascending unique node id; pooling = mean.
"""
import torch, torch.nn as nn, time
D,L,H,FF = 256,3,8,4
SEG = {"node":12,"opp":15,"bullet":6,"item":6,"global":38,"mem":256}
N_NODE,N_OPP,N_BUL,N_ITM,N_GLB,N_MEM = 1000,1,64,8,1,4

class NetV2(nn.Module):
    def __init__(self):
        super().__init__()
        self.proj = nn.ModuleDict({k:nn.Linear(v,D) for k,v in SEG.items()})
        self.type_emb = nn.ParameterDict({k:nn.Parameter(torch.zeros(1,1,D)) for k in SEG})
        self.trunk = nn.TransformerEncoder(nn.TransformerEncoderLayer(D,H,D*FF,batch_first=True,dropout=0.0,norm_first=True),L)
        self.head_node = nn.Linear(D,1); self.head_fire = nn.Linear(D,1); self.head_fail = nn.Linear(D,1)
    def forward(self,segs,mask):
        toks=[]
        for k in ("node","opp","bullet","item","global","mem"):
            x=segs[k]; n=x.shape[1]
            pos=torch.arange(n,device=x.device).view(1,n,1).float()/max(1,n)   # position encoding ON
            toks.append(self.proj[k](x)+self.type_emb[k]+pos)
        x=torch.cat(toks,1)
        h=self.trunk(x,src_key_padding_mask=mask).mean(dim=1)                  # mean pooling (eng default)
        return self.head_node(h),self.head_fire(h),self.head_fail(h)

def make(B,dev):
    segs={"node":torch.randn(B,N_NODE,SEG["node"],device=dev),"opp":torch.randn(B,1,SEG["opp"],device=dev),
          "bullet":torch.randn(B,N_BUL,SEG["bullet"],device=dev),"item":torch.randn(B,N_ITM,SEG["item"],device=dev),
          "global":torch.randn(B,1,SEG["global"],device=dev),"mem":torch.randn(B,N_MEM,SEG["mem"],device=dev)}
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
