// 最小采集器（父代理 2026-10-17 夜）：2 人局 Vantage vs Laika → 逐帧记录 → 每局一行 JSON 喂训练器
const fs=require('fs');const {spawn}=require('child_process');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_fire.js','utf8');
const OUT=(process.env.C_OUT||'D:/vt_run/collect')+'/';
const ROUNDS=+process.env.C_ROUNDS||3, CAP=+process.env.C_CAP||900, FIRE=+process.env.C_FIRE||1;
const NODE_SLOTS=1000, BUL_SLOTS=64, OPP=15, OPP_SLOTS=8, ITEM_R=8, ITEM_C=6, GLB=38;   // ⭐ OPP_SLOTS=8：与服务端 mk() 的 opp 槽 (B,8,15) 同源
// ⭐ 从 global 的 oppTok 造 opp(8,15)：oppTok = 每对手 15 维 × N 个对手（8 人局 = 105 维）
//    ⟹ 逐 15 维切成最多 8 行、其余补零（⛔ 不再"只取最近 1 个对手"那套裁剪）
var oppSeen={max:0,over:0};
function oppRows(o){
  var src=(o&&o.opp)||[]; var nb=Math.floor(src.length/OPP);
  if(nb>oppSeen.max)oppSeen.max=nb;
  if(nb>OPP_SLOTS){ oppSeen.over++; if(oppSeen.over<=3) console.log('⚠️ OPP_OVER 对手数 '+nb+' > 槽位 '+OPP_SLOTS+'（已显式计数、不静默）'); }
  var out=[]; for(var b=0;b<OPP_SLOTS;b++){ var r=[]; for(var i=0;i<OPP;i++) r.push(b<nb?+src[b*OPP+i]||0:0); out.push(r); }
  return out;
}
function itemRows(o){
  var col=(o&&o.col)||[], mine=(o&&o.mine)||[], out=[];
  for(var k=0;k<8;k++){
    var c=col.slice(k*3,k*3+3), m=mine.slice(k*3,k*3+3);
    while(c.length<3)c.push(0); while(m.length<3)m.push(0);
    out.push([+c[0]||0,+c[1]||0,+c[2]||0,+m[0]||0,+m[1]||0,+m[2]||0]);
  }
  return out;
}
function pad(rows,slot,w){ if(rows.length>=slot) return rows.slice(0,slot); const out=rows.slice(); const z=new Array(w).fill(0); while(out.length<slot) out.push(z.slice()); return out; }
// ⭐ 一问一答（行队列版，2026-10-17 修）：原 `stdout.once('data')` 会把"一个 chunk 里的多行"（开机 6 行日志）当一条
//    ⟹ 前几帧解析失败 + 首帧串包（实测 max|Δlp|=2.13）。这里按 `\n` 切行排队；开机必须先吃掉到 WARMUP_SAMPLE。
let _buf='', _q=[], _wait=[];
function _pumpLine(ln){ if(!String(ln).trim())return; if(_wait.length)_wait.shift()(ln); else _q.push(ln); }
function _nextLine(){ if(_q.length) return Promise.resolve(_q.shift()); return new Promise(r=>_wait.push(r)); }
function ask(srv,o){ srv.stdin.write(JSON.stringify(o)+'\n'); return _nextLine().then(t=>{ try{return JSON.parse(String(t).trim())}catch(e){return {lp:null,err:'parse',raw:String(t).slice(0,160)}} }); }
async function waitBoot(){ for(let i=0;i<40;i++){ const ln=await _nextLine(); if(String(ln).indexOf('WARMUP_SAMPLE')>=0) return i+1; } throw new Error('开机 40 行里没出现 WARMUP_SAMPLE'); }
const SCORE_SRC="(()=>{var gc=GameManager.getGameController();var out={state:gc?gc.getState():null,scores:{}};try{var ss=gc.getScores();for(var k in ss){var s=ss[k];var pid=s.getPlayerId?s.getPlayerId():s.playerId;var t=s.getType?s.getType():s.type;var v=s.getValue?s.getValue():s.value;out.scores[pid+':'+t]=v;}}catch(e){out.err=String(e&&e.message||e);}return out})()";
(async()=>{
  fs.mkdirSync(OUT,{recursive:true});
  const srv=spawn('py',['-3.13','_tools/training/policy_server_graph.py'],{env:{...process.env,PYTHONIOENCODING:'utf-8'}});
  srv.stderr.on('data',d=>{ const t=String(d); if(t.indexOf('CKPT_')>=0) console.log('SRV_CKPT '+t.trim().slice(0,120)); });
  srv.stdout.setEncoding('utf8');
  srv.stdout.on('data',d=>{ _buf+=String(d); let i; while((i=_buf.indexOf('\n'))>=0){ const ln=_buf.slice(0,i); _buf=_buf.slice(i+1); _pumpLine(ln); } });
  const m=new Match(); const op=await m.open({humanIds:[],aiCount:1,vantCount:1,control:false});
  console.log('SRV_BOOT_LINES '+await waitBoot());   // ⭐ 必须先吃完开机行（否则前几帧串包）
  console.log('OPEN '+JSON.stringify({ai:op.aiIds,vant:op.vantageIds}));
  await m.eval(SRC); console.log('SETUP '+await m.eval('window.__probe.setup()'));
  // ⭐ 开火接线（2026-10-17 派单③）：服务端返回的 fire 决定本帧要不要拼 picks[1] 射击帧
  const FIRE_BACK=process.env.VT_FIRE_BACK||'now';
  const MEM_ENV=(process.env.VT_MEM_ON==='1');
  const GROW_SRC=(process.env.VT_GROW_SRC||'server');   // ⭐ A/B 开关：server=服务端 head_grow 采样；bridge=桥自己取 B 目标叶（Arm A）   // ⭐ 记忆开关：环境可强制开；否则读 window.__vtConfig.mem   // ⭐ 默认 now = back=L−1−rel（2026-10-17 裁定 (a)：当帧开火）
  await m.eval('window.__b.fireBias='+(+process.env.VT_FIRE_REL_BIAS||0)+';'); console.log('FIRE_BIAS '+(+process.env.VT_FIRE_REL_BIAS||0)+' FIRE_BACK '+await m.eval('window.__b.setFireBack('+JSON.stringify(FIRE_BACK)+')')+'（zero=父代理指定 back=0 / now=对照 back=L-1-rel）');
  await m.pump(20,{yieldMs:0});
  const inRound=await m.eval("(()=>{try{return GameModel._STATES.IN_ROUND}catch(e){return 'in round'}})()");
  const episodes=[]; const wins=[]; const epFd=fs.openSync(OUT+'episodes.jsonl','w');   // ⭐ 逐局落盘（cap=3000 全攒在内存会 heap OOM）
  let totalFrames=0, totalProj=0, vFire=0, truncated=0, lpOk=0, lpTot=0, oob=0, skippedNoTree=0, badLp=0;
  // ⭐ 开火接线记账（派单③）：fire=1 帧数 / 真出现 vantage_1 子弹的帧数 / picks[1] 提交与被接受/被拒
  let firedFrames=0, fireAndBullet=0, noFireButBullet=0, picks1Submitted=0, pickExtras=0, giveUpB=0;
  let aimFrames=0, nodeIdSet=new Set();
  let aReqOk=0, aReqBad=0, aSkipNoCand=0, growEntSee=null;
  let fireEntSee=null, fireLpCnt=0;
  let skipNoAction=0;   // ⭐ N<2 无合法动作（no-op 已移出）   // ⭐ head_fire 采样参数   // ⭐ A 相：请求成功/失败/无候选
  let growUidCnt=0;
  let emptyIntentFrames=0;
  const MEM_ECHO_MAX=+(process.env.VT_MEM_ECHO_MAX||260);   // ⭐ 对拍回声上限（帧）
  let memEcho=[];
  let prevGiveUpB=null, legalPen=0, legalExcluded=0, legalUnknown=0, legalPenBase=0; const legalByCls={};   // ⭐ legal 重罚计数   // ⭐ 空射意图帧数（没子弹仍想开火）   // ⭐ aim 帧数 / 每局 distinct nodeId
  let prevVCount=0, spawnFrames=0, fire1ThenSpawn=0, lastFire=0, subFireFrames=0;   // ⭐ 新子弹计数（比"在飞"严格）+ 游戏侧开火键真值
  let lastPickSameCursor=0, lastPickCursorChanged=0;
  let targetChangedFrames=0, targetSameFrames=0, prevTargetId=null, opBFireFrames=0, opBFrames=0, opOtherFrames=0;
  let slotsNullFrames=0, buildOKEnd=0, buildMissEnd=0, fireNoCursorEnd=0, fireErrSeen='';
  let vNextOk=0, vNextFail=0;   // ⭐ (A)1 截断局 v_next 补得成不成功（⏔t 不静默）
  let desiredFireFrames=0, desiredErrSeen='';
  const TRACE_FIRE=(process.env.VT_FIRE_TRACE==='1'), TRACE_N=+(process.env.VT_FIRE_TRACE_N||60);   // ⭐ 父代理 ① 只读诊断   // ⭐ 诊断：射击帧的依据游标下一帧是否还在
  const skipReasons={}, aReasons={}, roundFire=[];   // ⭐ aReasons = A 相拒绝原因分类
  for(let ep=1; ep<=ROUNDS; ep++){
    const frames=[]; let nodeId=0, done=false, won=null, f=0, prevState=null;
    const rb=JSON.parse(await m.eval('JSON.stringify(window.__b.stats())'));   // ⭐ 本轮起点（picks[1] 提交/被接受差分用）
    const firedBase=firedFrames;
    nodeIdSet=new Set(); prevGiveUpB=null;   // ⭐ 每局重置
    // ⭐ 记忆开关（每局读一次）：面板写 window.__vtConfig.mem，采集器只读
    const _nc0=await m.eval("(()=>{try{var t=VantageTree.getTree();return t?t.nodeCount:null}catch(e){return null}})()");   // ⭐ A 相：本局起点节点数
    const memOn = MEM_ENV ? 1 : (await m.eval("(()=>{try{return (window.__vtConfig&&window.__vtConfig.mem)?1:0}catch(e){return 0}})()"));   // ⭐ 每局重置
    let rbOpBFire=0, wepFirst=null, wepLast=null, rbWepInc=0, rbWepDec=0, rbNumLast=null, prevWepFired=null, rbVBullet=0; let prevAlive=null;   // ⭐ 上一帧对手 alive 位（命中推断用）   // ⭐ 逐局开火/真发射对账
    const spawnBase=spawnFrames, lpBase=lpOk, lpTotBase=lpTot, oobBase=oob;   // ⭐ 逐局对账起点
    let waited=0;   // ⭐⭐ 必须先等进入 IN_ROUND，否则会把"倒计时/回合间"当成回合结束（假负）
    while(waited++<800){ const s0=await m.eval(SCORE_SRC); if(s0.state===inRound) break; await m.pump(1,{yieldMs:0}); }
    for(f=0; f<CAP; f++){
      const st=await m.eval(SCORE_SRC);
      if(f>5 && st.state==='ended'){ done=true;   // ⭐ 只认 `GameModel._STATES.ENDED`（"between rounds"/"counting down" 是回合【前】状态 ⟹ 曾把 42/50 局误判成 21 帧假负）
        let v={}; for(const k in st.scores){ if(k.indexOf(':1')>0) v[k.split(':')[0]]=st.scores[k]; }
        const ids=Object.keys(v);
        if(ids.length===1) won=(ids[0]==='vantage_1')?1:0; else won=(ids.length===0)?-1:null;
        if(won===null){ var anyV=false; for(var k2 in st.scores){ if(k2.indexOf(':1')>0&&st.scores[k2]>0) anyV=true; }
          if(anyV){ var vp=Object.keys(st.scores).filter(function(k3){return k3.indexOf(':1')>0&&st.scores[k3]>0;})[0];
                    won=(vp.indexOf('vantage_1')===0)?1:0; } }
        console.log('EP'+ep+' ROUND_END state='+st.state+' scores='+JSON.stringify(st.scores)+' won='+won);
        break; }
      const o=JSON.parse(await m.eval('window.__b.step('+nodeId+',0)'));   // ⭐ 开火位在【拿到服务端回答后】再置（同一帧生效，无延迟）
      if(o.err){ console.log('STEP_ERR '+o.err); break; }
      { const skv=(o.stats&&o.stats.skipped)?String(o.stats.skipped):''; if(skv){ skipReasons[skv]=(skipReasons[skv]||0)+1;
        if(skv.indexOf('A:')===0||skv.indexOf('生长')>=0){ const key=skv.replace(/\d+/g,'N'); aReasons[key]=(aReasons[key]||0)+1; } } }   // ⭐ A 相拒绝原因分类   // ⭐ 被拒原因逐类计数（如 'B:重试超限(射击:...)'）
      if(o.subFire===true) subFireFrames++;
      if(o.desiredFire===true) desiredFireFrames++;
      if(o.desiredErr && !desiredErrSeen) { desiredErrSeen=String(o.desiredErr); }
      if(TRACE_FIRE && f<TRACE_N){
        const lp=o.stats&&o.stats.lastFirePick;
        console.log('TRACE f='+f+' desiredFrame='+o.desiredFrame+' desiredFire='+o.desiredFire+' op='+(o.opName||'')+
          ' | lastPick='+(lp?JSON.stringify(lp):'null')+' | cur='+(o.cur?JSON.stringify({id:o.cur.id,L:o.cur.L,rel:o.cur.rel,onPath:o.cur.onPath}):'null')+
          ' | wantFire='+o.wantFire+' subFire='+o.subFire);
      }   // ⭐ 游戏侧真值：该帧提交的 inputState.fire 为真
      let spawnedNow=0, hitNow=0, rKill=0, rSelfkill=0, rDeath=0, rKillStorm=0, rDeathStorm=0;
      let legalNow=0;   // ⭐ 本帧重罚（负计数，逐帧归因）
      { const ks=(o.kills||[]); for(let ki=0;ki<ks.length;ki++){ const e2=ks[ki]; const kk=e2.killer, vv=e2.victim;
          const killerKnown = (kk!==null && kk!==undefined);
          if(vv==='vantage_1'){ if(killerKnown && kk==='vantage_1') rSelfkill++; else if(!killerKnown) rDeathStorm++; else rDeath++; }
          else if(killerKnown && kk==='vantage_1'){ rKill++; hitNow++; }
          else if(!killerKnown){ rKillStorm++; }
        } }   // ⭐奖惩 v2：用 TANK_KILLED 的 killer/victim；storm 部分是【推断】(killer 缺失)，计数在 summary
      if(o.ammo!==null && o.ammo!==undefined && o.ammo<=0 && o.queueLen!==null && !(o.queueLen>0) && o.wantFire) emptyIntentFrames++;
      // ⭐⭐ legal（重罚）：每次被拒计一次负奖励；⏔t 罚「树自身变化导致引用失效」
      { const gb=((o.stats&&typeof o.stats.giveUpB==='number')?o.stats.giveUpB:0);
        const dG=(prevGiveUpB===null)?0:Math.max(0,gb-prevGiveUpB); prevGiveUpB=gb;
        if(dG>0){ const sk=String((o.stats&&o.stats.skipped)||'');
          let cls=null;
          if(sk.indexOf('no-output')>=0||sk.indexOf('noSlots')>=0) cls='no_output';
          else if(sk.indexOf('炮口贴墙')>=0) cls='wall';
          else if(sk.indexOf('不在路线上')>=0) cls='off_route';
          else if(sk.indexOf('节点编号不存在')>=0) cls='bad_node';
          else if(sk.indexOf('失效节点')>=0||sk.indexOf('真死')>=0) cls='TREE_STALE_NO_PENALTY';   // 设计明确不罚
          if(cls==='TREE_STALE_NO_PENALTY'){ legalExcluded+=dG; }
          else if(cls){ legalPen+=dG; legalByCls[cls]=(legalByCls[cls]||0)+dG; legalNow-=dG; }   // ⭐ 逐帧计
          else { legalUnknown+=dG; }   // 分不出类 ⇒ 不罚、但计数
        } }
      if(o.aim===1) aimFrames++;

      if(o.wep&&typeof o.wep.fired==='number'){ if(wepFirst===null)wepFirst=o.wep.fired; else if(o.wep.fired>prevWepFired){ rbWepInc+=(o.wep.fired-prevWepFired); spawnedNow=o.wep.fired-prevWepFired; } else if(o.wep.fired<prevWepFired) rbWepDec+=(prevWepFired-o.wep.fired); wepLast=o.wep.fired; prevWepFired=o.wep.fired; if(typeof o.wep.num==='number') rbNumLast=o.wep.num; }
      // ⭐ 命中口径=【推断】对手 oppTok 的 alive 位（每对手 15 维、位 7）1→0（详见文档§十一）
      const oppArr=(o.opp||[]); const aliveNow=[]; for(let q=0;q*15+7<oppArr.length;q++) aliveNow.push((oppArr[q*15+7]|0)>0?1:0);
      // ⭐ 删除「alive 位 1→0」的 hit 推断（主人第 9 条：会把毒雾杀也算成我杀的）⇒ 改用 TANK_KILLED 事件
      prevAlive=aliveNow;   // ⭐ 真发射数（_bulletsFired）
      if(o.opName){ if(String(o.opName).indexOf('+fire')>=0){ opBFireFrames++; rbOpBFire++; } if(String(o.opName).charAt(0)==='B') opBFrames++; else if(String(o.opName)!=='') opOtherFrames++; }
      if(o.stats&&o.stats.lastTargetId!==null&&o.stats.lastTargetId!==undefined){ if(prevTargetId===null){}else if(o.stats.lastTargetId===prevTargetId) targetSameFrames++; else targetChangedFrames++; prevTargetId=o.stats.lastTargetId; }
      if(o.stats&&o.stats.lastFirePick&&o.cur){ if(o.cur.id===o.stats.lastFirePick.nodeId) lastPickSameCursor++; else lastPickCursorChanged++; }   // ⭐ 诊断：上一帧射击帧的依据游标是否还在
      if(o.nSlots===-1) slotsNullFrames++;   // ⭐ pendingSlots 空 ⟹ 桥必然 no-output
      const N=(o.n||[]).length;
      if(N<1){ skippedNoTree++; await m.pump(1,{yieldMs:0}); continue; }   // ⭐ 空树帧（回合间隙）不进数据
      // ⭐ D11：动作空间已改为 [1,N)（移除 no-op）⇒ **N<2 时没有合法动作**，不该叫服务端
      if(N<2){ skipNoAction++; await m.pump(1,{yieldMs:0}); continue; }
      const bRows=(o.b&&o.b.length)?o.b:[[0,0,0,0,0,0,0]];   // ⭐ 没子弹时不能发 []（服务端要求二维）
      // ⭐⭐ 两端同口径（2026-10-17）：发给服务端的段 = 落进 buffer 的段（node/opp/bullet/item/global）
      //     ⛔ 少了 opp/item ⟹ 服务端看到的是补零、训练器看到真实值 ⟹ 两套输入分布（ratio 必爆）
      const oppR=oppRows(o), itemR=itemRows(o);
      // ⭐⭐ A 相：先问服务端「在可生长节点里选 1 个」（D11：没候选就不调）
      let growUid=null, lpGrow=null, growOkList=o.growOk||null, growOkN=o.growOkCount||0;   // ⭐ 在 step() 回包顶层
      if(GROW_SRC==='server' && growOkN>0 && growOkList){
        const pa=await ask(srv,{N:N,seed:(ep*100000+f+7)%2147483647,mem_on:memOn,phase:'A',round_id:ep,grow_ok:growOkList,segs:{node:o.n,opp:oppR,bullet:bRows,item:itemR,global:[o.g]}});
        if(pa && pa.grow && typeof pa.grow.grow_nodeId==='number'){ const rw=pa.grow.grow_nodeId; if(o.n[rw]) growUid=o.n[rw][0]|0; lpGrow=pa.grow.lp_grow; await m.eval('window.__b.growRow='+rw); aReqOk++; growEntSee=(pa.grow.ent_grow!==undefined?pa.grow.ent_grow:growEntSee); }
        else { aReqBad++; await m.eval('window.__b.growRow=null'); }
      } else { aSkipNoCand++; await m.eval('window.__b.growRow=null'); }   // GROW_SRC=bridge 或无候选 ⇒ 桥回退到 B 目标叶
      const p=await ask(srv,{N:N,seed:ep*100000+f,mem_on:memOn,phase:'B',round_id:ep,segs:{node:o.n,opp:oppR,bullet:bRows,item:itemR,global:[o.g]}});
      lpTot++; const lpOkF=(typeof p.lp==='number'&&isFinite(p.lp)); if(lpOkF)lpOk++;
      if(!lpOkF){ badLp++; if(badLp<=3) console.log('BAD_LP ep='+ep+' f='+f+' lp='+p.lp+' err='+(p.err||'')); await m.pump(1,{yieldMs:0}); continue; }   // ⭐ 非有限 lp ⟹ 该帧不进数据（⛔ 不许静默写 0）
      if(p.err){ if(!global.__errSeen)global.__errSeen={}; if(!global.__errSeen[p.err]){global.__errSeen[p.err]=0; console.log('SRV_ERR '+p.err);} global.__errSeen[p.err]=(global.__errSeen[p.err]||0)+1; }
      if(typeof p.nodeId==='number'){ if(p.nodeId>=N||p.nodeId<0)oob++; nodeId=p.nodeId; }
      if(growUid!==null) growUidCnt++;
      if(typeof p.fire_ent==='number') fireEntSee=p.fire_ent;
      if(typeof p.lp_fire==='number') fireLpCnt++;
      if(p.mem_echo && memEcho.length<MEM_ECHO_MAX) memEcho.push({f:f,N:N,mem:p.mem_echo});   // ⭐ 对拍用：服务端每帧到底喂了什么
      if(typeof p.nodeId==='number') nodeIdSet.add(p.nodeId);   // ⭐ 父代理判据：distinct nodeId（每局去重计数）
      // ⭐ 开火接线：服务端 fire（out[1]）⟹ 本帧 wantFire ⟹ build() 拼 picks[1] 射击帧
      //    `VT_FIRE_FORCE=0` = A/B 基线（完全不发射击帧）；不设 = 用服务端的 fire
      const FORCE=(process.env.VT_FIRE_FORCE===''||process.env.VT_FIRE_FORCE===undefined)?null:(+process.env.VT_FIRE_FORCE);
      const fire=(FORCE===null)?((p.fire===1)?1:0):FORCE;
      await m.eval('window.__b.setFire('+fire+')');
      if(fire===1) firedFrames++;
      const proj=(await m.snapshot()).projectiles||[];
      const nProj=proj.length; if(nProj>totalProj)totalProj=nProj;
      const hasVBullet=proj.some(x=>String(x.owner)==='vantage_1');
      const vCount=proj.filter(x=>String(x.owner)==='vantage_1').length;
      if(vCount>prevVCount){ spawnFrames++; if(lastFire===1) fire1ThenSpawn++; }   // ⭐ 上一帧要了开火 ⟹ 本帧真冒出新子弹
      prevVCount=vCount; lastFire=fire;
      if(hasVBullet){ vFire++; rbVBullet++; }
      if(fire===1&&hasVBullet) fireAndBullet++;
      if(fire===0&&hasVBullet) noFireButBullet++;   // ⚠️ 反向不符：没要开火却有我方子弹（前几帧的弹还在飞）
      const nid=(typeof p.nodeId==='number'?p.nodeId:0);
      const curPick=o.cur||null;
      const picksRec=[{nodeId:nid,back:0}];
      if(fire===1&&curPick){ picksRec.push({nodeId:curPick.id,back:(FIRE_BACK==='now')?Math.max(0,curPick.L-1-curPick.rel):0}); }   // ⭐ picks[1]=射击帧（意图记录；真提交/被接受另用 stats 差分核对）
      frames.push({t:f,N:N,
        obs:{node:o.n,opp:oppR,bullet:pad(bRows,BUL_SLOTS,7),item:itemR,global:[o.g]},
        act:{nodeId:(typeof p.nodeId==='number'?p.nodeId:0),fire:fire,picks:picksRec,
             grow:(growUid===null?null:{nodeId:growUid,lp_grow:lpGrow}),
             lp_fire:(typeof p.lp_fire==='number'?p.lp_fire:null), fire_ent:(typeof p.fire_ent==='number'?p.fire_ent:null),
             fire_frames:(picksRec.length>1?picksRec.slice(1):[])},   // ⭐ 射击帧清单（桥真提交的）   // ⭐ ⭐ A 相动作（uid + 采样时的 lp_grow）
        lp:(lpOkF?p.lp:0),v:(typeof p.v==='number'&&isFinite(p.v)?p.v:0),
        r:{total:0.01,result:0,survive:0.01,legal:0,spawn:spawnedNow,hit:hitNow,aim:(o.aim|0),
           kill:rKill,selfkill:rSelfkill,death:rDeath,kill_storm:rKillStorm,death_storm:rDeathStorm,win:0,lose:0,legal:legalNow,   // ⭐ win/lose/legal 只在〈本局末帧〉写（本局结果/本局累计重罚）
           crate:0,draw:0,empty_fire:((o.ammo!==null&&o.ammo!==undefined&&o.ammo<=0&&o.queueLen!==null&&!(o.queueLen>0)&&o.wantFire)?1:0)},done:false});   // ⭐ 奖惩 v2   // ⭐ (B-2) aim   // ⭐ (B) 真发射/命中两项
      await m.pump(1,{yieldMs:0});
    }
    const re2=JSON.parse(await m.eval('JSON.stringify(window.__b.stats())'));
    buildOKEnd=re2.buildOK||0; buildMissEnd=re2.buildMisses||0; fireNoCursorEnd=re2.fireNoCursor||0; if(re2.fireErr) fireErrSeen=String(re2.fireErr);   // ⭐ 本轮终点
    const dSubmit=(re2.fireSubmits||0)-(rb.fireSubmits||0), dExtra=(re2.pickExtras||0)-(rb.pickExtras||0), dGiveUp=(re2.giveUpB||0)-(rb.giveUpB||0);
    picks1Submitted+=dSubmit; pickExtras+=dExtra; giveUpB+=dGiveUp;
    const _nc1=await m.eval("(()=>{try{var t=VantageTree.getTree();return t?t.nodeCount:null}catch(e){return null}})()");
    roundFire.push({ep:ep,nodeStart:_nc0,nodeEnd:_nc1,nodeDelta:(_nc0!==null&&_nc1!==null)?(_nc1-_nc0):null,frames:frames.length,fired:firedFrames-firedBase,submitted:dSubmit,accepted:dExtra,giveUpB:dGiveUp,
      opBFire:rbOpBFire, aimFrames:aimFrames, distinctNodeIds:nodeIdSet.size, wepShotsByInc:rbWepInc, wepReloadDec:rbWepDec, wepNumCap:rbNumLast, wepFiredDelta:(wepFirst!==null&&wepLast!==null)?(wepLast-wepFirst):null, wepFirst:wepFirst, wepLast:wepLast,
      vBulletSpawn:spawnFrames-spawnBase, vBulletFramesInRound:rbVBullet,
      lpFinite:(lpOk-lpBase)+'/'+(lpTot-lpTotBase), oob:oob-oobBase, win:won});   // ⭐ 逐局三数对账：_bulletsFired 增量 / opBFire / 新子弹帧
    if(!done){ truncated++; }
    if(frames.length && !done){
      // ⭐⭐ (A)1 截断局：末帧 done 写【真值】(false)，并补 v_next = 【下一帧】服务端返回的 v
      try{
        const o2=JSON.parse(await m.eval('window.__b.step('+nodeId+',0)'));
        if(o2 && !o2.err && (o2.n||[]).length>=1){
          const N2=o2.n.length, b2=(o2.b&&o2.b.length)?o2.b:[[0,0,0,0,0,0,0]];
          const p2=await ask(srv,{N:N2,seed:(ep*100000+999983)%2147483647,segs:{node:o2.n,opp:oppRows(o2),bullet:b2,item:itemRows(o2),global:[o2.g]}});
          if(typeof p2.v==='number'&&isFinite(p2.v)){ frames[frames.length-1].v_next=p2.v; vNextOk++; }
          else { vNextFail++; console.log('V_NEXT_FAIL ep='+ep+' v='+p2.v+' err='+(p2.err||'')); }
        } else { vNextFail++; }
      }catch(eVN){ vNextFail++; }
    }
    { if(frames.length){ const lf=frames[frames.length-1]; lf.r.win=(won===1?1:0); lf.r.lose=(won===0?1:0); } legalPenBase=legalPen; }   // ⭐ legal 已逐帧写，此处只写 win/lose
    if(frames.length){ const last=frames[frames.length-1]; last.done=(done===true); last.r.result=(won===null?0:(won===1?1:(won===-1?-0.25:-1))); last.r.total=last.r.result+(last.r.survive||0); }   // ⭐ 存活尺度 1.0→0.01：回报 O(1~5)
    { const _mz=await m.maze(); const _epObj={ep:ep,scene:{players:2,mapW:_mz.width,mapH:_mz.height,storm:false,crates:[]},frames:frames,win:won};
      if(memEcho.length) { _epObj.mem_echo=memEcho; memEcho=[]; }   // ⭐ 对拍回声随第一局落盘
      fs.writeSync(epFd,JSON.stringify(_epObj) + String.fromCharCode(10)); /*
');
*/      episodes.push({ep:ep,win:won}); wins.push(won); totalFrames+=frames.length; frames.length=0; }
    totalFrames+=frames.length;
    // 每局复位：重开一局（原版会自动开新回合）
  }
  const _fin=JSON.parse(await m.eval('JSON.stringify(window.__b.stats())'));
  const _ifc=JSON.parse(await m.eval('JSON.stringify(window.__vantageIface||{})'));   // ⭐ A 相被接受数 = _ifaceStats.growAt
   // ⭐ 脉冲开火计数（父代理要求单独上报）
  const summary={rounds:episodes.length, fireSubmitsTotal:_fin.fireSubmits||0,
    aCalls:_fin.aCalls||0, aReqOk, aReqBad, aSkipNoCand, growEntSee, fireEntSee, fireLpCnt, skipNoAction, aGrowServer:_fin.aGrowServer||0, aServerReject:_fin.aServerReject||0, growOkCountEnd:_fin.growOkCount||0, aGrow:_fin.aGrow||0, aNotGrowable:_fin.aNotGrowable||0, aTreeFull:_fin.aTreeFull||0, growRejectMissing:_fin.growRejectMissing||0, growRejectNotGrowable:_fin.growRejectNotGrowable||0, growStillValid:_fin.growStillValid||0, growChkErr:_fin.growChkErr||null, aNotLeaf:_fin.aNotLeaf||0, aNoSlots:_fin.aNoSlots||0, aErr:_fin.aErr||null,
    agAccepted:(_ifc.growAt||0), giveUpA:(_ifc.giveUpA||0), callsA:(_ifc.callsA||0), callsB:(_ifc.callsB||0), nodeCountEnd:_fin.nodeCount,
    bPicks:(_ifc.picks||0), pulseBlocked:_fin.pulseBlocked||0, pulseBlockedByPrev:_fin.pulseBlockedByPrev||0, pulseBlockedBySelfFire:_fin.pulseBlockedBySelfFire||0,totalFrames,totalProj,vFire,truncated,lpOk,lpTot,oob,skippedNoTree,badLp,oppRowsMax:oppSeen.max,oppOver:oppSeen.over,
    fireMode:FIRE_BACK, fire1Frames:firedFrames, vBulletFrames:vFire, fire1AndBulletFrames:fireAndBullet, noFireButBulletFrames:noFireButBullet,
    vBulletSpawnFrames:spawnFrames, fire1ThenSpawnFrames:fire1ThenSpawn, subFireFrames:subFireFrames, lastPickSameCursor:lastPickSameCursor, lastPickCursorChanged:lastPickCursorChanged, targetChangedFrames:targetChangedFrames, targetSameFrames:targetSameFrames, opBFrames:opBFrames, opBFireFrames:opBFireFrames, opOtherFrames:opOtherFrames, desiredFireFrames:desiredFireFrames, desiredErr:desiredErrSeen, slotsNullFrames:slotsNullFrames, vNextOk:vNextOk, vNextFail:vNextFail, buildOK:buildOKEnd, buildMisses:buildMissEnd, fireNoCursor:fireNoCursorEnd, fireErr:fireErrSeen,
    aimFramesTotal:aimFrames, growFramesWithAction:growUidCnt, distinctNodeIdsTotal:nodeIdSet.size, emptyIntentFrames, legalPen, legalExcluded, legalUnknown, legalByCls, emptyBlocked:(_fin.emptyBlocked||0), deathSubErr:(_fin.deathSubErr||null), picks1Submitted, pickExtrasAccepted:pickExtras, giveUpB, skipReasons:skipReasons, aReasons:aReasons, roundFire:roundFire, win:wins};
  fs.closeSync(epFd);   // ⭐ episodes.jsonl 已逐局写入
  fs.writeFileSync(OUT+'summary.json',JSON.stringify(summary,null,2));
  console.log('SUMMARY '+JSON.stringify(summary));
  await m.close(); srv.kill();
})().catch(e=>{console.log('FATAL '+((e&&e.stack)||e));process.exit(1)});
