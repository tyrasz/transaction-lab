# Standalone Amsterdam contract clearing

The proof-backed state manager now has a separate explicit EIP-8246 clearing operation. It resets code, nonce and the complete storage namespace while preserving the exact residual native balance. Zero balance produces an empty absent account; positive balance survives. Old deletion methods and defaults remain unchanged.

The method requires an exact trusted Amsterdam mode, a rollback checkpoint and authenticated creation eligibility. It consumes creation and authorization markers, retains immutable initial storage-root provenance, and supports rollback, settled copies and later recreation. A caller must still bind its invocation-local committed created/selfdestruct intersection: manager markers alone are not that proof.

Eight new controls and the legacy deletion/reset/query controls pass (68 total), with a separate independent 29-control review. Real synthetic Amsterdam bytecode tests cover self-beneficiary constructor clearing, prefunding, endowment, later balance refill, repeated selfdestruct, root revert and later CREATE2 reuse. Four initial failures came from two fixture setup errors; that first log and the corrected run are both retained.

The executor, parent lifecycle/native-value validators and query validators do not yet select or admit this new clearing basis. Public Sepolia execution remains unavailable. These tests establish the standalone manager behavior, not end-to-end or independent-client equivalence.
