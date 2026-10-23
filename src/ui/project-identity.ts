import type { Session } from '../capture/events.ts';

export const unassignedProject = 'Unassigned';

export function projectPath(path: string | null | undefined): string {
  if (!path?.startsWith('/')) return unassignedProject;
  const root = path.split('/.orca/workspaces/')[0]!.replace(/\/+$/, '');
  return root || '/';
}

export function workspaceProject(id: string | null | undefined): string {
  return projectPath(id?.split('::').at(-1));
}

export function sessionProject(session: Pick<Session, 'cwd' | 'workspaceId'>): string {
  const workspace = workspaceProject(session.workspaceId);
  return workspace !== unassignedProject ? workspace : projectPath(session.cwd);
}

export function projectLabel(path: string): string {
  return path === unassignedProject ? path : path.split('/').filter(Boolean).at(-1) || path;
}

export function projectDisplay(path: string, paths: string[]): string {
  const label = projectLabel(path);
  if (paths.filter(candidate => projectLabel(candidate) === label).length < 2) return label;
  const parent = path.slice(0, -(label.length + 1));
  return parent ? `${label} · ${parent}` : path;
}
