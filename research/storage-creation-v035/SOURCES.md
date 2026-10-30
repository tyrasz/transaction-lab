# Storage-only creation: source resolution, 2026-10-30

The inspected specifications support **allow creation, clear the entire prior storage namespace before initcode, and preserve the old balance plus endowment** when the destination has nonce zero and empty code. This rule is consistent across Shanghai, Cancun, Prague, Osaka and the pinned Amsterdam specification. Nonempty storage alone is not an activated collision condition in these sources. A failed initcode/code-deposit operation restores the old destination state; creator nonce, transaction fees and ancestor rollback follow their ordinary, separate rules.

This resolves the specification question, not the existing client disagreement. The retained v033 observations and current unsupported product boundary remain unchanged. No EVM, Geth, RPC, or new comparison target was executed for this memo. Exact local byte identities, line ranges and acquisition limitations are in [source-notes.json](source-notes.json).

## Normative basis and activation

[EIP-684](https://eips.ethereum.org/EIPS/eip-684), Specification, makes nonzero nonce or nonempty code the creation-collision predicate. It applies to transaction creation and CREATE/CREATE2. It does not add storage to that predicate.

The [Shanghai Yellow Paper](https://ethereum.github.io/yellowpaper/paper.pdf), version `efc5f9a`, dated 2025-02-04, section 7, equations 99 and 102 (PDF page 11), initializes the destination storage root to the empty trie while retaining its prior balance. Equation 118 (page 12) checks the original nonce/code for collision. Equation 115 restores the original destination state on creation failure. Thus allowing an old storage-only destination does not mean preserving its storage.

[EIP-7610](https://eips.ethereum.org/EIPS/eip-7610) remains **Last Call** in the official page read on 2026-10-30. It proposes adding nonempty storage to the collision predicate, describes retroactive application, and expressly requires a hard fork. Proposed retroactivity does not activate the proposal. Its test discussion acknowledges existing reset tests and asks for their expectations to change under the proposal. A library comment, test directory named `eip7610`, or skipped test is not activation metadata.

| Fork | Published activation evidence inspected | Storage-only rule in pinned EELS |
| --- | --- | --- |
| Shanghai | Yellow Paper Shanghai scope; [EIP-4895](https://eips.ethereum.org/EIPS/eip-4895) timestamp `1681338455`; pinned Common list excludes 7610 | Deployable; reset storage |
| Cancun | [EIP-7569](https://eips.ethereum.org/EIPS/eip-7569), included EIPs, mainnet `1710338135`; no 7610 | Deployable; reset storage |
| Prague | [EIP-7600](https://eips.ethereum.org/EIPS/eip-7600), included EIPs, mainnet `1746612311`; no 7610 | Deployable; reset storage |
| Osaka | [EIP-7607](https://eips.ethereum.org/EIPS/eip-7607), included EIPs, mainnet `1764798551`; no 7610 | Deployable; reset storage |
| Amsterdam | [EIP-7773](https://eips.ethereum.org/EIPS/eip-7773), scheduled EIPs, Sepolia `1791294816`; mainnet activation blank; no 7610 | Deployable; reset storage in the pinned draft/runtime specification |

The Osaka meta document describes BPO changes as blob-parameter changes, so BPO1/BPO2 do not supply a separate creation-collision activation. Amsterdam observations here do not establish mainnet Amsterdam activation. The local Common metadata corroborates the finite fork lists but is not itself protocol authority.

## Pinned executable specification

EELS commit URL `e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e` was acquired by the parent into `outputs/evm-toolchains/eels-e27f097ec7/source`. Archive SHA-256 is `066dd6ffc615f5f8894cd4f6ea711ba8164e5f1bb83bdf53221a49fefcfb9db6`. This memo independently rehashed 15 relevant files and matched every one against the retained extraction inventory. This is pinned-URL/archive-byte provenance, not a claim of independent Git-object validation.

All paths below are under `src/ethereum/forks/<fork>/` in that retained source. Links use the pinned upstream commit.

| Fork | Deployability (`state_tracker.py`) | Creation snapshot/reset/rollback (`vm/interpreter.py`) | Internal CREATE/CREATE2 (`vm/instructions/system.py`) |
| --- | --- | --- | --- |
| Shanghai | [279–287](https://github.com/ethereum/execution-specs/blob/e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e/src/ethereum/forks/shanghai/state_tracker.py#L279) | [155–197](https://github.com/ethereum/execution-specs/blob/e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e/src/ethereum/forks/shanghai/vm/interpreter.py#L155); reset167 | 99–105 |
| Cancun | [281–289](https://github.com/ethereum/execution-specs/blob/e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e/src/ethereum/forks/cancun/state_tracker.py#L281) | [155–198](https://github.com/ethereum/execution-specs/blob/e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e/src/ethereum/forks/cancun/vm/interpreter.py#L155); reset167 | 100–106 |
| Prague | [281–289](https://github.com/ethereum/execution-specs/blob/e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e/src/ethereum/forks/prague/state_tracker.py#L281) | [175–218](https://github.com/ethereum/execution-specs/blob/e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e/src/ethereum/forks/prague/vm/interpreter.py#L175); reset187 | 100–106 |
| Osaka | [281–289](https://github.com/ethereum/execution-specs/blob/e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e/src/ethereum/forks/osaka/state_tracker.py#L281) | [175–218](https://github.com/ethereum/execution-specs/blob/e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e/src/ethereum/forks/osaka/vm/interpreter.py#L175); reset187 | 100–106 |
| Amsterdam | [362–370](https://github.com/ethereum/execution-specs/blob/e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e/src/ethereum/forks/amsterdam/state_tracker.py#L362) | [339–392](https://github.com/ethereum/execution-specs/blob/e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e/src/ethereum/forks/amsterdam/vm/interpreter.py#L339); reset350 | 96–132 |

This is an actual namespace clear, not merely deletion of newly written slots. `destroy_storage` drops writes and adds `storage_clears`: Shanghai 412–428; Cancun/Prague/Osaka 414–432; Amsterdam 518–539. `get_storage` checks that marker before falling back to earlier block/prestate storage. Creation also marks the account newly created so original-storage gas accounting sees zero. The snapshot preceding the clear is restored on failure. Initial account balance does not enter the deployability predicate, although it can affect empty-account cleanup and Amsterdam state charging.

Earlier web-rendered EELS content gave different Amsterdam line numbers. The locally acquired, inventory-matched bytes above are authoritative for this memo; no raw SHA is assigned to a rendered webpage.

## Why the retained clients disagree

Pinned Geth `1df30b18d9ed35ee9d28ffd4648442c2204554ad`:

- [`core/vm/evm.go` 585–615](https://github.com/ethereum/go-ethereum/blob/1df30b18d9ed35ee9d28ffd4648442c2204554ad/core/vm/evm.go#L585) checks nonce/code, and only creates an account object if absent.
- [`core/state/statedb.go` 672–683](https://github.com/ethereum/go-ethereum/blob/1df30b18d9ed35ee9d28ffd4648442c2204554ad/core/state/statedb.go#L672) marks an existing account as a new contract without resetting its namespace.
- [`core/state/state_object.go` 164–215](https://github.com/ethereum/go-ethereum/blob/1df30b18d9ed35ee9d28ffd4648442c2204554ad/core/state/state_object.go#L164) continues reading old storage unless the account was actually destructed. This explains the retained preservation result; it is not the reset specified above. Seven inspected Geth files match its retained source inventory.

EthereumJS EVM 10.1.3 checks `storageRoot` as a collision at `evm/dist/esm/evm.js` 656–674, before its `clearStorage` at 677. Amsterdam's earlier `interpreter.js` 1005–1019 repeats that check without entering a child. Both comments refer to EIP-7610, but the installed Common hardfork lists 141–203 contain no such activation. Current v034 `evm.js` has the separately disclosed delegation-only patch; these storage predicates are unchanged. This rejects where the inspected specifications allow and reset. None of these source conclusions reclassifies or replaces the existing captured client outcomes.

## Reachability and official fixture leads

[EIP-161](https://eips.ethereum.org/EIPS/eip-161) makes modern creation initialize the contract nonce before initcode. Before that change, a constructor could write storage, return empty code, and leave nonce zero. EIP-7610 reports historical examples; this memo did not repeat that scan. Reaching such an old address again would generally require a creation-address hash collision/preimage, rather than replaying an already consumed creator nonce. Arbitrary state-test prestate can express the condition directly and does not prove practical mainnet reachability.

Zero-balance storage-only accounts are also empty under EIP-161's nonce/code/balance definition, so touching them can delete them. Positive balance avoids that cleanup. Modern SELFDESTRUCT does not independently manufacture this shape: historical deletion removes storage, Cancun's retained old contracts keep their nonce/code, and Amsterdam EIP-8246 clears storage together with nonce/code. EIP-7702 authorization increments nonce even when clearing code. No actual wallet, chain state, current account count or feasible collision is asserted.

The retained `tests@v21.0.2` `create_empty_contract_with_storage` vectors are **not** old-storage reset evidence: all 15 inspected by the parent start without old storage and create it during initcode. Transient `trans_storage_reset` tests are another unrelated name match. Do not count either as coverage of this dispute.

The pinned Geth suite explicitly skips `create2collisionStorageParis`, `InitCollisionParis`, `dynamicAccountOverwriteEmpty_Paris` and `RevertInCreateInInit`: `tests/state_test.go` 57–64 and `tests/block_test.go` 69–73. Its `ethereum/tests` submodule pin is `c67e485ff8b5be9abc8ad15345ec21aa22e290d9`. Useful acquisition leads are `GeneralStateTests/stCreate2/create2collisionStorageParis.json`, `stSStoreTest/InitCollisionParis.json`, and `stExtCodeHash/dynamicAccountOverwriteEmpty_Paris.json`, with corresponding fillers. Their payloads were not successfully acquired by this agent, so these names are not claimed as inspected expected-result fixtures. A current upstream Geth search also exposes `paris/eip7610_create_collision/{initcollision,revert_in_create}` skip expressions; those require source/expectation inspection before use.

## Limits and next use

Research was bounded to primary sources: at most 32 direct browser URL opens and eight search queries, then local reads/hashes. No new archive download, extraction, dependency installation or target execution was performed by this agent. The browser provides rendered results, not an enforceable raw-response byte cap; failed raw fetches and missing raw hashes are disclosed in the JSON. Parent-owned EELS acquisition has its own retained 64 MiB compressed / 512 MiB expanded / 16 MiB per-file / 30,000-file / 120-second limits and exact archive inventory.

The actionable implementation target is a clear-before-initcode namespace reset with rollback, balance retention and zero original-storage accounting, guarded by nonce/code collision rules. Any implementation still needs dedicated raw/parent/query proof-state tests and independent frozen observations; allow-and-preserve and collision are useful divergent client observations, not interchangeable correctness oracles. The current unsupported boundary remains until that separate work is implemented and validated.

## Subsequent execution and original-storage review

After this source memo, the parent acquired six independent EELS observations.
Their [separate packet](eels-comparison/NOTES.md) supports the clear-before-initcode
prediction and retains every earlier client disagreement. This does not change
the memo's earlier source-only scope or claim execution of the official fixtures.

An additional source review distinguishes current storage from the original
values used by SSTORE gas accounting. Each fork's `state_tracker.py` checks
`created_accounts` before prior storage and returns zero for a marked address.
The creation marker is shared across snapshots and explicitly survives revert;
`storage_clears` and current writes are copied and restored. Thus a failed
creation restores actual old storage while original-value gas bookkeeping still
sees zero until the next transaction. The implementation must not use the same
rollback-aware set for both purposes or erase unrelated original-value caches.

| Fork | `get_storage_original` | `mark_account_created` | snapshot / restore |
| --- | ---: | ---: | ---: |
| Shanghai | 205 | 431 | 623 / 655 |
| Cancun | 207 | 435 | 627 / 659 |
| Prague | 207 | 435 | 627 / 659 |
| Osaka | 207 | 435 | 627 / 659 |
| Amsterdam | 288 | 542 | 734 / 769 |

These are observations of the same pinned source files already covered by the
source inventory. For example, Amsterdam's zero-original branch is at line 307,
its shared marker at line 761 and storage-clear restoration at line 786.
The new manager foundation keeps a separate invocation-lifetime marker, resets
it with the original-storage cache at the next invocation, and preserves
rollback-aware creation permission and storage-reset provenance separately.
