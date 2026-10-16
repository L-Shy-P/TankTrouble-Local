# -*- coding: utf-8 -*-
"""阶段0 单进程 worker：跑 SEC 秒，打印 SPS=<steps/s>（供多进程吞吐实测）"""
import os, time, torch, importlib.util, io, contextlib, sys
spec=importlib.util.spec_from_file_location("nv2","_tools/training/net_v2.py"); nv2=importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(nv2)
dev="cuda" if torch.cuda.is_available() else "cpu"
B=int(os.environ.get("S0_B","32")); SEC=float(os.environ.get("S0_SEC","3"))
model=nv2.NetV2().to(dev); opt=torch.optim.Adam(model.parameters(),3e-4)
n=0; t0=time.time()
while time.time()-t0<SEC:
    segs,mask=nv2.make(B,dev); out=model(segs,mask)
    gp=out[0]
    if gp.dim()>3: gp=gp.reshape(B,-1)
    legal=(gp.abs().sum(-1)>0).float(); heavy=(1.0-legal)
    loss=gp.mean()+heavy.mean()*10.0
    opt.zero_grad(); loss.backward(); opt.step(); n+=1
dt=time.time()-t0
print("WORKER pid=%d dev=%s sps=%.2f steps=%d"%(os.getpid(),dev,n/dt,n))
