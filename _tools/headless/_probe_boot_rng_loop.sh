#!/usr/bin/env bash
cd "$(dirname "$0")"
LOG=prof/detfix/bootrng_loop.log
: > "$LOG"
for i in $(seq 1 30); do
  node _probe_site_counts.js --frames 1200 > prof/detfix/_bootrng_one.log 2>&1
  python - "$i" <<'PY' >> "$LOG"
import json,sys,io,shutil,os
i=sys.argv[1]
try:
    d=json.load(io.open('prof/detfix/sitecounts_report_1200.json',encoding='utf-8',errors='replace'))
    print(json.dumps({'i':int(i),'diffSites':d['diffSites'],'recSites':d['recSites'],'repSites':d['repSites']}),flush=True)
    if d['diffSites']>0:
        for src,dst in [('prof/detfix/sitecounts_report_1200.json','prof/detfix/bootrng_HIT_report.json'),
                        ('prof/detfix/sitecounts_rec_1200.jsonl','prof/detfix/bootrng_HIT_rec.jsonl'),
                        ('prof/detfix/sitecounts_rep_1200.jsonl','prof/detfix/bootrng_HIT_rep.jsonl')]:
            try: shutil.copyfile(src,dst)
            except Exception: pass
except Exception as e:
    print(json.dumps({'i':int(i),'err':str(e)[:150]}),flush=True)
PY
  hit=$(python -c "
import json,io
try:
    d=json.load(io.open('prof/detfix/sitecounts_report_1200.json',encoding='utf-8',errors='replace'))
    print(1 if d['diffSites']>0 else 0)
except Exception: print(0)")
  if [ "$hit" = "1" ]; then echo '{"stop":"hit"}' >> "$LOG"; break; fi
done
echo '{"done":true}' >> "$LOG"
