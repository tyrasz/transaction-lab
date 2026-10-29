# Independent artifact review of the BLS corpus

The corrected capture retains **1,838 matched rows and 18 unsupported rows out of 1,856 declared rows**. This consists of all 928 pinned upstream vectors on both Prague and Osaka. The matches include 118 expected invalid-input failures; they do not mean every call succeeded. The nine oversized vectors per fork remain unsupported under the declared public input and gas limits.

The first capture is preserved separately and unchanged. All 1,838 admitted rows contain `output: null` and the same `LocalStateError` from state construction; 18 rows remain unsupported. Its archived worker supplied an account map where the constructor required `{accounts: map}`. The corrected capture is a separately authorized second declaration. The archived production runtime, dependencies, source input vectors, expected outputs, declared gas and selection are identical between attempts. The changed files are the worker construction, its test, freezer/history plumbing and disclosure text; the verifier lists them explicitly.

This audit executed no VM, precompile, Geth, subprocess, target case or RPC request. It imports only Node filesystem, path, assertion, hashing and URL facilities. It does not import the producer adjudicator. It independently:

- Checks externally supplied plan, source and evidence manifest hashes; all file bytes, modes, symlink targets, exact inventories and the Node executable hash.
- Joins all 23 retained upstream files to the pinned Geth source inventory, including Git blob hashes and both licenses. All 18 BLS JSON files in that inventory are included, with 928 original vectors.
- Reconstructs the complete fork/file/index order, real protocol addresses, calldata, expected bytes, intrinsic gas, calldata floor, total/message gas and all unsupported reasons.
- Binds every raw worker input to those reconstructed values and synthetic accounts/header; checks strict UTF-8, process arguments, clean exit, byte hashes, duration bounds and all 36 process records.
- Independently classifies status, output, component/total gas, logs, nonce-only state and fork context. It also joins execution to the retained root trace and confirms the output does not claim authenticated state/header or paid fees.
- Rehashes both complete packets after consumption and verifies the corrected archive's explicit reference to the first manifest.

The artifact review confirms internal consistency of retained evidence and pinned executable sources; it is not a fresh execution or an independent cryptographic implementation. Geth supplies saved expected vectors and was not run for this comparison. The synthetic header and initial recorded accounts are not authenticated blockchain state. This is neither full signed-transaction conformance nor a transaction-population coverage or accuracy rate.

The corrected evidence manifest is `53c93e308a683020cf827b974bfdc2a696acf87e4b11544d1b99ed2db0462976`, its plan is `7cb82bea0fcfec8568581f57cd5b23d162791ae29d58ba62a57f929e575f507f`, and its source manifest is `5ef202ff46c79041589320a6a9a5c12d8a3c208bdb70cdc0d5c08c8f310fa662`. It contains 112 evidence files and 1,857 archived source entries (21,151,902 file bytes). The common input-plan hash is `b1f6b97fad0c2ed14b182d440d7283fd3efaadc70dcfb553c1491e9d24255095`.

The original evidence manifest remains `80af9842a37426970a3cd681b759edafb83dda1cb805a64fa9d8fba764d4a565`, with 112 evidence files and 1,855 archived source entries. Both original captures remain untouched by this audit.

Six artifact-only control groups passed. They cover independent classification mutations, exact inputs/trace binding, expected exceptional failure, retention of all oversized vectors, byte/inventory/symlink tampering, relocation, and resealed false counts/process exits/signals/timing. The first retained TAP reports 1,012.176 seconds elapsed, including 1,010.388 seconds in an artifact parsing control; the cause of that elapsed interval was not established. These timings describe this offline audit only, not either target capture. The raw TAP is retained without adjustment.

Recheck from the repository root (artifact reads only):

```sh
node research/bls-precompile-v1-review/verify.mjs . 53c93e308a683020cf827b974bfdc2a696acf87e4b11544d1b99ed2db0462976
node --test research/bls-precompile-v1-review/verify.test.mjs
```

The verifier supports relocating the repository tree: retained subprocess arguments are checked against the originally declared source root, while files are read from the supplied current root. It still requires the pinned Node executable bytes/version/platform/architecture. The review report, controls and this note are supplemental and outside both frozen corpus source roots.
