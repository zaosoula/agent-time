import assert from 'node:assert/strict';
import test from 'node:test';
import { projectDisplay, projectLabel, sessionProject, workspaceProject } from '../src/ui/project-identity.ts';

test('different projects with the same folder name retain separate identities', () => {
  const personal = workspaceProject('local::/Users/me/personal/app');
  const client = workspaceProject('local::/Users/me/client/app');
  assert.notEqual(personal, client);
  assert.equal(projectLabel(personal), 'app');
  assert.equal(projectLabel(client), 'app');
  assert.equal(projectDisplay(personal, [personal, client]), 'app · /Users/me/personal');
  assert.equal(projectDisplay(client, [personal, client]), 'app · /Users/me/client');
});

test('Orca worktrees and sessions resolve to their project path', () => {
  assert.equal(workspaceProject('local::/Users/me/app/.orca/workspaces/task'), '/Users/me/app');
  assert.equal(sessionProject({ cwd: '/tmp/other', workspaceId: 'local::/Users/me/app/.orca/workspaces/task' }), '/Users/me/app');
  assert.equal(sessionProject({ cwd: '/Users/me/app', workspaceId: 'unknown-workspace' }), '/Users/me/app');
});

test('project colours derive from a stable hash of the path, not list position', async () => {
  const { projectColor, projectColorIndex, projectColorCount } = await import('../src/ui/project-identity.ts');
  const app = '/Users/me/client/app';
  assert.equal(projectColorIndex(app), projectColorIndex(app));
  assert.equal(projectColor(app), projectColor(app));
  assert.match(projectColor(app), /^var\(--project-[1-8]\)$/);
  const slots = new Set(['/a', '/b', '/c', '/d', '/e', '/f', '/g', '/h', '/i', '/j'].map((path) => projectColorIndex(path)));
  assert.ok(slots.size > 3, 'different paths spread across the palette');
  for (const slot of slots) assert.ok(slot >= 0 && slot < projectColorCount);
  assert.equal(projectColor('Unassigned'), 'var(--muted)');
});
