# Next implementation gap: native HYPE measurements

This is a read-only next-work assessment, not an implemented or validated capability. No production source, captured evidence or execution input was changed; no RPC, VM, preparation or benchmark was run for this audit. Installing or deploying a subsequent implementation is a separate step.

Prioritize measured native HYPE balances for ordinary HyperEVM value transfers and payable contract calls. The current API accepts their unsigned inputs and can return execution evidence, but the measurement adapter excludes them. This is a concrete implementation restriction, not a newly observed execution mismatch. Native HYPE sends and the native side of wrapping, payable swaps and lending entrypoints would benefit; unknown receipt-token balances and HyperCore settlement would remain separate coverage gaps.

## Current restriction

All paths below are relative to the development repository.

- `src/validate.js:31–39` accepts canonical positive decimal `value`; `src/server.js:251–268`, especially line262, passes that exact value to the original fixed-five-million-gas trace at a canonical block hash.
- `src/current-state.js:130` rejects nonzero value. Line133 binds the trace to zero value, line145 requires root runtime code, and line147 hardcodes the original diff request to `value: '0x0'`.
- `src/affected-balances.js:132` independently rejects positive-value requests. Lines138–144 disclose excluded native and unknown-token effects.
- `src/analyze.js:184–225` detects native value but reports that native balance changes and fees are uncalculated. `src/config.js:59–61` explicitly describes the current zero-native-value profile.
- `src/account-effects.js:19–25` is a token-oriented projection that excludes native assets. `src/server.js:53–66` and `:270–285` finalize and publish only existing token/allowance views.
- `test/current-state.test.js:131–146` deliberately rejects positive request value before measurement RPCs. `STATUS.md:466–470` records the narrow current Hyperlend measurement scope.

## Bounded implementation requirements

Native measurements must be additive to the existing Hyperlend USDC, hUSDC and variable-debt semantics. Do not weaken their protocol reconciliation, substitute native flows for token balances, broaden the historical replay profile silently, or infer that an unmeasured token has zero change.

1. Bind the original trace and complete diff to the exact requested value, sender, destination, calldata, gas and selected canonical header. Permit ordinary code-free recipients for native transfers while keeping actual token-query targets classified separately.
2. Derive native candidates and committed net CALL flows with reverted-ancestor handling. DELEGATECALL and CALLCODE do not transfer funds to their code addresses. Require every reported native balance transition, including display-omitted candidates, to agree with the supported flow model. This consistency model alone is not a balance measurement.
3. Anchor selected initial balances through independent pinned reads. Use bounded before/after `BALANCE` witnesses with the complete original overrides; validate exact header context and nonce-only witness mutations. Query-only nonce changes are discarded. After-query validation must use the actual post-execution sender balance, including refunds.
4. Preserve explicit post zero and distinguish it from an omitted unchanged balance. Never invent a missing prebalance. Normalize a newly funded empty recipient only after pinned zero balance, zero nonce and empty-code checks, recording the normalization separately while retaining the original raw diff.
5. Keep code-free sender, unsupported lifecycle, reserved-witness-address and HyperCore boundaries. A new native view establishes only its supported EVM balances; it cannot establish subsequent HyperCore settlement. The default profile remains unpriced, with no signed fee or future-inclusion claim.
6. Reserve RPC and evidence capacity for complete state reconstruction, witnesses and final canonical checks before adding native reads. Retain explicit candidate omissions. Shared canonical, preparation or deadline failures must withhold native and token amounts together; empty or unavailable collections are not zero effects.

## Reuse and next source work

- `engines/standard-evm/native-effects.js:44` exports the pure `collectNativeEffects()` model, including bounded candidates, CALL context, revert handling and display omissions. Reuse this behavior or extract a shared pure helper without silently changing the existing Ethereum path.
- `engines/standard-evm/unsigned-call.js:170–205` supplies the header/native witness pattern. Lines294–361 contain candidate collection, initial anchors, funded-empty-recipient normalization, complete diff reconciliation, sender balance/nonce validation, measurements and omission counts. These are implementation references, not HyperEVM execution evidence.
- Extend `src/current-state.js` and add a dedicated native measurement adapter. Integrate it into `src/server.js:270–285`, extending `finalizeMeasurements()` at lines53–66 so all native rows, including a partial view, lose amounts on a shared failure. Preserve existing Hyperlend token outputs and their separate evidence.
- Add explicit native response fields and HYPE presentation/capability disclosures in the API/UI. Keep measured amounts separate from transfer-event totals and unavailable rows. Do not label the whole transaction fully covered merely because native measurements succeeded.

## Focused tests before a separately declared live check

Reuse the behavioral controls in `engines/standard-evm/test/native-effects.test.js` and `engines/standard-evm/test/native-execution.test.js:46–148`, adapted to chain999 and the actual HyperEVM response schema:

- Positive transfer and a payable contract call with existing configured-token queries; assert exact requested value reaches both original tracers.
- Self-transfer, internal refund, successful nested transfer, caught revert and ancestor rollback; no invented delegate/CALLCODE debits.
- Funding an empty recipient with all three pinned checks; reject missing/contradictory basic state or unsupported creation.
- Explicit final zero, omitted unchanged balance and missing prebalance; reject inconsistent flow/diff evidence and unexpected query mutations.
- Candidate cap and RPC reservation, including a contradictory balance change on an omitted account.
- Late canonical/deadline failure clears all previously measured native and token amounts; original failure remains explicit rather than becoming an empty successful preview.
- Existing Hyperlend supply/withdraw/borrow/repay and permission recorded regressions remain semantically unchanged.

A future live check needs separately frozen inputs and retained outcomes. The existing Ethereum native controls and Hyperlend zero-value recordings do not establish native HyperEVM accuracy, complete asset discovery or production readiness.
