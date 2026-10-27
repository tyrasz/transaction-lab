# Proposed proof-backed local lending reference

Preparation only, 2026-10-27. No network requests or runtime changes were made. The completed engine checkpoint is `3c32074`; this proposal does not freeze or launch another capture.

## Two fixed inputs

Use the complete `cases[].request` objects from the preserved [deposit plan](../../reports/standard-evm-deposits-v2/plan.json), SHA-256 `d458f18ebd659998296a05283e6987f945bb54d7fe5786551abf70c9d7640f8f`. They already contain exactly `{from,to,data,value,gas}`, with `value: "0x0"` and `gas: "0x4c4b40"` (5,000,000). Do not reconstruct calldata, replace the permit, add approvals, change amounts or move to a newer block.

| Case | Exact selected input | Historical state anchor |
| --- | --- | --- |
| `aave-usdc-supply-with-permit` | Sender `0x48c16c5652add27eddb0f896748a35fc60b8d1b4`; Aave Pool `0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2`; selector `0x02c205f0`; 260 calldata bytes; requested USDC `3962903485` raw | Block **26270482**, timestamp **1792940807**; [original parent response](../../reports/standard-evm-discovery/raw/025.json), `response.result` |
| `morpho-kiln-usdc-deposit` | Sender `0x44c3a96181af9e295ce8e188fa8fcdd72d1eb668`; Kiln wrapper `0x334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b`; selector `0x6e553f65`; 68 calldata bytes; requested USDC `350000000000` raw | Block **26270562**, timestamp **1792941767**; [original parent response](../../reports/standard-evm-discovery/raw/026.json), `response.result` |

Exact state bindings:

- Aave block hash `0x4badf912d1bcc7f77197108544be0ab4b8cef7a94fb7a4ee1e65fda816300dc7`; state root `0xea7a9456b042ca8e618b09805777d6b4523a5192fe3ee897adec9844bc7386e2`. Parent-response file SHA-256 `e07dce6ae8d184dac5a8fe4739034d30535b0283e96f655ca248bca99302cda9`; calldata-byte SHA-256 `ecaa9c7506f91be69226699316f72772e197b590a81154bc164d4ce695aa6040`.
- Morpho block hash `0x00cbe8bb974276f900d767a7853e0011817eeebbea1d9525e7c1fb230fd21d61`; state root `0x37ac4c37f5e4962fc3dcc2d1362b66b2a2e5895c034ba33d9b7ec53c40714f66`. Parent-response file SHA-256 `6abaf67305776d021e27544f63de446c79b6e779e21d6bcf8e77dbe0bd3541c4`; calldata-byte SHA-256 `95254a4a3ebc459a74f50c5b57159e0d5319c79447363242998ac03b9eaa8afc`.

Both stored headers pass the current exact RLP/Keccak verifier offline, with 21 fields and the pinned BPO2 schedule. Original transaction provenance is [Aave `0x616628…130b2`](../../reports/standard-evm-discovery/raw/012.json) and [Morpho `0xc46259…873a7`](../../reports/standard-evm-discovery/raw/011.json). These calls execute at their respective **parent block ends**, not their original transaction positions. The Aave permit's embedded deadline is `1792944357`, 3,550 seconds after its fixed execution timestamp; wall-clock expiry does not justify changing it. The actual permit nonce/domain/signature checks must execute from proven state.

## Proposed bounded packet

Use exactly **two local attempts**, Aave then Morpho, with the endpoint predeclared as `https://eth.drpc.org`. This choice follows the completed development capability observations; it is not blind provider selection. Do not add a fallback endpoint or replace either case after failure. PublicNode's retained historical-state failure is existing evidence, not a reason to rerun it implicitly. A future two-provider matrix would need a separately declared four-attempt plan.

Before dispatch, copy and hash the complete local runtime, installed dependency tree, lockfile, Node identity, selected inputs and headers. Verify header commitments, then instantiate fresh `createRpcStateInputs`, `createProofStateManager` and `executeEthereumCall` for each case. Only hash-bound `eth_getProof` and `eth_getCode` responses may seed local state; collection follows the local engine's own demands. Existing traces, state diffs, decoded output amounts and touched-address lists are planning/comparison material, never a state-input fallback or prefetch oracle.

Pre-dispatch scope decision: use the collector’s existing **256 proof/code calls and 120 seconds per local attempt**, 25 seconds per request, 8 MiB per response, 32 MiB per local case and 64 MiB shared local wire budget. This replaces the transfer packet’s 64-call tightening before any lending dispatch; it does not raise the runtime collector ceiling or permit an adaptive retry. Preserve the engine's unchanged 5M gas, 1M instruction, 1,000-frame, depth-32 and 1 MiB-memory ceilings. Drain each bounded transport operation and terminal save before sealing its attempt, including a failed attempt.

Only after **both local outputs are saved**, request two separate `/api/evm/simulate` outputs, in the same case order. Derive flat API inputs only from each fixed request and header, converting value `0x0` to decimal `0` and omitting explicit queries. Assert offline equality with the preserved `apiRequest` objects from [Aave](../../reports/standard-evm-auto/aave-response.json) and [Morpho](../../reports/standard-evm-auto/morpho-response.json), which omit explicit queries and enable automatic discovery. Bind the then-frozen expected product implementation. Each product request retains the existing 65-RPC / 32 MiB / 145-second transport limits; allow a 160-second HTTP deadline and a separate 64 MiB HTTP-body cap. Proposed total maxima: **642 underlying public RPCs, 128 MiB RPC-response bytes, two localhost POSTs and 600 seconds**. No retries, replacements, funding overrides or source changes after dispatch.

## Likely constraints and required comparator work

The preserved automatic responses have SHA-256 `2fea1f944225742955948d2d9e93142095f9a78f7b1edb5f26047613a222388c` (Aave) and `b6d7cffefe131c58450b1ba5cc960b1ced800dc176b90fe90539814d67123773` (Morpho). Their original provider call traces are transport entry **8**, and original prestate diffs entry **11**. These observations support planning only:

| Observed prior behavior | Aave | Morpho |
| --- | ---: | ---: |
| Provider gas used | 189,775 | 1,413,682 |
| Entered frames / maximum depth | 18 / 6 | 232 / 6 |
| Non-precompile addresses, including sender | 14 | 17 |
| Changed storage words in prior diff | 10 | 18 |
| `2 × addresses + changed words` bookkeeping floor under the current lazy collector | 38 | 52 |

This floor excludes unchanged storage reads, additional account accesses and Aave's `ecrecover` precompile context. It is **not a complete witness count or latency prediction**. The earlier 64-call proposal would leave Morpho only 12 calls beyond this floor, and Aave may also exceed 64. The fixed pre-dispatch choice is now 256 per case, within the existing collector ceiling; this does not ensure either case completes. Archive proof availability and sequential proof latency may exhaust 120 seconds before gas/frame limits. Retain that outcome; do not enlarge ceilings mid-run. Prior traces show CALL/DELEGATECALL/STATICCALL and no lifecycle frames or positive native value. This is compatible with the intended profile, but does not prove absence of every unsupported opcode. Missing BLOCKHASH ancestry, blob context, lifecycle changes or unsupported account cleanup still fail closed.

A **new versioned comparison helper** is required; leave the sealed transfer comparator unchanged:

1. Saved Aave's successful void-return root omits `output`. Define and test the documented omitted-empty-output convention explicitly, while rejecting malformed fields and preserving reverts. Do not report missing bytes as verified merely by defaulting every optional value.
2. Both saved traces encode log `position` and `index` as canonical hex quantities. Parse bounded numeric or canonical-hex representations, validate per-frame positions and global indices, preserve failed-branch exclusion and exact emission order, and reject contradictory/ambiguous evidence. The transfer comparator currently rejects these hex positions.
3. Retain root input/value/gas, proven sender nonce, original diff nonce transition, code-hash metadata, complete observed state changes and transaction-style gas checks. Derive effects from the new local execution; compare with fresh product raw evidence afterward. Return-field or log-order incompleteness must not erase other mismatches or become agreement.

Primary Geth [call-tracer source](https://raw.githubusercontent.com/ethereum/go-ethereum/master/eth/tracers/native/call.go) declares output with `omitempty`, log position/index as `hexutil.Uint`, and position as the count of current-frame child calls when emitted. These are documented serialization semantics, not authentication of the public provider's implementation. Add offline controls using the already saved two traces before freezing a new harness.

## Reporting boundary

Report two selected development workloads, each attempted once, with availability/revert/unsupported/resource-limit outcomes preserved. Proofs authenticate demanded initial facts against the selected header commitment; they do not authenticate consensus or provide a full poststate root. The calls remain unsigned and unpriced, with no outer-signature validation, fee settlement, time advancement or original-position replay. Morpho's product auto-discovery previously selected eight of eleven query candidates; omissions and fee-recipient ownership must remain explicit. Neither prior success nor a new match establishes general lending coverage, complete economic effects, production reliability or a 90% score.
