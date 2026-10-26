import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localWorkOutcomes} from '../src/capture/work-outcomes.ts';
import type {Summary} from '../src/capture/events.ts';

test('local work evidence includes a detached observed worktree without attributing its commits to an agent',async()=>{
  const root=mkdtempSync(join(tmpdir(),'agent-time-work-outcomes-')),repo=join(root,'repo'),worktree=join(repo,'.orca','workspaces','agent');
  const git=(cwd:string,args:string[],date?:string)=>execFileSync('git',['-C',cwd,...args],{
    encoding:'utf8',env:{...process.env,...(date?{GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date}:{})},
  }).trim();
  const commit=(cwd:string,subject:string,date:string)=>{
    const filename=subject.replaceAll(' ','-');
    writeFileSync(join(cwd,filename),subject);
    git(cwd,['add',filename]);git(cwd,['-c','user.name=Test','-c','user.email=test@example.com','commit','-qm',subject],date);
  };
  try{
    mkdirSync(repo);git(repo,['init','-q','-b','main']);
    commit(repo,'main work','2026-10-20T10:00:00+02:00');
    git(repo,['worktree','add','--detach',worktree,'HEAD']);
    commit(worktree,'agent work','2026-10-20T11:00:00+02:00');
    const agentHead=git(worktree,['rev-parse','HEAD']);
    commit(worktree,'remote only','2026-10-20T11:30:00+02:00');
    git(repo,['update-ref','refs/remotes/origin/other',git(worktree,['rev-parse','HEAD'])]);
    git(worktree,['reset','--hard',agentHead]);
    commit(repo,'later work','2026-10-21T10:00:00+02:00');
    const at=new Date('2026-10-20T12:00:00+02:00').getTime()/1000;
    const summary:Summary={intervals:[{start:at,end:at+60,state:'grouped',proof:'observed',sourceEventIds:[],hostId:'local',workspaceId:`local::${worktree}`,sessionId:'session-1'}],sessions:[{key:'session-1',hostId:'local',workspaceId:`local::${worktree}`,cwd:worktree,sessionId:'session-1',title:'Agent',state:'complete',lastObservedAt:at,seconds:60,observedSeconds:60,child:false,proof:'observed'}],coverage:[],unresolved:[],humanSeconds:0,agentSeconds:0,elapsedSeconds:0,childAgentSeconds:0};
    const result=await localWorkOutcomes(summary,'2026-10-20');
    assert.equal(result.gitAvailable,true);
    assert.equal(result.projects.length,1);
    assert.equal(result.projects[0]?.projectPath,repo);
    assert.deepEqual(result.projects[0]?.branches,['main']);
    assert.deepEqual(result.projects[0]?.commits.map(item=>item.subject),['agent work','main work']);
    assert.equal(result.skippedProjects,0);
    await assert.rejects(localWorkOutcomes(summary,'2026-02-30'),/Invalid summary date/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
