import type {AppReviewGroup} from './review-apps.ts';
import type {AgentExecution} from './project-explorer.ts';
import type {BillingReport} from '../capture/billing-types.ts';
export type ActivityDetailTarget =
 | {kind:'human';date:string;groups:AppReviewGroup[]}
 | {kind:'agent';date:string;execution:AgentExecution}
 | {kind:'billing';report:Omit<BillingReport,'projectSnapshot'>};
/** Original spans only. A first/last envelope would include unobserved gaps. */
export function activityDetailSpans(target:ActivityDetailTarget){
 if(target.kind==='billing')return [];
 return (target.kind==='human'?target.groups:target.execution.bars).map(item=>({start:item.start,end:item.end}));
}
