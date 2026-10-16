# -*- coding: utf-8 -*-
"""① TF32 开关对比 + ② B=128 掉崖的替代方案（梯度累积）"""
import time, torch, importlib.util, io, contextlib
spec=importlib.util.spec_from_file_location("nv2","_tools/training/net_v2.py"); nv2=importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(nv2)
dev="cuda"
def bench(B, steps=10, tf32=False, prec=None, accum=1):
    torch.backends.cuda.matmul.allow_tf32=tf32; torch.backends.cudnn.allow_tf32=tf32
    if prec: torch.set_float32_matmul_precision(prec)
    m=nv2.NetV2().to(dev); opt=torch.optim.Adam(m.parameters(),3e-4)
    segs,mask=nv2.make(B,dev)
    for _ in range(3):
        out=m(segs,mask); loss=out[0].mean()/accum; loss.backward()
        if accum==1: opt.step(); opt.zero_grad()
    torch.cuda.synchronize(); t0=time.time()
    for s in range(steps):
        for a in range(accum):
            out=m(segs,mask); loss=out[0].mean()/accum; loss.backward()
        opt.step(); opt.zero_grad()
    torch.cuda.synchronize(); return (time.time()-t0)/steps*1000
print("TF32_OFF  B=32 %.1f ms/步"%bench(32,tf32=False))
print("TF32_ON   B=32 %.1f ms/步"%bench(32,tf32=True))
print("PREC_HIGH B=32 %.1f ms/步"%bench(32,tf32=False,prec="high"))
print("TF32_ON   B=64 %.1f ms/步"%bench(64,tf32=True))
B=32
for acc in (1,4):
    ms=bench(B,steps=6,tf32=True,accum=acc)
    print("GRAD_ACC  B=%d x accum=%d ⟹ %.1f ms/步 (等效批 %d, %.0f 样本/s)"%(B,acc,ms,B*acc,B*acc/(ms/1000)))
