# Unified controls, cards and status

Approved scope: normalize action buttons and single-line form controls, reuse card/heading components, and simplify the bottom status bar. Preserve existing calculations, saved policies, form drafts, page caching and action semantics.

- Regular controls use 32px and compact controls use 28px. Checkbox/radio/range, multiline fields, navigation, charts and expandable content rows retain their own layout.
- Shared native-button, card and section-heading components replace repeated visual definitions where useful. Labels, focus rings, disabled controls, explicit submit actions and native input behavior remain intact.
- One bottom capture status replaces the sidebar duplicate. Show current global working agents only when capture is running, never selected-day session counts.
- Billing calculation/open/export, manual history optimization and backup creation expose real ongoing work across navigation. Only actual billing day progress is displayed; other jobs stay indeterminate. Jobs finish or clear on success/error, and completion links return to the owner workspace.

Verification: focused page/draft/history regressions, shared component rendering and attrs, background-job lifecycle, complete JS suite and production build; representative browser checks of control dimensions and retained background work.

## Verified outcome

Shared AppButton, AppCard and SectionHeading are adopted across the app's workspaces, settings and review actions. Native form submission, heading levels, slots, attrs and focused limits targets are covered by real component-rendering tests. Structured rows can still grow; controls share regular32/compact28 dimensions.

Validation: full JS suite634/634; final focused UI/lifecycle/regression suite40/40; production build/typecheck passed. Browser preview confirmed billing button/date/select32px at12px text, storage compact actions28px and fields32px, both themes, one footer status, offscreen report progress and return-to-result. Synthetic preview data only. Existing >500kB bundle advisory remains.

Review fixes: completed billing notifications disappear when project results are invalidated; cancelling pending optimization clears its ready message; late progress responses cannot decorate a completed operation. No timing, capture, billing calculation or stored-data semantics were changed. No release created.
