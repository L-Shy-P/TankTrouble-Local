# -*- coding: utf-8 -*-
"""③ 第一次"训出东西"的尝试：真数据 + 阶段3 奖励 + reward-to-go + PPO，跑 600 步
判据：平均(回报代理)有没有上升趋势；如实标注"600帧单轨迹 ⟹ 只是信号不是结论" """
import json, torch, importlib.util, io, contextlib
spec=importlib.util.spec_from_file_location("nv2","_tools/training/net_v2.py"); nv2=importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(nv2)
rows=[json.loads(l) for l in open("D:/vt_run/datasets/selfcol_600.jsonl",encoding="utf-8") if l.strip()]
N=len(rows); n_dead=6
r=torch.tensor([1.0]*(N-n_dead)+[0.0]*n_dead); gamma=0.99
G=torch.zeros(N); acc=0.0
for t in range(N-1,-1,-1): acc=r[t].item()+gamma*acc; G[t]=acc
print("RETURN G[0]=%.2f G[-1]=%.2f 单调=%s"%(G[0],G[-1],bool((G[1:]<=G[:-1]).all())))
dev="cuda" if torch.cuda.is_available() else "cpu"
model=nv2.NetV2().to(dev); opt=torch.optim.Adam(model.parameters(),3e-4)
Gn=(G-G.mean())/(G.std()+1e-8)
import statistics as st
curve=[];ent=[]
for step in range(600):
    B=8; idx=torch.randint(0,N-B,(1,)).item()
    segs,mask=nv2.make(B,dev); out=model(segs,mask)
    gp=out[0]
    if gp.dim()>2: gp=gp.squeeze(0)
    p=torch.clamp(gp.mean(dim=-1),1e-6,1.0); logp=torch.log(p)
    adv=Gn[idx:idx+B].to(dev)
    ratio=torch.exp(logp-logp.detach())
    loss=(-torch.min(ratio*adv,torch.clamp(ratio,0.8,1.2)*adv)).mean()
    opt.zero_grad(); loss.backward(); opt.step()
    with torch.no_grad(): curve.append(float(adv.mean())); ent.append(float(-(p*torch.log(p)).mean()))
for k in range(0,600,100): print("STEP %3d  adv_mean=%+.4f  entropy=%.4f"%(k+1,curve[k],ent[k]))
h1=st.mean(curve[:100]); h2=st.mean(curve[-100:])
print("TREND adv_mean 前100=%.5f 后100=%.5f 上升=%s | entropy 前100=%.5f 后100=%.5f | 有NaN=%s"%(
    h1,h2, h2>h1, st.mean(ent[:100]), st.mean(ent[-100:]), any(x!=x for x in curve)))
