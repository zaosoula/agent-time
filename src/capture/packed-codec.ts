import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';

export const MAX_BLOCK_EVENTS=2048;
export const MAX_BLOCK_BYTES=2*1024*1024;
export const MAX_CODEC_BYTES=4*1024*1024;
export const MAX_COMPRESSED_BYTES=MAX_CODEC_BYTES+65536;
type ObjectValue=Record<string,unknown>;
type Shape=[string[],string[]|null];
type Part=[number,number,unknown[],unknown[]];
type RawRecord=[0,number,string];
type SharedRecord=[1|2|3,ObjectValue,ObjectValue,Part[]];
type RecordValue=RawRecord|SharedRecord;
interface Format {version:1;count:number;bytes:number;shapes:Shape[];records:RecordValue[];}
export interface PackedBlock {data:Buffer;key:string;originalBytes:number;count:number;records:{toolCalls:number;activityRuns:number;workerRuns:number};}
const object=(value:unknown):value is ObjectValue=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=Object.hasOwn;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const map=():ObjectValue=>Object.create(null) as ObjectValue;
const volatile=new Set(['eventId','observedAt','monotonicAt','collectorEpoch','sourceAt']);
const digest=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
function canonical(payload:string):ObjectValue|null{
 try{
  const event:unknown=JSON.parse(payload);
  if(!object(event)||JSON.stringify(event)!==payload||Object.keys(event).length>256)return null;
  if(own(event,'data')&&(!object(event.data)||Object.keys(event.data).length>1024))return null;
  return event;
 }catch{return null;}
}
/** Only identity-complete boundaries are eligible; a caller additionally checks
 * the identity's uniqueness over the entire database, including other blocks. */
export function toolIdentity(event:ObjectValue):string|null{
 const data=event.data;
 if(event.source!=='hook'||!['tool_start','tool_end'].includes(String(event.kind))||!object(data))return null;
 if(![event.hostId,event.provider,event.sessionId,data.toolId].every(value=>typeof value==='string'&&value.length>0))return null;
 return JSON.stringify([event.provider,event.hostId,event.sessionId,event.agentId,data.toolId]);
}
function context(event:ObjectValue,activity:boolean):string{
 const state=map();for(const [key,value] of Object.entries(event))if(!volatile.has(key)&&key!=='data')state[key]=value;
 const data=map();if(object(event.data))for(const [key,value] of Object.entries(event.data))if(!activity||key!=='idleSeconds')data[key]=value;
 return JSON.stringify([state,data,activity?event.collectorEpoch:null]);
}
function common(events:ObjectValue[],data:boolean):ObjectValue{
 const result=map(),first=data?events[0]!.data as ObjectValue:events[0]!;
 for(const [key,value] of Object.entries(first)){
  if(!data&&key==='data')continue;
  if(events.every(event=>{const item=data?event.data:event;return object(item)&&own(item,key)&&same(item[key],value);}))result[key]=value;
 }
 return result;
}
export function encodeEventBlock(payloads:string[],toolPairs:Array<[number,number]>=[]):PackedBlock{
 if(!payloads.length||payloads.length>MAX_BLOCK_EVENTS)throw new Error('Packed block count is outside its limit');
 const bytes=payloads.reduce((n,value)=>n+Buffer.byteLength(value),0);
 if(bytes>MAX_BLOCK_BYTES)throw new Error('Packed block payload bytes exceed the size limit');
 const events=payloads.map(canonical),used=new Uint8Array(payloads.length),shapes:Shape[]=[],shapeIds=new Map<string,number>(),records:RecordValue[]=[];
 const stats={toolCalls:0,activityRuns:0,workerRuns:0};
 const shape=(event:ObjectValue)=>{
  const value:Shape=[Object.keys(event),object(event.data)?Object.keys(event.data):null],key=JSON.stringify(value);
  let id=shapeIds.get(key);if(id===undefined){id=shapes.length;shapeIds.set(key,id);shapes.push(value);}return id;
 };
 const shared=(kind:1|2|3,slots:number[])=>{
  const group=slots.map(slot=>events[slot]!),root=common(group,false),data=group.every(event=>object(event.data))?common(group,true):map();
  const parts:Part[]=slots.map(slot=>{
   const event=events[slot]!,shapeId=shape(event),[keys,dataKeys]=shapes[shapeId]!;
   return [slot,shapeId,keys.filter(key=>key!=='data'&&!own(root,key)).map(key=>event[key]),(dataKeys||[]).filter(key=>!own(data,key)).map(key=>(event.data as ObjectValue)[key])];
  });
  records.push([kind,root,data,parts]);for(const slot of slots)used[slot]=1;
  if(kind===1)stats.toolCalls++;else if(kind===2)stats.activityRuns++;else stats.workerRuns++;
 };
 const identities=new Map<string,number>();for(const event of events)if(event){const id=toolIdentity(event);if(id)identities.set(id,(identities.get(id)||0)+1);}
 for(const [a,b] of toolPairs){
  if(!Number.isInteger(a)||!Number.isInteger(b)||a<0||b<0||a>=events.length||b>=events.length||a===b)throw new Error('Invalid packed tool boundary slots');
  if(used[a]||used[b])continue;
  const first=events[a],last=events[b];if(!first||!last)continue;
  const id=toolIdentity(first);
  if(!id||id!==toolIdentity(last)||identities.get(id)!==2||first.kind!=='tool_start'||last.kind!=='tool_end'||typeof first.observedAt!=='number'||typeof last.observedAt!=='number'||last.observedAt<first.observedAt)continue;
  shared(1,[a,b]);
 }
 let activity:{key:string;at:number;slots:number[]}|undefined;
 const activities:Array<number[]>=[],workers=new Map<string,number[]>();
 for(let slot=0;slot<events.length;slot++){
  if(used[slot])continue;const event=events[slot];if(!event||!object(event.data))continue;
  if(event.source==='macos'&&event.kind==='activity'&&typeof event.observedAt==='number'){
   const key=context(event,true),at=event.observedAt;
   if(activity&&activity.key===key&&at>activity.at&&at-activity.at<=15){activity.slots.push(slot);activity.at=at;}
   else{activity={key,at,slots:[slot]};activities.push(activity.slots);}
  }else if(event.source==='orca'&&event.kind==='worker'&&event.data.fresh===false){
   const key=context(event,false),group=workers.get(key)||[];group.push(slot);workers.set(key,group);
  }
 }
 for(const slots of activities)if(slots.length>1)shared(2,slots);
 for(const slots of workers.values())if(slots.length>1)shared(3,slots);
 for(let slot=0;slot<payloads.length;slot++)if(!used[slot])records.push([0,slot,payloads[slot]!]);
 const format:Format={version:1,count:payloads.length,bytes,shapes,records},body=Buffer.from(JSON.stringify(format));
 if(body.length>MAX_CODEC_BYTES)throw new Error('Packed codec size exceeds its limit');
 const data=gzipSync(body,{level:6});return {data,key:digest(data),originalBytes:bytes,count:payloads.length,records:stats};
}
function invalid():never{throw new Error('Corrupt packed event format');}
function keys(value:unknown):value is string[]{return Array.isArray(value)&&value.length<=1024&&value.every(key=>typeof key==='string')&&new Set(value).size===value.length;}
export function decodeEventBlock(data:Uint8Array,expectedKey:string):string[]{
 if(data.byteLength>MAX_COMPRESSED_BYTES)throw new Error('Compressed block size exceeds its limit');
 if(!/^[a-f0-9]{64}$/.test(expectedKey)||digest(data)!==expectedKey)throw new Error('Packed block digest mismatch');
 let value:unknown;
 try{value=JSON.parse(gunzipSync(data,{maxOutputLength:MAX_CODEC_BYTES}).toString('utf8'));}catch{throw new Error('Corrupt packed block or decompression size limit exceeded');}
 if(!object(value)||value.version!==1||!Number.isInteger(value.count)||Number(value.count)<1||Number(value.count)>MAX_BLOCK_EVENTS||!Number.isInteger(value.bytes)||Number(value.bytes)<0||Number(value.bytes)>MAX_BLOCK_BYTES||!Array.isArray(value.shapes)||value.shapes.length>MAX_BLOCK_EVENTS||!Array.isArray(value.records)||value.records.length>MAX_BLOCK_EVENTS)invalid();
 const format=value as unknown as Format,rows:string[]=new Array(format.count),seen=new Uint8Array(format.count);let total=0;
 for(const shape of format.shapes)if(!Array.isArray(shape)||shape.length!==2||!keys(shape[0])||shape[0].length>256||shape[1]!==null&&!keys(shape[1]))invalid();
 const place=(slot:unknown,payload:unknown)=>{
  if(!Number.isInteger(slot)||Number(slot)<0||Number(slot)>=rows.length||seen[Number(slot)]||typeof payload!=='string')invalid();
  total+=Buffer.byteLength(payload);if(total>MAX_BLOCK_BYTES)throw new Error('Packed payload expansion exceeds size limit');
  rows[Number(slot)]=payload;seen[Number(slot)]=1;
 };
 for(const record of format.records){
  if(!Array.isArray(record))invalid();
  if(record[0]===0){if(record.length!==3)invalid();place(record[1],record[2]);continue;}
  if(![1,2,3].includes(record[0])||record.length!==4||!object(record[1])||!object(record[2])||!Array.isArray(record[3])||record[3].length>MAX_BLOCK_EVENTS)invalid();
  const [,root,data,parts]=record as SharedRecord;
  for(const part of parts){
   if(!Array.isArray(part)||part.length!==4||!Number.isInteger(part[1])||!Array.isArray(part[2])||!Array.isArray(part[3]))invalid();
   const [slot,id,rootValues,dataValues]=part,shape=format.shapes[id];if(!shape)invalid();
   const result=map();let r=0,d=0;
   for(const key of shape[0]){
    if(key==='data'){
     if(shape[1]===null)invalid();const detail=map();
     for(const name of shape[1]){if(own(data,name))detail[name]=data[name];else{if(d>=dataValues.length)invalid();detail[name]=dataValues[d++];}}
     result.data=detail;
    }else if(own(root,key))result[key]=root[key];
    else{if(r>=rootValues.length)invalid();result[key]=rootValues[r++];}
   }
   if(r!==rootValues.length||d!==dataValues.length)invalid();
   place(slot,JSON.stringify(result));
  }
 }
 if(total!==format.bytes||seen.some(value=>value!==1))invalid();
 return rows;
}
