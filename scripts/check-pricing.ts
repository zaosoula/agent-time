import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {bundledCatalog,validateCatalog,type ModelRates,type PricingCatalog} from '../src/usage/pricing.ts';

const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function table(text:string,header:string):string[][] {
 const lines=text.split('\n'),start=lines.findIndex(line=>line.startsWith('|')&&line.includes(header));
 if(start<0)throw new Error(`Pricing table changed: ${header}`);
 const rows:string[][]=[];
 for(const line of lines.slice(start+2)){if(!line.startsWith('|'))break;rows.push(line.split('|').slice(1,-1).map(v=>v.trim()));}
 if(!rows.length)throw new Error('Empty pricing table');return rows;
}
function money(cell:string):number {const match=cell.match(/^\$([0-9]+(?:\.[0-9]+)?)(?:\s*\/\s*MTok)?(?:<sup>\d+<\/sup>)?$/);if(!match)throw new Error(`Unrecognized price: ${cell}`);return Number(match[1]);}
export function proposeCatalog(openai:string,claude:string,current:PricingCatalog,date:string){
 const models:Record<string,ModelRates>={...current.models},notes:string[]=[],found=new Set<string>();
 // Only the first, explicitly standard table. Never parse Batch/Flex/Fast tables.
 const standard=openai.split('### Standard pricing data')[1]?.split('###')[0];if(!standard)throw new Error('OpenAI standard section missing');
 for(const row of table(standard,'Short context input')){
  const model=row[0].split(' ')[0];if(!/^(gpt|o[1-9])[a-z0-9.-]*$/.test(model))continue;
  if(row[2]==='-'){notes.push(`${model}: no cached-input rate; review manually`);continue;}
  models[model]={input:money(row[1]),cacheRead:money(row[2]),cacheWrite:row[3]==='-'?0:money(row[3]),cacheWrite1h:row[3]==='-'?0:money(row[3]),output:money(row[4])};found.add(model);
 }
 // Older Codex prices live in a separate standard table. Stop before Fast.
 const codex=openai.match(/\| Codex \| (gpt-[a-z0-9.-]+) \| (\$[0-9.]+) \| (\$[0-9.]+) \| (\$[0-9.]+) \|/);
 if(codex){models[codex[1]]={input:money(codex[2]),cacheRead:money(codex[3]),output:money(codex[4]),cacheWrite:0,cacheWrite1h:0};found.add(codex[1]);}
 const claudeRows=table(claude,'Base input tokens');
 for(const row of claudeRows){
  const match=row[0].match(/^Claude (\w+) ([0-9.]+)/);if(!match)throw new Error('Claude model naming changed');
  const model=`claude-${match[1].toLowerCase()}-${match[2].replaceAll('.','-')}`;
  // Per-request context tiers need a richer usage policy; keep them unpriced.
  if(row[0].includes('for prompts')){notes.push(`${model}: prompt-length tiers; review manually`);continue;}
  models[model]={input:money(row[1]),cacheWrite:money(row[2]),cacheWrite1h:money(row[3]),cacheRead:money(row[4]),output:money(row[5])};found.add(model);
 }
 for(const model of Object.keys(current.models))if(!found.has(model))throw new Error(`Previously supported model missing from parsed tables: ${model}`);
 const digest=hash(openai+'\n'+claude);
 return {catalog:validateCatalog({...current,version:`${date}-${digest.slice(0,12)}`,verifiedAt:date,models}),notes};
}
async function main(){
 const current=validateCatalog(JSON.parse(await readFile('src/usage/catalog.json','utf8')));
 const urls=current.sources.map(s=>s+'.md');
 const pages=await Promise.all(urls.map(async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error(`${url}: HTTP ${r.status}`);const text=await r.text();if(text.length>2*1024*1024)throw new Error('Pricing page too large');return text;}));
 const date=new Date().toISOString().slice(0,10),digests=Object.fromEntries(current.sources.map((source,i)=>[source,hash(pages[i])]));
 const previous=JSON.parse(await readFile('pricing/source-checks.json','utf8').catch(()=>'{}'));
 const changed=JSON.stringify(digests)!==JSON.stringify(previous);
 // Reconfirm unchanged prices weekly so verification dates stay meaningful.
 if(process.env.PRICING_FORCE_REVIEW!=='true'&&!changed&&Date.now()-Date.parse(current.verifiedAt)<7*86400000){console.log('Official pricing pages unchanged; no proposal needed.');return;}
 const {catalog,notes}=proposeCatalog(pages[0],pages[1],current,date);
 const changes=Object.keys(catalog.models).filter(model=>JSON.stringify(catalog.models[model])!==JSON.stringify(current.models[model]));
 const report=`# Pricing review\n\nProposal only; merging this PR publishes the reviewed catalog.\n\nSources: ${current.sources.join(', ')}\n\nFetched ${date}. ${changed?'Official page content changed.':'Weekly verification due; official page hashes unchanged.'}\n\nModels with proposed rate changes or additions: ${changes.join(', ')||'none'}.\n\nCheck prices, cache durations, context thresholds, service tiers, region and footnotes against the source pages. The app still estimates the standard short-context/global baseline. This date is a verification date, not an asserted provider effective date. Existing usage keeps its previous catalog.\n\nManual review notes:\n${[...new Set(notes)].map(n=>'- '+n).join('\n')||'- None'}\n`;
 // Preserve immutable files for both the old and proposed versions.
 await mkdir('pricing/history',{recursive:true});
 for(const c of [current,catalog])await writeFile(`pricing/history/${c.version}.json`,JSON.stringify(c,null,2)+'\n',{flag:'wx'}).catch(async e=>{if(e.code!=='EEXIST')throw e;const existing=validateCatalog(JSON.parse(await readFile(`pricing/history/${c.version}.json`,'utf8')));if(JSON.stringify(existing)!==JSON.stringify(c))throw new Error('Immutable history version conflict');});
 await writeFile('src/usage/catalog.json',JSON.stringify(catalog,null,2)+'\n');
 await writeFile('pricing/source-checks.json',JSON.stringify(digests,null,2)+'\n');
 await writeFile('pricing/REVIEW.md',report);
 console.log(`Prepared proposal ${catalog.version}; ${changes.length} model changes. Review before merging.`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
