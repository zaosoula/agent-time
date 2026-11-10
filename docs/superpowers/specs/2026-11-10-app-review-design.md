# App sections for activity review

The user approved the Timing-style proposal and requested implementation: a chronological day ribbon above expandable app sections, with total observed time per app, individual activity/context rows and one shared assignment bar.

## Required behavior

- App sections identify the foreground application, not the browser page title. Keep different app IDs and hosts separate even when names or visited pages match.
- App totals retain the current raw observation durations. Existing accounting, rounding, daily/weekly summaries, captured events and review APIs do not change.
- Child rows retain page/window context, project/review state and source pairs. Never combine across a real gap or an intervening app. The ribbon paints actual source intervals, not the envelope between separated visits.
- Checking an app explicitly selects its eligible groups in the current filtered view. Checking a child selects that group. Split segments remain editable through the existing split workflow and cannot be overwritten by bulk assignment.
- The shared bar shows selected count/time, project picker and impact; supports assign/reassign and leave unassigned through the existing decision endpoint. Deduplicate pairs and enforce the existing 10,000-pair limit before any write. Undo continues through persisted review history.
- To review, Decided, All activity, search and site filtering remain available. Changing day/view/filter clears selection. All activity is the default for a new review state.
- Preserve expanded evidence, suggestions, note creation, automatic-match reset, split editing and previewed future website rules. Put uncommon per-row controls inside expanded details.
- Retain J/A/U/Command-Z and add previous-row K, checkbox selection via Space, staged project shortcuts 1–3 and Enter for a selected batch. Ignore text editing and picker/menu interactions.
- Initial child rendering is bounded to 30 groups per expanded app; app totals cover the full current filter. Reveal additional children explicitly. Focusing a hidden group opens its app and reveals the required page.
- Use existing Agent Time colors, locale formatting and pure browser-safe modules. No dependencies, database migration, capture changes, automatic attribution rules or new data collection.

## Implementation choices

Use presentation-only grouping and timeline geometry helpers. Reuse the existing review actions and advanced editors. Reuse timeline viewport functions for fit/zoom/pan and project colors for stable app identities. On narrow screens stack controls and keep selection/assignment available. Timelines are complementary to accessible app/child checkboxes; tiny bars must not become the only way to select an observation.

## Acceptance

Regression fixtures preserve input intervals, source pairs, total seconds, gaps, browser contexts and split boundaries. Bulk operations exclude split segments and reject over-limit selections. UI compilation and the browser-import guard pass; the full JavaScript suite passes. Inspect the real component on isolated fixture data when a browser host is available. One independent final branch review checks selection scope, stale state, keyboard behavior and timing preservation.
