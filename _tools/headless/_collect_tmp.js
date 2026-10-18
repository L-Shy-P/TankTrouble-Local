// 最小采集器（父代理 2026-10-17 夜）：2 人局 Vantage vs Laika → 逐帧记录 → 每局一行 JSON 喂训练器
const fs=require('fs');const {spawn}=require('child_process');const {Match}=require('./match');
const SRC=fs.readFileSync(__dirname+'/inject_fire.js','utf8');
// ⭐ v202：树形指标源码（一处定义、多处只调它 —— ⛔ 不每帧重新拼）
const SHAPE_SRC=`(function(){try{var t=VantageTree.getTree();if(!t||!t.root)return null;
  var nI=0,nL=0,mD=0,dh={},kh={},hg=0,fi=0,fb=0;
  (function rec(n,d){if(!n)return;if(d>mD)mD=d;dh[d]=(dh[d]||0)+1;var ks=n.children||[];
    if(ks.length){nI++;kh[ks.length]=(kh[ks.length]||0)+1;}else nL++;
    if(n.hasGrown===true)hg++;if(n.forkInsert)fi++;if(n.forkBranch)fb++;
    for(var i=0;i<ks.length;i++)rec(ks[i],d+1);})(t.root,0);
  var n9=kh[9]||0;return {nodeCount:t.nodeCount,internal:nI,leaves:nL,maxDepth:mD,depthHist:dh,kidHist:kh,
    full9Pct:(nI?Math.round(n9*1000/nI)/10:null),hasGrownTrue:hg,forkInserted:fi,forkBranch:fb};}catch(e){return {err:String(e&&e.message||e)}}})()`;
// ⭐ m.eval 走 CDP by-value ⟹ 直接回对象；两种都容忍（⛔ 不许因解析失败静默丢数）
const _J=(v)=>{ if(v===null||v===undefined) return {}; if(typeof v==='string'){ try{return JSON.parse(v);}catch(eJ){return {raw:String(v).slice(0,200)};} } return v; };
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
var itemOver=0, bulletOver=0;   // ⭐ 超容量显式计数（⏔t 静默丢弃）
function itemRows(o){
  var col=(o&&o.col)||[], mine=(o&&o.mine)||[], out=[];
  if(col.length>24||mine.length>24) itemOver++;   // 超 8 件×3 字段
  for(var k=0;k<8;k++){
    var c=col.slice(k*3,k*3+3), m=mine.slice(k*3,k*3+3);
    while(c.length<3)c.push(0); while(m.length<3)m.push(0);
    out.push([+c[0]||0,+c[1]||0,+c[2]||0,+m[0]||0,+m[1]||0,+m[2]||0]);
  }
  return out;
}
function pad(rows,slot,w){ if(rows.length>slot) bulletOver++;   // ⭐ 子弹超 64 显式计数
  if(rows.length>=slot) return rows.slice(0,slot); const out=rows.slice(); const z=new Array(w).fill(0); while(out.length<slot) out.push(z.slice()); return out; }
// ⭐ 一问一答（行队列版，2026-10-17 修）：原 `stdout.once('data')` 会把"一个 chunk 里的多行"（开机 6 行日志）当一条
//    ⟹ 前几帧解析失败 + 首帧串包（实测 max|Δlp|=2.13）。这里按 `\n` 切行排队；开机必须先吃掉到 WARMUP_SAMPLE。
let _buf='', _q=[], _wait=[];
function _pumpLine(ln){ if(!String(ln).trim())return; if(_wait.length)_wait.shift()(ln); else _q.push(ln); }
// ⭐ v202：加一个**看门狗**——服务端不回行时**响亮失败**（⛔ 不许挂死不报；实测同机多份重活时会挂起）
function _nextLine(){ if(_q.length) return Promise.resolve(_q.shift());
  return new Promise((res,rej)=>{ var done=false; var t=setTimeout(()=>{ if(done)return; done=true; rej(new Error('SRV_TIMEOUT: 300s 内没有读到服务端回行（同机资源抢占 / 服务端已死）')); }, 300000);
    _wait.push(function(ln){ if(done)return; done=true; clearTimeout(t); res(ln); }); }); }
function ask(srv,o){ srv.stdin.write(JSON.stringify(o)+'\n'); return _nextLine().then(t=>{ try{return JSON.parse(String(t).trim())}catch(e){return {lp:null,err:'parse',raw:String(t).slice(0,160)}} }); }
async function waitBoot(){ for(let i=0;i<40;i++){ const ln=await _nextLine(); if(String(ln).indexOf('WARMUP_SAMPLE')>=0) return i+1; } throw new Error('开机 40 行里没出现 WARMUP_SAMPLE'); }
const SCORE_SRC="(()=>{var gc=GameManager.getGameController();var out={state:gc?gc.getState():null,scores:{}};try{var ss=gc.getScores();for(var k in ss){var s=ss[k];var pid=s.getPlayerId?s.getPlayerId():s.playerId;var t=s.getType?s.getType():s.type;var v=s.getValue?s.getValue():s.value;out.scores[pid+':'+t]=v;}}catch(e){out.err=String(e&&e.message||e);}return out})()";
(async()=>{
  fs.mkdirSync(OUT,{recursive:true});
  const srv=spawn('py',['-3.13','_tools/training/policy_server_graph.py'],{env:{...process.env,PYTHONIOENCODING:'utf-8'}});
  srv.stderr.on('data',d=>{ const t=String(d); if(t.indexOf('CKPT_')>=0 || t.indexOf('MEM_STATE')>=0 || t.indexOf('NET_SPLIT')>=0 || t.indexOf('SRV_CAND')>=0) console.log('SRV_CKPT '+t.trim().slice(0,120)); });
  srv.stdout.setEncoding('utf8');
  srv.stdout.on('data',d=>{ _buf+=String(d); let i; while((i=_buf.indexOf('\n'))>=0){ const ln=_buf.slice(0,i); _buf=_buf.slice(i+1); _pumpLine(ln); } });
  // ⭐⭐⭐ 父代理 2026-10-18：**采集环境必须与评测同构**，否则训练数据里没有胜负信号。
  //   实测：老口径 `{aiCount:1,vantCount:1}` 跑 8725 帧(175s) ⟹ kill=0 selfkill=0 death=0 ⟹ 回合永不完结
  //        ⟹ `win/lose` 只在末帧写 ⟹ **策略永远学不到"想赢"**（也解释了"非零奖励帧 0.5%"）。
  //   而评测口径 `{players:2,storm,crates}` 下 303~2603 帧就会 victory/defeat。
  //   ⟹ `C_PLAYERS=2`（推荐）走评测同构开局；不给则保持老口径（兼容）。
  const m=new Match();
  const _CP=+(process.env.C_PLAYERS||0);
  const _op = _CP ? {humanIds:[], players:_CP, storm:!!+(process.env.C_STORM||0),
                      crates:(function(){var v=process.env.C_CRATES; if(v===undefined||v==='')return null; if(v==='1')return true; if(v==='0')return false; try{return JSON.parse(v);}catch(e){return null;}})(),
                      epoch:(process.env.C_EPOCH?Number(process.env.C_EPOCH):undefined), control:false}
                  : {humanIds:[],aiCount:1,vantCount:1,control:false};
  // ⭐ 与评测同构的地图 RNG：`C_MAZE_SEED=<scene.seed>` ⟹ 用与 run_scenes_30.js 相同的 LCG 序列
  //   （评测 mazeSeed = scene.seed*100003+7，序列长 150000，见 run_scenes_30.js:199-202）
  const _CMS=+(process.env.C_MAZE_SEED||0);
  if (_CMS>0) {
    const _ms=((_CMS*100003)+7)>>>0; let _s=_ms||1; const _n=150000; const _seq=new Array(_n);
    for (var _i=0;_i<_n;_i++){ _s=(Math.imul(_s,1664525)+1013904223)>>>0; _seq[_i]=_s/4294967296; }
    _op.rngSeq=_seq;
    console.log('MAZE_RNG seed='+_CMS+' mazeSeed='+_ms+' len='+_n);
  }
  console.log('OPEN_MODE '+(_CP?('players='+_CP+' storm='+(+process.env.C_STORM||0)+' crates='+(process.env.C_CRATES||'')):'legacy aiCount=1 vantCount=1'));
  const op=await m.open(_op);
  console.log('SRV_BOOT_LINES '+await waitBoot());   // ⭐ 必须先吃完开机行（否则前几帧串包）
  console.log('OPEN '+JSON.stringify({ai:op.aiIds,vant:op.vantageIds}));
  await m.eval(SRC); console.log('SETUP '+await m.eval('window.__probe.setup()'));

  // ⭐ 开火接线（2026-10-17 派单③）：服务端返回的 fire 决定本帧要不要拼 picks[1] 射击帧
  const FIRE_BACK=process.env.VT_FIRE_BACK||'now';
  const MEM_ENV=(process.env.VT_MEM_ON==='1');
  const GROW_SRC=(process.env.VT_GROW_SRC||'server');
  const PULSE_BLOCK=(process.env.VT_PULSE_BLOCK==='1')?1:0;   // ⭐ 默认 0 = 只记录不拦截（权威版：连续帧=按住是设计）   // ⭐ A/B 开关：server=服务端 head_grow 采样；bridge=桥自己取 B 目标叶（Arm A）   // ⭐ 记忆开关：环境可强制开；否则读 window.__vtConfig.mem   // ⭐ 默认 now = back=L−1−rel（2026-10-17 裁定 (a)：当帧开火）
  await m.eval('window.__b.pulseBlock='+PULSE_BLOCK+';'); if(process.env.VT_FIRE_FIRST==='1') await m.eval('window.__b.fireFirst=1;'); if(process.env.VT_PROBE_DZ==='1') await m.eval('window.__b.probeDzOn=1;'); if(process.env.VT_PROBE_MATCH==='1') await m.eval('window.__b.probeMatchOn=1;');
  if(process.env.VT_PROBE_GATE==='1') await m.eval('window.__b.probeGateOn=1;'); if(process.env.VT_PROBE_MDBG==='1') await m.eval('window.__b.probeMatchDbgOn=1;');
  if((process.env.VT_FIRE_MODE||'')==='mask') await m.eval("window.__b.fireMode='mask';");
  if(process.env.VT_FIRE_ROOT) console.log('FIRE_ROOT '+await m.eval('window.__b.setFireRoot('+(+process.env.VT_FIRE_ROOT||0)+')'));
  if(process.env.VT_FIRE_SINGLE) console.log('FIRE_SINGLE '+await m.eval('window.__b.setFireSingle('+(+process.env.VT_FIRE_SINGLE||0)+')'));
  if(process.env.VT_AIM_GATE) console.log('AIM_GATE '+await m.eval('window.__b.setAimGate('+(+process.env.VT_AIM_GATE||0)+')'));
  if(process.env.VT_HOLD_TARGET) console.log('HOLD_TARGET '+await m.eval('window.__b.setHoldTarget('+(+process.env.VT_HOLD_TARGET||0)+')'));
  if(process.env.VT_FIRE_HACK==='1') await m.eval('window.__b.fireHack=1;'); console.log('PULSE_BLOCK '+PULSE_BLOCK);
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
  let fireSelN=0, fireEnts=[];
  let skipNoAction=0;
  let fbSum=0, fbN=0, fb1=0, fb24=0, fb5=0;
  let execPolN=0;
  let fireForced=0, fireEpsN=0, firePN=0, fireTot=0;
  let routeNN=0, fireNZ=0, routeTot=0;
  let stillN=0, stillTot=0;   // ⭐ 静止帧计数   // ⭐ 强制/探索/火头 fire_p 统计   // ⭐ 真由策略执行的帧数
  let factLoggedOk=0, factLoggedRej=0, planCnt=0;   // ⭐ fireBacksPerSubmit 直方图   // ⭐ N<2 无合法动作（no-op 已移出）   // ⭐ head_fire 采样参数   // ⭐ A 相：请求成功/失败/无候选
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
  const backHist={};   // ⭐ v202：A 相 `back`（反向相对帧）取值直方图 —— 验收「唯一值数 > 1」
  const shapeTimeline=[];   // ⭐ v202：每 200 帧一次的树形时间线（回合末树被重置也能留证据）
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
      if(f%100===0) console.log('HEART ep='+ep+' f='+f+' nodeId='+nodeId);
      if(f>0 && f%200===0){ const sh=_J(await m.eval(SHAPE_SRC)); if(sh && !sh.err && sh.nodeCount>1){ sh.f=f; shapeTimeline.push(sh); } }
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
      // ⭐⭐ v202（2026-10-18 主人更正语义）：帧地址 = (子节点ID, **反向相对帧**) ⟹
      //   服务端采样 `nodeId`（head_grow）之后，这里再在 `[growKMin, growKMax]` 上**均匀采样 `back`**。
      //   ⛔ 服务端在 `_tools/training/`（不许改）⟹ 采样落在采集侧；⛔ 不急着加新网络头。
      let growBack=0, growKMin=-1, growKMax=-1;
      if(GROW_SRC==='server' && growOkN>0 && growOkList){
        const pa=await ask(srv,{N:N,seed:(ep*100000+f+7)%2147483647,mem_on:memOn,phase:'A',round_id:ep,grow_ok:growOkList,segs:{node:o.n,opp:oppR,bullet:bRows,item:itemR,global:[o.g]}});
        if(pa && pa.grow && typeof pa.grow.grow_nodeId==='number'){ const rw=pa.grow.grow_nodeId; if(o.n[rw]) growUid=o.n[rw][0]|0; lpGrow=pa.grow.lp_grow;
          growKMin=(o.growKMin&&typeof o.growKMin[rw]==='number')?o.growKMin[rw]:-1;
          growKMax=(o.growKMax&&typeof o.growKMax[rw]==='number')?o.growKMax[rw]:-1;
          if(growKMax>=growKMin && growKMin>=0) growBack=growKMin+Math.floor(Math.random()*((growKMax-growKMin)+1));
          backHist[growBack]=(backHist[growBack]||0)+1;
          await m.eval('window.__b.growRow='+rw+';window.__b.growBack='+growBack+';'); aReqOk++; growEntSee=(pa.grow.ent_grow!==undefined?pa.grow.ent_grow:growEntSee); }
        else { aReqBad++; await m.eval('window.__b.growRow=null'); }
      } else { aSkipNoCand++; await m.eval('window.__b.growRow=null'); }   // GROW_SRC=bridge 或无候选 ⇒ 桥回退到 B 目标叶
      if(o.probeDz) console.log('DZ_PROBE '+JSON.stringify(o.probeDz));
      if(o.probeMatch) console.log('MATCH_PROBE '+JSON.stringify(o.probeMatch));
      if(o.probeGate) console.log('GATE_PROBE '+JSON.stringify(o.probeGate));
      if(o.matchDbg) console.log('MATCHDBG '+JSON.stringify(o.matchDbg));
      const _lpF=(o.stats&&o.stats.lastFirePick)||null;
      if(o.growFact&&!factLoggedOk&&o.growFact.result==='ok'){ factLoggedOk=1; console.log('FACT_OK '+JSON.stringify(o.growFact)+' plan='+JSON.stringify(o.plan)); }
      if(o.growFact&&!factLoggedRej&&o.growFact.result==='reject'){ factLoggedRej=1; console.log('FACT_REJECT '+JSON.stringify(o.growFact)+' plan='+JSON.stringify(o.plan)); }
      if(Array.isArray(o.plan)) planCnt++;
      if(o.execByPolicy===true) execPolN++;
      if(o.execStill===true) stillN++;
      if(o.execStill!==null&&o.execStill!==undefined) stillTot++;
      if(o.matchDbg&&o.matchDbg.agentRouteId_stats!==undefined&&o.matchDbg.agentRouteId_stats!==null) routeNN++;
      if(o.matchDbg&&o.matchDbg.agentFirePicksLen_stats>0) fireNZ++;
      if(o.matchDbg) routeTot++;
      const fireCand=(_lpF&&Array.isArray(_lpF.backs))?_lpF.backs.map(function(bk){return {nodeId:_lpF.nodeId,back:bk};}):[];   // ⭐ 本段可执行帧
      const p=await ask(srv,{N:N,seed:ep*100000+f,mem_on:memOn,phase:'B',round_id:ep,fire_cand:fireCand,segs:{node:o.n,opp:oppR,bullet:bRows,item:itemR,global:[o.g]}});
      lpTot++; const lpOkF=(typeof p.lp==='number'&&isFinite(p.lp)); if(lpOkF)lpOk++;
      if(!lpOkF){ badLp++; if(badLp<=3) console.log('BAD_LP ep='+ep+' f='+f+' lp='+p.lp+' err='+(p.err||'')); await m.pump(1,{yieldMs:0}); continue; }   // ⭐ 非有限 lp ⟹ 该帧不进数据（⛔ 不许静默写 0）
      if(p.err){ if(!global.__errSeen)global.__errSeen={}; if(!global.__errSeen[p.err]){global.__errSeen[p.err]=0; console.log('SRV_ERR '+p.err);} global.__errSeen[p.err]=(global.__errSeen[p.err]||0)+1; }
      if(typeof p.nodeId==='number'){ if(p.nodeId>=N||p.nodeId<0)oob++; nodeId=p.nodeId; }
      if(growUid!==null) growUidCnt++;
      if(Array.isArray(o.plan)) planCnt++;
      if(o.growFact&&!factLoggedOk&&o.growFact.result==='ok'){ factLoggedOk=1; console.log('FACT_OK '+JSON.stringify(o.growFact)+' plan='+JSON.stringify(o.plan)); }
      if(o.growFact&&!factLoggedRej&&o.growFact.result==='reject'){ factLoggedRej=1; console.log('FACT_REJECT '+JSON.stringify(o.growFact)+' plan='+JSON.stringify(o.plan)); }
      if(typeof p.fire_ent==='number') fireEntSee=p.fire_ent;
      if(typeof p.lp_fire==='number') fireLpCnt++;
      if(p.mem_echo && memEcho.length<MEM_ECHO_MAX) memEcho.push({f:f,N:N,mem:p.mem_echo});   // ⭐ 对拍用：服务端每帧到底喂了什么
      if(typeof p.nodeId==='number') nodeIdSet.add(p.nodeId);   // ⭐ 父代理判据：distinct nodeId（每局去重计数）
      // ⭐ 开火接线：服务端 fire（out[1]）⟹ 本帧 wantFire ⟹ build() 拼 picks[1] 射击帧
      //    `VT_FIRE_FORCE=0` = A/B 基线（完全不发射击帧）；不设 = 用服务端的 fire
      const FORCE=(process.env.VT_FIRE_FORCE===''||process.env.VT_FIRE_FORCE===undefined)?null:(+process.env.VT_FIRE_FORCE);
      await m.eval('window.__b.fireWantedLast='+((p.fire===1)?'1':'0'));
      if(p.fire_sel && Array.isArray(p.fire_sel.fire_frames)){ await m.eval('window.__b.fireFramesFromServer='+JSON.stringify(p.fire_sel.fire_frames)); fireSelN++; if(typeof p.fire_sel.fire_ent==='number') fireEnts.push(p.fire_sel.fire_ent); }
      else { await m.eval('window.__b.fireFramesFromServer=null'); }
      let fire=(FORCE===null)?((p.fire===1)?1:0):FORCE;
      // ⭐⭐ 探针/探索：VT_FORCE_FIRE=1 无条件强制；VT_FIRE_EPS=ε 每帧以ε概率强制（给火头探索信号）
      const _eps=parseFloat(process.env.VT_FIRE_EPS||'0');
      if(process.env.VT_FORCE_FIRE==='1'){ fire=1; fireForced++; } else if(_eps>0 && Math.random()<_eps && fire===0){ fire=1; fireEpsN++; }
      firePN += (p.fire===1?1:0); fireTot++;
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
      { const _nb=picksRec.length-1; if(_nb>0){ fbSum+=_nb; fbN++; if(_nb===1) fb1++; else if(_nb<=4) fb24++; else fb5++; } }   // ⭐ 每次提交拼了几个 back
      frames.push({t:f,N:N,
        obs:{node:o.n,opp:oppR,bullet:pad(bRows,BUL_SLOTS,7),item:itemR,global:[o.g]},
        execByPolicy:(o.execByPolicy===true), execStill:(o.execStill===true),   // ⭐ 「静止」判据：本帧执行的 inputs 全 false
   // ⭐ Phase1 数据保险：本帧执行源是否策略
        plan:(Array.isArray(o.plan)?o.plan:null),   // ⭐ 事实直传：plan 段承载「A 长了哪个/结果」
        act:{nodeId:(typeof p.nodeId==='number'?p.nodeId:0),fire:fire,picks:picksRec,
             grow:(growUid===null?null:{nodeId:growUid,back:growBack,kMin:growKMin,kMax:growKMax,lp_grow:lpGrow}),   // ⭐ v202：back = 反向相对帧（帧地址的第二维）
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
        if(o2 && !o2.err && (o2.n||[]).length>=2){   // ⭐ D11：N<2 无合法动作 ⇒ 不能问（否则服务端报错 ⇒ v_next 缺失）
          const N2=o2.n.length, b2=(o2.b&&o2.b.length)?o2.b:[[0,0,0,0,0,0,0]];
          const p2=await ask(srv,{N:N2,seed:(ep*100000+999983)%2147483647,segs:{node:o2.n,opp:oppRows(o2),bullet:b2,item:itemRows(o2),global:[o2.g]}});
          if(typeof p2.v==='number'&&isFinite(p2.v)){ frames[frames.length-1].v_next=p2.v; vNextOk++; }
          else { vNextFail++; console.log('V_NEXT_FAIL ep='+ep+' v='+p2.v+' err='+(p2.err||'')); }
        } else { vNextFail++; if(vNextFail<=3) console.log('V_NEXT_SKIP ep='+ep+' N='+((o2&&o2.n)?o2.n.length:'?')); }
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
  // ⭐ v202 验收：树侧「在某一帧分叉」计数 + 树形指标（全部只读）
  const forkStats=_J(await m.eval(`(function(){try{
    var t=VantageTree.getTree(); if(!t||!t.stats) return {};
    var s=t.stats, ks=['expandForkOk','expandForkFromInternal','expandForkFromLeaf','expandForkLeaf','expandRejectHasGrown','expandRejectBackRange','expandForkReuse','expandForkNewBranches','expandForkReuseDeltaMax','forkInvariantChecks','forkInvariantNodes','forkInvariantMaxDt','forkInvariantMaxDp','forkInvariantLost','forkDepthShifted','forkDepthShiftPlus1','expands'];
    var o={}; for(var i=0;i<ks.length;i++) o[ks[i]]=s[ks[i]];
    o.lastForkInstance=s.lastForkInstance||null; o.growStalls=s.growStalls||null; return o;
  }catch(e){return {err:String(e&&e.message||e)}}})()`));
  const treeShape=_J(await m.eval(SHAPE_SRC));

  // ⭐⭐ v202 验收自测（真实树上直接验三条硬判据）：
  //   ① 插入分叉后【既有节点的 tEndSec / 位姿零变化】（全树前后沙盘 diff）
  //   ④ `hasGrown === true` 的节点上再长 ⟹ 必须被 `expandRejectHasGrown` 拒绝
  //   ② 非叶目标上真的新建了节点（expandForkFromInternal 增量 + 实例）
  let forkSelfTest = null;
  try {
    forkSelfTest = _J(await m.eval(`(function(){try{
      var t=VantageTree.getTree(); if(!t||!t.root) return {err:'noTree'};
      var ad=null; try{ ad=(VantageTree.getLastAdapter?VantageTree.getLastAdapter():null); }catch(eAd){}
      var snap=function(){var m={};(function rec(n){if(!n)return;var tk=(n.simState&&n.simState.tank)?n.simState.tank:null;m[n.id]={t:(typeof n.tEndSec==='number')?n.tEndSec:null,x:tk?tk.x:null,y:tk?tk.y:null,d:(typeof n.depth==='number')?n.depth:null};var ks=n.children||[];for(var i=0;i<ks.length;i++)rec(ks[i]);})(t.root);return m;};
      // ⚠️ 智能体路径要求 tree._agentDecision/_agentDecisionB 在场（agentPathActive）。跑完收尾时它们可能已被清空
      //    ⟹ 这里按"决策缝的同一写法"临时置一个空决策，用完**原样还原**（只影响本次自测，不影响整局数据）。
      var sA=t._agentDecision, sB=t._agentDecisionB, forced=0;
      if(!t._agentDecision && !t._agentDecisionB){ t._agentDecision={picks:[],memory:{}}; forced=1; }
      var st0={hg:t.stats.expandRejectHasGrown||0, ok:t.stats.expandForkOk||0, fi:t.stats.expandForkFromInternal||0, nb:t.stats.expandForkNewBranches||0, br:t.stats.expandRejectBackRange||0, ic:t.stats.forkInvariantChecks||0};
      // ── ④ hasGrown 拒绝：在树里找 hasGrown===true 的节点，直接对它调 expandLeaf ──
      var hgNode=null, hgCount=0;
      (function rec(n){if(!n)return;if(n.hasGrown===true){hgCount++; if(!hgNode)hgNode=n;}var ks=n.children||[];for(var i=0;i<ks.length;i++)rec(ks[i]);})(t.root,0);
      var hgReturn=null, hgDelta=0;
      if(hgNode){ hgReturn=VantageTree.expandLeaf(t,hgNode,ad,t.threats||[],0); hgDelta=(t.stats.expandRejectHasGrown||0)-st0.hg; }
      // ── ①② 非叶段内分叉：挑最浅的、L≥3 的非叶节点，back=3 ⟹ 必须新建节点且既有节点帧号/位姿零变化 ──
      var best=null,bd=1e9;
      (function rec(n,dep){if(!n)return;var ks=n.children||[];var L=(typeof n.validFrames==='number'&&n.validFrames>0)?n.validFrames:0;
        if(n!==t.root&&n.parent&&ks.length&&L>=3&&dep<bd){bd=dep;best=n;}for(var i=0;i<ks.length;i++)rec(ks[i],dep+1);})(t.root,0);
      var preNode=t.nodeCount, before=snap(), forkReturn=null, usedBack=null, L2=null, okDelta=0, fiDelta=0, nbDelta=0;
      if(best){ L2=(typeof best.validFrames==='number'&&best.validFrames>0)?best.validFrames:0;
        usedBack=Math.max(1,Math.min(L2-1,3));
        forkReturn=VantageTree.expandLeaf(t,best,ad,t.threats||[],usedBack);
        okDelta=(t.stats.expandForkOk||0)-st0.ok; fiDelta=(t.stats.expandForkFromInternal||0)-st0.fi; nbDelta=(t.stats.expandForkNewBranches||0)-st0.nb; }
      var after=snap(), lost=0,maxDt=0,maxDp=0,depthChg=0,n2=0,id,diffList=[];
      for(id in before){var b0=before[id],a0=after[id];if(!a0){lost++;continue;}n2++;
        if(b0.t!==null&&a0.t!==null){var dt=Math.abs(a0.t-b0.t);if(dt>maxDt)maxDt=dt;}
        var dpv=0;
        if(b0.x!==null&&a0.x!==null){dpv=Math.max(Math.abs(a0.x-b0.x),Math.abs(a0.y-b0.y));if(dpv>maxDp)maxDp=dpv;}
        if(b0.d!==a0.d)depthChg++;
        if((b0.t!==a0.t)||(dpv>1e-12)||(b0.d!==a0.d)){ if(diffList.length<6) diffList.push({id:+id,dt:+(a0.t-b0.t),dp:+dpv,dB:b0.d,dA:a0.d,xB:+(+b0.x).toFixed(3),xA:+(+a0.x).toFixed(3)}); }}
      // ── 掩码普查：按 kRangeOfNode 数"可生长行"里叶子/非叶各多少（证明非叶真的进候选集）──
      var nGrowLeaf=0,nGrowInternal=0,nNoGrow=0;
      if(window.__b && window.__b.kRangeOfNode){(function rec(n){if(!n)return;var ks=n.children||[];var rg=window.__b.kRangeOfNode(n);
        if(!rg||rg.kMax<rg.kMin) nNoGrow++; else if(ks.length) nGrowInternal++; else nGrowLeaf++;
        for(var i=0;i<ks.length;i++)rec(ks[i]);})(t.root);}
      t._agentDecision=sA; t._agentDecisionB=sB;   // 原样还原
      return {forcedAgentPath:forced, hasGrownNodeCount:hgCount, hasGrownTargetId:(hgNode?hgNode.id:null),
        hasGrownRejectReturn:hgReturn, rejHasGrownDelta:hgDelta,
        targetId:(best?best.id:null), targetL:L2, backUsed:usedBack, forkReturn:forkReturn,
        forkOkDelta:okDelta, fromInternalDelta:fiDelta, newBranchesDelta:nbDelta,
        preNodeCount:preNode, postNodeCount:t.nodeCount,
        checkedNodes:n2, lostNodes:lost, maxDeltaTEndSec:maxDt, maxDeltaPose:maxDp, depthChanged:depthChg, diffSample:diffList,
        adapterPresent:!!ad, lastForkInstance:t.stats.lastForkInstance||null,
        growableLeaves:nGrowLeaf, growableInternals:nGrowInternal, notGrowable:nNoGrow};
    }catch(e){return {err:String(e&&e.message||e)}}})()`));
    console.log('FORK_SELFTEST '+JSON.stringify(forkSelfTest));
  } catch(eFT){ forkSelfTest={err:String(eFT&&eFT.message||eFT)}; console.log('FORK_SELFTEST_ERR '+forkSelfTest.err); }
  const _ifc=JSON.parse(await m.eval('JSON.stringify(window.__vantageIface||{})'));   // ⭐ A 相被接受数 = _ifaceStats.growAt
   // ⭐ 脉冲开火计数（父代理要求单独上报）
  const summary={rounds:episodes.length, fireSubmitsTotal:_fin.fireSubmits||0,
    aCalls:_fin.aCalls||0, aReqOk, aReqBad, aSkipNoCand, growEntSee, fireEntSee, fireLpCnt, fireSelN, fireBacksMean_bridge:(_fin.fbN?_fin.fbSum/_fin.fbN:null), fireBacksBuckets_bridge:{one:_fin.fb1||0, two2four:_fin.fb24||0, fivePlus:_fin.fb5||0}, fireBacksFrames_bridge:_fin.fbN||0, fireBacksMean_collectorSide:(fbN?fbSum/fbN:null), fireEmptyFallback:(_fin.fireEmptyFallback||0), fireFilterTooSmall:(_fin.fireFilterTooSmall||0), fireEntMean:(fireEnts.length?fireEnts.reduce(function(x,y){return x+y;},0)/fireEnts.length:null), skipNoAction, aGrowServer:_fin.aGrowServer||0, aServerReject:_fin.aServerReject||0, growOkCountEnd:_fin.growOkCount||0, aGrow:_fin.aGrow||0, aNotGrowable:_fin.aNotGrowable||0, aTreeFull:_fin.aTreeFull||0, growRejectMissing:_fin.growRejectMissing||0, growRejectNotGrowable:_fin.growRejectNotGrowable||0, growStillValid:_fin.growStillValid||0, growChkErr:_fin.growChkErr||null, aNotLeaf:_fin.aNotLeaf||0, aNoSlots:_fin.aNoSlots||0, aErr:_fin.aErr||null,
    agAccepted:(_ifc.growAt||0), giveUpA:(_ifc.giveUpA||0), callsA:(_ifc.callsA||0), callsB:(_ifc.callsB||0), nodeCountEnd:_fin.nodeCount,
    bPicks:(_ifc.picks||0), pulseBlocked:_fin.pulseBlocked||0, pulseBlock:_fin.pulseBlock||0, pulseHeldFrames:_fin.pulseHeldFrames||0, pulseBlockedByPrev:_fin.pulseBlockedByPrev||0, pulseBlockedBySelfFire:_fin.pulseBlockedBySelfFire||0,totalFrames,totalProj,vFire,truncated,lpOk,lpTot,oob,skippedNoTree,badLp,oppRowsMax:oppSeen.max,oppOver:oppSeen.over,
    fireMode:FIRE_BACK, fire1Frames:firedFrames, vBulletFrames:vFire, fire1AndBulletFrames:fireAndBullet, noFireButBulletFrames:noFireButBullet,
    vBulletSpawnFrames:spawnFrames, fire1ThenSpawnFrames:fire1ThenSpawn, subFireFrames:subFireFrames, lastPickSameCursor:lastPickSameCursor, lastPickCursorChanged:lastPickCursorChanged, targetChangedFrames:targetChangedFrames, targetSameFrames:targetSameFrames, opBFrames:opBFrames, opBFireFrames:opBFireFrames, opOtherFrames:opOtherFrames, desiredFireFrames:desiredFireFrames, desiredErr:desiredErrSeen, slotsNullFrames:slotsNullFrames, vNextOk:vNextOk, vNextFail:vNextFail, buildOK:buildOKEnd, buildMisses:buildMissEnd, fireNoCursor:fireNoCursorEnd, fireErr:fireErrSeen,
    planFrames:planCnt,
    // ⭐ v202「在某一帧分叉」验收数（全部来自树侧 stats，逐项有出处）
    growBackDistinct:Object.keys(backHist).length,        // ⭐ `act.grow.back` 的唯一取值数（>1 才算"有分叉帧这一维"）
    growBackHist:backHist,
    fork:forkStats, treeShape:treeShape, forkSelfTest:forkSelfTest, shapeTimeline:shapeTimeline,
    // ⭐ 口径澄清：两个完全不同的数
    fireSubmitsTotal:_fin.fireSubmits||0,          // 「想开火」帧数（提交次数）
    bulletsSpawned:(function(){var _t=0;for(var _i=0;_i<roundFire.length;_i++)_t+=(roundFire[_i].wepShotsByInc||0);return _t;})(),   // ⭐ 真子弹（_bulletsFired 增量）
    fireFallbackUsed:_fin.fireFallbackUsed||0, fireMasked:_fin.fireMasked||0, stillFrames:stillN, stillPct:(stillTot?stillN/stillTot:null), routeNonNullPct:(routeTot?routeNN/routeTot:null), fireFramesNonZeroPct:(routeTot?fireNZ/routeTot:null), routeSamples:routeTot, fireHackApplied:_fin.fireHackApplied||0, bTargetSrc:_fin.bTargetSrc||null, bNoTargetAll:_fin.bNoTargetAll||0, fireHackErr:_fin.fireHackErr||null, aSkipEnoughLeaves:_fin.aSkipEnoughLeaves||0, aSkipNotThisFrame:_fin.aSkipNotThisFrame||0, aNoTree:_fin.aNoTree||0, aNoSlots:_fin.aNoSlots||0, aBadTarget:_fin.aBadTarget||0, aCallsTotal:_fin.aCalls||0, aGrowTurns:_fin.aGrowTurns||0,
    agentFrameFromCache:_fin.agentFrameFromCache||0, agentFrameFromDz:_fin.agentFrameFromDz||0, agentFrameMissing:_fin.agentFrameMissing||0, bResendAfterA:_fin.bResendAfterA||0, bResendOk:_fin.bResendOk||0, execByPolicyFrames:execPolN, fireForced:fireForced, fireEpsN:fireEpsN, fire_p:(fireTot?firePN/fireTot:null), fireTot:fireTot, curLStats:_fin.curLStats||null, nodePeak:_fin.nodeCount||null, itemOver, bulletOver, aimFramesTotal:aimFrames, growFramesWithAction:growUidCnt, distinctNodeIdsTotal:nodeIdSet.size, emptyIntentFrames, legalPen, legalExcluded, legalUnknown, legalByCls, emptyBlocked:(_fin.emptyBlocked||0), deathSubErr:(_fin.deathSubErr||null), picks1Submitted, pickExtrasAccepted:pickExtras, giveUpB, skipReasons:skipReasons, aReasons:aReasons, roundFire:roundFire, win:wins};
  fs.closeSync(epFd);   // ⭐ episodes.jsonl 已逐局写入
  fs.writeFileSync(OUT+'summary.json',JSON.stringify(summary,null,2));
  console.log('SUMMARY '+JSON.stringify(summary));
  await m.close(); srv.kill();
})().catch(e=>{console.log('FATAL '+((e&&e.stack)||e));process.exit(1)});
