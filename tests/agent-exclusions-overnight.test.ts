import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Collector} from '../src/capture/collector.ts';
import {makeEvent} from '../src/capture/events.ts';
import {agentSessionKey} from '../src/capture/session-identity.ts';
import {snapshot} from '../src/mcp/data.ts';

const who={hostId:'local',provider:'claude',sessionId:'one'},key=agentSessionKey(who);
const at=(hour:number,day:number,min=0)=>new Date(2026,10,day,hour,min).getTime()/1000;
const hook=(kind:string,observedAt:number,data:Record<string,unknown>={})=>makeEvent('hook',kind,{...who,observedAt,monotonicAt:observedAt,data});

test('overnight background shell corrected on each day',async()=>{
 const output=mkdtempSync(join(tmpdir(),'at-overnight-')),c=new Collector(output);
 try{
  c.updateSettings({macosActivity:false,orcaPolling:false,tokenUsage:false});
  c.store.put(hook('prompt_submitted',at(22,16)));
  c.store.put(hook('tool_start',at(22,16,5),{toolId:'bg'}));
  c.store.put(hook('tool_end',at(22,16,6),{toolId:'bg',backgroundTaskId:'b1'}));
  c.store.put(hook('response_stop',at(22,16,7)));
  c.store.put(hook('prompt_submitted',at(8,17),{backgroundTaskId:'b1',backgroundStatus:'completed'}));
  c.store.put(hook('tool_start',at(9,17),{toolId:'w'}));c.store.put(hook('tool_end',at(9,17,10),{toolId:'w'}));c.store.put(hook('response_stop',at(9,17,10)));
  const d16=c.summaryForDate('2026-11-16'),d17=c.summaryForDate('2026-11-17');
  const before=[d16.agentSeconds,d17.agentSeconds];
  const bars=(s:typeof d16)=>s.intervals.filter(i=>i.state==='grouped').map(i=>[new Date(i.start*1000).toISOString(),new Date(i.end*1000).toISOString(),i.background]);
  const s16=c.excludeAgentTime(key,'2026-11-16',at(22,16,10),at(0,17));
  const s17=c.excludeAgentTime(key,'2026-11-17',at(0,17),at(8,17));
  const a16=c.summaryForDate('2026-11-16'),a17=c.summaryForDate('2026-11-17');
  const m16=snapshot(output,at(0,16),at(0,17)).summary,m17=snapshot(output,at(0,17),at(0,18)).summary,both=snapshot(output,at(0,16),at(0,18)).summary;
  assert.equal(m16.agentSeconds,a16.agentSeconds);assert.equal(m17.agentSeconds,a17.agentSeconds);
  for(const x of c.agentTimeExclusions('2026-11-16'))c.undoAgentTimeExclusion(x.id,'2026-11-16');
  for(const x of c.agentTimeExclusions('2026-11-17'))c.undoAgentTimeExclusion(x.id,'2026-11-17');
  assert.deepEqual([c.summaryForDate('2026-11-16').agentSeconds,c.summaryForDate('2026-11-17').agentSeconds],before);
 }finally{await c.close();rmSync(output,{recursive:true,force:true});}
});
