# Amsterdam creation-attempt observation design

Source-only review on 2026-10-29 of checkout `80f086674980d0dd08ddf55ab84dd14b4315738a`. No VM, Geth, RPC, or test targets were executed for this review. No production code was changed. Existing `engines/local-evm/test/amsterdam-collision-boundary.test.js` records the known unsupported case: raw execution succeeds with creator nonce 7 → 9 and one entered CREATE2 frame; the isolated parent returns `LOCAL_ISOLATED_PROTOCOL` with no output/changes. This review read that test; it does not claim a fresh execution or independent-client result.

The smallest useful change is a bounded creation-attempt ledger joined to **actual creator nonce writes**, not a count of CREATE opcodes or entered constructor frames. Keep the current parent equality check until that evidence exists. Initially admit only no-child collisions justified by a nonzero nonce or nonempty code in authenticated/current reconstructed state; leave ambiguous paths unavailable.

## Pinned control flow

Paths below are relative to `engines/local-evm/node_modules/@ethereumjs/evm/dist/esm/` unless stated otherwise. Installed package metadata says `@ethereumjs/evm` 10.1.3; exact bytes, not the version label alone, define this review.

| Source | Relevant order and consequence |
| --- | --- |
| `interpreter.js:211–267,300–324` | `runStep` runs dynamic gas first, then emits `step`, then charges remaining opcode gas and executes the handler. VM errors inside dynamic gas also emit `step` in the catch path. A step is evidence of an attempted opcode, never proof of a nonce increment. The step exposes executing address, code address, account, pre-op stack and old-sized memory snapshot. |
| `opcodes/EIP7928.js:189–290` | CREATE gas checks initcode size, memory/word/hash costs, target-dependent state charge and static context. Pre-target and post-target OOG occur before the interpreter's nonce write. State precharge can precede static rejection in this pinned runtime. Do not infer admission from BAL membership or rewrite these gas rules in the observer. |
| `opcodes/functions.js:1275–1337` | Legacy CREATE/CREATE2 extract value/offset/length/salt; oversized initcode traps, `0xef00` initcode returns zero before `interpreter.create`. CREATE2 forwards to the same `create` implementation. |
| `interpreter.js:957–1027` | Depth, insufficient balance and nonce-overflow fail fast before the nonce write. Target derivation uses executing account and pre-increment nonce, or salt and initcode. Lines 1000–1001 increment and await `journal.putAccount`. Only afterwards, lines 1009–1018 check target nonce/code/storage and return zero on collision, consuming forwarded regular gas and refunding the precharge. **No child `runCall` or `beforeMessage` occurs on that branch.** |
| `interpreter.js:1028–1047,1052–1123` | Non-colliding attempts enter a child; constructor REVERT/OOG does not itself undo the creator increment made in its parent. Parent code may subsequently fail and undo it. Lines 189–197 also contain a pinned exceptional-halt path after creation onto an alive target; parent success must be read at actual frame exit, not predicted at opcode return. |
| `evm.js:1105–1133,1179–1238` | Outer sender increment precedes root message entry. Each message checkpoints after `beforeMessage`, then commits/reverts before `afterMessage`. Therefore creation increments belong to the creator's enclosing frame, not the new constructor checkpoint. |
| `journal.js:34–36`; project `proof-state.js:14,70–72,86–105` | Journal forwards `putAccount` to the guarded manager. The proof manager returns and stores account copies, so the observer can compare the real current account with the candidate write without aliasing the interpreter's mutated account object. |
| Project `execute.js:158–188,216–298,419–425`; `execution-changes.js:108–115,329–364` | Existing guarded manager, frame stack and sticky host-failure rollback supply the observation seam. Current nonce validation counts entered creations under successful parent ancestry. Root sender and prepared authorizations are separate sources of nonce changes. |

Pinned Geth offers corroborating **source semantics**, not a newly executed comparison. `core/vm/evm.go:506–517,550–603` increments the creator at line 566 before collision and before the child snapshot at line 603. Constructor revert rolls back that later snapshot (`:642–647`); enclosing frame rollback removes the creator increment. Geth's tracer enters at `:556–560`, before collision, unlike the EJS child-message trace. Client frame counts are not equivalent evidence. `instructions.go:635–743` shows the CREATE/CREATE2 result-zero/refund handling; `gas_table.go:544–596` rejects static creation before opcode execution.

Two differences must remain explicit: pinned Geth performs Amsterdam depth/balance/nonce checks before its account-creation state charge (`evm.go:530–546`), whereas the EJS gas handler charges before `interpreter.create` fail-fast checks; and the displayed Geth collision predicate (`:589–592`) checks nonce/code, while EJS also checks storage root. Neither equivalence is established here. Do not broaden a nonce-observation patch into a gas or storage-only collision correctness claim.

## Proposed observation and bounded data contract

1. Assign stable preorder frame IDs plus a monotonically increasing opcode sequence. At every CREATE/CREATE2 step, arm an invocation-local candidate on the **current executing frame**, recording frame/code addresses, PC, opcode, depth, static ancestry, creator nonce/balance snapshot and decoded arguments. Copy values immediately; never retain mutable event objects. Bound candidate count separately (proposed 1,000, including no-child/aborted attempts), initcode bytes by the existing 32,768-byte child-input cap, memory by 1 MiB and aggregate serialized evidence by the existing 8 MiB trace cap. Budget excess fails the whole attempt; no truncated successful ledger.
2. Decode stack in VM pop order: value, offset, length, then salt for CREATE2. Keep salt as exactly 32 bytes; CREATE has null salt. Reconstruct the initcode window with zero-extension beyond the pre-expansion memory snapshot. Zero length ignores an arbitrarily large offset; nonzero length needs safe BigInt bounds before allocation. Retain bytes and Keccak hash, not a hash with no reviewable bytes. These are newly observed execution inputs, not authenticated initial state.
3. In the existing guarded `putAccount`, before the underlying write, compare against a fresh copy of the current creator account using the real manager. A matching candidate admits exactly one successful write with nonce `n → n+1`, `n < 2^64−1`, and unchanged balance/code hash/storage root. Correlate only while that frame is active and before entering a child; separately recognize root nonce, authorization and new-account nonce writes. Record only after the write succeeds. Host/deadline/proof failures keep the existing sticky latch and whole-attempt rollback. Extra observer reads must be accounted in state-read evidence/budgets; they are not silently free.
4. Bind the target from `keccak(RLP([creator, nonceBefore]))[12:]` for CREATE, or `keccak(0xff || creator || salt || keccak(initcode))[12:]` for CREATE2. Capture the actual subsequent collision-check account read under the same pending token, including its current nonce, code hash and storage root. Do not substitute immutable pre-state when an earlier constructor or reentrant call changed it.
5. An entered constructor must consume one token and bind its child frame ID, creator, initcode, value, type and derived address. A no-child nonce write can be classified `collision` only with a matching target read that proves the pinned collision predicate and a zero result. Resolve the token at the next step of the same frame (pre-op stack after CREATE), or at frame exit using the retained interpreter run-state stack for an instruction at end-of-code. A frame exit is still required to determine retention. Any unjoined write, duplicate write, unknown no-child reason, missing terminal observation or inconsistent stack result is unavailable.
6. Observed candidates without a nonce write count zero. Retain their bounded diagnostic disposition; do not invent a precise reason from a step alone. No-child collision transfers no endowment, executes no initcode, deploys no code, creates no account and confers no lifecycle/SELFDESTRUCT eligibility. Entered child failure similarly does not deploy code, but its creator increment survives if the creator frame and all ancestors commit.

Suggested serialized entry fields (final naming requires schema review): `index`, `frameId`, `step`, `pc`, `opcode`, `creator`, `codeAddress`, `nonceBefore`, `nonceAfter` (null when no write), `value`, `initcode`, `initcodeHash`, `salt`, `target`, `childFrameId` (null when absent), `disposition`, and the bounded target-account observation. Derive `retained` in the parent; do not trust a child-supplied retained count. Zero-write candidates can use a reduced explicit schema when decoding never completed. Root transaction CREATE is excluded from this internal ledger and retains its existing sender preparation rules.

The manager-write seam avoids replacing or monkey-patching pinned opcode implementations. It is a design proposal, not an implemented or tested hook. If the existing event/writer association cannot be made unambiguous, keep the case unsupported rather than falling back to final nonce-difference inference.

## Parent invariants and trust boundary

- Validate exact data-only schemas, canonical bounded quantities, unique ordered IDs, finite fork selection and every frame association. An incrementing attempt must have no inherited STATICCALL context, even under DELEGATECALL/CALLCODE. Creator is the frame's execution address, never merely its code address. Bound PC/opcode against authenticated running code, known constructor input or previously validated deployed code where available; unknown code provenance stays unsupported.
- Maintain nonce, balance and lifecycle overlays in **execution order**, with frame checkpoints. Each write is `+1` from the current overlay. Merge on frame success, discard on frame REVERT/exception; a constructor's own failure does not discard its creator-frame write. Reentrant changes and constructors that create children require this chronological ledger, not one global per-address sum. Root sender increment and successful authorization preparation form the separate starting overlay.
- For admitted no-child collisions, independently derive the address and justify nonzero target nonce/code from proof-backed starting facts or earlier retained/current-frame effects. A newly created empty-runtime contract still has nonce 1 and can justify a repeated CREATE2 collision. A prior failed constructor cannot justify a persistent target. Reverted subcalls may temporarily contain valid collisions; validate against their temporary overlay, then discard all those effects. Starting query/reset overlays must be bound to the original completed result. A storage-root-only observation without reconstructible current namespace is insufficient for the first implementation.
- Join every entered internal creation exactly once to a counted attempt; use this ledger instead of also adding old entered-frame counts. No orphan attempts or constructor frames. Before lifecycle finalization, nonce equals authenticated/prepared baseline plus committed increments, with new contracts starting at 1. Apply already-validated clearing/deletion effects afterwards; they may erase a final nonce without erasing the diagnostic attempt. Sender aliases, delegation and creation by constructors must use the same accounting rather than extra ad hoc increments.
- Preserve native-balance reconstruction: only successful committed entered creation transfers value. Collision/abort cannot justify a balance change, code deployment, storage row, creation marker or clearing. Failed ancestor removes both descendant native effects and its attempt counts. Fee settlement remains separate.
- This makes the isolated child's trace/state **consistency** checks stronger. A child-supplied step and write ledger is not cryptographic proof that bytecode executed, nor an independent replay. Without opcode/memory replay, parent checks cannot authenticate arbitrary child-reported memory execution from a hash alone. Do not describe the ledger as independently authenticated execution. Independent full-state/client comparisons remain necessary for coverage claims.

## Predeclared validation matrix for later work

No cases in this matrix were run for this memo. Keep the existing unavailable regression unchanged until the new contract is implemented and reviewed.

| Fixed family | Required observation |
| --- | --- |
| Existing repeated CREATE2 boundary | Two nonce-write attempts, one child, one collision; 7 → 9 only after creator/root commit. |
| CREATE and CREATE2 against proven nonce/code collisions | Derived target and exact +1; zero result, no child/transfer/code/lifecycle credit. Include zero and nonzero requested endowment. |
| Constructor REVERT, INVALID/OOG and code-deposit failure | One creator increment retained with successful parent; failed constructor creates no surviving account/code. |
| Same sequences followed by parent/root REVERT | All enclosed attempt increments/state discarded; outer transaction preparation retained under current profile. |
| Nested and reentrant creators, delegated/callcode execution | Correct executing creator, chronological nonce progression and ancestor rollback; no double count. |
| Static ancestor → delegate/callcode → CREATE/CREATE2 | No nonce write; reject fabricated attempts despite altered child error fields. |
| Insufficient balance, nonce max, depth limit | Zero increments; protocol-depth case is component-only if it exceeds the public depth-32 bound. State-charge/gas outcomes remain separately compared. |
| Pre/post-target OOG, stack underflow, oversize/EOF initcode | Step or target access never suffices to count an increment. Public bounds remain unchanged. |
| Empty initcode, last-opcode creation, prefunded target, create-then-clear | Terminal token resolution, nonce-1 collision basis, and correct post-finalization nonce/state. |
| Resealed hostile child packets | Duplicate/orphan/missing attempt, wrong PC/code/creator/salt/target/nonce, forged collision, changed value, missing ancestor rollback, forged terminal stack, unknown fields and evidence-budget exhaustion all rejected without retained completed output. |

Use authenticated synthetic fixtures first. Then separately predeclare a small Geth sequence packet comparing complete state roots and gas/status while allowing tracer-shape differences. Storage-only collisions and fail-fast/state-charge ordering need named differential controls, not silently expanded support or altered expectations.

## Source identities

All SHA-256 values below were recomputed from local files during this review. Project-relative paths use the stated checkout. `EVM/` means `engines/local-evm/node_modules/@ethereumjs/evm/`. `GETH/` means `../evm-toolchains/geth-v1.17.10/`. The four Geth source files also match their entries in the pinned source inventory. The source checkout's other concurrent input-proof edits were not changed or included in this design's source claims.

| File | SHA-256 |
| --- | --- |
| `EVM/package.json` | `8a3c432434a6250963e416156e0387f016db477d95660114c9d595e3602b3b66` |
| `EVM/dist/esm/interpreter.js` | `27106c4194446a01eb6207a2c5158e13eb242fc6cbb7e180d4b937cd87ba6499` |
| `EVM/dist/esm/opcodes/functions.js` | `9a73c68a74d15dd4e6255062cef6b9e575fe0eafd2256948683e3d0556a88440` |
| `EVM/dist/esm/opcodes/gas.js` | `72087f58b0b78e2f5dc7fed7cfa48aeee6000c5dbff4f3d851622f40c5a900c4` |
| `EVM/dist/esm/opcodes/EIP7928.js` | `1294c92cc0f875dda60bfc81c610aef82e8800fbea8f6da4f73a7f36b48f289a` |
| `EVM/dist/esm/evm.js` | `e978f659e72aeb8ee22ebc4559bafb37e4760b0557512224f734b5b46da22f46` |
| `EVM/dist/esm/journal.js` | `664ee68ebc39fb3a1c0ec6aabf4de45eb7fc856be2d9213a7b828ec16b04780d` |
| `engines/local-evm/execute.js` | `6e02d114dc5b4f6591f2261cda3628cee69d76b2c56e2a93e215c2bace31c671` |
| `engines/local-evm/execution-changes.js` | `c2a88949247dd68ffffe18981e57e507fe690330bc30cbc81510f2fc23025567` |
| `engines/local-evm/proof-state.js` | `a917ca47f007e2d51fb930e6c898f3d54887390a9872dfceeed7748bff0b2ada` |
| `engines/local-evm/test/amsterdam-collision-boundary.test.js` | `a86f438651362a55adac14d33f505cb0478f10490659e5bfd6fb3108ba1438a0` |
| `GETH/toolchain-manifest.json` | `791a91bca058b516b21a66097787f96959477958219eaee9dd20e73367b21333` |
| `GETH/source-inventory.json` | `36e245fda711de52fe5e0b8c917d4bbbffd840ed7edfc0696f29cbb1f8b24dff` |
| `GETH/source/core/vm/evm.go` | `42016043f3376a3d8fca94693a0641f775af4010b750310b762a847c1fbbd1a8` |
| `GETH/source/core/vm/instructions.go` | `06027536b7f673b6faae36e76c7789a12cdced522b7fe14e55912e67546ee0d4` |
| `GETH/source/core/vm/gas_table.go` | `c2b6dca8425327a052b6d4eb53852cc113399dae8d69683bc246957dfb032dd4` |
| `GETH/source/core/vm/interpreter.go` | `0b9bf7e732aa253d8b4700754e42ef56ef8d76eb2071790f0397ba37a1645c51` |

Geth source commit: `1df30b18d9ed35ee9d28ffd4648442c2204554ad`, tag `v1.17.10`. The retained toolchain manifest pins the previously built binary to `10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521`; this review did not invoke or rebuild it. No broad EthereumJS/Geth semantic equivalence is asserted.
