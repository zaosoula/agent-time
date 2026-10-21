import type {Summary,Interval} from './events.ts';
import {dailyTotals} from './daily.ts';

export interface WeeklyProject {project:string;humanSeconds:number;agentSeconds:number;elapsedSeconds:number;reviewedSeconds:number;}
export interface ReviewedEntry {date:string;start:number;end:number;project:string;source:string;seconds:number;}
export interface WeeklyReview {startDate:string;endDate:string;projects:WeeklyProject[];totals:Omit<WeeklyProject,'project'>;days:Array<{date:string;humanSeconds:number;agentSeconds:number;elapsedSeconds:number}>;reviewedEntries:ReviewedEntry[];}
const dateString=(date:Date)=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const project=(interval:Interval)=>interval.workspaceId?.split('::').at(-1)||'Unassigned';
export function weeklyReview(summary:Summary,startDate:string):WeeklyReview{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(startDate))throw new Error('Invalid week start');
 const start=new Date(`${startDate}T00:00:00`);
 if(Number.isNaN(start.getTime())||dateString(start)!==startDate)throw new Error('Invalid week start');
 const end=new Date(start);end.setDate(end.getDate()+7);
 const rows=new Map<string,WeeklyProject>(),reviewedEntries:ReviewedEntry[]=[],days:WeeklyReview['days']=[];
 const totals={humanSeconds:0,agentSeconds:0,elapsedSeconds:0,reviewedSeconds:0};
 for(let day=new Date(start);day<end;day.setDate(day.getDate()+1)){
  const next=new Date(day);next.setDate(next.getDate()+1);
  const from=day.getTime()/1000,to=next.getTime()/1000;
  const byProject=new Map<string,Interval[]>();
  for(const interval of summary.intervals){
   if(interval.end<=from||interval.start>=to||!['human','grouped'].includes(interval.state))continue;
   const clipped={...interval,start:Math.max(interval.start,from),end:Math.min(interval.end,to)};
   const key=project(interval),group=byProject.get(key)||[];group.push(clipped);byProject.set(key,group);
   if(clipped.state==='human'&&clipped.userAttribution){
    reviewedEntries.push({date:dateString(day),start:clipped.start,end:clipped.end,project:key,source:clipped.foregroundName||clipped.browserDomain||'Mac activity',seconds:clipped.end-clipped.start});
   }
  }
  for(const [key,intervals] of byProject){
   const totals=dailyTotals({...summary,intervals},day);
   const row=rows.get(key)||{project:key,humanSeconds:0,agentSeconds:0,elapsedSeconds:0,reviewedSeconds:0};
   row.humanSeconds+=totals.humanSeconds;row.agentSeconds+=totals.agentSeconds;row.elapsedSeconds+=totals.elapsedSeconds;
   row.reviewedSeconds+=intervals.filter(interval=>interval.state==='human'&&interval.userAttribution).reduce((total,interval)=>total+interval.end-interval.start,0);
   rows.set(key,row);
  }
  const all=[...byProject.values()].flat();
  const dayTotals=dailyTotals({...summary,intervals:all},day);
  days.push({date:dateString(day),...dayTotals});
  totals.humanSeconds+=dayTotals.humanSeconds;totals.agentSeconds+=dayTotals.agentSeconds;totals.elapsedSeconds+=dayTotals.elapsedSeconds;
  totals.reviewedSeconds+=all.filter(interval=>interval.state==='human'&&interval.userAttribution).reduce((sum,interval)=>sum+interval.end-interval.start,0);
 }
 const projects=[...rows.values()].sort((a,b)=>b.elapsedSeconds-a.elapsedSeconds||a.project.localeCompare(b.project));
 const endDate=new Date(end);endDate.setDate(endDate.getDate()-1);
 return {startDate,endDate:dateString(endDate),projects,totals,days,reviewedEntries:reviewedEntries.sort((a,b)=>a.start-b.start)};
}
export function reviewedCsv(entries:ReviewedEntry[]):string{
 const cell=(value:string|number)=>{const raw=String(value),safe=/^[=+\-@\t\r]/.test(raw)?"'"+raw:raw;return '\"'+safe.replaceAll('\"','\"\"')+'\"';};
 return ['date,start,end,project,source,seconds',...entries.map(entry=>[entry.date,new Date(entry.start*1000).toISOString(),new Date(entry.end*1000).toISOString(),entry.project,entry.source,Math.round(entry.seconds)].map(cell).join(','))].join('\n')+'\n';
}
