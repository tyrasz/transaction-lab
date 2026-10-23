# Transaction Lab checkpoint — 0.4.0

Updated October 23, 2026. The long-term goal remains active. This checkpoint does not establish superiority to Blockaid.

The app runs locally at http://127.0.0.1:5174/ and requires no wallet connection or Dynamic authentication. It never signs or broadcasts transactions.

## Implemented and checked

- HyperEVM simulations pinned to a block hash, with request/trace identity validation and canonical-state checks.
- Historical execution by transaction hash, matching receipt/block/status/gas checks and receipt recheck.
- Hyperlend USDC supply, withdrawal, variable-rate borrow and repay interpretation with exact amounts, accrued-interest separation, deployed-implementation provenance and derived rounding bounds.
- Current-state before/after USDC, receipt-token and debt measurements for supported operations. Reserve custody and non-transferable debt are labeled separately from user assets.
- **Historical balances at the original transaction position.** Independent single-call queries before and after the original transaction validate block headers, query implementations, sender nonce and exact native fee effects. A separate original-call replay must match the recorded execution. No probes are inserted into the original execution sequence.
- Final current-state allowance measurements for observed USDC/hUSDC permission pairs. Maximum, bounded, revoked and unchanged values are distinct. Historical allowances remain unmeasured.
- Bounded, lazy state contexts and fail-closed handling for unsupported state changes, malformed results, ignored indexes, reorgs and inconsistent effects. Deposit reconciliation checks all measured sender/beneficiary balances, including expected zero deltas.
- Provider error envelopes are sanitized before raw-result retention, including nested tracing errors. Genuine EVM failure strings and return data remain execution evidence.
- UI separates historical measurements, current simulation, debt, reserve custody, event evidence and unmeasured permissions. Raw downloadable JSON includes the implementation source fingerprint and measurement context.

## Evidence at this checkpoint

- **185/185 regression tests passed.** Includes seven full recorded historical replay sequences, the recorded archive failure, canonical-change controls, nested-error retention and six saved live reader sequences. `reports/latest-tests.txt`.
- **14/14 recorded benchmark cases passed:** ten observed public RPC traces and four synthetic controls. Development regression cases, not blind holdouts. `reports/latest-benchmark.json`.
- **12/12 live API cases passed:** current and historical supply/withdraw/borrow/repay, partial HyperCore replay, insufficient-balance supply, maximum allowance and revocation. Historical cases now require measured original-position balances. [Full requests and responses](reports/live/2026-10-23T15-35-55-289Z.json).
- **7/7 current-state cases agreed across two public providers** at block 49,321,677. [Comparison evidence](reports/comparisons/2026-10-23T15-36-44-315Z.json). Agreement does not establish engine independence or a performance ranking.
- **7/8 historical HTTP requests returned measured balances; 3/4 provider pairs matched, 1 incomplete.** The archive provider returned upstream HTTP 503 for the withdrawal receipt; the API returned HTTP 502 and no retry was performed. There were zero measured disagreements. [Full HTTP/RPC evidence](reports/historical-comparisons/2026-10-23T15-35-35-718Z-http.json), [notes](reports/historical-comparisons/2026-10-23T15-35-35-718Z-notes.md). All 230 RPC attempts are retained. An earlier harness-input failure is also retained and made zero public RPC calls.
- [Six live reader checks](reports/historical-state/module-validation.json) and their [validation notes](reports/historical-state/module-validation-notes.md) cover independently priced query calls and exact nonce/fee checks.
- Browser verification confirmed original repayment amount, transaction indexes 12 → 13, original block time/hash, historical balances and matching raw JSON. [Standalone response shown in the browser](reports/live/historical-repayment-response-0.4.0.json).

Implementation source SHA-256: `d82b3cc095e5f7d168fd9f530fd056b035f723f8fb510e0e14ee48fed2e778f0`. The final live and historical comparison reports match these source files.

## Concrete findings

The historical repayment spent **199.626280 USDC**. Debt went from **199.626281 to 0.000002**, a reduction of **199.626279**. The one raw-unit difference is preserved and reconciled against contract rounding. Re-running the request against the captured current state instead pays only **0.000002 USDC**, matching remaining debt; this is a separate current-state simulation.

The historical deposit spent **15.066115 USDC** and increased hUSDC from **5718.512299 to 5733.578413**, a measured increase of **15.066114**. This agrees with event-implied principal after accrued interest is removed. Neither the mint event total nor the cash amount is substituted for measured receipt-token balance change.

Three incident candidates have public transaction/receipt research. **Zero are admitted security benchmark cases and zero are blind holdouts.** [Intake plan](research/security-corpus/PLAN.md) separates attacker drains from earlier victim signing requests and excludes post-incident labels from hypothetical pre-sign features. General security remains `not_assessed`.

## Next work

1. Expand affected-account and permission coverage, including permits, credit delegation and multicalls. Validate historical allowance queries separately from balance queries.
2. Admit independently reviewed security cases and legitimate controls, then build narrowly scoped detectors and measure abstentions, false positives and false negatives.
3. Expand chains/protocols only with chain-specific state and replay validation.
4. Establish broader independent-engine, availability and latency evaluations before comparative superiority claims. The retained archive failure is a reliability observation, not a passing case.

Measurements cover the listed tokens/accounts, not total portfolio value, every fee or permission, or future chain state. Unknown implementations and unsupported transaction envelopes return unavailable measurements. No paid infrastructure, external publication, signing or fund movement has been performed.
