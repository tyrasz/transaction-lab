# Transaction Lab checkpoint — 0.6.0

Updated October 26, 2026. The long-term goal remains active. This checkpoint does not establish 90% accuracy across EVM transactions or superiority to Blockaid.

The app runs locally at http://127.0.0.1:5174/ without a wallet connection or Dynamic authentication. It never signs or broadcasts transactions. Public RPC nodes perform EVM execution; this service owns the interpretation, supported state measurements, consistency checks and retained evidence. Current detailed coverage is HyperEVM chain 999, configured Hyperlend USDC operations and configured USDC/hUSDC permissions. General security remains `not_assessed`.

## Added in this checkpoint

- Implementation-verified `transferFrom` observations distinguish the token owner, immediate spender, recipient and external transaction submitter. Strict ABI, proxy execution and return evidence are checked. Requested transfer amounts are never treated as requested allowances; successful calls do not establish signing intent or spender trustworthiness.
- Final allowances can now be measured for exercised owner/spender pairs even when no new approve, permit or Approval event occurs. A zero overall allowance delta does not imply no intermediate grant or spending.
- `accountEffects` projects all bounded observed transfer participants and configured permission roles, including accounts other than the submitter. Gross incoming/outgoing events, event net amounts and already measured balances stay separate. Unknown tokens keep raw units; debt stays a liability. The projection adds no balance queries, so additional accounts remain explicitly unmeasured. Limits are 64 accounts, 128 token/account pairs, 256 movements and 256 permission observations; exceeding limits produces unavailable coverage rather than silent truncation.
- Shared balance and allowance results are finalized after both consumers settle. A failed canonical-block check is latched and withholds every measured result sharing that context, even if another check passed. Complete shared evidence replaces early snapshots that could contain a pending request. Unrelated token-query failures remain local. This adds no RPC requests.
- The browser has expandable account views and a public historical allowance-spending example. It separately labels requested transfers, emitted effects, final allowances and missing balance measurements.

Existing lending principal, interest, rounding, receipt-token positions, liabilities and reserve-custody accounting remain separate. Historical measurements retain the original block, transaction position, envelope, semantic replay, query isolation and state-validation requirements.

## Verification

- **264/264 regression tests passed.** Tests include actual recorded historical responses, owner/spender distinctions, stale and malformed evidence, false returns, limits, both canonical-failure orders, sanitized RPC failures and complete shared evidence. `reports/latest-tests.txt`.
- **14/14 recorded decoder benchmark cases passed:** ten observed public traces and four synthetic controls. These remain development cases, not blind holdouts. `reports/latest-benchmark.json`.
- **Six historical API requests returned HTTP 200 and original execution evidence. Five measured final allowances; one retained unavailable allowance state.** Four lending requests also measured balances. Exactly **162 RPC calls**, no retries or replacement transactions. Supply and repay allowance deltas matched across the two providers: −15,066,115 and −199,626,280 raw USDC. The new direct transfer measured −1,277,067. Direct case B remains unavailable because the provider's canonical transaction list puts the hash at index 0 while its original receipt says index 2. [Complete HTTP/RPC capture](reports/affected-account-comparisons/2026-10-26T02-23-00-749Z-http.json), [notes](reports/affected-account-comparisons/2026-10-26T02-23-00-749Z-notes.md), [manifest](reports/affected-account-comparisons/manifest.json).
- **Two separate current-state checks returned HTTP 200 at block 49,536,896.** Hyperlend supply succeeded: USDC −15.066115, hUSDC +15.066114 and allowance −15.066115. The one-raw-unit receipt difference is preserved by the existing scaled-rounding model. The direct transferFrom call reverted with the contract-reported `ERC20: transfer amount exceeds balance`; no effective account or allowance changes are inferred. This is a retained state-dependent execution outcome, not a permit-nonce error or an accuracy percentage. [Raw requests and responses](reports/live/v0.6-current-transfer-checks.json), [notes](reports/live/v0.6-current-transfer-checks-notes.json).
- A separate browser check confirmed the historical direct transfer's distinct owner and submitter, ±1.277067 USDC event totals, unmeasured token balances and independently measured allowance reduction. Its raw response is retained separately from the six-request cohort: [JSON displayed in the browser](reports/live/historical-transfer-from-response-0.6.0.json).

Implementation source SHA-256: `fab9ca0c5b9d0292c67457d9e8eead88fa32914f65b56886067ed864a241b542`. The six-request capture, both current-state results and browser response match the frozen source files. The v0.5 and earlier evidence remains preserved with its original source identity; it was not silently overwritten or counted as new live results.

## Concrete account coverage

In the direct historical example, owner `0xfc1bdd1ff58200761d56ccbce73f6f42ebe56379` differs from submitter/spender/recipient `0x2908da1b63c4f7ce001bf5d875d179930a79eed4`. Original execution transfers 1.277067 USDC and the measured allowance decreases by 1.277067. Neither signing intent nor maliciousness is inferred.

The existing router case has five USDC event participants. The external sender's event net is −25 USDC; the router receives and spends 25 USDC, ending with a zero event net. A downstream spender has +24.812304 USDC, another recipient +0.000196, and a fee recipient +0.1875. These are event totals, not independently measured balances. The router's intermediate 24.8125 USDC approval is consumed while that allowance pair begins and ends at zero. [Discovery, independent expected quantities and raw provenance](reports/affected-account-discovery/INDEX.md).

## What remains

There is no representative accuracy percentage. The [prospective coverage protocol](research/coverage-evaluation/PLAN.md) defines a future unfiltered HyperEVM cohort with frozen code, explicit denominators, resource budgets, failures and unknowns. No cohort has been selected or evaluated under that protocol. Its first pilot can provide descriptive counts only, not a 90% claim or a general EVM result.

Next work is independent balance measurement for additional observed accounts, broader transaction and permission coverage, and independent execution/effects evaluation. Native assets, general NFTs, arbitrary token behavior, other chains, independent permit signature verification and broad threat detection remain incomplete or unsupported.

Security research retains one LI.FI development effects reference, zero admitted security scoring cases and zero blind holdouts. It is still outside the current chain-999 engine and supplies no detection score. No paid infrastructure, external publication or fund movement has occurred.
