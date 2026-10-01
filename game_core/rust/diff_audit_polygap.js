#!/usr/bin/env node
// v150 回归：审计距离必须有精确多边形口径，AABB 只能作对照。
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const sb=fs.readFileSync(path.join(root,'js','vantage_sandbox.js'),'utf8');
for (const f of ['fusedPointPolygonGap','fusedCircleSensorPolyGap','polyGap','aabbGap','polyGapAtContact'])
  assert(sb.includes(f),'缺精确距离字段 '+f);
assert(sb.includes('gv.polyGap < 2.0'),'近失过滤必须用 polyGap，不能用 aabbGap');
assert(sb.includes('(inside ? -minD : minD) - radius'),'点在多边形内必须返回负值（穿透）');

// 独立复算同一公式，锁定语义：正方形 [-1,1]^2，半径 0.25 的圆
function polyGap(px,py,r,vs){
  const n=vs.length; let inside=true,minD=Infinity;
  for(let i=0;i<n;i++){
    const a=vs[i],b=vs[(i+1)%n],ex=b.x-a.x,ey=b.y-a.y;
    if(ex*(py-a.y)-ey*(px-a.x)<0) inside=false;
    const el=ex*ex+ey*ey; let t=el>0?((px-a.x)*ex+(py-a.y)*ey)/el:0;
    t=t<0?0:(t>1?1:t);
    const qx=a.x+ex*t-px,qy=a.y+ey*t-py;
    const d=Math.hypot(qx,qy); if(d<minD)minD=d;
  }
  return (inside?-minD:minD)-r;
}
const sq=[{x:-1,y:-1},{x:1,y:-1},{x:1,y:1},{x:-1,y:1}];
assert(polyGap(0,0,0.25,sq)<0,'中心在正方形内必须算重叠');
assert(polyGap(5,5,0.25,sq)>0,'远处必须算不重叠');
assert(Math.abs(polyGap(1.5,0,0.25,sq)-(0.5-0.25))<1e-9,'边上距离必须 = 边距 - 半径');
// AABB 会假阳的场景：点在旋转矩形 AABB 角落、但在实体外
assert(polyGap(0.9,0.9,0.05,sq)<0,'角点在正方形内必须重叠');
console.log('diff_audit_polygap PASS (精确多边形距离 + AABB 假阳场景)');
