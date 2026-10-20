# Adding a capture source

Source descriptors live in `src/capture/sources/`. `registry.ts` discovers files named `*.agent.ts`, `*.browser.ts`, or `*.poller.ts` and validates IDs, settings, and capabilities. Start from the existing descriptor of the same kind and add one new file. Do not add a second hard-coded list to the collector.

## Browser

Provide a unique ID, display name, macOS bundle ID, `browserX` setting, and default enabled state. `titleSuffix` helps the generic macOS probe identify browser page titles. Browser capture depends on Mac activity and optional Accessibility for page detail. A descriptor does not grant macOS permission or bypass app and site exclusions.

## Agent

Provide `id`, `${id}Hooks`, `${id}TokenUsage`, configuration discovery, hook event names, `normalizeHook`, and `parseUsage`. The hook normalizer must emit a validated `CaptureEvent` with a stable provider and session identity. Usage parsing must be idempotent and use a stable event ID. Keep hooks nonblocking and preserve unknown configuration keys and hooks from other tools. Installation should not rewrite byte-identical configuration, because Codex may require renewed trust after a file changes.

## Poller

Provide `poll` and `${id}Polling`. Pollers must tolerate a missing optional CLI and report unavailable status without spawning it repeatedly. Preserve the difference between an observed event and an inferred interval.

## Verify

Run `node --test tests/source-registry.test.ts`, `npm test`, and `npm run typecheck`. The registry fixture test creates a one-file browser and agent source and checks discovery, settings, and generic probe wiring. For a real agent, add a fixture with an authentic hook payload and usage record and check event validation, deduplication, install/repair, and first delivered event. Test a fresh session in the actual provider before claiming support.
