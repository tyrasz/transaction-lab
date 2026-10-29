# Sepolia local-preview integration contracts

Read-only assessment, 2026-10-29, working tree based on `989e5488e2e076a249583a15e414e695c75574d0`. No production edits, VM execution or new public RPC. The saved Sepolia smoke packet remains a separate provider observation; it does not establish local support.

## Finding

An EthereumJS upgrade is not automatically required. The installed Common 10.1.3 contains the experimental Amsterdam bundle `[2780,7708,7843,7778,7928,7954,7976,7981,7997,8024,8037,8038,8246,8282]`. Its own comment says implementation/spec are incomplete or moving. The bundled **Sepolia schedule does not activate Amsterdam**: its final entry has `block:null` and no timestamp. Simply selecting `Sepolia` still chooses BPO2 for the captured current block. See [installed schedule](../../engines/local-evm/node_modules/@ethereumjs/common/dist/esm/chains.js) and [bundle](../../engines/local-evm/node_modules/@ethereumjs/common/dist/esm/hardforks.js).

The official Sepolia configuration and meta-EIP give Amsterdam timestamp `1791294816` (2026-10-06 13:53:36 UTC). Introduce a reviewed, source-bound schedule overlay, rather than changing installed dependencies or inferring a fork from RPC fields. Sources: [eth-clients Sepolia](https://github.com/eth-clients/sepolia/blob/main/README.md), [EIP-7773](https://eips.ethereum.org/EIPS/eip-7773). Pin the exact source revision/content when implementing; these pages are current references, not archived inputs in this note.

Offline checks using saved block 12018196 (`timestamp=1793261160`) established:

- Bundled `Common(Sepolia).setHardforkBy(...)` selects `bpo2`; a detached copy with that timestamp selects `amsterdam`, chain ID 11155111.
- Independently RLP-encoding 23 fields, ending in `requestsHash`, `blockAccessListHash`, `slotNumber`, reproduces saved hash `0xdd182e949a9f742d2b9730c6d3d432da4ac182c5d9dc81598fc9517466fc1dc7`.
- Current `verifyEthereumHeader` rejects this exact saved header with `LOCAL_HEADER_INVALID: Unsupported header field or property.` Current HTTP admission rejects chain 11155111 earlier with 400 `UNSUPPORTED_CHAIN`.

## Chain and source contract

Use one finite chain module, for example `ethereum-chain.js`, exporting strict `normalizeLocalChainId(value)` and `ethereumCommon(header, chainId = 1)`. Accept only 1 and 11155111; select a detached chain configuration from this whitelist. Do not accept a `Common`, schedule, RPC URL, hardfork name or EIP list from the client or child. Preserve current mainnet schedule/response shape where possible. Sepolia metadata should identify the explicit schedule overlay and experimental Amsterdam support scope.

| Boundary | Current assumption | Required change |
| --- | --- | --- |
| [API](../../src/local-simulation.js):88–107,152 | Admission/output always 1; handshake requires `0x1` | Normalize requested chain once; require exact matching `eth_chainId` before header/state reads; retain it in `apiRequest`, source and capabilities. |
| [Server](../../src/server.js):233,249,294 | `proofRpcFactory()` has no chain; config lists no Sepolia | Pass a validated chain selection to a trusted endpoint factory. A dedicated server-side `SEPOLIA_RPC_URL`/fixed default must never reuse `ETHEREUM_RPC_URL` silently. No caller-supplied endpoints; keep provider routes unchanged. |
| [Proof transport](../../src/proof-rpc.js):100 | Mainnet default URL | Transport method/pin/ancestry/budget mechanics are reusable; chain selection belongs before construction. It does not prove network membership itself. |
| [Parent](../../engines/local-evm/isolated-call.js):47,132,181,189,241 | Options, context, profile and scope assume 1 | Add an explicit trusted `chainId` option; derive Common/header/profile independently. Bind every child identity to it and reject mismatches. |
| [Worker](../../engines/local-evm/isolated-worker.js):28,68 | Start payload and collector assume 1 | Include normalized chain in strict start schema; use it for collector, original call and preview. Do not infer it from child output. |
| [Preview](../../engines/local-evm/ethereum-preview.js):26,131 and [query compiler](../../engines/local-evm/preview-queries.js):74,84,93 | Scope and every compiled identity say 1 | Thread trusted chain through compilation and re-decoding, before/after CALLs and native reads. Native reads remain VM-free. Disposable queries inherit chain/fork but not original fees/auth/blob context. |
| [Input reproof](../../engines/local-evm/input-facts.js):37 | `inputs.context.chainId===1` | Take expected chain explicitly and compare. Keep exact proof/code/selector reconstruction and private cache protections. |
| [Ancestry](../../engines/local-evm/authenticated-ancestry.js) and [collector](../../engines/local-evm/rpc-state-inputs.js):141 | Mainnet header verifier; chain-1-only ancestry | Carry trusted chain into each ancestor verification, selecting that ancestor's fork by its own timestamp; retain hash/height/time linkage and 255-read bound. |

The [loader](../../src/local-loader.js):36–65 already inventories every local runtime `.js`, full local dependencies and static server/adapter imports. A new local `.js` schedule module is automatically source-bound. Keep schedule provenance/constants in that closure, not an untracked environment file. The parent/worker protocol must not create an unbound alternate path. Chain handshake plus hash/proofs still does not establish consensus, finality or independent chain membership.

## Header and environment contract

Extend [header verification](../../engines/local-evm/ethereum-header.js):29–52 with explicit chain selection. Require the 32-byte `blockAccessListHash` only when EIP-7928 is active and canonical uint64 `slotNumber` only when EIP-7843 is active; reject premature fields and missing active fields. Append in that order after `requestsHash`, matching the installed [block serializer](../../engines/fixture-evm/node_modules/@ethereumjs/block/dist/esm/header/header.js):500–504. Keep all existing width/canonical/fixed-field/hash checks and whole-header final reread. Do not derive a slot from timestamp or trust a supplied hash without recomputation. [EIP-7928](https://eips.ethereum.org/EIPS/eip-7928) commits the BAL; [EIP-7843](https://eips.ethereum.org/EIPS/eip-7843) exposes the committed slot through opcode 0x4b.

Pass authenticated `slotNumber` through the wrapper's reduced block, `executeUnsignedCall`'s actual EVM header, retained environment and parent exact equality. Currently each drops it. Verifying the BAL commitment is not verifying BAL contents or replaying the source block; retain that limitation explicitly.

## Accounting and state gates before admission

The existing wrapper is not a generic `runTx` replacement. [ethereum-profile.js](../../engines/local-evm/ethereum-profile.js):27–54 fixes 21000 base, 2400/1900 access-list charges, 32000 creation, 25000 authorization and the old floor/refund calculation. [EIP-2780](https://eips.ethereum.org/EIPS/eip-2780) separates state-independent inclusion charges from pre-frame runtime charges; [EIP-8037](https://eips.ethereum.org/EIPS/eip-8037) adds state-gas accounting; [EIP-8038](https://eips.ethereum.org/EIPS/eip-8038) changes access/write costs. The installed EVM has state-gas reservoir/spill and preparation-OOG fields initialized by `runTx`; a bare `runCall` does not establish correct transaction setup by itself. Parent recomputation must use the same declared profile while deriving inputs independently. Root owns the detailed gas/execution audit.

Specific boundaries outside that calculation:

- [ethereum-blob-fees.js](../../engines/local-evm/ethereum-blob-fees.js):8–14,47–58 independently constructs Mainnet and has no Amsterdam table. This affects **priced nonblob calls too**, because `ethereumFeePlan` asks for blob context unconditionally. Accept trusted selected Common/chain, retain exact bounded integer pricing, and source-pin the correct network BPO parameters. Never silently reuse a mainnet timestamp selection.
- [authorization-validation.js](../../engines/local-evm/authorization-validation.js):13 and [execution-changes.js](../../engines/local-evm/execution-changes.js):283 deliberately reject EIP-7928 for authorization/delegated-sender accounting. Retain explicit unsupported admission until Amsterdam preparation, refunds and committed creation nonce rules have parent coverage. The recovery helper's default chain 1 must not be used implicitly on Sepolia.
- Amsterdam activates [EIP-8246](https://eips.ethereum.org/EIPS/eip-8246): same-invocation destruction preserves remaining balance while clearing code/nonce/storage. Current finalizer and parent native-flow ledger burn/refinalize to zero. Gate affected SELFDESTRUCT paths until both are updated; enabling the fork without this guard would execute incorrect state. Preserve checkpoint/rollback/query-neutrality rules.
- EIP-7708 creates real ETH-transfer logs. Existing parent/log/query output handling must preserve committed logs and reject mutating/log-emitting getters; do not confuse protocol logs with the provider's optional synthetic transfer tracing.
- Existing 24-KiB created-code and 32-KiB input caps may remain explicit stricter product limits. They are no longer Amsterdam protocol maxima. Keep exceeded limits unavailable/unsupported instead of converting them into an ordinary VM failure.
- `execute.js` uses many `chainId===1` branches, otherwise selecting HyperEVM rules. Replace with a strict admitted-Ethereum-chain predicate, not a broad `chainId!==999` shortcut. Crypto/runtime budget guards must remain installed on supported Sepolia forks.

## Implementable first slice and acceptance checks

Build the chain/header/proof spine first, with API admission still gated. Then integrate the Amsterdam transaction setup and parent accounting for an explicitly bounded plain-EOA native transfer profile plus native balance queries. If broader calls are not yet validated, reject them explicitly; do not advertise all Amsterdam execution merely because Common includes its EIPs. Provider simulation is not an alternative path inside the local result.

Before enabling that slice, require offline checks for: saved 23-field header hash and tampered/missing/premature suffixes; activation-minus-one/activation timestamps; same block metadata on wrong chain; wrong `eth_chainId` before state dispatch; child chain/profile/query-identity forgery; cross-activation ancestry; CHAINID/SLOTNUM context; existing-recipient versus absent-recipient funding and insufficient runtime gas; original revert/host failure with withheld measurements; native balances before/after with exact nonce and no query execution; mainnet response/gas regressions. Unsupported auth, lifecycle and priced paths must have explicit negatives until implemented.

Finally expose Sepolia only for the local UI path. [public/app.js](../../public/app.js):1310–1346 currently validates native/fee identities against chain 1/mainnet schedule, so API-only widening would show unavailable or misleading results. Select network and engine independently, retain chain in the input fingerprint, clear stale results on either change, label test ETH, and keep Ethereum provider/HyperEVM/Arbitrum routes unchanged. No automatic token inventory or broad accuracy claim is implied.
