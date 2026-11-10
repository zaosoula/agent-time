# App review verification

The review screen now derives expandable foreground-app sections and actual-interval app/project lanes from the same day intervals as before. Capture, stored events, schema, reducer and timing accounting are unchanged.

Verified on an isolated sample database through the real Vue screen and collector endpoints:

- App checkbox selected all 37 Orca visits, including 7 beyond the first 30 rendered children.
- Assign to alpha, reassign to bravo and Undo restored alpha; leave unassigned and Undo also worked.
- Show more revealed all 37 children. Searching Spotify cleared the prior selection and hid the shared bar.
- Expanded evidence and split editing remained accessible, and saving a split succeeded.
- Timeline and app totals retained 18 minutes of observed fixture activity after decisions.

Automated verification:417/417 JavaScript tests pass, including 11 new grouping/selection/timeline tests. Type checking and production build pass. New tests cover same URL in different browsers, app/host identity, interruptions and gaps, context/project boundaries, immutable input/source pairs, split exclusion, pair deduplication and 10,000-pair cap, actual clipped spans and local-day/DST range fitting.

Decision: preserve each continuous same-app/context visit rather than the legacy grouping's 60-second gap allowance. This can produce more child rows; initial rendering stays limited to 30 per expanded app. Backend accounting and persisted review history stay unchanged.

This is a source/UI implementation; it does not change the released app version or installer.

Independent final review found one important keyboard issue: a review shortcut intercepted Space on native buttons and project-picker triggers. Reproduced in the real screen (Select visible visits selected 1 rather than 30), then fixed by preserving control ownership. Regression policy test failed before implementation and passed after; browser checks now select 30 through the button, open the picker with Space and still select one visit with Space on its row.

Deferred minor: the two ribbon lanes render all visible-range bars. A synthetic 3,600-visit day can render 7,200 buttons. Child rows remain paginated; large-day rendering latency was not measured, so density-aware rendering is deferred rather than claiming a performance result.

Review rulings: capture accuracy, minute-credit accounting and existing summary/backlog counts remain outside this presentation change because changing them would alter the timing contract. Native desktop accessibility and large-day latency are not claimed as tested; browser keyboard and real collector workflows were tested. The cost of retaining these boundaries is that existing summary grouping counts may differ from the finer visit count, and desktop/large-day behavior may need follow-up.
