/** Billing dates use the project's timezone, independently of this Mac's timezone. */
const formats=new Map<string,Intl.DateTimeFormat>();
export function validateBillingDate(date:string):string{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw new Error('Use a valid YYYY-MM-DD billing date');return date;
}
export function nextBillingDate(date:string):string{return new Date(Date.parse(validateBillingDate(date)+'T00:00:00Z')+86400000).toISOString().slice(0,10);}
export function billingLocalDate(at:number,timezone:string):string{
 let fmt=formats.get(timezone);if(!fmt){fmt=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});formats.set(timezone,fmt);if(formats.size>64)formats.delete(formats.keys().next().value!);}
 const parts=fmt.formatToParts(new Date(at*1000));const part=(name:string)=>parts.find(p=>p.type===name)!.value;return `${part('year')}-${part('month')}-${part('day')}`;
}
export function billingDayStart(date:string,timezone:string):number{
 const midnight=Date.parse(validateBillingDate(date)+'T00:00:00Z')/1000;
 let low=midnight-2*86400,high=midnight+2*86400;
 while(low<high){const middle=Math.floor((low+high)/2);if(billingLocalDate(middle,timezone)<date)low=middle+1;else high=middle;}
 if(billingLocalDate(low,timezone)!==date)throw new Error('This calendar date does not exist in the project timezone');return low;
}
export function* billingDateRange(from:string,to:string):Generator<string>{validateBillingDate(from);validateBillingDate(to);if(from>to)throw new Error('Billing period ends before it starts');for(let date=from;date<=to;date=nextBillingDate(date))yield date;}
