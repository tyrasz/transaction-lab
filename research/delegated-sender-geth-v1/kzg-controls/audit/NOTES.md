# Independent KZG capture artifact audit

The separate artifact verifier confirms **16 matched, 0 mismatched, 0 unavailable and 0 unattempted**. It preserves twelve successful product executions, one REVERT and three ordinary EVM failures. All sixteen saved full-VM diagnostics match. The verifier was independently reviewed, and its thirteen offline control groups passed; the unchanged output is retained in [controls.tap](controls.tap). This audit executed no product, full-VM or Geth target and made no network request.

The externally supplied capture, plan, source and product pins are retained in [pins.json](pins.json). The checks cover all **121 evidence files and 4,018 runtime entries**, including 24,916,601 regular-file bytes and one relative dependency symlink. The raw subprocess streams retain 819,122 bytes. All 78 recorded proof responses were reverified against the declared state root and saved code; these are synthetic parsed responses, not network wire evidence. Exact Node and available Geth binary hashes were checked.

The audit independently reconstructs the sixteen fixed declarations, initial MPTs and header hashes; decodes and binds signed type-2 fields; validates proof facts; applies the product's saved deltas to a third fresh MPT; and joins that root and ordered log hash to each sealed Geth expectation. Its raw Geth classifier is independent of the producer's adjudicator. A false Geth assertion stays a mismatch even if the displayed state root matches. Product/expectation seals, process arguments, original ordering, dual-clock bounds and all denominator rows remain bound through relocation. Tamper controls include resealed changes to proof bytes, call modes, fee context, prestate, expected roots, raw process data and claimed facts.

The result supports only these fixed synthetic **state-root and internal Geth log-hash comparisons**. Nested storage/log observations make relevant precompile output visible to those channels. Direct return bytes are compared only by the full-VM diagnostic, which shares both the KZG verifier and EthereumJS opcodes with the product. No separate Geth gas, return or receipt channel, population accuracy rate, blob sidecar, whole-blob validity, block-body capacity, inclusion or consensus claim is established. Hash-bound archived cryptographic/MPT/transaction primitives are reused; Git history and an externally trusted execution clock are not reconstructed.

Read-only verification from the repository root:

```sh
node research/delegated-sender-geth-v1/kzg-controls/audit/verify.mjs --pinned
node --test research/delegated-sender-geth-v1/kzg-controls/audit/verify.test.mjs
```

[manifest.json](manifest.json) seals this audit's files. The sibling [supplement manifest](../supplement-manifest.json) also binds the producer notes and preserved pre-dispatch launcher diagnostic/record. Neither manifest changes the frozen capture. The launcher exited before any target ran; its authorized correction used the same frozen plan, as documented in the [producer notes](../NOTES.md).

`ignored-dependencies.paths0` records 3,841 exact NUL-separated runtime dependency paths, hash-bound by [report.json](report.json). The evidence commit must include these paths as well as every other manifest-listed runtime entry, preserving the symlink as a symlink. No current engine dependency tree is modified.
