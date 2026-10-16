# Agent Time beta data notice

Agent Time records activity on this Mac so you can review personal work time. The beta is for feedback, not billing or payroll. The release owner approved this notice for public beta distribution on 2026-10-16.

## What is stored locally

- Agent hooks record event time, source, session and agent identifiers, tool name or event kind, current working directory, and Orca workspace, run, task, dispatch, terminal, and host identifiers when available. Hook events do not intentionally include prompt or tool output bodies.
- macOS activity records the foreground app and bundle ID, idle seconds, and sleep/wake state. With Accessibility permission, Agent Time can read Orca window and selected tab titles and identify its worktree. Granting Accessibility is optional; without it, project attribution has gaps.
- When browser tracking is enabled for Safari, Chrome, or Brave, the local event can contain the **full page URL, including path and query, and page title**. Disable an individual browser in Settings to stop adding its URL and title to new samples. Earlier records remain in the local database.
- Optional usage import reads local Claude Code and Codex log files for model identifiers, token counts, account IDs, and usage timestamps. It stores usage records and cursor paths locally; it does not upload conversation text. Orca account metadata and rate-limit status may also be read locally.
- Settings, project rules, hook ownership records, Linear project cache, and captured events are stored under macOS Application Support. Linear OAuth tokens use macOS Keychain. Agent hook configuration is written only when you choose installation in Agent Time.

## Network access

- The app checks a beta HTTPS endpoint for signed app updates, and downloads an update only after you choose to install it.
- It can fetch the public pricing catalog from the Agent Time GitHub repository, no more than about once per day while usage is active.
- If you choose to connect Linear, authorization opens Linear in your browser and Agent Time exchanges/syncs project and workspace data with Linear. You can disconnect Linear in the app.
- Agent Time does not automatically upload your capture history or diagnostic summary. The **Copy diagnostic summary** action copies an allowlisted status report to your clipboard. Review it before sharing it with support.

## Retention and control

Capture data stays in the app's local database until you remove it. Settings let you pause capture, turn off sources, and remove Agent Time's hooks and login item. Removing the app alone does not erase local history or user-wide agent hooks. See [removal](remove.md) for both choices. The beta has no cloud account or remote history backup.
