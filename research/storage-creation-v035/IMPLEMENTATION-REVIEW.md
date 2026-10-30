# Storage-only creation: implementation review

Read-only review on 2026-10-30 of the v034 implementation at commit `b2c2c4d0b71e165aa7a1d475b1d8d12de7864ae7`, now on development branch `codex/evm-coverage-v035`. No production/dependency edits, VM/client executions, or network requests were made for this review. Paths below are relative to the repository; line numbers describe the reviewed bytes.

This document maps three possible rules to implementation work. It does **not** select the correct rule or treat agreement with Geth as consensus evidence. The earlier [source investigation](../amsterdam-storage-creation-v033/SOURCES.md) records the distinct EJS collision, Geth preservation, and EELS clearing hypotheses and its source-acquisition limitations. Current official-fixture/EELS investigation is separate work.

## Present boundary

The disputed account has current nonce zero, empty code, and nonempty storage. Balance does not decide collision, but does affect EIP-161 emptiness and Amsterdam account state-gas charging.

- `creation-support.js:8–18` identifies that account and creates `LOCAL_CREATION_STORAGE_UNSUPPORTED`.
- `creation-attempt-observer.js:149–156` stops Amsterdam internal creation after the actual creator nonce write and first target read. This occurs before the EJS no-child collision return.
- `execute.js:199–206,319–326` binds root/historical entered collisions to the account actually read, then latches an unsupported host failure. The guarded checkpoint unwind restores the whole attempt, including outer preparation. An enclosing catch or REVERT cannot turn it into a completed result.
- Independent parent checks reject the same case in `creation-attempt-validation.js:101–109,132–137` and the historical branch of `execution-changes.js:109–121`. Successful deployment additionally requires an initially empty trie through `deployableFact` (`execution-changes.js:39–43,429–438`).
- `proof-state.js:116–138` currently makes `clearStorage` an assertion, not a clear operation. Only initially empty or previously authenticated-reset namespaces can acquire a creation marker. Account `storageRoot` remains a namespace anchor, not a recomputed trie root after each slot write.

Ordinary CALL, genuine nonce/code collisions, and failures before a real creation attempt remain separate supported paths. Disabling one guard alone cannot enable the disputed behavior consistently.

## Runtime paths that must agree

Pinned EJS 10.1.3 has two collision checks:

1. `node_modules/@ethereumjs/evm/dist/esm/evm.js:656–677`: root CREATE and entered historical internal creation test nonce, code **and storage root**. Successful entry then calls `clearStorage` before `newContract`, nonce initialization, endowment, and constructor execution.
2. `.../interpreter.js:980–1046`: internal CREATE/CREATE2 first perform depth/balance/nonce checks, warm the target where active, and write the creator nonce. Under EIP-7928, the nonce/code/storage collision at 1009–1018 returns zero without entering a child. The collision consumes the forwarded regular grant and refunds the recorded account state precharge.

Transaction creation has only CREATE; CREATE2 is internal. Historical internal creation enters a child before the first check, whereas Amsterdam can reject without a child. Changes must preserve this trace/accounting distinction. Root account state precharge (`evm.js:610–635`), opcode precharge/63-of-64 forwarding, constructor failure, and code-deposit charging must not be replaced by a synthetic success/failure result.

## A. Support storage-only collision

This is the smallest implementation change **if independently established as the selected fork's rule**.

- Keep the two EJS predicates. Replace the two unconditional product unsupported guards with trusted network/fork policy checks. Do not widen activation just because the installed library applies its predicate unconditionally.
- Parent collision validation must accept a proven nonempty **current namespace** as a third collision basis. Amsterdam already retains `targetBefore.storageRoot`; authenticate it against inputs plus the chronological starting overlay. Historical entered/root paths need the equivalent current-state check, including queries after an authenticated reset. Do not infer a collision from an undemanded slot map being empty or from a child's claimed storage root.
- No storage-clear/reset schema is needed. The target's old account/storage remains unchanged. Preserve creator increment on a caught internal collision, but discard it when its enclosing creator frame reverts. Root transaction nonce, retained authorization preparation, and priced fee settlement follow the normal completed EVM-failure path, rather than today's whole-attempt unsupported rollback.
- A getter that catches a collision may still be rejected if its creator nonce persists. A nested getter that rolls that increment back and returns successfully can become measurable under the existing nonce-only query rule. Do not allow mutating getters merely because the collision is now understood.

## B. Support deployment preserving old storage

- Change **both** EJS collision predicates to the established nonce/code rule for the approved forks. The existing `clearStorage` call must become a deliberately authorized preservation operation in the proof manager; a general-purpose clear must not silently become a no-op for every caller. The current assertion-only implementation cannot just be left in place: `assertDeployable` rejects the original nonempty root and any nonzero loaded overlay slots.
- Give `beginContractCreation` an internal trusted policy that accepts nonce-zero/code-empty existing accounts with retained storage. Keep balance and old root, add the creation marker, then let the runtime perform nonce initialization/endowment/code installation. Keep absent/empty-storage behavior unchanged. Generic `putAccount` root/code replacement remains prohibited.
- Keep lazy slot proofs against the authenticated old trie. Constructor SLOAD must see old values; SSTORE's before/original values must come from the appropriate proven transaction namespace. Untouched slots are retained implicitly by the original trie, not enumerated as zeroes. Existing non-reset `snapshotChanges` already emits sparse before/after slot deltas, including nonzero before values (`proof-state.js:310–316`).
- Relax **only provenance-authorized deployment** restrictions: `canonicalStateChanges` currently requires zero-before storage alongside runtime installation (`preview-mutations.js:97–102`); parent `deployableFact`, creation entry/attempt joins, and successful-creation checks also require an empty root. These must validate nonce/code eligibility while binding every changed slot's before value to its proof. A code-bearing delta alone must not authorize preservation.
- Same-invocation SELFDESTRUCT finalization also needs adjustment. Both manager finalizers (`proof-state.js:188–221`) and parent deletion/clearing checks currently require initially empty deployment storage. A created account on a retained old trie must qualify through authenticated creation provenance; later deletion/Amsterdam clearing removes that entire trie with the existing correct fork-specific balance treatment.
- Preserve root/constructor/enclosing rollback: a failed constructor restores old storage and endowment; a caught internal failure retains its creator increment; a reverted ancestor restores that increment too. Query copies must retain the original successful deployment overlay and lazy old-namespace facts. Net mutation validation remains exact.

## C. Support deployment clearing old storage

This requires the same two runtime predicate changes as B, plus an actual storage-namespace transition.

- Add an internal creation-specific clear operation/policy at the existing pre-constructor `clearStorage` point. Preserve the account's prefunded balance and eligible nonce/code, replace its current storage root with the empty-root anchor, and erase/mask every old slot, including undemanded slots. Then install the normal creation marker and let EJS initialize nonce/endowment/code. `#resetAccount` is not a drop-in: it also clears code/nonce, deletes creation/authorization markers, and can make the account absent.
- Introduce an explicit basis such as `contract_creation_storage_clear` with the immutable `initialStorageRoot`. It is not a prior SELFDESTRUCT/deletion and must not borrow those bases. Bind it to one actual entered creation at the derived target under trusted fork policy, after collision eligibility but before constructor instructions. The checkpointed state must distinguish a pending pre-constructor clear from arbitrary manager calls.
- Reuse the existing reset machinery's useful guarantees: old proof results seed only ancestor namespaces that still own them (`loadSlot:59–65`); cleared reads never resurrect old slots (`getStorage:80–83`); snapshot reset rows start at zero and retain every final nonzero new-namespace slot, even one equal to its old value (`snapshotChanges:295–308`). Extend its finite basis checks, checkpoint/copy state, and code-installation eligibility accordingly.
- Parent `validateExecutionChanges:333` currently rejects **all** surviving reset rows in the original invocation. Replace that with a specific, independently justified creation-clear path. `preview-mutations` must recognize the new exact shape; the parent must bind the old root, constructor/target/commit, zero-before new slots, unchanged prefunding plus proven endowment, and nonce/code output. A sparse list of overwritten slots cannot prove the entire old trie was removed. Amsterdam chronological validation must preserve the pre-clear `targetBefore` evidence, then advance its current namespace to empty.
- Resolve and test original-storage gas semantics explicitly. The EJS `OriginalStorageCache` lazily reads the manager and is not checkpointed; generic `SimpleStateManager.clearStorage` intentionally leaves it intact. A proposed implementation must not return old original values for slots demanded before clearing and zero for equivalent slots first demanded afterward accidentally. Choose/cache the original baseline mandated by the selected rule, including SSTORE refunds/state gas and rollback, rather than copying an account-reset implementation on faith.
- Finalizers must compose with a creation clear without dropping the authenticated original root. Constructor and ancestor rollback must restore the old trie, pending markers, balance and nonce. After-query copies may carry the authenticated original clear; they may not add an unproved reset or discard original deltas. A query's transient clear/deployment is allowed only if fully reverted before its successful return.

## Required integration controls

Use root CREATE and internal CREATE **and** CREATE2, across each approved fork boundary; do not infer historical behavior from Amsterdam alone. Existing tests in `amsterdam-storage-collision.test.js`, `storage-creation-parent.test.js`, `reset-preview.test.js` and `amsterdam-clearing-parent.test.js` cover useful boundaries but deliberately assert today's unsupported behavior.

Minimum additions are: balance-zero versus prefunded targets; nonce/code collision controls; static/depth/balance/nonce/gas fail-fast; constructor success/REVERT/OOG/code-deposit failure; caught failure and enclosing rollback; repeated/reentrant targets; exact creator/outer nonce retention; priced fees and authorization retention; created SELFDESTRUCT with later refill; lazy hidden slots, overwritten nonzero slots and old-equal new writes; before/after queries with neutral rollback versus retained mutation; and parent forgeries omitting/resetting the old-root or changing target/attempt/provenance. Root and internal failure gas must be checked separately.

The existing sentinel gives a concrete discriminator. Starting with balance 17, nonce 0, empty code, slots `0=999,991=123456`, its constructor copies slot 991 into slot 1, writes `2=42`, and receives value 5. Ignoring unrelated settlement:

| Rule | Target result | Final slots 0 / 1 / 2 / 991 |
| --- | --- | --- |
| A | Collision; target unchanged | 999 / 0 / 0 / 123456 |
| B | Deployed, nonce 1, balance 22 | 999 / 123456 / 42 / 123456 |
| C | Deployed, nonce 1, balance 22 | 0 / 0 / 42 / 0 |

These are conditional rule consequences, not captured results or a correctness vote. Shared-EJS comparisons test integration consistency; independently sourced activated-fork fixtures/specification and separately retained client observations establish a stronger rule-specific basis. No EELS execution is claimed here.

## Runtime identity and reviewed pins

B/C modify a file already protected by the v034 delegation patch guard. Compose a new reproducible patch and manifest that preserves all three exact-23-byte delegation checks, pins both modified collision files, and rejects unknown bytes. Update startup/worker runtime assertions, source closure and disclosed patch identity together; an ad hoc node_modules edit will correctly fail the existing guard. Keep stock comparison dependencies and all prior captures untouched. Capabilities/help must describe the finally selected fork-specific creation rule only after the full path is validated.

SHA-256 of reviewed files (engine-relative except where noted):

| File | SHA-256 |
| --- | --- |
| `creation-support.js` | `5c92fed2708d472ea69c7efe8064844303a946cce59a7e813df7b9a47f9d9a34` |
| `execute.js` | `fb7db0e62a6c850ab4bcee4c6d64e828e6f6f38c3c6e69bb2d319736492cf361` |
| `creation-attempt-observer.js` | `1f421988f908c01b628a486b3419db446429daf41844f0d8751e767eed691ff4` |
| `creation-attempt-validation.js` | `bb9fe76e3be652c576a02faa849db3a64bad38cb9fd061960ddcc86607f65c74` |
| `proof-state.js` | `a917ca47f007e2d51fb930e6c898f3d54887390a9872dfceeed7748bff0b2ada` |
| `execution-changes.js` | `a1b44305110f7b5640c6d1914c0d674425118b4b1095679895e22fa21f2a518e` |
| `preview-mutations.js` | `accf3bf24294fc8fc6a79ea284e4c807edfedf8c7aed2a344191c5f11a5087d8` |
| `ethereum-preview.js` | `cdf093c694e621bfa75d16515c93c62014fc4d1b8daae821c837fcae235aecff` |
| `isolated-call.js` | `6c78935865666314a84ac005120c3eb450ffc88a478d3380dee601c3f8db1581` |
| `delegation-runtime-patch.js` | `2b22c4bd47a5a4faac903559394dce84d7527bf866ac518c711ebbc2ecff2a59` |
| `node_modules/@ethereumjs/evm/dist/esm/evm.js` | `fcc46a02ca958fcdb9a74626f532e9181165e056bef467a3ad40c631310ac440` |
| `node_modules/@ethereumjs/evm/dist/esm/interpreter.js` | `27106c4194446a01eb6207a2c5158e13eb242fc6cbb7e180d4b937cd87ba6499` |
| `node_modules/@ethereumjs/evm/dist/esm/opcodes/gas.js` | `b014bb84c89c87a222e990ef10dffd6b91ee1eb19ab58539d2d6bc6763680970` |
| `node_modules/@ethereumjs/statemanager/dist/esm/simpleStateManager.js` | `f0ed9a71aa368cdbb7365b7dddc90c317750555cc4e0cec8a9524708f5c96920` |
| `node_modules/@ethereumjs/statemanager/dist/esm/cache/originalStorageCache.js` | `be5bbb9d858c8213d313dfaabd6015b1ae56e5937381810c26439ec2cf65abdd` |
