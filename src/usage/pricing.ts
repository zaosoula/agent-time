import bundled from './catalog.json' with {type:'json'};
import type {Counts} from './parser.ts';

export interface ModelRates {input:number;output:number;cacheRead:number;cacheWrite:number;cacheWrite1h:number;}
export interface PricingCatalog {
 schemaVersion:1;version:string;verifiedAt:string;currency:'USD';unit:'millionTokens';basis:'standard-short-context-global';sources:string[];models:Record<string,ModelRates>;
}
const officialSources=['https://developers.openai.com/api/docs/pricing','https://platform.claude.com/docs/en/about-claude/pricing'];
export function validateCatalog(value:unknown):PricingCatalog {
 const c=value as PricingCatalog;
 if(!c||c.schemaVersion!==1||!/^\d{4}-\d{2}-\d{2}-[a-zA-Z0-9-]{1,80}$/.test(c.version)||!/^\d{4}-\d{2}-\d{2}$/.test(c.verifiedAt)||!Number.isFinite(Date.parse(c.verifiedAt))||new Date(c.verifiedAt).toISOString().slice(0,10)!==c.verifiedAt||Date.parse(c.verifiedAt)>Date.now()+86400000||c.currency!=='USD'||c.unit!=='millionTokens'||c.basis!=='standard-short-context-global')throw new Error('Unsupported pricing catalog');
 if(!Array.isArray(c.sources)||c.sources.length!==2||!officialSources.every(s=>c.sources.includes(s)))throw new Error('Pricing catalog must cite both official sources');
 if(!c.models||typeof c.models!=='object'||Array.isArray(c.models)||!Object.keys(c.models).length||Object.keys(c.models).length>2000)throw new Error('Invalid pricing models');
 const models:Record<string,ModelRates>={};
 for(const [model,r] of Object.entries(c.models)){
  if(!/^(gpt|o[1-9]|claude)[a-z0-9.-]*$/.test(model)||!r||Object.keys(r).length!==5)throw new Error('Invalid model rates');
  for(const k of ['input','output','cacheRead','cacheWrite','cacheWrite1h'] as const)if(typeof r[k]!=='number'||!Number.isFinite(r[k])||r[k]<0||r[k]>100000)throw new Error('Invalid token price');
  models[model]={input:r.input,output:r.output,cacheRead:r.cacheRead,cacheWrite:r.cacheWrite,cacheWrite1h:r.cacheWrite1h};
 }
 return {schemaVersion:1,version:c.version,verifiedAt:c.verifiedAt,currency:'USD',unit:'millionTokens',basis:'standard-short-context-global',sources:[...officialSources],models};
}
export const bundledCatalog=validateCatalog(bundled);
export const pricingCheckedAt=bundledCatalog.verifiedAt;
export const pricingSources=bundledCatalog.sources;
export function apiEquivalent(model:string,c:Counts,catalog:PricingCatalog=bundledCatalog):number|null{
 const p=catalog.models[model.replace(/-\d{8}$/,'')];if(!p)return null;
 const oneHour=Math.min(c.cacheWrite,c.cacheWrite1h);
 return (c.input*p.input+c.output*p.output+c.cacheRead*p.cacheRead+(c.cacheWrite-oneHour)*p.cacheWrite+oneHour*p.cacheWrite1h)/1e6;
}
