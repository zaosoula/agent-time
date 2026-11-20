import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Collector} from '../src/capture/collector.ts';
import {makeEvent} from '../src/capture/events.ts';
import {agentSessionKey} from '../src/capture/session-identity.ts';
import {snapshot} from '../src/mcp/data.ts';

const who={hostId:'local',provider:'claude',sessionId:'one'},key=agentSessionKey(who);
const date='2026-10-22',next='2026-10-23',at=(hour:number,day=22)=>new Date(2026,9,day,hour).getTime()/1000;
const hook=(kind:string,observedAt:number,data:Record<string,unknown>={})=>makeEvent('hook',kind,{...who,observedAt,monotonicAt:observedAt,data});
const agentTotals=(s:{agentSeconds:number;mainAgentSeconds?:number;agentWallSeconds?:number;elapsedSeconds:number})=>[s.agentSeconds,s.mainAgentSeconds,s.agentWallSeconds,s.elapsedSeconds];
async function withCollector(name:string,run:(c:Collector,output:string)=>void|Promise<void>){
 const output=mkdtempSync(join(tmpdir(),`agent-time-exclusions-${name}-`)),c=new Collector(output);
 try{c.updateSettings({macosActivity:false,orcaPolling:false,tokenUsage:false});await run(c,output);}
 finally{await c.close();rmSync(output,{recursive:true,force:true});}
}
/** One measured turn from `from` to `to`, with tool activity inside the agent idle threshold. */
const work=(c:Collector,from:number,to:number)=>{
 c.store.put(hook('prompt_submitted',from));
 for(let t=from;t<to;t+=240){c.store.put(hook('tool_start',t,{toolId:`t${t}`}));c.store.put(hook('tool_end',Math.min(t+230,to),{toolId:`t${t}`}));}
 c.store.put(hook('response_stop',to));
};
const hour=(c:Collector)=>work(c,at(10),at(11));

test('day summary removes excluded agent time',()=>withCollector('day',c=>{
 hour(c);
 assert.ok(c.summaryForDate(date).agentSeconds>=3600);
 c.store.addAgentTimeExclusion({...who,executionKey:key,date,start:at(10),end:at(11)});
 const s=c.summaryForDate(date);
 assert.equal(s.agentSeconds,0);
 assert.equal(s.sessions.find(item=>item.key===key)?.seconds??0,0);
}));

test('midnight-crossing correction leaves previous day unchanged',()=>withCollector('midnight',c=>{
 c.store.put(hook('tool_start',at(22,22)+3590,{toolId:'bg'}));
 c.store.put(hook('tool_end',at(23),{toolId:'bg',backgroundTaskId:'b1'}));
 c.store.put(hook('prompt_submitted',at(1,23),{backgroundTaskId:'b1',backgroundStatus:'completed'}));
 // Incremental window updates may reorder keys, so compare the JSON values.
 const json=(value:unknown)=>JSON.parse(JSON.stringify(value)),before=json(c.summaryForDate(date));
 assert.ok(c.summaryForDate(next).agentSeconds>0);
 c.store.addAgentTimeExclusion({...who,executionKey:key,date:next,start:at(0,23),end:at(1,23)});
 assert.equal(c.summaryForDate(next).agentSeconds,0);
 assert.deepEqual(json(c.summaryForDate(date)),before);
}));

test('correction persists after new events extend the interval',()=>withCollector('extend',c=>{
 hour(c);
 c.store.addAgentTimeExclusion({...who,executionKey:key,date,start:at(10),end:at(11)});
 assert.equal(c.summaryForDate(date).agentSeconds,0);
 work(c,at(12),at(12)+600);
 const s=c.summaryForDate(date);
 assert.equal(s.agentSeconds,600);
 assert.ok(s.intervals.filter(i=>i.state!=='human').every(i=>i.end<=at(10)||i.start>=at(11)));
}));

test('task-counter credit in an excluded range is removed',()=>withCollector('counter',c=>{
 c.updateSettings({countTaskCounters:true});
 c.store.put(hook('tool_start',at(10),{toolId:'one'}));c.store.put(hook('tool_end',at(10)+60,{toolId:'one'}));
 const start=makeEvent('agent_report','task_start',{...who,observedAt:at(10),data:{name:'Build',leaseSeconds:7200}});
 c.store.put(start);c.store.put(makeEvent('agent_report','task_stop',{...who,observedAt:at(11),data:{taskCounterId:start.eventId}}));
 assert.ok(c.summaryForDate(date).agentSeconds>=3600);
 c.store.addAgentTimeExclusion({...who,executionKey:key,date,start:at(10),end:at(11)});
 assert.equal(c.summaryForDate(date).agentSeconds,0);
}));

test('MCP snapshot and whole-history summary agree with the day summary',()=>withCollector('mcp',(c,output)=>{
 hour(c);work(c,at(12),at(12)+600);
 c.summary();
 c.store.addAgentTimeExclusion({...who,executionKey:key,date,start:at(10),end:at(11)});
 const day=c.summaryForDate(date),mcp=snapshot(output,at(0),at(0,23)).summary;
 assert.equal(day.agentSeconds,600);
 assert.equal(mcp.agentSeconds,day.agentSeconds);
 assert.ok(c.summary().intervals.filter(i=>i.state!=='human').every(i=>i.end<=at(10)||i.start>=at(11)));
}));

test('undo restores the original totals exactly',()=>withCollector('undo',c=>{
 hour(c);
 const before=c.summaryForDate(date);
 const saved=c.store.addAgentTimeExclusion({...who,executionKey:key,date,start:at(10)+600,end:at(10)+1200});
 assert.equal(c.summaryForDate(date).agentSeconds,before.agentSeconds-600);
 c.store.undoAgentTimeExclusion(saved.id,date);
 const after=c.summaryForDate(date);
 assert.deepEqual(agentTotals(after),agentTotals(before));
 assert.deepEqual(after.sessions.map(s=>s.seconds),before.sessions.map(s=>s.seconds));
}));

for(const form of ['session key','interval key'] as const)test(`a correction keyed by the ${form} removes a standalone task-counter session`,()=>withCollector(`standalone-${form.split(' ')[0]}`,c=>{
 c.updateSettings({countTaskCounters:true});
 const start=makeEvent('agent_report','task_start',{provider:'codex',hostId:'local',observedAt:at(10),data:{name:'Solo',leaseSeconds:7200}});
 c.store.put(start);c.store.put(makeEvent('agent_report','task_stop',{provider:'codex',hostId:'local',observedAt:at(11),data:{taskCounterId:start.eventId}}));
 const before=c.summaryForDate(date),session=before.sessions.find(s=>s.key===`task-counter:${start.eventId}`)!;
 assert.ok(session&&session.seconds>=3600&&before.agentSeconds>=3600);
 const counted=before.intervals.find(i=>i.attributionSource==='task-counter')!;
 c.store.addAgentTimeExclusion({executionKey:form==='session key'?session.key:agentSessionKey(counted),date,start:at(10),end:at(11)});
 const after=c.summaryForDate(date);
 assert.equal(after.agentSeconds,0);
 assert.equal(after.sessions.find(s=>s.key===session.key)?.seconds,0);
}));

test('excludeAgentTime clamps to the day, validates the range and round-trips undo',()=>withCollector('api',c=>{
 hour(c);
 const total=c.summaryForDate(date).agentSeconds;
 assert.throws(()=>c.excludeAgentTime(key,date,at(12),at(13)),/Activity changed; refresh and try again/);
 assert.throws(()=>c.excludeAgentTime(key,date,at(0,21),at(0,21)+10),/Choose a range inside this day/);
 assert.throws(()=>c.excludeAgentTime('other',date,at(10),at(11)),/Activity changed/);
 const s=c.excludeAgentTime(key,date,at(10)-7200,at(10)+1800);
 const [saved]=c.agentTimeExclusions(date);
 assert.equal(saved!.start,at(10)-7200<new Date(2026,9,22).getTime()/1000?new Date(2026,9,22).getTime()/1000:at(10)-7200);
 assert.ok(s.agentSeconds<total&&s.agentSeconds>0);
 assert.equal(c.agentTimeExclusions(next).length,0);
 const back=c.undoAgentTimeExclusion(saved!.id,date);
 assert.equal(back.agentSeconds,total);
 assert.equal(c.agentTimeExclusions(date).length,0);
 assert.throws(()=>c.undoAgentTimeExclusion(saved!.id,date),/Correction not found/);
}));

test('excludeAgentTime refuses when another app owns capture',()=>withCollector('lock',(c,output)=>{
 hour(c);
 writeFileSync(join(output,'capture.lock'),'x');
 assert.throws(()=>c.excludeAgentTime(key,date,at(10),at(11)),/Review activity in the app that owns capture/);
 assert.throws(()=>c.undoAgentTimeExclusion('00000000-0000-4000-8000-000000000000',date),/Review activity in the app that owns capture/);
}));
