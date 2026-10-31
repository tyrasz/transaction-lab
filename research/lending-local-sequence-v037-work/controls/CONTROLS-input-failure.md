# Input availability classification controls

The sealed V037 captures remain unchanged. Their unavailable first originals
were recorded with `LOCAL_EXECUTION_FAILED`; their input collector already
recorded `RPC_STATE_INPUT_UNAVAILABLE`. The raw captured provider error is the
evidence for historical-state unavailability. The new public message does not
infer or expose that provider-specific reason.

The current-source fix in `engines/local-evm/execute.js` recognizes only an
actual `RpcStateInputError` instance with code `RPC_STATE_INPUT_UNAVAILABLE`.
It reports `LOCAL_INPUT_UNAVAILABLE` with a fixed local message. The worker and
executor import the same collector module, so the actual offline isolated
worker controls exercise this class identity before IPC serialization.
Unknown exceptions, same-name/code lookalikes, invalid proofs and unknown typed
codes remain generic. Rollback-failure precedence is unchanged.

First focused run: `input-failure-propagation-first.tap`, 1/3 passed, 2 failed.
Both failures were test assumptions requiring `rolled_back` for an error before
any checkpoint; actual `unchanged` was correct. The tests now bind that exact
disposition for first-read failures and `rolled_back` for a later invocation.
The direct adapter counter assertion was also corrected to use its existing
`snapshotUsage()` method before the second run.

Second focused run: `input-failure-propagation-focused-second.tap`, 21/21 passed,
5.72 seconds. It includes the new three controls and the two existing Amsterdam
suites whose three exact code assertions intentionally inject proof-read
failures. Their parent tamper, preparation, fee and lifecycle checks remain.

The new controls cover first-proof failure across a real isolated worker,
second-original failure preserving the validated priced prefix and rolling
back only that invocation, later steps skipped, null measurements and execution
amounts, no leaked remote message, worker closure and broker drainage, and six
direct host-error variants including invalid-proof and spoofed error objects.

These are deterministic offline synthetic-fixture controls. There were zero
public calls and no rerun of either real lending sequence or independent client
reference. No frozen source packet, capture or loader inventory was modified.
