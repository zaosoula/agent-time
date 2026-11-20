import{test}from'node:test';import assert from'node:assert/strict';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{Collector}from'../src/capture/collector.ts';import{makeEvent,type Summary}from'../src/capture/events.ts';import{EventStore}from'../src/capture/store.ts';
const at=(s:string)=>new Date(s).getTime()/1000;
const plain=(value:any)=>{const{token,...summary}=value;return summary;};
function samples(c:Collector,date:string){for(let i=0;i<4;i++)c.store.put(makeEvent('macos','activity',{eventId:date+'-'+i,observedAt:at(date+'T10:00:00')+i*5,monotonicAt:i*5,data:{idleSeconds:0,foregroundBundleId:'fixture',browserDomain:'example.com',browserUrl:'https://example.com/page'}}));}
async function fixture(fn:(c:Collector,dir:string)=>unknown){const dir=mkdtempSync(join(tmpdir(),'home-day-cache-')),c=new Collector(dir);try{await fn(c,dir);}finally{await c.close();rmSync(dir,{recursive:true,force:true});}}

test('closed-day revisits reuse exact lightweight snapshots and stable validation tokens',()=>fixture(c=>{
 for(const date of ['2026-10-20','2026-10-21','2026-10-22'])samples(c,date);
 const first=c.versionedSummary('2026-10-20'),expected=plain(first);
 c.versionedSummary('2026-10-21');c.versionedSummary('2026-10-22');const computations=(c as any).days.computations;
 assert.deepEqual(c.versionedSummary('2026-10-20',0,first.token),{unchanged:true,token:first.token});
 assert.deepEqual(plain(c.versionedSummary('2026-10-20')),expected);assert.equal((c as any).days.computations,computations);
 assert.equal((c as any).days.entries.has('2026-10-20'),false,'closed view snapshots must not retain raw day graphs');
}));

test('unrelated own live activity preserves a past snapshot; corrections and late evidence invalidate it',()=>fixture(c=>{
 samples(c,'2026-10-20');const first=c.versionedSummary('2026-10-20');
 c.store.put(makeEvent('macos','activity',{observedAt:at('2026-11-14T10:00:00'),data:{idleSeconds:0}}));
 assert.deepEqual(c.versionedSummary('2026-10-20',0,first.token),{unchanged:true,token:first.token});
 c.store.setHumanDecisions([['2026-10-20-0','2026-10-20-1']],'assigned','/new');
 const changed=c.versionedSummary('2026-10-20',0,first.token);assert(!('unchanged'in changed));assert.deepEqual(plain(changed),c.summaryForDate('2026-10-20'));
 c.store.put(makeEvent('macos','activity',{observedAt:at('2026-10-20T10:00:12'),data:{idleSeconds:0}}));
 assert(!('unchanged'in c.versionedSummary('2026-10-20',0,changed.token)));
}));

test('external decision writes invalidate cached past-day results',()=>fixture((c,dir)=>{
 samples(c,'2026-10-20');const first=c.versionedSummary('2026-10-20'),other=new EventStore(join(dir,'events.sqlite'));
 try{other.setHumanDecisions([['2026-10-20-0','2026-10-20-1']],'assigned','/external');}finally{other.close();}
 const next=c.versionedSummary('2026-10-20',0,first.token);assert(!('unchanged'in next));assert.deepEqual(plain(next),c.summaryForDate('2026-10-20'));
}));

test('counter evidence is read once across summary/list reads and unrelated activity, but new closure is honored',()=>fixture(c=>{
 const start=at('2026-10-20T10:00:00');c.store.put(makeEvent('agent_report','task_start',{eventId:'counter',provider:'claude',sessionId:'s',observedAt:start,data:{name:'Task'}}));
 let reads=0;const read=c.store.taskReportEvidence.bind(c.store);c.store.taskReportEvidence=(...args)=>{reads++;return read(...args);};
 const before=c.reportedWork('2026-10-20');c.reportedWork('2026-10-20');assert.equal(reads,1);
 c.store.put(makeEvent('macos','activity',{observedAt:start+2,data:{idleSeconds:0}}));c.reportedWork('2026-10-20');assert.equal(reads,1);
 c.store.put(makeEvent('hook','session_end',{provider:'claude',sessionId:'s',observedAt:start+100}));const after=c.reportedWork('2026-10-20');assert.equal(reads,2);assert.notDeepEqual(after,before);assert.equal(after[0]?.end,start+100);
}));

test('cached evidence reevaluates leases, future session-end visibility and clock rollback without stale status',()=>fixture(c=>{
 const original=Date.now;let now=at('2026-10-21T00:01:00');Date.now=()=>now*1000;
 try{
  c.store.put(makeEvent('agent_report','task_start',{eventId:'clock-counter',provider:'claude',sessionId:'clock',observedAt:at('2026-10-20T23:58:00'),data:{name:'Clock',leaseSeconds:43200}}));
  c.store.put(makeEvent('hook','session_end',{provider:'claude',sessionId:'clock',observedAt:at('2026-10-21T01:00:00')}));
  assert.equal(c.reportedWork('2026-10-20')[0]?.status,'active');now=at('2026-10-21T01:01:00');assert.equal(c.reportedWork('2026-10-20')[0]?.status,'session-ended');
  now=at('2026-10-21T00:01:00');assert.equal(c.reportedWork('2026-10-20')[0]?.status,'active');
  c.store.put(makeEvent('agent_report','task_start',{eventId:'lease-counter',provider:'claude',sessionId:'lease',observedAt:now,data:{name:'Lease',leaseSeconds:30}}));
  const date='2026-10-21',first=c.reportedWork(date).find(r=>r.id==='lease-counter')!;now+=31;
  const expired=c.reportedWork(date).find(r=>r.id==='lease-counter')!;assert.equal(first.status,'active');assert.equal(expired.status,'interrupted');assert.equal(expired.end,first.start);
 }finally{Date.now=original;}
}));

test('compressed snapshot cache preserves undefined fields, isolates mutations and enforces a byte/count limit',async()=>{
 const {DaySnapshotCache}=await import('../src/capture/day-snapshot-cache.ts');const cache=new DaySnapshotCache(2000,2);
 const value={intervals:[{start:1,end:2,extra:undefined}],sessions:[],coverage:[],unresolved:[],humanSeconds:0,agentSeconds:0,elapsedSeconds:0}as unknown as Summary;
 assert(cache.put('a','key',value,'token'));assert.deepEqual(cache.get('a','key')?.value,value);
 cache.get('a','key')!.value.intervals[0]!.end=99;assert.equal(cache.get('a','key')!.value.intervals[0]!.end,2);
 cache.put('b','key',value,'b');cache.put('c','key',value,'c');assert.equal(cache.get('a','key'),undefined);assert(cache.retainedBytes<=2000);
 assert.equal(cache.get('b','other'),undefined);
});

test('late terminal titles outside the observation window invalidate a closed view',()=>fixture(c=>{
 const date='2026-10-20',start=at(date+'T10:00:00');
 c.store.put(makeEvent('hook','session_start',{provider:'claude',sessionId:'t',terminalHandle:'terminal',cwd:'/p',observedAt:start}));
 c.store.put(makeEvent('orca','terminal',{terminalHandle:'terminal',observedAt:start-3*86400,data:{title:'Before'}}));
 const first=c.versionedSummary(date);assert(!('unchanged'in first));assert.equal(first.sessions[0]?.title,'Before');
 c.store.put(makeEvent('orca','terminal',{terminalHandle:'terminal',observedAt:start+5*86400,data:{title:'After'}}));
 const next=c.versionedSummary(date,15000,first.token);assert(!('unchanged'in next));assert.equal(next.sessions[0]?.title,'After');
}));

test('resource refreshes and opt-in setting changes cannot reuse old closed-day snapshots',()=>fixture(c=>{
 const original=Date.now;let now=at('2026-10-21T12:00:00');Date.now=()=>now*1000;
 try{
  const date='2026-10-20';samples(c,date);const first=c.versionedSummary(date);
  c.store.put(makeEvent('agent_report','resource',{observedAt:at(date+'T11:00:00'),data:{url:'https://example.com/page',project:'/resource'}}));now+=11;
  const resource=c.versionedSummary(date,0,first.token);assert(!('unchanged'in resource));assert(resource.intervals.some(i=>i.projectPath==='/resource'));assert.deepEqual(plain(resource),c.summaryForDate(date));
  const start=at(date+'T10:30:00');c.store.put(makeEvent('agent_report','task_start',{eventId:'opt-in-counter',provider:'claude',sessionId:'opt-in',observedAt:start,data:{name:'Task'}}));c.store.put(makeEvent('agent_report','task_stop',{provider:'claude',sessionId:'opt-in',observedAt:start+20,data:{taskCounterId:'opt-in-counter'}}));
  const before=c.versionedSummary(date);assert(!('unchanged'in before));c.updateSettings({countTaskCounters:true});
  const next=c.versionedSummary(date,0,before.token);assert(!('unchanged'in next));assert(next.agentSeconds>before.agentSeconds);assert.deepEqual(plain(next),c.summaryForDate(date));
 }finally{Date.now=original;}
}));

test('today remains live and outside the closed-day snapshot cache',()=>fixture(c=>{
 const original=Date.now;Date.now=()=>at('2026-10-20T12:00:00')*1000;
 try{samples(c,'2026-10-20');const first=c.versionedSummary('2026-10-20');assert.equal((c as any).viewSnapshots.retainedBytes,0);
 c.store.put(makeEvent('macos','activity',{observedAt:at('2026-10-20T10:00:20'),monotonicAt:20,data:{idleSeconds:0}}));assert(!('unchanged'in c.versionedSummary('2026-10-20',0,first.token)));assert.equal((c as any).viewSnapshots.retainedBytes,0);
 }finally{Date.now=original;}
}));

test('closed-day tokens fit the 64-character since limit on every path',()=>fixture(c=>{
 samples(c,'2026-10-20');
 const summary=c.versionedSummary('2026-10-20'),again=c.versionedSummary('2026-10-20'),home=c.versionedHomeResponse('2026-10-20'),inner=c.versionedHomeSummary('2026-10-20');
 for(const token of [summary.token,again.token,home.token,inner.token])assert.ok(token.length<=64,`${token.length}: ${token}`);
 assert.match(summary.token,/^r-/);
 assert.deepEqual(c.versionedSummary('2026-10-20',0,summary.token),{unchanged:true,token:summary.token});
}));
