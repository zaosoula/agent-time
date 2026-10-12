import { object } from './orca.ts';
interface Controller { status():unknown; summary():unknown; start(duration:number):Promise<unknown>; stop():Promise<unknown>; }
export async function dispatchRequest(payload:unknown,controller:Controller):Promise<Record<string,unknown>> {
  const request=object(payload),id=request.id;
  try{
    if(typeof id!=='string'||id.length>128)throw new Error('Invalid request ID');
    const params=object(request.params);
    if(request.method==='start') {
      if(Object.keys(params).some(k=>k!=='durationSeconds'))throw new Error('Unsupported parameter');
      const duration=params.durationSeconds;
      if(typeof duration!=='number'||!Number.isFinite(duration)||duration<1||duration>86400)throw new Error('Invalid capture duration');
      return {id,result:await controller.start(duration)};
    }
    if(Object.keys(params).length)throw new Error('Unsupported parameter');
    if(request.method==='status')return {id,result:controller.status()};
    if(request.method==='summary')return {id,result:controller.summary()};
    if(request.method==='stop')return {id,result:await controller.stop()};
    throw new Error('Unknown method');
  }catch(error){return {id:typeof id==='string'?id:null,error:String(error)};}
}
