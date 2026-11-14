import {startBackgroundActivity,backgroundActivities,clearCompletedBackgroundActivities} from '../src/ui/background-activity.ts';
import{test}from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{computed,ref,watch}from'vue';import{randomUUID}from'node:crypto';import ts from'typescript';
function page(){
 const source=readFileSync(new URL('../src/ui/BillingReports.vue',import.meta.url),'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!.replace(/^import .*;\n/gm,'');
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const calls:Array<{method:string;params:any}>=[],activated:Array<()=>void>=[];const revision=ref(0);let finish!:(value:any)=>void;
 const scope=ref({from:'2026-11-01',to:'2026-11-14',mode:'day'});
 const store={project:ref('all'),period:scope,setPeriod:(from:string,to:string)=>{scope.value={...scope.value,from,to};},billingProjectRevision:revision,settingsSection:ref('general'),openProject:(...params:any[])=>calls.push({method:'open-project',params}),navigate:(page:string)=>calls.push({method:'navigate',params:page})};
 const project={id:'example',name:'Example',sources:{repositories:['/example']},policies:[{effectiveFrom:'2026-01-01'}]};
 const request=async(method:string,params:any)=>{calls.push({method,params});if(method==='billing_projects')return{projects:[project]};if(method==='billing_report_history')return{reports:[{reportId:'historical',projectId:'example',fromDate:'2026-10-01',toDate:'2026-10-02'}],nextHistoryCursor:'9'};if(method==='billing_report')return new Promise(resolve=>{finish=resolve;});return null;};
 backgroundActivities.value=[];
 const bindings={startBackgroundActivity,clearCompletedBackgroundActivities,sessionStorage:{setItem:(key:string,value:string)=>calls.push({method:'saved-setting',params:{key,value}})},computed,ref,watch,onMounted:()=>{},onUnmounted:()=>{},onActivated:(fn:()=>void)=>activated.push(fn),useStore:()=>store,request,humanizeError:String,toast:{success(){}},crypto:{randomUUID},setTimeout:()=>1,clearTimeout:()=>{}};
 const state=new Function(...Object.keys(bindings),js+';return{refresh,selectProject,loadReport,configure,projectId,fromDate,toDate,report,reporting,cursor,view,showSaved,loadHistory,loadSavedReport,history,historyCursor,savedReport,generatedReport,generatedCursor,savedCursor};')(...Object.values(bindings));
 return{state,calls,activated,revision,store,finish:(value:any)=>finish(value)};
}
test('dedicated report page generates from saved project settings and retains its result on activation',async()=>{
 const p=page();await p.state.refresh();assert.equal(p.state.projectId.value,'example');
 p.state.fromDate.value='2026-11-06';p.state.toDate.value='2026-11-12';
 const pending=p.state.loadReport();assert.equal(p.state.reporting.value,true);assert.equal(backgroundActivities.value[0]?.done,false);
 assert.equal(p.calls.filter(c=>c.method==='billing_report').length,1);const input=p.calls.find(c=>c.method==='billing_report')!.params;
 assert.equal(input.project,'example');assert.equal(input.fromDate,'2026-11-06');assert.equal(input.toDate,'2026-11-12');assert.match(input.progressId,/^[a-f0-9-]{36}$/);
 const report={reportId:'saved',fromDate:input.fromDate,toDate:input.toDate,days:[{date:input.fromDate}]};p.finish({report,nextCursor:null});await pending;assert.equal(backgroundActivities.value[0]?.label,'Billing report ready');assert.equal(backgroundActivities.value[0]?.done,true);
 for(const activate of p.activated)activate();assert.equal(p.calls.filter(c=>c.method==='billing_projects').length,1);assert.deepEqual(p.state.report.value,report);
 p.revision.value++;for(const activate of p.activated)activate();await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(p.calls.filter(c=>c.method==='billing_projects').length,2);assert.deepEqual(p.state.report.value,report);assert.equal(p.state.fromDate.value,'2026-11-06');assert.equal(p.calls.filter(c=>c.method==='billing_report').length,1);
 p.state.configure();assert.deepEqual(p.calls.at(-1),{method:'open-project',params:[undefined,'billing','example']});
 p.state.selectProject('other');assert.equal(backgroundActivities.value.length,0,'invalidated results must dismiss their completion link');
});

test('billing configuration retains policy editing but no longer owns report generation',()=>{
 const settings=readFileSync(new URL('../src/ui/BillingSettings.vue',import.meta.url),'utf8');assert(!settings.includes("'billing_report'"));assert(settings.includes('Open billing reports'));assert(settings.includes('Billing policy'));
 const app=readFileSync(new URL('../src/ui/App.vue',import.meta.url),'utf8');assert(!app.includes("id: 'billing', title: 'Billing'"));
 const reports=readFileSync(new URL('../src/ui/ReportsPage.vue',import.meta.url),'utf8');assert(reports.includes("id:'billing',label:'Billing'"));assert(reports.includes('<BillingReports'));
});

test('saved reports browse without disturbing the pending generated report and open by immutable ID',async()=>{
 const p=page();await p.state.refresh();p.state.fromDate.value='2026-11-01';p.state.toDate.value='2026-11-03';
 const pending=p.state.loadReport();p.state.showSaved();await Promise.resolve();
 assert.equal(p.state.history.value.length,1);await p.state.loadSavedReport(p.state.history.value[0]);
 assert.equal(p.calls.filter(c=>c.method==='billing_report').length,1);
 const generated={reportId:'new',projectId:'example',fromDate:'2026-11-01',toDate:'2026-11-03',days:[{date:'2026-11-01'}]};
 p.finish({report:generated,nextCursor:'31'});await pending;
 assert.deepEqual(p.state.generatedReport.value,generated);assert.equal(p.state.savedReport.value,null);
 const opening=p.state.loadSavedReport(p.state.history.value[0]);const input=p.calls.at(-1)!.params;
 assert.equal(input.reportId,'historical');assert.equal(input.fromDate,'2026-10-01');assert.equal(input.progressId,undefined);
 const historical={reportId:'historical',projectId:'example',fromDate:'2026-10-01',toDate:'2026-10-02',days:[]};p.finish({report:historical,nextCursor:'62'});await opening;
 assert.deepEqual(p.state.report.value,historical);assert.equal(p.state.savedCursor.value,'62');assert.equal(p.state.generatedCursor.value,'31');assert.equal(p.state.historyCursor.value,'9');
 p.state.view.value='generate';assert.deepEqual(p.state.report.value,generated);assert.equal(p.state.fromDate.value,'2026-11-01');
 for(const activate of p.activated)activate();assert.equal(p.calls.filter(c=>c.method==='billing_report').length,2);
 p.state.view.value='saved';const exporting=p.state.loadReport(false,'csv');assert.equal(p.calls.at(-1)!.params.reportId,'historical');assert.equal(p.calls.at(-1)!.params.cursor,undefined);p.finish({report:historical,nextCursor:null,export:{path:'/synthetic.csv'}});await exporting;
 await p.state.loadHistory(true);assert.equal(p.calls.at(-1)!.params.historyCursor,'9');assert.equal(p.calls.at(-1)!.params.cursor,undefined);
 const historyCalls=p.calls.filter(c=>c.method==='billing_report_history').length,retainedRows=p.state.history.value.length;p.state.view.value='generate';p.state.showSaved();await Promise.resolve();assert.equal(p.calls.filter(c=>c.method==='billing_report_history').length,historyCalls);assert.equal(p.state.history.value.length,retainedRows);
 await p.state.loadHistory();assert.equal(p.calls.filter(c=>c.method==='billing_report_history').length,historyCalls+1);assert.equal(p.calls.at(-1)!.params.historyCursor,undefined);assert.equal(p.state.history.value.length,1);
});

test('new billing requests use shared dates while an existing snapshot exports its original scope',async()=>{
 const p=page();await p.state.refresh();p.store.period.value={from:'2026-11-06',to:'2026-11-12',mode:'custom'};
 const pending=p.state.loadReport();let input=p.calls.at(-1)!.params;assert.equal(input.fromDate,'2026-11-06');assert.equal(input.toDate,'2026-11-12');
 p.store.period.value={from:'2026-11-01',to:'2026-11-14',mode:'custom'};
 const snapshot={reportId:'original-scope',projectId:'example',fromDate:'2026-11-06',toDate:'2026-11-12',days:[]};p.finish({report:snapshot,nextCursor:null});await pending;assert.deepEqual(p.state.report.value,snapshot);
 const exporting=p.state.loadReport(false,'csv');input=p.calls.at(-1)!.params;assert.equal(input.fromDate,'2026-11-06');assert.equal(input.toDate,'2026-11-12');assert.equal(input.reportId,'original-scope');p.finish({report:snapshot,nextCursor:null});await exporting;
});
