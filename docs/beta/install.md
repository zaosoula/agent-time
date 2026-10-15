# Install Agent Time closed beta

**Release gate:** Follow these steps only with a versioned, Developer ID signed and notarized Apple Silicon installer supplied by the release owner. The current local development build is not the beta installer. The tested minimum macOS version is recorded in [release-record.md](release-record.md) before invitation.

1. Download the one-time installer from the private invitation link. Open it in Finder and move Agent Time to Applications. Do not bypass a macOS Gatekeeper warning; report it to support.
2. Open Agent Time. The app runs in the menu bar even when the dashboard window is closed. Use **Quit Agent Time** in the menu bar to stop the collector.
3. Read the [data notice](privacy.md). In Settings, choose the sources you want: macOS activity, agents, individual browsers, and optional usage import. Accessibility adds Orca tab and website attribution; capture can continue with limited detail if you decline it.
4. Choose **Connect your agents** only for agents you want tracked. Review the configuration locations shown in the dialog, then install. For Codex, review and trust Agent Time hooks in `/hooks`. Start a new agent session after installing; older sessions may lack events.
5. Open **Capture health**. An installed hook means configuration is present; verify a real **last event** after you start an agent. If no event arrives, use **Check all hooks** or **Install / repair hooks** in Settings. A native notification can also warn when a hook is outdated.
6. Optionally enable **Start capture when I sign in** in Settings → System and approve it in macOS Login Items. It is off unless you enable it.

Later beta builds arrive through the app; see [updates](update.md). If a step fails, share the version, macOS version, source, and reproduction steps using the private feedback address in your invitation. You can copy a redacted diagnostic summary from Capture health; review it before sending.
