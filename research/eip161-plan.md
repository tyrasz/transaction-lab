# EIP-161 cleanup design for the proof-backed unsigned message profile

Research completed against the pinned EthereumJS 10.1.3 packages on 2026-10-28. This is a design and implementation checklist, not a live-chain result. No public RPC was used. Version 0.18 production remains unchanged.

## Applicable rule

[EIP-161](https://eips.ethereum.org/EIPS/eip-161) defines an empty account by zero nonce, zero balance and empty code. Storage is deliberately not part of this predicate. Cleanup happens at transaction end, after SELFDESTRUCT finalization; ordinary reverted touches do not justify deletion. The earlier [EIP-158](https://eips.ethereum.org/EIPS/eip-158) text contains alternative definitions/algorithms and explicitly discusses storage-bearing accounts with otherwise empty fields. Its immediate-deletion/sweeping alternatives must not replace EIP-161's finalization rule. The [2016 consensus incident](https://blog.ethereum.org/2016/11/25/security-alert-11242016-consensus-bug-geth-v1-4-19-v1-5-2) explains why rollback behavior is material.

## What the pinned implementation actually does

The local and fixture engines both use EVM 10.1.3. Their `journal.js` bytes match, SHA256 `664ee68ebc39fb3a1c0ec6aabf4de45eb7fc856be2d9213a7b828ec16b04780d`.

- `@ethereumjs/util/dist/esm/account.js:isEmpty()` ignores `storageRoot`.
- `@ethereumjs/evm/dist/esm/journal.js:putAccount/deleteAccount` mark touches. Warming an address or storage key does not.
- `journal.revert()` removes frame-local touches except address `0x0000000000000000000000000000000000000003`, the RIPEMD160 precompile. This is a pinned compatibility exception, not a license to retain other reverted touches.
- `journal.cleanup()` visits retained touches, deletes absent/empty accounts through the state manager, then resets its journal. It does not independently erase a state manager's cached code/storage.
- `evm.runCall()` increments the root sender nonce before its message checkpoint. A completed EVM REVERT or exceptional halt retains that increment. It commits/reverts nested checkpoints but does not invoke `journal.cleanup()`. `postMessageCleanup()` only clears transient storage.
- `_executeCall` journals both sender and actual execution destination for non-DELEGATE calls, including zero value and STATICCALL. CALLCODE's execution destination is the caller's execution account. DELEGATECALL's code target is not touched merely by executing its code. SELFDESTRUCT journals a distinct beneficiary even for zero balance. CREATE target collision returns before its target account is journaled.
- Signed `runTx` refunds the sender, credits the miner (including a zero fee), processes SELFDESTRUCT, then invokes journal cleanup before final receipt work. Our unsigned profile does not settle fees and must not silently acquire this extra coinbase touch.

Six scratch executions against these installed packages confirmed: committed zero-value CALL and STATICCALL delete an existing empty account; BALANCE-only does not; ordinary root REVERT restores its touch; an OOG RIPEMD160 call remains touched even if its parent root reverts. The same scratch account had a nonempty storage root and a cached slot equal to 42: bare SimpleStateManager cleanup removed the account but left the slot readable. Reverting an enclosing state checkpoint restored the account and sender nonce. These are synthetic source-behavior checks, not official-vector or provider agreement.

## Minimal state/execution change

1. Admit authenticated existing empty accounts without converting them to absent. Reading, proving or warming an account alone must preserve existence.
2. Keep the existing outer atomic checkpoint. After root `runCall` and committed CREATE/SELFDESTRUCT finalization, snapshot the actual retained journal touch set, open an explicit empty-cleanup window, invoke the real pinned `journal.cleanup()`, and close the window. This also runs for completed EVM revert/failure. Unsupported input, exhausted limits, proof failure or host failure rolls back the entire outer checkpoint, including nonce and cleanup.
3. Permit `deleteAccount` only in this window and only when the current account is undefined or `isEmpty()`. An absent no-op produces no deletion evidence. An actual existing-to-absent transition masks the entire account, code and storage namespace, including unrequested slots, using checkpointed reset/deletion provenance.
4. Whole-account deletion does not require enumerating its storage trie. The authenticated initial account leaf binds its prior root. Report that complete namespace removal explicitly; do not invent an exhaustive per-slot diff or a recomputed post-state root.
5. Preserve immutable input proofs. Reset markers must survive commit/copy, roll back on revert, and prevent lazy old proofs or original-storage caches from resurrecting deleted values. Fresh query invocations get fresh original-storage caches. Any positive rematerialization after cleanup of an initially nonempty storage root remains unsupported until snapshots can represent the retained storage-reset provenance; existing support for initially empty roots remains.

## Parent/output contract

Optional `output.lifecycle.emptyAccountCleanup`, emitted only for actual deletions:

```json
{
  "basis": "eip161_transaction_end",
  "scope": "unsigned_message_touches_no_fee_settlement",
  "touchedAccounts": ["<sorted unique actual retained journal addresses>"],
  "deletions": [{
    "address": "<address>",
    "scope": "entire_account_including_code_and_storage",
    "initialStorageRoot": "<authenticated original root>"
  }]
}
```

Existing `lifecycle.finalizedDeletions` continues to describe same-invocation CREATE/SELFDESTRUCT only. An initial empty account deleted by EIP-161 has a net row consisting of its address and `existence:{before:true,after:false,basis:'eip161_empty_account_cleanup'}`. No fabricated nonce, balance, code or individual storage deltas accompany whole-account deletion.

The parent must validate full recursive execution-address/caller bindings, proof existence/empty fields/root, sorted bounded metadata and the exact matching deletion rows. It independently identifies eligible retained CALL/STATICCALL destinations and SELFDESTRUCT beneficiaries; mere reads, warmed addresses and delegated code targets are excluded. Ordinary failed ancestors remove eligibility. RIPEMD160 eligibility may survive failure only for an entered CALL/STATICCALL with a known post-touch outcome, or a successful own-frame SELFDESTRUCT beneficiary transfer, even beneath reverted ancestors. Insufficient balance/value overflow/creation collision must not become invented sticky touches. A retained positive call into an initially empty account is incompatible with claiming its empty cleanup unless a supported creation/state transition explains it.

Do not demand an invented exact trace-derived set for every journal touch. Require actual declared touches to be bounded, proof-bound and trace-justified, all required initial-empty deletions to be represented (or explicit surviving positive/created state), and no unsupported deletion. A nonce escape is permitted only for the expected root sender or validated creation state. A positive balance escape must equal the bounded native-value flow derived from authenticated starting balances, entry CALL/CREATE transfers, ordered children and terminal SELFDESTRUCT. In particular, a newly created self-beneficiary burns its balance immediately, can receive new funds before finalization, and burns any remaining refill at final deletion; a preexisting Cancun self-beneficiary retains its balance. This remains a parent result-consistency check, not independent execution.

Root revert validation becomes exact sender nonce increment plus justified RIPEMD160 empty cleanup, not arbitrary state changes. Sender nonce makes an initially empty sender nonempty; it is not itself cleaned up.

## Query/copy behavior

Validate lifecycle against the query's starting overlay as well as immutable facts. Original deletion rows must remain byte-semantically present in before/after snapshots. An after-state query of an already deleted account must not load its old storage or claim a second deletion. A query causing a new real deletion is state-changing and its measurement stays unavailable. Normalize only the expected query sender nonce. Disposable query copies cannot mutate the original execution, its evidence or its reset metadata.

## Release controls

- Actual bytecode: zero CALL, STATICCALL, SELFDESTRUCT zero beneficiary, positive funding, plain BALANCE/EXTCODEHASH/access-list warming; initial empty storage-root and nonempty storage-root fixtures.
- Rollback: ordinary child/root revert and OOG; RIPEMD160 child OOG caught/root REVERT; other precompiles must not inherit stickiness; host/proof/limit failure during cleanup restores all state.
- Creation: existing zero-balance empty target, prefunded target, storage-only collision, created-then-deleted absent and existing targets, surviving runtime/nonce, no double classification.
- Reset: known and never-read slots return zero after deletion; checkpoint/revert/copy and a later funding operation preserve reset semantics; no new proof is used to resurrect old state.
- Parent tampering: missing/extra/duplicate cleanup rows, wrong roots, untouched/BALANCE-only/code-target deletion, context laundering, deletion below reverted ordinary ancestors, false sticky insufficient-balance/value-overflow, omitted positive balance, nonce tampering and hostile metadata objects.
- Preview: unchanged inherited whole-account deletion accepted, new query deletion rejected, fresh nonce-only query accepted, original result immutable.
- Differential synthetic signed `runTx` control with fee effects isolated explicitly; do not claim full signed transaction equivalence from this unsigned profile.

Production changes belong only to the separate v0.19 worktree. No claims of full EIP-161 support should be published before the state, execution, parent, query and rollback controls pass together.

## Implemented parent slice and validation

The authorized v0.19 parent slice is implemented in `execution-changes.js`, `preview-mutations.js`, and the query overlay arguments in `isolated-call.js`. New `test/empty-cleanup-parent.test.js` has 13 passing controls, including real child execution and coordinated IPC mutation attempts. The complete local suite passed 359/359 before the final self-beneficiary ledger correction; the corrected ledger then passed all 13 focused controls, including the five-then-seven burn/transfer regression. Final integrated review and release remain the root task's responsibility. No live evidence or production v0.18 files were changed.
