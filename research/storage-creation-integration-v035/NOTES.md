# Storage creation integration checkpoint

The development product now deploys at an authenticated nonce-zero, code-empty
target with old storage by clearing that storage before initcode. It preserves
the target's balance, restores current storage on constructor or ancestor revert,
and retains the invocation's created-account marker for original SSTORE gas.
The generic storage-clear method remains restricted. This checkpoint is not an
installed release; the app on port 5174 remains version 0.34.

The combined explicit EthereumJS 10.1.3 ESM patch retains three delegation length
checks and removes storage from two collision predicates. Its preparation tool
accepts exact stock/0.34/final bytes, validates every input before writing, and
guards all three final file hashes at API/worker startup. The stock fixture
runtime and earlier archives were not changed. `runtime-application.json` records
the two files changed when upgrading the local 0.34 dependency.

Worker clearing requires an actual target read in the entered pre-constructor
frame and the matching creation event. Parent validation derives creation
targets, requires exact old-root reset provenance, checks zero-before new slots,
and binds deletion/Amsterdam finalization separately. Historical CREATE2 now
retains the actual canonical 32-byte `creationSalt`. Query overlays carry the
original reset but cannot retain additional mutations. Host/proof failures still
withhold measurements and roll back the entire attempt.

## Validation

The full engine suite passed 1,034/1,034 in 64.343 seconds; the full application
suite passed 720/720 in 71.948 seconds. Both exact logs are retained. Focused
groups cover root CREATE, internal CREATE/CREATE2, constructor and ancestor
rollback, nonce/code collisions, genuine proof/host failures, fee and
authorization overlays, terminal destruction, before/after queries and forged
parent inputs across Shanghai, Cancun, Prague, Osaka and Amsterdam. The wrapper
getter reads 0 before deployment and 42 afterward. The existing fixture root
helper does not understand reset rows; the new independent comparison uses a
separate reset-aware full-allocation reconstruction.

Early worker controls exposed an obsolete unsupported assertion and a test that
read through an intentionally failed input collector. Early lifecycle controls
needed the sanitized host error and Amsterdam's no-child collision representation.
The first/final logs are retained; these were test corrections. Parent validation
also tightened an inherited historical collision predicate. No failing capture
case was removed or replaced.

Seventeen pure/driver preparation controls passed, including actual harmless
Node timeout/output-overflow subprocesses, altered arguments/hashes, false
closure/PID claims, unsupported execution labels and malformed/reset deltas.
Pre-execution review corrected a driver variable-shadowing error, added exact
written-file identity tracking, process PID binding, explicit comparison pins,
exact capture inventory and a positive timeout remainder. These fixes preceded
the first product capture. Review records and exact logs are retained.

## Six unchanged inputs against saved EELS

The capture freezes 3,902 source/dependency files (24,011,808 regular-file bytes),
the actual Node executable identity and six exact initial declarations before
dispatch. It includes both complete dependency trees and initial-only fixture
builders. No reference output or expected poststate is read by the worker.
Every product case ran once. Six were observed; none was unavailable or skipped.
The run took 3.110 seconds and retained 193,715 stdout/stderr bytes. All actual
execution children closed and all brokers had zero pending reads.

| Input | Product charged gas | Saved EELS charged gas | Seven channels |
| --- | ---: | ---: | --- |
| Root CREATE, storage-only target | 175,718 | 175,718 | All match |
| Internal CREATE2, storage-only target | 178,046 | 178,046 | All match |
| Root CREATE, absent target | 359,318 | 359,318 | All match |
| Internal CREATE2, absent target | 361,646 | 361,646 | All match |
| Root CREATE, empty-storage target | 175,718 | 175,718 | All match |
| Internal CREATE2, empty-storage target | 178,046 | 178,046 | All match |

The seven channels are execution status, return data, charged gas,
single-transaction block gas, full poststate root, target state and logs.
All 42 channel comparisons match. The two storage-only targets finish with
balance 22, nonce 1, deployed runtime, slot 2 = 42 and slots 0, 1 and 991 = 0.
The original storage roots and complete initial allocation roots are reconstructed
before applying any reset; new slots are applied to an empty storage namespace.
The complete resulting MPT root is then recomputed independently of the worker's
sparse account root.

Plan SHA-256: `b46ed5f4a52277deef9c491240a6bffed3309e6091515d1e227ec8783d9c25c0`.
Capture manifest SHA-256: `3acd079c3063d32ceded9e022d70498ca77bf317f70ea72c16ce0622cc747f1b`.
Raw product reports are `capture/001.stdout` through `capture/006.stdout`;
`comparison.json` retains both normalized observations and every comparison.

The earlier pinned EELS comparator revalidates its saved state/receipt/log roots
and prior client records. EELS, Geth and stock EthereumJS were not rerun. Earlier
client disagreements and original root-wrapper failures remain unchanged.
EELS is the independent execution path; MPT/RLP/hash primitives and some fixture
and parser code are reused. This is not a new independent proof-path audit.

A separate artifact review reproduced the comparison byte for byte, joined all
30 parsed input records to the saved broker records, and separately walked the
two storage-target account proofs. It also checked derived creation addresses,
committed reset provenance, prefunding and recorded process closures. The full
scope and limits are retained in `peer-artifact-review.json`; it does not replace
the complete product proof validator or independently census OS descendants.

The development API closure was loaded and checked without starting a server.
Its 1,725-file source/runtime identity is
`8aa1afe194876bad672f12d16ce956fb0352b373b535215dca1851d9f46012b1`,
retained in `candidate-identity.json`. The installed checkout remains clean with
its prior two-file runtime patch; `installed-health.json` confirms the existing
read-only 0.34 service. No new public-chain simulation was made in this integration.

The product uses the unsigned priced equivalent of EELS's signed transaction.
These are known synthetic development cases with inert system scaffolding, not
public-chain transactions or a representative accuracy sample. The independent
packet covers successful Amsterdam deployments; historical-fork and rollback
gas behavior still needs independent execution validation. No all-fork accuracy,
consensus/finality, complete effect discovery or superiority to Blockaid is claimed.
