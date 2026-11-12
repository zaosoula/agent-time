import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {billingForProject,type BillingRequest,type BillingReply} from './billing-service.ts';
import type {BillingProgress} from './billing-progress.ts';
/** Keep long report reductions off the capture event loop; SQLite reads use a stable WAL snapshot. */
export function runBillingReport(output:string,request:BillingRequest,onProgress?:(progress:BillingProgress)=>void):Promise<BillingReply>{
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL(import.meta.url),{workerData:{output,request}});let settled=false;
  worker.on('message',(reply:{progress?:BillingProgress;result?:BillingReply;error?:string})=>{
   if(settled)return;
   if(reply.progress){onProgress?.(reply.progress);return;}
   settled=true;if(reply.error)reject(new Error(reply.error));else if(reply.result)resolve(reply.result);else reject(new Error('Invalid billing worker response'));
  });
  worker.once('error',error=>{settled=true;reject(error);});worker.once('exit',code=>{if(!settled)reject(new Error(`Billing worker exited before replying (${code})`));});
 });
}
/** Retain only small progress records. Never retain reports or event payloads here. */
export class BillingReports {
 private jobs=new Map<string,{at:number;progress:BillingProgress}>();
 private active=false;
 private output:string;
 constructor(output:string){this.output=output;}
 progress(id:string):BillingProgress|null{this.prune();return this.jobs.get(id)?.progress||null;}
 private prune(){for(const [id,job] of this.jobs)if(Date.now()-job.at>10*60_000&&['complete','failed'].includes(job.progress.phase))this.jobs.delete(id);}
 async run(request:BillingRequest):Promise<BillingReply>{
  if(this.active)throw new Error('A billing report is already running. Wait for it to finish before starting another.');
  this.prune();const id=request.progressId;
  if(id&&this.jobs.has(id))throw new Error('Billing progress ID already used');
  this.active=true;
  const update=(progress:BillingProgress)=>{if(id){this.jobs.set(id,{at:Date.now(),progress});while(this.jobs.size>8)this.jobs.delete(this.jobs.keys().next().value!);}};
  update({phase:'reading',completedDays:0,totalDays:0});
  try{const reply=await runBillingReport(this.output,request,update);const last=id?this.jobs.get(id)?.progress:undefined;update({phase:'complete',completedDays:last?.totalDays||0,totalDays:last?.totalDays||0});return reply;}
  catch(error){const last=id?this.jobs.get(id)?.progress:undefined;update({...last,phase:'failed',completedDays:last?.completedDays||0,totalDays:last?.totalDays||0});throw error;}
  finally{this.active=false;}
 }
}
if(!isMainThread){try{parentPort!.postMessage({result:billingForProject(workerData.output,workerData.request,progress=>parentPort!.postMessage({progress}))});}catch(error){parentPort!.postMessage({error:error instanceof Error?error.message:String(error)});}}
