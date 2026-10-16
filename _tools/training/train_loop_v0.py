# -*- coding: utf-8 -*-
"""training loop skeleton v0: PPO + cross-frame memory (memory = INPUT segment, per ruling:
train as a sequence, BPTT truncated to k frames, NO 'replay from t=0 with current weights'; collection format unchanged).
Smoke test: 2 rounds x 20 frames, fake data, 30 update steps -> params must change, loss must not be NaN."""
import torch, torch.nn as nn, importlib.util, contextlib, io
D,KMAX=256,8; K_WIN=5; CLIP=0.2; ENT=0.01; VF=0.5; BATCH=32
spec=importlib.util.spec_from_file_location("fn","_tools/training/net_full_v0.py"); fn=importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(fn)

class ActorCritic(nn.Module):
    def __init__(self):
        super().__init__()
        self.net=fn.FullNet()                      # trunk + 5 heads (grow/route/shots/len/fail as pointers+scalars)
        self.value=nn.Linear(D,1)                  # NEW: critic head
    def forward(self,segs,mask):
        o=self.net(segs,mask)
        return o, self.value(self.net.trunk(torch.cat([self.net.proj[k](segs[k]) for k in segs],1))[:,0])

def fake_round(frames=20,node=64,dev="cuda"):
    """one round = frames of segment inputs + masks + fake 'taken' actions & rewards"""
    r=[]
    for t in range(frames):
        segs={"node":torch.randn(1,node,12,device=dev),"opp":torch.randn(1,1,15,device=dev),
              "bullet":torch.randn(1,8,6,device=dev),"item":torch.randn(1,4,6,device=dev),
              "global":torch.randn(1,1,38,device=dev),"mem":torch.zeros(1,4,256,device=dev) if t==0 else torch.randn(1,4,256,device=dev)}
        m=torch.zeros(1,node+1+8+4+1+4,dtype=torch.bool,device=dev)
        r.append((segs,m,torch.randint(0,node,(1,)),float(torch.randn(1).item())))   # fake action id + reward
    return r   # memory zeroed at round start (per ruling), then carried as input data

if __name__=="__main__":
    dev="cuda"; model=ActorCritic().to(dev); opt=torch.optim.Adam(model.parameters(),3e-4)
    p0=sum(p.detach().double().sum().item() for p in model.parameters())
    print("PARAMS_WITH_VALUE %.2fM"%(sum(p.numel() for p in model.parameters())/1e6))
    rounds=[fake_round() for _ in range(2)]; losses=[]
    for step in range(30):
        tot=torch.zeros((),device=dev); n=0
        for tr in rounds:                                   # per round
            for i in range(0,len(tr),K_WIN):                # BPTT window = K_WIN frames
                win=tr[i:i+K_WIN]; loss=torch.zeros((),device=dev)
                for segs,m,act,rew in win:                  # memory is INPUT data -> no cross-window grad needed
                    o,_=model(segs,m)
                    p=o["growPtr"][0]                       # policy over node candidates (masked softmax inside)
                    logp=torch.log(p[int(act)]+1e-8); ent=-(p*torch.log(p+1e-8)).sum()
                    adv=torch.tensor(rew,device=dev); ratio=torch.exp(logp-logp.detach())
                    loss=loss-torch.min(ratio*adv,torch.clamp(ratio,1-CLIP,1+CLIP)*adv)+ENT*ent
                    n+=1
                tot=tot+loss/max(1,len(win))
        tot=tot/max(1,n) if n else tot
        opt.zero_grad(); tot.backward(); torch.nn.utils.clip_grad_norm_(model.parameters(),0.5); opt.step()
        losses.append(float(tot))
    p1=sum(p.detach().double().sum().item() for p in model.parameters())
    print("SMOKE steps=30 loss_first=%.6f loss_last=%.6f nan=%s"%(losses[0],losses[-1],any(x!=x for x in losses)))
    print("PARAM_SUM before=%.6f after=%.6f changed=%s"%(p0,p1,abs(p1-p0)>1e-9))
    gn=sum(float(g.abs().sum()) for g in [p.grad for p in model.parameters() if p.grad is not None])
    print("GRAD_SUM_last=%.4f" % gn)
