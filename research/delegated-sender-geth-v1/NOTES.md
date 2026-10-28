# Existing delegation: independent-client fixture check

Pinned Geth 1.17.10 executed all **14** fixed synthetic fixtures once: **14 matched, zero mismatched, unavailable or unattempted**. Thirteen use Osaka and one uses the Prague activation boundary. Each supplied initial allocation, header context, transaction fields and offline signed bytes remained unchanged. The checks cover existing delegated senders, direct and self-calls, warm/cold implementation reads, successful/reverting creation, CREATE2 collision, callbacks, enclosing rollback, nonce/balance refusal and root deployment.

This packet compares **full poststate roots and Geth's internal log-hash assertions** against the frozen exported fixture expectations. It does not independently compare gas, return values or receipts. It explicitly does **not** establish the product-source provenance of the previously generated expectations. The exported product deltas/full-VM claims and generator are retained for inspection; source identity captured after their generation cannot prove which dependencies produced them. This is a synthetic fixture check, not a population accuracy rate or a current-product coverage denominator.

The initial 14-case preparation rejected one comparison because the exported full-VM error uses `revert` while the product uses `reverted`. The preparation classifier was corrected before any target execution; no fixture bytes changed. Independent pre-dispatch review also required strict timing metadata and input hashing. The updated seven controls passed, including missing/negative timing, exit-zero mismatches, foreign fork/name, malformed raw streams and altered input binding. All target processes then completed within their bounds. No retries, network requests, wallet interaction or real transaction signing occurred.

- Fixed fixture SHA-256: `7b5bf7a815934953951908002cac69c1b74ae5a3d7ddd0dfc652b65a1a40959a`
- Geth commit: `1df30b18d9ed35ee9d28ffd4648442c2204554ad`
- Binary SHA-256: `10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521`
- Evidence manifest SHA-256: `aa861c891ee5da6e17df280fda2a163ab392ebb89fa090c2e38c10c2e043c702`
- Target execution window: 636.513 ms; per-process cap 5 seconds, combined output cap 1 MiB, global dispatch cap 120 seconds.
- [Raw results](capture/results.json), [plan](capture/PLAN.json), [fixed expectations](fixtures.json).

The driver refuses to overwrite the completed capture. Preserve its bytes and source files; any later case or harness revision belongs to a new capture. The [independent supplemental audit](../delegated-sender-geth-v1-audit/NOTES.md) rechecked all 14 raw outcomes and rebuilt the initial MPTs, signed envelopes and exported-delta poststate roots without executing a VM. Its 12 tamper controls pass; root repeated verification and controls. Audit manifest SHA-256: `bbf59b04961d10244ae9eed8efedda4f74f08ecc72fa6554ba1c9b0bc41f89fe`. All 14 logs were empty; no nonempty log coverage is implied.
