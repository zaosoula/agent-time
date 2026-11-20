import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {bundledCatalog,validateCatalog,type ModelRates,type PricingCatalog} from '../src/usage/pricing.ts';

const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
type Row=Record<string,string>;
/** Every Markdown table in `text`, each row keyed by its lower-cased header so column order can change. */
function tables(text:string):Row[][] {
 const lines=text.split('\n'),found:Row[][]=[];
 const cells=(line:string)=>line.split('|').slice(1,-1).map(v=>v.trim());
 for(let i=0;i<lines.length-1;i++){
  if(!lines[i]!.startsWith('|')||!/^\|[\s:|-]+\|$/.test(lines[i+1]!.trim()))continue;
  const header=cells(lines[i]!).map(name=>name.toLowerCase()),rows:Row[]=[];
  for(i+=2;i<lines.length&&lines[i]!.startsWith('|');i++)rows.push(Object.fromEntries(cells(lines[i]!).map((value,column)=>[header[column]??'',value])));
  found.push(rows);
 }
 return found;
}
/** The first header present in `row` among `names`; a renamed or missing price column fails loudly. */
function column(row:Row,...names:string[]):string {for(const name of names)if(name in row)return row[name]!;throw new Error(`Pricing column missing: ${names[0]}`);}
function money(cell:string):number {const match=cell.match(/^\$([0-9]+(?:\.[0-9]+)?)(?:\s*\/\s*MTok)?(?:<sup>\d+<\/sup>)?$/);if(!match)throw new Error(`Unrecognized price: ${cell}`);return Number(match[1]);}
export function proposeCatalog(openai:string,claude:string,current:PricingCatalog,date:string){
 const models:Record<string,ModelRates>={...current.models},notes:string[]=[],found=new Set<string>();
 // Only the explicitly standard section. Never parse Batch/Flex/Fast tables.
 const standard=openai.split('### Standard pricing data')[1]?.split('###')[0];if(!standard)throw new Error('OpenAI standard section missing');
 const standardRows=tables(standard).flat();if(!standardRows.length)throw new Error('Empty pricing table');
 // Some tables list no write rate. OpenAI usage never reports long-retention
 // writes, so both write rates use the short one.
 const writes=['short context 30m write','30m write','short context cache writes','cache writes'];
 const openaiRates=(row:Row,cached:string):ModelRates=>{const write=writes.some(name=>name in row)?column(row,...writes):'-',cacheWrite=write==='-'?0:money(write);return {input:money(column(row,'short context input','input')),cacheRead:money(cached),cacheWrite,cacheWrite1h:cacheWrite,output:money(column(row,'short context output','output'))};};
 for(const row of standardRows){
  const model=column(row,'model').split(' ')[0]!;if(!/^(gpt|o[1-9])[a-z0-9.-]*$/.test(model))continue;
  const cached=column(row,'short context cached input','cached input');
  if(cached==='-'){notes.push(`${model}: no cached-input rate; review manually`);continue;}
  models[model]=openaiRates(row,cached);found.add(model);
 }
 // Older Codex prices live in a grouped standard table; the first Codex row is the standard tier.
 const codex=tables(openai).flat().find(row=>row.category==='Codex'&&/^gpt-[a-z0-9.-]+$/.test(row.model||''));
 if(codex){models[codex.model!]=openaiRates(codex,column(codex,'cached input'));found.add(codex.model!);}
 const claudeRows=tables(claude).find(rows=>rows[0]&&'base input tokens' in rows[0]);if(!claudeRows?.length)throw new Error('Pricing table changed: Base input tokens');
 for(const row of claudeRows){
  const name=column(row,'model'),match=name.match(/^Claude (\w+) ([0-9.]+)/);if(!match)throw new Error('Claude model naming changed');
  const model=`claude-${match[1]!.toLowerCase()}-${match[2]!.replaceAll('.','-')}`;
  // Per-request context tiers need a richer usage policy; keep them unpriced.
  if(name.includes('for prompts')){notes.push(`${model}: prompt-length tiers; review manually`);continue;}
  models[model]={input:money(column(row,'base input tokens')),cacheWrite:money(column(row,'5m cache writes')),cacheWrite1h:money(column(row,'1h cache writes')),cacheRead:money(column(row,'cache hits and refreshes')),output:money(column(row,'output tokens'))};found.add(model);
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
