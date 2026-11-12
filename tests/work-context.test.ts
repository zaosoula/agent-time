import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateAttributes,validateAgentIdentity,applyWorkAttributes,readLauncherContext,eventWorkMetadata} from '../src/capture/work-context.ts';
import {normalizeHook,hookContext} from '../src/capture/hooks.ts';
import {summarize} from '../src/capture/correlate.ts';
import {eventParser} from '../src/capture/summary-window.ts';
import type {CaptureEvent} from '../src/capture/events.ts';

test('bounded attributes normalize keys, preserve declaration clears, and reject unsafe input',()=>{
 assert.deepEqual(validateAttributes({PROJECT_ID:'p',clear:''}),{project_id:'p',clear:''});
 assert.deepEqual(applyWorkAttributes({project:'p',task:'t'},{project:'',team:'a'}),{task:'t',team:'a'});
 assert.deepEqual(applyWorkAttributes({project:'p'},{}),{project:'p'});
 for(const value of [null,[],{a:1},{A:'x',a:'y'},{constructor:'x'},JSON.parse('{"__proto__":"x"}'),{'bad key':'x'},{a:'\nsecret'},{a:'x'.repeat(129)},Object.fromEntries(Array.from({length:17},(_,i)=>['a'+i,'x'])),Object.fromEntries(Array.from({length:4},(_,i)=>['a'+i,'界'.repeat(128)]))])assert.throws(()=>validateAttributes(value));
 assert.throws(()=>validateAttributes({['a'.repeat(65)]:'x'}));
 // Escapes consume serialized bytes even when the unescaped strings fit.
 assert.throws(()=>validateAttributes(Object.fromEntries(Array.from({length:5},(_,i)=>['a'+i,'\\'.repeat(120)]))));
 assert.ok(Buffer.byteLength(JSON.stringify(validateAttributes({a:'x'.repeat(128)})))<=1024);
 assert.throws(()=>applyWorkAttributes(Object.fromEntries(Array.from({length:16},(_,i)=>['a'+i,'x'])),{extra:'x'}));
 assert.deepEqual(validateAgentIdentity({id:'build-1',name:'Builder',role:'developer'}),{id:'build-1',name:'Builder',role:'developer'});
 for(const value of [{id:''},{id:'x\n'},{id:'a'.repeat(129)},'builder'])assert.throws(()=>validateAgentIdentity(value));
});

test('launcher captures only explicitly opted in values and invalid metadata never blocks timing',()=>{
 const env={AGENT_TIME_AGENT_ID:'billing-agent',AGENT_TIME_ATTR_PROJECT_ID:'p',SECRET:'do-not-capture',AGENT_TIME_TOKEN:'do-not-capture'};
 const context=hookContext(env);
 const event=normalizeHook('claude',{hook_event_name:'PreToolUse',session_id:'s',agent_type:'reviewer',tool_use_id:'t'},context);
 assert.deepEqual(eventWorkMetadata(event),{agentIdentity:{id:'billing-agent'},attributes:{project_id:'p'},metadataSource:'launcher',agentProfile:'reviewer'});
 assert.equal(event.agentId,undefined);assert.equal(event.data?.toolId,'t');assert.ok(!JSON.stringify(event).includes('do-not-capture'));
 const bad=readLauncherContext({AGENT_TIME_AGENT_ID:'private\nidentity',AGENT_TIME_ATTR_A:'private\nvalue'});
 assert.equal(bad.agentIdentity,undefined);assert.equal(bad.attributes,undefined);assert.ok(bad.metadataWarning);assert.ok(!JSON.stringify(bad).includes('private'));
 const start=normalizeHook('claude',{hook_event_name:'PreToolUse',session_id:'s'},hookContext({AGENT_TIME_ATTR_A:'private\nvalue'}));
 const end=normalizeHook('claude',{hook_event_name:'PostToolUse',session_id:'s'},hookContext({}));
 const summary=summarize([{...start,observedAt:0,monotonicAt:0},{...end,observedAt:10,monotonicAt:10}]);
 assert.equal(summary.agentSeconds,60);assert.ok(summary.sessions[0]?.metadataWarning);
});
const e=(id:string,time:number,kind:string,fields:Partial<CaptureEvent>={}):CaptureEvent=>({eventId:id,source:'hook',kind,observedAt:time,monotonicAt:time,collectorEpoch:'one',hostId:'local',provider:'claude',sessionId:'s',...fields});
test('metadata survives native child and late Dispatch promotion without changing totals or keys',()=>{
 const plain=[e('start',0,'tool_start'),e('end',1,'tool_end'),e('worker',20,'worker',{source:'orca',terminalHandle:'t',dispatchId:'d',runId:'r',data:{fresh:true,state:'working'}}),e('bind',21,'session_start',{terminalHandle:'t'}),e('cs',22,'child_start',{agentId:'native-child'}),e('ce',25,'child_stop',{agentId:'native-child'})];
 // Give the first hooks a terminal only to establish the existing Dispatch binding route.
 plain[0]!.terminalHandle='t';plain[1]!.terminalHandle='t';
 const enriched=plain.map(event=>({...event,projectPath:'/project',data:{...event.data,agentIdentity:{id:'business-agent'},attributes:{project_id:'p'},metadataSource:'launcher',childType:event.agentId?'reviewer':'builder'}}));
 const before=summarize(plain),after=summarize(enriched);
 assert.equal(after.agentSeconds,before.agentSeconds);assert.equal(after.childAgentSeconds,before.childAgentSeconds);assert.equal(after.elapsedSeconds,before.elapsedSeconds);
 assert.deepEqual(after.sessions.map(s=>s.key),before.sessions.map(s=>s.key));
 for(const session of after.sessions){assert.equal(session.agentIdentity?.id,'business-agent');assert.equal(session.projectPath,'/project');assert.equal(session.agentProfile,session.child?'reviewer':'builder');}
 for(const interval of after.intervals.filter(i=>i.state!=='human')){assert.equal(interval.agentIdentity?.id,'business-agent');assert.equal(interval.attributes?.project_id,'p');assert.equal(interval.projectPath,'/project');}
 assert.equal(after.sessions.find(s=>s.child)?.agentId,'native-child');
});
test('raw metadata changes do not attach an arbitrary map to grouped time',()=>{
 const summary=summarize([e('a',0,'tool_start',{data:{attributes:{project:'a'}}}),e('b',1,'tool_end',{data:{attributes:{project:'a'}}}),e('c',20,'tool_start',{data:{attributes:{project:'b'}}}),e('d',21,'tool_end',{data:{attributes:{project:'b'}}})]);
 assert.equal(summary.agentSeconds,60);assert.deepEqual(summary.intervals.filter(i=>i.state==='running').map(i=>i.attributes),[{project:'a'},{project:'b'}]);assert.equal(summary.intervals.find(i=>i.state==='grouped')?.attributes,undefined);
});
test('summary parsers intern repeated metadata maps within their own bounded window',()=>{
 const parse=eventParser(),payload=JSON.stringify(e('a',0,'tool_start',{data:{agentIdentity:{id:'business'},attributes:{project:'p'}}}));
 const a=parse(payload),b=parse(payload),other=eventParser()(payload);
 assert.equal(a.data?.attributes,b.data?.attributes);assert.equal(a.data?.agentIdentity,b.data?.agentIdentity);assert.notEqual(a.data?.attributes,other.data?.attributes);
});

test('summary metadata interning stops retaining new unique maps at its window cap',()=>{
 const parse=eventParser();
 for(let i=0;i<2100;i++)parse(JSON.stringify(e(String(i),i,'tool_start',{data:{attributes:{project:String(i)}}})));
 const payload=JSON.stringify(e('new',2200,'tool_start',{data:{attributes:{project:'after-cap'}}}));
 assert.notEqual(parse(payload).data?.attributes,parse(payload).data?.attributes);
});

test('profile from a lifecycle hook follows child tools without becoming a business identity',()=>{
 const summary=summarize([e('cs',0,'child_start',{agentId:'native',data:{childType:'reviewer'}}),e('tool',1,'tool_start',{agentId:'native'}),e('end',2,'tool_end',{agentId:'native'}),e('ce',3,'child_stop',{agentId:'native'})]);
 assert.equal(summary.sessions[0]?.agentProfile,'reviewer');assert.equal(summary.sessions[0]?.agentIdentity,undefined);
 for(const interval of summary.intervals){assert.equal(interval.agentProfile,'reviewer');assert.equal(interval.agentIdentity,undefined);assert.equal(interval.agentId,'native');}
});
test('open tools retain their start metadata when later hooks declare a different context',()=>{
 const summary=summarize([e('start',0,'tool_start',{data:{attributes:{project:'before'}}}),e('change',2,'session_start',{data:{attributes:{project:'after'}}}),e('end',5,'tool_end')]);
 assert.deepEqual(summary.intervals.find(i=>i.state==='running')?.attributes,{project:'before'});assert.deepEqual(summary.sessions[0]?.attributes,{project:'after'});
});

test('correlation keeps repeated attribute maps shared after validating parser rows',()=>{
 const parse=eventParser(),events=[];
 for(let i=0;i<10;i++)events.push(parse(JSON.stringify(e('start'+i,i*100,'tool_start',{data:{attributes:{project:'p'},agentIdentity:{id:'business'}}}))),parse(JSON.stringify(e('end'+i,i*100+1,'tool_end',{data:{attributes:{project:'p'},agentIdentity:{id:'business'}}}))));
 const intervals=summarize(events).intervals;
 assert.equal(new Set(intervals.map(interval=>interval.attributes)).size,1);assert.equal(new Set(intervals.map(interval=>interval.agentIdentity)).size,1);
});

test('a later project observation cannot relabel an earlier open tool',()=>{
 const summary=summarize([e('start-project-unknown',0,'tool_start'),e('end-project-known',5,'tool_end',{projectPath:'/future-project'})]);
 assert.equal(summary.sessions[0]?.projectPath,'/future-project');
 for(const interval of summary.intervals){assert.equal(interval.projectPath,undefined);}
 const preceding=summarize([e('known-before',0,'session_start',{projectPath:'/preceding-project'}),e('start-known',1,'tool_start'),e('end-different',5,'tool_end',{projectPath:'/future-project'})]);
 for(const interval of preceding.intervals)assert.equal(interval.projectPath,'/preceding-project');
});
