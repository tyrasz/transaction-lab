# Ordinary Ethereum coverage: next evidence plan

**Proposal only; not frozen or run.** Start with Ethereum mainnet (chain 1). Existing deposits, transfers, swaps and sequences are development evidence, not holdouts. The product's unsigned block-end profile has a code-free sender, fixed 5M gas, synthetic zero base fee and bounded explicit/discovered queries. It does not establish “90% of typical EVM transactions.”

## Freeze and prospective selection

Freeze implementation, comparator, classifier, endpoints, seed, budgets and claim definition. Observe only the latest header `H`; select **H+1 and H+2** before inspecting contents or outcomes. Check finality once, 20 minutes later, through two declared providers. Require both to have finalized these blocks and agree on execution headers, contiguous ancestry from H through each fixed finalized tip (at most 256 headers/provider), ordered transaction hashes and normalized envelopes. Independently bind header hashes. Preserve provider body claims and originals; agreement does not prove transaction-trie completeness, signatures or consensus finality. Disagreement, missing data or delayed finality remains a selection failure; no substitution or retries.

Seal every admitted transaction in population ledger `N`, including creations, unusual envelopes, coded senders and reverts. Rank by SHA-256 of frozen seed plus transaction hash; the first min(16, N) entries form the fixed sample `S`. Pilot limits: **16 slots, 384 RPCs/slot, 6,144 RPCs total, 512 MiB total/8 MiB per body, 25 seconds/RPC, 60 minutes total**, including selection and both execution paths. Narrower engine limits remain. Never accept truncated evidence. Entries outside `S` are `not_sampled`; unattempted selected slots are `budget_unattempted` and remain in `S`. Failed slots are not replaced. Report sampling fraction S/N separately from support within S. Two correlated blocks support descriptive counts only.

Frozen classification strata: transfer; approval/permit; swap; lending; vault/wrapper; other/unknown, with secondary mixed/router tags. Classify from independent envelope/receipt/trace evidence and a frozen deployment map, not successful product decoding. Unavailable classification remains unknown; strata never filter `N`.

## Two distinct execution questions

**First: block-end unsigned calls.** Project from/to/data/value at the declared parent hash; preserve the original envelope separately. Compare with local EthereumJS using independently verified proofs/code at that hash, never trace-derived initial state. Seal product outputs before comparison. Existing channels are status, return, committed logs, full observed changes and unsigned-profile gas—not full call-tree equality. Unsupported input remains a non-pass for population support. This does **not** reproduce the mined transaction.

**Original-transaction fidelity needs exact-position state.** Reconstruct preceding transactions and block transitions under the original header/envelope, or validate a position-aware provider against an independent equivalent reference. Fees, access lists, authorizations/blobs, lifecycle changes and fork rules need faithful support. Parent state is insufficient; receipts do not enumerate balances/permissions. Provider agreement is not independent execution or consensus proof.

## Report separate metrics

| Metric | Required reporting |
| --- | --- |
| Availability | Complete product executions / `S`; genuine EVM reverts and recognized EVM faults count as completed execution, RPC errors do not. Unsupported, unavailable and selected-but-unattempted remain visible. Report S/N separately. |
| Execution agreement | Exact matched comparisons / `S`, plus matched / independently comparable cases with that denominator and all missing-reference reasons. An unavailable oracle is not a mismatch or a pass. |
| Wallet/economic effects | Exact matched token/account, allowance and native pairs against an independently derived inventory; separately report omissions, mismatches and unknown completeness. Positions retain user/market identity; wrapper holdings are not merged into wallet assets. |
| Operations | Success, revert and failure latency distributions separately; timeouts, RPC counts, bytes and costs. Declare cold/warm cache and concurrency. Never calculate latency only from fast successes. |

Event/call discovery and eight queries cannot prove inventory completeness. Silent tokens, NFTs, rebases, liabilities, fees and deferred effects need reference semantics. Shares/oracle units are not valuations. Report observed-pair agreement, **not all-effects accuracy**. Security detection requires a separate labeled evaluation.

## Practical gates and unresolved dependencies

1. Build the ledger, strict input projection and reference transport. Dependencies: reliable same-hash archival proofs/code, complete finalized lists, proven BLOCKHASH ancestry and isolated local execution. Retain uneven public-proof availability without fallback.
2. Run the small future pilot; publish every row and resource failure. Use failures to prioritize implementation. That cohort becomes development data after inspection.
3. Freeze a new version and larger future sample across time/block clusters. Preserve weights if oversampling strata. A 90% claim needs a named metric and appropriate one-sided 95% lower bound ≥90%, accounting for clustering and unavailable outcomes. Other chains, production latency and economic completeness require separate evidence.

## Implemented offline prerequisites

[`cohort-accounting.mjs`](cohort-accounting.mjs) now provides `createCohortSelection({chainId:1,census,seed,sampleSize})` and `accountCohortOutcomes(selection,outcomes)`. Census rows contain transaction hash, block hash, and canonical decimal block number/index. The 32-byte seed and transaction-hash bytes determine rank; returned selections are immutable, canonically ordered and hashed. Accounting rederives the selection and requires exactly one outcome for every selected transaction. It rejects missing, duplicate, foreign or incompatible outcomes, retains unselected census rows, and separates execution availability from matched, mismatched and unknown comparisons. Empty denominators produce null fractions.

Completed execution includes separately named `success`, `reverted` and `failed` outcomes. The accounting module has twelve offline controls. Its generic helper permits up to 100,000 census/sample entries; the census validator narrows the proposed pilot to 16 slots.

[`cohort-census.mjs`](cohort-census.mjs) validates two recorded provider observations, header commitments, contiguous ancestry, exact target ordering and envelope agreement. It retains every admitted target transaction. Creations, access-list/blob/authorization contexts, unknown types/fields and oversized requests remain present with unsupported projection reasons. Selected calls carry the primary provider's exact parent header, converting only full transaction objects to ordered hashes. Empty transaction lists must agree with the committed empty trie root, but nonempty tries are not reconstructed. Timestamps are caller claims; general body completeness, senders, finality and predeclaration chronology are not authenticated. Fifteen offline controls pass.

[`cohort-outcomes.mjs`](cohort-outcomes.mjs) binds concrete expected implementation identities, projected input, raw provider wire and local input/execution context before comparing status, return bytes, committed logs, full observed changes and unsigned gas. Missing reference inputs remain unavailable. Genuine REVERT differs from other recognized EVM faults and provider errors. A missing original revert diff cannot pass the full-state channel. Eighteen controls include the two archived lending workloads; they add no new transaction observations. The future runner must bind actual source and artifact hashes; matching identity labels alone does not authenticate them. Economic completeness and security are separate evaluations.

[`cohort-wire.mjs`](cohort-wire.mjs) supplies fixed dRPC/PublicNode endpoints, read-only census/local/product profiles, shared call/byte/time budgets and exact request/response capture, including error bodies. It uses the frozen `captureHttp` from the previous lending packet, which must be included in the future source archive. Product parsing receives the captured complete bytes through its existing transport. Local reads accept only same-hash canonical proof/code requests. The default save hook retains records in memory; the runner must supply durable recording. Eighteen controls cover budgets, cancellation, no retry/fallback, shared save failures and product error-body preservation. These are fetched entity-byte limits, not TCP or process-memory limits.

[`executeIsolatedEthereumCall`](../../engines/local-evm/isolated-call.js) runs the reference in a fixed Node child, with parent-brokered hash-bound proof/code reads, a 145-second process deadline, V8 old-space ceiling, bounded IPC and cancellation/drain. Its 17 controls include an exact replay of the archived one-unit USDC execution, real worker termination, rollback and late replies. It does not provide an OS filesystem/network sandbox, a hard total-RSS cap or runtime source authentication. Missing authenticated in-range BLOCKHASH ancestry remains unsupported.

Run `node --test research/standard-evm/cohort-*.test.mjs` for the 63 cohort controls, and `npm --prefix engines/local-evm test` for the 139 local-engine controls. No new public RPC, future block selection or pilot freeze has occurred for these components. Collector, source freeze, classification and end-to-end evidence integration remain unfinished; this checkpoint produces no live coverage score.
