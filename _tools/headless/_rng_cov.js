const { Match } = require('./match');
(async () => {
  const m = new Match();
  await m.open({ humanIds: ['tank_a'], aiCount: 1, vantCount: 0 });
  await m.clearControl();
  const a = await m.eval(`(function(){
    var R = window.__vtRng, o = { keys: R ? Object.keys(R) : null };
    if (!R) return JSON.stringify(o);
    try { if (R.recordFlat) { R.recordFlat(); o.mode='recordFlat'; } else if (R.record) { R.record(); o.mode='record'; } } catch (e) { o.recErr = String(e.message||e); }
    function len(){ try { var d = R.dump(); if (typeof d === 'string') return d.length; if (d && typeof d.length === 'number') return d.length; return -1; } catch (e) { return -1; } }
    o.before = len();
    o.vals = []; for (var i=0;i<3;i++) o.vals.push(Math.random());
    o.arr = null; try { o.arr = (typeof MathUtils !== 'undefined' && MathUtils.randomArrayEntry) ? MathUtils.randomArrayEntry([11,22,33]) : 'no-MathUtils'; } catch (e) { o.arr = 'err:'+String(e.message||e); }
    o.after = len(); o.delta = o.after - o.before;
    try { var d = R.dump(); o.dumpType = typeof d; o.dumpTail = (d && d.slice) ? (typeof d === 'string' ? d.slice(-200) : JSON.stringify(d.slice(-6))) : null; o.seqLen = (d && d.length !== undefined) ? d.length : null; } catch (e) {}
    return JSON.stringify(o);
  })()`);
  console.log('A_RECORD ' + a);
  const b = await m.eval(`(function(){
    var R = window.__vtRng, o = {};
    try { var d = R.dump(); var seq = (typeof d === 'string') ? JSON.parse(d) : d; o.seqTop = Array.isArray(seq) ? seq.length : typeof seq;
      if (R.play) { R.play(seq); o.played = 'play'; } else if (R.playSites) { o.played = 'playSites-avail'; }
      o.replay = []; for (var i=0;i<3;i++) o.replay.push(Math.random());
    } catch (e) { o.err = String(e.message||e); }
    return JSON.stringify(o);
  })()`);
  console.log('B_REPLAY ' + b);
  await m.close();
})();
