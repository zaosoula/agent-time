/** Native sessions are scoped by host and provider. Dispatch IDs already name
 * an Orca execution, so its worker and native hooks must share one identity. */
export interface AgentIdentity {hostId?:string;provider?:string;sessionId?:string;agentId?:string;dispatchId?:string;child?:boolean;}
export function agentSessionKey(item:AgentIdentity):string{
 if(item.child)return JSON.stringify(['child',item.hostId??null,item.provider??null,item.sessionId??null,item.agentId??null]);
 if(item.dispatchId)return JSON.stringify(['dispatch',item.hostId??null,item.dispatchId]);
 return JSON.stringify(['session',item.hostId??null,item.provider??null,item.sessionId??null]);
}
export function hasNativeSessionIdentity(item:AgentIdentity):boolean{
 return Boolean(typeof item.hostId==='string'&&item.hostId&&typeof item.provider==='string'&&item.provider&&typeof item.sessionId==='string'&&item.sessionId);
}
