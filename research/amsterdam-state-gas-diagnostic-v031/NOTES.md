# Retained two-client discrepancy

The sole declared run completed in 1.310 seconds with **one match and one mismatch**, zero unavailable or unattempted cases, and `comparisonsUsable: true`. Source and artifact integrity checks passed; no retry or input replacement occurred. Both EthereumJS observations were durably sealed before either Geth process. The packet contains 3,906 inventory entries totaling 25,377,061 bytes and 22,088 bytes of raw process/transition output. Its 3,857 archived source entries include one dependency symlink.

| Fixed case | EthereumJS receipt gas | Geth receipt gas | Result |
| --- | ---: | ---: | --- |
| STOP baseline | 15,000 | 15,000 | State root, log hash, status, receipt gas and block gas agree |
| Post-target CALL OOG | 20,000,000 | 16,777,216 | Status and log hash agree; gas and state root differ |

The exceptional transaction is the same signed type-2 transaction in both clients, hash `0x71dd824da7c94281e0fd3eb34c29863a45f9453e401c3afeb3283b3d2c04a313`. It uses a synthetic key and synthetic amended allocation, not Sepolia chain state. Four disclosed inert STOP system accounts were added before freezing to satisfy Geth's Amsterdam transition-tool postprocessing requirements. Original account rows, allocations, roots and the original declaration source remain retained. These additions are identical for both clients; Geth's final allocation keeps all four unchanged and emits no requests. No production API execution was performed.

The saved EthereumJS root-exit observation has OOG, `postTargetLatch: true`, zero net state gas, and **3,222,784 state gas still in the reservoir**. After `runTx` settlement its reservoir is zero. The archived `runTx.js` explicitly force-drains the reservoir for this latch. The helper in the frozen source mirrors that observed pinned behavior; it is not a canonical interpretation.

Geth's saved opcode trace reaches the final CALL at PC 150, with requested gas zero, stack target `0x4444444444444444444444444444444444444444`, and 4,374 regular gas available. It exits with OOG and reports 16,762,216 message gas consumed; receipt and block gas are 16,777,216 after the 15,000 intrinsic charge. This is consistent with preserving the 3,222,784 reservoir. The raw trace retains the earlier three INVALID child calls, operand stacks and call frames for independent failure-path analysis. No automated claim that every earlier instruction/gas path is identical is made: EthereumJS retained root/latch counters, not an opcode trace.

At effective price 10 wei and tip 3 wei, the gas difference means EthereumJS charges 32,227,840 wei more to the sender and credits 9,668,352 wei more to the fee recipient. Geth's exceptional final state root is `0xf1a7cc0fb505f09670bf06e1a98f95aac24268618e41618b7c6897b171505615`; EthereumJS's is `0x13a2dfa443aa711dc90c50f64f9df968e3c31b1c4df03da4c09a0d6045bd4b1b`. The log hash is empty in both and both receipts report failure.

Pinned Geth `core/vm/gascosts.go` defines exceptional halt as restoring the frame's state reservoir and consuming execution gas. Its `core/state_transition.go` likewise drains execution only after a root exceptional halt. The same source rejects negative **final transaction** state gas, distinct from legitimate signed per-frame/refill counters. This diagnostic did not execute a negative-final-state case and makes no claim about its reachability. Current [EIP-8037](https://eips.ethereum.org/EIPS/eip-8037) also describes restoring the reservoir on exceptional halt; this two-client packet establishes an observed implementation disagreement, not consensus correctness by itself.

After receiving this result, the parent chose to make the **live standalone helper** refuse disputed post-target-OOG and negative-final-state inputs pending resolution. That follow-up does not change this capture, its archived helper, its observations, or its one-match/one-mismatch accounting. Negative reservoir deltas from legitimate refills are a separate supported case. Public Amsterdam execution remains closed.

External packet pins:

- Plan: `a32e63e57de64bfa4f97b6b7e17535a1d3e87bdaeaf077eda66c25f2f03b98b7`
- Source manifest: `66eb6a304a5eb0090119505568fbabf9176b07860d4e3b490f730b4847ccebb4`
- Evidence manifest: `339bcd0951d66deec7f981d24e9bb14d04062a565256d4234b5aa731878a98e0`
- Source repository snapshot: `6a1c2eba56ca477389a9901b355bebf485bdbd98`
- Geth source commit: `1df30b18d9ed35ee9d28ffd4648442c2204554ad`
- Geth binary: `10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521`
- Geth toolchain manifest: `791a91bca058b516b21a66097787f96959477958219eaee9dd20e73367b21333`
- Node v22.23.2, Darwin arm64 binary: `1f72236fcbfc84855d7c884fbcba0f6a7c635d600d7e493b823e77c467f2ae95`

`capture/` is immutable. An independent artifact-only review is being prepared in the sibling `research/amsterdam-state-gas-diagnostic-v031-review/`, with no target reexecution. The original eight preparation controls and their independent rerun were target-free; the earlier 13 helper controls were shared-runtime development tests, not part of this two-case denominator.
