# App Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline, task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved day timeline and expandable app sections with shared review/reassignment controls.
**Architecture:** Browser-safe presentation helpers derive app visits, selection and ribbon geometry from unchanged human intervals. Vue components consume these helpers and retain existing review/undo/split/rule APIs.
**Tech Stack:** Vue 3, TypeScript, current Lucide/Reka UI and Node test runner; no added dependencies.
**Spec:** `docs/superpowers/specs/2026-11-10-app-review-design.md`

## Global Constraints

No event/schema/timing-reducer changes. Existing 10,000-pair bulk limit and split-specific workflow remain. Render 30 initial child groups per expanded app. All runtime UI imports stay browser-safe. Preserve user edits outside this worktree.

## Review Focus

- The same URL in two browsers must stay in separate app sections.
- A gap or intervening app must not become observed time or one continuous visit.
- Two split segments sharing a source pair must not be bulk overwritten.
- Changing date/view/filter or receiving a decision response must not retain hidden selected rows.
- Focusing an initially hidden row must open its app and reveal it; keyboard input in project pickers must remain native.

---

### Task 1: App, selection and timeline presentation helpers
**Files:** create `src/ui/review-apps.ts`, `tests/review-apps.test.ts`.
**Interfaces:** `AppReviewGroup extends HumanReviewGroup` with `appKey/appName/bundleId/hostId`; `buildAppReviewGroups(intervals:Interval[]):AppReviewGroup[]`; `reviewAppSections(groups:AppReviewGroup[]):ReviewAppSection[]`; `reviewGroupId(group):string`; `reviewSelection(groups,selectedIds):{groups,pairs,seconds,hasDecisions,overLimit}`; `reviewTimelineBars(intervals,groups,range):ReviewTimelineBar[]`.
- [ ] Write failing tests for true app identity across browser pages, same-name/different-ID apps, disjoint visits and unchanged input/seconds/pairs.
- [ ] Add split-selection, deduplicated/oversized pair and clipped ribbon/gap tests.
- [ ] Implement helpers through existing `groupHumanReview`, using contiguous same-app runs and unchanged source intervals.
- [ ] Run `node --test tests/review-apps.test.ts tests/human-review.test.ts tests/timeline-viewport.test.ts tests/ui-bundle.test.ts`; commit after green.

### Task 2: Vue timeline, app hierarchy and shared action bar
**Files:** create `src/ui/ReviewTimeline.vue`; modify `src/ui/HumanReview.vue`; extend behavioral helper tests where new selection/focus logic needs proof.
**Interfaces:** timeline consumes human intervals, app review groups, selected group IDs and selected date; emits a group ID on selection. Parent owns filters, app expansion/limits, selection and all existing actions.
- [ ] Implement actual-interval app/project lanes with existing viewport zoom/pan, locale labels and accessible selection alternatives.
- [ ] Wrap existing child/detail workflows in expandable app sections; move ordinary project/assignment controls into one contextual shared bar.
- [ ] Add bulk leave-unassigned, app/visit selection, safe view/date/filter reset, bounded children, reveal-on-focus and keyboard shortcuts without changing endpoints.
- [ ] Verify focused tests plus `npm run build`, inspect fixture UI/selection/assign/undo/reassign/split when browser available, and commit.

### Task 3: Final verification and integration
- [ ] Run `npm test` and `npm run build`; record actual outcomes and any baseline failures.
- [ ] Request one fresh-context whole-branch review against spec and Review Focus. Fix Critical/Important findings with regression proof and green suite; record minor findings.
- [ ] Integrate the reviewed changes while preserving unrelated work; record validation/limitations and clean task-owned scratch only.
