import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,utimesSync,existsSync,symlinkSync,rmSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pruneHookRuntimes} from '../src/capture/hook-runtime-prune.ts';

const now=1_800_000_000_000;
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'agent-time-runtime-prune-'));
 const add=(name:string,age:number)=>{
  const dir=join(root,name);mkdirSync(join(dir,'sources'),{recursive:true});
  for(const file of ['node','hook-runner.ts','package.json'])writeFileSync(join(dir,file),'owned');
  writeFileSync(join(dir,'sources','agent-registry.ts'),'owned');
  utimesSync(dir,new Date(now-age),new Date(now-age));return dir;
 };
 return {root,add,done:()=>rmSync(root,{recursive:true,force:true})};
}

test('pruning keeps the current and newest previous runtime and unrecognized data',async()=>{
 const f=fixture();
 try{
  const old=f.add('1111111111111111',2*60*60*1000);
  const replaced=f.add('2222222222222222-replaced-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',2*60*60*1000);
  const previous=f.add('3333333333333333',90*60*1000);
  const current=f.add('4444444444444444',10*60*1000);
  const foreign=f.add('6666666666666666',3*60*60*1000);writeFileSync(join(foreign,'personal.txt'),'retain');
  symlinkSync(old,join(f.root,'7777777777777777'));
  assert.equal(await pruneHookRuntimes(f.root,'4444444444444444',{now,activeCommands:''}),2);
  assert.equal(existsSync(old),false);assert.equal(existsSync(replaced),false);
  for(const path of [previous,current,foreign])assert.equal(existsSync(path),true);
  assert.equal(lstatSync(join(f.root,'7777777777777777')).isSymbolicLink(),true);
 }finally{f.done();}
});

test('pruning waits for an active hook process and refuses an invalid current runtime',async()=>{
 const f=fixture();
 try{
  const old=f.add('1111111111111111',2*60*60*1000);
  f.add('2222222222222222',10*60*1000);
  f.add('3333333333333333',5*60*1000);
  const recent=f.add('4444444444444444',20*60*1000);
  assert.equal(await pruneHookRuntimes(f.root,'3333333333333333',{now,activeCommands:`${old}/node ${old}/hook-runner.ts`}),0);
  assert.equal(existsSync(old),true);
  assert.equal(existsSync(recent),true);
  assert.equal(await pruneHookRuntimes(f.root,'not-a-runtime',{now,activeCommands:''}),0);
  assert.equal(existsSync(old),true);
 }finally{f.done();}
});
