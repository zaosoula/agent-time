/** Canonical billing configuration is stored in SQLite; these types are shared with the UI. */
export type BillingBasis='overlapMergedWall'|'humanActive'|'weightedAgentOnly'|'weightedAgentRunning';
export type BillingCountingMode='minutes'|'seconds';
export interface BillingPolicy {
 id:string;effectiveFrom:string;basis:BillingBasis;currency:string;hourlyRate:string|null;agentOnlyHourlyRate:string|null;agentWeight:string;
 rounding:{minutes:1|15|60;mode:'nearest'|'up'|'down';scope:'day'|'period'};
 dailyCapMinutes:number|null;presenceWindowMinutes:number|null;
 /** Missing on legacy policies means seconds. New policies default to minutes. */
 countingMode?:BillingCountingMode;
 aiFees:{mode:'none'}|{mode:'actual'}|{mode:'flat';amount:string;scope:'day'|'period'};
}
export interface BillingProject {
 id:string;name:string;aliases:string[];sources:{repositories:string[];workspaceIds:string[];reportedProjects:string[]};timezone:string;policies:BillingPolicy[];revision?:number;
}
/** All interval timestamps and message/usage times are epoch seconds, matching CaptureEvent. */
export interface BillingSpan {start:number;end:number;kind:'human'|'agent';sessionKey?:string;projectId?:string|null;reported?:boolean;}
export interface BillingUsage {id:string;at:number;cost:string|null;currency?:string;source:string;verified:boolean;projectId?:string;taskCounterId?:string;}
export interface BillingDayInput {
 date:string;start:number;end:number;spans:BillingSpan[];excluded:Array<{start:number;end:number;reason:string;appliesTo?:'all'|'human'}>;
 humanMessages:number[];presenceEvidenceAvailable:boolean;usage:BillingUsage[];usageComplete:boolean;coverageComplete:boolean;
}
export interface BillingMetrics {humanActiveSeconds:number;agentWallSeconds:number;agentOnlyWallSeconds:number;agentRunningSeconds:number;overlapMergedWallSeconds:number;excludedSeconds:number;unknownSeconds:number;crossProjectOverlapSeconds:number;}
export interface BillingAmounts extends BillingMetrics {rawEligibleSeconds?:number;countingAdjustmentSeconds?:number;eligibleSeconds:number;billableSeconds:number;roundingSeconds:number;timeAmount:string|null;aiAmount:string|null;aiKnownAmount:string;totalAmount:string|null;}
export interface BillingDay extends BillingAmounts {date:string;policyId:string|null;countingMode?:BillingCountingMode;warnings:string[];}
export interface BillingReport {
 reportId:string;projectId:string;projectName:string;fromDate:string;toDate:string;timezone:string;currency:string|null;createdAt:string;
 calculationVersion:number;inputRevision?:string;projectSnapshot:BillingProject;days:BillingDay[];totals:BillingAmounts;quality:{complete:boolean;warnings:string[]};explanation:string;
 countingModes?:BillingCountingMode[];
}
