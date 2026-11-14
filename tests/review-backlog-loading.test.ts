import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {ref} from 'vue';
test('selected day appears before backlog and a stale backlog cannot replace it',async()=>{
 const source=readFileSync(new URL('../src/ui/store.ts',import.meta.url),'utf8').match(/  async function loadDayReview\(\) \{[\s\S]*?\n  }/)![0];
 const pending:Array<{date:string;full:boolean;resolve:(v:any)=>void}>=[];
 const selectedDate=ref('2026-11-10'),page=ref('review'),dayReview=ref<any>(null),dayReviewLoading=ref(false),backlogLoading=ref(false);
 const transport={status:(date:string,full:boolean)=>new Promise(resolve=>pending.push({date,full,resolve}))};
 const bindings={selectedDate,page,dayReview,dayReviewLoading,backlogLoading,dayReviewRequest:ref(0),dayReviewTransport:transport};
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const load=new Function(...Object.keys(bindings),code+';return loadDayReview;')(...Object.values(bindings));
 const first=load();assert.equal(pending[0]!.full,false);
 pending[0]!.resolve({date:selectedDate.value,backlog:[]});await Promise.resolve();await Promise.resolve();
 assert.equal(dayReview.value.date,'2026-11-10');assert.equal(pending[1]!.full,true);assert.equal(backlogLoading.value,true);
 selectedDate.value='2026-11-11';const second=load();pending[2]!.resolve({date:selectedDate.value,backlog:[]});await Promise.resolve();await Promise.resolve();
 pending[1]!.resolve({date:'2026-11-10',backlog:[{date:'old'}]});await first;
 assert.equal(dayReview.value.date,'2026-11-11');assert.equal(backlogLoading.value,true);
 pending[3]!.resolve({date:'2026-11-11',backlog:[{date:'new'}]});await second;assert.equal(dayReview.value.backlog[0].date,'new');assert.equal(backlogLoading.value,false);
});

import {Collector} from '../src/capture/collector.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {makeEvent} from '../src/capture/events.ts';
test('cooperative backlog yields between days and preserves exact synchronous output',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'review-backlog-')),collector=new Collector(dir);
 try{
  for(const date of ['2026-10-20','2026-10-21']){
   const at=new Date(`${date}T10:00:00`).getTime()/1000;
   for(const offset of [0,10])collector.store.put(makeEvent('macos','activity',{eventId:date+offset,observedAt:at+offset,monotonicAt:offset,data:{idleSeconds:0}}));
  }
  const expected=collector.dayReviewStatus('2026-10-22');let served=false;
  const reply=collector.dayReviewStatusAsync('2026-10-22');setImmediate(()=>{served=true;});
  assert.deepEqual(await reply,expected);assert.equal(served,true);
 }finally{await collector.close();rmSync(dir,{recursive:true,force:true});}
});
