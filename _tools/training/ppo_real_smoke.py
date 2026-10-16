# -*- coding: utf-8 -*-
"""③ PPO 目标接真数据（烟测）：真采记录 → 假 reward（Δh）→ clip/entropy/value → 前反向+更新
如实：真 reward 需游戏侧信号（死亡/比分），此处仅验证"PPO 式子能跑在有界 loss 上"。"""
import json, torch, torch.nn as nn, importlib.util, contextlib, io
spec=importlib.util.spec_from_file_location("tl","_tools/training/train_loop_v1.py")
try:
    tl=importlib.util.module_from_spec(spec)
    with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(tl)
    AC=tl.AC
except Exception as e:
    print("IMPORT_FAIL", str(e)[:80]); AC=None
rows=[json.loads(l) for l in open("D:/vt_run/datasets/selfcol_600.jsonl",encoding="utf-8") if l.strip()]
print("REAL_ROWS n=%d"%len(rows))
if AC:
    dev="cuda"; model=AC().to(dev); opt=torch.optim.Adam(model.parameters(),3e-4)
    p0=sum(p.detach().double().sum().item() for p in model.parameters())
    import importlib; spec2=importlib.util.spec_from_file_location("nv2","_tools/training/net_v2.py"); nv2mod=importlib.util.module_from_spec(spec2)
    with contextlib.redirect_stdout(io.StringIO()): spec2.loader.exec_module(nv2mod)
    make=nv2mod.make
    losses=[]
    for step in range(20):
        B=8; segs,mask=make(B,dev)
        o,v,_=model(segs,mask)
        logp=torch.log(torch.clamp(o["growPtr"].mean(1),1e-6,1))            # 假 logp
        adv=torch.tensor([(rows[i+1]["h"]%1000)/1000.0-0.5 for i in range(B)],dtype=torch.float32,device=dev)
        ratio=torch.exp(logp-logp.detach())
        loss=(-torch.min(ratio*adv,torch.clamp(ratio,0.8,1.2)*adv)).mean()+0.5*(v.squeeze(-1)-adv).pow(2).mean()
        opt.zero_grad(); loss.backward(); opt.step(); losses.append(float(loss))
    p1=sum(p.detach().double().sum().item() for p in model.parameters())
    ok=all(x==x and abs(x)<1e6 for x in losses)
    print("PPO_SMOKE steps=20 loss_first=%.5f loss_last=%.5f 有界无NaN=%s params_changed=%s"%(losses[0],losses[-1],ok,abs(p1-p0)>1e-9))
