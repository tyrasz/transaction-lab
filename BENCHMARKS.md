# Evidence and benchmarks

This project is an early transaction-preview implementation. Its benchmark reports whether a small, reviewed regression corpus is interpreted correctly. The cases were used while developing the adapters; this is not blind or held-out evaluation. It is not a score against Blockaid or a claim of equivalent security coverage.

Run `npm run benchmark` from this directory. The command reads saved fixtures, writes `reports/latest-benchmark.json`, prints case counts and exits nonzero if any case fails. It does not contact an RPC or Dynamic. `npm test` also verifies that analyzer failures produce a failing persisted report.

## Corpus

| Fixture | Evidence type | What it checks |
|---|---|---|
| Hyperlend USDC supply | Recorded public `debug_traceCall` | 15.066115 USDC principal; 15.066912 hUSDC mint; 0.000797 accrued interest; exact decimal formatting |
| Historical Hyperlend USDC supply | Recorded public `debug_traceTransaction` | 15.066115 USDC principal; 15.066497 hUSDC mint; 0.000383 interest; a -0.000001 difference between mint-event implied principal and deposit, consistent with the verified scaled-token rounding interval |
| Excessive Hyperlend supply | Recorded public `debug_traceCall` | Real insufficient-USDC-balance revert; contract-provided Error(string) decoded; no successful asset movements |
| Historical + current Hyperlend withdrawal (2 fixtures) | Recorded public transaction trace and later unsigned call trace | 503.900226 USDC received; historical/current hUSDC Burn values differ with accrued interest, while the implied position change is -503.900226 |
| Historical + current Hyperlend borrow (2 fixtures) | Recorded public transaction trace and later unsigned call trace | 835.474410 USDC received; separate variable debt increase; historical debt Mint includes 0.001738 interest; debt excluded from spendable assets |
| Historical + current Hyperlend repay (2 fixtures) | Recorded public transaction trace and later unsigned call trace | Historical payment 199.626280 USDC, implied debt change -199.626279; later request for the same amount executes only 0.000002 USDC, capped by debt |
| CoreWriter Perps → Spot | Recorded public `debug_traceTransaction` | Historical EVM execution succeeds; HyperCore coverage remains partial; no invented ERC-20 asset movement |
| Root revert | Hand-constructed negative control | A reverted transaction contributes no successful token movements |
| Caught child revert | Hand-constructed negative control | Reverted child logs are excluded while a successful sibling transfer remains |
| Unknown successful call | Hand-constructed coverage control | Success without a known interpretation is not promoted to full support |
| Very large token amount | Hand-constructed precision control | Integers larger than JavaScript's safe Number range retain exact raw and decimal values |

The ten observed fixtures were copied from the public RPC evidence already collected for this project. Each records the original artifact name, SHA-256, capture time, endpoint or provider, and exact RPC request. Only public chain data and the supplied transaction bodies are retained. The Dynamic reference omits authentication headers and the environment identifier. Synthetic fixtures explicitly set `isRealTransaction: false`; they must never be described as live transactions.

The historical Hyperlend deposit and insufficient-balance cases come from `reports/live/2026-10-23T14-21-41-661Z.json`. Their fixture inputs contain the captured raw trace, not the analyzer interpretation saved in that report; expectations were reviewed against the raw event fields and revert bytes. Their source result IDs, whole-artifact hashes and canonical trace JSON hashes identify the evidence. The excessive-supply case is an actual read-only RPC simulation of a deliberately large amount. It is not an executed onchain transaction and was never signed or broadcast. Both fixtures have recorded block identities.

The six lending cases come from `reports/lending-discovery/{withdraw,borrow,repay}-evidence.json`, with their independently decoded event words in the matching `*-decoded.json` files. Each fixture preserves both file hashes, the canonical trace hash, original RPC request, exact state block and whether it is an executed historical transaction or a later unsigned simulation. The current traces share block **49,318,777**, hash `0x206b1f6b56dced1f90f742384ad84d74973a02d8bee8c07a823f394d1506a5a2`. Expectations were transcribed from raw calldata, Pool events and position Mint/Burn words, not copied from the analyzer output. Tests verify source integrity and ensure that requested/actual amount confusion or debt included in either spendable asset list causes failure.

The separate `reports/lending-discovery/measured-current-balances.json` artifact records live prestate-diff and hash-bound before/after balance queries for those same three simulations. Its captured RPC responses are replayed by the lending-balance tests. The offline trace benchmark itself does not run the state measurement module or claim its event-derived position values are fresh balance queries.

Historical rounding is checked against the deployed hToken implementation and traced scaled mint input. The analyzer distinguishes the 15.066115 USDC deposited from the 15.066114 principal implied by Mint.value minus interest. The latter lies inside the mathematically derived floor/ceil interval. This confirms consistency with the model; it is not an independently measured token balance delta. Revert text is attributed to contract return data rather than presented as an independent diagnosis.

The original Hyperlend request used `latest` without recording a block number or hash. Its fixture therefore has `block: null`, rather than borrowing the block of the original deposit. The CoreWriter trace is bound to transaction `0xe4b9861a0fcda1cfda2414178b80e8646b2d9d24e6f01222cc8ad81b2ba65b36`, block 19185860. It did not enable callTracer logs. Its separate historical HyperCore ledger confirmation is not input to the EVM analyzer.

## Limited Dynamic comparison

A saved Dynamic response reports the same 15.066115 USDC outgoing principal. It reports 15.066781 incoming hUSDC; the independent RPC trace reports 15.066912. The requests were captured at different times without a shared recorded block. Accrued interest changes with state, so this difference is not an accuracy verdict.

The comparison preserves raw token amounts and the returned display strings. Our output formats integers exactly. Dynamic's saved decimal strings contain floating-point artifacts while its `rawValue` fields still encode exact amounts.

Dynamic's saved security verdict is `Benign`. This project returns `security.status: not_assessed`. The benchmark does not rank these classifications or substitute execution success for a safety decision. The public Dynamic response also does not establish the complete underlying Blockaid request or configuration.

## What passing means

A passing result means the analyzer satisfies the specific assertions in these fixtures. It says nothing about malicious-contract detection, unrelated protocols, chain coverage, live RPC availability, pricing, balance-state correctness, or latency under load. The corpus is small and partly synthetic. Adding more fixtures that resemble existing successful examples does not by itself establish generality.

## Additional historical balance evidence

Version 0.7 adds a separate state-measurement development check; it does not enlarge the fourteen-case decoder benchmark or turn it into an accuracy estimate. The [frozen reference packet](reports/affected-balance-validation/oracle.json) contains seven USDC before/after pairs from direct token reads at the exact original transaction positions: five router participants and two direct-transfer participants. Its 48 RPC calls use the earlier frozen validation adapter. These are separately queried values, not event arithmetic, but they share the provider and adapter assumptions with the product; they are not an independent EVM implementation.

The [predeclared eleven-run HTTP capture](reports/affected-balance-comparisons/capture.json) exercises seven historical transactions without retries or replacements. All eleven returned supported affected-account measurements. Seven also returned lending balances, and eight returned final allowances. Four transaction/provider pairs have identical complete balance, allowance and additional-account results. The previously observed direct-B index inconsistency was absent on its first new attempt, so that result now includes state measurements; the old unavailable observation remains retained and tested. See [capture notes](reports/affected-balance-comparisons/NOTES.md) and [separate validation summary](reports/affected-balance-comparisons/root-validation.json).

These hand-selected development cases do not establish transaction-wide completeness, security accuracy, or a 90% result. Unknown tokens, silent changes, native assets and unsupported mechanisms remain outside their measured-pair scope. The [prospective evaluation protocol](research/coverage-evaluation/PLAN.md) defines a separate unfiltered future cohort with all selected transactions retained in its denominator.

Next evidence should include independently labeled failures, supply on behalf of another account, allowance changes, fee-on-transfer and rebasing tokens, unusual proxy behavior, omitted trace logs, missing metadata, chain reorganizations, and provider disagreements. Same-block comparisons should use block-bound input and independently measured pre/post state. New protocol cases belong in a held-out corpus before being used to tune decoders.
