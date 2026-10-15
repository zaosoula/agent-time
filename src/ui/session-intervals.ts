import type {Interval,Session} from '../capture/events.ts';

// These identities mirror the session matching rules used by the timesheet:
// children use provider session + agent, roots prefer Dispatch, and roots
// without Dispatch use the provider session. Do not add cwd to these keys.
export function sessionIntervalKey(session:Pick<Session,'child'|'dispatchId'|'sessionId'|'agentId'>):string {
 if(session.child)return JSON.stringify(['child',session.sessionId??null,session.agentId??null]);
 if(session.dispatchId)return JSON.stringify(['dispatch',session.dispatchId]);
 return JSON.stringify(['session',session.sessionId??null]);
}

export function intervalSessionKey(interval:Pick<Interval,'child'|'dispatchId'|'sessionId'|'agentId'>):string {
 if(interval.child)return JSON.stringify(['child',interval.sessionId??null,interval.agentId??null]);
 if(interval.dispatchId)return JSON.stringify(['dispatch',interval.dispatchId]);
 return JSON.stringify(['session',interval.sessionId??null]);
}

export function indexSessionIntervals(intervals:Interval[]):{grouped:Map<string,Interval[]>;running:Map<string,Interval[]>} {
 const grouped=new Map<string,Interval[]>(),running=new Map<string,Interval[]>();
 for(const interval of intervals){
  const target=interval.state==='grouped'?grouped:interval.state==='running'?running:null;
  if(!target)continue;
  const key=intervalSessionKey(interval),list=target.get(key)||[];
  list.push(interval);target.set(key,list);
 }
 return {grouped,running};
}
