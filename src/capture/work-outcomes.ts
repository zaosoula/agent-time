import {execFile,execFileSync} from 'node:child_process';
import {existsSync,statSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {promisify} from 'node:util';
import type {Summary} from './events.ts';
import {summaryForDate} from './daily.ts';
import {projectPathFromWorktree} from './website-resolver.ts';

export interface LocalCommit {hash:string;committedAt:number;subject:string;}
export interface ProjectWorkOutcome {projectPath:string;branches:string[];commits:LocalCommit[];moreCommits:boolean;}
export interface WorkOutcomes {date:string;projects:ProjectWorkOutcome[];skippedProjects:number;skippedWorktrees:number;unavailableProjects:number;gitAvailable:boolean;}

type GitRunner=(cwd:string,args:string[])=>Promise<string|null>;
const maxProjects=12,maxWorktrees=8,maxCommits=12;

function gitBinary():string|null {
  for(const path of ['/opt/homebrew/bin/git','/usr/local/bin/git'])if(existsSync(path))return path;
  if(!existsSync('/usr/bin/git'))return null;
  // macOS's /usr/bin/git shim may open a Command Line Tools installation prompt.
  if(process.platform==='darwin')try{execFileSync('/usr/bin/xcode-select',['-p'],{stdio:'ignore',timeout:1000});}catch{return null;}
  return '/usr/bin/git';
}

const git=gitBinary();
const defaultRunner:GitRunner=async(cwd,args)=>{
  if(!git)return null;
  try{return (await promisify(execFile)(git,['-C',cwd,...args],{
    timeout:2000,maxBuffer:64_000,
    env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1'},
  })).stdout;}catch{return null;}
};

function candidatePaths(summary:Summary,date:string):string[]{
  const day=summaryForDate(summary,date);
  const workspaces=new Set(day.intervals.map(interval=>interval.workspaceId).filter((id):id is string=>Boolean(id)));
  const sessions=new Set(day.intervals.filter(interval=>interval.sessionId).map(interval=>JSON.stringify([interval.hostId,interval.sessionId])));
  const paths=new Set<string>();
  for(const id of workspaces){const path=id.split('::').at(-1);if(path&&isAbsolute(path))paths.add(resolve(path));}
  for(const session of summary.sessions){
    if(!session.cwd||!isAbsolute(session.cwd))continue;
    if(session.workspaceId&&workspaces.has(session.workspaceId)||sessions.has(JSON.stringify([session.hostId,session.sessionId])))paths.add(resolve(session.cwd));
  }
  return [...paths];
}

export async function localWorkOutcomes(summary:Summary,date:string,runner:GitRunner=defaultRunner):Promise<WorkOutcomes>{
  // summaryForDate also rejects impossible calendar dates and handles 23/25-hour days.
  const start=new Date(`${date}T00:00:00`);
  const paths=candidatePaths(summary,date);
  const end=new Date(start);end.setDate(end.getDate()+1);
  const from=start.getTime()/1000,to=end.getTime()/1000;
  const projects=new Map<string,Set<string>>();
  for(const path of paths){
    const projectPath=projectPathFromWorktree(path);
    if(existsSync(path))try{
      if(!statSync(path).isDirectory())continue;
      const worktrees=projects.get(projectPath)||new Set<string>();
      if(existsSync(join(projectPath,'.git')))worktrees.add(projectPath);
      worktrees.add(path);projects.set(projectPath,worktrees);
    }catch{/* Ignore unavailable workspaces. */}
  }
  const chosen=[...projects].slice(0,maxProjects);
  const results=await Promise.all(chosen.map(async([projectPath,worktrees])=>{
    const checked=[...worktrees].slice(0,maxWorktrees);
    const outputs=await Promise.all(checked.map((cwd,index)=>
      // The first repository view covers local branches; each observed worktree
      // also contributes its HEAD, including detached Orca worktrees.
      runner(cwd,['--no-pager','log',...(index===0?['--branches']:[]),'HEAD','--no-show-signature',`--since=${start.toISOString()}`,`--until=${end.toISOString()}`,`--max-count=${maxCommits+1}`,'--format=%H%x09%ct%x09%s'])));
    if(outputs.every(output=>output===null))return null;
    const commits=new Map<string,LocalCommit>();
    for(const output of outputs)for(const line of (output||'').split('\n').filter(Boolean)){
      const [hash,rawTime,...subject]=line.split('\t'),committedAt=Number(rawTime);
      if(/^[0-9a-f]{40,64}$/.test(hash||'')&&Number.isFinite(committedAt)&&committedAt>=from&&committedAt<to)commits.set(hash!,{hash:hash!,committedAt,subject:subject.join('\t').slice(0,200)});
    }
    const ordered=[...commits.values()].sort((a,b)=>b.committedAt-a.committedAt||a.hash.localeCompare(b.hash));
    const branchNames=await Promise.all(checked.map(cwd=>runner(cwd,['branch','--show-current'])));
    const branches=[...new Set(branchNames.map(name=>name?.trim().slice(0,120)).filter((name):name is string=>Boolean(name)))];
    return {projectPath,branches,commits:ordered.slice(0,maxCommits),moreCommits:ordered.length>maxCommits};
  }));
  return {date,projects:results.filter((item):item is ProjectWorkOutcome=>Boolean(item&&item.commits.length)),skippedProjects:Math.max(0,projects.size-maxProjects),skippedWorktrees:chosen.reduce((total,[,paths])=>total+Math.max(0,paths.size-maxWorktrees),0),unavailableProjects:results.filter(item=>item===null).length,gitAvailable:Boolean(git||runner!==defaultRunner)};
}
