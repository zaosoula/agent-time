export type SettingsSection = 'general' | 'counting' | 'connections' | 'privacy' | 'data';
export type ConnectionsSection = 'agents' | 'sources' | 'linear' | 'health';
interface SettingsRoute {
  section: SettingsSection;
  connection?: ConnectionsSection;
  projectSection?: 'attribution' | 'billing';
}
/** Keep saved pre-workspace destinations useful after upgrading. */
export function normalizeSettingsRoute(value: string | null | undefined): SettingsRoute {
  switch (value) {
    case 'agents': return { section: 'connections', connection: 'agents' };
    case 'sources': return { section: 'connections', connection: 'sources' };
    case 'advanced': return { section: 'connections', connection: 'health' };
    case 'projects': return { section: 'connections', connection: 'linear', projectSection: 'attribution' };
    case 'billing': return { section: 'general', projectSection: 'billing' };
    case 'counting': case 'connections': case 'privacy': case 'data': return { section: value };
    default: return { section: 'general' };
  }
}
