# -*- coding: utf-8 -*-
"""output heads v0 (design->impl): 5 heads, masked-softmax pointer, empirical argmax legality >=10k trials.
Defaults (parent-ruled, overridable): shot time = normalized position in node [0,1]; sparse list; order by time asc;
no-grow = caller-side empty (D11); candidates for A = growable leaves, for B = reachable nodes, for fail-head = include truedead.
"""
import torch, torch.nn as nn
D=256; KMAX=8; NEG=float("-inf")

class Heads(nn.Module):
    def __init__(self):
        super().__init__()
        self.node_score = nn.Linear(D,1)      # (1) A: growable leaf pointer
        self.route_score= nn.Linear(D,1)      # (3) B: reachable route-end pointer
        self.shot_ptr   = nn.Linear(D,1)      # (4a) per-shot node pointer (route nodes only)
        self.shot_off   = nn.Linear(D,1)      # (4b) normalized offset in node ([0,1] via sigmoid)
        self.len_head   = nn.Linear(D,KMAX+1) # (4c) sparse list length 0..KMAX
        self.fail_head  = nn.Linear(D,2)      # (5) truedead / alive flag (candidates INCLUDE truedead)
    def pointer(self, logits, mask):
        # mask: True = ILLEGAL (masked out)
        z = logits.masked_fill(mask, NEG)
        return z, torch.softmax(z, dim=-1)

def legality_trials(trials=12000, slen=64, seed=0):
    torch.manual_seed(seed); h=Heads(); bad=0; softmax_nonzero=0; allmasked_nan=0
    for t in range(trials):
        x=torch.randn(slen,D)
        legal=torch.rand(slen)>0.35                       # ~65% legal
        if legal.sum()==0: legal[torch.randint(slen,(1,))]=True
        mask=~legal
        z,p=h.pointer(h.node_score(x).squeeze(-1),mask)
        pick=int(z.argmax())
        if mask[pick]: bad+=1
        if p[mask].abs().max().item()!=0.0: softmax_nonzero+=1
        # edge case: ALL masked
        if t<200:
            z2,p2=h.pointer(h.node_score(x).squeeze(-1),torch.ones(slen,dtype=torch.bool))
            if torch.isnan(p2).any(): allmasked_nan+=1
    return bad, softmax_nonzero, allmasked_nan

if __name__=="__main__":
    torch.manual_seed(0); h=Heads(); x=torch.randn(2,16,D); tok=torch.randn(2,4,D)
    node_mask=torch.zeros(2,16,dtype=torch.bool); node_mask[0,10:]=True     # A: growable leaves
    route_mask=torch.zeros(2,16,dtype=torch.bool); route_mask[1,8:]=True    # B: reachable nodes
    fail_mask=torch.zeros(2,16,dtype=torch.bool)                            # fail-head: INCLUDES truedead -> nothing masked
    zA,pA=h.pointer(h.node_score(x).squeeze(-1),node_mask)
    zB,pB=h.pointer(h.route_score(x).squeeze(-1),route_mask)
    zS,pS=h.pointer(h.shot_ptr(x).squeeze(-1),torch.logical_or(route_mask, torch.zeros_like(route_mask)))
    off=torch.sigmoid(h.shot_off(tok).squeeze(-1)); L=h.len_head(tok)
    fa=h.fail_head(tok)
    print("SHAPES A=%s B=%s shot=%s off=%s len=%s fail=%s"%(tuple(pA.shape),tuple(pB.shape),tuple(pS.shape),tuple(off.shape),tuple(L.shape),tuple(fa.shape)))
    print("MASK_TAIL pA[0,-1]=%.3g pB[1,-1]=%.3g lenArgmax=%s offRange=[%.3f,%.3f]"%(pA[0,-1],pB[1,-1],L.argmax(-1).tolist(),off.min(),off.max()))
    bad,sm_nonzero,nan=legality_trials()
    print("LEGALITY trials=12000 illegal_picks=%d  masked_softmax_nonzero=%d  all_masked_nan_cases=%d"%(bad,sm_nonzero,nan))
    print("PARAMS_heads=%.4fM"%(sum(p.numel() for p in h.parameters())/1e6))
