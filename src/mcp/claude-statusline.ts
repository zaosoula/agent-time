import type {CaptureEvent} from '../capture/events.ts';

const clean=(value:unknown)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f\x1b]/g,' ').replace(/\s+/g,' ').trim().slice(0,72):'';
const elapsed=(seconds:number)=>{const total=Math.max(0,Math.floor(seconds)),minutes=Math.floor(total/60);return minutes>=60?`${Math.floor(minutes/60)}h ${String(minutes%60).padStart(2,'0')}m`:`${minutes}m ${String(total%60).padStart(2,'0')}s`;};

/** Claude's status line is per session. Never fall back to another session's declaration. */
export function renderClaudeReportedStatus(reports:CaptureEvent[],sessionId:string,now:number):string{
 if(!sessionId||sessionId.length>128)return '';
 const events=reports.filter(event=>event.source==='agent_report'&&event.provider==='claude'&&event.sessionId===sessionId&&event.observedAt<=now&&event.observedAt>=now-12*3600).sort((a,b)=>a.observedAt-b.observedAt);
 const stopped=new Set(events.filter(event=>event.kind==='task_stop').map(event=>String(event.data?.taskCounterId)));
 const counter=events.filter(event=>event.kind==='task_start'&&!stopped.has(event.eventId)).at(-1);
 const context=events.filter(event=>event.kind==='work_context').at(-1);
 const chosen=counter&&(!context||counter.observedAt>=context.observedAt)?counter:context;
 if(!chosen)return '';
 const title=clean(chosen.kind==='task_start'?chosen.data?.name:chosen.data?.task||chosen.data?.project);
 const issue=clean(chosen.data?.issueKey);
 if(!title&&!issue)return '';
 const label=[issue,title].filter(Boolean).join(' · ');
 return `${label} · ${elapsed(now-chosen.observedAt)} ${chosen.kind==='task_start'?'counter':'since report'} (reported)`;
}
