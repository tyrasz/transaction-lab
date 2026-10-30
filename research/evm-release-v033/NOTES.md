# Release 0.33 validation

This release corrects Amsterdam gas reporting and closes a false-completion
boundary for contract creation at accounts with zero nonce, empty code and
nonempty storage. The local library calls these collisions, while the pinned
independent client and execution-specification source enter creation and differ
on old-storage treatment. This case remains unsupported; it is not counted as
newly accurate transaction coverage.

`preRefundGasWithFloor` replaces the ambiguous Amsterdam `blockGasUsed` scalar.
`singleTransactionBlockGasUsed` is the maximum of that transaction's regular and
state dimensions. Charged `gasUsed` and historical output remain unchanged.
The retained independent Geth authorization case binds 250,606 charged/scalar
gas to 218,790 single-transaction block gas. Arithmetic examples also establish
why summing transaction maxima does not calculate a whole block's gas.

The new creation boundary is tied to actual account reads. Amsterdam internal
creation checks after the actual creator nonce write; entered root/historical
creation binds its collision to the same frame's target read. A latched host
failure restores every checkpoint, including outer nonce, authorization and fee
preparation, even when an ancestor catches a child or later reverts. Parent
validation independently rejects a fabricated completed storage-only collision.
Normal account reads, pre-access failures, genuine nonce/code collisions, and
empty or authenticated reset creation namespaces have positive controls.

Testing found a separate incomplete-authorization issue: an entered root's gas
was compared with its pre-authorization budget after a host failure. The parent
now folds the authorization list over verified starting facts to derive entry
gas, without needing a recipient-only proof or claiming retained preparation.
Forged gas, settlement metadata and state changes remain rejected.

## Validation and retained failures

- The final full engine run passed **980/980 tests** in 31.930 seconds.
- The full application run passed **717/718** in 54.190 seconds; its sole failure
  was an outdated assertion in the storage-only API test. Such measurements are
  explicitly `not_attempted`, rather than query failures. Correcting that test
  yielded **10/10** passing Sepolia application checks, including the failed case,
  in 11.788 seconds. Thus all 718 distinct application checks have passing final
  observations; the logs preserve both runs rather than presenting a fictional
  all-green full rerun.
- The earlier application run had 26 localhost-listener sandbox failures and
  one stale unsupported-response assertion. It is retained. The subsequent run
  used the required localhost permission; no application code bypass was added.
- Focused storage-boundary tests passed **11/11 groups**, covering 27 fixed
  scenarios and 13 shared-library signed comparisons only for undisputed paths.
- Direct parent controls passed **7/7 groups** using fabricated traces and
  independently verified synthetic proofs. They are not recorded executions.
- Incomplete-authorization parent controls passed **5/5 groups**, including ten
  actual isolated workers and eight forged response controls.
- Initial gas/creation expectation failures and the actual pre-fix incomplete
  authorization child payload remain alongside the passing correction logs.

Read-only peer review checked current account/reset facts, target-read binding,
the popped-frame host-failure latch, preparation rollback, and independent entry
gas derivation. This is bounded implementation review, not a second EVM or proof
of universal correctness. Dependencies and the browser code are unchanged.

The candidate on port 5175 returned version 0.33.0 and all three optional engines
available. Its 1,724-file production/dependency identity is
`4f2bc1a6c8bc39907eaab33b7a8d58ff132cfd2b20309bba655f151b45efcf90`.
The [fresh live Sepolia observation](../sepolia-api-live-v033/NOTES.md) succeeded
for exactly 0.001 test ETH with 21,000 gas. It uses a public address without a
signature or broadcast and does not establish a general EVM accuracy percentage.
