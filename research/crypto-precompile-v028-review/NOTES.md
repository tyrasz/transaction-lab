# Version 0.28 release verification

The release adds owned BLS12-381 and P-256 input/error handling over the existing pinned Noble arithmetic. Unexpected crypto failures cannot become catchable EVM failures or normal invalid signatures. The transaction API exposes no custom verifier option. Independent source review found no blocker in field bounds, curve equations, subgroup/infinity rules, scalar reduction, fork activation, gas handling or sticky host-failure rollback.

Final source regression results:

- `local-controls.tap`: 675 passed, zero failed; 35.496 seconds. This includes the twelve new BLS groups and twelve P-256 groups.
- `application-controls.tap`: 687 passed, zero failed; 50.188 seconds. Five new parent/API groups execute the real isolated child over authenticated synthetic proofs, including fresh before/after queries and final-header withholding.

The root independently rederived every P-256 vector/result association, checked all 1,669 evidence entries, matched the original vector bytes to the pinned Geth source inventory/checkout, and confirmed the released adapter equals the archived adapter. `p256-verification.json` retains that artifact-only result. The producer's separate verifier also passed. No target was reexecuted for review. The original upstream licenses are retained beside the P-256 packet, outside its immutable capture.

The [independent BLS review](../bls-precompile-v1-review/NOTES.md) separately checks both captures, the unchanged 928-vector upstream inventory, all 1,856 declared rows, unsupported bounds, and exact raw execution outcomes. Its corrected result is 1,838 matched and eighteen unsupported, with no mismatches, unavailable results or unattempted rows. The original setup-failure capture remains unchanged and all its admitted execution outputs are null. This harness correction does not alter the cryptographic runtime or expected results.

These fixed development corpora provide component evidence. They do not constitute a representative accuracy estimate, a Geth execution comparison, full signed-transaction conformance, complete asset discovery or cross-chain settlement verification. BLS corpus accounts/headers are synthetic and not proof-validated; the P-256 corpus directly invokes the pure adapter. The separate API tests supply synthetic authenticated proofs.

The independent regression suites and corpus executions made no public RPC request, signed no real transaction and broadcast nothing.
