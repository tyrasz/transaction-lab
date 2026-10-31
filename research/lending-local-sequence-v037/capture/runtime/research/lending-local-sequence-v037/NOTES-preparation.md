# Lending sequence input preparation

Status: input-only preparation, with no new RPC requests, EVM executions, transaction signatures, broadcasts, or withdrawal observations. This note and `declarations.mjs` prepare two fixed three-call sequences for later review and freeze. They do not authorize or perform a capture.

## Fixed declarations

Both cases use Ethereum mainnet (`chainId: 1`), one unchanged saved sender, the full unchanged saved block header, zero native value, and three ordered unsigned calls. Each withdrawal asks for half the original underlying USDC amount, rounded down to an integer raw unit. No expected success, balance, share burn, liquidity, state diff, or gas result is supplied.

| Case | Saved sender | Deposit raw USDC | New withdrawal raw USDC | Block number |
| --- | --- | ---: | ---: | ---: |
| Aave approve → supply → withdraw | `0x48c16c5652add27eddb0f896748a35fc60b8d1b4` | `3962903485` | `1981451742` | `26270482` |
| Kiln approve → deposit → withdraw | `0x44c3a96181af9e295ce8e188fa8fcdd72d1eb668` | `350000000000` | `175000000000` | `26270562` |

USDC has six decimals here. The Aave values are 3962.903485 and 1981.451742 USDC; the odd original raw amount requires rounding down half a raw unit. The Kiln values are 350000 and 175000 USDC. These are underlying asset amounts, not wrapper or vault share amounts.

The Aave block hash is `0x4badf912d1bcc7f77197108544be0ab4b8cef7a94fb7a4ee1e65fda816300dc7`; its state root is `0xea7a9456b042ca8e618b09805777d6b4523a5192fe3ee897adec9844bc7386e2`. The Kiln block hash is `0x00cbe8bb974276f900d767a7853e0011817eeebbea1d9525e7c1fb230fd21d61`; its state root is `0x37ac4c37f5e4962fc3dcc2d1362b66b2a2e5895c034ba33d9b7ec53c40714f66`. The loader checks each full header against its separately saved parent RPC response.

## ABI and prior evidence

For Aave, the exact approve and supply call bytes come from `reports/standard-evm-positions-v3/aave-approval-position-sequence-response.json` at `/apiRequest/calls/0` and `/apiRequest/calls/1`. They must equal the corresponding separately saved input in `reports/standard-evm-positions-v3/plan.json`. This earlier provider observation covers the constructed two-call sequence. The original historical transaction was `supplyWithPermit`; neither the earlier constructed sequence nor this new three-call extension is represented as that exact historical transaction.

The new Aave withdrawal calls Pool `0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2` with `withdraw(address,uint256,address)` (`0x69328dec`), using USDC and the saved sender as recipient. The saved official Pool documentation in `reports/standard-evm-discovery/raw/028.body`, with retrieval metadata in `028.json`, supplies the ABI. Its source URL is `https://aave.com/docs/aave-v3/smart-contracts/pool`. The declaration checks the saved body hash and signature text, and recomputes the selector.

For Kiln, the unchanged deposit call and header come from `reports/ethereum-lending-local-reference/plan.json` case `morpho-kiln-usdc-deposit`. The target is outer wrapper `0x334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b`, not a direct Morpho Blue deposit. The new withdrawal is `withdraw(uint256,address,address)` (`0xb460af94`) with the asset amount above and receiver = owner = sender. Saved primary documentation `reports/standard-evm-discovery/raw/027.body` lists this wrapper and the withdrawal ABI; `027.json` binds it to `https://raw.githubusercontent.com/kilnfi/app-plugin-kiln-v2/develop/PLUGIN_SPECIFICATION.md`. The declaration verifies the saved source identity and recomputes the selector. `redeem(shares,receiver,owner)` is a different operation and is not used.

Only the standalone Kiln deposit was previously captured. The prepended USDC approval and withdrawal are new declarations. The earlier deposit already had sufficient allowance, so this sequence cannot establish that approval was necessary. Prior standalone local/provider agreement does not establish agreement for the new three-call sequence.

## Shared queries and interpretation

The local input carries one shared top-level query list. Every provider call carries an identical copy of that list, because the standard sequence endpoint does not accept top-level queries. Order is fixed and described by `queryRoles`; raw token descriptors come from the saved deposits plan.

| Case | Ordered query roles |
| --- | --- |
| Aave, five queries | Sender USDC; sender aEthUSDC; reserve USDC; sender-to-Pool USDC allowance; sender Aave account data |
| Kiln, eight queries | Sender USDC; sender wrapper shares; wrapper inner-vault shares; wrapper USDC; inner-vault USDC; Morpho Blue USDC; sender-to-wrapper USDC allowance; inner-vault position in the one bound Blue market |

The Aave account-data descriptor is retained from the saved positions plan. Its base units are not assumed to be USD; basis-point and health-factor fields retain their own units. The Blue position belongs to inner vault `0xbeef01735c132ada46aa9aa4c54623caa92a64cb`, not the sender. Its market ID is checked against the saved binding and recomputed from the saved market parameters. Raw position shares are not converted to sender economic ownership.

The eight-query cap excludes wrapper-to-inner-vault allowance, fee recipients/self shares, other Blue markets, and other debt positions. These declarations do not claim full portfolio or economic coverage.

## Execution context and comparison boundary

Original calls align on saved sender, target, calldata, zero value, exact block hash/header, ordered preceding successful state, and gas limit 5000000. Local calls declare `gas: "5000000"`; provider calls omit gas because its endpoint fixes that amount and rejects a supplied gas field. The intended default profile is unsigned, unpriced block-end execution: source header base fee is retained as provenance while the execution base fee and gas price are zero. No fee settlement, outer transaction signature, block/time advancement, approval override, or funding override is introduced. The later runner must verify the actual captured environments rather than assume this alignment from the declarations alone.

Query gas differs: local queries use 1000000 (`engines/local-evm/ethereum-preview.js`), while provider queries use 300000 (`engines/standard-evm/unsigned-call.js`). Therefore, query comparison is limited to observed same-state returned values under different gas budgets. It is not an identical-query-context or query-gas comparison. The declarations expose this difference in `ALIGNMENT`.

Each query runs on a disposable before/after snapshot and does not affect later originals. Local execution runs originals before its independent queries; the provider path interleaves queries with originals. Both sequence paths stop at the first original non-success and are non-atomic. The provider skips queries for a reverted original; local output may retain observations of that failed invocation's state. Unavailable, skipped, or unmeasurable channels must remain explicit and must never become a zero amount or a comparison pass.

## Evidence and resource gaps

The earlier Aave supply witness lacks at least the sender aEthUSDC balance proof at slot 61, as recorded by the existing recorded local API test. It is insufficient by itself for these expanded queries and withdrawal. The earlier Kiln standalone deposit required 230 proof/code calls; the new withdrawal and queries may exceed the unchanged shared 256-proof-call cap. The declarations neither fabricate missing proofs nor raise that cap. Protocol collateral checks, withdrawal liquidity, wrapper fees, and shares burned remain unobserved.

No previous trace, state diff, post-state, or expected output is installed as initial state. Each future candidate must obtain and verify its state at the fixed header under the chosen capture policy. Existing saved captures establish provenance and prior evidence only.

## Module interface and freeze inputs

`loadLendingSequenceDeclarations({ root })` reads only the ten fixed files exported as `SOURCE_FILES`, checking regular-file status, exact byte count, and SHA-256 before parsing. They total 1830942 bytes. It returns a deeply frozen object with `schemaVersion`, `scope`, `alignment`, `sourceFiles`, `moduleDependencies`, and `cases`. Each case contains `id`, `chainId`, `from`, complete `header`, `amounts`, `localInput`, `providerInput`, `steps`, `queryRoles`, `provenance`, and `limitations`.

`localInput` and `providerInput` are independently normalized public API request bodies. Step metadata retains operation, signature, selector, request, source references, and whether that operation had a prior capture. The module performs no write, transport creation, EVM execution, or signing. Importing the module alone does not read the saved fixtures.

The future source freeze must include the declaration module, this note, every `SOURCE_FILES` entry, and all `MODULE_DEPENDENCIES` entries: `@noble/hashes/sha3.js`, `_u64.js`, `utils.js`, `package.json`, and `LICENSE` under `engines/local-evm/node_modules`. The runner owns the complete source inventory and identities for its own imports and API implementation. Do not substitute a live checkout dependency after freezing.

Offline checks completed: Node syntax validation; both declarations loaded with all ten source identity checks; local API normalization deep-equal to each supplied local input; provider API normalization deep-equal to each supplied provider input. The loader also checks selector encodings, fixed amounts, source header identity, per-call query equality, and the Blue market binding. Two cases passed, with zero target executions and zero public calls. No preparation artifact, freeze, or execution has been created by this task.
