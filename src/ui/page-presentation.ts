import {computed,onActivated,onDeactivated,ref,type Ref} from 'vue';
/** Cached pages keep their drafts/jobs, but must release teleported overlays and focus traps. */
export function usePagePresentation(){
 const active=ref(true);
 onActivated(()=>{active.value=true;});
 onDeactivated(()=>{active.value=false;});
 return active;
}
export function useRetainedOpen(open:Ref<boolean>){
 const active=usePagePresentation();
 return computed({get:()=>active.value&&open.value,set:(value:boolean)=>{if(active.value)open.value=value;}});
}
