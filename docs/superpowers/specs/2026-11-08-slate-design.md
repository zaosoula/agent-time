# Agent Time slate design

Apply the shared conversation's design direction to the existing Vue/Tauri app. Keep the home/project hierarchy: shared concurrency timeline first, compact projects below, then a session explorer. Preserve measured time, attribution, navigation, and reported-work separation.

Use slate blue #7CAAD6, light blue #D3E6F8, orange #FF963D, and navy #142334. Retain accessible light and dark appearances, the system typeface, tabular time figures, and restrained surfaces. The timeline is the main visual element; supporting controls remain compact.

Show sessions, subagents, peak concurrency, cumulative agent time, human activity, and agent/human ratio. Explain that agent time sums overlapping executions, active elapsed time counts overlap once, and the execution window includes gaps. Derive parallelism from actual load segments, never illustrative reference numbers. Make zoom controls visible, reduce idle shading, and keep labels readable in narrow windows.

Keep desktop execution lists bounded, align the session list to its natural height, and preview five executions on mobile. A dialog/bottom sheet provides the complete list and execution details. Preserve keyboard navigation and dismissal.

Recreate the selected clock-with-three-branches concept as clean editable source geometry in slate blue with an orange middle branch. The downloadable production pack is inaccessible; do not present its generated preview board as a master icon. Generate app/sidebar/favicon and macOS/Tauri assets plus a monochrome tray mark from the new source. Exact raster/material reproduction is not claimed.

Validate calculation helpers with real-data unit tests, run the existing suite and build, inspect desktop/mobile light/dark layouts in Orca, and check native compilation and generated icon output. Preserve unrelated beta-feed and skill changes. No release, installation, or publishing is requested.
