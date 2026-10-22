import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {EventStore} from '../src/capture/store.ts';
import {staticOrcaScopeReason} from '../src/capture/observation-retention.ts';

test('offline compacted copy preserves causal event order and review decisions',()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-time-compact-')),source=join(root,'source.sqlite'),target=join(root,'target.sqlite');
 const store=new EventStore(source);
 try{
  for(let i=0;i<4;i++)store.put({eventId:`terminal-${i}`,source:'orca',kind:'terminal',observedAt:100+i,monotonicAt:i,collectorEpoch:'epoch',hostId:'host',terminalHandle:'term',data:{title:'Same',connected:true}});
  for(let i=0;i<4;i++)store.put({eventId:`scope-${i}`,source:'orca',kind:'coverage',observedAt:200+i,monotonicAt:i,collectorEpoch:'epoch',data:{reason:staticOrcaScopeReason}});
  store.setHumanDecisions([['a','b']],'assigned','/project');
  store.setHumanGroupSplit([['c','d']],102,[[100,104]],'/before','/after');
  store.markDayReview('2026-10-22','fingerprint');
  store.close();
  const result=spawnSync(process.execPath,[resolve('scripts/compact-capture-copy.mjs'),source,target],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.beforeRows,8);
  assert.equal(report.afterRows,4);
  const compacted=new EventStore(target);
  try{assert.deepEqual(compacted.events().map(event=>event.eventId),['terminal-0','terminal-3','scope-0','scope-3']);assert.deepEqual(compacted.humanDecisions(),[{startEventId:'a',endEventId:'b',mode:'assigned',projectPath:'/project'}]);assert.equal(compacted.humanSplits()[0]?.splitAt,102);assert.equal(compacted.reviewActions().length,2);assert.equal(compacted.dayReview('2026-10-22')?.fingerprint,'fingerprint');}
  finally{compacted.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
});
