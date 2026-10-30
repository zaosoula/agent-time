# Agent Time local MCP server

Agent Time includes a local stdio MCP server. It reads the same SQLite capture database as the app and uses the collector's private spool for agent declarations. The app must be running to import declarations. No network endpoint or Linear token is exposed.

## Connect an installed app

The signed macOS app bundles its own Node runtime and MCP code. On a normal installation:

```sh
codex mcp add --env AGENT_TIME_PROVIDER=codex agent-time -- '/Applications/Agent Time.app/Contents/MacOS/node' '/Applications/Agent Time.app/Contents/Resources/mcp/server.ts'
claude mcp add --scope user -e AGENT_TIME_PROVIDER=claude agent-time -- '/Applications/Agent Time.app/Contents/MacOS/node' '/Applications/Agent Time.app/Contents/Resources/mcp/server.ts'
```

Run `codex mcp list` or `claude mcp list` to check that the server is configured. Restart an existing agent session to load the new tools. For a development checkout, use `npm run mcp` with `ADE_CAPTURE_OUTPUT` set to the fixture or app data directory. Do not run a second collector.

## Tools and trust

The read tools are `time_for_issue`, `time_for_project`, `timeline`, `sessions`, `coverage`, `unattributed`, `explain_attribution`, and `current_work`. Date ranges are local calendar dates, inclusive, with a 30-day bound. Large ranges may need to be split. Results retain source event IDs, attribution confidence, and coverage caveats; browser URLs, page titles, and terminal titles are omitted from MCP replies.

The declaration tools are `set_work_context`, `start_task`, `stop_task`, and `report_port_state`. An agent can report its current task, Linear key, project, or local TCP port. `start_task` returns a `taskCounterId` for `stop_task`. Each write accepts an optional stable UUID `requestId` so the agent can retry without creating another event. A port claim is checked against the local listener; an open listener is context, not proof of active work.

The configuration identifies the provider. The server uses a recent hook session only if exactly one matches; the agent can pass its actual hook `sessionId` to `set_work_context` when several sessions are active. Without a matching captured session, its declaration remains a suggestion and does not allocate measured time to an issue. Agent reports never alter Mac activity, agent time, overlap-merged wall time, or reviewed/billable totals. The elapsed task counter is also separate from measured time. A session-end hook closes the displayed active declaration and task counter for that session.

When a reported issue and an observed human project agree within 30 minutes, issue queries show that human activity as a separate **suggestion**. A Linear key visible in a captured browser page also becomes a suggestion. An issue key in the observed Orca worktree name can link measured intervals; if it conflicts with an agent report, the interval stays in conflict. Suggestions are not included in `humanActiveSeconds` for the issue.

The server reads only the local data directory. It does not read prompts, tool output, or keystrokes. To use a nonstandard data directory, set `ADE_CAPTURE_OUTPUT` in the MCP server's environment to the same directory as the running collector.

## Limits before invoice use

Issue matching currently uses an agent-reported key tied to an observed provider session or a key in an observed Orca worktree name. `time_for_project` accepts a repository path, Orca workspace ID, or an exact agent-reported project name; it does not map Linear project names to repositories. It does not infer historic issue IDs from Git commits or a Linear project. The query starts with a one-hour observation lookback, so a session already active before that window can be incomplete. Read tools keep at most 250,000 events in a request and cap returned interval lists. Keep the app's review decisions and coverage view as the source for invoice approval.
