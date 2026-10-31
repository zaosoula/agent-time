import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {renderClaudeReportedStatus} from '../src/mcp/claude-statusline.ts';
import {ClaudeStatusLineInstallation} from '../src/capture/claude-statusline-installation.ts';
import type {CaptureEvent} from '../src/capture/events.ts';

const at=1_800_000_000;
function report(id:string,kind:string,when:number,data:Record<string,unknown>,sessionId='current'):CaptureEvent{return {eventId:id,source:'agent_report',kind,observedAt:when,monotonicAt:0,collectorEpoch:'test',provider:'claude',sessionId,data};}
test('Claude line uses only the matching session and labels elapsed declarations',()=>{
 const events=[report('other','task_start',at-120,{name:'Private other task'},'other'),report('current','task_start',at-60,{name:'Fix login',issueKey:'EZYO-863'})];
 assert.equal(renderClaudeReportedStatus(events,'current',at),'EZYO-863 · Fix login · 1m 00s counter (reported)');
 assert.equal(renderClaudeReportedStatus(events,'missing',at),'');
 assert.equal(renderClaudeReportedStatus([...events,report('stop','task_stop',at-5,{taskCounterId:'current'})],'current',at),'');
 assert.equal(renderClaudeReportedStatus([report('clear','work_context',at-2,{task:null,issueKey:null,project:null})],'current',at),'');
});

test('opt-in setup preserves and restores a pre-existing Claude status line',()=>{
 const home=mkdtempSync(join(tmpdir(),'agent-time-statusline-')),output=join(home,'data'),settings=join(home,'.claude','settings.json');
 try{
  mkdirSync(join(home,'.claude'));mkdirSync(output);
  const original={theme:'dark',statusLine:{type:'command',command:"printf 'Existing line\\n'"}};
  writeFileSync(settings,JSON.stringify(original));
  const manager=new ClaudeStatusLineInstallation(output,{home,env:{},runtime:{node:process.execPath,script:join(process.cwd(),'src/mcp/claude-statusline-cli.ts')}});
  const target=manager.status().targets[0]!;
  assert.equal(target.state,'not-installed');
  assert.match(target.detail,/kept/);
  manager.install(target.id);
  manager.install(target.id);
  assert.equal(manager.status().targets[0]?.state,'installed');
  const installed=JSON.parse(readFileSync(settings,'utf8'));
  assert.equal(installed.theme,'dark');
  assert.match(installed.statusLine.command,/claude-statusline-cli/);
  assert.equal(installed.statusLine.refreshInterval,30);
  const db=new DatabaseSync(join(output,'events.sqlite'));db.exec('CREATE TABLE events (event_id TEXT PRIMARY KEY,observed_at REAL,payload TEXT)');
  const event=report('task','task_start',Date.now()/1000-70,{name:'Fix login',issueKey:'EZYO-863'});
  db.prepare('INSERT INTO events VALUES(?,?,?)').run(event.eventId,event.observedAt,JSON.stringify(event));db.close();
  const run=spawnSync('/bin/sh',['-c',installed.statusLine.command],{input:JSON.stringify({session_id:'current'}),encoding:'utf8',timeout:5000});
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stdout,/Existing line/);
  assert.match(run.stdout,/EZYO-863 · Fix login · 1m \d\ds counter \(reported\)/);
  manager.remove(target.id);
  assert.deepEqual(JSON.parse(readFileSync(settings,'utf8')),original);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('setup without a prior line is idempotent and refuses to erase outside changes',()=>{
 const home=mkdtempSync(join(tmpdir(),'agent-time-statusline-')),output=join(home,'data'),settings=join(home,'.claude','settings.json');
 try{
  mkdirSync(join(home,'.claude'));mkdirSync(output);writeFileSync(settings,'{"theme":"dark"}');
  const manager=new ClaudeStatusLineInstallation(output,{home,env:{},runtime:{node:process.execPath,script:join(process.cwd(),'src/mcp/claude-statusline-cli.ts')}}),id=manager.status().targets[0]!.id;
  manager.install(id);manager.install(id);
  const changed=JSON.parse(readFileSync(settings,'utf8'));changed.statusLine.command='printf changed';writeFileSync(settings,JSON.stringify(changed));
  assert.equal(manager.status().targets[0]?.state,'conflict');
  assert.throws(()=>manager.remove(id),/changed outside/);
  assert.equal(JSON.parse(readFileSync(settings,'utf8')).statusLine.command,'printf changed');
 }finally{rmSync(home,{recursive:true,force:true});}
});
