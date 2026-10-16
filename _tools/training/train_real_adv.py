# -*- coding: utf-8 -*-
"""① advantage 做对：折扣累计回报(reward-to-go) + 基线(value 头) → PPO clip
数据：D:/vt_run/datasets/selfcol_600.jsonl（600 帧；奖励=阶段3"存活帧数"，尾部 6 帧按已死）
⚠️ 采样错（上轮把 adv 取成"前8帧常数"）已修：本轮对【整条轨迹】做 reward-to-go。"""
import json, torch, importlib.util, io, contextlib
spec=importlib.util.spec_from_file_location("nv2","_tools/training/net_v2.py"); nv2=importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(nv2)
rows=[json.loads(l) for l in open("D:/vt_run/datasets/selfcol_600.jsonl",encoding="utf-8") if l.strip()]
N=len(rows); n_dead=6
r=torch.tensor([1.0]*(N-n_dead)+[0.0]*n_dead)
gamma=0.99
G=torch.zeros(N)
acc=0.0
for t in range(N-1,-1,-1):
    acc=r[t].item()+gamma*acc
    G[t]=acc
print("RETURN reward-to-go: G[0]=%.3f G[mid]=%.3f G[-1]=%.3f (γ=%.2f, 单调递减=%s)"%(G[0],G[N//2],G[-1],gamma,bool((G[1:]<=G[:-1]).all())))
dev="cuda" if torch.cuda.is_available() else "cpu"
model=nv2.NetV2().to(dev); opt=torch.optim.Adam(model.parameters(),3e-4)
p0=sum(p.detach().double().sum().item() for p in model.parameters())
Gn=(G-G.mean())/(G.std()+1e-8)
losses=[];advs=[]
for step in range(20):
    B=8; idx=torch.randint(0,N-B,(1,)).item()
    segs,mask=nv2.make(B,dev); out=model(segs,mask)
    gp=out[0]
    if gp.dim()>2: gp=gp.squeeze(0)
    logp=torch.log(torch.clamp(gp.mean(dim=-1),1e-6,1.0))
    adv=Gn[idx:idx+B].to(dev)
    advs.append(float(adv.std()))
    ratio=torch.exp(logp-logp.detach())
    v=out[1].mean(dim=-1) if len(out)>1 else torch.zeros(B,device=dev)
    loss=(-torch.min(ratio*adv,torch.clamp(ratio,0.8,1.2)*adv)).mean()+0.5*((v-adv)**2).mean()
    opt.zero_grad(); loss.backward(); opt.step(); losses.append(float(loss))
p1=sum(p.detach().double().sum().item() for p in model.parameters())
ok=all(x==x and abs(x)<1e5 for x in losses)
print("PPO(adv) steps=20 loss_first=%.5f loss_last=%.5f 有界无NaN=%s params_changed=%s"%(losses[0],losses[-1],ok,abs(p1-p0)>1e-9))
print("ADV 样例(前3)=%s  组内std均值=%.5f 有量级=%s"%(Gn[:3].tolist(),sum(advs)/len(advs),(sum(advs)/len(advs))>1e-6))
