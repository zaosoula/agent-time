# Troubleshooting Agent Time capture

Open **Capture health** and select **Run capture checks** first. The check separates an enabled source, its current configuration, and an event actually delivered to Agent Time. A configured hook alone does not prove capture works.

## No agent events

1. Open **Settings → Connect agents** and install or update only the affected Claude Code or Codex installation.
2. Start a *new* agent session. An existing session can keep an older hook runtime.
3. In Codex, open `/hooks` and trust the Agent Time hook if Codex asks. Agent Time cannot grant that trust on your behalf.
4. Return to **Capture health**. The source check should show an event from the current runtime. If it stays at “waiting”, use **Preview diagnostic summary** and send the reviewed text to `zao.soula@ezyostudio.com`.

## Mac activity or websites are missing

Enable **Mac activity** in Settings. Grant Accessibility access when the app prompts for it if you want browser tab details. macOS foreground app activity may still be captured when optional tab detail is unavailable. Open a supported browser in the foreground, then run capture checks again. App and site exclusions intentionally omit details.

## Orca says “Not installed”

Orca is optional. Agent hooks and Mac activity work without it. Install Orca only if you want its orchestration and worktree context. Agent Time will stop polling Orca while its CLI is unavailable.

## Collector exited or capture is paused

Use **Retry** or **Resume capture** in the app and verify a new event in Capture health. Automatic collector restarts are bounded. A deliberately stopped app or update does not restart capture until the app runs again.

## Updater cannot fetch release information

Check your connection to `https://agent-time.ezyostudio.com/latest.json`, then use **Retry update check**. The app installs updates only when you choose to. If the feed is unavailable, capture should still run; check Capture health separately. Send the diagnostic summary and app version if the error continues.

## Low disk space or database warning

Open **Settings → Storage** for database, write-ahead log, hook spool, runtime, and archive sizes. **Reclaim temporary space** checkpoints the SQLite write-ahead log and keeps all observations. Free space elsewhere on the Mac if needed. Do not delete the live `events.sqlite` file. Export an archive before a restore; use the app's preview and integrity check when importing a saved archive. The app does not silently remove old capture evidence.

## Sleep, wake, or clock change

Review the timeline around the gap. A missing interval is unknown time, not proof of work or idleness. If you know what happened, add a labelled manual note; Agent Time keeps it separate from observations.

## Share a support summary

In **Capture health**, select **Preview diagnostic summary** and inspect it. You can copy the text or save a redacted JSON support bundle to a location you choose. It contains source states, counts, coarse errors, version and platform information. It excludes event contents, project paths, URLs, window titles, and raw errors. Sharing is optional.
