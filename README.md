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

The desktop host starts one collector on launch. Closing its window hides it while collection continues. Use **Agent Time → Show Agent Time** to reopen it and **Quit Agent Time** to stop it. Capture pauses automatically after 24 hours in this validation preview; use Start capture to begin another period. Login autostart and an independent always-running service are not installed.

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

Orca polling can be disabled for hook-isolation tests by setting `"orcaPolling": false` in `settings.json` inside the capture data directory, then restarting the collector. Hook ingestion and macOS activity continue. The desktop Settings dialog shows the current polling state. Set it back to `true` and restart to compare polling against hooks.

CLI data is private and ignored by Git. `--run <id>` scopes a CLI collection to one Run. Desktop discovery enumerates explicit Runs on this Orca host so selecting a coordinator tab cannot silently narrow capture. Remote execution coverage remains unverified. Read [the validation results](docs/capture-validation.md) for observed proof and limits.
