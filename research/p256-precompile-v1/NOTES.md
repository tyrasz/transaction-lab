# P256 fixed-vector result

The once-run frozen corpus matched **782/782** saved official Geth expectations: **567 success words and 215 empty returns**, each consuming exactly **6,900 gas**. There were zero mismatches, unavailable results or unattempted entries. The source check passed and the packet is usable; the measured run took **702.995 ms**. No vector was replaced or rerun.

This is a pure-adapter check against unchanged expected outputs from Geth commit `1df30b18d9ed35ee9d28ffd4648442c2204554ad`. It did **not** execute Geth, an EVM, a signed transaction or RPC. It is not a poststate/root comparison or broad EVM accuracy estimate. `vectors.json` is the original 443,336-byte `core/vm/testdata/precompiles/p256Verify.json`, hash `72be71957c3e4292d874b3e2a6a2fc2142524433b01cb9a9552b9bb2528c214d`; provenance is retained separately.

The adapter validates all EIP-7951 input bounds and the curve equation, then uses pinned Noble P-256 arithmetic with the required infinity and modular-x checks. It intentionally does not use Noble's `verify` convenience function, whose broad catch would convert unexpected arithmetic failures into an ordinary invalid signature. Every return checks the budget; unexpected failures invoke the executor's sticky host-error hook and propagate. There is no request-selectable verifier. The test-only construction seam is internal source code, not an API parameter.

Twelve focused local test groups separately pass: valid and invalid encodings/signatures, high-S and zero/max hashes, exact gas/OOG boundaries, all four nested call modes, successful empty-return behavior, value/revert/fee handling, pre-Osaka ordinary address behavior, fresh measurement queries and eight pre/post-adapter deadline/host-failure rollback cases. Those controls are not included in the 782-vector denominator.

Frozen identities:

- Plan: `50deae81d1cb3496620b4e3ac7b857e2ed0d5ef750dc4a2cacc18ffcda0088bc`.
- Source manifest: `8e0ef9ac46873dae4c175741fff186b7f4adcfd74470f9f6493422e58497d8f1` (1,663 runtime entries).
- Evidence manifest: `6cd83b286bd21383582f36a2b8e30daa6645c7a1c3e5d4678524aaec8a192faa` (1,669 entries before the manifest itself).
- Adapter: `14c820ff1bd52756f9d67a8839282cf113d10cb87bcb35ac4bcf0530c55a01e4`.

The complete local dependency tree is retained inside the capture, including its symlink. Node's executable is identified, not embedded. No frozen captured bytes were changed after dispatch. This note and the artifact verifier are supplemental files outside the capture.

Artifact-only verification (no adapter execution):

```sh
node research/p256-precompile-v1/verify.mjs
```
