import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeEvent} from '../src/capture/events.ts';
import {compactHealthEvents,healthEvent,websiteHealth} from '../src/capture/health.ts';

test('capture monitor projects allowlisted metadata without prompt or tool contents',()=>{
 const event=makeEvent('hook','tool_start',{provider:'codex',sessionId:'session-12345678',cwd:'/work/ch_apptitude_kuva/.orca/workspaces/phase2',data:{toolName:'Bash',prompt:'private prompt',toolInput:'private command'}});
 const row=healthEvent(event);
 assert.equal(row?.title,'Tool started');assert.equal(row?.project,'ch_apptitude_kuva');assert.equal(row?.detail,'Bash · Session 12345678');
 assert.ok(!JSON.stringify(row).includes('private'));
});
test('repeated foreground and Orca snapshots do not bury recent agent events',()=>{
 const hook=makeEvent('hook','prompt_submitted',{provider:'claude',sessionId:'one'});
 const mac=Array.from({length:15},(_,i)=>makeEvent('macos','activity',{observedAt:hook.observedAt+i+1,data:{foregroundName:'Orca'}}));
 const orca=Array.from({length:15},(_,i)=>makeEvent('orca','worker',{observedAt:hook.observedAt+i+1,dispatchId:'dispatch',data:{state:'working',outcome:'in_progress'}}));
 const rows=compactHealthEvents([...mac,...orca,hook]);
 assert.equal(rows.filter(row=>row.source==='macos').length,1);assert.equal(rows.filter(row=>row.source==='orca').length,1);assert.equal(rows.filter(row=>row.source==='claude').length,1);
});
test('stale Orca worker snapshots and repeated coverage stay out of the live feed',()=>{
 const stale=makeEvent('orca','worker',{data:{fresh:false,state:'unknown'}});
 const coverage=makeEvent('orca','coverage',{data:{reason:'Host unavailable'}});
 const terminal=makeEvent('orca','terminal',{data:{title:'Review project'}});
 assert.deepEqual(compactHealthEvents([stale,coverage,terminal]).map(row=>row.kind),['terminal']);
});
test('duplicate hook delivery for one tool appears once in the monitor',()=>{
 const first=makeEvent('hook','tool_end',{provider:'codex',sessionId:'one',data:{toolId:'tool-1',toolName:'Bash'}});
 const duplicate=makeEvent('hook','tool_end',{provider:'codex',sessionId:'one',data:{toolId:'tool-1',toolName:'Bash'}});
 assert.equal(compactHealthEvents([first,duplicate]).length,1);
});

test('website health distinguishes matched, suggested, unmatched and checking evidence',()=>{
 const now=1000,rows=websiteHealth([
  {key:'http://localhost:1420',origin:'http://localhost:1420',url:'http://localhost:1420/page',observedAt:999,projectPath:'/work/app',source:'port_process',detail:'Port owner',suggestions:[]},
  {key:'http://localhost:3000',origin:'http://localhost:3000',url:'http://localhost:3000/',observedAt:998,suggestions:[{projectPath:'/work/other',source:'recent_orca',detail:'Recent worktree'}]},
  {key:'https://example.com',origin:'https://example.com',url:'https://example.com/',observedAt:997,suggestions:[]},
  {key:'https://old.example.com',origin:'https://old.example.com',url:'https://old.example.com/',observedAt:100,suggestions:[]},
 ],new Map([['http://localhost:1420',999]]),{key:'https://pending.example.com',observedAt:1000},now);
 assert.deepEqual(rows.map(row=>row.state),['checking','matched','suggested','unmatched']);
 assert.equal(rows[1]?.projectPath,'/work/app');assert.equal(rows[1]?.source,'port_process');assert.equal(rows[1]?.appliedAt,999);
 assert.equal(rows[2]?.suggestions[0]?.projectPath,'/work/other');
 assert.ok(!JSON.stringify(rows).includes('/page'));
});
