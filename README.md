# Agent Time

A local macOS time-capture preview for Orca agent sessions. Built with Vue 3, TypeScript, Reka UI, Tauri 2, a Node/SQLite collector, and a small Swift activity helper.

The app shows a daily timeline, projects, agent sessions and orchestration identities, capture health, and CSV export. Session details retain Run, Task, Dispatch and provider session IDs. Data stays on this Mac; prompts, tool output and keystroke contents are not stored. When enabled, selected Orca tab titles are stored as activity metadata.

## Run the desktop app

Development prerequisites: Node 26.9+, npm, Rust/Cargo and Xcode.

```sh
npm ci
npm run sidecars:build
npm run tauri dev
```

The desktop host starts one collector on launch. Closing its window hides it while collection continues. The clock icon in the macOS menu bar shows capture status and today's activity, agent, and Mac time. Its menu offers pause/resume, Open dashboard, Settings, and Quit Agent Time. It remains available when the dashboard is hidden and controls the same collector. Use **Agent Time → Show Agent Time** to reopen the window and **Quit Agent Time** to stop it. Capture continues until you pause it or quit the menu bar app. In Settings → System, enable **Start capture when I sign in** to register a macOS login agent. It opens Agent Time with the dashboard hidden and starts the collector at login; the menu bar item opens the dashboard. macOS may ask you to allow the startup item in System Settings → General → Login Items. Disabling the startup item prevents future login launches without stopping the current capture.

```sh
npm run desktop:build
open 'src-tauri/target/release/bundle/macos/Agent Time.app'
```

The local build includes its Node runtime, Swift helpers, and a native macOS widget extension. `desktop:build` chooses an installed Apple Development certificate (or uses `APPLE_SIGNING_IDENTITY`) so macOS Accessibility permission survives rebuilds with the same app identity. It disables Hardened Runtime for the local Node sidecar; a distribution build needs a separate signing and entitlement review. The first signed build may need one fresh grant if permission was previously given to an ad-hoc signed build. Orca integration is optional when its CLI is unavailable. The package built on this Mac is Apple Silicon only; notarization and distribution are separate work.

## Desktop widget

On macOS 14 or later, right-click the desktop, choose **Edit Widgets**, and search for **Agent Time**. Add the medium **Today's work** widget. It shows today's estimated Mac activity, credited agent time, and agents working now. Click it to open Agent Time. The widget reads a local snapshot from the running app and starts no additional collector. It warns when agent hooks need updating because agent time may be missing, and shows an unavailable state if the collector cannot respond. macOS decides when to refresh widgets; the update time is shown, and an old or previous-day snapshot asks you to open Agent Time.

For a browser development preview, run `npm run native:build` then `npm run dev`. Its local transport is provided only by the Vite development server. A hosted browser version is not implemented.

## What the numbers mean

- **Mac activity:** estimated foreground activity below the configurable Human idle threshold (five minutes by default). Reading and thinking can look idle. Stable Orca worktree IDs attribute human time to a project; a session needs a unique tab match. Browser time is grouped by website and page, with project attribution when a saved rule or current local evidence identifies one.
- **Agent time:** union of observed hook/tool and sampled running intervals for each independent root/Dispatch, then summed across roots. Counted intervals suspend after the configurable Agent idle threshold without a new agent event (five minutes by default); tracked actions still group across gaps of up to one minute. It is execution wall time, not CPU time or billable time. Native child time is separate from parent-inclusive duration.
- **Elapsed activity:** union of human and agent activity intervals, counting overlaps once.

**My day → Local work evidence** reads nearby commits from local branches and observed worktree HEADs only when opened. It shows Git commit time and subject beside the project's recorded Mac and agent time. A commit is context, not proof that a particular agent made it; this view does not change attribution, store code, or contact a Git remote. If Git is unavailable, time capture continues normally.

Orca polling supplies inferred intervals between matching fresh observations, sampled approximately every five seconds. Hook execution boundaries supply observed intervals. Missing events, sleep, interruptions and long observation gaps remain unknown rather than becoming overnight time. Source events retain uncertainty; this is not yet billing-ready timesheet software.

## Hook setup

On first launch, **Connect your agents** offers user-wide Claude and Codex hook installation. Choose providers and click **Install selected hooks**, or **Set up later**. The choice persists for this macOS user. **Settings → Agents → Relaunch hook setup** reopens the onboarding modal at any time. Open **Settings → Agents** for shared hook checks and installation actions, or **Settings → Claude / Codex** to check status, install, repair or update one provider. Provider-specific targets list the default user configuration, explicit `CLAUDE_CONFIG_DIR`/`CODEX_HOME` when available to the app, and detected Orca account config homes. Claude auth-only account directories are not treated as configuration homes. Newly added account homes are discovered on the next check; use Install / repair to cover them.

**Settings → System → Danger zone** previews removal of Agent Time's installed hooks and helper runtimes, then requires explicit confirmation. It covers managed user and Orca account configurations, previously used custom homes recorded by the installer, and legacy project hooks recorded in the current capture directory. Foreign hooks, timesheet history, capture preferences, and installation backups are retained. If a configuration cannot be edited safely, errors are shown and runtimes are kept so remaining hooks still have an executable. Restart existing agent sessions after removal; reinstall through hook setup when needed. This action does not disable Orca polling or macOS activity.

Installation uses `~/.claude/settings.json` and `~/.codex/hooks.json` rather than project files. Other tools' settings and hooks are preserved. The installer stores private original backups and command ownership records in `~/Library/Application Support/studio.ezyo.agenttime/hook-installations/`. Hook commands use the stable `hook-runtime/launch.sh` path in that Application Support folder. The launcher selects a verified, versioned Node runtime and hook handler from `hook-runtime/`, so app updates can refresh the runtime without changing provider hook commands. Existing commands with a hashed runtime path need one installation update to migrate. Configurations are updated atomically and repeated installation replaces owned handlers without adding duplicates. Known project hooks from our earlier reversible installer are removed only after that provider's user-wide installation succeeds; changed or conflicting legacy entries require attention and stay visible.

**Installed** verifies the expected configuration and runtime files. **Check installation** additionally runs the local hook runtime's self-test. Each configuration shows the latest event received from its installed runtime; installation alone does not prove provider trust or end-to-end capture. Start new agent sessions after changes and review Agent Time hooks in Codex's `/hooks` screen. The app does not edit provider trust records. Hook setup does not change the capture toggles.

The CLI below remains available for manual configuration or restoration.

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

While capture runs, outdated hooks for an enabled agent trigger an in-app warning and one macOS notification per issue state during that app run. Clicking the notification opens Settings to repair the hooks. The in-app warning remains while capture and the affected agent's hooks are enabled and the configuration is outdated.

The signed beta app checks its update feed when it starts and every hour while it is running, including when the dashboard is hidden. A newer version triggers one macOS notification per version; clicking it opens the dashboard, where you can choose **Install and restart**. Opening the dashboard also checks for updates. Updates are never installed automatically.

## Adding a tracked source

The built-in sources live in [`src/capture/sources/`](src/capture/sources/). Each source is one file, discovered by its suffix. The settings, health view, and source lists read the source metadata; there is no central list to edit.

- Add `<id>.browser.ts` for a browser whose active page URL is exposed through the generic macOS Accessibility document reader. Use `safari.browser.ts` as the shape. Give it a unique bundle ID and a `browser<Name>` setting. The Swift probe receives the bundle ID at launch; the collector validates the observed URL against its domain before storing it. Set `defaultEnabled:false` if page capture should require opt-in.
- Add `<id>.agent.ts` for an agent with the supported JSON hook configuration layout and local JSONL token logs. Use `claude.agent.ts` or `codex.agent.ts` as the shape. The file owns its hook events, normalization, account discovery, token parser, and duplicate policy. Its settings are `<id>Hooks` and `<id>TokenUsage`. The installer copies agent files into its versioned hook runtime and records ownership before changing a configuration.
- Add `<id>.poller.ts` for a metadata poller using the shared collector lock and event store. Use `orca.poller.ts` as the shape. The poller owns its reads and cancellation checks. A new event format also needs correlation rules before it can count time in the timeline.

The one-file path applies when the new source fits one of these existing capture capabilities. A browser without an accessible document URL or an agent with a different hook configuration protocol needs a new capability implementation. Run `npm test`, `npm run build`, and `cargo test --manifest-path src-tauri/Cargo.toml` after adding a source. `tests/source-registry.test.ts` exercises discovery and generated settings with one-file browser and agent fixtures.

## CLI capture and evidence

```sh
npm run capture -- collect --duration 300 --output .capture/manual
npm run capture -- report --database .capture/manual/events.sqlite --output .capture/report.html
npm test
npm run typecheck
cargo test --manifest-path src-tauri/Cargo.toml
```

Orca polling stores active worker samples for timing, but stores settled workers and terminal metadata only when their state changes. Existing databases remain readable. To measure historical compaction safely, create a separate SQLite copy:

```sh
node scripts/compact-capture-copy.mjs .capture/live/events.sqlite .capture/review-compact.sqlite
```

The command leaves the source untouched. It retains the first and last observation in each unchanged state, checks the full capture summary for equality, validates SQLite integrity, and reports the copy's size. It does not install the compacted copy or remove historical rows from the live database.

Open **Settings** in the sidebar (or press **⌘,**). Its section sidebar scrolls to **Agents**, **Claude**, **Codex**, **ADE / IDE**, **Orca**, **Browsers**, **Projects**, and **System**, and follows manual scrolling. Agents provides shared capture/usage controls and hook actions for both providers. Claude and Codex each have independent hook capture, token/usage scanning and installation controls. Orca manages session discovery; Browsers has independent Safari, Chrome, and Brave website switches; Projects holds each project's website matching; System contains macOS activity and Accessibility permission. Changes apply immediately and persist in `settings.json` in the capture data directory. Existing history is preserved. The former single browser preference is migrated to the three browser switches. Disabled hook events are discarded, including backlog generated while disabled; re-enabling a source never bridges its disabled period. Changing one source does not interrupt unrelated source timing.

Hook switches control ingestion. Use the Agents, Claude and Codex sections to manage user-wide installation; Codex still requires `/hooks` review. The Accessibility card reports the macOS helper's permission and opens the corresponding System Settings pane. Basic foreground/idle capture works without Accessibility. With permission, the macOS helper samples Orca’s selected tab and an enabled foreground browser about every two seconds. Website tracking stores the domain, full URL, and page title locally; URL credentials are removed. Disabling a browser stops new page details for it while foreground activity continues. Site time needs a stable browser and domain across two samples, while page time also needs a stable URL. Navigation transitions remain unattributed to a page. The collector matches Orca labels against CLI tab and active pane IDs even when worker polling is disabled. A unique terminal match assigns human time to its workspace and tab. Today shows Orca tabs and websites, and CSV export includes page URLs. External edits to the settings file are loaded on collector restart; use the page to apply changes live.

The timeline groups tracked agent actions separated by at most one minute within a session and includes completed prompt-to-response turns. Known permission waits, capture gaps, and interrupted turns stay uncounted; **Observed tools** retains the narrower measured execution total. Rows without tracked time are hidden. Project rows show orange human activity with purple parent-agent and faint subagent activity; expand a project for parent sessions and a parent for subagents. A selected Orca worktree attributes human time to the project even if the tab does not uniquely match a session. Matched browser time appears in the project row and remains visible in the website breakdown. Browser evidence alone does not identify an agent session.

In **Settings → Projects**, select a project to see its website rules and recent matches. Save an origin or URL-prefix rule there, or keep a recent match as a rule. An exact GitHub repository page can match a Git remote of a local clone. Localhost ports can match a listening process and its working directory, an Orca worktree ancestor, or a local Docker container's published port and project bind mount. Configured local proxy upstreams can also resolve a port. Repository port declarations, Compose names, tunnel processes, and recent Orca context are suggestions that require a saved rule. Remote Docker contexts are ignored for local port matching. A rule applies to future browser observations; recorded intervals are not retroactively reassigned.

**Linear projects:** In Settings → Projects, click **Add Linear workspace** and authorize Agent Time in your browser. Linear authorizes the workspace currently active in your browser. To add another, switch to that workspace in Linear first, then click Add Linear workspace again. The public OAuth client ID is built in. The app requests only the `read` scope using PKCE; no client secret is needed. Each workspace's access and refresh tokens stay in macOS Keychain, outside the capture database, and each has its own project cache. Sync reads project names, URLs, and external Resource links. GitHub repository links are compared with local clone remotes; other website links are displayed as suggestions for review. Linear links are suggestions only; current local evidence and saved rules still govern website time attribution. Disconnecting a workspace removes only its credentials and cached projects.

**Capture health → Website reconciliation** shows recent site keys, their matched project and evidence, unresolved suggestions, and when a matched project was actually attached to a browser observation. A found match needs another stable foreground sample before it can contribute project time. The panel shows recent evidence from the current capture run; older history remains in the timesheet.

CLI data is private and ignored by Git. `--run <id>` scopes a CLI collection to one Run. Desktop discovery enumerates explicit Runs on this Orca host so selecting a coordinator tab cannot silently narrow capture. Remote execution coverage remains unverified. Read [the validation results](docs/capture-validation.md) for observed proof and limits.

## Tokens and limits

**Tokens & limits** shows today/week/month token totals, daily usage, model breakdown, and estimated API-equivalent USD for captured Claude/Codex sessions and their native subagents. Enable scanning in Settings. Usage is scoped to provider session IDs observed by hooks and starts at their first captured observation; unrelated session history is excluded. Input, output, cache reads and cache writes are separate; reasoning is already part of output.

Local usage is imported incrementally into `usage_events` and `usage_cursors` in the existing SQLite database. Only counters and session/model/workspace metadata are persisted, not transcript contents. Orca supplies shared account limits and reset times; unavailable or stale limits stay labeled. Token scanning runs about once per minute while capture is active. Each provider can be enabled independently under Settings → Claude or Codex; shared controls in Agents apply to both. Disabling scanning preserves imported totals. Re-enabling it imports eligible captured-session history from the local logs. Existing shared token settings are retained when upgrading.

API-equivalent cost uses a versioned standard short-context/global token pricing baseline, including Claude 1-hour cache-write prices where logged. It is not the subscription bill and excludes tool fees, regional and speed-tier modifiers, and long-context premiums. Models without a verified rate stay unpriced; totals explicitly identify the priced portion. Prices come from the [OpenAI pricing page](https://developers.openai.com/api/docs/pricing) and [Anthropic pricing page](https://platform.claude.com/docs/en/about-claude/pricing).

## Pricing updates

The app downloads the reviewed catalog from this public repository once every 24 hours while token capture is enabled. Downloads include no session or account data. It validates the schema, units, source links and model rates; failed or invalid downloads keep the last valid catalog. SQLite retains downloaded catalogs, update status, and an immutable catalog version per usage record. Existing records are initially bound to the bundled baseline. Rates are assigned at import time; provider effective dates are not inferred. Earlier estimates are not recalculated when prices change. Unknown models remain unpriced under their assigned version.

The dashboard displays the active catalog verification date, errors, and an overdue indicator after 30 days. The bundled catalog keeps fresh installs working offline. Override the download URL with `ADE_PRICING_CATALOG_URL` (HTTPS required); set it to an empty string to disable remote price checks.

The **Check official pricing** GitHub workflow checks the official Markdown pricing pages daily. Changed pages or a weekly verification due date produce a review PR with proposed rates, source hashes, review notes, and immutable catalog files in `pricing/history/`. It never auto-merges. Review cache durations, context tiers, geography, service tiers and footnotes against the linked official pages before merging; merging publishes the catalog at `src/usage/catalog.json`. Unsupported model tiers require manual work and remain unpriced. A parser mismatch fails the workflow rather than publishing guesses. An existing open pricing PR is left for review.

To prepare a proposal manually, run `npm run pricing:check`. This command can modify the catalog and pricing review files locally; review its diff before committing. GitHub Actions must be allowed to create pull requests for scheduled proposals to work. Initial workflow activation requires the repository to have a default branch.
