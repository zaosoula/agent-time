import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {resolveProjectPath} from '../src/capture/project-path.ts';

function repository(t: test.TestContext){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'agent-time paths ')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const main=join(dir,'principal checkout'),first=join(dir,'sibling one'),second=join(dir,'sibling two');
 const git=(...args:string[])=>execFileSync('/usr/bin/git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git('init',main);git('-C',main,'-c','user.name=Test','-c','user.email=test@example.test','commit','--allow-empty','-m','initial');
 git('-C',main,'worktree','add','-b','first',first);git('-C',main,'worktree','add','-b','second',second);
 return {dir,main,first,second,git};
}
test('ordinary sibling worktrees and nested project paths map to the principal checkout',t=>{
 const {main,first,second}=repository(t);
 mkdirSync(join(first,'packages','client'),{recursive:true});mkdirSync(join(main,'packages','client'),{recursive:true});
 assert.equal(resolveProjectPath(first),main);assert.equal(resolveProjectPath(second),main);
 assert.equal(resolveProjectPath(join(first,'packages','client')),join(main,'packages','client'));
 assert.equal(resolveProjectPath(join(main,'packages','client')),join(main,'packages','client'));
});
test('relative gitdir links resolve and remote hosts never inspect local git metadata',t=>{
 const {main,first}=repository(t);const file=join(first,'.git');
 const gitdir=readFileSync(file,'utf8').trim().slice(8);
 writeFileSync(file,`gitdir: ${relative(first,gitdir)}\n`);
 assert.equal(resolveProjectPath(first,{hostId:'remote-host'}),first);
 assert.equal(resolveProjectPath(first,{hostId:'local'}),main);
});
test('missing paths remain honest after worktree deletion and bounded cache pressure',t=>{
 const {dir,main,first,git}=repository(t);assert.equal(resolveProjectPath(first),main);
 git('-C',main,'worktree','remove',first);
 assert.equal(resolveProjectPath(first),first);
 for(let i=0;i<600;i++)assert.equal(resolveProjectPath(join(dir,`missing-${i}`)),join(dir,`missing-${i}`));
 assert.equal(resolveProjectPath(first),first);
});
test('separate git directories resolve principal paths without flattening ordinary repositories',t=>{
 const {dir,git}=repository(t),main=join(dir,'separate'),metadata=join(dir,'metadata'),linked=join(dir,'separate linked');
 git('init','--separate-git-dir',metadata,main);git('-C',main,'-c','user.name=Test','-c','user.email=test@example.test','commit','--allow-empty','-m','initial');
 git('-C',main,'worktree','add','-b','other',linked);
 assert.equal(resolveProjectPath(main),main);assert.equal(resolveProjectPath(linked),linked);
 // Separate git dirs do not necessarily retain the principal checkout location.
 // An explicit core.worktree makes that evidence available to Git.
 git('-C',main,'config','core.worktree',main);
 const newer=join(dir,'separate linked newer');git('-C',main,'worktree','add','-b','newer',newer);
 assert.equal(resolveProjectPath(newer),main);
});

test('positive and negative caches expire and evict old paths under bounded pressure',t=>{
 const {dir,main,first}=repository(t),file=join(first,'.git'),original=readFileSync(file,'utf8');
 const actualNow=Date.now();let now=actualNow;t.mock.method(Date,'now',()=>now);
 assert.equal(resolveProjectPath(first),main);rmSync(file);
 assert.equal(resolveProjectPath(first),main,'positive result is reused without Git');
 now+=60_001;assert.equal(resolveProjectPath(first),first,'positive TTL expires');
 writeFileSync(file,original);assert.equal(resolveProjectPath(first),first,'negative result is cached');
 now+=5_001;assert.equal(resolveProjectPath(first),main,'negative TTL expires');
 rmSync(file);
 for(let index=0;index<256;index++){
  const path=join(dir,`existing-${index}`);mkdirSync(path);assert.equal(resolveProjectPath(path),path);
 }
 assert.equal(resolveProjectPath(first),first,'old positive result evicted at cache limit');
 writeFileSync(file,original);
 for(let index=0;index<256;index++)resolveProjectPath(join(dir,`existing-${index}`));
 assert.equal(resolveProjectPath(first),main,'old negative result evicted at cache limit');
});

test('the explicit local execution host is compatible and unrelated hosts stay raw',t=>{
 const {main,first}=repository(t),previous=process.env.ORCA_EXECUTION_HOST_ID;
 process.env.ORCA_EXECUTION_HOST_ID='local-execution-uuid';
 t.after(()=>{if(previous===undefined)delete process.env.ORCA_EXECUTION_HOST_ID;else process.env.ORCA_EXECUTION_HOST_ID=previous;});
 assert.equal(resolveProjectPath(first,{hostId:'local-execution-uuid'}),main);
 assert.equal(resolveProjectPath(first,{hostId:'different-execution-uuid'}),first);
});
