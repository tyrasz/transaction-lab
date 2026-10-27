# Ordinary Ethereum coverage: next evidence plan

**Proposal only; not frozen or run.** Start with Ethereum mainnet (chain 1). Existing deposits, transfers, swaps and sequences are development evidence, not holdouts. The product's unsigned block-end profile has a code-free sender, fixed 5M gas, synthetic zero base fee and bounded explicit/discovered queries. It does not establish “90% of typical EVM transactions.”

## Freeze and prospective selection

Freeze implementation, comparator, classifier, endpoints, seed, budgets and claim definition. Observe only the latest header `H`; select **H+1 and H+2** before inspecting contents or outcomes. Check finality once, 20 minutes later, through two declared providers. Require both to have finalized these blocks and agree on complete headers, ancestry, ordered transaction hashes and envelopes. Independently bind header hashes. Disagreement, missing data or delayed finality remains a selection failure; no substitution or retries.

Seal every admitted transaction in population ledger `N`, including creations, unusual envelopes, coded senders and reverts. Rank by SHA-256 of frozen seed plus transaction hash; the first min(16, N) entries form the fixed sample `S`. Pilot limits: **16 slots, 384 RPCs/slot, 6,144 RPCs total, 512 MiB total/8 MiB per body, 25 seconds/RPC, 60 minutes total**, including selection and both execution paths. Narrower engine limits remain. Never accept truncated evidence. Entries outside `S` are `not_sampled`; unattempted selected slots are `budget_unattempted` and remain in `S`. Failed slots are not replaced. Report sampling fraction S/N separately from support within S. Two correlated blocks support descriptive counts only.

Frozen classification strata: transfer; approval/permit; swap; lending; vault/wrapper; other/unknown, with secondary mixed/router tags. Classify from independent envelope/receipt/trace evidence and a frozen deployment map, not successful product decoding. Unavailable classification remains unknown; strata never filter `N`.

## Two distinct execution questions

**First: block-end unsigned calls.** Project from/to/data/value at the declared parent hash; preserve the original envelope separately. Compare with local EthereumJS using independently verified proofs/code at that hash, never trace-derived initial state. Seal product outputs before comparison. Existing channels are status, return, committed logs, full observed changes and unsigned-profile gas—not full call-tree equality. Unsupported input remains a non-pass for population support. This does **not** reproduce the mined transaction.

**Original-transaction fidelity needs exact-position state.** Reconstruct preceding transactions and block transitions under the original header/envelope, or validate a position-aware provider against an independent equivalent reference. Fees, access lists, authorizations/blobs, lifecycle changes and fork rules need faithful support. Parent state is insufficient; receipts do not enumerate balances/permissions. Provider agreement is not independent execution or consensus proof.

## Report separate metrics

| Metric | Required reporting |
| --- | --- |
| Availability | Complete product executions / `S`; genuine EVM reverts count as completed execution, RPC errors do not. Unsupported, unavailable and selected-but-unattempted remain visible. Report S/N separately. |
| Execution agreement | Exact matched comparisons / `S`, plus matched / independently comparable cases with that denominator and all missing-reference reasons. An unavailable oracle is not a mismatch or a pass. |
| Wallet/economic effects | Exact matched token/account, allowance and native pairs against an independently derived inventory; separately report omissions, mismatches and unknown completeness. Positions retain user/market identity; wrapper holdings are not merged into wallet assets. |
| Operations | Success, revert and failure latency distributions separately; timeouts, RPC counts, bytes and costs. Declare cold/warm cache and concurrency. Never calculate latency only from fast successes. |

Event/call discovery and eight queries cannot prove inventory completeness. Silent tokens, NFTs, rebases, liabilities, fees and deferred effects need reference semantics. Shares/oracle units are not valuations. Report observed-pair agreement, **not all-effects accuracy**. Security detection requires a separate labeled evaluation.

## Practical gates and unresolved dependencies

1. Build the ledger, strict input projection and reference transport. Dependencies: reliable same-hash archival proofs/code, complete finalized lists, proven BLOCKHASH ancestry and isolated local execution. Retain uneven public-proof availability without fallback.
2. Run the small future pilot; publish every row and resource failure. Use failures to prioritize implementation. That cohort becomes development data after inspection.
3. Freeze a new version and larger future sample across time/block clusters. Preserve weights if oversampling strata. A 90% claim needs a named metric and appropriate one-sided 95% lower bound ≥90%, accounting for clustering and unavailable outcomes. Other chains, production latency and economic completeness require separate evidence.
