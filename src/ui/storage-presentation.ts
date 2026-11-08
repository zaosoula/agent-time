import type {StorageUsage} from '../capture/storage-usage.ts';
export function storageProjection(byDay:StorageUsage['byDay'],history?:Pick<NonNullable<StorageUsage['history']>,'efficient'|'originalBytes'|'compressedBytes'>):{bytes:number|null;compressed:boolean}{
 const days=new Map<string,number>();for(const row of byDay)if(row.events>0)days.set(row.date,(days.get(row.date)||0)+row.payloadBytes);
 const recent=[...days].sort((a,b)=>b[0].localeCompare(a[0])).slice(0,7),compressed=Boolean(history?.efficient&&history.originalBytes>0);
 const ratio=compressed?Math.min(1,history!.compressedBytes/history!.originalBytes):1;
 return {bytes:recent.length?Math.round(recent.reduce((n,[,bytes])=>n+bytes,0)/recent.length*30*ratio):null,compressed};
}
