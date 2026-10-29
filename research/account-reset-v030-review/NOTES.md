# Independent saved-artifact review

The original packet retains **5 matched, 0 mismatched, 10 unavailable, 0 unattempted**. This review does not change that classification or execute any product, VM, Geth, or network request.

The artifact-only verifier independently checks all 4,193 captured entries, 4,021 archived runtime entries (including one symlink), external plan/source/manifest pins, 25 saved process envelopes and their raw stream joins, fixed five-sequence membership, 15 signed inputs and ordered prefix bodies. It rebuilds the five initial full-state tries, every cumulative product delta into a separate fresh trie, and every Geth allocation dump into another fresh trie. All 15 poststate roots agree. The reset fold preserves unchanged original code/nonce and explicit old-equal storage writes while clearing the entire old storage namespace.

All 27 retained proof calls are cryptographically rechecked against the declared initial roots with matching saved code, including raw proofs beyond the claimed fact reconstruction. All 53 proof/code records join to the collector evidence (27,948 parsed-result bytes), and claimed account/storage facts are independently re-proven. These are synthetic initial allocations and self-consistent header hashes, not proof of a consensus-selected mainnet state. The complete input evidence is joined; per-phase diagnostic IDs are not independently authenticated fetch partitions.

All 15 Geth prefixes contain matching full-state roots, internal log hashes, receipt statuses and independently calculated gas. All 33 receipt occurrences bind to the exact signed type-2 transaction bodies. All five single-transaction prefixes also have complete matching root call output. The ten longer prefixes contain 18 empty later trace files and saved `incorrect number of top-level calls` diagnostics. Their later return values remain unavailable, so agreement in the other saved channels does not promote those ten rows to matched. The log hashes in this fixed corpus are empty-log hashes; it adds no nonempty-log evidence.

The producer's separate [diagnosis](../account-reset-v030/diagnosis.json) identifies reused native callTracer state in pinned Geth. This audit confirms the saved error/empty-file pattern; it did not execute a corrected tracer. Packet usability means the bounded attempt and failures were retained; it does not mean every comparison channel completed.

Product execution in this packet used the actual proof-backed core with a retained manager. It did not use a public sequence API or the isolated parent validator. Geth provides a different opcode/state-finalization implementation; the audit itself uses the archived EthereumJS trie/signature/proof primitives, without executing EVM code. Recorded process timings and source inventory are checked, not independently attested. This fixed development corpus supports no population accuracy or universal EVM claim.

## Pins

- Capture manifest: `df41304fda31c7fe06112352efb79b0734dc00c4fd9c09c08072f6985746cdd1`
- Plan: `38dd6775fd91592ca3e152e27994c840b6eebaf8101ef53a12066f43f657a3f7`
- Runtime source: `f8ad4fa047b5db8117829b310889d39ab356700a68fd09e9bda82356caa0c787`
- Geth binary: `10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521`

## Artifact-only reproduction

From the repository root:

```sh
node research/account-reset-v030-review/verify.mjs
node --test research/account-reset-v030-review/verify.test.mjs
```

An optional capture-directory argument allows relocation; recorded absolute command arguments are checked as provenance and are never used to dispatch or read external files. The verifier reads dependencies only from the exact hashed runtime archive. Nine controls cover stream/parsed-result and signed-input tampering, false proof facts/code, reset namespace and old-equal fields, omitted deletion, receipt/return mismatches, missing traces, gas/refund claims, source bytes, and unsafe paths/symlinks. `report.json` and `controls.tap` retain the results. The supplemental manifest binds only this review directory; the original capture remains unchanged.
