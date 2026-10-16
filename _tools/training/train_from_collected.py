# -*- coding: utf-8 -*-
"""④ 打通"采集→训练"（管线烟测）：读回落盘的 A 样本 → 张量化 → 前向/loss/反向/更新
注意（如实）：路线 B 设计下【不落盘全观测】，落盘的是紧凑流程记录；本脚本用它构造输入张量，
真观测由页面编码器在采集时算、训练时靠重放重建（后续接）。"""
import json, glob, torch, torch.nn as nn, importlib.util, contextlib, io
spec=importlib.util.spec_from_file_location("nv2","_tools/training/net_v2.py"); nv2=importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(nv2)
NetV2, make = nv2.NetV2, nv2.make

path="D:/vt_run/datasets/a_samples_sink.jsonl"
rows=[json.loads(l) for l in open(path,encoding="utf-8") if l.strip()]
print("READ_BACK n=%d keys=%s"%(len(rows), sorted(rows[0].keys()) if rows else None))
print("MEMORY_FIELD_ABSENT=%s (抽查: 记录里没有 memory 段 ⟹ 采集侧不存记忆)"%("memory" not in rows[0]))
shards=sorted(glob.glob("D:/vt_run/datasets/ashards2/*.abin"))
print("PACKED_SHARDS=%d bytes_total=%d"%(len(shards), sum(__import__("os").path.getsize(p) for p in shards)))

# 张量化：用紧凑记录构造 obs(B,10540)（烟测；真观测后续用重放重建）
B=min(len(rows),16)
obs=torch.zeros(B,10540)
for i,r in enumerate(rows[:B]):
    v=torch.tensor([r.get("f",0), r.get("commits",0), r.get("nNodes",0)],dtype=torch.float32)
    obs[i,:3]=v; obs[i,3:6]=v
dev="cuda" if torch.cuda.is_available() else "cpu"
obs=obs.to(dev); segs,mask=make(B,dev); segs["global"]=obs[:, :38].view(B,1,38)
net=NetV2().to(dev); opt=torch.optim.Adam(net.parameters(),3e-4)
p0=sum(p.detach().double().sum().item() for p in net.parameters())
losses=[]
for step in range(10):
    out=net(segs,mask); loss=sum(o.mean() for o in out)
    opt.zero_grad(); loss.backward(); opt.step(); losses.append(float(loss))
p1=sum(p.detach().double().sum().item() for p in net.parameters())
print("TRAIN steps=10 loss_first=%.5f loss_last=%.5f params_changed=%s"%(losses[0],losses[-1],abs(p1-p0)>1e-9))
print("PIPE_OK read->tensor->forward->loss->backward->update  (obs=%s)"%(tuple(obs.shape),))
