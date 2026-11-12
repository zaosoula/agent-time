# Billing counting mode

User approved configurable minute-per-block and actual-second counting, minutes as default.

- [x] Engine: optional policy countingMode, minutes/seconds; omitted legacy mode means seconds. Apply exclusions/presence first, contiguous union blocks before weights/rates and existing commercial rounding. Keep raw metrics and expose raw eligible/counting credit separately. Share one minute across midnight within a policy, split at policy changes. Bound retained state to open blocks; no raw full-history accumulation.
- [x] Persistence/UI/API: new or appended policies missing a mode default to minutes; unchanged legacy policies keep their omission/seconds and immutable saved reports remain unchanged. Show selector, history/report mode and separate credit adjustment. No live database configuration is changed automatically.
- [x] Verify meaningful legacy/new/minute/second/midnight/union/cap/presence/rate regressions, independent review, full checks/build and packaged API/UI path. Publish next beta under standing authorization and record public/signing/runtime evidence.

Scope: no change to capture/MCP measurement, exclusion rules, raw stored events or already saved invoice snapshots. An existing project switches through a new policy version. Minute credit is per eligible production block, with human/agent-only shares proportional to observed contribution; weighted cumulative keeps separate agent channels. Commercial rounding remains an independent policy stage.

Local verification: 576 JavaScript tests, production typecheck/build and production audit passed. Independent review findings (legacy rate edit silently changing mode; fractional 60-second arithmetic causing a negative credit) were fixed failing-first and re-reviewed. Real browser and backend verified new-policy minute default, 120 counted seconds / EUR 2.50 versus 40 actual seconds / EUR 1.25 after commercial rounding, with both saved reports preserved.

Release verified: beta49 source 386ffa2, run 43145992173. CI 576 JS / 33 Rust; real browser and exact packaged mode/report flows passed. Public files, checksums, signature, notarization and Gatekeeper verified; see release record.
