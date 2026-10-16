# -*- coding: utf-8 -*-
"""异步 rollout 的 Python 策略端：stdin 逐行收 {"h":obsHash} → 真网络前向 → stdout 回 {"lp","v","nodeId"}"""
import sys, json, torch, importlib.util, io, contextlib
spec=importlib.util.spec_from_file_location("nv2","_tools/training/net_v2_fixed.py"); nv2=importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(nv2)
dev="cuda" if torch.cuda.is_available() else "cpu"; print("DEV",dev,flush=True); model=nv2.NetV2().to(dev); model.eval()
B=1; _segs,_mask=nv2.make(B,dev)          # ⭐ 循环外建一次、循环内复用（别每帧重建）
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try:
        d=json.loads(line); h=int(d.get("h",0))
        torch.manual_seed(12345)          # ⭐ 固定种子：抽样确定性 ⟹ "同帧同结果"可验证
        segs,mask=_segs,_mask          # ⭐ 复用循环外建好的张量（原：每帧 nv2.make()）
        gx=d.get("g"); nx=d.get("n")
        if gx:
            gg=torch.tensor(gx,dtype=segs["global"].dtype,device=dev).view(1,-1)[:,:segs["global"].shape[2]]
            segs["global"][0,:gg.shape[1],:]=gg
        if nx:
            nn=torch.tensor(nx,dtype=segs["node"].dtype,device=dev)
            k=min(nn.shape[0],segs["node"].shape[1]); w=min(nn.shape[1],segs["node"].shape[2])
            segs["node"][0,:k,:w]=nn[:k,:w]
        with torch.no_grad(): out=model(segs,mask)
        assert len(out)==4, "期望 4 个输出（含动作分布头）、实际 %d —— 检查是否加载了 net_v2_fixed.py" % len(out)
        gp=out[3]
        if gp.dim()>2: gp=gp.squeeze(0)
        node_len=max(1,gp.shape[0]-78)                        # ⭐ 只取 node 段作候选
        logits=gp[:node_len].float().reshape(-1)              # 该头原始分数（一维）
        logp_all=torch.log_softmax(logits,dim=-1)             # ① 数值稳定
        probs=torch.exp(logp_all)
        idx=int(torch.multinomial(probs,1).item())
        lp=float(logp_all[idx])                               # ② 选中项的对数概率（必 ≤0、不再被 clamp 压成 0）
        v=float(out[1].mean()) if len(out)>1 else 0.0
        print(json.dumps({"lp":lp,"v":v,"nodeId":idx}),flush=True)
    except Exception as e:
        print(json.dumps({"lp":None,"v":None,"err":str(e)[:60]}),flush=True)
