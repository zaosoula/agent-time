# Navigation workspaces implementation plan

Approved by the user after the navigation/action audit on 2026-11-13.

## Acceptance

Main destinations: Home, Review, Agents, Projects, Billing, Reports. Settings is anchored at the sidebar footer. Reports contains Time, Usage, Evidence. Settings contains General, Time counting, Capture & connections, Privacy, Data & backup. Capture health remains directly reachable through global status, warnings, menu-bar actions and native/deep-link compatibility.

Project work moves out of global Settings: an explicit Projects workspace owns Overview, Attribution, Billing, Evidence. Repository identities and billable groups remain explicitly distinct; selecting a repository must never silently merge billing groups. Linear/hook/MCP/permission setup stays in connections.

Reuse current components, transports, calculations and immutable policies/reports. Preserve visited-page state, background report jobs, drafts, scroll and dialogs' hidden-page lifecycle. Keep storage/recovery/cleanup and support actions accessible with contextual disclosure. No timing, capture, attribution or money calculation changes.

## Shared contracts (root owns store.ts/App.vue)

- New page IDs `projects`, `reports`; legacy weekly/outcomes/usage/health navigation maps to the appropriate new section.
- Store refs `reportsSection`: time|usage|evidence; `projectsSection`: overview|attribution|billing|evidence; `connectionsSection`: agents|sources|linear|health; `billingSettingsProject`: configured billing project ID; existing `project` remains repository/project filter.
- `openSettings(section, connection?)`, `openProject(path?, section?, billingProjectId?)` helpers select a specific target without remounting or resetting an unrelated report. Components use existing raw useStore refs or reactive wrapper consistently.
- Settings props status/busy remain; add `review-site` emission for embedded health navigation.

## Work units

1. Baseline page retention/editor/bundle tests and production build. Isolate in existing clean app-review worktree on codex/navigation-workspaces; preserve root user files.
2. Projects workspace (ProjectsPage.vue; WebsiteRules.vue/BillingSettings.vue scoped props; focused tests). Use explicit repository selector plus explicit billing-group selector, contextual activity/evidence links and advanced technical source disclosure. Move project policy ownership out of settings, preserve draft revisions and saves.
3. Settings restructuring (CaptureSettings.vue; focused tests). Five sections, lazy visited panels. Capture & connections subviews for agents/MCP, Mac/browsers, Linear, health. Startup and About/update access under General. Setup assistant in connections. Technical health/repair/support and destructive recovery remain secondary, never hide global critical status.
4. Saved billing reports (billing store/service/collector + strict Rust bridge/transport; BillingReports.vue; tests). Add bounded, read-only paged history. Select/export existing immutable report without recalculation; project-specific edit-policy action opens Projects Billing. Preserve ongoing worker jobs and dates/results.
5. Root navigation and ReportsPage (store.ts/App.vue/ReportsPage.vue, WeeklyReview/Usage/WorkOutcomes poll guards, retention tests). Seven cached top-level workspaces, three cached report views; explicit navigation compatibility; native menu routes still work. Keep global errors/status/pause/update visible. Sidebar project shortcut opens project workspace, while existing activity filters remain available.
6. Nested actions (HumanReview/TodayPage/SessionInspector/SessionExplorer). Default unresolved queue; make assign/change/bulk/undo primary; progressive detail for visits and less-used actions. One consistent session detail presentation with technical metadata disclosed. Running timers and limits link from Agents. Remove duplicated full session browser from Home; retain contextual links.
7. Integrated focused tests, full JavaScript suite, production build/typecheck, strict native bridge tests, browser walkthrough with synthetic data. Verify legacy navigation, every section's reachability, saved report exports, jobs completing off-screen and draft/filter/scroll retention. Independent review before commit/merge.
8. Commit and push implementation with source docs updated. No new beta publication unless requested.

## Stop condition

All approved destinations/actions are reachable in their new homes; state/background work and stored data preserved; checks pass; no known important review finding. Report material limitations honestly.

## Verification completed

- 628 JavaScript tests pass, including navigation compatibility, nested KeepAlive retention, hidden Evidence refresh, limits focus precedence, metadata catalog fallback, saved report history and async project/rule saves.
- 34 locked native tests pass, including strict history-request validation. Native resources built locally for tests; no installed app or live capture modified.
- Production typecheck/build passes. UI bundle boundary remains free of Node runtime imports.
- Browser walkthrough used synthetic projects and the actual billing store/service behind the preview route. Verified six main navigation destinations and footer Settings; five settings sections; direct capture health, source/MCP/Linear/privacy/data access; saved report opening/export by immutable ID; background report completion off-screen; retained rate/website drafts; collapsed visit group assignment without a write; account-limit focus; date-correct Evidence refresh; known repositories on empty days.
- Independent review found and then verified fixes for cross-project async save races, hidden Evidence staleness, explicit limits focus losing to scroll restoration, and history pagination being reset on view changes.
- Existing timing, capture, review-decision and price computation code is unchanged by this slice. Saved report history is bounded/read-only; no schema migration.
- The public-guide HTTP test now consumes asset response bodies and closes its test connections, avoiding a nondeterministic server teardown hang.

Previews use synthetic data. Native menu routing is source/native-test verified; no customer installation or new release is claimed.
