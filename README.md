# Agent Time

A local macOS time-capture preview for Orca agent sessions. Built with Vue 3, TypeScript, Reka UI, Tauri 2, a Node/SQLite collector, and a small Swift activity helper.

The app shows a daily timeline, projects, agent sessions and orchestration identities, capture health, and CSV export. Session details retain Run, Task, Dispatch and provider session IDs. Data stays on this Mac; prompts, tool output and keystroke contents are not stored.

## Run the desktop app

Development prerequisites: Node 26.9+, npm, Rust/Cargo and Xcode command-line tools.

```sh
npm ci
npm run sidecars:build
npm run tauri dev
```

The desktop host starts one collector on launch. Closing its window hides it while collection continues. The clock icon in the macOS menu bar shows capture status and today's activity, agent, and Mac time. Its menu offers pause/resume, Open dashboard, Settings, and Quit Agent Time. It remains available when the dashboard is hidden and controls the same collector. Use **Agent Time → Show Agent Time** to reopen the window and **Quit Agent Time** to stop it. Capture pauses automatically after 24 hours in this validation preview; use Start capture to begin another period. Login autostart and an independent always-running service are not installed.

```sh
npm run sidecars:build
npm run tauri build -- --bundles app
open 'src-tauri/target/release/bundle/macos/Agent Time.app'
```

The unsigned local app includes its Node runtime and Swift helper. It still needs Orca installed and running. The package built on this Mac is Apple Silicon only, about 150 MiB; code signing, notarization and distribution are separate work.

For a browser development preview, run `npm run native:build` then `npm run dev`. Its local transport is provided only by the Vite development server. A hosted browser version is not implemented.

## What the numbers mean

- **Mac activity:** estimated foreground activity below a five-minute input-idle threshold. Reading and thinking can look idle. Human project/session attribution is currently unverified, so human time stays unassigned.
- **Agent time:** union of observed hook/tool and sampled running intervals for each independent root/Dispatch, then summed across roots. It is execution wall time, not CPU time or billable time. Native child time is separate from parent-inclusive duration.
- **Elapsed activity:** union of human and agent activity intervals, counting overlaps once.

Orca polling supplies inferred intervals between matching fresh observations, sampled approximately every five seconds. Hook execution boundaries supply observed intervals. Missing events, sleep, interruptions and long observation gaps remain unknown rather than becoming overnight time. Source events retain uncertainty; this is not yet billing-ready timesheet software.

## Hook setup

Orca polling works without modifying provider configuration. Exact provider session IDs and native-subagent events require hooks in the account/project where the agent actually runs. Existing sessions may need to restart. Codex requires its normal hook trust review; never bypass that review.

The hook command is:

```sh
'/absolute/path/to/node' '/absolute/path/to/src/capture/cli.ts' hook --provider claude --spool '/absolute/path/to/capture-data/spool'
```

Replace paths with the actual runtime/repository/data directory shown in the running app. Use `codex` for Codex. The app's data directory defaults to the Tauri application data path; inspect Capture status/CLI or use an explicit `ADE_CAPTURE_OUTPUT` for a development test. Do not install hooks with a spool directory that differs from the collector's data directory.

Preview and apply a reversible project-local configuration change using the CLI:

```sh
npm run capture -- hook-config prepare --provider claude \
  --config /absolute/project/.claude/settings.local.json \
  --manifest /private/path/hook-manifest.json \
  --hook-command "'/absolute/node' '/absolute/repo/src/capture/cli.ts' hook --provider claude --spool '/private/capture-data/spool'"
npm run capture -- hook-config apply --manifest /private/path/hook-manifest.json
npm run capture -- hook-config restore --manifest /private/path/hook-manifest.json
```

For Codex, target its documented `hooks.json` in the active trusted config layer. Never overwrite account credentials or assume every Orca account uses the shell's default home. Preparation does not write the target; apply verifies the original has not changed. Restore preserves unrelated hooks added afterward and refuses conflicting modifications to our entries.

Hooks record only provider/session/subagent IDs, working directory, tool identity/name, event type, and allowlisted Orca workspace/terminal IDs. They never invoke Orca or send data over the network, return no output, and succeed silently if capture fails. Each hook uses a private atomic spool record.

## CLI capture and evidence

```sh
npm run capture -- collect --duration 300 --output .capture/manual
npm run capture -- report --database .capture/manual/events.sqlite --output .capture/report.html
npm test
npm run typecheck
cargo test --manifest-path src-tauri/Cargo.toml
```

Open **Settings** in the sidebar (or press **⌘,**) to enable macOS activity, Claude hooks, Codex hooks, and Orca polling independently. Changes apply immediately and persist in `settings.json` in the capture data directory. Existing history is preserved. Disabled hook events are discarded, including backlog generated while disabled; re-enabling a source never bridges its disabled period. Changing one source does not interrupt unrelated source timing.

Hook switches control ingestion, not installation or provider trust. Install hooks as described above; Codex still requires `/hooks` review. The Accessibility card reports the macOS helper's permission and opens the corresponding System Settings pane. Basic foreground/idle capture works without Accessibility; focused Orca window context needs it, and focused agent attribution remains unverified. External edits to the settings file are loaded on collector restart; use the page to apply changes live.

CLI data is private and ignored by Git. `--run <id>` scopes a CLI collection to one Run. Desktop discovery enumerates explicit Runs on this Orca host so selecting a coordinator tab cannot silently narrow capture. Remote execution coverage remains unverified. Read [the validation results](docs/capture-validation.md) for observed proof and limits.

## Tokens and limits

**Tokens & limits** shows today/week/month token totals, daily usage, model breakdown, and estimated API-equivalent USD for captured Claude/Codex sessions and their native subagents. Enable scanning in Settings. Usage is scoped to provider session IDs observed by hooks and starts at their first captured observation; unrelated session history is excluded. Input, output, cache reads and cache writes are separate; reasoning is already part of output.

Local usage is imported incrementally into `usage_events` and `usage_cursors` in the existing SQLite database. Only counters and session/model/workspace metadata are persisted, not transcript contents. Orca supplies shared account limits and reset times; unavailable or stale limits stay labeled. Token scanning runs about once per minute while capture is active.

API-equivalent cost uses a versioned standard short-context/global token pricing baseline, including Claude 1-hour cache-write prices where logged. It is not the subscription bill and excludes tool fees, regional and speed-tier modifiers, and long-context premiums. Models without a verified rate stay unpriced; totals explicitly identify the priced portion. Prices come from the [OpenAI pricing page](https://developers.openai.com/api/docs/pricing) and [Anthropic pricing page](https://platform.claude.com/docs/en/about-claude/pricing).

## Pricing updates

The app downloads the reviewed catalog from this public repository once every 24 hours while token capture is enabled. Downloads include no session or account data. It validates the schema, units, source links and model rates; failed or invalid downloads keep the last valid catalog. SQLite retains downloaded catalogs, update status, and an immutable catalog version per usage record. Existing records are initially bound to the bundled baseline. Rates are assigned at import time; provider effective dates are not inferred. Earlier estimates are not recalculated when prices change. Unknown models remain unpriced under their assigned version.

The dashboard displays the active catalog verification date, errors, and an overdue indicator after 30 days. The bundled catalog keeps fresh installs working offline. Override the download URL with `ADE_PRICING_CATALOG_URL` (HTTPS required); set it to an empty string to disable remote price checks.

The **Check official pricing** GitHub workflow checks the official Markdown pricing pages daily. Changed pages or a weekly verification due date produce a review PR with proposed rates, source hashes, review notes, and immutable catalog files in `pricing/history/`. It never auto-merges. Review cache durations, context tiers, geography, service tiers and footnotes against the linked official pages before merging; merging publishes the catalog at `src/usage/catalog.json`. Unsupported model tiers require manual work and remain unpriced. A parser mismatch fails the workflow rather than publishing guesses. An existing open pricing PR is left for review.

To prepare a proposal manually, run `npm run pricing:check`. This command can modify the catalog and pricing review files locally; review its diff before committing. GitHub Actions must be allowed to create pull requests for scheduled proposals to work. Initial workflow activation requires the repository to have a default branch.
