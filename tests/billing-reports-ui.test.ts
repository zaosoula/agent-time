import{test}from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{computed,ref}from'vue';import{randomUUID}from'node:crypto';import ts from'typescript';
function page(){
 const source=readFileSync(new URL('../src/ui/BillingReports.vue',import.meta.url),'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!.replace(/^import .*;\n/gm,'');
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const calls:Array<{method:string;params:any}>=[],activated:Array<()=>void>=[];const revision=ref(0);let finish!:(value:any)=>void;
 const store={billingProjectRevision:revision,settingsSection:ref('general'),navigate:(page:string)=>calls.push({method:'navigate',params:page})};
 const project={id:'example',name:'Example',policies:[{effectiveFrom:'2026-01-01'}]};
 const request=async(method:string,params:any)=>{calls.push({method,params});if(method==='billing_projects')return{projects:[project]};if(method==='billing_report')return new Promise(resolve=>{finish=resolve;});return null;};
 const bindings={sessionStorage:{setItem:(key:string,value:string)=>calls.push({method:'saved-setting',params:{key,value}})},computed,ref,onMounted:()=>{},onUnmounted:()=>{},onActivated:(fn:()=>void)=>activated.push(fn),useStore:()=>store,request,humanizeError:String,toast:{success(){}},crypto:{randomUUID},setTimeout:()=>1,clearTimeout:()=>{}};
 const state=new Function(...Object.keys(bindings),js+';return{refresh,selectProject,loadReport,configure,projectId,fromDate,toDate,report,reporting,cursor};')(...Object.values(bindings));
 return{state,calls,activated,revision,store,finish:(value:any)=>finish(value)};
}
test('dedicated report page generates from saved project settings and retains its result on activation',async()=>{
 const p=page();await p.state.refresh();assert.equal(p.state.projectId.value,'example');
 p.state.fromDate.value='2026-11-06';p.state.toDate.value='2026-11-12';
 const pending=p.state.loadReport();assert.equal(p.state.reporting.value,true);
 assert.equal(p.calls.filter(c=>c.method==='billing_report').length,1);const input=p.calls.find(c=>c.method==='billing_report')!.params;
 assert.equal(input.project,'example');assert.equal(input.fromDate,'2026-11-06');assert.equal(input.toDate,'2026-11-12');assert.match(input.progressId,/^[a-f0-9-]{36}$/);
 const report={reportId:'saved',fromDate:input.fromDate,toDate:input.toDate,days:[{date:input.fromDate}]};p.finish({report,nextCursor:null});await pending;
 for(const activate of p.activated)activate();assert.equal(p.calls.filter(c=>c.method==='billing_projects').length,1);assert.deepEqual(p.state.report.value,report);
 p.revision.value++;for(const activate of p.activated)activate();await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(p.calls.filter(c=>c.method==='billing_projects').length,2);assert.deepEqual(p.state.report.value,report);assert.equal(p.state.fromDate.value,'2026-11-06');assert.equal(p.calls.filter(c=>c.method==='billing_report').length,1);
 p.state.configure();assert.deepEqual(p.calls.find(c=>c.method==='saved-setting')?.params,{key:'agent-time.settings-tab',value:'billing'});assert.equal(p.store.settingsSection.value,'billing');assert.equal(p.calls.at(-1)!.method,'navigate');assert.equal(p.calls.at(-1)!.params,'settings');
});

test('billing configuration retains policy editing but no longer owns report generation',()=>{
 const settings=readFileSync(new URL('../src/ui/BillingSettings.vue',import.meta.url),'utf8');assert(!settings.includes("'billing_report'"));assert(settings.includes('Open billing reports'));assert(settings.includes('Billing policy'));
 const app=readFileSync(new URL('../src/ui/App.vue',import.meta.url),'utf8');assert(app.includes("id: 'billing', title: 'Billing reports'"));assert(app.includes('<KeepAlive :max="9">'));
});
