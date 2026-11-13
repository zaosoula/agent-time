import {randomUUID} from 'node:crypto';
import type {BillingProject,BillingPolicy,BillingDayInput,BillingDay,BillingReport,BillingAmounts} from './billing-types.ts';
// Exact rational arithmetic is retained through weighting, rounding and monetary pricing.
type Q={n:bigint;d:bigint};
const q=(n:bigint,d=1n):Q=>{if(d===0n)throw new Error('Zero denominator');if(d<0n){n=-n;d=-d;}let a=n<0n?-n:n,b=d;while(b){const r=a%b;a=b;b=r;}return {n:n/a,d:d/a};};
const add=(a:Q,b:Q)=>q(a.n*b.d+b.n*a.d,a.d*b.d);
const mul=(a:Q,b:Q)=>q(a.n*b.n,a.d*b.d);
const div=(a:Q,b:Q)=>q(a.n*b.d,a.d*b.n);
const num=(a:Q)=>Number(a.n)/Number(a.d);
function decimal(value:string):Q {if(value.includes('/')){const [a,b,...rest]=value.split('/');if(rest.length)throw new Error('Invalid fraction');return div(decimal(a!),decimal(b!));}if(!/^\d+(\.\d+)?$/.test(value))throw new Error('Invalid nonnegative decimal');const [a,b='']=value.split('.');return q(BigInt(a!+b),10n**BigInt(b.length));}
const seconds=(ms:number)=>div(decimal(String(ms)),q(1000n));
function rounded(value:Q,p:BillingPolicy):Q {const unit=BigInt(p.rounding.minutes*60),den=value.d*unit;let count=value.n/den;const rem=value.n%den;if(p.rounding.mode==='up'&&rem>0n||p.rounding.mode==='nearest'&&rem*2n>=den)count++;return q(count*unit);}
function money(value:Q,currency:string):string {const places=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits??2;const scale=10n**BigInt(places);const v=(value.n*scale*2n+value.d)/(2n*value.d);const s=v.toString().padStart(places+1,'0');return places?s.slice(0,-places)+'.'+s.slice(-places):s;}
type I=[number,number];
function union(items:I[]):I[]{const out:I[]=[];for(const [a,b] of items.filter(x=>x[1]>x[0]).sort((a,b)=>a[0]-b[0])){const last=out.at(-1);if(last&&a<=last[1])last[1]=Math.max(last[1],b);else out.push([a,b]);}return out;}
function subtract(items:I[],cuts:I[]):I[]{const out:I[]=[];for(const [a,b] of items){let start=a;for(const [c,d] of cuts){if(d<=start)continue;if(c>=b)break;if(c>start)out.push([start,c]);start=Math.max(start,d);if(start>=b)break;}if(start<b)out.push([start,b]);}return out;}
const length=(items:I[])=>items.reduce((v,[a,b])=>v+b-a,0)/1000;
const intersect=(a:I[],b:I[])=>subtract(a,subtract(a,b));
const metricKeys=['humanActiveSeconds','agentWallSeconds','agentOnlyWallSeconds','agentRunningSeconds','overlapMergedWallSeconds','excludedSeconds','unknownSeconds','crossProjectOverlapSeconds','eligibleSeconds','rawEligibleSeconds','countingAdjustmentSeconds','billableSeconds','roundingSeconds'] as const;
function empty():BillingAmounts{return {humanActiveSeconds:0,agentWallSeconds:0,agentOnlyWallSeconds:0,agentRunningSeconds:0,overlapMergedWallSeconds:0,excludedSeconds:0,unknownSeconds:0,crossProjectOverlapSeconds:0,eligibleSeconds:0,rawEligibleSeconds:0,countingAdjustmentSeconds:0,billableSeconds:0,roundingSeconds:0,timeAmount:null,aiAmount:null,aiKnownAmount:'0',totalAmount:null};}
type Aggregate={day:BillingDay;policy:BillingPolicy;human:Q;agent:Q;eligible:Q;billable:Q;cost:Q;costKnown:boolean;time:Q|null;fee:Q;feeKnown:boolean;rawEligible:Q;};
/** Retain one open eligible block per channel; only per-day rational weights survive midnight. */
class EligibleMinuteBlocks {
 private blocks=new Map<string,{start:number;end:number;parts:Map<Aggregate,{human:Q;agent:Q}>}>();
 private settle(key:string){
  const block=this.blocks.get(key);if(!block)return;
  // Normalize allocation by the exact sum of retained parts: timestamp subtraction can
  // otherwise make complementary floating-point pieces add to slightly over one block.
  const duration=[...block.parts.values()].reduce((sum,part)=>add(sum,add(part.human,part.agent)),q(0n)),credit=q(BigInt(Math.ceil((block.end-block.start)/60000))*60n);
  for(const [target,part] of block.parts){
   target.human=add(target.human,mul(credit,div(part.human,duration)));
   const agentWeight=target.policy.basis==='overlapMergedWall'?q(1n):decimal(target.policy.agentWeight);
   target.agent=add(target.agent,mul(mul(credit,div(part.agent,duration)),agentWeight));
  }
  this.blocks.delete(key);
 }
 add(key:string,ranges:I[],target:Aggregate,human:I[],agent:I[]){
  for(const [start,end] of ranges){
   let block=this.blocks.get(key);
   if(block&&start>block.end){this.settle(key);block=undefined;}
   if(!block){block={start,end,parts:new Map()};this.blocks.set(key,block);}else block.end=Math.max(block.end,end);
   const previous=block.parts.get(target)??{human:q(0n),agent:q(0n)};
   const milliseconds=(items:I[])=>items.reduce((sum,[a,b])=>add(sum,decimal(String(b-a))),q(0n));
   block.parts.set(target,{human:add(previous.human,milliseconds(intersect([[start,end]],human))),agent:add(previous.agent,milliseconds(intersect([[start,end]],agent)))});
  }
 }
 closeBefore(boundary:number){for(const [key,block] of this.blocks)if(block.end<boundary)this.settle(key);}
 flush(){for(const key of this.blocks.keys())this.settle(key);}
}
export function calculateBilling(project:BillingProject,inputs:Iterable<BillingDayInput>,options:{fromDate:string;toDate:string;reportId?:string}):BillingReport {
 if(options.fromDate>options.toDate)throw new Error('Invalid date range');
 const policies=[...project.policies].sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom));
 const minuteBlocks=new EligibleMinuteBlocks();let previousPolicy:BillingPolicy|undefined,previousEnd=-Infinity,previousDate='';const needsChronology=policies.some((policy,index)=>policy.countingMode==='minutes'&&policy.effectiveFrom<=options.toDate&&(!policies[index+1]||policies[index+1]!.effectiveFrom>options.fromDate));
 const aggregates:Aggregate[]=[];const seenDates=new Set<string>(),seenCosts=new Set<string>();
 for(const raw of inputs){const input:BillingDayInput={...raw,start:raw.start*1000,end:raw.end*1000,spans:raw.spans.map(s=>({...s,start:s.start*1000,end:s.end*1000})),excluded:raw.excluded.map(s=>({...s,start:s.start*1000,end:s.end*1000})),humanMessages:raw.humanMessages.map(at=>at*1000),usage:raw.usage.map(u=>({...u,at:u.at*1000}))};if(input.date<options.fromDate||input.date>options.toDate)continue;if(seenDates.has(input.date))throw new Error('Duplicate billing date');seenDates.add(input.date);
 const policy=policies.findLast(p=>p.effectiveFrom<=input.date);if(!policy)throw new Error(`No billing policy for ${input.date}`);
 const weight=decimal(policy.agentWeight);if(!(input.end>input.start))throw new Error('Invalid day boundaries');
 if(needsChronology&&(input.start<previousEnd||input.date<previousDate))throw new Error('Minute counting requires chronological, non-overlapping day inputs');
 previousEnd=input.end;previousDate=input.date;
 if(previousPolicy&&previousPolicy!==policy)minuteBlocks.flush();previousPolicy=policy;
 const warnings:string[]=[];const clip=(start:number,end:number):I=>[Math.max(input.start,start),Math.min(input.end,end)];
 const excluded=union(input.excluded.map(s=>clip(s.start,s.end)));
 const agentExcluded=union(input.excluded.filter(s=>s.appliesTo!=='human').map(s=>clip(s.start,s.end)));
 // Capture pauses stop human observation; independently captured agents may continue.
 const captured=input.spans.filter(s=>!s.reported&&s.projectId===project.id);
 const human= subtract(union(captured.filter(s=>s.kind==='human').map(s=>clip(s.start,s.end))),excluded);
 const agent=subtract(union(captured.filter(s=>s.kind==='agent').map(s=>clip(s.start,s.end))),agentExcluded);
 const only=subtract(agent,human);const merged=union([...human,...agent]);
 const other=union(input.spans.filter(s=>!s.reported&&s.projectId&&s.projectId!==project.id).map(s=>clip(s.start,s.end)));
 const cross=length(intersect(merged,other));if(cross)warnings.push('crossProjectOverlap: simultaneous captured work belongs to another project; review allocation.');
 const presence=policy.presenceWindowMinutes===null?null:union(input.humanMessages.map(at=>clip(at,at+policy.presenceWindowMinutes!*60000)));
 if(presence!==null&&!input.presenceEvidenceAvailable)warnings.push('Presence evidence unavailable; agent-only time cannot qualify.');
 const eligibleOnly=presence===null?only:input.presenceEvidenceAvailable?intersect(only,presence):[];
 const sessions=new Map<string,I[]>();for(const s of captured.filter(s=>s.kind==='agent')){const key=s.sessionKey??'unknown-session';sessions.set(key,[...(sessions.get(key)??[]),clip(s.start,s.end)]);}
 if(captured.some(s=>s.kind==='agent'&&!s.sessionKey)&&policy.basis==='weightedAgentRunning')warnings.push('Agent session identity missing; anonymous intervals are merged.');
 const eligibleSessions=new Map<string,I[]>();let running=0,eligibleRunning=0;for(const [key,spans] of sessions){const clean=subtract(union(spans),agentExcluded);running+=length(clean);const humanPart=intersect(clean,human);const eligibleParts=union([...humanPart,...(presence===null?subtract(clean,human):input.presenceEvidenceAvailable?intersect(subtract(clean,human),presence):[])]);eligibleSessions.set(key,eligibleParts);eligibleRunning+=length(humanPart)+length(presence===null?subtract(clean,human):input.presenceEvidenceAvailable?intersect(subtract(clean,human),presence):[]);}
 const h=seconds(length(human)*1000);let a=q(0n);
 if(policy.basis==='overlapMergedWall')a=seconds(length(eligibleOnly)*1000);
 if(policy.basis==='weightedAgentOnly')a=mul(seconds(length(eligibleOnly)*1000),weight);
 if(policy.basis==='weightedAgentRunning')a=mul(seconds(eligibleRunning*1000),weight);
 const eligible=add(h,a);
 let cost=q(0n),costKnown=input.usageComplete;
 for(const usage of policy.aiFees.mode==='actual'?input.usage:[]){if(usage.projectId&&usage.projectId!==project.id||usage.at<input.start||usage.at>=input.end||seenCosts.has(usage.id))continue;seenCosts.add(usage.id);if(usage.currency&&usage.currency!==policy.currency)throw new Error('Usage currency differs from billing currency');if(usage.cost===null)costKnown=false;else cost=add(cost,decimal(usage.cost));if(!usage.verified)warnings.push(`Unverified AI cost from ${usage.source}.`);}
 if(!input.coverageComplete)warnings.push('Capture coverage incomplete; unknown time is not treated as observed zero.');
 if(policy.aiFees.mode==='actual'&&!costKnown)warnings.push('AI usage incomplete; known subtotal only.');
 const day:BillingDay={...empty(),date:input.date,policyId:policy.id,countingMode:policy.countingMode??'seconds',warnings,humanActiveSeconds:length(human),agentWallSeconds:length(agent),agentOnlyWallSeconds:length(only),agentRunningSeconds:running,overlapMergedWallSeconds:length(merged),excludedSeconds:length(excluded),unknownSeconds:input.coverageComplete?0:Math.max(0,(input.end-input.start)/1000-length(union([...merged,...excluded]))),crossProjectOverlapSeconds:cross,eligibleSeconds:num(eligible),rawEligibleSeconds:num(eligible)};
 const aggregate:Aggregate={day,policy,human:policy.countingMode==='minutes'?q(0n):h,agent:policy.countingMode==='minutes'?q(0n):a,eligible,billable:eligible,cost,costKnown,time:null,fee:q(0n),feeKnown:true,rawEligible:eligible};aggregates.push(aggregate);
 if(policy.countingMode==='minutes'){
  if(policy.basis==='overlapMergedWall'||policy.basis==='weightedAgentOnly')minuteBlocks.add('production',union([...human,...eligibleOnly]),aggregate,human,eligibleOnly);
  else {
   minuteBlocks.add('human',human,aggregate,human,[]);
   if(policy.basis==='weightedAgentRunning')for(const [key,ranges] of eligibleSessions)minuteBlocks.add('agent:'+key,ranges,aggregate,[],ranges);
  }
  minuteBlocks.closeBefore(input.end);
 }
 }
 minuteBlocks.flush();
 for(const aggregate of aggregates){aggregate.eligible=add(aggregate.human,aggregate.agent);aggregate.billable=aggregate.eligible;aggregate.day.eligibleSeconds=num(aggregate.eligible);// Started-minute counting cannot reduce eligibility; retain legacy raw numbers while eliminating subtraction epsilon.
 aggregate.day.countingAdjustmentSeconds=Math.max(0,num(add(aggregate.eligible,q(-aggregate.rawEligible.n,aggregate.rawEligible.d))));}
 aggregates.sort((a,b)=>a.day.date.localeCompare(b.day.date));
 const currencies=new Set(aggregates.map(a=>a.policy.currency));if(currencies.size>1)throw new Error('Mixed currencies in a billing report');const currency=[...currencies][0]??null;
 // Each revision is an independent rounding/rate segment. Allocate period rounding within each day's hard cap.
 const groups=new Map<string,Aggregate[]>();for(const a of aggregates)groups.set(a.policy.id,[...(groups.get(a.policy.id)??[]),a]);
 for(const group of groups.values()){
 const p=group[0]!.policy;const cap=p.dailyCapMinutes===null?null:decimal(String(p.dailyCapMinutes*60));
 const capped=(value:Q)=>cap&&num(value)>num(cap)?cap:value;
 if(p.rounding.scope==='day')for(const a of group)a.billable=capped(rounded(a.eligible,p));
 else {const sum=group.reduce((v,a)=>add(v,capped(a.eligible)),q(0n));let target=rounded(sum,p);const maximum=cap?mul(cap,q(BigInt(group.filter(a=>a.eligible.n>0n).length))):target;if(num(target)>num(maximum))target=maximum;
 let remaining=target;for(let i=0;i<group.length;i++){const a=group[i]!;let share=sum.n===0n?q(0n):mul(target,div(capped(a.eligible),sum));share=capped(share);a.billable=share;remaining=add(remaining,q(-share.n,share.d));}
 // Rounding can leave capacity after proportional shares hit caps.
 for(const a of group){if(num(remaining)<=0)break;if(a.eligible.n===0n)continue;const capacity=cap?add(cap,q(-a.billable.n,a.billable.d)):remaining;const extra=num(capacity)<num(remaining)?capacity:remaining;a.billable=add(a.billable,extra);remaining=add(remaining,q(-extra.n,extra.d));}
 }
 for(const [index,a] of group.entries()){
 const factor=a.eligible.n===0n?q(0n):div(a.billable,a.eligible);const humanUnits=mul(a.human,factor),agentUnits=mul(a.agent,factor);
 const agentRate=p.agentOnlyHourlyRate??p.hourlyRate;
 a.time=p.hourlyRate===null&&humanUnits.n!==0n||agentRate===null&&agentUnits.n!==0n?null:div(add(mul(humanUnits,decimal(p.hourlyRate??'0')),mul(agentUnits,decimal(agentRate??'0'))),q(3600n));

 if(p.aiFees.mode==='actual'){a.fee=a.cost;a.feeKnown=a.costKnown;}else if(p.aiFees.mode==='flat')a.fee=p.aiFees.scope==='day'||index===0?decimal(p.aiFees.amount):q(0n);
 a.day.billableSeconds=num(a.billable);a.day.roundingSeconds=num(a.billable)-a.day.eligibleSeconds;
 a.day.timeAmount=a.time===null?null:money(a.time,p.currency);a.day.aiKnownAmount=money(a.fee,p.currency);a.day.aiAmount=a.feeKnown?a.day.aiKnownAmount:null;a.day.totalAmount=a.time!==null&&a.feeKnown?money(add(a.time,a.fee),p.currency):null;
 }
 }
 const totals=empty();for(const a of aggregates)for(const key of metricKeys)totals[key]=(totals[key]??0)+(a.day[key]??0);
 const timeKnown=aggregates.length>0&&aggregates.every(a=>a.time!==null),feeKnown=aggregates.length>0&&aggregates.every(a=>a.feeKnown);const time=aggregates.reduce((v,a)=>add(v,a.time??q(0n)),q(0n)),fee=aggregates.reduce((v,a)=>add(v,a.fee),q(0n));
 if(currency){totals.timeAmount=timeKnown?money(time,currency):null;totals.aiKnownAmount=money(fee,currency);totals.aiAmount=feeKnown?totals.aiKnownAmount:null;totals.totalAmount=timeKnown&&feeKnown?money(add(time,fee),currency):null;}
 const warnings=[...new Set(aggregates.flatMap(a=>a.day.warnings))];
 const expected=(Date.parse(options.toDate+'T00:00:00Z')-Date.parse(options.fromDate+'T00:00:00Z'))/86400000+1;if(aggregates.length!==expected)warnings.push('Some requested dates have no capture coverage.');if(!currency)warnings.push('No billing data available.');
 return {reportId:options.reportId??randomUUID(),projectId:project.id,projectName:project.name,...options,timezone:project.timezone,currency,createdAt:new Date().toISOString(),calculationVersion:6,countingModes:[...new Set(aggregates.map(a=>a.policy.countingMode??'seconds'))],projectSnapshot:structuredClone(project),days:aggregates.map(a=>a.day),totals,quality:{complete:warnings.length===0&&timeKnown&&feeKnown,warnings},explanation:'Raw captured seconds remain unchanged. Counting uses actual seconds for legacy/seconds policies or one started minute per contiguous eligible block for minute policies, continuing across midnight within a revision; counting adjustments are separate from commercial rounding. Captured intervals are merged across project sources; reported timers are omitted. Capture pauses exclude human observations while independently captured agent work can qualify. Sleep markers alone do not exclude captured activity. Locks and unexplained Mac observation gaps exclude both. Missing Mac samples within an explicit capture pause follow the human-only pause rule. Human messages gate agent-only time when configured. Policy revisions round separately, daily caps are hard limits, and unknown amounts remain unknown. This report is a calculation snapshot, not invoice approval.'};
}
export function renderBillingExport(report:BillingReport,format:'csv'|'markdown'):string {
 const productionLabel='temps de production : pilotage + exécution d’agents (agents parallèles comptés une fois)';
 const unionOnly=report.days.length>0&&report.days.every(day=>report.projectSnapshot.policies.find(p=>p.id===day.policyId)?.basis==='overlapMergedWall');
 const label=unionOnly?productionLabel:'Billable time (see policy basis)';
 const values=(d:BillingAmounts)=>[d.humanActiveSeconds,d.agentWallSeconds,d.agentOnlyWallSeconds,d.agentRunningSeconds,d.overlapMergedWallSeconds,d.excludedSeconds,d.unknownSeconds,d.crossProjectOverlapSeconds,d.rawEligibleSeconds??d.eligibleSeconds,d.countingAdjustmentSeconds??0,d.eligibleSeconds,d.roundingSeconds,d.billableSeconds,d.timeAmount,d.aiAmount,d.aiKnownAmount,d.totalAmount];
 const modeFor=(policyId:string|null)=>{const mode=report.projectSnapshot.policies.find(policy=>policy.id===policyId)?.countingMode;return mode??'legacy seconds';};
 const modes=[...new Set(report.days.map(day=>report.projectSnapshot.policies.find(policy=>policy.id===day.policyId)?.countingMode??'seconds'))];const totalMode=modes.length>1?'mixed':modes[0]==='minutes'?'minutes':report.days.every(day=>modeFor(day.policyId)==='legacy seconds')?'legacy seconds':'seconds';
 const rows:unknown[][]=[['Project','Date','Currency','Policy','Time basis','Counting mode','Human active seconds','Agent wall seconds','Agent-only wall seconds','Cumulative agent seconds','Merged wall seconds','Excluded seconds','Unknown seconds','Cross-project overlap seconds','Raw eligible seconds','Counting adjustment seconds','Eligible seconds','Rounding seconds','Billable seconds','Time amount','AI amount','AI known subtotal','Total amount','Warnings'],...report.days.map(d=>[report.projectName,d.date,report.currency,d.policyId,report.projectSnapshot.policies.find(p=>p.id===d.policyId)?.basis==='overlapMergedWall'?productionLabel:report.projectSnapshot.policies.find(p=>p.id===d.policyId)?.basis??'unknown',modeFor(d.policyId),...values(d),d.warnings.join('; ')]),[report.projectName,'TOTAL',report.currency,'All revisions',label,totalMode,...values(report.totals),report.quality.warnings.join('; ')]];
 if(format==='csv')return rows.map(row=>row.map(value=>{let text=value===null?'unknown':String(value);if(/^[\s]*[=+\-@]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';}).join(',')).join('\r\n')+'\r\n';
 const cell=(v:unknown)=>String(v??'unknown').replaceAll('|','\\|').replace(/[\r\n]/g,' ').replaceAll('<','&lt;');return rows.map((row,i)=>'| '+row.map(cell).join(' | ')+' |'+(i===0?'\n| '+row.map(()=> '---').join(' | ')+' |':'')).join('\n')+'\n\n'+report.explanation;
}
