# Independent saved-artifact review

The sealed two-case packet verifies with its original **one match and one mismatch** retained. This review ran no diagnostic VM, Geth process, or network request. It used only saved bytes, signature/header decoding, hashes, full-MPT construction and independent fee arithmetic. It did not change the capture or its archived helper.

Pinned capture manifest: `339bcd0951d66deec7f981d24e9bb14d04062a565256d4234b5aa731878a98e0`.
Pinned plan: `a32e63e57de64bfa4f97b6b7e17535a1d3e87bdaeaf077eda66c25f2f03b98b7`.
Pinned source: `66eb6a304a5eb0090119505568fbabf9176b07860d4e3b490f730b4847ccebb4`.

The verifier checks all 3,906 capture entries and 3,857 archived runtime entries, including one symlink; the unchanged Geth binary and build/source/dependency identities; both exact signed type-2 inputs and independently rebuilt original/amended initial roots; synthetic header/environment joins; four process records; two EthereumJS observation seals; signed Geth body and receipt joins; and the complete output inventory. It verifies the source-defined ordering in which both EthereumJS observations are sealed before either Geth dispatch. The saved process records do not provide an independent historical timestamp attestation of that ordering.

The STOP baseline agrees at 15,000 gas and the same post-state root. The second case retains failed status and the same empty-log hash on both clients, with different gas and state roots:

| Observation | EthereumJS | Geth |
| --- | ---: | ---: |
| Root message gas consumed | 16,762,216 | 16,762,216 |
| Charged receipt gas | 20,000,000 | 16,777,216 |
| Recorded block gas | 20,000,000 | 16,777,216 |
| Final state gas | 0 | Not separately reported by t8n |

All 54 JSONL records are parsed as balanced frames: five frames and 44 opcode records across the two cases. In the exceptional case, Geth catches three INVALID children with 16,000,000, 600,000 and 154,547 gas. It then reaches the intended final CALL at PC 150, to the authority `0x4444444444444444444444444444444444444444`, with value zero, requested child gas zero and 4,374 execution gas. The cold authority access consumes 3,000 gas including the static 100 charge; the remaining 1,374 cannot pay the 3,000 cold delegation-resolution charge. No fourth child frame is entered. The saved block access list contains the authority and omits implementation `0x5555555555555555555555555555555555555555`, consistent with the pinned source recording that delegated target only after its charge succeeds.

The relevant pinned Geth code is `core/vm/operations_acl.go` (Amsterdam CALL pricing, lines 467–514), `core/vm/interpreter.go` (static/dynamic charging and fault trace), `core/vm/gascosts.go` (ExitHalt preserves the reservoir), and `core/state_transition.go` (executeCall drains execution only). Four additional interpretation files are copied into this review's `source/`, verified against the original pinned source inventory; they are not additions to the frozen capture.

EthereumJS records root OOG, the post-target latch true, and a 3,222,784 reservoir at root return. Its post-run counters then show reservoir zero and total charge 20,000,000, matching the archived `runTx.js` force-drain branch. EthereumJS did not record a full opcode trace, so its exact PC is source-inferred from the fixed program and recorded latch, rather than independently observed. Geth's exact failure path is observed in its saved opcode trace. This establishes the intended client accounting discrepancy for this fixture; it does not establish which evolving Amsterdam interpretation is canonical.

The verifier independently rebuilds Geth's full final allocation and EthereumJS's fee-only final state from each immutable initial allocation. Both roots match their saved outputs. For the failed case, the 3,222,784 gas difference accounts exactly for the 32,227,840 wei sender-charge difference and 9,668,352 wei coinbase-tip difference (effective price 10, tip 3, base fee 7). No other account or storage difference is needed. MPT and cryptographic primitives come from the archived EthereumJS dependencies; the fee/state arithmetic and trace analysis are independent of the producer comparator.

The four request-contract STOP rows remain unchanged. They are disclosed synthetic scaffolding, not deployed Sepolia contracts. Geth executes its block system hooks; the EthereumJS observation executes only the user transaction. The fixed 20M envelope also exceeds the public product's 5M ceiling. Neither this packet nor this audit enables public Sepolia/Amsterdam execution, validates a reachable negative final state counter, establishes consensus validity, or measures population accuracy. The later live helper's unsupported-settlement change is a separate product decision and is not substituted into these archived observations.

A separate peer reviewed the final checker source read-only and found no blocker; that review ran no additional targets or controls. Eight controls pass, covering the actual packet, raw-byte identity, process limits, trace target/PC/gas mutations, missing or trailing frame exits, fee-state changes, classification preservation, and source/symlink mutation. `controls.tap` retains the run; `report.json` retains the actual artifact-only verdict.

Reproduce from the repository root without target execution:

```sh
node research/amsterdam-state-gas-diagnostic-v031-review/verify.mjs
node --test research/amsterdam-state-gas-diagnostic-v031-review/verify.test.mjs
```

The verifier requires the retained archive and exact external Node/Geth binary bytes at their recorded paths; it hashes but never executes Geth. A copied capture can be passed to the exported `verify(capturePath)` function; recorded absolute command arguments remain compared to the original source-root identity, not rewritten.
