# Agent Time local MCP server

Agent Time includes a local stdio MCP server. It reads the same SQLite capture database as the app and uses the collector's private spool for agent declarations. The app must be running to import declarations. No network endpoint or Linear token is exposed.

## Connect an installed app

In **Connect your agents**, select **Also connect local MCP tools** when installing hooks. For agents already connected, open **Settings → Agents → Local MCP tools** and connect each account configuration. Agent Time shows missing, outdated, and externally changed entries separately. It can repair or remove only entries it installed. Restart the agent session after connecting or removing tools.

No skill is required for tool discovery: the MCP server publishes each tool's description and input schema. To encourage live task reporting, tell your agent: “When you begin or change a task, use Agent Time's `set_work_context` or `start_task` tool. Report the project and ticket reference when known, and stop task counters when finished.” This is optional guidance; declarations are separate from measured time.

If you prefer manual setup, the signed macOS app bundles its own Node runtime and MCP code:

```sh
codex mcp add --env AGENT_TIME_PROVIDER=codex --env ADE_CAPTURE_OUTPUT="$HOME/Library/Application Support/studio.ezyo.agenttime" agent-time -- '/Applications/Agent Time.app/Contents/MacOS/node' '/Applications/Agent Time.app/Contents/Resources/mcp/server.ts'
claude mcp add --scope user agent-time -e AGENT_TIME_PROVIDER=claude ADE_CAPTURE_OUTPUT="$HOME/Library/Application Support/studio.ezyo.agenttime" -- '/Applications/Agent Time.app/Contents/MacOS/node' '/Applications/Agent Time.app/Contents/Resources/mcp/server.ts'
```

Run `codex mcp list` or `claude mcp list` to check that the server is configured. Restart an existing agent session to load the new tools. For a development checkout, use `npm run mcp` with `ADE_CAPTURE_OUTPUT` set to the fixture or app data directory. Do not run a second collector.

## Tools and trust

The read tools are `time_for_issue`, `time_for_project`, `timeline`, `sessions`, `coverage`, `unattributed`, `explain_attribution`, `current_work`, and `task_history`. Date ranges are local calendar dates and inclusive. Most detailed evidence tools retain a 30-day bound; `time_for_project` and billing aggregates support full months and longer ranges using bounded daily reads. Large ranges may need to be split. Results retain source event IDs, attribution confidence, and coverage caveats; browser URLs, page titles, and terminal titles are omitted from MCP replies.

The declaration tools are `set_work_context`, `start_task`, `heartbeat_task`, `stop_task`, `report_resource`, and `report_port_state`. An agent can report its current task, ticket reference, project, business agent identity, or local TCP port. `start_task` returns a `taskCounterId` for `stop_task`. Each write accepts an optional stable UUID `requestId` so the agent can retry without creating another event. A port claim is checked against the local listener; an open listener is context, not proof of active work.

The configuration identifies the provider. The server uses a recent hook session only if exactly one matches; the agent can pass its actual hook `sessionId` to `set_work_context` when several sessions are active. Without a matching captured session, its declaration remains a suggestion and does not allocate measured time to an issue. Context reports never alter measured Mac activity or approve billing. Task counters add only uncovered declared time when **Count task counters** is explicitly enabled; the default remains off. The elapsed task counter is also separate from measured time. A session-end hook closes the displayed active declaration and task counter for that session.

When a reported issue and an observed human project agree within 30 minutes, issue queries show that human activity as a separate **suggestion**. A Linear key visible in a captured browser page also becomes a suggestion. An issue key in the observed Orca worktree name can link measured intervals; if it conflicts with an agent report, the interval stays in conflict. Suggestions are not included in `humanActiveSeconds` for the issue.

The server reads only the local data directory. It does not read prompts, tool output, or keystrokes. To use a nonstandard data directory, set `ADE_CAPTURE_OUTPUT` in the MCP server's environment to the same directory as the running collector.

## Reported resources

`report_resource` records a remote page an agent created or updated, such as a Claude, Codex or Orca artifact, pull request, issue, deployment or preview. Browser time on that page (same origin and path; query and fragment ignored) is attributed to the reporting agent's project, for time before and after the report. Review decisions and user website rules take precedence. Reports need a workspace ID or an absolute project path; reports from the last 31 days apply.

## Agent instructions

The server sends instructions when an agent connects (`instructions` in `src/mcp/server.ts`). They ask agents to call `set_work_context` when a task starts or changes, to wrap multi-step tasks in `start_task`/`stop_task`, to pass their provider, session and workspace IDs, and to query time only when the user asks. Clients that support MCP server instructions, such as Claude Code and Codex, add them to the agent's context; reports remain advisory.

## Limits before invoice use

Issue matching currently uses an agent-reported key tied to an observed provider session or a key in an observed Orca worktree name. `time_for_project` accepts a repository path, Orca workspace ID, or an exact agent-reported project name; it does not map Linear project names to repositories. It does not infer historic issue IDs from Git commits or a Linear project. The query starts with a one-hour observation lookback, so a session already active before that window can be incomplete. Measured queries read bounded daily windows and cap returned interval lists. Task history reads indexed reports and session endings, with at most 10,000 rows of each and 1,000 returned tasks; `truncated` signals incomplete results. Split the date range when it is true. Keep the app's review decisions and coverage view as the source for invoice approval.


## Projects, agents and task counters (beta 45)

Existing calls remain valid. `issueKey` now accepts an explicit free reference of 1–128 characters, such as `T-9716`, `D-140`, `K-189` or a local task name. Control characters are rejected. Automatic browser/worktree issue detection keeps its existing Linear-shaped pattern to avoid unrelated text claiming time.

Use both context and counters. A counter snapshots this MCP connection's latest context at start, so a later topic change does not move an earlier task. You can override its `project`, `issueKey`, `agentIdentity` and `billable`. An optional `parentTaskCounterId` must name an existing counter; without connection context, project/ticket/billing metadata can inherit from the parent. A child keeps its own business agent identity. Context from a different explicitly identified native session is not inherited.

```json
{"project":"KANZen","issueKey":"T-9716","task":"Prepare TVA","agentIdentity":{"id":"cto","name":"CTO","role":"engineering"},"billable":false,"provider":"claude","sessionId":"actual-native-session-id"}
```

Pass that object to `set_work_context`, then call `start_task` with `name`. Keep the returned `taskCounterId`. `agentIdentity.id` is the stable identity in the office (for example CTO); `sessionId` is still the provider's real captured session. They serve different purposes. When several native sessions exist, Agent Time never guesses one from a business name.

A child calls `start_task` with its own native identity and `parentTaskCounterId`. Parent elapsed time includes the period occupied by children. Do not sum parent and child durations to make an invoice. Tracked time remains cumulative per native execution: overlapping counters on one execution merge; separate executions can overlap.

New counters have a 15-minute lease. Call `heartbeat_task` at least every five minutes while work continues. `leaseSeconds` on `start_task` can explicitly select 60 seconds to 12 hours; renew at most halfway through that period. An expired counter is marked **interrupted** and its declared end stops at the last start/heartbeat confirmation, rather than inventing work until the crash is noticed. A native session ending within the lease closes the counter. A late native session ending cannot revive an expired counter. A later explicit `stop_task` can recover the actual declared elapsed span. Old counters without a lease retain a generous 12-hour inactivity bound. Long renewed tasks are found through their recent heartbeats without reading the whole capture history. No polling process or new database schema is required for expiry; the state survives restart as a deterministic projection of saved reports.

Finish with `stop_task` even on failure. Optional `outcome` is `completed`, `failed` or `cancelled`. Optional `usage` contains **only this task's own usage, excluding children**:

```json
{"taskCounterId":"server-issued-uuid","outcome":"completed","usage":{"inputTokens":12500,"outputTokens":800,"cachedInputTokens":10000,"cost":0.043,"currency":"USD","source":"provider-response"}}
```

`source` is `provider-response` when the agent copied provider usage, or `agent-reported` for its own estimate. Both remain declarations: Agent Time does not independently verify the provider's bill (`usageVerified:false`). Omit unavailable values; zero means a known zero. A cost requires a three-letter uppercase currency. Cached input is a subset of input tokens, not an additional token total. No prices or currencies are silently inferred or converted.

`billable:true`, `false` and omitted/null mean declared billable, internal, and unspecified respectively. This flag does not turn a declaration into measured work, change review decisions, or approve an invoice.

`current_work` shows open and interrupted counters. `task_history` accepts a local date range plus optional exact `project`, `issueKey` and business `agentId` filters; it returns completed, failed, interrupted and active declarations, parent links and usage. Its elapsed seconds are clipped to the requested range; usage belongs to the whole task and must not be summed again across daily queries. These results remain separate from observed totals and from invoice approval.

After updating Agent Time, restart existing agent/MCP connections so the refreshed tool catalog and heartbeat instructions are loaded. The OfficeKit report consumer must still read context/counter reports instead of relying only on its working directory; these extensions cannot change external OfficeKit code.


## Project billing (beta 46)

Configure billable projects and policy versions in **Settings → Billing**. SQLite is canonical; multiple repositories/workspaces can share one deduplicated production clock. `billing_projects` lists the configured identities. `billing_for_project` calculates compact, saved financial summaries with daily pagination or local CSV/Markdown exports. Raw captured intervals, commercial rounding, declared counters, unknown fees and coverage are kept distinct. See [Project billing](billing.md) for policy, pricing, evidence and API details.

## Generic launcher context and measured agent reads (beta 48)

A launcher can opt in to business identity and external attributes without opening a counter:

```sh
AGENT_TIME_AGENT_ID=worker-17 AGENT_TIME_ATTR_CLIENT_ID=client-one AGENT_TIME_ATTR_PROJECT_ID=project-one claude -p --agent builder "Work on the task"
```

Only `AGENT_TIME_AGENT_ID`, `AGENT_TIME_ATTR_*` and the existing Orca identity allowlist are captured from the environment. Do not put credentials in these opt-in attributes. The business identity is returned as `agentIdentity.id`; provider-native `agentId`/`sessionId` stay unchanged. A provider's `agent_type` is returned separately as `agentProfile`, including for root sessions. A profile such as `builder` can be shared by many distinct business agents.

`set_work_context` and `start_task` accept an `attributes` string map. Keys are normalized to lowercase (`AGENT_TIME_ATTR_PROJECT_ID` becomes `project_id`). Up to 16 keys are accepted, with 64-character keys, 128-character values and at most 1,024 UTF-8 bytes for the serialized map. Keys must match `[a-z][a-z0-9_.-]*`; control characters, unsafe prototype keys and case collisions are rejected. Each complete report has a 4,096-byte UTF-8 limit. Invalid launcher metadata is omitted with a fixed warning while timing capture continues; invalid explicit MCP declarations return an error.

Effective attributes combine launcher context, preceding session declarations, then explicit task overrides. An empty string removes an inherited key; an empty map leaves inherited keys unchanged. `start_task` freezes its effective context, so later declarations and retries do not move a task. Context is scoped to the actual provider/session/native child and host. Pass `hostId` when reporting for a known remote execution; ambiguous hostless evidence cannot choose between identical native sessions on different hosts.

`sessions`, `timeline` and `time_for_project` accept exact `agentIdentityId` and `agentProfile` filters. Both filters, when supplied, must match. These filters select captured work, not declared elapsed counters. Unassociated human activity is excluded from agent-filtered reads. Timeline contributors and temporal `contextSlices` retain metadata changes and their source evidence instead of flattening parallel agents into one attribute map. Session metadata represents its latest context. Bounded reads expose truncation when applicable; split the query for detailed evidence when truncated.

Metadata changes do not create new minute-credit blocks. Filtered credits are allocated from the original captured block, preserving unfiltered totals and cross-midnight credit. Attribute-based ERP grouping and timesheet writes remain the consumer's responsibility; no external IDs or billing approval are inferred from these values.

Ordinary linked Git worktrees are grouped with their principal checkout as well as Orca worktrees. New hook events retain raw `cwd` alongside canonical `projectPath`, preserving known grouping after a worktree is deleted. Nested paths remain nested beneath the principal checkout so billing subprojects stay distinct. Remote paths are not resolved against this Mac's filesystem. Unavailable historical filesystem evidence remains unresolved. Existing manual review decisions take precedence.

After upgrading, repair/update installed hooks in **Settings → Agents** and restart launcher/MCP sessions. Copied hook runtimes must be refreshed to capture the new opt-in metadata; existing captures and calls remain readable.
