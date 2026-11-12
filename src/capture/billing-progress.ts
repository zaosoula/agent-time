/** Work completed by the report worker, independent of financial/counting rules. */
export interface BillingProgress {
 phase:'reading'|'calculating'|'saving'|'complete'|'failed';
 completedDays:number;
 totalDays:number;
 date?:string;
}
export const validBillingProgressId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
