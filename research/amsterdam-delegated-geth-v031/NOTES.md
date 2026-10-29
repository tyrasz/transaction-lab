# Existing-delegated-sender Amsterdam comparison

The one predeclared run completed with **6 matched, 0 mismatched, 0 unavailable and 0 unattempted**. All nine comparison fields agree for every case: full product-delta poststate root, recomputed committed-log hash, receipt status, receipt gas, block gas, root return data, message gas with explicit delegation-preparation adjustment, exact ordered logs, and logs bloom. All six product attempts completed through the real isolated parent; all six Geth processes exited successfully. Total run time was 4.687 seconds; comparisonsUsable=true, sourceUnchanged=true, artifactsUnchanged=true, fatal=null. No target retries, public RPC, network, broadcasts, full-VM expected outputs, or case replacements occurred.

| Fixed case | Receipt gas | Block gas | Final sender nonce | Committed logs |
| --- | ---: | ---: | ---: | ---: |
| Nonself transfer | 21,000 | 21,000 | 2 | 1 |
| Self-call, cold delegate | 15,018 | 15,018 | 2 | 0 |
| Self-call, access-listed delegate | 16,298 | 16,298 | 2 | 0 |
| Repeated CREATE2 collision | 4,925,391 | 4,740,261 | 4 | 1 |
| Ancestor-reverted creation | 30,374 | 30,374 | 2 | 0 |
| Reentrant creation | 609,859 | 555,390 | 5 | 0 |

Block gas is Geth's maximum of regular and state dimensions; receipt gas is the charged scalar. The self-calls and caught-rollback case return word42. Native-transfer logs occur in cases 1 and 4. The product's repeated-CREATE2 ledger records two nonce writes but only one entered constructor; Geth's trace exposes a collision frame too. No internal trace/path equivalence is claimed.

Inputs are synthetic Sepolia Amsterdam type-2 transactions with existing exact sender designations, signed with a public fixed test key, and four disclosed inert STOP request-system accounts. Geth executes its required post-block hooks; product executes only the transaction; scaffold state is checked unchanged. Headers are synthetic and proof-authenticated against the fixture allocation, not public-chain headers. Existing delegation is tested; authorization-list preprocessing is absent. These six selected development cases establish neither population accuracy nor consensus, signed-wallet admission, API transport, sidecar, or inclusion validity.

The sealed packet has 159 manifest entries, retaining 38 actual proof/code calls (25 eth_getProof and 13 eth_getCode), all 12 raw process results and 6 full Geth output sets. Source retention is 57 copied runtime/harness files plus 2 relative dependency-tree links. The referenced prior source inventory binds 3,841 dependency entries / 23,112,265 bytes. All 3,841 entries and its source manifest were confirmed already Git-tracked. Keep both sibling capture directories in their repository layout. Missing or changed dependency bytes fail validation; there is no fallback installation. The old capture was not changed.

Capture pins:

- Manifest: `8cc307cf8e64f1d03d7a28f675a1e8218a04e90dbab6d1a56e92bc640c746ed1`
- Plan: `ae7ed6994ce64921a9d5c85489be83aade863708e7225a93f58b567e897bd0b5`
- Source: `40add5ce0da626c0d21bc462bda2f4feecd0b8955de1e70b04cc960ffaa62d8e`
- Referenced dependency source: `f60cfd73f3987ac3f1a7cc826251a44cf2a2f8b36dacbc7ebb0f1e818e0fcc41`
- Pinned Geth binary: `10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521`

Before target execution, preparation passed 12/12 controls and independent review repeated 12/12. The first preparation log preserves two fabricated-test expectation failures: the first three declarations intentionally share one allocation, so distinct roots are 4; a failed receipt requires a joined failed root trace. Only those test expectations changed; no target ran and no case was replaced. The new parser also read the six prior saved traces as compatibility evidence, without execution. All preparation/freeze/dispatch logs remain outside the immutable capture in `preparation/` and are covered by the producer supplement manifest.

From the repository root, these checks do not rerun targets:

```sh
node --test research/amsterdam-delegated-geth-v031/run.test.mjs
node research/amsterdam-delegated-geth-v031/capture/runtime/research/amsterdam-delegated-geth-v031/run.mjs check research/amsterdam-delegated-geth-v031/capture ae7ed6994ce64921a9d5c85489be83aade863708e7225a93f58b567e897bd0b5
```

`check` validates source/input/dependency/Node/Geth identity; it is not a full independent proof or result audit. Raw output and manifest hashes are preserved for the separate artifact-only review. The original captured classification and bytes are immutable. No commit was made by this producer task.
