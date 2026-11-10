import type {Interval} from '../capture/events.ts';
import {groupHumanReview,type HumanReviewGroup} from '../capture/human-review.ts';
import type {TimeRange} from './timeline-viewport.ts';

export interface AppReviewGroup extends HumanReviewGroup {
  appKey:string;
  appName:string;
  bundleId?:string;
  hostId?:string;
}
export interface ReviewAppSection {
  key:string;
  label:string;
  bundleId?:string;
  hostId?:string;
  groups:AppReviewGroup[];
  seconds:number;
}
export const reviewGroupId=(group:HumanReviewGroup)=>`${group.start}:${group.key}`;
const pairKey=(pair:readonly string[],segment?:string)=>JSON.stringify([pair[0],pair[1],segment||'']);
function application(interval:Interval){
  const bundleId=interval.foregroundBundleId||interval.browserBundleId;
  const appName=interval.foregroundName||bundleId||'Unknown app';
  return {appKey:JSON.stringify([interval.hostId||'',bundleId?'bundle:'+bundleId:'name:'+appName]),appName,bundleId,hostId:interval.hostId};
}

/** View grouping only. Keep every source pair and preserve interruptions, even
 * when the same page/app returns within the old review grouping's 60 s margin. */
export function buildAppReviewGroups(intervals:Interval[]):AppReviewGroup[]{
  const result:AppReviewGroup[]=[];
  let run:Interval[]=[],app:ReturnType<typeof application>|undefined;
  const flush=()=>{
    if(!app||!run.length)return;
    for(const group of groupHumanReview(run))result.push({...group,...app,key:JSON.stringify([app.appKey,group.key])});
    run=[];
  };
  for(const interval of intervals.filter(i=>i.state==='human'&&i.sourceEventIds.length===2&&Number.isFinite(i.start)&&Number.isFinite(i.end)&&i.end>i.start).sort((a,b)=>a.start-b.start||a.end-b.end)){
    const next=application(interval),last=run.at(-1);
    if(app&&(next.appKey!==app.appKey||last&&interval.start>last.end))flush();
    app=next;run.push(interval);
  }
  flush();return result;
}

export function reviewAppSections(groups:AppReviewGroup[]):ReviewAppSection[]{
  const sections=new Map<string,ReviewAppSection>();
  for(const group of groups){
    let app=sections.get(group.appKey);
    if(!app){app={key:group.appKey,label:group.appName,bundleId:group.bundleId,hostId:group.hostId,groups:[],seconds:0};sections.set(app.key,app);}
    app.groups.push(group);app.seconds+=group.seconds;
  }
  for(const app of sections.values())app.groups.sort((a,b)=>a.start-b.start||a.end-b.end);
  return [...sections.values()].sort((a,b)=>b.seconds-a.seconds||a.label.localeCompare(b.label)||a.key.localeCompare(b.key));
}

export function reviewSelection(groups:AppReviewGroup[],selectedIds:Readonly<Record<string,boolean>>){
  const selected=groups.filter(group=>!group.reviewSegment&&selectedIds[reviewGroupId(group)]);
  const pairs=[...new Map(selected.flatMap(group=>group.pairs).map(pair=>[JSON.stringify(pair),pair])).values()];
  return {groups:selected,pairs,seconds:selected.reduce((n,g)=>n+g.seconds,0),hasDecisions:selected.some(g=>Boolean(g.userAttribution)),overLimit:pairs.length>10000};
}

export interface ReviewTimelineBar {
  key:string;
  groupId:string;
  appKey:string;
  appName:string;
  projectPath?:string;
  start:number;
  end:number;
}
/** Draw actual source spans, never a group's envelope across missing evidence. */
export function reviewTimelineBars(intervals:Interval[],groups:AppReviewGroup[],range:TimeRange):ReviewTimelineBar[]{
  const byPair=new Map<string,AppReviewGroup>();
  for(const group of groups)for(const pair of group.pairs)byPair.set(pairKey(pair,group.reviewSegment),group);
  const bars:ReviewTimelineBar[]=[];
  for(const interval of intervals.filter(i=>i.state==='human'&&i.sourceEventIds.length===2).sort((a,b)=>a.start-b.start||a.end-b.end)){
    const group=byPair.get(pairKey(interval.sourceEventIds,interval.reviewSegment));
    if(!group)continue;
    const start=Math.max(range.start,interval.start),end=Math.min(range.end,interval.end);
    if(!(end>start))continue;
    const groupId=reviewGroupId(group),last=bars.at(-1);
    if(last&&last.groupId===groupId&&last.end===start){last.end=end;continue;}
    bars.push({key:`${groupId}:${start}`,groupId,appKey:group.appKey,appName:group.appName,projectPath:group.projectPath,start,end});
  }
  return bars;
}
