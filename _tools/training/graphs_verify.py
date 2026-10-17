# -*- coding: utf-8 -*-
"""① 四档 CUDA Graphs：录 + 重放一致性验证（不接主流程）
档表 (64/256/512/1000) —— 含 1000 必须（真 N 的 p75=1000）
关键判据：重放输出 == 直接前向输出（allclose）—— 别录出错图"""
import time, torch, importlib.util, io, contextlib
def load(p,n):
    s=importlib.util.spec_from_file_location(n,p); m=importlib.util.module_from_spec(s)
    with contextlib.redirect_stdout(io.StringIO()): s.loader.exec_module(m)
    return m
fx=load('_tools/training/net_v2_fixed.py','fx'); dev='cuda'; net=fx.NetV2().to(dev).eval()
TIERS=(64,256,512,1008)   # ⭐ 主人裁定(2026-10-16)：最高档 1008（1000 停止生长、但 999 节点时生长 +9）
def mk(B,N):
    segs={'node':torch.randn(B,N,10,device=dev),'opp':torch.randn(B,8,15,device=dev),'bullet':torch.randn(B,64,7,device=dev),
          'item':torch.randn(B,8,6,device=dev),'global':torch.randn(B,1,38,device=dev),'mem':torch.randn(B,4,256,device=dev)}
    mask=torch.zeros(B,N+85,dtype=torch.bool,device=dev)
    assert mask.shape[1]==segs['node'].shape[1]+85, '掩码与张量长度不一致（opp 1→8 ⟹ 上下文 78→85）'
    return segs,mask
print('MEM_BEFORE %.1f MB'%(torch.cuda.memory_allocated()/1e6))
for N in TIERS:
    t0=time.time()
    segs,mask=mk(1,N)
    static={k:v.clone() for k,v in segs.items()}; smask=mask.clone()
    for _ in range(3): net(static,smask)
    torch.cuda.synchronize()
    g=torch.cuda.CUDAGraph()
    with torch.cuda.graph(g): out_graph=net(static,smask)
    torch.cuda.synchronize(); rec=(time.time()-t0)*1000
    # ⭐ 录完必须 replay 一次，out_graph 才是【本次重放】的值（否则是录图时刻的旧张量）
    g.replay(); torch.cuda.synchronize()
    # 对照：同一输入、直接前向
    with torch.no_grad(): out_direct=net(static,smask)
    same=all(torch.allclose(a,b,atol=1e-5) for a,b in zip(out_graph,out_direct))
    maxd=max(float((a-b).abs().max()) for a,b in zip(out_graph,out_direct))
    print('TIER %4d 录图=%.0fms 重放==直接前向: %s  maxdiff=%.2e'%(N,rec,same,maxd))
print('MEM_AFTER %.1f MB (四张图)'%(torch.cuda.memory_allocated()/1e6))
