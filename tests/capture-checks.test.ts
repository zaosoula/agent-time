import test from 'node:test';
import assert from 'node:assert/strict';
import {captureChecks} from '../src/capture/capture-checks.ts';
import type {CaptureHealth} from '../src/capture/health.ts';
import type {HookInstallationStatus} from '../src/capture/hook-installation.ts';

const source=(id:string,state:'receiving'|'waiting'|'repair-needed'='waiting')=>({id,name:id,state,lastEvent:null,action:'start-session' as const,detail:'Start a session'});
const health=():CaptureHealth=>({checkedAt:1000,latest:{},hooks:{},sources:[source('macos'),source('claude'),source('safari')],spool:{pending:0,temporary:0,invalid:0,oldestAgeSeconds:null,truncated:false},accessibility:null,websites:[],events:[]});
const hooks=():HookInstallationStatus=>({setupSeen:true,runtimeVersion:'abcd',runtimeReady:true,agents:[{id:'claude',name:'Claude',setting:'claudeHooks',usageSetting:'claudeTokenUsage'}],targets:[{id:'target',provider:'claude',label:'User',path:'/tmp/hook',state:'installed',lastEvent:null,error:null}],legacyPaths:[],migrationError:null});

test('capture check separates installed hooks from observed current-runtime delivery',()=>{
 const checks=captureChecks(health(),hooks());
 const agent=checks.find(item=>item.id==='claude')!;
 assert.equal(agent.steps.find(step=>step.id==='configuration')?.result,'pass');
 assert.equal(agent.steps.find(step=>step.id==='delivery')?.result,'waiting');
 const current=hooks();current.targets[0].lastEvent=990;
 assert.equal(captureChecks(health(),current).find(item=>item.id==='claude')!.steps.find(step=>step.id==='delivery')?.result,'pass');
});
test('repair and Mac helper failure expose the failing step',()=>{
 const current=health();current.sources[0]={...current.sources[0],state:'failed',detail:'Helper exited'};
 current.sources[1]={...current.sources[1],state:'repair-needed'};
 const report=captureChecks(current,hooks());
 assert.equal(report.find(item=>item.id==='macos')?.steps.find(step=>step.id==='observation')?.result,'fail');
 assert.equal(report.find(item=>item.id==='claude')?.steps.find(step=>step.id==='configuration')?.result,'fail');
});
