import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityDetailSpans,trimCuts,timeInputValue,timeInputSeconds} from '../src/ui/activity-detail-target.ts';
import type {ActivityDetailTarget} from '../src/ui/activity-detail-target.ts';
import {unionSeconds} from '../src/capture/correlate.ts';
test('details preserve disjoint visits and agent intervals instead of counting their gaps',()=>{
 const groups=[{start:10,end:20},{start:100,end:110}];
 assert.deepEqual(activityDetailSpans({kind:'human',date:'2026-11-12',groups} as ActivityDetailTarget),groups);
 assert.deepEqual(activityDetailSpans({kind:'agent',date:'2026-11-12',execution:{bars:groups}} as ActivityDetailTarget),groups);
 assert.deepEqual(activityDetailSpans({kind:'billing',report:{}} as ActivityDetailTarget),[]);
});

import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {computed,ref,watch,reactive} from 'vue';
test('common details close on Escape, restore the invoker and avoid hidden-page focus changes',async()=>{
 const source=readFileSync(new URL('../src/ui/ActivityDetailsPanel.vue',import.meta.url),'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*;\n/gm,'');
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 let mounted=()=>{},unmount=()=>{},focused=0,restored=0;const active=ref(true),emitted:string[]=[];
 class Element{isConnected=true;focus(){restored++;}}
 const bindings={requestAnimationFrame:(fn:()=>void)=>{fn();return 1;},withDefaults:(props:any,defaults:any)=>({...defaults,...props}),computed,ref,watch,onMounted:(fn:()=>void)=>mounted=fn,onBeforeUnmount:(fn:()=>void)=>unmount=fn,nextTick:async(fn:()=>void)=>fn(),usePagePresentation:()=>active,useStore:()=>({}),trimCuts,timeInputValue,timeInputSeconds,duration:()=>'',defineProps:()=>({target:{kind:'human',date:'2026-11-12',groups:[]}}),defineEmits:()=>((event:string)=>emitted.push(event)),document:{activeElement:new Element()},HTMLElement:Element,activityDetailSpans};
 const state=new Function(...Object.keys(bindings),js+';return {root,close};')(...Object.values(bindings));state.root.value={focus:()=>focused++};mounted();await Promise.resolve();assert.equal(focused,1);
 let prevented=false,stopped=false;state.close({preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});assert.deepEqual(emitted,['close']);assert(prevented&&stopped);
 unmount();assert.equal(restored,1);active.value=false;unmount();assert.equal(restored,1);
});

import {parse,compileScript} from '@vue/compiler-sfc';
import {defineComponent} from 'vue';
test('compiled Vue boolean props opt into panel focus by default',()=>{
 const source=readFileSync(new URL('../src/ui/ActivityDetailsPanel.vue',import.meta.url),'utf8');
 const script=compileScript(parse(source).descriptor,{id:'details-runtime-test'}).content.replace(/^import[\s\S]*?;\n/gm,'');
 const js=ts.transpileModule(script,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports:any={};new Function('exports','_defineComponent',js)(exports,defineComponent);
 assert.equal(exports.default.props.focusOnOpen.default,true);
});

test('trimCuts returns the head and tail to exclude',()=>{
 const span={start:100,end:200};
 assert.deepEqual(trimCuts(span,{start:120,end:200}),[[100,120]]);
 assert.deepEqual(trimCuts(span,{start:100,end:180}),[[180,200]]);
 assert.deepEqual(trimCuts(span,{start:120,end:180}),[[100,120],[180,200]]);
 assert.deepEqual(trimCuts(span,{start:100,end:200}),[]);
 for(const bad of [{start:90,end:150},{start:150,end:210},{start:150,end:150},{start:160,end:150}])assert.throws(()=>trimCuts(span,bad),/Keep the new times inside the original interval/);
});

const BASE=new Date('2026-11-12T10:00:00').getTime()/1000;
function panel(corrections:any[]=[]){
 const source=readFileSync(new URL('../src/ui/ActivityDetailsPanel.vue',import.meta.url),'utf8');
 const code=source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*;\n/gm,'');
 const js=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const calls:any[]=[];let fail:Error|null=null;
 const store={agentCorrections:ref(corrections),loadAgentCorrections:async()=>{},
  excludeAgentTime:async(...a:any[])=>{calls.push(['exclude',...a]);if(fail)throw fail;},
  undoAgentTimeCorrection:async(...a:any[])=>{calls.push(['undo',...a]);if(fail)throw fail;}};
 const execution=reactive({key:'codex:s1',bars:[{start:BASE,end:BASE+100}]});
 const bindings={withDefaults:(p:any,d:any)=>({...d,...p}),computed,ref,watch,onMounted:()=>{},onBeforeUnmount:()=>{},nextTick:async()=>{},requestAnimationFrame:()=>1,usePagePresentation:()=>ref(true),defineProps:()=>({target:reactive({kind:'agent',date:'2026-11-12',execution})}),defineEmits:()=>(()=>{}),document:{},HTMLElement:class{},activityDetailSpans,trimCuts,timeInputValue,timeInputSeconds,unionSeconds,useStore:()=>store,duration:(n:number)=>`${n}s`,preciseClock:(n:number)=>String(n),reviewGroupId:()=>'',reviewVisitTitle:()=>'',reviewAssignmentLabel:()=>''};
 const state=new Function(...Object.keys(bindings),js+';return {removeSpan,askRemove,saveEdit,startEdit,undoCorrection,editStart,editEnd,error,busy,removing,editing,activeCorrections};')(...Object.values(bindings));
 return {state,calls,store,execution,setFail:(e:Error)=>fail=e};
}
test('deleting an interval excludes its exact range for the execution',async()=>{
 const {state,calls,execution}=panel();
 await state.removeSpan(execution.bars[0]);
 assert.deepEqual(calls,[['exclude','codex:s1',BASE,BASE+100]]);
});
test('editing an interval excludes one range per trimmed edge',async()=>{
 const {state,calls,execution}=panel();
 state.startEdit(execution.bars[0]);
 state.editStart.value=timeInputValue(BASE+20);state.editEnd.value=timeInputValue(BASE+80);
 await state.saveEdit(execution.bars[0]);
 assert.deepEqual(calls,[['exclude','codex:s1',BASE,BASE+20],['exclude','codex:s1',BASE+80,BASE+100]]);
 assert.equal(state.editing.value,null);
});
test('editing with unchanged times excludes nothing and invalid times show an inline error',async()=>{
 const {state,calls,execution}=panel();
 state.startEdit(execution.bars[0]);await state.saveEdit(execution.bars[0]);assert.deepEqual(calls,[]);
 state.startEdit(execution.bars[0]);state.editStart.value=timeInputValue(BASE-100);await state.saveEdit(execution.bars[0]);
 assert.equal(state.error.value,'Keep the new times inside the original interval');assert.deepEqual(calls,[]);
});
test('a failed correction surfaces the collector message',async()=>{
 const {state,execution,setFail}=panel();setFail(new Error('Activity changed; refresh and try again'));
 await state.removeSpan(execution.bars[0]);
 assert.equal(state.error.value,'Activity changed; refresh and try again');
});
test('undo calls the store with the correction id and only this execution\'s active corrections show',async()=>{
 const {state,calls}=panel([{id:'a',executionKey:'codex:s1',start:1,end:2},{id:'b',executionKey:'other',start:1,end:2},{id:'c',executionKey:'codex:s1',start:3,end:4,undoneAt:9}]);
 assert.deepEqual(state.activeCorrections.value.map((c:any)=>c.id),['a']);
 await state.undoCorrection({id:'a'});assert.deepEqual(calls,[['undo','a']]);
});
test('the panel never uses browser confirm or alert',()=>{
 const source=readFileSync(new URL('../src/ui/ActivityDetailsPanel.vue',import.meta.url),'utf8');
 assert.doesNotMatch(source,/\b(window\.)?(confirm|alert)\s*\(/);
});

test('editing a span that ends at the next midnight or starts at 00:00 saves',async()=>{
 const mid=new Date('2026-11-13T00:00:00').getTime()/1000,open=new Date('2026-11-12T00:00:00').getTime()/1000;
 const a=panel();const late={start:mid-3600,end:mid};
 a.state.startEdit(late);assert.equal(a.state.editEnd.value,'00:00:00');a.state.editStart.value=timeInputValue(mid-1800);
 await a.state.saveEdit(late);assert.deepEqual(a.calls,[['exclude','codex:s1',mid-3600,mid-1800]]);assert.equal(a.state.error.value,'');
 const b=panel();const early={start:open,end:open+3600};
 b.state.startEdit(early);b.state.editEnd.value=timeInputValue(open+1800);
 await b.state.saveEdit(early);assert.deepEqual(b.calls,[['exclude','codex:s1',open+1800,open+3600]]);
 const src=readFileSync(new URL('../src/ui/ActivityDetailsPanel.vue',import.meta.url),'utf8');assert.doesNotMatch(src,/:(min|max)=/);
});
test('a failed second cut closes the form and reports the partial save',async()=>{
 const {state,store,execution}=panel();let n=0;
 store.excludeAgentTime=async()=>{if(++n===2)throw new Error('Activity changed; refresh and try again');};
 state.startEdit(execution.bars[0]);state.editStart.value=timeInputValue(BASE+20);state.editEnd.value=timeInputValue(BASE+80);
 await state.saveEdit(execution.bars[0]);
 assert.equal(state.editing.value,null);assert.equal(state.error.value,'Start trimmed; the end was not saved. Edit again.');
});

test('an open remove confirm follows its interval, not its row position',async()=>{
 const {state,calls,execution}=panel();
 const b={start:BASE+200,end:BASE+300};execution.bars.push(b);
 state.askRemove(b);
 execution.bars.unshift({start:BASE-500,end:BASE-400});
 assert.equal(state.removing.value,b.start);
 await state.removeSpan(b);
 assert.deepEqual(calls,[['exclude','codex:s1',b.start,b.end]]);
 assert.equal(state.removing.value,null);
});
test('open forms close when their interval disappears', async()=>{
 const {state,calls,execution}=panel();
 const b={start:BASE+200,end:BASE+300};execution.bars.push(b);
 state.askRemove(b);execution.bars.splice(1,1);
 assert.equal(state.removing.value,null);assert.deepEqual(calls,[]);
 execution.bars.push(b);state.startEdit(b);execution.bars.splice(1,1);
 assert.equal(state.editing.value,null);
});
test('time edits move from the edge itself across DST and midnight',()=>{
 const previous=process.env.TZ;process.env.TZ='Europe/Paris';
 try{
  // 2026-10-25: clocks go back from 03:00 CEST to 02:00 CET, so 02:10 happens twice.
  const second=Date.parse('2026-10-25T01:20:00Z')/1000;assert.equal(timeInputValue(second),'02:20:00');
  assert.equal(timeInputSeconds('02:10:00',second),second-600);
  const first=Date.parse('2026-10-25T00:20:00Z')/1000;assert.equal(timeInputValue(first),'02:20:00');
  assert.equal(timeInputSeconds('02:10:00',first),first-600);
  // An end at midnight shown as 00:00:00 moves back into the same day.
  const midnight=Date.parse('2026-11-12T23:00:00Z')/1000;assert.equal(timeInputSeconds('23:30:00',midnight),midnight-1800);
  // 2026-03-29: 02:30 is skipped.
  assert.throws(()=>timeInputSeconds('02:30:00',Date.parse('2026-03-29T00:50:00Z')/1000),/does not exist/);
 }finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
