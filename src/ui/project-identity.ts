import type { Interval, Session } from '../capture/events.ts';

export const unassignedProject = 'Unassigned';

export function projectPath(path: string | null | undefined): string {
  if (!path?.startsWith('/')) return unassignedProject;
  const root = path.split('/.orca/workspaces/')[0]!.replace(/\/+$/, '');
  return root || '/';
}

export function workspaceProject(id: string | null | undefined, canonicalPath?: string | null): string {
  const canonical = projectPath(canonicalPath);
  return canonical !== unassignedProject ? canonical : projectPath(id?.split('::').at(-1));
}

/** Explicit review decisions take precedence over the original observation. */
export function intervalProject(interval: Pick<Interval,'workspaceId'|'projectPath'|'userAttribution'>): string {
  if(interval.userAttribution==='unassigned')return unassignedProject;
  return workspaceProject(interval.workspaceId,interval.userAttribution==='assigned'?undefined:interval.projectPath);
}

export function sessionProject(session: Pick<Session, 'cwd' | 'workspaceId'> & {projectPath?:string}): string {
  const workspace = workspaceProject(session.workspaceId, session.projectPath);
  return workspace !== unassignedProject ? workspace : projectPath(session.cwd);
}

export function projectLabel(path: string): string {
  return path === unassignedProject ? path : path.split('/').filter(Boolean).at(-1) || path;
}

export function projectDisplay(path: string, paths: string[]): string {
  const label = projectLabel(path);
  if (paths.filter((candidate) => projectLabel(candidate) === label).length < 2) return label;
  const parent = path.slice(0, -(label.length + 1));
  return parent ? `${label} · ${parent}` : path;
}

/** Number of project colours defined as `--project-1` … `--project-N` in style.css. */
export const projectColorCount = 8;

/**
 * Stable palette slot for a project path (FNV-1a hash), so a project keeps its colour no matter which
 * other projects appear on a given day.
 */
export function projectColorIndex(path: string, size = projectColorCount): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < path.length; index++) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % size;
}

/** CSS colour for a project, using the theme-aware project palette tokens. */
export function projectColor(path: string): string {
  return path === unassignedProject ? 'var(--muted)' : `var(--project-${projectColorIndex(path) + 1})`;
}
