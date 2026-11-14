<script setup lang="ts">
defineProps<{from:string;through:string;source:string;mode:'live'|'snapshot';timezone?:string;detail?:string}>();
</script>
<template>
 <aside class="report-scope" aria-label="Report scope"><strong>{{mode==='snapshot'?'Saved snapshot':'Live activity'}} · {{from===through?'Day detail':'Full period'}}</strong><span>{{from}}<template v-if="from!==through"> – {{through}}</template><template v-if="timezone"> · {{timezone}}</template> · {{source}}</span><small v-if="detail">{{detail}}</small><slot /></aside>
</template>
<style scoped>.report-scope{display:grid;gap:5px;margin:14px 0;padding:14px 16px;border:1px solid var(--border);border-radius:var(--radius-card);font-size:var(--text-sm);overflow-wrap:anywhere}.report-scope span,.report-scope small{color:var(--muted);line-height:1.5}</style>
