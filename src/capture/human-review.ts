import type {Interval,Summary} from './events.ts';

export interface HumanDecision {
 startEventId:string;
 endEventId:string;
 mode:'assigned'|'unassigned';
 projectPath:string|null;
}

export function humanIntervalKey(interval:Interval):string|null {
 return interval.state==='human'&&interval.sourceEventIds.length===2
  ? `${interval.sourceEventIds[0]}:${interval.sourceEventIds[1]}`:null;
}

export function applyHumanDecisions(summary:Summary,decisions:HumanDecision[]):Summary {
 if(!decisions.length)return summary;
 const byPair=new Map(decisions.map(item=>[`${item.startEventId}:${item.endEventId}`,item]));
 return {...summary,intervals:summary.intervals.map(interval=>{
  const key=humanIntervalKey(interval),decision=key?byPair.get(key):undefined;
  if(!decision)return interval;
  return {...interval,workspaceId:decision.mode==='assigned'&&decision.projectPath
   ? `manual::${decision.projectPath}`:undefined,userAttribution:decision.mode};
 })};
}

export interface HumanReviewGroup {
 key:string;start:number;end:number;seconds:number;label:string;detail:string;
 browserUrl?:string;browserOrigin?:string;browserDomain?:string;projectPath?:string;userAttribution?:'assigned'|'unassigned';attributionSource?:string;attributionReason?:string;
 pairs:Array<[string,string]>;
}

function identity(interval:Interval):string {
 return interval.browserUrl||interval.browserOrigin||interval.browserDomain||interval.tabId||interval.tabTitle||interval.foregroundBundleId||interval.foregroundName||'Unknown app';
}

export function groupHumanReview(intervals:Interval[]):HumanReviewGroup[] {
 const groups:HumanReviewGroup[]=[];
 for(const interval of intervals.filter(i=>i.state==='human').sort((a,b)=>a.start-b.start)){
  const key=humanIntervalKey(interval);if(!key)continue;
  const path=interval.workspaceId?.split('::').at(-1);
  const label=interval.browserTitle||interval.tabTitle||interval.foregroundName||interval.browserDomain||'Unknown app';
  const detail=interval.browserUrl||interval.browserDomain||interval.foregroundBundleId||'Foreground activity';
  const matchKey=JSON.stringify([identity(interval),path||'',interval.userAttribution||'',interval.attributionSource||'',interval.attributionReason||'']);
  const last=groups.at(-1);
  if(last&&last.key===matchKey&&last.pairs.length<500&&interval.start-last.end<=60){
   last.end=Math.max(last.end,interval.end);last.seconds+=interval.end-interval.start;
   last.pairs.push(interval.sourceEventIds as [string,string]);
  }else groups.push({key:matchKey,start:interval.start,end:interval.end,seconds:interval.end-interval.start,
   label,detail,browserUrl:interval.browserUrl,browserOrigin:interval.browserOrigin,browserDomain:interval.browserDomain,projectPath:path,
   userAttribution:interval.userAttribution,attributionSource:interval.attributionSource,attributionReason:interval.attributionReason,pairs:[interval.sourceEventIds as [string,string]]});
 }
 return groups.reverse();
}
