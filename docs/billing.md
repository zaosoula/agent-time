# Project billing

Configure **Settings → Billing**. SQLite is the source of truth: `billing_projects`, immutable `billing_policies` and immutable `billing_reports`. No billing configuration file is loaded. Archive backup, import, compaction and restore preserve these records. Old databases acquire the additive tables when the updated app opens; existing capture events and review decisions are untouched.

## A billable project can contain several repositories

Choose a stable ID, a display name, aliases, repository roots, workspace IDs and exact reported project names. Roots include descendants and Orca worktrees; when registered repositories are nested, the longest matching root owns the source. Equal-specificity conflicts and ambiguous aliases are errors. Unknown projects do not silently return zero. A registered project with no captured activity can return zero together with its evidence/coverage limitations.

## Policy versions

Each policy has an immutable ID and an effective local date. Saving an edited rule appends a version; a same-date correction uses the last appended version. Existing versions cannot be modified, reordered or deleted. Changing sources or prices does not rewrite a saved report. Revision checks reject concurrent configuration overwrites.

Available bases:

- **Human + agent shared clock** (default): union of captured human and agent intervals across all project sources. Parallel agents count once.
- **Human active time**: captured human intervals only.
- **Human + weighted agent-only time**: human seconds plus a factor times agent wall time outside human activity.
- **Human + weighted cumulative agent time**: human seconds plus a factor times each native agent execution's time, including overlapping agents. This is an explicitly chosen commercial weighting that may exceed elapsed time.

Factors accept decimals or exact fractions such as `1/6`. Rates are decimal strings in one explicit currency. A separate agent rate is optional; otherwise the main rate applies. Missing rates yield unknown amounts. Different currencies in one report are rejected rather than converted implicitly.

Billing uses the raw intervals underlying timing summaries, before their per-block minute credit. Existing captured timing metrics keep their original meaning. Commercial rounding is applied once at the chosen scope: nearest/up/down to 1, 15 or 60 minutes, per day or per policy segment in the requested period. A hard daily cap also limits period-rounding allocations; empty days cannot receive manufactured production time. Rate categories share the rounded eligible quantity proportionally. The authoritative total is priced before final currency rounding, so displayed per-day rounded money can differ slightly from the report total.

Known sleep, lock events and capture pauses are excluded. Mac observation gaps longer than five minutes are also excluded and disclosed. Older capture data may not contain explicit lock events; the report does not manufacture them. Missing capture or attribution evidence is flagged rather than certified as inactivity. Human-message gating is optional and disabled by default: qualifying recorded user prompts need explicit human-origin evidence or a terminal-backed prompt accompanied by captured human activity for that project. Background/headless prompts alone do not establish human presence. A gate never creates activity across an excluded span.

Declared task counters are excluded from automatic billing even if the app's separate task-counter credit setting is enabled. A task's declared `billable` flag is not invoice approval. Overlapping work attributed to different billable projects is reported for review; it is not silently allocated or summed into a supposedly unique client clock.

## AI fees and exports

AI fees are separate from time charges: none, actual recorded cost, or a flat amount per day/period. Flat period fees apply once per policy revision segment. Actual-cost inputs currently include recorded own-task MCP usage linked to a project or workspace. Their source and verification limits are preserved. Missing/unverified/incomplete usage stays explicit: a known subtotal is shown, while the complete actual fee can remain unknown. Costs are not inferred from elapsed time, and parent counters do not imply parent-inclusive usage. Non-actual policies ignore unrelated usage and currencies.

A report saves its policy/source snapshot, input revision, daily results, totals and explanation. Repeating an identical calculation reuses its saved result. CSV and Markdown exports use that same report, include authoritative totals, raw metrics, exclusions, rounding and separate fees, and are written privately under the app data directory's `billing-exports`. CSV cells guard against spreadsheet formula injection. Reports and exports are calculation snapshots, not issued invoices or payment actions.

## MCP

Restart existing agent/MCP connections after updating.

- `billing_projects()` lists configured projects, aliases, grouped sources and policy versions.
- `billing_for_project({project, fromDate, toDate, detail?, format?, reportId?, cursor?})` calculates a report; dates are inclusive in the project's timezone. The default JSON summary omits daily rows. `detail: "daily"` returns up to 31 days with `nextCursor`; reuse the returned `reportId` and cursor to page the same result. `format: "csv"` or `"markdown"` returns a local export path and checksum. Exporting an existing report never reprices it.
- `time_for_project` accepts `view: "summary"` for compact measured totals. Its default retains detailed issue/coverage fields for existing short queries and switches to compact output for longer ranges. At most 31 daily rows are returned, with `moreDays` explicitly indicating a longer result. Totals cover the entire requested period; use a narrower period for additional daily details. Native paths/workspaces and registered billing aliases resolve explicitly.

Full 31-day months and longer aggregate periods are supported. Reads process one bounded day at a time, preserve cross-midnight intervals and use the project's timezone, including daylight-saving changes. Billing reads a consistent SQLite WAL snapshot and frozen timing settings; unimported spool declarations cannot change an invoice estimate outside that snapshot. Historical resource attribution uses mappings relevant to the historical window rather than expiring against today's date. Large resource-mapping windows have an explicit safety bound instead of silent truncation.

The desktop report calculation runs in a worker so capture can continue. Configuration writes use app IPC; MCP exposes reads/calculations, not silent tariff changes. Report responses omit the potentially large full configuration snapshot, which remains in SQLite.
