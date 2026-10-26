# Automatic token and account query selection — 0.10.0

This development packet exercises the real HTTP API with no caller-supplied `queries`: two previously selected lending deposits submitted through the browser and one separately selected contract-held USDC/WETH swap submitted through an HTTP client. Each input was frozen before its single attempt. All outcomes, raw HTTP/RPC bodies and 36 implementation/browser/capture source files are retained. There were no retries, replacement inputs, signatures or broadcasts.

| Example | Observed candidates | Selected / measured | Unselected | Duration |
| --- | ---: | ---: | ---: | ---: |
| Aave V3 USDC supplyWithPermit | 4 | 4 / 4 | 0 | 6.457 seconds |
| Kiln wrapper into Morpho V1 Steakhouse USDC | 11 | 8 / 8 | 3 | 9.462 seconds |
| Contract-held USDC/WETH swap | 4 | 4 / 4 | 0 | 6.044 seconds |

All three responses were HTTP 200 with successful execution and verified canonical block binding. There were 106 public RPC requests and 648,104 response bytes. Durations describe these runs, not production latency. These are selected examples at historical parent-block-end states, not original-position replay, current executable quotes, a representative accuracy cohort or a security assessment.

## What changed

The engine selects query candidates from bounded committed ERC20-shaped events and direct token calls. It records executing code/storage addresses and immediate callers, including proxy delegation. Failed/static branches and known NFT-shaped ambiguity are excluded. A matching event or selector is only a query hypothesis: before/after amounts still come from separately validated token queries using the complete original state changes. Discovery neither establishes token identity nor finds every economic effect.

The fixed selection order is sender balances, sender-owned allowances, other balances, then other allowances, with lexical query ordering within each group. At most eight queries execute. Omitted candidates remain in JSON and the browser; malformed or over-limit discovery withholds its selected query list. Manual query mode retains the earlier execution behavior.

## Measured examples

Aave measured sender USDC −3,962.903485 and aEthUSDC +3,962.903484, reserve USDC +3,962.903485 and final sender-to-Pool allowance 0→0. The one-unit receipt-token rounding difference is preserved. [Raw Aave response](aave-response.json).

Morpho measured sender USDC −350,000, outer wrapper shares +330,497.511812 and sender-to-wrapper allowance 350,000→0. Automatic discovery additionally selected the wrapper's own outer-share balance (+55.312640) and a separate account's inner-vault share balance (+27.347370306362683662). These balances are not depositor assets. Three observed candidates were not selected: the wrapper's inner-vault share balance, wrapper-to-inner USDC allowance and inner-to-Blue USDC allowance. The earlier manual eight-query packet measured a different set; its values remain preserved. [Raw Morpho response](morpho-response.json).

The swap contract `0x51c72848c68a965f66fa7a88855f9f7784502a7f` measured USDC −13,542.516010 and WETH +5.801876231282977354, with opposite changes in the pool's balances. These are contract-held assets; ownership by the external submitting account is unassessed. The API has no configured WETH display metadata and retains exact raw units. The readable WETH quantity here uses the separately pinned metadata in the [swap discovery packet](../standard-evm-swap-followup/index.json). [Raw swap response](swap-response.json).

The first swap search used a stricter sender-held-assets rule and found no eligible candidate. That [unsuccessful packet](../standard-evm-swap-discovery/NOTES.md) remains unchanged. A separately frozen follow-up permitted contract-held assets and selected this case. Neither selection is an unbiased accuracy sample.

## Evidence

- [Frozen plan](plan.json): SHA-256 `c393b1bdd032e0f18ae8d6a698d5022ac27bae8f6ea4b5db90cb89e974992603`.
- Implementation SHA-256: `46c44c52578a050e56aef17f8f562b16f9e539bfdfe9aa4c5775d8b75447dc4e`.
- [Manifest](manifest.json): SHA-256 `473e1a366c7b20ca41f4fa7adb481500ea44e806bcfc3005285198550f276a52`, binding 48 files and 5,991,936 bytes.
- [Results](results.json), [manual browser observations](browser-checks.json), and exact HTTP exchanges [1](http/001.json), [2](http/002.json), [3](http/003.json).

The browser showed automatic mode, actual account attribution, exact balances and allowances, and all three Morpho omissions with reasons. Editing the example cleared the earlier result; controls locked during Aave's request. No browser warnings or errors were observed. The swap was exercised through the HTTP client, not the browser. Screenshot inspection is recorded as a manual observation; no screenshot artifact is included.

The [archived offline verifier](verification.json) reproduces all three complete API responses and all 106 sequential RPC exchanges without a network connection. It checks the declared source/file inventory, exact HTTP inputs, candidate selection and omissions, and all 16 measured pairs. Eleven focused verifier controls pass, including an archive-only copy with network access blocked and mutation, missing-case, source-inventory and unexpected-request controls. Root independently repeated the verifier successfully. This verifies reproducibility of the captured provider evidence; it is not an independent execution oracle.

The [separate evidence audit](independent-audit.json) checks all 16 measurements against 32 before/after query return words and 32 nonce-only query state changes, reconstructs full original overrides without importing product validators, and matches the ten overlapping deposit measurements to the prior manual packet.

That audit also identifies an internal transfer of **0.000833321237492342 ETH** in the swap. The trace value and original state-diff balances agree on the exact debit and credit of 833321237492342 wei. This is an internal value transfer, not outer transaction fee settlement; purpose and ownership remain unassessed. No native-balance preview is produced by the four ERC20 queries, so the successful token measurements do not represent every effect of this transaction.
