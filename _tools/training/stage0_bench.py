# -*- coding: utf-8 -*-
"""① 阶段0 独立跑速度实测：合成树 → 前向 → 合法性检查 → 分级惩罚 → 反向（纯 Python，不跑游戏/不跑浏览器）
「合成树」= 用 net 自己的 make() 造随机批次（等价"随机合成树输入"）"""
import time, torch, importlib.util, io, contextlib
spec=importlib.util.spec_from_file_location("nv2","_tools/training/net_v2.py"); nv2=importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(nv2)
dev="cuda" if torch.cuda.is_available() else "cpu"
model=nv2.NetV2().to(dev); opt=torch.optim.Adam(model.parameters(),3e-4)
def bench(B, steps=50, tag=""):
    for _ in range(5):
        segs,mask=nv2.make(B,dev); out=model(segs,mask)
    torch.cuda.synchronize() if dev=="cuda" else None
    t0=time.time()
    for s in range(steps):
        segs,mask=nv2.make(B,dev); out=model(segs,mask)
        gp=out[0]
        if gp.dim()>3: gp=gp.reshape(B,-1)
        # 合法性检查：全掩 ⟹ 重罚（契约：不许 NaN）
        legal=(gp.abs().sum(-1)>0).float()
        heavy=(1.0-legal)                      # 重罚
        light=torch.relu(gp.sum(-1)).mean()*0.0  # 轻罚占位（0）
        loss=(gp.mean()+heavy.mean()*10.0+light)
        opt.zero_grad(); loss.backward(); opt.step()
    torch.cuda.synchronize() if dev=="cuda" else None
    dt=time.time()-t0; ms=dt/steps*1000
    sps=steps/dt
    print("STAGE0 B=%4d steps=%3d  %.2f ms/step  %.1f step/s  (episodes/s≈%.1f 按1步=1批)"%(B,steps,ms,sps,sps))
    return ms
for B in (32,64,128):
    ms=bench(B)
    for N in (10_000,1_000_000,100_000_000):
        print("   折算 %d 步(批) 需 %.3f h"%(N, ms*N/1000/3600))
