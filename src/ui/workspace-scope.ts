import {computed,ref,watch,type Ref} from 'vue';
import {dateString,isValidDateString,shiftDate} from './format.ts';
export type PeriodMode='day'|'week'|'month'|'custom';
export interface WorkspacePeriod {mode:PeriodMode;from:string;to:string;}
export function periodFor(mode:Exclude<PeriodMode,'custom'>,date:string):WorkspacePeriod {
 if(!isValidDateString(date))throw new Error('Choose a valid date');
 if(mode==='day')return {mode,from:date,to:date};
 const value=new Date(date+'T12:00:00');
 if(mode==='week'){const from=shiftDate(date,-((value.getDay()+6)%7));return {mode,from,to:shiftDate(from,6)};}
 const from=date.slice(0,7)+'-01';value.setMonth(value.getMonth()+1,0);return {mode,from,to:dateString(value)};
}
export function validPeriod(from:string,to:string){return isValidDateString(from)&&isValidDateString(to)&&from<=to&&new Date(to+'T12:00:00').getTime()-new Date(from+'T12:00:00').getTime()<=366*86400000;}
export function createWorkspaceScope(selectedDate:Ref<string>){
 const period=ref<WorkspacePeriod>(periodFor('day',selectedDate.value));
 function setPeriod(from:string,to:string,mode:PeriodMode='custom'){
  if(!validPeriod(from,to))return false;
  period.value={from,to,mode};
  if(selectedDate.value<from||selectedDate.value>to)selectedDate.value=from;
  return true;
 }
 function setPeriodMode(mode:Exclude<PeriodMode,'custom'>){const next=periodFor(mode,selectedDate.value);setPeriod(next.from,next.to,next.mode);}
 function shiftPeriod(direction:number){
  const p=period.value;
  if(p.mode==='day'){const next=shiftDate(p.from,direction);setPeriod(next,next,'day');}
  else if(p.mode==='week'){const next=periodFor('week',shiftDate(p.from,7*direction));setPeriod(next.from,next.to,'week');}
  else if(p.mode==='month'){const date=new Date(p.from+'T12:00:00');date.setMonth(date.getMonth()+direction);const next=periodFor('month',dateString(date));setPeriod(next.from,next.to,'month');}
  else {const days=Math.round((new Date(p.to+'T12:00:00').getTime()-new Date(p.from+'T12:00:00').getTime())/86400000)+1;setPeriod(shiftDate(p.from,days*direction),shiftDate(p.to,days*direction));}
 }
 watch(selectedDate,date=>{if(date<period.value.from||date>period.value.to){if(period.value.mode==='custom')setPeriod(date,date,'day');else setPeriodMode(period.value.mode);}}, {flush:'sync'});
 const periodLabel=computed(()=>period.value.from===period.value.to?period.value.from:`${period.value.from} – ${period.value.to}`);
 return {period,periodLabel,setPeriod,setPeriodMode,shiftPeriod};
}
