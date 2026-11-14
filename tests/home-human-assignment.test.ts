import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {computed,ref,watch,reactive,nextTick,effectScope} from 'vue';
import * as workspace from '../src/ui/review-workspace.ts';
import {buildAppReviewGroups,reviewGroupId} from '../src/ui/review-apps.ts';
function home(){
 const source=readFileSync(new URL('../src/ui/TodayPage.vue',import.meta.url),'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*;\n/gm,'');
 const writes:any[]=[],applied:any[]=[],undo:any[]=[],scope=effectScope();let complete!:(v:any)=>void,historyCalls=0;
 const store=reactive({selectedDate:'2026-11-12',project:'all',page:'today',filteredIntervals:[],timelineProjects:[],applyReviewedSummary:(v:any,date:string)=>{applied.push([v,date]);},setDate(){},navigate(){}});
 const bindings={...workspace,buildAppReviewGroups,reviewGroupId,computed,ref,watch,reactive,defineProps:()=>({mode:'today'}),defineEmits:()=>()=>{},useStore:()=>store,transport:{setHumanDecision:(...args:any[])=>{writes.push(args);return new Promise(resolve=>complete=resolve);}},reviewTransport:{history:async()=>++historyCalls===1?[]:[{id:'own',canUndo:true,mode:'unassigned',projectPath:null,eventIds:['a','b']}],undo:async(...args:any[])=>{undo.push(args);return {}; }},toast:{success(){},error(){}},duration:String};
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const state=scope.run(()=>new Function(...Object.keys(bindings),js+';return {assignHuman,undoHuman,humanUndo,humanBusy};')(...Object.values(bindings)));
 return {state,store,writes,applied,undo,finish:(v:any)=>complete(v),stop:()=>scope.stop()};
}
test('Home saves the original day during navigation and never attaches its undo to a different day',async()=>{
 const p=home();try{
  const task=p.state.assignHuman([{pairs:[['a','b']],reviewSegment:'after'}],null);await Promise.resolve();
  p.store.selectedDate='2026-11-13';await nextTick();p.finish({});await task;
  assert.equal(p.writes[0][3],'2026-11-12');assert.deepEqual(p.writes[0][4],[{pair:['a','b'],segment:'after'}]);assert.equal(p.applied[0][1],'2026-11-12');assert.equal(p.state.humanUndo.value,'');
 }finally{p.stop();}
});
test('Home undo identifies its own recorded event scope and uses the same day',async()=>{
 const p=home();try{
  const task=p.state.assignHuman([{pairs:[['a','b']]}],null);await Promise.resolve();p.finish({});await task;
  assert.equal(p.state.humanUndo.value,'own');await p.state.undoHuman();assert.deepEqual(p.undo,[['own','2026-11-12']]);assert.equal(p.state.humanUndo.value,'');
 }finally{p.stop();}
});
