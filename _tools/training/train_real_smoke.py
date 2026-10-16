# -*- coding: utf-8 -*-
"""③ 接真数据烟测：用【自采的真实逐帧记录】做"下一帧观测预测"（自监督）⟹ 判据 loss 应当下降
数据：D:/vt_run/datasets/selfcol_600.jsonl（{t,d,h} 600 条真采）"""
import json, torch, torch.nn as nn
rows=[json.loads(l) for l in open("D:/vt_run/datasets/selfcol_600.jsonl",encoding="utf-8") if l.strip()]
print("REAL_ROWS n=%d  keys=%s"%(len(rows), sorted(rows[0].keys())))
X=torch.tensor([[r["t"], r["d"], r["h"]%100000] for r in rows[:-1]],dtype=torch.float32)
X=(X-X.mean(0))/(X.std(0)+1e-6)
Y=torch.tensor([[r["h"]%100000] for r in rows[1:]],dtype=torch.float32)
Y=(Y-Y.mean(0))/(Y.std(0)+1e-6)
dev="cuda" if torch.cuda.is_available() else "cpu"; X=X.to(dev); Y=Y.to(dev)
net=nn.Sequential(nn.Linear(3,64),nn.ReLU(),nn.Linear(64,64),nn.ReLU(),nn.Linear(64,1)).to(dev)
opt=torch.optim.Adam(net.parameters(),1e-2); lossf=nn.MSELoss()
p0=sum(p.detach().double().sum().item() for p in net.parameters()); cur=[]
for s in range(200):
    pred=net(X); loss=lossf(pred,Y); opt.zero_grad(); loss.backward(); opt.step(); cur.append(float(loss))
p1=sum(p.detach().double().sum().item() for p in net.parameters())
print("REAL_TRAIN steps=200 loss_first=%.5f loss@50=%.5f loss_last=%.5f 下降=%s nan=%s"%(
    cur[0],cur[49],cur[-1], cur[-1]<cur[0], any(x!=x for x in cur)))
print("PARAMS_CHANGED=%s  (样本=%d)"%(abs(p1-p0)>1e-9, X.shape[0]))
