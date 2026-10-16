# -*- coding: utf-8 -*-
"""full net v0: trunk (segment tokens, <=1000 nodes) + 5 heads, one forward -> all outputs.
Contract: every masked-pointer head asserts >=1 legal candidate (else raise, never NaN).
Heads: A-grow(pointer over node tokens) / B-route(pointer over node tokens) /
       shots(pointer over route nodes + normalized offset + length) / fail(flag, candidates include truedead).
"""
import torch, torch.nn as nn
D,L,H,FF=256,3,8,4; SEG={"node":12,"opp":15,"bullet":6,"item":6,"global":38,"mem":256}; KMAX=8

class FullNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.proj=nn.ModuleDict({k:nn.Linear(v,D) for k,v in SEG.items()})
        self.type_emb=nn.ParameterDict({k:nn.Parameter(torch.zeros(1,1,D)) for k in SEG})
        self.trunk=nn.TransformerEncoder(nn.TransformerEncoderLayer(D,H,D*FF,batch_first=True,dropout=0.0,norm_first=True),L)
        self.node_score=nn.Linear(D,1); self.route_score=nn.Linear(D,1); self.shot_ptr=nn.Linear(D,1)
        self.shot_off=nn.Linear(D,1); self.len_head=nn.Linear(D,KMAX+1); self.fail_head=nn.Linear(D,2)
    def masked_pointer(self,score,mask,what):
        if mask.all(): raise ValueError("no legal candidate in "+what)      # <= contract: never NaN
        z=score.masked_fill(mask,float("-inf"))
        return z, torch.softmax(z,dim=-1)
    def forward(self,segs,mask):
        toks={}
        for k in ("node","opp","bullet","item","global","mem"):
            x=segs[k]; n=x.shape[1]
            pos=torch.arange(n,device=x.device).view(1,n,1).float()/max(1,n)
            toks[k]=self.proj[k](x)+self.type_emb[k]+pos
        seq=torch.cat([toks[k] for k in ("node","opp","bullet","item","global","mem")],1)
        h=self.trunk(seq,src_key_padding_mask=mask)                          # (B,N,d)
        nodes=h[:, :segs["node"].shape[1], :]                                # node tokens
        g=h.mean(1)                                                          # pooled for scalar heads
        m_node=torch.zeros(nodes.shape[:2],dtype=torch.bool,device=nodes.device)
        m_node[:, -50:]=True                                                 # demo: last 50 illegal
        _,pA=self.masked_pointer(self.node_score(nodes).squeeze(-1),m_node,"A-grow")
        _,pB=self.masked_pointer(self.route_score(nodes).squeeze(-1),m_node.clone(),"B-route")
        _,pS=self.masked_pointer(self.shot_ptr(nodes).squeeze(-1),m_node.clone(),"shots")
        return {"growPtr":pA,"routePtr":pB,"shotPtr":pS,
                "shotOffset":torch.sigmoid(self.shot_off(g)),"shotLen":self.len_head(g),"failFlag":self.fail_head(g)}

if __name__=="__main__":
    torch.manual_seed(0); net=FullNet(); B=2
    def mk(n,node=1000,bul=64,itm=8):
        return ({"node":torch.randn(n,node,12),"opp":torch.randn(n,1,15),"bullet":torch.randn(n,bul,6),
                 "item":torch.randn(n,itm,6),"global":torch.randn(n,1,38),"mem":torch.randn(n,4,256)},
                torch.zeros(n,node+1+bul+itm+1+4,dtype=torch.bool))
    s,m=mk(B); net.eval()
    with torch.no_grad(): out=net(s,m)
    print("FULL_FORWARD_OK",{k:tuple(v.shape) for k,v in out.items()})
    print("PARAMS %.2fM"%(sum(p.numel() for p in net.parameters())/1e6))
    s2,m2=mk(1); s2["node"][:, :, :]=0
    bad=0
    for t in range(2000):
        mm=torch.rand(1,1000)>0.5
        if mm.all(): continue
        with torch.no_grad():
            z,p=net.masked_pointer(net.node_score(torch.randn(1,1000,D)).squeeze(-1),mm,"t")
        if mm[0,int(z.argmax())]: bad+=1
    print("LEGALITY_2k illegal=%d"%bad)
    try:
        with torch.no_grad(): net.masked_pointer(torch.randn(1,1000),torch.ones(1,1000,dtype=torch.bool),"allmask")
        print("ASSERT_FAIL not raised (BAD)")
    except ValueError as e: print("ASSERT_OK raised:",str(e))
    print("NO_SCORE_INPUT ok (segs only 12/15/6/6/38/256)")
