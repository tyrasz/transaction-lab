# Independent offline audit of the v4 development recheck

This supplemental sibling directory does not modify the original v4 packet or its manifest. It is an audit of retained evidence, not another simulation run or a new prospective sample.

The audit passed against v4 evidence manifest `dce9038a13613eea736defdf135b6bfc2cf5abed9fddec0a2714ec33df6fd024`. It rehashed all 85 original evidence files and 1,785 archived source entries, checked the frozen Node identity, rehashed the four selected parent headers, and joined all 52 fresh RPC wires (196,954 response bytes) to the corresponding local broker/input record or product transport/engine record. No wire was left unjoined. Exact original call/trace/diff envelopes and pinned state selectors were checked. The frozen adjudicator reproduced all four live outcomes and both separately labeled saved-input comparisons.

| Case | Fresh local attempt | Provider result | Supported comparison |
| --- | --- | --- | --- |
| 002 | First proof unavailable | Verified revert, 317,368 gas | Local reference unavailable |
| 005 | First proof unavailable | Verified success | Saved v2 input supplement matches all five channels, 21,000 gas |
| 007 | First proof unavailable | Trace succeeds, but state-diff request rejected | Unverified context; not comparable |
| 016 | First proof unavailable | Verified revert | Saved v2 input supplement matches all five channels, 21,960 gas |

Every fresh local `eth_getProof` returned RPC error `-32000`, stating that the historical state was unavailable. There are **zero fresh verified proof responses** in this packet. An unavailable proof is not an empty account, zero balance, or failed EVM execution.

For cases 005 and 016, the audit independently reran the frozen Merkle-proof verifier on four retained account proofs, including the exclusion proof for case 005's previously absent recipient, and verified all four associated code values. Every proof/code value was also joined back to its original v2 wire bytes. The facts remain cryptographically bound to the exact original parent state roots. This establishes their validity for those roots; it does not establish current RPC availability, current balances, independent-provider agreement, or original-transaction-position replay. No output trace or poststate was used to construct proof inputs. This audit does not rerun the VM: it recomputes comparisons with the already frozen adjudicator and explicitly records that limitation.

Case 007 exposes a retained provider inconsistency: `callTracer` accepted the declared blob hashes with `maxFeePerBlobGas: 0x0` and returned success using 21,000 gas; `prestateTracer` at the same block with the exact same call envelope returned `-32003`, “max fee per blob gas less than block blob gas fee.” The report correctly withholds canonical validation and measurement claims. The earlier successful trace does not resolve the rejected state-diff evidence.

The v3 packet is also preserved. Its recorded execution window was 1,336,998.307 ms versus the declared 1,200,000 ms execution window plus at most 25,000 ms terminal drain. Its last request reports 392,128.524 ms before a deadline result; cases 007 and 016 were never attempted. The operator reported host suspension, which is consistent with delayed timer processing, but RPC bytes alone do not prove that cause. This is a real scheduling-bound overrun, not evidence that the deadline was enforced in real time. The v3 top-level `complete` describes a finalized ledger; it must not be presented as four completed tests. The new v4 capture preserves these earlier failures and does not replace them.

Reproduce the supplemental audit without network or VM execution:

```sh
node reports/ordinary-ethereum-unresolved-v4-audit/verify.mjs --verify
node --test reports/ordinary-ethereum-unresolved-v4-audit/verify.test.mjs
```

Three controls pass, including mutations of wire bytes, RPC IDs/parameters, the blob fee cap, and fabricated successful state-diff evidence. The audit itself uses only archived modules after source verification. It does not establish consensus/finality, signed transaction validity, fee settlement, blob sidecar validity, complete asset coverage, or any population accuracy percentage.
