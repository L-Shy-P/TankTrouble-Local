#!/usr/bin/env node
// v151 回归：接触链表审计必须能区分"不在链表 / IsTouching=false / 写回丢失"三层。
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const sb=fs.readFileSync(path.join(root,'js','vantage_sandbox.js'),'utf8');
for (const f of ['auditContactList','sensorProj','IsTouching','IsEnabled','bodyActive','overlapNoContact','GetContactList'])
  assert(sb.includes(f),'缺接触链表审计字段 '+f);
assert(sb.includes('if (mv && typeof mv.polyGap === '+"'"+'number'+"'"+' && mv.polyGap < 0)'),'overlapNoContact 必须只收 polyGap<0');
assert(sb.includes('auditContactList(audit, fc, k);'),'必须在 Step 后每帧调用');
console.log('diff_audit_contactlist PASS (三层定位字段齐全)');
