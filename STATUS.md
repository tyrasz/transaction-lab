# Transaction Lab checkpoint — 0.7.0

Updated October 26, 2026. The long-term goal remains active. **No representative 90% accuracy rate or superiority to Blockaid has been established.**

The app runs at http://127.0.0.1:5174/ without a wallet connection or Dynamic authentication. Public RPC nodes execute EVM calls; the service owns interpretation, supported state measurements, validation and evidence retention. It never signs or broadcasts. Detailed coverage remains HyperEVM, configured Hyperlend USDC operations and configured token permissions. Security is `not_assessed`.

## What changed

Historical `affectedBalanceChanges` now queries balances for observed configured-token participants beyond the sender. Candidates come from verified Transfer execution and transferFrom owner/recipient arguments. Up to eight candidate pairs are accepted, including existing measured pairs. Reuse is proven through the shared query cache, exact amounts and execution identity. Event totals remain separate from measured values; unknown tokens, silent changes and native effects remain outside this view.

The browser joins those additional balances into Observed accounts. Original measurements and new measurements have distinct references in JSON. Shared balance, allowance and affected-account results are finalized after all consumers settle. Any canonical-block failure withholds all measured results and reused references. Unrelated query failures stay local. Current and historical contexts enforce bounded queries, requests and retained evidence; failed queries are cached without retries.

**Generic current-state affected balances remain unavailable.** The existing current Hyperlend adapter remains scoped to reconciled operations. Broader queries require traced before/after token and Pool implementation validation; returning a uint256 or checking a proxy storage slot alone is insufficient. [Scope review](reports/affected-balance-validation/CURRENT-SCOPE.md).

## Verified evidence

- The full local suite passed **330/330 tests** at this checkpoint, including recorded RPC playback, malformed evidence, resource limits, current-query scope rejection and shared canonical failures. This includes 24 evaluation-runner controls reviewed before live selection.
- The decoder benchmark passed **14/14 cases**: ten observed public traces and four synthetic controls. These remain development cases, not blind holdouts.
- A frozen reference packet contains **seven exact USDC balance pairs**, collected through **48 read-only RPC requests**. It uses a separate collection run and earlier frozen adapter; it shares provider and validation assumptions with the product and is not an independent execution engine. [Reference values](reports/affected-balance-validation/oracle.json), [raw evidence and notes](reports/affected-balance-validation/NOTES.md).
- **Eleven predeclared historical API requests** completed with HTTP 200 and affected-account measurements, using **402 RPC requests**, no retries or replacements. Seven also measured lending balances; eight measured allowances. Four cases have identical complete balance, allowance and affected-account results across both providers. [Full capture](reports/affected-balance-comparisons/capture.json), [manifest](reports/affected-balance-comparisons/manifest.json), [notes](reports/affected-balance-comparisons/NOTES.md).
- The direct-B transaction now has a consistent provider transaction list on its first new attempt. Its earlier inconsistent-index result remains preserved and tested as unavailable. The extra 19 requests explain the difference from the predicted 383 requests; no index validation was relaxed.
- The separate browser check shows two measured accounts for the historical direct transfer and agrees with the capture. [Displayed raw JSON](reports/live/historical-transfer-from-response-0.7.0.json), [separate validation summary](reports/affected-balance-comparisons/root-validation.json).

Frozen core source SHA-256: `7658ae0d03d6b17f72045905d231e9803b6ab38d57b4cac3a88d2eec19b5ff10`. Every v0.7 captured response has this identity. Earlier captures remain unchanged with their original source identity.

## Concrete result

The historical direct transfer spends 1.277067 USDC from owner `0xfc1bdd1ff58200761d56ccbce73f6f42ebe56379`, whose measured balance changes from 1.541542 to 0.264475 USDC. The submitting recipient gains exactly 1.277067 USDC. Owner, spender and submitter remain distinct; signing intent is unverified.

In the router example, the external sender goes from 50 to 25 USDC. The router receives and spends 25 USDC while its measured balance is zero both before and after. Three other accounts gain 24.812304, 0.000196 and 0.1875 USDC. These values now come from validated token queries as well as separate event evidence. An unknown token in the same transaction remains unmeasured.

## Next work and limits

The executable prospective evaluation runner passed its offline review before its first unfiltered run. Its protocol retains every selected future transaction in the denominator, seals product results before comparison, and distinguishes retrieval agreement, original-position replay, observed pair corroboration and incomplete all-effects coverage. No cohort has yet been selected under this protocol. [Evaluation protocol](research/coverage-evaluation/PLAN.md).

Next work validates current queries, evaluates broader transactions and expands supported assets and permissions. Native assets, general NFTs, arbitrary token behavior, other chains, independent execution, permit signature verification and broad threat detection remain incomplete or unsupported. Security research has one LI.FI development effects reference, zero security scoring cases and zero blind holdouts. No paid infrastructure, external publication or fund movement has occurred.
