<script setup lang="ts">
import {nextTick,reactive,ref,watch} from 'vue';
import {useStore} from './store.ts';
import SectionHeading from './SectionHeading.vue';
import WeeklyReview from './WeeklyReview.vue';
import BillingReports from './BillingReports.vue';
import UsagePage from './UsagePage.vue';
import WorkOutcomes from './WorkOutcomes.vue';
import {capturePageScroll,restorePageScroll} from './page-scroll.ts';
const store=reactive(useStore());
const sections=[{id:'time',label:'Time'},{id:'billing',label:'Billing'},{id:'usage',label:'Usage'},{id:'evidence',label:'Evidence'}] as const;
const root=ref<HTMLElement|null>(null);
const scroll=new Map<string,ReturnType<typeof capturePageScroll>>();
watch(()=>store.reportsSection,(next,previous)=>{
 if(root.value)scroll.set(previous,capturePageScroll(root.value));
 void nextTick().then(()=>{if(root.value&&store.reportsSection===next){root.value.scrollTop=0;root.value.scrollLeft=0;restorePageScroll(root.value,scroll.get(next)||[]);}});
});
</script>
<template>
 <section ref="root" class="reports-workspace app-page">
  <SectionHeading class="workspace-heading" title="Reports" description="Review your time, usage and supporting evidence." :level="1" size="page">
   <nav class="workspace-tabs" aria-label="Report views"><button v-for="section in sections" :key="section.id" :class="['workspace-tab',{active:store.reportsSection===section.id}]" :aria-current="store.reportsSection===section.id?'page':undefined" @click="store.reportsSection=section.id">{{ section.label }}</button></nav>
  </SectionHeading>
  <KeepAlive :max="4">
   <WeeklyReview v-if="store.reportsSection==='time'" key="time" />
   <UsagePage v-else-if="store.reportsSection==='usage'" key="usage" :status="store.status" />
   <BillingReports v-else-if="store.reportsSection==='billing'" key="billing" />
   <WorkOutcomes v-else key="evidence" :active="store.page === 'reports' && store.reportsSection === 'evidence'" />
  </KeepAlive>
 </section>
</template>
<style scoped>
.reports-workspace{min-width:0;flex:1;overflow:auto}.workspace-heading{padding:28px 30px 0}.workspace-tabs{display:flex;gap:5px;margin-top:22px;border-bottom:1px solid var(--border)}.workspace-tab{padding:10px 16px;color:var(--muted);border-bottom:2px solid transparent}.workspace-tab:hover{color:var(--text);background:var(--hover)}.workspace-tab.active{color:var(--text);border-bottom-color:var(--blue);font-weight:600}.workspace-tab:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
</style>
