import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import * as requireVue from 'vue';
import {createRenderer,defineComponent,h,nextTick,onMounted,onUnmounted,reactive,ref,KeepAlive,Teleport} from 'vue';
import {compileTemplate} from '@vue/compiler-sfc';
import ts from 'typescript';
import {useRetainedOpen} from '../src/ui/page-presentation.ts';
import {capturePageScroll,restorePageScroll} from '../src/ui/page-scroll.ts';

type Node={type:string;children:Node[];parent:Node|null;text:string;props:Record<string,unknown>};
const node=(type:string):Node=>({type,children:[],parent:null,text:'',props:{}});
const renderer=createRenderer<Node,Node>({
 createElement:node,createText:text=>({...node('text'),text}),createComment:text=>({...node('comment'),text}),
 setText:(n,text)=>{n.text=text;},setElementText:(n,text)=>{n.text=text;n.children=[];},
 parentNode:n=>n.parent,nextSibling:n=>n.parent?.children[n.parent.children.indexOf(n)+1]||null,
 insert:(n,parent,anchor)=>{if(n.parent)n.parent.children.splice(n.parent.children.indexOf(n),1);n.parent=parent;const i=anchor?parent.children.indexOf(anchor):-1;if(i<0)parent.children.push(n);else parent.children.splice(i,0,n);},
 remove:n=>{if(n.parent)n.parent.children.splice(n.parent.children.indexOf(n),1);n.parent=null;},
 patchProp:(n,key,_old,value)=>{n.props[key]=value;},
});

test('the real app page boundary retains a pending job, drafts and results through all seven workspaces',async()=>{
 const source=readFileSync(new URL('../src/ui/App.vue',import.meta.url),'utf8').match(/<KeepAlive[\s\S]*?<\/KeepAlive>/)![0];
 const compiled=compileTemplate({source,filename:'App.vue',id:'retention-test'});assert.deepEqual(compiled.errors,[]);
 const js=ts.transpileModule(compiled.code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports:Record<string,unknown>={};new Function('require','exports',js)(createRequire(import.meta.url),exports);
 const store=reactive({page:'settings',status:null,issues:[] as string[]}),context:any={};let mounts=0,unmounts=0,resolveJob!:(value:string)=>void;
 const Settings=defineComponent({setup(){mounts++;onUnmounted(()=>unmounts++);const draft=ref('unfinished edit'),result=ref('');context.draft=draft;context.result=result;
  onMounted(()=>{void new Promise<string>(resolve=>{resolveJob=resolve;}).then(value=>result.value=value);});
  return()=>h('section',draft.value+':'+result.value);
 }});
 const Other=defineComponent({setup(){return()=>h('section','other');}});
 const app=renderer.createApp(defineComponent({data:()=>({store,busy:false}),methods:{toggleCapture(){},updateSettings(){},settingsError(){},reviewSite(){}},render:exports.render as any}));
 for(const name of ['TodayPage','ReviewPage','ProjectsPage','ReportsPage','BillingReportsPage'])app.component(name,Other);
 app.component('CaptureSettingsPage',Settings);const root=node('root');app.mount(root);
 context.draft.value='my unsaved policy';store.page='reports';await nextTick();resolveJob('completed in background');await nextTick();
 for(const page of ['today','sessions','review','projects','billing','reports','settings']){store.page=page;await nextTick();}
 assert.equal(mounts,1);assert.equal(unmounts,0);assert.equal(context.draft.value,'my unsaved policy');assert.equal(context.result.value,'completed in background');
 assert(root.children.some(n=>n.text==='my unsaved policy:completed in background'));app.unmount();assert.equal(unmounts,1);
});

test('scroll restoration keeps vertical and horizontal context without touching replaced result nodes',()=>{
 const table={scrollTop:120,scrollLeft:80},removed={scrollTop:60,scrollLeft:0};
 const root={scrollTop:350,scrollLeft:0,querySelectorAll:()=>[table,removed],contains:(value:unknown)=>value===table};
 const saved=capturePageScroll(root as unknown as HTMLElement);root.scrollTop=0;table.scrollTop=0;table.scrollLeft=0;removed.scrollTop=0;
 restorePageScroll(root as unknown as HTMLElement,saved);assert.equal(root.scrollTop,350);assert.deepEqual(table,{scrollTop:120,scrollLeft:80});assert.equal(removed.scrollTop,0);
});

test('ordinary navigation preserves global filters and selected session; explicit project changes clear selection',()=>{
 const source=readFileSync(new URL('../src/ui/store.ts',import.meta.url),'utf8').match(/  function navigate\(destination: Page,[\s\S]*?\n  }/)![0];
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const page=ref('today'),project=ref('/project'),selectedSessionKey=ref('selected');
 const navigate=new Function('page','project','selectedSessionKey','reportsSection','settingsSection','connectionsSection',js+';return navigate;')(page,project,selectedSessionKey,ref('time'),ref('general'),ref('sources'));
 navigate('settings');navigate('today');assert.equal(project.value,'/project');assert.equal(selectedSessionKey.value,'selected');
 navigate('today','all');assert.equal(project.value,'all');assert.equal(selectedSessionKey.value,'');
});


test('cached page dialogs release teleported content while retaining the draft and intended open state',async()=>{
 const body=node('body'),current=ref('editor');let state:any;
 const Editor=defineComponent({setup(){const open=ref(true),draft=ref('unfinished note'),presented=useRetainedOpen(open);state={open,draft,presented};return()=>h('section',[h(Teleport,{to:body as any},presented.value?[h('dialog',draft.value)]:[])]);}});
 const Other=defineComponent({setup(){return()=>h('section','destination');}});
 const app=renderer.createApp(defineComponent({setup(){return()=>h(KeepAlive,null,{default:()=>[current.value==='editor'?h(Editor):h(Other)]});}}));
 app.mount(node('root'));assert.equal(body.children.filter(n=>n.type==='dialog').length,1);
 current.value='other';await nextTick();assert.equal(body.children.filter(n=>n.type==='dialog').length,0);
 state.presented.value=false;assert.equal(state.open.value,true);assert.equal(state.draft.value,'unfinished note');
 current.value='editor';await nextTick();assert.equal(body.children.filter(n=>n.type==='dialog').length,1);assert.equal(state.presented.value,true);app.unmount();
});

test('discarded hidden-page requests retry on return instead of leaving a permanently empty view',async()=>{
 for(const kind of ['WorkOutcomes','WeeklyReview']){
  const source=readFileSync(new URL(`../src/ui/${kind}.vue`,import.meta.url),'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!.replace(/^import .*;\n/gm,'');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.None,target:ts.ScriptTarget.ES2022}}).outputText;
  const store=reactive({page:kind==='WorkOutcomes'?'outcomes':'weekly',selectedDate:'2026-11-10',project:'all',timelineProjects:[],reviewRevision:0});
  const pending:Array<(value:unknown)=>void>=[],activated:Array<()=>void>=[];
  const read=()=>new Promise(resolve=>pending.push(resolve));
  const bindings={defineProps:()=>({}),usePagePresentation:()=>ref(true),computed:requireVue.computed,reactive,ref,watch:requireVue.watch,onMounted:()=>{},onUnmounted:()=>{},onActivated:(fn:()=>void)=>activated.push(fn),useStore:()=>store,workOutcomeTransport:{list:read},weeklyTransport:{review:read},windowVisible:ref(true),humanizeError:String,clock:String};
  const state=new Function(...Object.keys(bindings),code+';return {loading,error,load};')(...Object.values(bindings));
  assert.equal(pending.length,1);const page=store.page;store.page='settings';store.selectedDate='2026-11-17';await nextTick();
  pending[0]!({projects:[],days:[]});await new Promise(resolve=>setTimeout(resolve,0));assert.equal(state.loading.value,false);
  store.selectedDate='2026-11-10';await nextTick();store.page=page;for(const activate of activated)activate();await nextTick();assert.equal(pending.length,2,kind);
  pending[1]!({projects:[],days:[]});await new Promise(resolve=>setTimeout(resolve,0));assert.equal(state.loading.value,false);
 }
});

test('legacy destinations open the matching new workspace without dropping project context',()=>{
 const source=readFileSync(new URL('../src/ui/store.ts',import.meta.url),'utf8').match(/  function navigate\(destination: Page,[\s\S]*?\n  }/)![0];
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const page=ref('today'),project=ref('/project'),selectedSessionKey=ref('selected'),reportsSection=ref('time'),settingsSection=ref('general'),connectionsSection=ref('sources');
 const navigate=new Function('page','project','selectedSessionKey','reportsSection','settingsSection','connectionsSection',js+';return navigate;')(page,project,selectedSessionKey,reportsSection,settingsSection,connectionsSection);
 for(const [destination,section]of [['weekly','time'],['usage','usage'],['outcomes','evidence']]){navigate(destination);assert.equal(page.value,'reports');assert.equal(reportsSection.value,section);}
 navigate('health');assert.equal(page.value,'settings');assert.equal(settingsSection.value,'connections');assert.equal(connectionsSection.value,'health');assert.equal(project.value,'/project');assert.equal(selectedSessionKey.value,'selected');
});

test('the real Reports boundary retains each nested report view',async()=>{
 const source=readFileSync(new URL('../src/ui/ReportsPage.vue',import.meta.url),'utf8').match(/<KeepAlive[\s\S]*?<\/KeepAlive>/)![0];
 const compiled=compileTemplate({source,filename:'ReportsPage.vue',id:'nested-report-test'});assert.deepEqual(compiled.errors,[]);
 const js=ts.transpileModule(compiled.code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports:Record<string,unknown>={};new Function('require','exports',js)(createRequire(import.meta.url),exports);
 const store=reactive({reportsSection:'time',status:null});const drafts:any={};let mounts=0;
 const View=(key:string)=>defineComponent({setup(){mounts++;const draft=ref(key);drafts[key]=draft;return()=>h('section',draft.value);}});
 const app=renderer.createApp(defineComponent({data:()=>({store}),render:exports.render as any}));
 app.component('WeeklyReview',View('time'));app.component('UsagePage',View('usage'));app.component('WorkOutcomes',View('evidence'));
 app.mount(node('root'));drafts.time.value='retained week';for(const section of ['usage','evidence','time','usage','time']){store.reportsSection=section;await nextTick();}
 assert.equal(mounts,3);assert.equal(drafts.time.value,'retained week');app.unmount();
});


function actualPageScript(name:string, bindings:Record<string,unknown>, expose:string) {
 const source=readFileSync(new URL(`../src/ui/${name}.vue`,import.meta.url),'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!.replace(/^import .*;\n/gm,'');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.None,target:ts.ScriptTarget.ES2022}}).outputText;
 const values={computed:requireVue.computed,reactive,ref,watch:requireVue.watch,nextTick,onMounted:()=>{},onActivated:()=>{},...bindings};
 return new Function(...Object.keys(values),code+`;return {${expose}};`)(...Object.values(values));
}
const flushPresentation=async()=>{await nextTick();await nextTick();await nextTick();};

test('project Evidence reloads a changed hidden date and only the visible evidence instance reads history',async()=>{
 const store=reactive({page:'projects',projectsSection:'evidence',reportsSection:'evidence',selectedDate:'2026-11-10',project:'all',timelineProjects:[]});
 const projectReads:string[]=[],reportReads:string[]=[];
 const make=(workspace:string,calls:string[])=>actualPageScript('WorkOutcomes',{
  defineProps:()=>reactive({get active(){return store.page===workspace&&(workspace==='projects'?store.projectsSection:store.reportsSection)==='evidence';}}),
  usePagePresentation:()=>ref(true),useStore:()=>store,clock:String,humanizeError:String,
  workOutcomeTransport:{list:async(date:string)=>{calls.push(date);return {projects:[]};}},
 },'outcomes');
 make('projects',projectReads);make('reports',reportReads);await flushPresentation();
 assert.deepEqual(projectReads,['2026-11-10']);assert.deepEqual(reportReads,[]);
 store.projectsSection='overview';store.selectedDate='2026-11-11';await flushPresentation();
 assert.deepEqual(projectReads,['2026-11-10']);assert.deepEqual(reportReads,[]);
 store.projectsSection='evidence';await flushPresentation();assert.deepEqual(projectReads,['2026-11-10','2026-11-11']);
 store.page='reports';await flushPresentation();assert.deepEqual(reportReads,['2026-11-11']);
 store.selectedDate='2026-11-12';await flushPresentation();
 assert.deepEqual(reportReads,['2026-11-11','2026-11-12']);assert.deepEqual(projectReads,['2026-11-10','2026-11-11']);
});

test('explicit account limits focus wins after report and app scroll restoration and waits for visibility',async()=>{
 const store={page:ref('sessions'),reportsSection:ref('evidence'),usageFocus:ref(''),usage:ref({}),usageError:ref('')};
 const reports=actualPageScript('ReportsPage',{useStore:()=>store,capturePageScroll,restorePageScroll},'root,scroll');
 const element={scrollTop:500,scrollLeft:0,querySelectorAll:()=>[],contains:()=>false};reports.root.value=element;
 reports.scroll.set('usage',[{element:reports.root.value,top:100,left:0}]);
 const presented=ref(false);let focused=0;
 const usage=actualPageScript('UsagePage',{
  useStore:()=>store,defineProps:()=>({status:null}),usePagePresentation:()=>presented,compactNumber:String,usd:String,
 },'limitsSection');
 usage.limitsSection.value={scrollIntoView(){element.scrollTop=999;},focus(){focused++;}};
 store.usageFocus.value='limits';await flushPresentation();assert.equal(store.usageFocus.value,'limits');assert.equal(focused,0);
 // The real App restores its outer workspace after one nextTick.
 requireVue.watch(store.page,()=>{void nextTick().then(()=>{element.scrollTop=50;});});
 store.page.value='reports';store.reportsSection.value='usage';presented.value=true;await flushPresentation();
 assert.equal(element.scrollTop,999);assert.equal(store.usageFocus.value,'');assert.equal(focused,1);
});

test('a first visit to a report section starts at zero while cached sections retain scroll',async()=>{
 const store={reportsSection:ref('time')};
 const reports=actualPageScript('ReportsPage',{useStore:()=>store,capturePageScroll,restorePageScroll},'root');
 const element={scrollTop:400,scrollLeft:20,querySelectorAll:()=>[],contains:()=>false};reports.root.value=element;
 store.reportsSection.value='usage';await flushPresentation();assert.equal(element.scrollTop,0);assert.equal(element.scrollLeft,0);
 element.scrollTop=100;store.reportsSection.value='time';await flushPresentation();assert.equal(element.scrollTop,400);assert.equal(element.scrollLeft,20);
 store.reportsSection.value='usage';await flushPresentation();assert.equal(element.scrollTop,100);assert.equal(element.scrollLeft,0);
});
