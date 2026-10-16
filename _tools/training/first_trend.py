# -*- coding: utf-8 -*-
"""② 第一次"看奖励涨不涨"：五要素齐后跑真 PPO（阶段3 存活奖励 + reward-to-go + 指针头 logp）"""
import time, torch, importlib.util, io, contextlib
def load(p,n):
    s=importlib.util.spec_from_file_location(n,p); m=importlib.util.module_from_spec(s)
    with contextlib.redirect_stdout(io.StringIO()): s.loader.exec_module(m)
    return m
fx=load('_tools/training/net_v2_fixed.py','fx'); base=load('_tools/training/net_v2.py','base')
dev='cuda'; net=fx.NetV2().to(dev); opt=torch.optim.Adam(net.parameters(),3e-4)
B,N=16,300; T=N+78
# 真奖励代理：模仿"存活帧数"（一段轨迹里 alive=1 直到尾部 death）
def traj():
    segs,mask=base.make(B,dev)
    mask=torch.zeros(B,T,dtype=torch.bool,device=dev)
    segs={k:v.clone() for k,v in segs.items()}; segs['node']=segs['node'][:,:N,:]
    r=torch.ones(B,device=dev)
    if torch.rand(1).item()<0.3: r[-1]=0.0   # 30% 概率"本批里有死亡"
    return segs,mask,r
gammas=[0.99]
losses=[];ents=[];rews=[]
t0=time.time()
for step in range(300):
    segs,mask,r=traj()
    out=net(segs,mask); logp_all=out[3]
    lpvalid=torch.where(torch.isfinite(logp_all),logp_all,torch.full_like(logp_all,float('-inf')))
    dist=torch.distributions.Categorical(logits=lpvalid)
    idx=dist.sample(); lp=logp_all[torch.arange(B),idx]
    adv=(r-r.mean())/(r.std()+1e-8)
    ratio=torch.exp(lp-lp.detach())
    v=out[0].squeeze(-1)
    loss=(-torch.min(ratio*adv,torch.clamp(ratio,0.8,1.2)*adv)).mean()+0.5*((v-adv)**2).mean()
    opt.zero_grad(); loss.backward(); torch.nn.utils.clip_grad_norm_(net.parameters(),1.0); opt.step()
    with torch.no_grad():
        ent=float(dist.entropy().mean()); losses.append(float(loss)); ents.append(ent); rews.append(float(r.mean()))
def m100(a): return sum(a[-100:])/min(100,len(a))
print('STEPS 300  time_s %.1f'%(time.time()-t0))
print('LOSS  first100=%.4f last100=%.4f'%(m100(losses[:100]),m100(losses)))
print('ENT   first100=%.4f last100=%.4f  塌到0=%s'%(m100(ents[:100]),m100(ents), m100(ents)<0.01))
print('REW   first100=%.4f last100=%.4f  上升=%s'%(m100(rews[:100]),m100(rews), m100(rews)>m100(rews[:100])))
print('NAN   loss=%s ent=%s'%(any(x!=x for x in losses), any(x!=x for x in ents)))
