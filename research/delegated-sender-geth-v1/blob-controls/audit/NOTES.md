# Independent blob-control artifact audit

The fixed twelve-case packet verifies as **12 matched, 0 mismatched, 0 unavailable, 0 unattempted**. The retained local executions include ten successes, one message revert and one out-of-gas failure. Those two execution failures are expected comparison cases, not missing outcomes. All twelve saved full-VM diagnostics also match. This audit made no network request and executed no product, full-VM or Geth target.

The independent pins supplied after capture are recorded in `pins.json`: manifest `94831aa6ae90ce103db8717d0335a14bd0206561da65d651205515654d191e7e`, plan `aca13660450ada163c0df2d5523bde1040b6dcca0fca0536de5e05d568b80ba3`, source manifest `dd09ff746e79b71f1a77aec67676548a024201bb1c1c0196410420b70ddf6a53`, and product commit `6e0d61d2c34b70400e56494c578af03f80572d1b`.

All 93 evidence files and 3,886 runtime entries were checked, including file modes and the relative dependency symlink. Raw subprocess stdout/stderr retain 726,501 bytes, with counts, hashes, canonical base64 and strict UTF-8 checked. The exact Node executable and available pinned Geth binary hashes match their declarations. Original recorded process arguments remain bound even when the capture is copied to a different location.

For each case, the audit reconstructed only the initial declaration and full-state MPT, recomputed its header hash, independently decoded and bound every signed type-3/type-2 field, and recovered the declared sender. It reverified all 92 saved account/storage proof responses with their saved code and reconstructed claimed input facts. These are synthetic parsed RPC results, not network wire bodies. The audit then independently applied the product's recorded deltas to a third fresh MPT and bound that root, product log hash and signed transaction to the sealed Geth expectation. Saved full-VM output is checked separately and never substitutes for the product-derived root.

Independent raw Geth classification binds the expected case name and fork, clean closed process, timing, exact input identity, boolean pass result and displayed root. A false assertion remains a mismatch even when its displayed root matches. The classifier does not import the producer's adjudicator. Source/byte inventories, durable product seals, expectation seals, fixed ordering and all twelve denominator rows are retained.

## Scope

The cross-client evidence establishes the fixed synthetic product-delta state roots and Geth's internal product-log-hash assertions. Geth gas, return data and receipts were not separately compared. The full-VM diagnostic shares EthereumJS's opcode library with the product. No ordinary-transaction coverage rate, sidecar/KZG validity, inclusion, parent excess transition or whole-block capacity validation is established. Header `blobGasUsed` is retained but Geth's state-test format does not enforce that selected block's full body.

The audit reuses hash-bound archived cryptographic, transaction, MPT and initial-fixture construction primitives. Frozen Git provenance is bound to the supplied release pin rather than rebuilt from Git history. Saved ordering is supported by the reviewed protocol and artifacts, not an externally trusted clock. This is a strict audit of the complete sealed packet: an incomplete product, missing expectation or interrupted integrity state is rejected rather than silently repaired or scored.

## Checks

From the checkout root:

```sh
node research/delegated-sender-geth-v1/blob-controls/audit/verify.mjs --pinned
node --test research/delegated-sender-geth-v1/blob-controls/audit/verify.test.mjs
```

Twelve test groups pass without target execution. They cover all initial signed declarations, proof and delta tampering, malformed process output, exact storage encoding, dual-clock limits, a relocated complete capture, and re-sealed changes to blob hashes/caps, expected roots, process arguments, summary counts and claimed initial facts. A deliberately changed disposable raw assertion remains a mismatch after all outer hashes are recomputed. `controls.tap` retains the test output. No original capture file was changed.

`ignored-dependencies.paths0` contains 3,841 exact NUL-separated dependency paths for Git force-add. Its hash is recorded in `report.json`; the paths were checked against the repository's ignore rules. `manifest.json` seals this supplemental audit separately from the capture. The verifier and inventory checks were adapted from the committed v024 fee-control audit; signed blob-envelope checks and this capture's classifications are independent of the producer's decoder and adjudicator.
