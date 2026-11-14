import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityDetailSpans} from '../src/ui/activity-detail-target.ts';
import type {ActivityDetailTarget} from '../src/ui/activity-detail-target.ts';
test('details preserve disjoint visits and agent intervals instead of counting their gaps',()=>{
 const groups=[{start:10,end:20},{start:100,end:110}];
 assert.deepEqual(activityDetailSpans({kind:'human',date:'2026-11-12',groups} as ActivityDetailTarget),groups);
 assert.deepEqual(activityDetailSpans({kind:'agent',date:'2026-11-12',execution:{bars:groups}} as ActivityDetailTarget),groups);
 assert.deepEqual(activityDetailSpans({kind:'billing',report:{}} as ActivityDetailTarget),[]);
});

import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {computed,ref} from 'vue';
test('common details close on Escape, restore the invoker and avoid hidden-page focus changes',async()=>{
 const source=readFileSync(new URL('../src/ui/ActivityDetailsPanel.vue',import.meta.url),'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*;\n/gm,'');
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 let mounted=()=>{},unmount=()=>{},focused=0,restored=0;const active=ref(true),emitted:string[]=[];
 class Element{isConnected=true;focus(){restored++;}}
 const bindings={requestAnimationFrame:(fn:()=>void)=>{fn();return 1;},withDefaults:(props:any,defaults:any)=>({...defaults,...props}),computed,ref,onMounted:(fn:()=>void)=>mounted=fn,onBeforeUnmount:(fn:()=>void)=>unmount=fn,nextTick:async(fn:()=>void)=>fn(),usePagePresentation:()=>active,defineProps:()=>({target:{kind:'human',date:'2026-11-12',groups:[]}}),defineEmits:()=>((event:string)=>emitted.push(event)),document:{activeElement:new Element()},HTMLElement:Element,activityDetailSpans};
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
