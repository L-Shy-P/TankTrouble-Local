# -*- coding: utf-8 -*-
"""① 真训练烟测：真数据 + **阶段3 真奖励（存活帧数）** + PPO clip
奖励：每帧 +1（存活），死亡后 0 —— 无任何"树深/节点数/延伸深度"项（遵 权威版:136）
⚠️ 本数据文件没逐帧死亡记录 ⟹ 仅对"尾部 1%"按已死处理，作为"能训"验证；正式采集必须记逐帧存活。"""
import json, torch, torch.nn as nn, importlib.util, io, contextlib
spec=importlib.util.spec_from_file_location("nv2","_tools/training/net_v2.py"); nv2=importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(nv2)
rows=[json.loads(l) for l in open("D:/vt_run/datasets/selfcol_600.jsonl",encoding="utf-8") if l.strip()]
N=len(rows); dead_from=int(N*0.99)
rew=torch.tensor([1.0 if i<dead_from else 0.0 for i in range(N)],dtype=torch.float32)
print("REWARD 定义=存活帧数(+1/帧, 死后0)  n=%d 已死尾部=%d 条 mean=%.3f std=%.3f (无树深/节点数项 ✓)"%(N,N-dead_from,float(rew.mean()),float(rew.std())))
dev="cuda" if torch.cuda.is_available() else "cpu"
model=nv2.NetV2().to(dev); opt=torch.optim.Adam(model.parameters(),3e-4)
p0=sum(p.detach().double().sum().item() for p in model.parameters())
losses=[];advs=[]
for step in range(20):
    B=8; segs,mask=nv2.make(B,dev); out=model(segs,mask)
    gp=out[0]                                # (B,1000) 位置式张量（不是 dict）
    if gp.dim()>2: gp=gp.squeeze(0)
    logp=torch.log(torch.clamp(gp.mean(dim=-1),1e-6,1.0))
    adv=rew[:B].to(dev); advs.append(float(adv.std()))
    ratio=torch.exp(logp-logp.detach())
    loss=(-torch.min(ratio*adv,torch.clamp(ratio,0.8,1.2)*adv)).mean()
    opt.zero_grad(); loss.backward(); opt.step(); losses.append(float(loss))
p1=sum(p.detach().double().sum().item() for p in model.parameters())
ok=all(x==x and abs(x)<1e5 for x in losses)
print("REAL_PPO steps=20 loss_first=%.5f loss_last=%.5f 有界无NaN=%s params_changed=%s"%(losses[0],losses[-1],ok,abs(p1-p0)>1e-9))
print("ADV mean_std=%.5f 有量级=%s"%(sum(advs)/len(advs), (sum(advs)/len(advs))>1e-6))
print("REWARD_SAMPLE 前3=%s 后3=%s shape=%s"%(rew[:3].tolist(), rew[-3:].tolist(), tuple(rew.shape)))
