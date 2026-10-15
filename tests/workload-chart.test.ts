import test from 'node:test';
import assert from 'node:assert/strict';
import {workloadAreaPath,workloadHeight} from '../src/ui/workload-chart.ts';

test('adjacent concurrency levels form one stepped area while evidence gaps remain separate',()=>{
 const path=workloadAreaPath([
  {start:0,end:10,roots:1,children:0,total:1},
  {start:10,end:20,roots:1,children:3,total:4},
  {start:25,end:30,roots:1,children:0,total:1},
 ],0,40);
 assert.equal(path,'M0 56V46H250H250V30H500V56ZM625 56V46H750V56Z');
 assert.equal((path.match(/M/g)||[]).length,2);
 assert.ok(workloadHeight(1)<workloadHeight(4));
 assert.ok(workloadHeight(4)<workloadHeight(30));
});

test('workload shape clips segments to the visible timeline',()=>{
 assert.equal(workloadAreaPath([{start:-10,end:10,roots:1,children:0,total:1}],0,20),'M0 56V46H500V56Z');
 assert.equal(workloadAreaPath([],0,20),'');
});
