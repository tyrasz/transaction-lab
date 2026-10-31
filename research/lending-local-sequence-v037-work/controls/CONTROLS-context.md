# Context and declaration controls

These are preserved first-run development controls, outside the future capture and source OWN inventory. No integration was rerun while preserving them. All five copies were compared byte-for-byte with their original temporary files.

- Declaration controls: 14 passed, 0 failed.
- First context pure controls: 12 passed, 0 failed.
- Final default context run: 12 passed, 0 failed, 1 integration test explicitly skipped.
- One opt-in current-engine integration: 1 passed, 0 failed; one Osaka chain-1 synthetic approve100 → deposit100 → withdraw50 sequence, source BASEFEE 7, unsigned unpriced execution, original gas 5M. Three fixed CALL queries (allowance, wallet token balance, vault shares) ran independently before and after each original: 3 originals + 18 getter halves = 21 EVM invocations. Every original and query context passed validation after initial-proof checking.
- Public calls: 0. No lending-reference target, external provider execution, transaction signature, or broadcast. This integration uses the same engine and synthetic token/vault state; it is not independent-client or public-protocol evidence.
- Integration is skipped by default and runs only with LENDING_CONTEXT_OFFLINE_INTEGRATION=1. Input-only preparation must leave that opt-in disabled.

## Preserved evidence

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| [lending-v037-declarations-first.tap](lending-v037-declarations-first.tap) | 3524 | 3b63cd90cd1306cbb1913e0fa915f49b3f7e4a059e8740549216bc6d5ddcd5a0 |
| [lending-v037-context-first.tap](lending-v037-context-first.tap) | 3056 | de79e95bca51e31ade37921fc3da41e4e8fe31d7e44eae2e8ff6bc6028da48d5 |
| [lending-v037-context-pure-final.tap](lending-v037-context-pure-final.tap) | 3330 | a2667010ef200d52357f0f9146f7ee8bfdde1b57629b3e7e927c009d01c42a5b |
| [lending-v037-context-offline-current-first.tap](lending-v037-context-offline-current-first.tap) | 388 | a0ef22839d0a1dfd6fb5139211e5fd767663e8721a891b96176a1512c4d5dc59 |
| [lending-v037-context-offline-current-first.json](lending-v037-context-offline-current-first.json) | 503713 | 344abe5f38ac8f4ae268f0832dd8fd154128e37391ab09b2f97550d552b845a4 |

## Released source identities

- declarations.mjs: 74e4136f4e332c669fae0dc4624a0c0515974cf6bf30fa89f0b74f0b2e6a82c2
- declarations.test.mjs: 03466cc3c72599daa360fb24ee85f31365c4aeab3d28be44157f9337e1b71ec1
- context-validation.mjs: 64f946ae1160288104a41ad6711ea3a4f90a6db2b649b1b78ee0f676c98316fa
- context-validation.test.mjs: b113c164921e0b4511176ec1bd1212f78ebd71794b6cefd3b2e3c478caf5d8cf

## Archive review

The current sourceRows inventory contains 4036 rows totaling 27434067 bytes. It includes all six optional fixture helpers (sequence, fee, Amsterdam execution, authorization, lifecycle, proof), the lifecycle helper's hash-bound reports/ethereum-proof-capability/capture.json, and all 24 distinct relative imports reviewed from those helpers plus the new context module/tests. No missing dependency was found in this bounded review. The control evidence directory is excluded. This was a read-only inventory check, not a freeze or target preparation.

Shared validation helpers remain disclosed in CONTEXT_VALIDATION_SCOPE. The provider's existing eight-word header witness does not observe GASPRICE; providerGasPriceIndependentlyWitnessed remains false.

## Gas-accounting revision

The context helper now recomputes historical scalar gas accounting with the shared ethereumUsedGas arithmetic and compares the complete four-field accounting object against retained root message gas, the declared intrinsic/floor, and the reported refund counter. It rejects authorization, fee-settlement, or state-gas accounting in this fixed unpriced mainnet profile. This binds accounting to recorded consumption; it does not independently prove refund eligibility.

The revised pure controls passed 13/13, with the opt-in integration skipped. Controls include coherent accounting tampering, mismatched root gas/refund counters, unsupported dimensions, and the one-fifth refund cap plus calldata floor. The original integration JSON above was then revalidated from saved bytes: initial proofs, 3 originals and 18 getter halves all passed. New VM invocations: 0; public calls: 0. The earlier actual integration was not rerun.

| Revised control | Bytes | SHA-256 |
| --- | ---: | --- |
| [context-gas-binding-pure-first.tap](context-gas-binding-pure-first.tap) | 3583 | 354df3bef139fd61a092c2625d6d81dd9a842439b2f0d9778568a2242df33483 |
| [context-gas-binding-saved-revalidation.json](context-gas-binding-saved-revalidation.json) | 1611 | d44586a395d764fe8e0e64b3ac4e447bde9d9ea6428b1de92e6845a2efd12b80 |

Final released context sources after this revision:

- context-validation.mjs: 0a9497cfeca935977708acd851c37353964522f6e723b4a6b5555a96bc3411e9
- context-validation.test.mjs: 29d8fb57b6010b661b2e06e17aca261838b07a96e99cd42909f73163f1451aa1

The earlier source identities and first logs above remain preserved as the preceding revision. No new dependency was introduced: ethereumUsedGas is imported from the already archived ethereum-profile.js.
