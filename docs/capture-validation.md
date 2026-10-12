# Capture validation — 2026-10-12

## Observed live

Two read-only Claude workers were launched through Orca orchestration in the same existing workspace and test Run. Both emitted provider hook session IDs with distinct Orca terminal handles. Those handles matched their launch receipts and separate Task/Dispatch records. The collector grouped both root sessions under the Run without merging them by directory.

One worker launched a native Claude child. SubagentStart, child tool boundaries and SubagentStop carried a distinct agent ID and the root session ID. The captured child start/stop span was approximately 3.43 seconds. Child duration is shown separately from inclusive parent/root time. Other child-stop-only observations remain incomplete evidence.

Both Tasks settled successfully, their terminals were released using Orca's lifecycle, and the coordinator delivery was acknowledged. No worker was left reclaimable. Temporary project-local Claude hooks were restored to their pre-test state. No user/global account configuration was changed.

The compiled Swift helper returned foreground-app and all-event input-idle observations. Accessibility was available for the tested helper, but Orca's focused window title was generic: human session/project attribution remains unverified. No permission is requested automatically.

The unsigned Apple Silicon Tauri app launched from its application bundle with PATH initially restricted to `/usr/bin:/bin`; its bundled Node executable, SQLite, packaged capture source and Swift helper ran. Node's native dependencies resolved to system frameworks/libraries. Native UI inspection observed the timeline, linked session inspector, and ongoing collection. Bundling is not signing, notarization, or distribution proof.

## Scenario matrix

| Scenario | Proof | Result / limit |
|---|---|---|
| Multiple workers, same workspace and Run | Live | Two root provider sessions linked to distinct Dispatches |
| Two Runs sharing one workspace | Simulated; live metadata discovery | Explicit Run separation; no second controlled live Run launched |
| Provider-native child grouping | Live | Distinct child agent ID associated with root; child duration separate |
| Retry / reused terminal | Simulated | Separate attempts; late prior-session closures stay with their original binding |
| Coordinator / permission wait | Simulated | Known waits separate from running; coordinator ask/answer boundaries not live-tested |
| Completion / retained terminal / takeover | Simulated; live metadata | Completed/retained/takeover rows observed; finished attempts stop accumulating |
| Restart, sleep, contact loss | Simulated | No inferred duration across gaps; native remote restart/disconnection unverified |
| Foreground switching and idle | Live plus simulated normalization | Native observations returned; session attribution unverified |
| Duplicate / reordered / concurrent events | Simulated | Idempotent storage; tool IDs preserve overlapping tool intervals |
| Hook failure and rollback | Live restoration plus simulated faults | Hook configuration restored; capture failure does not block agent execution |

## Independent review

A read-only reviewer found execution-interval and cleanup cases absent from the initial tests: overlapping tools, missing old tool ends, sleep spanning a native child, late prior-session closures after terminal reuse, non-owner stop writes, and slow polling during Quit. Regression tests were written and observed failing before fixes. The collector now tracks tools separately, preserves session/attempt bindings, fences native child continuity at boundaries, and restricts stop writes to its lock owner. Polling checks cancellation between pages/batches, shutdown stops the helper before waiting, and the native host owns a child process group for fallback cleanup.

The report CLI destination/default-database interaction was also corrected. The native close/reopen check preserved the same collector PID. Native Quit left no owned app/Node/Swift processes and removed the collector lock. The final suite passed 34 TypeScript tests and two Rust tests; typecheck and frontend/native builds passed. Detailed receipts are recorded in local `.capture/` evidence; generated evidence and private identity values are not committed.

## Limits

This is a capture-validation preview, not a production billing system. Actual Codex hook delivery has not been tested; configuration generation follows the documented provider layout but still requires trust and runtime validation. Remote-host tracking, lock recovery after arbitrary crashes, sustained multi-day capture, and precise human project/session allocation need further proof. No transcript backfill adapter is claimed. Capture continues while the window is hidden; it stops when the app quits, and hooks only spool while quit. No login/background service was installed.
