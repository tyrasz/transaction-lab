# Two lending calls executed from proof-backed initial state

This is a post-seal supplement, outside the original manifest. The capture completed once on 2026-10-27 in 94.679 seconds. Its two selected development workloads succeeded locally, and the subsequent product responses matched all five declared comparison channels: execution status, return bytes, committed log order/content, full observed state changes, and transaction-style gas. These are two examples, not a coverage percentage or security score.

| Observation | Aave USDC supplyWithPermit | Morpho wrapper deposit |
| --- | ---: | ---: |
| Local proof / code requests | 43 / 15 | 213 / 17 |
| Proven input accounts / demanded slots | 15 / 28 | 17 / 196 |
| Local response bytes | 702,215 | 2,706,859 |
| Local elapsed time | 17.576 s | 58.774 s |
| Local instructions / entered frames | 8,737 / 18 | 218,974 / 232 |
| Maximum frame depth / committed logs | 6 / 7 | 6 / 16 |
| Changed accounts / storage words | 4 / 10 | 6 / 18 |
| Matched transaction-style gas | 189,775 | 1,413,682 |
| Product RPC requests / response bytes | 30 / 98,187 | 46 / 345,527 |
| Product HTTP / comparison | 200 / five channels matched | 200 / five channels matched |

Aave entered 5 CALL, 9 DELEGATECALL and 4 STATICCALL frames, including one successful `ecrecover` precompile call. Its return was empty bytes. Morpho entered 10 CALL, 12 DELEGATECALL and 210 STATICCALL frames; its return was `0x0000000000000000000000000000000000000000000000000000004cf32fd184`. Frame counts include the root. Full call-tree equality is not one of the five comparison claims.

Both local attempts were saved before either product request began. Fresh local managers obtained only hash-bound `eth_getProof` and `eth_getCode` inputs; provider traces, state diffs, query results and expected token amounts did not seed local execution. The original calldata, sender and value were retained at each original parent-block end with fixed 5M gas. The Aave permit executed naturally from proven state. No approval insertion, funding override, time advancement, retry, replacement or fallback was used.

The pre-dispatch limit was the collector's existing 256 calls per case, with 120 seconds, 8 MiB per body, 32 MiB per case and 64 MiB shared local responses. Morpho needed 230 calls; the earlier transfer packet's 64-call tightening would not have accommodated this witness. Across both locals and products, the actual totals were **364 public RPC requests and 3,852,788 response bytes**, plus two localhost POSTs. All outcomes were retained, sources stayed unchanged, and no declared budget violation occurred.

The original manifest contains 2,265 entries and 41,153,256 regular-file bytes. Every file hash/symlink target was rechecked offline after sealing. All 288 local wire requests, exact response bodies, proof/code method restrictions, pinned selectors and collector evidence correspondence were checked. All 76 product request/response hashes and byte counts were independently recomputed; each full HTTP body equals its saved parsed API result. The frozen harness/comparator passed 30 offline controls before dispatch.

Exact identities:

- [Plan](plan.json): SHA-256 `f9fb0e1b465bcf191185e1790204bf64a324634d98436ebb4a17f4cb6cd83288`.
- [Original manifest](manifest.json): SHA-256 `34b1e325ea08604705e50f06da81e442bb48cea017faf3058671e1e1a4e8f8c5`.
- Product implementation: version `0.12.0`, SHA-256 `3b769d18eac4e46548420e51799baf0185f56154c1fbfaaed6914f8b4cb83e60`, with the complete declared identity matched in both responses.
- Frozen local archive: 1,668 entries, including 1,659 installed dependency entries; 10,292,616 file bytes, with Node and lockfile identities in the plan.

Raw results: [Aave local](aave-usdc-supply-with-permit-local.json), [Aave product](aave-usdc-supply-with-permit-product.json), [Morpho local](morpho-kiln-usdc-deposit-local.json), [Morpho product](morpho-kiln-usdc-deposit-product.json), and [comparison results](results.json). Each local record links its exact raw wire body; each product record retains its full transport evidence. [The phase marker](LOCAL-PHASE-SAVED.json) records completion of both local saves before product dispatch.

Header RLP/Keccak commitments and demanded account/storage/code proofs were verified. Consensus, finality, block body and a complete poststate root were not independently authenticated. Execution was unsigned and unpriced, without outer-signature validation, fee settlement or original transaction-position replay. Observed-state agreement does not prove a complete economic inventory or general protocol reliability. A separate supplemental offline reexecution audit is being prepared without changing this sealed packet.
