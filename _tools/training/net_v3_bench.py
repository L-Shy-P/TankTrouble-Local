# -*- coding: utf-8 -*-
"""bench: max trainable batch + steady-state step time + samples/sec (v2 structure, 1078 tokens)."""
import torch, time
import importlib.util
spec=importlib.util.spec_from_file_location("v2","_tools/training/net_v2.py"); v2=importlib.util.module_from_spec(spec)
import io, contextlib
with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(v2)
NetV2, make = v2.NetV2, v2.make

def bench(B, iters=8):
    dev="cuda"; net=NetV2().to(dev); net.train()
    opt=torch.optim.Adam(net.parameters(),1e-3)
    s,m=make(B,dev)
    for _ in range(3):                                     # warmup
        loss=sum(x.mean() for x in net(s,m)); loss.backward(); opt.step(); opt.zero_grad()
    torch.cuda.synchronize(); torch.cuda.reset_peak_memory_stats()
    t0=time.time()
    for _ in range(iters):
        loss=sum(x.mean() for x in net(s,m)); loss.backward(); opt.step(); opt.zero_grad()
    torch.cuda.synchronize(); dt=(time.time()-t0)/iters
    pk=torch.cuda.max_memory_allocated()/1e9
    del net,opt,s,m; torch.cuda.empty_cache()
    return dt*1000, pk

print("GPU", torch.cuda.get_device_name(0), "totalGB %.1f"%(torch.cuda.get_device_properties(0).total_memory/1e9))
best=None
for B in (32,64,128,256):
    try:
        ms,pk=bench(B)
        print("BENCH batch=%4d ms/step=%7.1f  peakGB=%.2f  samples/s=%6.1f"%(B,ms,pk,B/(ms/1000)))
        best=(B,ms,pk)
    except RuntimeError as e:
        print("OOM batch=%d : %s"%(B,str(e)[:60])); break
print("MAX_OK", best)
