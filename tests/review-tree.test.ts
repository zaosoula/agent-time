import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Interval} from '../src/capture/events.ts';
import {buildAppReviewGroups,reviewGroupId} from '../src/ui/review-apps.ts';
import {buildReviewTree,reviewNodeSelection,type ReviewNode} from '../src/ui/review-tree.ts';

const interval=(id:string,start:number,end:number,extra:Partial<Interval>={}):Interval=>({start,end,state:'human',proof:'observed',sourceEventIds:[id+'a',id+'b'],hostId:'local',foregroundBundleId:'com.brave.Browser',foregroundName:'Brave',...extra});
const page=(id:string,start:number,end:number,url:string,extra:Partial<Interval>={})=>interval(id,start,end,{browserUrl:url,browserTitle:'Documentation',...extra});
const flatten=(nodes:ReviewNode[]):ReviewNode[]=>nodes.flatMap(node=>[node,...flatten(node.children)]);

test('browser tree groups app, domain, canonical page, visits while conserving every descendant',()=>{
 const groups=buildAppReviewGroups([
  page('a',0,40,'https://example.com/docs?utm_source=email'),
  page('b',100,130,'https://example.com/docs?fbclid=tracking'),
  page('c',200,220,'https://example.com/other'),
  page('d',300,325,'https://other.com/docs'),
 ]),before=JSON.stringify(groups),tree=buildReviewTree(groups);
 assert.equal(tree.length,1);assert.equal(tree[0]!.kind,'app');assert.equal(tree[0]!.seconds,115);
 assert.deepEqual(tree[0]!.children.map(node=>[node.kind,node.label,node.seconds]),[['site','example.com',90],['site','other.com',25]]);
 const context=tree[0]!.children[0]!.children[0]!;
 assert.equal(context.kind,'context');assert.equal(context.seconds,70);assert.equal(context.children.length,2);
 assert.deepEqual(context.children.map(node=>node.kind),['visit','visit']);
 for(const node of flatten(tree)){
  assert.equal(node.seconds,node.groups.reduce((sum,g)=>sum+g.seconds,0));
  if(node.children.length){
   assert.deepEqual(new Set(node.children.flatMap(child=>child.groups)),new Set(node.groups));
   assert.equal(node.children.reduce((sum,child)=>sum+child.groups.length,0),node.groups.length);
  }else assert.equal(node.groups.length,1);
 }
 assert.deepEqual(flatten(tree).filter(node=>node.kind==='visit').map(node=>node.groups[0]!.start).sort((a,b)=>a-b),[0,100,200,300]);
 assert.equal(JSON.stringify(groups),before);
});

test('canonical URLs retain meaningful queries, duplicate query values, fragments and unknown tracking-like parameters',()=>{
 const urls=['https://example.com/search?q=one&utm_medium=email#section','https://example.com/search?q=one#section','https://example.com/search?q=two#section','https://example.com/search?q=one#other','https://example.com/search?q=one&q=two#section','https://example.com/search?q=one&ref=customer#section'];
 const groups=buildAppReviewGroups(urls.map((url,i)=>page(String(i),i*100,i*100+30,url)));
 const contexts=buildReviewTree(groups)[0]!.children[0]!.children;
 assert.equal(contexts.length,5);assert.equal(contexts.find(node=>node.groups.length===2)!.seconds,60);
 assert.ok(contexts.some(node=>node.description?.includes('q=one&q=two')));
 assert.ok(contexts.some(node=>node.description?.includes('ref=customer')));
});

test('short visits collapse beneath their context without absorbing the 15 second boundary or gaps',()=>{
 const groups=buildAppReviewGroups([page('tiny',0,5,'https://example.com/a'),page('small',100,114,'https://example.com/a'),page('boundary',200,215,'https://example.com/a')]);
 const context=buildReviewTree(groups)[0]!.children[0]!.children[0]!;
 const short=context.children.find(node=>node.kind==='short')!;
 assert.equal(short.seconds,19);assert.equal(short.children.length,2);
 assert.deepEqual(short.groups.map(group=>[group.start,group.end]).sort((a,b)=>a[0]!-b[0]!),[[0,5],[100,114]]);
 assert.equal(context.seconds,34);assert.equal(context.children.filter(node=>node.kind==='visit').length,1);
 assert.equal('start' in short,false);assert.equal('end' in context,false);
});

test('nonbrowser general activity uses direct visits and meaningful contexts group repeated visits',()=>{
 const native={foregroundBundleId:'editor',foregroundName:'Editor'};
 const groups=buildAppReviewGroups([interval('plain',0,30,native),interval('doc',100,130,{...native,tabTitle:'Plan.md'}),interval('again',200,230,{...native,tabTitle:'Plan.md'})]);
 const app=buildReviewTree(groups)[0]!;
 assert.equal(app.children.length,2);assert.equal(app.children[0]!.kind,'context');assert.equal(app.children[0]!.label,'Plan.md');
 assert.equal(app.children[1]!.kind,'visit');assert.ok(!flatten([app]).some(node=>node.label==='General activity'));
 assert.equal(buildReviewTree(buildAppReviewGroups([interval('single',0,30,native)]))[0]!.children[0]!.kind,'visit');
});

test('all parent assignments retain mixed existing projects and source split identities',()=>{
 const groups=buildAppReviewGroups([
  page('a',0,30,'https://example.com/a',{workspaceId:'manual::/one',userAttribution:'assigned'}),
  page('b',100,130,'https://example.com/a',{workspaceId:'manual::/two',userAttribution:'assigned'}),
  page('s',200,220,'https://example.com/a',{reviewSegment:'before',workspaceId:'manual::/one',userAttribution:'assigned'}),
  page('s',220,240,'https://example.com/a',{reviewSegment:'after',userAttribution:'unassigned'}),
 ]),tree=buildReviewTree(groups),context=tree[0]!.children[0]!.children[0]!;
 assert.equal(context.groups.length,4);assert.match(context.description!,/Mixed assignments/);
 for(const node of [tree[0]!,tree[0]!.children[0]!,context])assert.deepEqual(new Set(reviewNodeSelection(node,{})),new Set(groups));
 assert.equal(new Set(flatten(tree).filter(node=>node.kind==='visit').map(node=>node.key)).size,4);
 assert.deepEqual(new Set(context.groups.flatMap(group=>group.pairs.map(pair=>JSON.stringify(pair)))),new Set(['["aa","ab"]','["ba","bb"]','["sa","sb"]']));
});

test('filtered input alone defines every ancestor and stable keys survive ordering and assignments',()=>{
 const groups=buildAppReviewGroups([page('a',0,30,'https://example.com/a'),page('b',100,130,'https://example.com/b'),page('c',200,230,'https://other.com/a')]);
 const subset=[groups.find(group=>group.start===0)!],tree=buildReviewTree(subset);
 assert.equal(tree[0]!.seconds,30);assert.deepEqual(tree[0]!.groups,subset);assert.equal(flatten(tree).filter(node=>node.kind==='visit').length,1);
 assert.deepEqual(flatten(buildReviewTree(groups)).map(node=>node.key),flatten(buildReviewTree([...groups].reverse())).map(node=>node.key));
 const reassigned=groups.map(group=>({...group,projectPath:'/new',userAttribution:'assigned' as const}));
 assert.deepEqual(flatten(buildReviewTree(groups)).map(node=>node.key),flatten(buildReviewTree(reassigned)).map(node=>node.key));
});

test('node selection uses selected descendants when present and ignores stale selection IDs',()=>{
 const groups=buildAppReviewGroups([page('a',0,30,'https://example.com/a'),page('b',100,130,'https://example.com/a')]),app=buildReviewTree(groups)[0]!,selected=groups.find(group=>group.start===0)!;
 assert.deepEqual(reviewNodeSelection(app,{[reviewGroupId(selected)]:true,stale:true}),[selected]);
 assert.deepEqual(new Set(reviewNodeSelection(app,{stale:true})),new Set(groups));
 assert.deepEqual(buildReviewTree([]),[]);
});

test('project parents separate unassigned and assigned visits without changing source data or durations',async()=>{
 const {buildProjectReviewTree}=await import('../src/ui/review-tree.ts');
 const groups=buildAppReviewGroups([
  page('a',0,40,'https://example.com/a',{workspaceId:'manual::/one/client',userAttribution:'assigned'}),
  page('b',100,130,'https://example.com/a',{workspaceId:'auto::/one/client'}),
  page('c',200,220,'https://example.com/a',{workspaceId:'manual::/two/client',userAttribution:'assigned'}),
  page('s',300,310,'https://example.com/a',{reviewSegment:'before',workspaceId:'manual::/one/client',userAttribution:'assigned'}),
  page('s',310,320,'https://example.com/a',{reviewSegment:'after',userAttribution:'unassigned'}),
  page('u',400,425,'https://example.com/a'),
 ]),before=JSON.stringify(groups),tree=buildProjectReviewTree(groups);
 assert.equal(new Set(flatten(tree).map(n=>n.key)).size,flatten(tree).length);
 assert.equal(tree.length,3);assert.ok(tree.every(n=>n.kind==='project'));
 assert.deepEqual(tree.map(n=>n.seconds).sort((a,b)=>a-b),[20,35,80]);
 assert.ok(tree.some(n=>n.label==='Unassigned'));
 assert.equal(new Set(tree.map(n=>n.label)).size,3,'same basename projects stay distinguishable');
 for(const project of tree){
  assert.ok(project.children.every(n=>n.kind==='app'));
  assert.equal(project.children.reduce((sum,n)=>sum+n.seconds,0),project.seconds);
 }
 assert.deepEqual(flatten(tree).filter(n=>n.kind==='visit').map(n=>reviewGroupId(n.groups[0]!)).sort(),groups.map(reviewGroupId).sort());
 assert.equal(JSON.stringify(groups),before);
 assert.equal(buildProjectReviewTree([groups[0]!])[0]!.seconds,40);
});
