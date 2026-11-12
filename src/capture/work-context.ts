import type {CaptureEvent} from './events.ts';

/** Generic business metadata; native provider/session/child identity remains separate. */
export interface AgentIdentity {id:string;name?:string;role?:string;}
export type WorkAttributes=Record<string,string>;
export interface WorkMetadata {
 agentIdentity?:AgentIdentity;agentProfile?:string;attributes?:WorkAttributes;
 metadataSource?:'launcher'|'agent-report'|'mixed';projectPath?:string;metadataWarning?:string;
}
export const MAX_WORK_ATTRIBUTES=16;
export const MAX_ATTRIBUTE_KEY=64;
export const MAX_ATTRIBUTE_VALUE=128;
export const MAX_ATTRIBUTE_BYTES=1024;
export const MAX_AGENT_REPORT_BYTES=4096;
export const invalidWorkMetadataWarning='Invalid work metadata omitted; timing observations retained';
const controls=/[\u0000-\u001f\u007f-\u009f]/;
const forbiddenKeys=new Set(['__proto__','prototype','constructor']);
const encoder=new TextEncoder();
function record(value:unknown):value is Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const prototype=Object.getPrototypeOf(value);return prototype===Object.prototype||prototype===null;
}
function boundedText(value:unknown,max:number,empty=false):value is string{
 return typeof value==='string'&&(empty||value.trim().length>0)&&[...value].length<=max&&!controls.test(value);
}
/** Validate the declaration itself, retaining empty-string deletion markers. */
export function validateAttributes(value:unknown):WorkAttributes{
 if(!record(value))throw new Error('Invalid work attributes');
 const entries=Object.entries(value);if(entries.length>MAX_WORK_ATTRIBUTES)throw new Error('Too many work attributes');
 const result:WorkAttributes={};
 for(const [rawKey,item] of entries.sort(([a],[b])=>a.toLowerCase().localeCompare(b.toLowerCase()))){
  const key=rawKey.toLowerCase();
  if(key.length>MAX_ATTRIBUTE_KEY||! /^[a-z][a-z0-9_.-]*$/.test(key)||forbiddenKeys.has(key)||Object.hasOwn(result,key)||!boundedText(item,MAX_ATTRIBUTE_VALUE,true))throw new Error('Invalid work attribute');
  result[key]=item;
 }
 if(encoder.encode(JSON.stringify(result)).byteLength>MAX_ATTRIBUTE_BYTES)throw new Error('Work attributes exceed byte limit');
 return result;
}
export function validateAgentIdentity(value:unknown):AgentIdentity{
 if(!record(value)||!boundedText(value.id,128)||Object.keys(value).some(key=>!['id','name','role'].includes(key)))throw new Error('Invalid agent identity');
 const result:AgentIdentity={id:value.id};
 for(const key of ['name','role'] as const)if(value[key]!==undefined){if(!boundedText(value[key],128))throw new Error('Invalid agent identity');result[key]=value[key];}
 return result;
}
/** Launcher baseline → preceding declaration → explicit task overrides. */
export function applyWorkAttributes(base?:WorkAttributes,overrides?:WorkAttributes):WorkAttributes{
 const result=validateAttributes(base??{});
 for(const [key,value] of Object.entries(validateAttributes(overrides??{}))){if(value==='')delete result[key];else result[key]=value;}
 for(const key of Object.keys(result))if(result[key]==='')delete result[key];
 return validateAttributes(result);
}
/** Invalid opt-in context is non-fatal, and warnings never include rejected values. */
export function readLauncherContext(env:NodeJS.ProcessEnv=process.env):WorkMetadata{
 const result:WorkMetadata={};let invalid=false;
 if(env.AGENT_TIME_AGENT_ID!==undefined)try{result.agentIdentity=validateAgentIdentity({id:env.AGENT_TIME_AGENT_ID});}catch{invalid=true;}
 const attrs:Record<string,unknown>={};let count=0;
 // Scan names only: unrelated environment values are never read or copied.
 for(const key of Object.keys(env))if(key.startsWith('AGENT_TIME_ATTR_')){
  if(++count>MAX_WORK_ATTRIBUTES){invalid=true;break;}
  // Keep original case until validation so aliases cannot silently overwrite.
  const suffix=key.slice('AGENT_TIME_ATTR_'.length);
  Object.defineProperty(attrs,suffix,{value:env[key],enumerable:true,configurable:true});
 }
 if(count)try{if(count>MAX_WORK_ATTRIBUTES)throw new Error('limit');result.attributes=validateAttributes(attrs);}catch{invalid=true;}
 if(result.agentIdentity||result.attributes)result.metadataSource='launcher';
 if(invalid)result.metadataWarning=invalidWorkMetadataWarning;
 return result;
}
/** Read only approved metadata; malformed historical rows cannot discard timings. */
export function eventWorkMetadata(event:Pick<CaptureEvent,'data'|'projectPath'>):WorkMetadata{
 const result:WorkMetadata={},data=event.data;let invalid=false;
 if(data?.agentIdentity!==undefined)try{result.agentIdentity=validateAgentIdentity(data.agentIdentity);}catch{invalid=true;}
 if(data?.attributes!==undefined)try{result.attributes=validateAttributes(data.attributes);}catch{invalid=true;}
 // Native provider agent_type describes a profile; it is never a business ID.
 const profile=data?.childType??data?.agentProfile;
 if(profile!==undefined){if(boundedText(profile,128))result.agentProfile=profile;else invalid=true;}
 if(['launcher','agent-report','mixed'].includes(String(data?.metadataSource)))result.metadataSource=data!.metadataSource as WorkMetadata['metadataSource'];
 if(typeof event.projectPath==='string')result.projectPath=event.projectPath;
 if(invalid||data?.metadataWarning!==undefined)result.metadataWarning=invalidWorkMetadataWarning;
 return result;
}
