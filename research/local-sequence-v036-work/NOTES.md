# Ordered local sequence development checkpoint

Updated October 31, 2026. Development work only; installed release 0.35 is unchanged.
This directory is an evolving work record, not a sealed comparison packet.

The new internal sequence and isolated-child entry points accept two to four
unsigned calls from one sender at one authenticated header. Originals share a
retained state manager and execute before disposable before/after queries.
They stop on the first non-success. Completed EVM failures retain transaction
preparation and fees; unavailable attempts must restore their preceding state.
All state changes remain relative to the immutable initial proof facts.

Parent validation now binds each original's starting overlay to the accepted
preceding result, validates cumulative state and fee/authorization context,
checks query snapshots, and accounts for shared execution/read budgets and
ordered input evidence. The startup envelope admits four maximum-sized calldata
inputs within a bounded 768 KiB sequence payload. Legacy payloads remain bounded.

Retained observations:

- `core-first.tap`: 9/9 core tests passed; synthetic token and 1:1 vault only.
- `core-rollback-strengthening.tap`: 2/2 affected rollback checks passed after
  requiring evidence that log opcodes executed before parent REVERT/OOG.
  These are strengthened checks of existing cases, not two new sample cases.
- `isolated-sequence-first.tap`: 15/15 actual-child/admission/protocol checks
  passed, including Osaka, priced Sepolia Amsterdam, failure preservation,
  missing proof rollback, shared return budget, and tampered result rejection.
- `legacy-isolated-first.tap`: 33/33 existing isolated call, preview, lifecycle
  and reset-preview regressions passed.

Additional retained development checks:

- `full-engine-first.tap`: 1,069/1,069 passed before the final shared-budget
  guards and deletion/nonce-prefix corrections.
- `full-engine-final.tap`: 1,086/1,086 passed after those changes (31.456 s).
- `shared-budget-first.tap`: 6/7 groups passed. The remaining failure was a
  test expectation: an early read limit leaves state unchanged, rather than
  rolling back a write that never happened. The corrected controls and existing
  isolated-sequence tests passed 22/22 in `shared-budget-final.tap`.
- `validator-lifecycle-sequence-final.tap`: 21/21 passed, including six actual
  retained-state execution groups and fifteen validation controls. These use
  the same EthereumJS engine and are not an independent reference comparison.
- `adapter-first.tap`: 11/11 passed for validation, per-step projection,
  canonical-header confirmation, cancellation, output bounds and withholding.
- `api-loader-first.tap`: 27/27 passed for the new route, actual isolated
  synthetic-proof execution, source inventory and loader integration. Additional
  response-boundary validation follows in separate logs.
- `ui-first.tap`: 48/49 passed; the failure was a legacy test that forced a
  disabled Sepolia sequence option and expected single-call dispatch. The
  corrected test requires no dispatch, then selects single mode explicitly.
  `ui-second.tap` passed 50/50; `ui-all-before-final-control.tap` passed 77/77;
  the final UI controls passed **78/78** in `ui-final.tap` (1.332 s).
- The final UI checks include one actual priced Sepolia adapter-to-isolated
  worker-to-UI flow using synthetic initial proofs. Approval, deposit, allowance,
  token/share and native fee measurements retain their own step baselines.
  Selecting another step preserves the complete sequence in raw JSON. The DOM
  harness tests behavior, not actual browser layout or a public deployment.
- `reference-driver-first.tap`: 12/13 passed; a source-boundary assertion used
  an obsolete variable name. `reference-driver-final.tap`: 14/14 passed after
  fixing that assertion and adding preparation-ledger and forced-termination
  controls. Inert temporary child programs verify stream caps and timeout/group
  cleanup; these controls never invoke either EVM.

Development now includes `POST /api/evm/local-sequence`, its source inventory,
and browser mode for Ethereum and Sepolia. Shared explicit queries are measured
around each step; each step can supply its own gas, fees, access list, blobs and
authorizations. No transaction is signed or broadcast by the product.

The final response-boundary controls passed **21/21** in
`response-boundary-fallback-final.tap`. Deadlines and cancellation remain active
through full serialization and persistence. Staged files are published only
after checks; cleanup fallback files always contain an unavailable response.
An operating-system failure of both removal and replacement is reported
explicitly. `timing.totalMsScope` excludes response serialization/persistence;
HTTP `Server-Timing` separately measures preparation through final validation,
excluding delivery. No force-cancellation of filesystem work is claimed.

`full-app-first.tap` retains **744/770**: 26 failures were three outdated test
source-inventory lists that omitted `src/local-sequence.js`. The lists were
corrected while preserving independent hashing, frozen recordings and all
semantic/integrity assertions. The affected replay checks passed 26/26 and
7/7. After the final cleanup-boundary fix, the complete application regression
passed **774/774** in `full-app-final.tap` (101.144 s). These tests use local
fixtures and temporary localhost servers, not new public-chain observations.

The candidate server on port 5175 passed health/configuration GET checks and
advertises local sequences for Ethereum and Sepolia. Browser checking was
initially blocked by the locked Mac; the subsequent editor-only check is
recorded below. Installed port 5174 remains unchanged.

The first independent four-sequence capture is preserved in
`../local-sequence-v036-reference/`; see its `NOTES.md`. Four product processes
ran, but all four EELS adapters failed before execution because of mixed
integer types in the funding check. The frozen comparator also rejected
nonce/balance-only product rows because it wrongly required `storage` arrays.
The result is **zero comparable positions and 72 unavailable channels**, not
an accuracy result. That first capture and its original comparison remain
unchanged.

The corrected sibling [v2 packet](../local-sequence-v036-reference-v2/NOTES.md)
ran the same four byte-identical synthetic inputs once per client. Its saved
`reference-v2-comparison.json` reports **10/10 mutually completed positions
matched, 60 matched channels, zero mismatches, and 12 null channels** for the
two declared positions that both clients left unattempted after
the preceding revert. All stop dispositions agree. Eight successful and two
reverted executions are comparable; stopped positions are not execution
matches. All eight outer processes were observed, with retained source,
closure and original-write checks; the execution-and-verification interval
was 8.400 seconds. Queries are retained but excluded from comparison.

V2 plan SHA256 is
`a1df7fb169e89826b0a27e4dd4e83796b5c0fb9dbafba48c7821676d5bf88da4`;
capture manifest is
`402045e7a4b5e69d51a7956e66fab4e6b0b71204b65430a310929db748e9f270`;
saved comparison SHA256 is
`1e17eddb695225216373230a839cee9dbe8616ff6fd28318d127df95254bb735`.
The independent bounded adapter review passed **21/21** input/artifact controls
without running either client. Its exact log is `reference-v2-peer-review.tap`,
with SHA256 `dd4d0b6386f35271227ff7019efec2cd56bbf6906c2d28544136cecdaa6d583a`
also retained in `reference-v2-peer-review.tap.sha256`.
The separate [saved-artifact audit](../local-sequence-v036-reference-v2/audit/NOTES.md)
passed without target execution. It checked both complete inventories and
process closure, rebuilt 28 allocation roots and 10 receipt/transaction trie
roots, checked signed envelopes and fee/nonce carry, and revalidated 44 proof
records using the shared archived proof validator. Its independently written
state reconstruction agrees with the frozen comparator. Shared crypto/parser
dependencies and the selected synthetic scope remain explicit.

The repeat corrects only Python typed-integer admission arithmetic and the
comparator's omitted-storage handling. It is not a new case population and
does not establish real Aave, Morpho or Hyperlend sequence coverage. The
reference uses stock EELS transaction transitions under the same declared
environment, not a cumulative consensus block test; proof revalidation shares
the production verifier. The old external Python runtime's drift and a fresh
current-runtime inventory are fully recorded; v2 uses the same inventory as
the first sequence attempt. No public-chain sequence capture or release has
occurred. Installed 0.35.0 remains unchanged. The Mac became available, and
`browser-editor-check.json` records actual Ethereum/Sepolia ordered-form,
advanced-control and four-call-limit checks at 1280 × 720, with no browser
console errors. Two screenshots were viewed in the conversation, not saved
as files. No simulation was dispatched; result-view and responsive checks
remain outside this browser observation.

These development checks do not change the public 16-call accuracy sample or
establish Aave/Morpho/Hyperlend category coverage or general EVM accuracy.
