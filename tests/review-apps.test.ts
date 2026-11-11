import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Interval} from '../src/capture/events.ts';
import {buildAppReviewGroups,reviewAppSections,reviewGroupId,reviewSelection,reviewTimelineBars,reviewTimelineRange} from '../src/ui/review-apps.ts';

const interval=(id:string,start:number,end:number,extra:Partial<Interval>={}):Interval=>({start,end,state:'human',proof:'observed',sourceEventIds:[id+'a',id+'b'],hostId:'local',foregroundBundleId:'orca',foregroundName:'Orca',...extra});

test('app sections use foreground app identity rather than the browser page title',()=>{
 const input=[interval('a',0,5,{foregroundBundleId:'brave',foregroundName:'Brave',browserUrl:'https://example.com/a',browserTitle:'A page'}),interval('b',5,10,{foregroundBundleId:'chrome',foregroundName:'Chrome',browserUrl:'https://example.com/a',browserTitle:'A page'})];
 const groups=buildAppReviewGroups(input),sections=reviewAppSections(groups);
 assert.deepEqual(sections.map(s=>[s.label,s.seconds,s.groups.length]),[['Brave',5,1],['Chrome',5,1]]);
 assert.notEqual(groups[0]!.appKey,groups[1]!.appKey);assert.deepEqual(new Set(groups.map(g=>g.label)),new Set(['A page']));
});
test('app visits preserve gaps and intervening apps instead of merging their envelopes',()=>{
 const input=[interval('a',0,5),interval('b',5,10),interval('c',10,15,{foregroundBundleId:'spotify',foregroundName:'Spotify'}),interval('d',15,20),interval('e',25,30)];
 const before=JSON.stringify(input),sections=reviewAppSections(buildAppReviewGroups(input));
 assert.deepEqual(sections.map(s=>[s.label,s.seconds]),[['Orca',20],['Spotify',5]]);
 assert.deepEqual(sections[0]!.groups.map(g=>[g.start,g.end,g.seconds,g.pairs.length]),[[0,10,10,2],[15,20,5,1],[25,30,5,1]]);
 assert.equal(JSON.stringify(input),before);
});
test('browser contexts and review projects remain separate inside the same app',()=>{
 const groups=buildAppReviewGroups([interval('a',0,5,{browserUrl:'https://example.com/a',browserTitle:'A'}),interval('b',5,10,{browserUrl:'https://example.com/b',browserTitle:'B'}),interval('c',10,15,{browserUrl:'https://example.com/b',browserTitle:'B',workspaceId:'manual::/other',userAttribution:'assigned'})]);
 const sections=reviewAppSections(groups);assert.equal(sections.length,1);assert.equal(sections[0]!.seconds,15);assert.equal(sections[0]!.groups.length,3);assert.deepEqual(new Set(groups.flatMap(g=>g.pairs.map(p=>p.join(':')))),new Set(['aa:ab','ba:bb','ca:cb']));
});
test('same display names on different app IDs or hosts do not collapse into one app',()=>{
 const sections=reviewAppSections(buildAppReviewGroups([interval('a',0,2,{foregroundBundleId:'one'}),interval('b',2,4,{foregroundBundleId:'two'}),interval('c',4,6,{foregroundBundleId:'one',hostId:'other'})]));
 assert.equal(sections.length,3);assert.equal(new Set(sections.map(s=>s.key)).size,3);
});
test('bulk selection excludes split segments and deduplicates original pairs',()=>{
 const groups=buildAppReviewGroups([interval('split',0,5,{reviewSegment:'before',userAttribution:'assigned',workspaceId:'manual::/a'}),interval('split',5,10,{reviewSegment:'after',userAttribution:'unassigned'}),interval('whole',10,15)]);
 const selected=Object.fromEntries(groups.map(g=>[reviewGroupId(g),true]));const result=reviewSelection(groups,selected);
 assert.equal(result.groups.length,1);assert.deepEqual(result.pairs,[['wholea','wholeb']]);assert.equal(result.seconds,5);
 const whole=groups.find(g=>!g.reviewSegment)!;const duplicate={...whole,key:whole.key+'duplicate',start:20};const dedup=reviewSelection([whole,duplicate],{[reviewGroupId(whole)]:true,[reviewGroupId(duplicate)]:true});assert.deepEqual(dedup.pairs,[['wholea','wholeb']]);
});
test('selection cannot include stale or filtered IDs and reports the existing bulk limit',()=>{
 const groups=buildAppReviewGroups([interval('a',0,5)]),group=groups[0]!;
 assert.equal(reviewSelection(groups,{stale:true}).groups.length,0);
 const huge={...group,pairs:Array.from({length:10001},(_,i)=>[String(i),'end'+i] as [string,string])};
 assert.equal(reviewSelection([huge],{[reviewGroupId(huge)]:true}).overLimit,true);assert.equal(reviewSelection([group],{[reviewGroupId(group)]:true}).overLimit,false);
});
test('ribbon bars clip actual intervals and never paint across a gap or a filtered app',()=>{
 const input=[interval('a',0,5),interval('b',5,10),interval('c',10,15,{foregroundBundleId:'other',foregroundName:'Other'}),interval('d',15,20),interval('e',25,30)],groups=buildAppReviewGroups(input).filter(g=>g.appName==='Orca');
 const before=JSON.stringify(input),bars=reviewTimelineBars(input,groups,{start:2,end:18});
 assert.deepEqual(bars.map(b=>[b.start,b.end]),[[2,10],[15,18]]);assert.equal(bars.reduce((n,b)=>n+b.end-b.start,0),11);assert.equal(JSON.stringify(input),before);
 assert.equal(reviewTimelineBars(input,groups,{start:11,end:14}).length,0);
});
test('ribbon bars distinguish both parts of a split sharing the same source IDs',()=>{
 const input=[interval('s',0,5,{reviewSegment:'before',userAttribution:'assigned',workspaceId:'manual::/a'}),interval('s',5,10,{reviewSegment:'after',userAttribution:'assigned',workspaceId:'manual::/b'})],groups=buildAppReviewGroups(input),bars=reviewTimelineBars(input,groups,{start:0,end:10});
 assert.deepEqual(bars.map(b=>[b.start,b.end,b.projectPath]),[[0,5,'/a'],[5,10,'/b']]);assert.notEqual(bars[0]!.groupId,bars[1]!.groupId);
});
test('app presentation excludes agent work and leaves frozen observation evidence untouched',()=>{
 const input=[interval('a',0,5),interval('b',5,10,{state:'grouped'})];input.forEach(i=>{Object.freeze(i.sourceEventIds);Object.freeze(i);});Object.freeze(input);
 const groups=buildAppReviewGroups(input);assert.equal(groups.length,1);assert.equal(groups[0]!.seconds,5);assert.deepEqual(groups[0]!.pairs,[['aa','ab']]);
});

test('review ribbon fits actual human activity within local day boundaries, including DST',()=>{
 for(const date of ['2026-03-29','2026-10-25']){
  const start=new Date(date+'T00:00:00').getTime()/1000,endDate=new Date(date+'T00:00:00');endDate.setDate(endDate.getDate()+1);const end=endDate.getTime()/1000;
  const range=reviewTimelineRange(date,[interval('late',end-120,end-30)],end-10);assert.ok(range.start<=end-120);assert.ok(range.end>=end-30);assert.ok(range.start>=start&&range.end<=end);assert.ok(range.end>range.start);
  const empty=reviewTimelineRange(date,[],start+60);assert.ok(empty.start>=start&&empty.end<=end&&empty.end>empty.start);assert.ok(empty.start<=start+60&&empty.end>=start+60);
 }
});

test('review shortcuts preserve native buttons and picker keys while Space still selects visits',async()=>{
 const {reviewShortcutAllowed}=await import('../src/ui/review-apps.ts');
 const row={inReview:true,editing:false,picker:false,nativeControl:false};
 assert.equal(reviewShortcutAllowed(' ',row),true);
 assert.equal(reviewShortcutAllowed('Enter',row),true);
 for(const key of [' ','Enter'])assert.equal(reviewShortcutAllowed(key,{...row,nativeControl:true}),false,`native button owns ${key}`);
 for(const key of [' ','Enter','j','k','a','u','1','z']){
  assert.equal(reviewShortcutAllowed(key,{...row,nativeControl:true,picker:true}),false,`picker owns ${key}`);
  assert.equal(reviewShortcutAllowed(key,{...row,editing:true}),false,`text editor owns ${key}`);
 }
 assert.equal(reviewShortcutAllowed('j',{...row,inReview:false}),false);
 assert.equal(reviewShortcutAllowed('j',{...row,nativeControl:true}),true);
});

test('context groups condense repeated visits without filling gaps or changing source visits',async()=>{
 const {reviewContextGroups}=await import('../src/ui/review-apps.ts');
 const input=Array.from({length:134},(_,i)=>interval('visit'+i,i*20,i*20+5));
 const before=JSON.stringify(input),visits=buildAppReviewGroups(input),contexts=reviewContextGroups(visits);
 assert.equal(contexts.length,1);const context=contexts[0]!;
 assert.equal(context.label,'General activity');assert.equal(context.seconds,670);assert.equal(context.groups.length,134);
 assert.deepEqual(new Set(context.groups),new Set(visits));assert.equal(JSON.stringify(input),before);
 assert.deepEqual(context.groups.map(g=>[g.start,g.end]),input.map(i=>[i.start,i.end]));
 assert.equal(reviewTimelineBars(input,visits,{start:0,end:2680}).length,134);
 assert.equal(reviewAppSections(visits)[0]!.contexts.length,1);
 const selected=Object.fromEntries(context.groups.map(g=>[reviewGroupId(g),true]));
 assert.equal(reviewSelection(visits,selected).pairs.length,134);assert.equal(reviewSelection(visits,selected).seconds,670);
});
test('context groups keep projects, review decisions, pages, apps and split segments separate',async()=>{
 const {reviewContextGroups}=await import('../src/ui/review-apps.ts');
 const input=[
  interval('a',0,5,{browserUrl:'https://example.com/a',browserTitle:'Page A'}),
  interval('b',20,25,{browserUrl:'https://example.com/a',browserTitle:'Page A'}),
  interval('c',40,45,{browserUrl:'https://example.com/b',browserTitle:'Page B'}),
  interval('d',60,65,{browserUrl:'https://example.com/a',browserTitle:'Page A',workspaceId:'manual::/a',userAttribution:'assigned'}),
  interval('e',80,85,{browserUrl:'https://example.com/a',browserTitle:'Page A',workspaceId:'auto::/a'}),
  interval('f',100,105,{browserUrl:'https://example.com/a',browserTitle:'Page A',userAttribution:'unassigned'}),
  interval('g',120,125,{foregroundBundleId:'brave',foregroundName:'Brave',browserUrl:'https://example.com/a',browserTitle:'Page A'}),
  interval('s',140,145,{reviewSegment:'before',userAttribution:'assigned',workspaceId:'manual::/a'}),
  interval('s',145,150,{reviewSegment:'after',userAttribution:'unassigned'}),
 ];
 const visits=buildAppReviewGroups(input),contexts=reviewContextGroups(visits);
 assert.equal(contexts.length,8);assert.equal(contexts.find(c=>c.groups.length===2)?.label,'Page A');
 assert.equal(contexts.reduce((sum,c)=>sum+c.seconds,0),45);
 assert.equal(new Set(contexts.map(c=>c.key)).size,8);
 for(const context of contexts){
  assert.equal(new Set(context.groups.map(g=>JSON.stringify([g.appKey,g.projectPath,g.userAttribution,g.reviewSegment,g.browserUrl]))).size,1);
 }
 const keys=Object.fromEntries(contexts.flatMap(c=>c.groups).map(g=>[reviewGroupId(g),true]));
 assert.equal(reviewSelection(visits,keys).pairs.length,7);
});
test('context checkbox state includes hidden visits and excludes split activity',async()=>{
 const {reviewContextGroups,reviewCheckState}=await import('../src/ui/review-apps.ts');
 const visits=buildAppReviewGroups([interval('a',0,5),interval('b',20,25),interval('s',40,45,{reviewSegment:'before'})]);
 const context=reviewContextGroups(visits).find(c=>c.groups.length===2)!;
 const [first,second]=context.groups;
 assert.deepEqual(reviewCheckState(context.groups,{}),{eligible:context.groups,checked:false,partial:false});
 assert.equal(reviewCheckState(context.groups,{[reviewGroupId(first!)]:true}).partial,true);
 assert.equal(reviewCheckState(context.groups,{[reviewGroupId(first!)]:true,[reviewGroupId(second!)]:true}).checked,true);
 const split=visits.filter(g=>g.reviewSegment);assert.equal(reviewCheckState(split,Object.fromEntries(split.map(g=>[reviewGroupId(g),true]))).checked,false);
 const later=reviewContextGroups([...visits, ...buildAppReviewGroups([interval('new',60,65)])]).find(c=>c.label==='General activity'&&c.groups.length===3)!;
 assert.equal(later.key,context.key);
});

test('reconciliation only contains unresolved activity; automatic assignments need no confirmation',async()=>{
 const {reviewViewGroups}=await import('../src/ui/review-apps.ts');
 const groups=buildAppReviewGroups([
  interval('pending',0,5),
  interval('automatic',10,15,{workspaceId:'local::/SoundScape',attributionSource:'orca-worktree'}),
  interval('manual',20,25,{workspaceId:'manual::/argos',userAttribution:'assigned'}),
  interval('left',30,35,{userAttribution:'unassigned'}),
  interval('conflict',40,45,{workspaceId:'local::/maybe',attributionSource:'conflict'}),
 ]);
 const before=JSON.stringify(groups);
 assert.deepEqual(reviewViewGroups(groups,'queue').map(g=>g.start).sort((a,b)=>a-b),[0,40]);
 assert.deepEqual(reviewViewGroups(groups,'reviewed').map(g=>g.projectPath).sort(),['/SoundScape','/argos']);
 assert.equal(reviewViewGroups(groups,'all').length,5);
 assert.equal(JSON.stringify(groups),before);
});
test('reconciliation defaults to Needs a project and migrates old All activity preferences once',async()=>{
 const {initialReviewState}=await import('../src/ui/review-apps.ts');
 for(const saved of [undefined,null,{},[],{viewMode:'all',filterText:'SoundScape',focused:'old'}])
  assert.deepEqual(initialReviewState(saved),{viewMode:'queue',filterText:'',focused:''});
 assert.deepEqual(initialReviewState({version:2,viewMode:'all',filterText:'Orca',focused:'new'}),{viewMode:'all',filterText:'Orca',focused:'new'});
 assert.equal(initialReviewState({version:2,viewMode:'invalid'}).viewMode,'queue');
});
test('assignment labels and actions distinguish automatic attribution from a pending suggestion',async()=>{
 const {reviewAssignmentLabel,reviewCanAssign}=await import('../src/ui/review-apps.ts');
 const groups=buildAppReviewGroups([
  interval('auto',0,5,{workspaceId:'local::/SoundScape',attributionSource:'orca-worktree'}),
  interval('manual',10,15,{workspaceId:'manual::/SoundScape',userAttribution:'assigned'}),
  interval('left',20,25,{userAttribution:'unassigned'}),interval('pending',30,35),
  interval('conflict',40,45,{workspaceId:'local::/SoundScape',attributionSource:'conflict'}),
 ]).sort((a,b)=>a.start-b.start);
 assert.deepEqual(groups.map(reviewAssignmentLabel),['Automatically assigned · SoundScape','Assigned · SoundScape','Left unassigned','Needs a project','Conflicting matches']);
 assert.equal(reviewCanAssign(groups[0]!,''),false);
 assert.equal(reviewCanAssign(groups[0]!,'/SoundScape'),false);
 assert.equal(reviewCanAssign(groups[0]!,'/other'),true);
 assert.equal(reviewCanAssign(groups[4]!,'/SoundScape'),true);
 assert.equal(reviewCanAssign(groups[2]!,'/SoundScape'),true);
});

test('website context and visit names stay consistent when the page title matches the app',async()=>{
 const {reviewContextTitle,reviewVisitTitle,reviewContextGroups}=await import('../src/ui/review-apps.ts');
 const visits=buildAppReviewGroups([
  interval('page',0,5,{foregroundName:'Culture Club Pro',foregroundBundleId:'webapp.culture',browserDomain:'pro.culture-club.app',browserUrl:'https://pro.culture-club.app/admin/statistics',browserTitle:'Culture Club Pro · Culture Club Pro'}),
  interval('site',20,25,{foregroundName:'Culture Club Pro',foregroundBundleId:'webapp.culture',browserDomain:'pro.culture-club.app'}),
 ]);
 const before=JSON.stringify(visits),contexts=reviewContextGroups(visits);
 assert.equal(contexts.length,2);assert.deepEqual(contexts.map(c=>c.label),['Culture Club Pro','Culture Club Pro']);
 assert.deepEqual(visits.map(reviewContextTitle),['Culture Club Pro','Culture Club Pro']);
 assert.deepEqual(visits.map(reviewVisitTitle),['Culture Club Pro','Culture Club Pro']);
 assert.equal(JSON.stringify(visits),before);assert.equal(visits.filter(v=>v.browserUrl).length,1);
});
test('a known browser site uses its domain, while app-only activity stays general',async()=>{
 const {reviewContextTitle,reviewVisitTitle}=await import('../src/ui/review-apps.ts');
 const browser=buildAppReviewGroups([interval('b',0,5,{foregroundName:'Brave',foregroundBundleId:'com.brave.Browser',browserDomain:'example.com'})])[0]!;
 const general=buildAppReviewGroups([interval('o',10,15)])[0]!;
 assert.equal(reviewContextTitle(browser),'example.com');assert.equal(reviewVisitTitle(browser),'example.com');
 assert.equal(reviewContextTitle(general),'General activity');assert.equal(reviewVisitTitle(general),'Visit');
});
