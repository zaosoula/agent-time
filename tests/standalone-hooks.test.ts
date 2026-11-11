import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {CaptureEvent} from '../src/capture/events.ts';
import {summarize} from '../src/capture/correlate.ts';
import {dailyTotals,recentWorkingAgentCount,summaryForDate} from '../src/capture/daily.ts';
import {agentLoadSegments} from '../src/ui/timeline-groups.ts';

const hook=(id:string,at:number,kind:string,extra:Partial<CaptureEvent>={}):CaptureEvent=>({eventId:id,source:'hook',kind,observedAt:at,monotonicAt:at,collectorEpoch:'epoch',hostId:'local',provider:'claude',sessionId:'native',data:{toolId:'tool'},...extra});
const work=(s:ReturnType<typeof summarize>)=>s.intervals.filter(i=>i.state==='grouped');

test('standalone Claude hooks measure their explicit session without inventing an Orca terminal or project',()=>{
 const events=[hook('a',10,'tool_start'),hook('b',20,'tool_end')],before=JSON.stringify(events);
 const s=summarize(events);assert.equal(s.agentSeconds,60);assert.equal(s.sessions.length,1);assert.equal(s.sessions[0]!.proof,'observed');
 assert.equal(s.sessions[0]!.terminalHandle,undefined);assert.equal(s.sessions[0]!.workspaceId,undefined);
 assert.equal(s.intervals.find(i=>i.state==='running')!.end,20);assert.equal(JSON.stringify(events),before);
 assert.ok(!s.unresolved.some(i=>i.reason.includes('terminal binding')));
});

test('standalone sessions sharing a directory stay distinct, while missing explicit identity stays unverified',()=>{
 const a=[hook('a',10,'tool_start',{cwd:'/same'}),hook('b',20,'tool_end',{cwd:'/same'})];
 const b=[hook('c',10,'tool_start',{cwd:'/same',sessionId:'second'}),hook('d',20,'tool_end',{cwd:'/same',sessionId:'second'})];
 const s=summarize([...a,...b]);assert.equal(s.agentSeconds,120);assert.equal(agentLoadSegments(work(s),[])[0]!.total,2);
 for(const missing of [{sessionId:undefined},{provider:undefined},{hostId:undefined}]){
  const invalid=summarize([hook('x',10,'tool_start',missing),hook('y',20,'tool_end',missing)]);
  assert.equal(invalid.agentSeconds,0);assert.ok(invalid.unresolved.length);
 }
});

test('provider and host scope standalone identities, matched tool closures, daily totals and live count',()=>{
 const events=[['local','claude'],['remote','claude'],['local','codex']].flatMap(([hostId,provider],n)=>[hook(n+'a',10+n,'tool_start',{hostId,provider}),hook(n+'b',20+n,'tool_end',{hostId,provider})]);
 const s=summarize(events);assert.equal(s.sessions.length,3);assert.equal(s.agentSeconds,180);
 assert.equal(work(s).length,3);assert.equal(Math.max(...agentLoadSegments(work(s),[]).map(s=>s.total)),3);
 const now=new Date(2026,10,11,0,0,0);const offset=now.getTime()/1000;
 assert.equal(dailyTotals({...s,intervals:s.intervals.map(i=>({...i,start:i.start+offset,end:i.end+offset}))},now).agentSeconds,180);
 assert.equal(recentWorkingAgentCount([],events,15),3);assert.equal(recentWorkingAgentCount([],events,25),0);
});

test('a native session later bound to an Orca Dispatch is counted once, including an already open tool',()=>{
 const common={hostId:'local',provider:'claude',sessionId:'native',terminalHandle:'term',workspaceId:'ws',dispatchId:'dispatch'};
 const s=summarize([
  hook('start',0,'tool_start'),
  hook('worker',5,'worker',{...common,source:'orca',data:{state:'working',fresh:true,outcome:'in_progress'}}),
  hook('end',10,'tool_end',common),
  hook('done',12,'worker',{...common,source:'orca',data:{state:'idle',fresh:true,outcome:'completed'}}),
 ]);
 assert.equal(s.sessions.length,1);assert.equal(s.sessions[0]!.dispatchId,'dispatch');assert.equal(s.agentSeconds,60);
 assert.equal(work(s).length,1);assert.equal(s.intervals.find(i=>i.state==='running'&&i.sourceEventIds[0]==='start')?.end,10);
});

test('standalone timing retains wait, capture fences, idle caps and bounded incomplete evidence',()=>{
 const waiting=summarize([hook('p',0,'prompt_submitted'),hook('w',10,'waiting'),hook('s',20,'response_stop')]);
 assert.equal(waiting.intervals.filter(i=>i.state==='grouped').reduce((n,i)=>n+i.end-i.start,0),10);
 const fenced=summarize([hook('a',0,'tool_start'),hook('f',5,'capture_stop',{source:'capture'}),hook('b',1000,'tool_end')]);
 assert.ok(!fenced.intervals.some(i=>i.state==='running'&&i.end===1000));
 assert.ok(fenced.agentSeconds<=60);
 const idle=summarize([hook('p',0,'prompt_submitted'),hook('s',3600,'response_stop')]);assert.equal(idle.agentSeconds,300);
 const open=summarize([hook('p',0,'prompt_submitted')]);assert.equal(open.agentSeconds,0);
});

test('a daily summary does not borrow an equal session ID from another provider on a different day',()=>{
 const at=new Date('2026-11-11T10:00:00').getTime()/1000;
 const s=summarize([hook('ca',at,'tool_start'),hook('cb',at+10,'tool_end'),hook('xa',at-86400,'tool_start',{provider:'codex'}),hook('xb',at-86390,'tool_end',{provider:'codex'})]);
 const today=summaryForDate(s,'2026-11-11');assert.equal(today.sessions.length,1);assert.equal(today.sessions[0]!.provider,'claude');
});

test('late Orca binding retains matching tool closures and response stops that omit terminal metadata',()=>{
 for(const [startKind,endKind,until] of [['tool_start','tool_end',240],['prompt_submitted','response_stop',120]] as const){
  const s=summarize([hook('begin',0,startKind),hook('binding',10,'session_start',{terminalHandle:'term',dispatchId:'dispatch',workspaceId:'ws'}),hook('finish',until,endKind)]);
  assert.equal(s.sessions.length,1);assert.equal(s.agentSeconds,until);assert.equal(s.sessions[0]!.terminalHandle,'term');
  assert.equal(s.sessions[0]!.dispatchId,'dispatch');assert.ok(!s.unresolved.some(i=>i.reason.includes('no matching')));
 }
});

test('a completed promoted session does not lend its Dispatch or project to a later unbound session start',()=>{
 const s=summarize([hook('a',0,'tool_start',{terminalHandle:'term',dispatchId:'dispatch',workspaceId:'ws'}),hook('b',10,'tool_end',{terminalHandle:'term',dispatchId:'dispatch',workspaceId:'ws'}),hook('end',11,'session_end'),hook('new',20,'session_start'),hook('c',21,'tool_start'),hook('d',30,'tool_end')]);
 assert.equal(s.sessions.length,2);assert.equal(s.agentSeconds,120);
 const native=s.sessions.find(s=>!s.dispatchId)!;assert.equal(native.workspaceId,undefined);assert.equal(native.seconds,60);
});

test('late promotion preserves provisional evidence before a capture fence in all totals',()=>{
 const s=summarize([hook('a',0,'tool_start'),hook('f',5,'capture_stop',{source:'capture'}),hook('binding',10,'session_start',{terminalHandle:'term',dispatchId:'dispatch'}),hook('b',20,'tool_start'),hook('c',30,'tool_end')]);
 assert.equal(s.agentSeconds,120);assert.equal(s.sessions.length,1);assert.equal(s.sessions[0]!.seconds,120);
 assert.equal(work(s).length,2);
});

test('completed and taken-over Orca workers release aliases before a standalone continuation',()=>{
 for(const data of [{state:'done',outcome:'completed',fresh:false},{state:'working',outcome:'in_progress',fresh:true,takeover:true}]){
  const bound={terminalHandle:'term',dispatchId:'dispatch',workspaceId:'ws'};
  const s=summarize([hook('a',0,'tool_start',bound),hook('b',10,'tool_end',bound),hook('worker',11,'worker',{...bound,source:'orca',data}),hook('p',20,'prompt_submitted'),hook('c',21,'tool_start'),hook('d',30,'tool_end'),hook('s',40,'response_stop')]);
  const native=s.sessions.find(s=>!s.dispatchId);assert.ok(native);assert.equal(native.workspaceId,undefined);assert.equal(native.seconds,60);assert.equal(s.agentSeconds,120);
 }
});
