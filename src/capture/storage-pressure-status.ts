export interface StoragePressureNotice {
 id:string;reason:'disk-space';phase:'queued'|'compressing'|'ready'|'blocked'|'failed'|'resumed';autoResume?:boolean;
 at:number;freeBytes:number|null;savedBytes:number;
}
export function isStoragePressureNotice(value:unknown):value is StoragePressureNotice{
 if(!value||typeof value!=='object')return false;
 const v=value as Record<string,unknown>;
 return typeof v.id==='string'&&v.id.length>0&&v.id.length<=80&&v.reason==='disk-space'&&['queued','compressing','ready','blocked','failed','resumed'].includes(String(v.phase))&&(v.autoResume===undefined||typeof v.autoResume==='boolean')&&typeof v.at==='number'&&Number.isFinite(v.at)&&typeof v.savedBytes==='number'&&Number.isFinite(v.savedBytes)&&v.savedBytes>=0&&(v.freeBytes===null||typeof v.freeBytes==='number'&&Number.isFinite(v.freeBytes)&&v.freeBytes>=0);
}
export function storagePressureDetail(notice:StoragePressureNotice):string{
 if(notice.phase==='queued'||notice.phase==='compressing')return 'Capture paused because less than 1 GB is free. Stored history is being compressed automatically.';
 if(notice.phase==='resumed')return 'Capture restarted automatically after free space recovered.';
 const resume=notice.autoResume?' Free space is checked every 10 seconds; capture restarts automatically when space and your storage budget allow.':' Resume capture when you are ready.';
 if(notice.phase==='ready')return 'Compression finished and enough space is available.'+resume;
 if(notice.phase==='failed')return 'Automatic compression could not finish. Capture remains paused.'+resume;
 return 'Compression finished, but storage is still full.'+resume;
}
