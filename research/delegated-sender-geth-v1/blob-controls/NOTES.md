# Fixed blob-fee comparison results

The single frozen run retained all twelve predeclared cases: **12 matched, 0 mismatched, 0 unavailable and 0 unattempted**. Geth checked each product-applied full poststate root and internally asserted its ordered log hash. The separate signed full-VM diagnostic also matched all twelve on state, logs, return, execution status and gas. That diagnostic shares EthereumJS opcodes with the product; Geth is the independent opcode implementation.

These are fixed synthetic development controls, not a population sample or a universal accuracy result. Product execution completed with ten successes, one REVERT and one out-of-gas failure. Matching those latter cases means their expected failure effects matched, not that the transactions succeeded. Seven cases retained nonempty logs. There were no retries, replacement cases, public RPC requests or broadcasts.

## Recorded results

All rows below matched both retained comparisons. Gas is the product/full-VM charged gas; ordinary Geth state-test output does not provide an independently compared gas channel. All fee amounts are raw wei.

| ID | Case | Fork | Product execution | Charged gas | Blob burn | Committed logs |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 001 | Maximum 6 blobs | Cancun | success | 157,244 | 5,505,024 | 1 |
| 002 | Maximum 9 blobs | Prague | success | 157,244 | 8,257,536 | 1 |
| 003 | Maximum 6 blobs | Osaka | success | 157,244 | 5,505,024 | 1 |
| 004 | Maximum 6 blobs | BPO1 | success | 157,244 | 5,505,024 | 1 |
| 005 | Maximum 6 blobs | BPO2 | success | 157,244 | 5,505,024 | 1 |
| 006 | Priced type2 BLOBBASEFEE, no clamp | Osaka | success | 117,444 | 0 | 1 |
| 007 | Storage/log followed by REVERT | Osaka | reverted | 43,513 | 1,835,008 | 0 |
| 008 | Storage followed by OOG | Osaka | failed | 50,000 | 1,835,008 | 0 |
| 009 | Execution refund cap | Osaka | success | 28,815 | 1,835,008 | 0 |
| 010 | Calldata floor after refund | Osaka | success | 101,000 | 1,835,008 | 0 |
| 011 | Sender equals coinbase | BPO2 | success | 157,244 | 1,835,008 | 1 |
| 012 | Exact maximum-cap affordability | Osaka | success | 21,000 | 1,835,008 | 0 |

Cases 001–006 and 011 persist blob price, first/last/out-of-range hashes, gas price, base fee and sender balance observations in storage and logs. Case 006 records BLOBBASEFEE 1 with block base fee 1,600: the price comes from the current excess, without a direct base-fee/16 clamp. Cases 007/008 retain blob burn and execution fees while discarding message storage/value/log effects. Cases 009/010 each have a message refund counter of 14,400; the refund cap and then the calldata floor produce the different charged gas shown above. The alias case separately preserves the sender's beneficiary credit, and case 012 starts with exactly the declared maximum-cap affordability requirement.

The saved [results](capture/results.json) report `status: complete`, `comparisonsUsable: true`, `sourceUnchanged: true`, and no fatal error. The run began at **2026-10-28 13:40:11.799 UTC** and finished at **13:40:30.582 UTC**. Preparation took 17.498 seconds wall time and the Geth phase 1.274 seconds; both dual-clock verdicts were within budget. These are local capture timings, not public-RPC or general performance measurements.

## Provenance and limits

Product baseline: `6e0d61d2c34b70400e56494c578af03f80572d1b`. Protocol/repository commit at freeze: `b43eb20273c6a3c121f5373645fff5a70f6b0367`. Freeze timestamp: `2026-10-28T13:39:47.857Z`. The source archive contains **3,886 entries, 23,865,536 regular-file bytes and one bounded internal dependency symlink**. It includes the complete installed local/fixture dependency trees, fixtures, actual executor and protocol. No sealed capture file was changed when writing this note.

Node: v22.23.2, darwin/arm64, executable SHA-256 `1f72236fcbfc84855d7c884fbcba0f6a7c635d600d7e493b823e77c467f2ae95`. Geth: v1.17.10, source commit `1df30b18d9ed35ee9d28ffd4648442c2204554ad`, binary SHA-256 `10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521` (54,847,666 bytes). The binary is external to the capture; its toolchain, source and dependency inventories are retained and bound. Exact binary availability remains a replay requirement.

| Artifact | SHA-256 |
| --- | --- |
| [Evidence manifest](capture/manifest.json), covering 93 evidence files | `94831aa6ae90ce103db8717d0335a14bd0206561da65d651205515654d191e7e` |
| [Frozen plan](capture/PLAN.json) | `aca13660450ada163c0df2d5523bde1040b6dcca0fca0536de5e05d568b80ba3` |
| [Source manifest](capture/source-manifest.json) | `dd09ff746e79b71f1a77aec67676548a024201bb1c1c0196410420b70ddf6a53` |
| [Results](capture/results.json) | `e3c25840eee04734018e23502622e2f71f786ebc2c5b6848869c56dedff55fd6` |

For each case the isolated product consumed only synthetic initial proofs/code; its result was durably sealed before the separate full VM ran. A third fresh MPT applied the product deltas. Every available product-root/log expectation was sealed before the first Geth call. Exact signed type3/type2 bytes are independently decoded and bound to the JSON-derived message Geth executes. All twelve original positions and all raw subprocess outputs remain in the capture. The writer of this note rehashed the 93 evidence files, checked all twelve raw Geth streams and ran the archived source/plan check without executing any target.

Geth comparison is limited to **full state root and internal log-hash assertion**. It does not establish separate return data, receipt or gas agreement. The preserved headers' full blob usage does not imply Geth block-body capacity validation. Parent excess evolution, sidecars, KZG proofs, transaction inclusion, consensus, original transaction position and broad Ethereum coverage remain outside scope. The five maximum accepted counts are positive controls; rejected envelopes are covered separately by local tests. Known empty-account/nonempty-storage oracle limitations were excluded in the predeclared selection, not removed after observing results.

## Read-only verification

From the repository root, this validates the archived runtime, plan/input hashes, exact Node identity and pinned Geth binary without running Geth or an EVM:

```sh
node research/delegated-sender-geth-v1/blob-controls/capture/runtime/research/delegated-sender-geth-v1/blob-controls/run.mjs check research/delegated-sender-geth-v1/blob-controls/capture aca13660450ada163c0df2d5523bde1040b6dcca0fca0536de5e05d568b80ba3
```

The separate artifact-only audit has its own [verifier](audit/verify.mjs) and controls. It reconstructs initial tries, verifies proofs/signatures and applies saved product deltas; it does not replay target opcodes or invoke Geth:

```sh
node research/delegated-sender-geth-v1/blob-controls/audit/verify.mjs --pinned
node --test research/delegated-sender-geth-v1/blob-controls/audit/verify.test.mjs
```

Original execution used the reviewed one-shot freeze/check/run protocol documented in [PLAN.md](PLAN.md). The capture is sealed and cannot be overwritten or retried. A separately authorized replay would need the exact archived sources, declarations, Node and Geth identities, a new output destination, and an explicit distinction from this original run. The source plan retains original absolute paths; relocation never justifies rewriting sealed process arguments or files.
