import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {applyReportedResources,reportedResources,resourceKey} from '../src/capture/reported-resources.ts';
import {validAgentReport} from '../src/mcp/report.ts';
import type {CaptureEvent,Interval,Summary} from '../src/capture/events.ts';

const resource=(data:Record<string,unknown>,fields:Partial<CaptureEvent>={}):CaptureEvent=>{const id=randomUUID();return {eventId:id,source:'agent_report',kind:'resource',observedAt:Date.now()/1000,monotonicAt:1,collectorEpoch:'e',provider:'claude',workspaceId:'/w/caex/.orca/workspaces/audit',data:{requestId:id,contextId:randomUUID(),...data},...fields};};
const human=(url:string,fields:Partial<Interval>={}):Interval=>({start:0,end:120,state:'human',proof:'observed',sourceEventIds:['a','b'],browserUrl:url,...fields});
const summary=(intervals:Interval[]):Summary=>({intervals,unresolved:[],coverage:[],sessions:[],humanSeconds:0,agentSeconds:0,elapsedSeconds:0,childAgentSeconds:0});

test('resource keys ignore query, fragment and trailing slash',()=>{
 assert.equal(resourceKey('https://Claude.ai/artifact/AbC/?x=1#y'),'https://claude.ai/artifact/AbC');
 assert.equal(resourceKey('file:///tmp/a'),null);
});

test('browser time on a reported page goes to the reporting agent project',()=>{
 const resources=reportedResources([resource({url:'https://claude.ai/artifact/FRyJ',title:'Culture Club',resourceKind:'artifact'})]);
 const result=applyReportedResources(summary([human('https://claude.ai/artifact/FRyJ?v=2'),human('https://claude.ai/artifact/other')]),resources);
 assert.equal(result.intervals[0].workspaceId,'resource::/w/caex');
 assert.equal(result.intervals[0].attributionSource,'agent_resource');
 assert.match(String(result.intervals[0].attributionReason),/Culture Club/);
 assert.equal(result.intervals[1].workspaceId,undefined);
});

test('review decisions and user rules stay authoritative',()=>{
 const resources=reportedResources([resource({url:'https://claude.ai/artifact/FRyJ'})]);
 const input=summary([human('https://claude.ai/artifact/FRyJ',{userAttribution:'unassigned'}),human('https://claude.ai/artifact/FRyJ',{attributionSource:'rule',workspaceId:'web::/w/other'})]);
 assert.equal(applyReportedResources(input,resources),input);
});

test('a report without a project path is ignored and the latest report wins',()=>{
 assert.equal(reportedResources([resource({url:'https://x.dev/a'},{workspaceId:undefined})]).size,0);
 const older=resource({url:'https://x.dev/a'},{observedAt:1}),newer=resource({url:'https://x.dev/a'},{observedAt:2,workspaceId:'/w/new'});
 assert.equal(reportedResources([newer,older]).get('https://x.dev/a')?.projectPath,'/w/new');
});

test('resource reports are validated',()=>{
 assert.equal(validAgentReport(resource({url:'https://claude.ai/artifact/FRyJ',resourceKind:'artifact'})),true);
 assert.equal(validAgentReport(resource({url:'javascript:alert(1)'})),false);
 assert.equal(validAgentReport(resource({url:'https://user:pw@x.dev/a'})),false);
 assert.equal(validAgentReport(resource({url:'https://x.dev/a',resourceKind:'secret'})),false);
 assert.equal(validAgentReport(resource({url:'https://x.dev/a',extra:1})),false);
});

test('resource attribution retains persisted canonical paths after worktree deletion',()=>{
 const resources=reportedResources([resource({url:'https://x.dev/canonical'},{workspaceId:'local::/tmp/deleted-worktree',projectPath:'/projects/main/packages/client'})]);
 assert.equal(resources.get('https://x.dev/canonical')?.projectPath,'/projects/main/packages/client');
 const result=applyReportedResources(summary([human('https://x.dev/canonical',{projectPath:'/previous/project'})]),resources);
 assert.equal(result.intervals[0].projectPath,'/projects/main/packages/client');
});
