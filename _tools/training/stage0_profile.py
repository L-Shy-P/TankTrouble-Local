# -*- coding: utf-8 -*-
"""① 剖析 255ms/步花在哪：分别计时 数据准备/前向/反向/优化器，并试 预生成数据/AMP/更大B"""
import time, torch, importlib.util, io, contextlib
spec=importlib.util.spec_from_file_location("nv2","_tools/training/net_v2.py"); nv2=importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(nv2)
dev="cuda"; sync=torch.cuda.synchronize
model=nv2.NetV2().to(dev); opt=torch.optim.Adam(model.parameters(),3e-4); lossf=lambda out: out[0].mean()
def seg(B, steps):   # 分解计时
    t=[0.0]*4
    for _ in range(steps):
        s=time.time(); segs,mask=nv2.make(B,dev); sync(); t[0]+=time.time()-s
        s=time.time(); out=model(segs,mask); loss=lossf(out); sync(); t[1]+=time.time()-s
        s=time.time(); opt.zero_grad(); loss.backward(); sync(); t[2]+=time.time()-s
        s=time.time(); opt.step(); sync(); t[3]+=time.time()-s
    return [x/steps*1000 for x in t]
def cached(B, steps, amp=False, compile_=False):
    segs,mask=nv2.make(B,dev)
    m2=model
    if compile_:
        try: m2=torch.compile(model)
        except Exception as e: return None,"compile失败:%s"%str(e)[:40]
    scaler=torch.cuda.amp.GradScaler(enabled=amp)
    for _ in range(5):
        with torch.cuda.amp.autocast(enabled=amp): out=m2(segs,mask); loss=lossf(out)
        scaler.scale(loss).backward(); scaler.step(opt); scaler.update(); opt.zero_grad()
    sync(); t0=time.time()
    for _ in range(30):
        with torch.cuda.amp.autocast(enabled=amp): out=m2(segs,mask); loss=lossf(out)
        opt.zero_grad(); scaler.scale(loss).backward(); scaler.step(opt); scaler.update()
    sync(); return (time.time()-t0)/30*1000, "ok"
print("S0_DEV", torch.cuda.get_device_name(0), "tf32", torch.backends.cuda.matmul.allow_tf32)
for B in (32,64):
    d,f,b,o=seg(B,10)
    print("BREAK B=%d  数据准备=%.1fms 前向=%.1fms 反向=%.1fms 优化器=%.1fms 合计=%.1fms"%(B,d,f,b,o,d+f+b+o))
for B in (32,64,128,256):
    ms,note=cached(B,30,amp=False)
    print("CACHED B=%d  %.1f ms/步  (%.1f 步/s)  %s"%(B,ms,1000/ms,note))
for B in (64,128):
    ms,note=cached(B,30,amp=True)
    print("AMP   B=%d  %.1f ms/步  (%.1f 步/s)  %s"%(B,ms,1000/ms,note))
