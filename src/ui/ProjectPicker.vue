<script setup lang="ts">
import {computed,ref} from 'vue';
const props=defineProps<{paths:string[];modelValue:string;label:string}>();
const emit=defineEmits<{ 'update:modelValue':[value:string] }>();
const query=ref(''),open=ref(false);
const basename=(path:string)=>path.split('/').filter(Boolean).at(-1)||path;
const matches=computed(()=>props.paths.filter(path=>`${basename(path)} ${path}`.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())).slice(0,80));
function choose(path:string){emit('update:modelValue',path);query.value='';open.value=false;}
</script>
<template>
 <div class="project-picker">
  <button type="button" class="project-picker-current" :aria-label="label" :aria-expanded="open" @click="open=!open">{{modelValue?basename(modelValue):'Choose project'}} <small v-if="modelValue" :title="modelValue">{{modelValue}}</small></button>
  <div v-if="open" class="project-picker-menu" @keydown.esc.stop="open=false"><input v-model="query" type="search" :aria-label="`Search ${label.toLowerCase()}`" placeholder="Search project or enter /folder/path" autofocus/><div class="project-picker-results"><button v-for="path in matches" :key="path" type="button" :aria-selected="path===modelValue" @click="choose(path)"><strong>{{basename(path)}}</strong><small>{{path}}</small></button><button v-if="query.startsWith('/')&&!paths.includes(query.trim())" type="button" @click="choose(query.trim())"><strong>Use this folder</strong><small>{{query.trim()}}</small></button><p v-if="!matches.length&&!query.startsWith('/')">No matching project. Discover a project by working in its folder.</p></div></div>
 </div>
</template>
<style scoped>
.project-picker{position:relative;min-width:200px;flex:1 1 220px}.project-picker-current{width:100%;min-height:34px;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--hover);color:var(--text);text-align:left;font-size:12px}.project-picker-current small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:10px}.project-picker-menu{position:absolute;z-index:20;top:100%;left:0;right:0;min-width:280px;padding:6px;border:1px solid var(--border);border-radius:7px;background:var(--panel);box-shadow:0 8px 24px #0004}.project-picker-menu input{box-sizing:border-box;width:100%;padding:8px;border:1px solid var(--border);border-radius:5px;background:var(--hover);color:var(--text)}.project-picker-results{max-height:230px;overflow:auto}.project-picker-results button{display:block;width:100%;padding:8px;text-align:left;color:var(--text);border-radius:5px}.project-picker-results button:hover,.project-picker-results button:focus-visible{background:var(--hover);outline:2px solid var(--blue)}.project-picker-results strong,.project-picker-results small{display:block}.project-picker-results small{overflow-wrap:anywhere;color:var(--muted);font-size:10px}.project-picker-results p{color:var(--muted);font-size:11px;padding:8px}
</style>
