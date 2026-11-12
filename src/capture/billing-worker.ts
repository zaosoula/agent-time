import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {billingForProject,type BillingRequest,type BillingReply} from './billing-service.ts';
/** Keep long report reductions off the capture event loop; SQLite reads use a stable WAL snapshot. */
export function runBillingReport(output:string,request:BillingRequest):Promise<BillingReply>{
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL(import.meta.url),{workerData:{output,request}});let settled=false;
  worker.once('message',(reply:{result?:BillingReply;error?:string})=>{settled=true;if(reply.error)reject(new Error(reply.error));else if(reply.result)resolve(reply.result);else reject(new Error('Invalid billing worker response'));});
  worker.once('error',error=>{settled=true;reject(error);});worker.once('exit',code=>{if(!settled)reject(new Error(`Billing worker exited before replying (${code})`));});
 });
}
if(!isMainThread){try{parentPort!.postMessage({result:billingForProject(workerData.output,workerData.request)});}catch(error){parentPort!.postMessage({error:error instanceof Error?error.message:String(error)});}}
