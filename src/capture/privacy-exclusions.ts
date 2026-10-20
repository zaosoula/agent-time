import {existsSync,lstatSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export interface PrivacyExclusion {kind:'app'|'site';value:string;}
export function validateExclusions(value:unknown):PrivacyExclusion[]{
 if(!Array.isArray(value)||value.length>100)throw new Error('Invalid privacy exclusions');
 const seen=new Set<string>();
 return value.map(item=>{
  if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join(',')!=='kind,value')throw new Error('Invalid privacy exclusion');
  const {kind,value:raw}=item as Record<string,unknown>;
  if(kind!=='app'&&kind!=='site'||typeof raw!=='string'||raw.length<1||raw.length>253)throw new Error('Invalid privacy exclusion');
  const normalized=kind==='site'?raw.toLowerCase():raw;
  if(kind==='app'?!/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(normalized):!/^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/.test(normalized))throw new Error('Use an exact app bundle ID or website hostname');
  const key=`${kind}:${normalized}`;if(seen.has(key))throw new Error('Duplicate privacy exclusion');seen.add(key);
  return {kind,value:normalized} as PrivacyExclusion;
 });
}
export function isExcluded(payload:Record<string,unknown>,list:PrivacyExclusion[]):boolean{
 const app=payload.foregroundBundleId;
 if(typeof app==='string'&&list.some(item=>item.kind==='app'&&item.value===app))return true;
 const url=payload.browserUrl;
 if(typeof url==='string')try{
  const hostname=new URL(url).hostname.toLowerCase();
  return list.some(item=>item.kind==='site'&&item.value===hostname);
 }catch{/* A separate domain observation may still be available. */}
 const domain=payload.browserDomain;
 if(typeof domain==='string')return list.some(item=>item.kind==='site'&&item.value===domain.toLowerCase());
 return false;
}
function hasObservedSite(payload:Record<string,unknown>):boolean{
 if(typeof payload.browserUrl==='string')try{if(new URL(payload.browserUrl).hostname)return true;}catch{}
 return typeof payload.browserDomain==='string'&&/^(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i.test(payload.browserDomain);
}
export class PrivacyExclusions {
 private path:string;private entries:PrivacyExclusion[];
 constructor(output:string){
  this.path=join(output,'privacy-exclusions.json');
  if(existsSync(this.path)&&lstatSync(this.path).isSymbolicLink())throw new Error('Privacy exclusions file must not be a symlink');
  this.entries=existsSync(this.path)?validateExclusions(JSON.parse(readFileSync(this.path,'utf8'))):[];
 }
 list():PrivacyExclusion[]{return this.entries.map(item=>({...item}));}
 matches(payload:Record<string,unknown>,browserForeground=false):boolean{
  return isExcluded(payload,this.entries)||browserForeground&&this.entries.some(item=>item.kind==='site')&&!hasObservedSite(payload);
 }
 replace(value:unknown):PrivacyExclusion[]{
  const next=validateExclusions(value);
  if(existsSync(this.path)&&lstatSync(this.path).isSymbolicLink())throw new Error('Privacy exclusions file must not be a symlink');
  const temp=this.path+'.'+randomUUID()+'.tmp';
  writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{mode:0o600,flag:'wx'});
  renameSync(temp,this.path);this.entries=next;return this.list();
 }
}
