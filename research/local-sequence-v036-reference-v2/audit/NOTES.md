# V2 saved-artifact audit

Result: **pass**, with no target, VM, reference-process, or network execution. The first evaluation passed; its stdout and empty stderr are retained. Only this new audit directory was written.

The externally supplied V2 plan and manifest pins matched. All 3,988 capture entries, the 3,987-entry original-write ledger, 3,911 runtime entries, and 5,080 external toolchain entries validated. All eight recorded processes completed and closed, with empty stderr and 856,555 total raw bytes. The execution-and-verification interval was 8,400 ms wall / 8,400.086 ms monotonic; this does not claim a bound on preparation or final serialization.

The archived saved-only comparator reproduced the retained comparison exactly. Separate audit code reapplied each cumulative product delta against immutable initial allocation, compared full reference allocations, and rebuilt 28 allocation roots (8 initial/original plus 20 product/reference postroots). It checked 12 signed envelopes and recovered senders, 10 typed receipts and transaction/receipt trie roots, all log payloads and blooms, and nonce/fee carry. The 44 saved proof records were revalidated by the shared archived production proof validator.

All 10 mutually executed positions matched six channels: execution status, return data, charged gas, committed logs, full state root, and single-transaction block gas. Eight were successful and two reverted. Both declared calls after a revert remained `not_attempted`, with all 12 channel values null. This is **60 matched, 0 mismatched, 12 unavailable channels**, not 12 executed successes.

The first packet was rehashed in full and remains unchanged: four product processes observed, four EELS processes unavailable due to the typed-integer adapter error, and its original comparator retained 72 null channels. All four V2 input files are byte-identical to their first-packet inputs; 3,893 engine/runtime entries are unchanged. This is a corrected repeat of the same four selected synthetic sequences, not four additional coverage cases.

## Limits

- Synthetic token/vault fixtures only; no Aave, Morpho, public-chain, or broad EVM accuracy claim.
- Reference execution is unmodified pinned EELS. This audit rechecks saved evidence; it does not execute another EVM.
- Canonical comparison and proof validation share archived code. Independent audit logic still uses the archived RLP, Keccak, secp256k1 and MPT libraries.
- Unsigned product calls are compared with signed type-2 reference transactions. Each reference step starts a fresh single-transaction context with only the preceding EELS allocation and the same synthetic header; this is not cumulative block validation or consensus authentication.
- Disposable queries and separate measured-native-balance channels are excluded. Full state roots include native fee effects.
- All-product-before-EELS ordering is bound to frozen driver control flow and saved row order, without independently trusted timestamps.
- The explicitly inventoried Python runtime differs from older storage-creation captures, as recorded in the packet's retained drift report.

## Reproduction

From the repository root, run `node research/local-sequence-v036-reference-v2/audit/review.mjs`. It performs saved-artifact checks only and emits the report to stdout. The frozen runtime and external toolchain must remain available at their recorded locations.

Pins and detailed rows are in `report.json`; `manifest.json` binds this audit's source, report, notes and retained first-evaluation output. The capture and earlier comparison are not modified.
