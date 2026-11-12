import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {computed,ref} from 'vue';
import ts from 'typescript';
import type {BillingProject} from '../src/capture/billing-types.ts';

function editor(){
 const source=readFileSync(new URL('../src/ui/BillingSettings.vue',import.meta.url),'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!.replace(/^import .*;\n/gm,'');
 const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const writes:Array<{project:BillingProject;expectedRevision?:number}>=[];
 const request=async(_name:string,input:{project:BillingProject;expectedRevision?:number})=>{writes.push(input);return {...input.project,revision:(input.expectedRevision??0)+1};};
 const state=new Function('computed','ref','onMounted','onUnmounted','crypto','request','humanizeError','toast',compiled+';return {newPolicy,selectProject,setCountingMode,policyChanged,policy,original,save};')(computed,ref,()=>{},()=>{},{randomUUID},request,String,{success(){}});
 return {state,writes};
}
test('billing editor defaults new policies to minutes without changing legacy seconds on selection or resave',async()=>{
 const {state,writes}=editor();assert.equal(state.newPolicy().countingMode,'minutes');
 const legacyPolicy=state.newPolicy();delete legacyPolicy.countingMode;
 const project:BillingProject={id:'old',name:'Legacy',aliases:[],sources:{repositories:[],workspaceIds:[],reportedProjects:[]},timezone:'UTC',policies:[legacyPolicy],revision:1};
 state.selectProject(project);assert.equal(state.policyChanged.value,false);assert.equal(Object.hasOwn(state.policy.value,'countingMode'),false);
 state.setCountingMode({target:{value:'seconds'}});assert.equal(state.policyChanged.value,false);
 await state.save();assert.equal(writes.length,1);assert.equal(writes[0]!.project.policies.length,1);assert.equal(Object.hasOwn(writes[0]!.project.policies[0]!,'countingMode'),false);
 state.setCountingMode({target:{value:'minutes'}});assert.equal(state.policyChanged.value,true);
 state.setCountingMode({target:{value:'seconds'}});assert.equal(state.policyChanged.value,false);
 state.setCountingMode({target:{value:'minutes'}});await state.save();assert.equal(writes[1]!.project.policies.length,2);assert.equal(writes[1]!.project.policies[1]!.countingMode,'minutes');
 assert.equal(Object.hasOwn(writes[1]!.project.policies[0]!,'countingMode'),false);
});

test('editing a legacy policy rate appends explicit seconds while retaining the omitted historical mode',async()=>{
 const {state,writes}=editor(),legacyPolicy=state.newPolicy();delete legacyPolicy.countingMode;
 state.selectProject({id:'old',name:'Legacy',aliases:[],sources:{repositories:[],workspaceIds:[],reportedProjects:[]},timezone:'UTC',policies:[legacyPolicy],revision:1});
 state.policy.value.hourlyRate='150';assert.equal(state.policy.value.countingMode,undefined);assert.equal(state.policyChanged.value,true);
 await state.save();const policies=writes[0]!.project.policies;
 assert.equal(policies.length,2);assert.equal(Object.hasOwn(policies[0]!,'countingMode'),false);assert.equal(policies[1]!.countingMode,'seconds');
});
