# Agent Time closed beta specification

## Goal and first cohort

Offer a small, private macOS beta of Agent Time that a tester can install, understand, verify, update, and remove without development tools. The first candidate is a direct, Developer ID signed and notarized download for Apple Silicon Macs. The release owner chooses the tested minimum macOS version from fresh-machine results before inviting testers. Intel support is a separate build and test decision. A later App Store or TestFlight route would require a separate sandbox compatibility project.

The beta is for validating personal time capture, Orca grouping, agent hooks, browser activity, and the day view. It is not a billing or payroll record. Orca is required for orchestration views; Claude Code and Codex are optional sources. Missing permissions or unsupported sources must produce honest coverage states, not plausible-looking time.

## Beta safety contract

- No distributed build uses an Apple Development identity, unsigned nested executable, or a build with Hardened Runtime disabled. Notarization acceptance, stapling, Gatekeeper assessment, and a quarantined install on another Mac are required.
- The app and every bundled executable retain stable signing identity and bundle ID across updates. Existing settings, events, hook ownership records, Keychain credentials, and Accessibility grants must survive an upgrade; rollback must not delete or reinterpret the database.
- Hook installation remains a distinct user action. The app must explain what files it edits, how to verify delivery, and how to remove its own hooks and login item. Starting the app must not change provider trust settings.
- Capture data remains local. A short privacy notice lists recorded data, local retention, and the exact network exceptions: optional Linear authorization/sync and public pricing catalog fetches. Feedback and diagnostics are sent only after the tester chooses to share them. Diagnostic output must omit prompts, tool output, URL paths/query strings, tokens, and Keychain contents.
- A beta release includes a versioned artifact, checksum, release notes, installation/update/removal steps, known limitations, and a private feedback contact. No tester is invited until the contact works and the release can be withdrawn.

## Delivery decision

Use a private, direct download for the first Apple Silicon pilot. Apple requires a Developer ID signature, Hardened Runtime, and notarization for this route. The current app uses broad local filesystem, process, Accessibility, and provider configuration access; Mac App Store distribution would require a separate App Sandbox design and validation. Manual, announced updates are acceptable for the first small cohort. Add signed automatic updates before a wider or long-running beta.

## Acceptance gates

1. **Distribution:** the exact downloaded artifact passes signature, notarization ticket, Gatekeeper, quarantine, and nested-helper checks on a clean Mac without Xcode, Homebrew, or a system Node install.
2. **First run:** a tester can understand the data captured, choose hooks and permissions, run an agent, see an actual received event, and identify missing coverage. Declining a permission keeps the app usable with an accurate limitation.
3. **Continuity:** a real upgrade preserves history, provider configuration, credentials, permissions, capture settings, and login behavior. Hook runtime version changes either migrate safely or show a repair warning. A documented rollback leaves data intact.
4. **Reliability:** a multi-day trial covers sleep/wake, app hide/reopen, quit/relaunch, Orca unavailable/reconnected, database growth, and resource use. The release owner records thresholds and accepts the observed results before invitations.
5. **Operations:** support receives a reproducible, redacted report; the team can publish a fixed build, notify testers, and withdraw a bad artifact. Beta communications state what the metrics mean and their known limits.

## Scope boundary

No public launch, payments, account service, automatic upload of capture history, remote-host tracking claim, billing-accuracy claim, or Mac App Store submission is part of this first pilot.
