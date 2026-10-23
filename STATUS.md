# Transaction Lab checkpoint — 0.3.0

Updated October 23, 2026. The long-term goal remains active. This checkpoint does not establish superiority to Blockaid.

The app runs locally at http://127.0.0.1:5174/ and requires no wallet connection or Dynamic authentication. It never signs or broadcasts transactions.

## Implemented and checked

- HyperEVM simulations pinned to a block hash, with request/trace identity validation and canonical-state checks.
- Historical execution by transaction hash, matching receipt/block/status/gas checks and receipt recheck.
- Hyperlend USDC supply, withdrawal, variable-rate borrow and repay interpretation with exact amounts, accrued-interest separation, deployed-implementation provenance and derived rounding bounds.
- Same-block before/after USDC, receipt-token and debt measurements for the supported operations. Reserve custody and non-transferable debt are labeled separately from user assets.
- Final allowance measurements for observed USDC/hUSDC permission pairs. Maximum, bounded, revoked and unchanged values are distinct; events and requests remain separate evidence.
- Shared lazy state reconstruction, bounded permission pairs, exact integer returns and fail-closed handling for unsupported state changes, malformed results, reorgs and inconsistent effects.
- Revert explanations, explicit HyperCore limits, raw downloadable JSON and an implementation source fingerprint.
- UI separates measured allowances, asset balances, debt, reserve custody and event evidence. Requested and actual lending amounts are distinct; inputs lock during requests and edits clear stale results.

## Evidence at this checkpoint

- **138/138 regression tests passed.** Includes full-withdrawal/full-repayment exactness, capped repayment, Mint during repayment, false approval returns, malformed evidence, event provenance, and state consistency. `reports/latest-tests.txt`.
- **14/14 recorded benchmark cases passed:** ten observed public RPC traces and four synthetic controls. These are development regression cases, not blind holdouts. `reports/latest-benchmark.json`.
- **12/12 live API cases passed:** current and historical supply/withdraw/borrow/repay, partial HyperCore replay, insufficient-balance supply, maximum allowance and revocation. [Full requests and responses](reports/live/2026-10-23T15-05-25-680Z.json).
- **7/7 same-block cases agreed across two public providers** at block 49,319,768: supply, failure, withdraw, borrow, repay, maximum allowance and revoke. [Comparison evidence](reports/comparisons/2026-10-23T15-05-25-866Z.json). Agreement does not establish engine independence or a performance ranking.
- **14 comparison-helper checks passed.** Browser checks verified debt separation, measured approval pairs, zero-to-zero no-op, requested/actual repayment, disabled inputs and clearing stale results.
- [Six allowance probes](reports/allowances/public-allowance-probes.json) and [three independently captured lending balance measurements](reports/lending-discovery/measured-current-balances.json) retain raw read-only RPC evidence.

Implementation source SHA-256: `db6184214fb90547f770d1297eb5b8f827532602f49a06f8d44a418240c80021`. The final live report's fingerprint matches the current source files.

## Concrete findings

At the captured current state, the historical 199.626280 USDC repayment request pays only **0.000002 USDC**, matching outstanding debt. The model uses the executed amount. Borrowed USDC is accompanied by a separate debt increase. Withdrawal and partial-repayment position deltas can differ from the cash amount by contract-defined rounding; those differences are preserved and verified against balance reads.

Three incident candidates have been researched with public transaction/receipt evidence. **Zero are admitted security benchmark cases and zero are blind holdouts.** [Intake plan](research/security-corpus/PLAN.md) separates attacker drains from earlier victim signing requests and excludes post-incident labels from hypothetical pre-sign features. General security remains `not_assessed`.

## Next work

1. Implement historical balance measurement at the original transaction position. Capability probes show `debug_traceCall` silently ignores `txIndex` on these providers; `debug_traceCallMany` with an explicit state context reproduced the three original lending operations and their before/after balances on both providers. Header probes require the original gas price to preserve BASEFEE. This remains capability evidence, not an API feature yet.
2. Expand exact affected-account and permission coverage, including permit/credit delegation, multi-call behavior and additional chains/protocols.
3. Admit independently reviewed security cases and legitimate controls, then build narrowly scoped detectors and measure abstentions, false positives and false negatives.
4. Establish broader independent-engine, availability and latency evaluations before making any comparative superiority claim.

Historical API replay still returns execution/event evidence only. Current measurements cover the listed tokens/accounts, not total portfolio value, fees, every permission, or future chain state. No paid infrastructure, external publication, signing or fund movement has been performed.
