import { execFile } from 'node:child_process';
import {accessSync,constants,statSync} from 'node:fs';
import {delimiter,join} from 'node:path';
import { promisify } from 'node:util';
import { makeEvent, type CaptureEvent, type Issue } from './events.ts';
import {informativeWorker} from './observation-retention.ts';
const exec = promisify(execFile);
import { object, type JsonObject } from './json.ts';
export { object, type JsonObject };
export function orcaCliAvailable(command=process.env.ORCA_CLI_COMMAND||'orca',path=process.env.PATH||''):boolean{
  const executable=(file:string)=>{try{accessSync(file,constants.X_OK);return statSync(file).isFile();}catch{return false;}};
  return command.includes('/')?executable(command):path.split(delimiter).some(folder=>executable(join(folder||'.',command)));
}
export async function callOrca(argv: string[]): Promise<unknown> {
  const command = process.env.ORCA_CLI_COMMAND || 'orca';
  const { stdout } = await exec(command, argv, { timeout: 12000, maxBuffer: 8*1024*1024 });
  return JSON.parse(stdout);
}
export async function readWorkers(call: (argv: string[]) => Promise<unknown> = callOrca, runId?: string, canContinue=()=>true): Promise<{ workers: JsonObject[]; coverage: Issue[] }> {
  const workers: JsonObject[] = [], coverage: Issue[] = [], seen = new Set<string>(); let cursor: string | undefined;
  try {
    do {
      if(!canContinue())throw new Error('Collection cancelled');
      const argv = ['orchestration','worker-list','--limit','100','--json'];
      if (runId) argv.push('--run',runId); if (cursor) argv.push('--cursor',cursor);
      const receipt = object(await call(argv)); if (!receipt.ok) throw new Error('Orca worker read failed');
      const r = object(receipt.result);
      if (!Array.isArray(r.workers)) throw new Error('invalid worker receipt');
      workers.push(...r.workers.map(object));
      const scope = object(r.hostScope || r.scope);
      for (const host of scope.omittedHostIds || []) coverage.push({ reason: `Host not covered: ${host}`, source: 'orca' });
      if (!r.page?.hasMore) break;
      cursor = r.page.nextCursor;
      if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) throw new Error('missing or repeated pagination cursor');
      seen.add(cursor);
    } while (true);
  } catch (error) { coverage.push({ reason: String(error), source: 'orca' }); }
  return { workers, coverage };
}
export function workerEvent(worker: JsonObject): CaptureEvent {
  const p = object(worker.projection), resource = object(worker.resource), stage = object(p.stage), evidence = object(p.evidence);
  return makeEvent('orca','worker',{
    hostId: p.host?.id, workspaceId: p.workspace?.id || resource.worktreeId,
    terminalHandle: worker.agentTerminalHandle || resource.terminalHandle,
    terminalIncarnation: resource.endpointIncarnation, runtimeId: resource.endpointId,
    provider: p.provider?.id, runId: worker.runId, taskId: worker.taskId, dispatchId: worker.dispatchId,
    data: { state: stage.activity || 'unknown', outcome: p.outcome || worker.dispatchStatus,
      fresh: evidence.liveStatus === 'fresh', terminalState: worker.terminalState,
      takeover: resource.retainedReason === 'user_takeover', parent: p.parent || null,
      liveness: p.liveness?.verdict || 'unverifiable' },
  });
}
const settledOutcomes=new Set(['succeeded','failed','completed','cancelled','abandoned']);
export {informativeWorker};
const finishedTerminal=new Set(['released','reclaimable']);
/**
 * Poll state kept between fleet reads. Run discovery lists every Run, and each
 * Run costs one worker-list call, so quiet Runs are re-read on a slower clock.
 */
export class FleetCache {
 runs:string[]=[];fullListAt=0;
 /** Run id -> when its workers were last read, and whether any was live then. */
 checked=new Map<string,{at:number;quiet:boolean;settled:boolean}>();
}
// Run-list is newest first: one page each tick finds new Runs; the full list is refreshed slowly.
const fullRunListMs=5*60_000;
// A Run with no fresh worker is re-read after this delay; hooks keep capturing meanwhile.
const quietRunMs=30_000;
// A Run whose workers have all settled is re-read only to notice reuse.
const settledRunMs=5*60_000;
function runState(workers:JsonObject[]){
 const events=workers.map(object);
 const fresh=events.some(worker=>object(object(worker.projection).evidence).liveStatus==='fresh');
 // A worker whose terminal is released or reclaimable cannot become live again
 // without Orca reporting a fresh status, so its Run is polled like a settled one.
 const settled=events.length>0&&events.every(worker=>{const p=object(worker.projection);return (settledOutcomes.has(String(p.outcome||worker.dispatchStatus))||finishedTerminal.has(String(worker.terminalState)))&&object(p.evidence).liveStatus!=='fresh';});
 return {quiet:!fresh,settled};
}
export async function readFleet(call: (argv:string[])=>Promise<unknown> = callOrca, canContinue=()=>true, cache?:FleetCache, now=Date.now()):Promise<{workers:JsonObject[];coverage:Issue[]}> {
  // A default worker-list can inherit whichever coordinator is selected in Orca.
  // Enumerate explicit Runs so switching tabs cannot silently narrow capture.
  const runs:string[]=[],coverage:Issue[]=[];let cursor:string|undefined;const seen=new Set<string>();
  const fullList=!cache||!cache.fullListAt||now-cache.fullListAt>=fullRunListMs;let complete=false,listed=false;
  try {
    do {
      if(!canContinue())throw new Error('Collection cancelled');
      const argv=['orchestration','run-list','--limit','100','--json'];if(cursor)argv.push('--cursor',cursor);
      const r=object(await call(argv));if(!r.ok||!Array.isArray(r.result?.runs))throw new Error('Run discovery unavailable');
      for(const run of r.result.runs)if(typeof run.id==='string')runs.push(run.id);
      listed=true;
      if(r.result.nextCursor===null||r.result.nextCursor===undefined){complete=true;break;}
      if(!fullList)break;
      cursor=String(r.result.nextCursor);if(seen.has(cursor))throw new Error('Repeated Run cursor');seen.add(cursor);
    }while(true);
  }catch(error){coverage.push({reason:String(error),source:'orca'});}
  let selected=[...new Set(runs)];
  if(cache&&listed){
    if(fullList&&complete){cache.runs=selected;cache.fullListAt=now;const current=new Set(runs);for(const id of [...cache.checked.keys()])if(!current.has(id))cache.checked.delete(id);}
    else cache.runs=[...new Set([...selected,...cache.runs])];
    selected=cache.runs.filter(id=>{
      const checked=cache.checked.get(id);
      if(!checked||!checked.quiet)return true;
      return now-checked.at>=(checked.settled?settledRunMs:quietRunMs);
    });
  }
  const workers:JsonObject[]=[];
  for(let offset=0;offset<selected.length;offset+=4){
    if(!canContinue())break;
    const ids=selected.slice(offset,offset+4);
    const batch=await Promise.all(ids.map(run=>readWorkers(call,run,canContinue)));
    batch.forEach((r,index)=>{
      workers.push(...r.workers);coverage.push(...r.coverage);
      if(cache){if(r.coverage.length)cache.checked.delete(ids[index]!);else cache.checked.set(ids[index]!,{at:now,...runState(r.workers)});}
    });
  }
  coverage.push({reason:'Only this Orca host is observed; remote execution has not been verified',source:'orca'});
  return {workers,coverage};
}
/** `read` may supply a shared terminal-list receipt (it can include visual layouts). */
export async function terminalEvents(call = callOrca, read?:()=>Promise<unknown>): Promise<CaptureEvent[]> {
  const receipt = object(read ? await read() : await call(['terminal','list','--limit','1000','--json']));
  if (!receipt.ok || !Array.isArray(receipt.result?.terminals)) throw new Error('Orca terminal metadata unavailable');
  const result: CaptureEvent[] = receipt.result.terminals.filter((t: JsonObject) => t.agentIdentity).map((t: JsonObject) => makeEvent('orca','terminal',{
    hostId: t.executionHostId, runtimeId: receipt._meta?.runtimeId, workspaceId: t.worktreeId,
    cwd: t.worktreePath, terminalHandle: t.handle, terminalIncarnation: t.incarnationId,
    provider: t.agentIdentity, data: { title: String(t.title || '').slice(0,180), connected: t.connected },
  }));
  if (receipt.result.truncated) result.push(makeEvent('orca','coverage',{data:{reason:'Terminal list truncated'}}));
  for (const host of receipt.result.hostScope?.omittedHostIds || []) result.push(makeEvent('orca','coverage',{data:{reason:`Host not covered: ${host}`}}));
  return result;
}
