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
