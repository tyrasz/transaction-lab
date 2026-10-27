# Position-query v3: measured results and replay

These notes, saved verification and v2 comparison are post-seal supplements. The original capture manifest and its 145 files remain unchanged.

All three fixed HTTP requests returned 200. Both standalone deposit calls and both approval→supply steps succeeded with verified canonical context. All **12 token queries and four position queries** were measured in this selected development capture.

| Request | Token queries | Position queries | RPC calls | Response bytes |
| --- | --- | --- | --- | --- |
| Aave supplyWithPermit | 4/4 measured | 1/1 measured | 34 | 115,299 |
| Morpho wrapper deposit | 3/3 measured | 1/1 measured | 31 | 368,412 |
| Aave approval → supply | 1/1, then 4/4 measured | 1/1 in each step | 56 | 211,163 |

Total: 121 read-only RPC calls, 694,874 response bytes, 27.985341167 seconds. No retry, replacement, signing, broadcast or funding override occurred. All requests, blocks, provider and limits were identical to v2; the product version changed to 0.13.1 with the scoped typed-position delegate-call fix.

## Measured values and carried state

Aave's supply position returned the following exact integers. The first three remain **oracle base units with unknown currency and scale**; they are not labelled USD. Threshold and LTV are basis-point fields. The health-factor word is retained as a ratio scaled by 10^18, without a safety or liquidation judgment.

| Field | Before supply | After supply |
| --- | ---: | ---: |
| totalCollateralBase | 114367800827 | 510592963427 |
| totalDebtBase | 21216 | 21216 |
| availableBorrowsBase | 107494274781 | 404644902299 |
| currentLiquidationThreshold | 9599 | 8203 |
| ltv | 9399 | 7925 |
| healthFactor | 5175007482545248868778280 | 19742109048721719457013574 |

All six Aave fields were unchanged by the approval step. The supply's complete before tuple equals the approval's after tuple byte for byte. Its before and after tuples also equal the standalone supplyWithPermit results. These comparisons use separately traced queries in the complete carried state; query nonce mutations are not carried into later steps. USDC approval itself was measured as 0 → 3,962,903,485 raw units, followed by consumption back to 0 during supply.

Morpho's Blue position belongs to inner vault `0xbeef01735c132ada46aa9aa4c54623caa92a64cb`, not the sender. Market `0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64` supplyShares changed from `26565631929266438023` to `26884573979212466695`, delta `318942049946028672`. borrowShares and collateral were measured as 0 → 0. Shares are not converted to assets.

## Comparison with retained earlier attempts

The full engine and preview rows for all 12 token queries exactly equal v2, including identities, raw values and local evidence references. The complete Morpho position measurement and preview also exactly equal v2. The three formerly unavailable Aave position checks now contain independently obtained before/after trace and mutation evidence; no v2 trace was used to invent missing measurements.

The first packet (`../standard-evm-positions/`) retains a zero-HTTP, zero-RPC EPERM socket-bind failure. The v2 packet retains successful executions and token measurements, measured Morpho position, and three unavailable Aave position checks. Neither packet was overwritten or relabelled. v3 is a separately declared post-fix run of the same selected inputs.

## Reproduce the checks offline

From the repository root:

```sh
node reports/standard-evm-positions-v3/verify.mjs a8a5de3bb276a6669b1ce4abc39d8c641f389889786ad9f13aec0e2664543a26
node reports/standard-evm-positions-v3/compare-v2.mjs
```

The frozen verifier returned `reproduced`: 145 sealed files, 119 archived source/dependency/regression files, all input bindings and 121 saved wire responses checked; all three responses reproduced through the archived real HTTP handler and transport. Only generated run IDs, timestamps, aggregate timing and individual transport durations are excluded from semantic equality. There were no live source imports, sockets or public requests during verification. [verification.json](verification.json) records the result. [comparison-v2.json](comparison-v2.json) records the hash-bound exact comparisons from the separate comparison script.

Plan SHA256: `5f08851552e8210ab8ad88493feb40f11de46d64b18207b87880d21811e04c86`.
Capture manifest SHA256: `a8a5de3bb276a6669b1ce4abc39d8c641f389889786ad9f13aec0e2664543a26`.
Product v0.13.1 SHA256: `492389cb5478917d8e75b61306323bdee29d15ce7efa7e128a45f9d582b0759b`.

This is reproducible provider-consistency evidence for three selected development cases, not a representative success rate, independent execution oracle, deployment authentication, full economic-effects guarantee or security assessment. Simulations use historical block-end state, synthetic BASEFEE zero and no outer transaction fee settlement. Sequence calls are separate ordered unsigned executions, not an atomic signed bundle.
