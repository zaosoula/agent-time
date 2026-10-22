import type {Interval,Summary} from './events.ts';

export interface HumanDecision {
 startEventId:string;
 endEventId:string;
 mode:'assigned'|'unassigned';
 projectPath:string|null;
}
export interface HumanSplit {startEventId:string;endEventId:string;splitAt:number;beforePath:string|null;afterPath:string|null;}

export function humanIntervalKey(interval:Interval):string|null {
 return interval.state==='human'&&interval.sourceEventIds.length===2
  ? `${interval.sourceEventIds[0]}:${interval.sourceEventIds[1]}`:null;
}

export function applyHumanDecisions(summary:Summary,decisions:HumanDecision[],splits:HumanSplit[]=[]):Summary {
 if(!decisions.length&&!splits.length)return summary;
 const byPair=new Map(decisions.map(item=>[`${item.startEventId}:${item.endEventId}`,item]));
 const splitByPair=new Map(splits.map(item=>[`${item.startEventId}:${item.endEventId}`,item]));
 return {...summary,intervals:summary.intervals.flatMap(interval=>{
  const key=humanIntervalKey(interval),split=key?splitByPair.get(key):undefined;
  if(split&&split.splitAt>interval.start&&split.splitAt<interval.end){
   const assigned=(part:Interval,path:string|null,start:number,end:number,reviewSegment:'before'|'after'):Interval=>({...part,start,end,reviewSegment,workspaceId:path?`manual::${path}`:undefined,userAttribution:path?'assigned':'unassigned'});
   return [assigned(interval,split.beforePath,interval.start,split.splitAt,'before'),assigned(interval,split.afterPath,split.splitAt,interval.end,'after')];
  }
  const decision=key?byPair.get(key):undefined;
  if(!decision)return interval;
  return {...interval,workspaceId:decision.mode==='assigned'&&decision.projectPath
   ? `manual::${decision.projectPath}`:undefined,userAttribution:decision.mode};
 })};
}

export interface HumanReviewGroup {
 key:string;start:number;end:number;seconds:number;label:string;detail:string;
 browserUrl?:string;browserOrigin?:string;browserDomain?:string;projectPath?:string;userAttribution?:'assigned'|'unassigned';attributionSource?:string;attributionReason?:string;reviewSegment?:'before'|'after';
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
  const matchKey=JSON.stringify([identity(interval),path||'',interval.userAttribution||'',interval.attributionSource||'',interval.attributionReason||'',interval.reviewSegment||'']);
  const last=groups.at(-1);
  if(last&&last.key===matchKey&&last.pairs.length<500&&interval.start-last.end<=60){
   last.end=Math.max(last.end,interval.end);last.seconds+=interval.end-interval.start;
   last.pairs.push(interval.sourceEventIds as [string,string]);
  }else groups.push({key:matchKey,start:interval.start,end:interval.end,seconds:interval.end-interval.start,
   label,detail,browserUrl:interval.browserUrl,browserOrigin:interval.browserOrigin,browserDomain:interval.browserDomain,projectPath:path,
   userAttribution:interval.userAttribution,attributionSource:interval.attributionSource,attributionReason:interval.attributionReason,reviewSegment:interval.reviewSegment,pairs:[interval.sourceEventIds as [string,string]]});
 }
 return groups.reverse();
}
