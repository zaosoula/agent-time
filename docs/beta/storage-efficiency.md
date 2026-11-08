# Lossless storage efficiency

The efficient history format keeps every original event ID, timestamp, payload byte and insertion position. Completed tool starts/ends share a physical record while both logical boundaries remain readable. Ambiguous, unmatched and cross-block calls retain separate records. Timing reducers are unchanged.

## Measurements

A private consistent snapshot contained 1,284,388 events. Its verified copy retained all events and matched ordered payload, insertion-order and non-storage-table hashes before and after VACUUM. At the same fixed clock, the previous beta and the new reader produced identical daily summaries/review state for November 2–8, weekly review, MCP snapshot and coverage.

| Measurement | Previous | Efficient format |
| --- | ---: | ---: |
| Database bytes | 1,061,752,832 | 435,736,576 |
| Event payload bytes | 695,470,339 raw | 69,894,722 compressed |
| Retained JavaScript heap after replay | 179,117,608 | 46,399,888 |

The copy completed in 170 seconds with `--max-old-space-size=128`; measured peak RSS was 330,000 KiB. The codec produced 628 blocks, including 97,796 shared tool-call records, 41,511 activity records and 2,413 worker records. A separate regression reads 120 MB of logical payload with a 64 MiB JavaScript heap.

**Memory limit:** this proves lower retained JavaScript heap and bounded compaction, not lower total memory for every read workload. The full seven-day/weekly/MCP replay peaked at 951,648 KiB RSS versus 719,088 KiB for the previous reader. Native allocations and the requested result window remain material. This RSS regression must remain visible when assessing rollout; do not advertise universally lower application RAM.

## Default limits and recovery

- Raw recent payload: seven days or 128 MiB. Each background pass handles at most 20,480 rows / 16 MiB; blocks contain at most 2,048 events / 2 MiB original payload.
- Decoder cache: 16 MiB per connection; SQLite page cache: 8 MiB; summary cache: 32 MiB / 16 days. One oversized requested day can stand alone.
- Managed storage: 5,120 MiB, configurable in Data & backup. Capture pauses if care cannot keep it within the budget or preserve 1 GiB free disk. Unique history is never silently expired. Unlimited unique input cannot fit a fixed disk budget forever.
- New hook/report spool: 64 KiB per record / 4,096 pending entries plus concurrent writes. A fixed marker records overflow as missing evidence. Reconnect active agent processes after upgrade so they use the new producer limits.
- Archives compress through a verified private temporary copy. Manual, unclassified, unique and unverified backups are protected. Only verified redundant automatic rollbacks can expire beyond the two-copy / 512 MiB target; the newest stays recoverable.

Existing databases upgrade through a verified replacement on next launch, keeping the prior database as a rollback archive. Format 0/1 remains readable by the new app. Older app/MCP readers cannot read format 2: restart/reconnect agent tools after optimization. To use an older app, restore the pre-upgrade archive; decompressing it restores the exact original SQLite bytes.

## Implementation decisions and costs

- A content-addressed generated payload keeps existing logical SQL compatible. Cost: a new reader requirement and one-time reconnect.
- An explicit `rowid` preserves VACUUM order and existing consumers. Storage-only settings create no timing fence.
- The new copy path is lossless; the older explicit pruning utility remains. This permits streaming hash verification instead of retaining whole-history timing reducers.
- Packing follows insertion order and pairs only inside a block. Cost: less compression for calls crossing block boundaries; it avoids repeated large-block decoding.
- Garbage collection and sparse-block repacking run in offline verified-copy/pruning paths. Cost: unsupported external SQL deletes do not reclaim blocks during normal live care.
- Archive care runs daily and under quota pressure; packing runs each minute. Cost: existing plain exports can wait a day for compression. New exports compress immediately.
- Import, comparisons and logical checks stream rows; prepared decoder statements are reused. Metadata-only indexes avoid payload decoding during counts, coverage and runtime probes. Cost: additional stored metadata/index space and per-row calls.
- Structural SQLite checking temporarily skips the virtual payload on its private synchronous connection, with a guaranteed reset. A separate bounded pass checks every payload and stored metadata. Cost: another streaming verification pass.
- The virtual column passes its 36-byte locator as hex to avoid per-callback SQLite ArrayBuffer allocations. On-disk references remain 36 bytes; both decoder argument forms are accepted.

The UI host was unavailable during this run; compilation and API tests verify the storage controls, but a visual native screenshot is not claimed. Private databases and raw replay results are excluded from the repository.
