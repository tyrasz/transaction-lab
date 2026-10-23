# Transaction Lab checkpoint — 0.2.0

Updated October 23, 2026. The long-term goal remains active. This checkpoint does not establish superiority to Blockaid.

The app runs locally at http://127.0.0.1:5174/ and requires no wallet connection or Dynamic authentication. It never signs or broadcasts transactions.

## Implemented and checked

- HyperEVM simulations pinned to an explicit block hash, with strict request/trace identity validation.
- Historical execution by transaction hash, matching receipt/block/status/gas checks and receipt recheck.
- Hyperlend USDC supply interpretation with exact integer amounts, separate deposit principal and accrued interest, and verified scaled-token rounding bounds.
- Before/after USDC and hUSDC balances measured through a prestate diff and ephemeral balanceOf reads at the same block and timestamp.
- Scoped approval/revocation observations for configured USDC/hUSDC, including maximum allowances, request/event correlation, false returns, reverted subcalls and unverified signatures.
- Contract-reported revert decoding, explicit HyperCore limitations, raw downloadable JSON and implementation source fingerprints.
- UI clears stale results after input changes and locks inputs during requests.

## Evidence at this checkpoint

- **82/82 regression tests passed**, including malformed data, exact arithmetic, failed calls, credential-safe errors and state consistency. Local output: `reports/latest-tests.txt`.
- **8/8 recorded benchmark cases passed**: four observed public RPC traces and four explicitly synthetic controls. `reports/latest-benchmark.json`.
- **6/6 live API cases passed**: current supply with measured balances; historical supply; partial HyperCore replay; insufficient balance; maximum approval; revocation. Full requests/responses: [live report](reports/live/2026-10-23T14-42-03-283Z.json).
- **2/2 same-block cases agreed across two public providers**: successful supply and insufficient-balance failure. Exact balances, events, gas, principal and rounding matched at block 49317727. [Comparison evidence](reports/comparisons/2026-10-23T14-31-58-945Z.json). Providers may share an execution engine; these two samples are not a performance ranking.
- Comparison-helper checks: **10/10 passed**. Browser verification covered deposit balances, permission findings, disabled inputs during requests and clearing a previous preview after an edit.

## Next concrete work

1. Verify final allowance state with before/after reads, including already-maximal allowances and multiple approval changes in one transaction.
2. Expand lending coverage to withdrawals, repayments and borrowing, using observed successful and failed transactions plus independent state comparisons.
3. Add historical balance measurement at the transaction's original position, preserving block context and earlier transactions in that block.
4. Build a held-out security corpus with independently sourced labels; measure false positives and false negatives before introducing broader risk verdicts.
5. Expand provider disagreement handling, performance measurements, operational limits and supported protocols.

General security remains `not_assessed`. Approval observations do not verify spender reputation or final allowance. Current balance measurements cover only the configured USDC/hUSDC supply adapter; historical replay does not yet return position-specific balance deltas.

No paid infrastructure, external publication, signing or fund movement has been performed.
