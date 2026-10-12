# Orca Agent Time Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove local capture and correct grouping of human activity, Orca orchestration workers, and provider sessions, then deliver an HTML evidence report.

**Architecture:** Python adapters persist minimal source events in SQLite; a deterministic reducer produces time-bounded associations and intervals. A Swift helper supplies macOS observations. A controlled Orca Run proves live joins while replay tests cover arithmetic and failure cases.

**Tech Stack:** Python 3.11+ standard library (`sqlite3`, `unittest`, `subprocess`, `argparse`, `html`), native Swift/AppKit/CoreGraphics/ApplicationServices. No third-party runtime dependency.

**Spec:** `docs/superpowers/specs/2026-10-12-agent-time-capture-design.md`

## Global Constraints

- Use Python 3.11+ and its standard library for CLI orchestration, SQLite persistence, correlation, replay tests, and HTML reporting.
- Use a small native Swift helper for macOS foreground, input inactivity, and sleep/wake observations.
- Poll documented Orca read APIs at a configurable interval, default five seconds.
- Use a configurable idle threshold, initially five minutes, retaining underlying observations so later correction is possible.
- The collector never consumes or acknowledges an orchestration inbox and never executes suggested next actions.
- Collection failure must not block, interrupt, or add context to an agent.
- Hook installation is explicit and reversible; preserve existing configurations and resolve the actual configuration root for each Orca account before modifying it.
- Folder workspaces are supported without Git.
- Missing final events, stale observations, sleep, collector downtime, and remote contact loss do not imply continued activity or process exit.
- Every derived interval carries observed, inferred, or unresolved proof status and its source evidence.
- Store generated evidence and databases outside tracked source paths and keep transcript/prompt content out of fixtures.
- Defer billing, cloud sync, full application tracking, screenshots/OCR, AI summaries, pricing calculations, and polished dashboard UI.

## Review Focus

1. Multiple workers sharing a directory must remain unresolved unless an explicit session/terminal binding proves the join (Task 3).
2. Wall-clock rollback must not create negative intervals or silently reorder causal observations (Tasks 1 and 3).
3. Truncated pages, remote omissions, and missing workers must remain coverage uncertainty rather than completion (Task 2).
4. Partial/corrupt spool files and simultaneous hooks must not block agents or lose other valid events (Tasks 1 and 2).
5. Titles and error messages containing HTML must render as text; omitted capabilities must remain visible (Task 5).

## File map and shared contracts

Create `ade_capture/` with `__init__.py`, `events.py`, `store.py`, `orca.py`, `hooks.py`, `hook_config.py`, `correlate.py`, `macos.py`, `report.py`, and `__main__.py`. Tests mirror these modules under `tests/`, using `unittest`; `tests/__init__.py` enables module-scoped invocations. Create `native/ActivityProbe.swift`, `README.md`, and `docs/capture-validation.md`. Add `.gitignore` entries for `.capture/`, `__pycache__/`, `*.pyc`, and native build artifacts. Local generated data goes into ignored `.capture/`, created with mode 0700; spool/database files use mode 0600.

An Event is a JSON-compatible dictionary with required `event_id: str`, `source: str`, `kind: str`, `observed_at: float` (UTC seconds), `monotonic_at: float`, and `collector_epoch: str`. Optional fields: `source_at`, `host_id`, `runtime_id`, `workspace_id`, `cwd`, `terminal_handle`, `terminal_incarnation`, `provider`, `session_id`, `turn_id`, `agent_id`, `parent_agent_id`, `run_id`, `task_id`, `dispatch_id`, and `data` (allowlisted object). Missing fields are absent or null, never guessed. Validate finite timestamps; collector epochs distinguish incomparable monotonic clocks.

An Interval dictionary contains `start`, `end`, `state`, `proof`, `source_event_ids`, and identity/grouping fields. Summary dictionary contains `intervals`, `unresolved`, `coverage`, `human_seconds`, `agent_seconds`, `elapsed_seconds`, and `child_agent_seconds`. Root-inclusive and child durations remain separate. A validation verdict has `scenario`, `mode` (`live` or `simulated`), `status` (`pass`, `fail`, `unsupported`, `unverified`), and `evidence`.

## Task 1: Private, idempotent event persistence

**Files:** `ade_capture/__init__.py`, `ade_capture/events.py`, `ade_capture/store.py`, `tests/__init__.py`, `tests/test_store.py`, `.gitignore`.

**Interfaces:** `make_event(source: str, kind: str, **fields) -> dict`; `Store(path: Path)` with `put(event: dict) -> bool`, `events() -> list[dict]`, `close() -> None`. Store validates events, stores serialized minimal payloads, and uses `event_id` as the unique key. `put` returns False on identical replay and rejects conflicting contents for the same ID.

- [ ] **Write failing persistence tests.** Use temporary directories for all test data. Include this test and companion cases for conflicting duplicates, invalid/nonfinite timestamps, permission modes, and preserved clock rollback:

```python
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from ade_capture.store import Store

class StoreTests(TestCase):
    def test_replay_does_not_duplicate(self):
        with TemporaryDirectory() as root:
            store = Store(Path(root) / 'events.sqlite')
            event = dict(event_id='e1', source='test', kind='running',
                         observed_at=10.0, monotonic_at=1.0,
                         collector_epoch='boot-a')
            self.assertTrue(store.put(event))
            self.assertFalse(store.put(event))
            self.assertEqual(store.events(), [event])
            store.close()
```

- [ ] **Run red:** `python3 -m unittest tests.test_store -v`; expect an import failure before implementation.
- [ ] **Implement schema and transactions.** Use the following storage kernel, with validation and conflict comparison before writes:

```python
connection.execute('PRAGMA journal_mode=WAL')
connection.execute('CREATE TABLE IF NOT EXISTS events '
                   '(event_id TEXT PRIMARY KEY, observed_at REAL NOT NULL, '
                   'payload TEXT NOT NULL)')
with connection:
    connection.execute('INSERT INTO events VALUES (?, ?, ?)',
                       (event['event_id'], event['observed_at'], payload))
```

Do not interpolate SQL or store source transcripts. Order replay deterministically by collector epoch, monotonic observation, then event ID; expose source timestamps separately. Reject malformed events without deleting valid earlier records. Create directories/files with restrictive modes before opening SQLite.
- [ ] **Run green:** `python3 -m unittest tests.test_store -v` and `git diff --check`.
- [ ] **Commit only Task 1 paths:** `git add ade_capture/__init__.py ade_capture/events.py ade_capture/store.py tests/__init__.py tests/test_store.py .gitignore`, then commit `feat: persist capture events idempotently`.

## Task 2: Orca snapshots and provider hook ingestion

**Files:** `ade_capture/orca.py`, `ade_capture/hooks.py`, `ade_capture/hook_config.py`, `tests/test_ingestion.py`, `tests/test_hook_config.py`.

**Interfaces:** `read_workers(call: Callable[[list[str]], dict], run_id: str | None = None) -> tuple[list[dict], list[dict]]` returns worker rows and coverage issues; `normalize_hook(provider: str, payload: dict, context: dict) -> dict`; `spool_hook(event: dict, directory: Path) -> bool`; `import_spool(directory: Path, store: Store) -> list[dict]` returns ingestion issues; `prepare_config(path: Path, provider: str, command: str, events: list[str]) -> dict` returns a reversible patch manifest; `restore_config(manifest: dict) -> None` removes only our additions after verifying contents. `call` executes only validated read commands via argv, with timeout and JSON receipt validation.

- [ ] **Write failing tests for pagination and ambiguous coverage.** Include:

```python
from unittest import TestCase
from ade_capture.orca import read_workers

class IngestionTests(TestCase):
    def test_reads_every_page(self):
        replies = iter([
            {'ok': True, 'result': {'workers': [{'dispatchId': 'd1'}],
             'page': {'hasMore': True, 'nextCursor': 'page-2'}}},
            {'ok': True, 'result': {'workers': [{'dispatchId': 'd2'}],
             'page': {'hasMore': False}}},
        ])
        calls = []
        def call(argv):
            calls.append(argv)
            return next(replies)
        rows, issues = read_workers(call, run_id='r1')
        self.assertEqual([w['dispatchId'] for w in rows], ['d1', 'd2'])
        self.assertIn('page-2', calls[1])
        self.assertEqual(issues, [])
```

Add cases for repeated cursor (stop with coverage issue), timeout after the first page (preserve collected rows), omitted host coverage, missing optional provider fields, and non-OK receipt. Hook tests cover concurrent separate records, incomplete files, oversized input, invalid JSON, identical replay, prompt/tool-output removal, session/subagent IDs, and no stdout/stderr on hook failure. Configuration tests prove exact original restoration and preservation of unrelated hooks added after installation; conflicts must refuse destructive restoration.
- [ ] **Run red:** `python3 -m unittest tests.test_ingestion tests.test_hook_config -v`.
- [ ] **Implement documented reads and minimal hooks.** Start with these command forms, confirmed against installed help at execution time:

```python
argv = ['orca', 'orchestration', 'worker-list', '--limit', '100', '--json']
if run_id:
    argv += ['--run', run_id]
if cursor:
    argv += ['--cursor', cursor]
```

Normalize Run/Task/Dispatch/terminal/incarnation/workspace/host and fresh/stale evidence from worker records; read terminal metadata for non-orchestrated sessions. Capture receipt runtime IDs. Polling never calls `check`, `send`, or lifecycle mutations.

Provider hooks accept at most 256 KiB, discard prompt/tool text, and record session/turn/subagent IDs plus verified environment context. Write one UUID-named spool file per invocation via exclusive creation and atomic rename; import only final files and archive/remove only after the SQLite transaction succeeds. Catch all ordinary capture failures and exit 0 silently; hook code does not call Orca. Bound hook work to a local write, with no network calls.

Before implementing config patches, fetch current official provider hook documentation, check actual Orca-managed executables and configuration roots, and inspect only hook settings (never credentials). Claude uses its documented JSON settings hook layout. For Codex prefer a separate `hooks.json` beside its active config, preserving the existing file. Handle trust through the supported provider flow; never bypass it. Preview patch manifests before applying them as part of the approved controlled test. Refuse symlink targets and unsupported settings shapes.

Register the supported equivalents of SessionStart, UserPromptSubmit, tool boundaries, Stop, Interrupt, SessionEnd, SubagentStart, and SubagentStop; unsupported events get capability verdicts. Store mapping of provider-specific names explicitly. Record hook process ancestry and any verified Orca terminal identity to enable joins. Read only allowlisted identity variables; never dump environment variables or account credentials. An absent binding stays unresolved.
- [ ] **Run green:** `python3 -m unittest tests.test_ingestion tests.test_hook_config -v`.
- [ ] **Commit Task 2 paths** with `feat: ingest Orca metadata and agent hooks`.

## Task 3: Time-bounded grouping and interval arithmetic

**Files:** `ade_capture/correlate.py`, `tests/test_correlate.py`.

**Interfaces:** `union_seconds(intervals: list[tuple[float, float]]) -> float`; `summarize(events: list[dict], *, idle_threshold: float = 300, max_gap: float = 15) -> dict`. Input is the Event contract. Output is the Summary contract. Verified bindings are `kind='binding'` events with session and terminal/incarnation/host plus `data.valid_from` and optional `data.valid_until`; sources must demonstrate how the binding was established.

- [ ] **Write failing arithmetic and relationship tests.** Include:

```python
from unittest import TestCase
from ade_capture.correlate import union_seconds, summarize

class CorrelationTests(TestCase):
    def test_union_counts_overlap_once(self):
        self.assertEqual(union_seconds([(0, 60), (20, 80)]), 80)
        self.assertEqual(union_seconds([(0, 60), (60, 90)]), 90)

    def test_same_cwd_is_not_a_verified_join(self):
        event = dict(event_id='h1', source='hook', kind='prompt_submitted',
                     observed_at=10.0, monotonic_at=1.0,
                     collector_epoch='a', session_id='s1', cwd='/shared')
        result = summarize([event])
        self.assertTrue(result['unresolved'])
        self.assertEqual(result['agent_seconds'], 0)
```

Add independently meaningful fixtures for two Runs in one directory; follow-up Dispatch with reused terminal; completed retained terminal; user takeover; interrupted and missing final events; explicit known wait/resume; native child sharing root session ID; simultaneous root agents; duplicate/reordered events; backwards source time; collector epoch change; disappeared workers; sleep; polling gaps; and idle/reading intervals. Root plus child must not inflate combined agent duration. Empty input yields zero totals and explicit missing coverage.
- [ ] **Run red:** `python3 -m unittest tests.test_correlate -v`.
- [ ] **Implement the union algorithm and conservative reducer.** The arithmetic kernel is:

```python
merged = []
for start, end in sorted(intervals):
    if end < start:
        raise ValueError('negative interval')
    if merged and start <= merged[-1][1]:
        merged[-1] = (merged[-1][0], max(merged[-1][1], end))
    else:
        merged.append((start, end))
return sum(end - start for start, end in merged)
```

Maintain per-session/agent/turn state. Submission opens pending state, not execution. Tool boundaries or a fresh Orca working observation prove activity only to their precision. A provider response stop closes its observed turn segment, while accepted settlement closes attempt ownership. Subsequent continuation creates another segment. Bound inferred intervals to adjacent observations within `max_gap`; a gap does not extend activity to now. Poll transitions display their uncertainty bounds. Reject associations crossing host/incarnation or explicit binding validity boundaries. Keep root/native-child and Orca-worker relationships distinct. Human totals use interval union; idle classification uses the configured threshold and remains estimated. Preserve source IDs for every interval.
- [ ] **Run green:** `python3 -m unittest tests.test_correlate -v` and inspect expected arithmetic values in fixtures.
- [ ] **Commit Task 3 paths** with `feat: group sessions and calculate bounded time`.

## Task 4: Native human-activity observations

**Files:** `native/ActivityProbe.swift`, `ade_capture/macos.py`, `tests/test_macos.py`.

**Interfaces:** native helper emits JSON lines with foreground bundle ID, wall/monotonic timestamps, all-event idle seconds, Accessibility capability, and sleep/wake observations. Python `normalize_activity(payload: dict, context: dict) -> dict` produces Event contract; `probe_capabilities(executable: Path) -> dict` records actual helper permissions. Context supplies collector epoch; no macOS API is invoked from unit tests.

- [ ] **Write failing normalization tests.** Include:

```python
from unittest import TestCase
from ade_capture.macos import normalize_activity

class MacOSTests(TestCase):
    def test_bad_idle_is_unknown(self):
        event = normalize_activity(
            {'foreground_bundle_id': 'test.app', 'idle_seconds': -1,
             'observed_at': 10.0, 'monotonic_at': 1.0},
            {'collector_epoch': 'a', 'host_id': 'local'})
        self.assertIsNone(event['data']['idle_seconds'])
        self.assertEqual(event['data']['idle_status'], 'unknown')
```

Add finite validation, missing permission, sleep/wake discontinuity, extreme idle exceeding uptime, and focused app without focused-session identity. Permission absence must reduce capability without breaking app-level capture.
- [ ] **Run red:** `python3 -m unittest tests.test_macos -v`.
- [ ] **Implement native signals using these API anchors:**

```swift
let app = NSWorkspace.shared.frontmostApplication
let allEvents = CGEventType(rawValue: UInt32.max)!
let idle = CGEventSource.secondsSinceLastEventType(
    .combinedSessionState, eventType: allEvents)
let trusted = AXIsProcessTrusted()
```

Observe NSWorkspace activation and sleep/wake notifications, plus periodic input-idle sampling. Emit newline-delimited JSON with `JSONSerialization`; flush output. Use uptime/monotonic clocks to detect invalid inactivity. Accessibility inspection reads only focused-window and selected workspace/tab identifiers where available; never collect text-entry contents or complete UI trees. Missing/ambiguous session context remains absent. Do not prompt for new OS permission silently. A currently trusted probe does not establish helper trust.
- [ ] **Build and exercise:** `mkdir -p .capture/bin` then `swiftc native/ActivityProbe.swift -o .capture/bin/activity-probe`. Run a bounded sample, compare observed foreground and all-event inactivity, and record actual Accessibility capability. Record focused-session detection as pass or unverified according to observation, not API availability.
- [ ] **Run green:** `python3 -m unittest tests.test_macos -v`.
- [ ] **Commit Task 4 paths** with `feat: capture macOS foreground and idle signals`.

## Task 5: Runnable harness, local report, and live orchestration proof

**Files:** `ade_capture/__main__.py`, `ade_capture/report.py`, `tests/test_report.py`, `tests/test_cli.py`, `README.md`, `docs/capture-validation.md`.

**Interfaces:** `render_report(summary: dict, verdicts: list[dict]) -> str`; CLI subcommands `hook --provider --spool`, `collect --output --duration --interval --run`, `report --database --output`, and `hook-config prepare|apply|restore` with explicit target/manifest. Defaults: output `.capture/`, interval 5 seconds; no permanent service. Hook command always returns 0 without output; other commands return nonzero for actual failures. Report accepts an empty store and shows missing evidence.

- [ ] **Write failing reporting and CLI tests.** Include:

```python
from unittest import TestCase
from ade_capture.report import render_report

class ReportTests(TestCase):
    def test_titles_are_escaped_and_uncertainty_visible(self):
        summary = dict(intervals=[], unresolved=[], coverage=[],
                       human_seconds=0, agent_seconds=0, elapsed_seconds=0,
                       child_agent_seconds=0)
        verdict = dict(scenario='<script>alert(1)</script>', mode='live',
                       status='unverified', evidence='no verified binding')
        result = render_report(summary, [verdict])
        self.assertNotIn('<script>alert(1)</script>', result)
        self.assertIn('&lt;script&gt;', result)
        self.assertIn('unverified', result)
```

CLI tests run bounded collection with injected fake readers, assert hook failure is silent/successful, validate finite positive duration/interval, and verify no generated data is written outside the chosen output directory. Report tests require separate live/simulated verdicts, overlap-aware totals, child detail, unresolved joins, and host coverage omissions.
- [ ] **Run red:** `python3 -m unittest tests.test_report tests.test_cli -v`.
- [ ] **Implement orchestration of existing interfaces:**

```python
store = Store(output / 'events.sqlite')
# The bounded collector persists normalized snapshots, hook imports,
# native observations, and coverage issues without mutating source runs.
summary = summarize(store.events(), idle_threshold=300, max_gap=15)
report_path.write_text(render_report(summary, verdicts), encoding='utf-8')
store.close()
```

Use `html.escape` for all external values; embed no transcript HTML. Show navigable workspace/Run/task/session groups, labeled human/agent/elapsed metrics, intervals, and the ten-scenario verdict matrix. Ensure collector cleanup in `finally`, terminate only its own native helper, and preserve committed events on interruption. Document setup, commands, metrics, uncertainty, account-specific hook installation, and rollback.
- [ ] **Run green:** `python3 -m unittest discover -s tests -v`; `git diff --check`.
- [ ] **Perform bounded live test after loading the current Orca guides.** Resolve active provider executable/account root, prepare/install hook changes and follow the provider trust flow. Read `orca skills get orchestration --json` and supported placement/coordinator references before lifecycle work. Record a manifest of original configuration and every owned test resource. Create one dedicated Run and launch two read-only worker tasks in this workspace through `worker-start --spec`. Use self-contained prompts: target the capture validation; inspect only own hook identity and local metadata; modify no repository files; report acceptance and settle following the injected contract. Start both workers before waiting, and start capture before their work. Use waits of at most 60 seconds with progress updates. No worker duplication on timeout.

Correlate launch receipts with captured session identities and time-bounded terminal bindings. Where no explicit identity is available, inspect verified process ancestry/env in the test worker; never join by cwd alone. Observe a native subagent only through a provider that supports it and explicitly instruct that test worker to create one read-only child; keep its parent/child evidence separate from Orca worker grouping. Add a second dedicated Run only if needed to prove same-workspace Run isolation; maintain all created Run/Dispatch IDs in the manifest.

Coordinator operations may process their own test Run's messages; the passive collector may not. Settle and release each owned worker using the lifecycle contract. If blocked or unverifiable, preserve authority, record the exact state, and report required recovery rather than force-closing. Restore only test-owned hook additions; verify unrelated configuration survives. Never touch unrelated runs or workers.
- [ ] **Record every scenario verdict** in `.capture/validation.json`, separating live and simulated evidence. Record actual tool versions, coverage, duration uncertainty, config restoration result, and resources remaining. Provider trust requiring user interaction is a concrete external requirement, not permission to bypass trust. Unsupported remote restart/session detection stays unverified.
- [ ] **Render and inspect HTML:** `python3 -m ade_capture report --database .capture/events.sqlite --output .capture/report.html`; use Orca's embedded browser after its browser guide to verify readability, escaping, navigation, and visibility of uncertainty. Publish nothing.
- [ ] **Accept only on core live proof:** same-workspace worker grouping end to end, at least one real hook-to-session join, verified macOS foreground/idle readings, and passing deterministic tests. If the core join fails, record that failure and revise the design instead of beginning dashboard work. Document outcomes in `docs/capture-validation.md` without private transcript content.
- [ ] **Commit Task 5 source/tests/docs only** with `feat: report agent time capture validation`; inspect committed paths and final worktree status. Never stage `.capture/` or hook files outside the repository.

## Final review and stop condition

Review implementation against all ten spec scenarios and the five Review Focus cases. Test results are fixture proof unless labeled live. The report must distinguish a turn completion, accepted task settlement, process exit, and unknown contact state. Run the complete unittest suite once after final edits; repeat only for new failures or changes. A passing harness and local report completes this phase; a production dashboard, billing readiness, and background-service installation remain separate work.

## Execution recommendation

Implement inline with `superpowers:executing-plans`, followed by an independent code review. The five tasks share event contracts and the live exercise changes account-specific configuration, so one implementer should keep ownership of correlation and cleanup. Live Orca workers are test subjects, not implementation delegates. If the user prefers subagent-driven implementation, preserve these contracts and stage boundaries and use the corresponding skill.
