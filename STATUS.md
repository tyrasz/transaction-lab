# Transaction Lab checkpoint — 0.7.1

Updated October 26, 2026. The long-term goal remains active. **No representative 90% accuracy rate or superiority to Blockaid has been established.** This is a working prototype with narrow, measured coverage, not a general EVM simulation or security product.

The app runs at http://127.0.0.1:5174/ without a wallet connection or Dynamic authentication; its local health check confirms version 0.7.1. Public RPC nodes execute EVM calls; the service owns interpretation, supported state measurements, validation and evidence retention. Detailed coverage remains HyperEVM, configured Hyperlend USDC operations and configured token permissions. Security remains `not_assessed`. No signing or broadcasting occurs.

## What changed

Historical measurements now require the original transaction and its original-position replay to have equal complete returned pre/post state diffs. The comparison preserves absolute native balances, nonce transitions, storage values and missing-field distinctions. Matching call traces or matching balance deltas alone is insufficient. The new check requires one additional RPC; the shared context's 64-call limit is unchanged. Admitted measurements identify this check as `originalReplayState: complete_pre_post_diff_match`.

A separate 86-request diagnostic demonstrated why this matters. All ten provider/case observations matched the original trace and diff at the reported transaction index. At an earlier, wrong boundary, four still matched the strict trace but none matched the full diff. In those four cases, the fee recipient's absolute balances differed even though its fee delta agreed. This validates a rejection rule for these recorded cases; it does not establish a universal index offset or independent execution correctness. [Position diagnostic](reports/system-position-diagnostic/NOTES.md).

The strict token/Pool query validator is now a shared pure module. Generic current-state affected balances remain unavailable. A separate 126-request capability capture validated 28 configured-token queries and their nonce-only state changes at two known pinned states. It also showed that these unpriced calls expose **BASEFEE = 0**, differing from the real block. Current previews now state that gas-price fields are omitted and the execution header is unverified, replacing the unsupported claim that the header was unchanged. This research has not enabled broader current-state measurements. [Current-query evidence](reports/current-query-capability/NOTES.md).

The prospective evaluator now independently checks bound original/replay state diffs and nonce transitions. It continues to classify effective-gas-price reconstruction of typed transactions as incomplete, even when traces and reported diffs agree. Changes to its rules do not retroactively change the earlier failed pilot.

## Latest live evidence

Fourteen predeclared historical API requests ran once on the frozen 0.7.1 core, using **467 read-only RPC calls**, with no retries, replacements or transport errors. Thirteen produced supported measured results. One withheld measurements after a real within-run provider inconsistency. HTTP 200 means the request was handled; it is not an accuracy verdict. [Full raw capture](reports/replay-state-comparisons/capture.json), [findings and case table](reports/replay-state-comparisons/NOTES.md).

The unavailable direct-B case initially had five transactions in its block, with the target at index 2. The final query returned the same block hash with only three transactions and the target at index 0. The shared canonical check cleared allowance and affected-balance measurements and their execution identities. The empty arrays mean unavailable evidence, not zero effects. No retry or index adjustment was made. Its earlier successful and failed captures remain unchanged.

A separately planned, one-shot archive withdrawal control filled a regression fixture gap: **39 RPC calls**, measured lending/affected balances and an exact original/replay diff match. It is additional development coverage, excluded from the fourteen-request matrix. [Separate raw capture and notes](reports/replay-state-archive-withdraw/NOTES.md).

Together these are **15 selected replay requests, 14 with supported measurements and one withheld**. They repeat known operations/providers and cannot be converted into an EVM-wide success percentage. The captures total 506 RPC calls. Every successful measurement still depends on provider evidence and scoped adapter assumptions, rather than an independent execution engine or cryptographic state proof.

Frozen core source SHA-256: `1d7c3a202cc691729b0b31a6d1abf65fa32fb3a0d2b31c31e458240198b38b10`. All fifteen responses identify version 0.7.1 and this seventeen-file source inventory. Raw responses, request parameters, byte counts and hashes are retained. Offline verifiers and file manifests pass for all four new evidence packets.

## Regression evidence and earlier observations

The full local regression suite passes **373/373 tests**, with zero failures, cancellations or skips. It checks recorded RPC playback, malformed evidence, wrong replay positions, state-field presence, resource limits and canonical failures. The two supplemental hUSDC supply allowance tests explicitly combine hash-pinned older query recordings with new preparation evidence at the same block/index/envelope and equal original diff; they are offline composite regressions, not additional live runs.

The decoder benchmark passes **14/14 cases**, comprising ten observed traces and four synthetic controls. These are development examples, not blind holdouts or a broad accuracy sample.

The earlier seven-pair USDC reference packet remains unchanged. Its 48 RPC requests were a separate collection using an earlier frozen adapter, sharing provider/validation assumptions with the product. The earlier 0.7.0 eleven-request, 402-RPC API capture also remains unchanged with its original implementation identity. [Reference values](reports/affected-balance-validation/oracle.json), [previous API evidence](reports/affected-balance-comparisons/NOTES.md).

Known amounts are preserved: the direct-A owner's balance changes from 1.541542 to 0.264475 USDC, and its recipient gains 1.277067 USDC. In the router example, the sender loses 25 USDC, the router remains at zero before/after, and three other accounts gain 24.812304, 0.000196 and 0.1875 USDC. Events and measured balances remain separate. Unknown tokens remain unmeasured; these examples are not all-effects completeness claims.

## Broad evaluation and remaining work

The first unfiltered prospective pilot remains **selection_failed**: providers returned five versus eight transaction hashes for the same block. It retained nine RPC requests, accepted no cohort and attempted no transaction. Its denominator and accuracy metrics remain null. [Unchanged failed pilot](reports/coverage-evaluation/2026-10-26T04-23-53.888Z-c78b7336/NOTES.md), [frozen protocol](research/coverage-evaluation/PLAN.md).

A separate twelve-request diagnostic linked the three extra entries uniquely to official HyperCore system actions across twelve action fields. The subsequent position diagnostic showed both providers returning eight entries for that same block, whereas one had earlier returned five. Therefore response views can change; endpoint names cannot establish a permanent index convention. System correspondence, list position and replay boundary must remain distinct. [System-action evidence](reports/system-transaction-diagnostic/NOTES.md), [proposed enumeration and position rules](research/coverage-evaluation/SYSTEM-VIEWS.md).

Next work is to validate current query behavior before expanding it, implement explicit ordinary/system action enumeration, and evaluate broader unseen transactions without excluding unsupported cases. General native-asset effects, NFTs, arbitrary token behavior, other chains, independent execution, permit signature verification, system-action replay and broad threat detection remain incomplete or unsupported. Security research has one LI.FI development effects reference, zero security scoring cases and zero blind holdouts. No paid infrastructure, external publication or fund movement has occurred.
