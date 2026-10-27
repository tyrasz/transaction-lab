# Ethereum proof capability observation

The fixed one-shot plan dispatched exactly 12 read-only requests to Ethereum dRPC and Ethereum PublicNode. Eleven returned successful JSON-RPC results; one returned a preserved RPC error. The capture observed 138,145 response bytes in 2,363 ms, with no retries, replacements, skipped roles, redirects, budget violations, execution traces, signed transactions or broadcasts.

The immutable packet is bound by:

- `plan.json`: SHA-256 `d89d74d9579ad2d20ef0acb83249515464d7bd7415e12a74762af204c86be073`.
- `capture.json`: SHA-256 `d0965c21ce4f75e1c1db5df31e1a21970c9f11ffb985f24f7b911359caf0df6e`.
- `manifest.json`: SHA-256 `3e4e91ac7f6bb0711226548c8a04d53d6deabc7179147d9695de0a1a5d234f5b`, covering 28 files and 837,581 retained artifact bytes. This supplementary note is outside that manifest.

The first provider selected finalized block **26,277,709** (`0x190f74d`), hash `0xd5c5a3ba092484a5e1b3b54a054de8d1b1df7e24e60717f92517adccb0d6ce9e`, state root `0x7a9eaf8bef6cb59ee3c58cbf7d96c173c3cc849f2a088ebe073d2069a1793af3`. All four initial/final header responses are deeply equal. Every proof/code request used this exact hash with `requireCanonical: true`.

The separately implemented `engines/local-evm/ethereum-header.js` also recomputes the execution header's RLP/Keccak hash: **21 fields, 649 encoded bytes, BPO2**. It matches the selected hash and therefore binds the recorded state root to that hash. Its six offline tests pass, including changed commitments and malformed fork fields. This authenticates the execution-header commitment only; transaction/body lists, chain membership, consensus and finality are outside that check.

| Observation | dRPC | PublicNode |
| --- | --- | --- |
| USDC account and slot-zero proof | Returned; verified offline | Returned; verified offline |
| USDC runtime code | 2,186 bytes; matches proven code hash | Identical bytes; matches proven code hash |
| Fixed candidate account exclusion | Returned; verified offline | RPC error; unverified |

Both USDC proof responses are deeply equal. Offline verification binds the account nonce **1**, native balance **0**, code hash `0xd80d4b7c890cb9d6a4893e6b52bc34b56b25335cb13716e0d1d31383e6b41505`, storage root and the requested slot-zero word to the recorded state root. Slot zero is `0x000000000000000000000000fcb19e6a322b27c06842a71e8c725399f049ae3a`. No interpretation of this storage word as a token balance or allowance is asserted. The pinned code bytes independently match the proven code hash.

The fixed candidate `0x3ff06dc2d15492073973547de56b02a2f72df74b` came from the plan's deterministic seed, with no replacement search. dRPC's account proof establishes exclusion. Its raw response reports all-zero code/storage hashes; the verifier accepts this provider representation only after exclusion is proved, retains those reported fields separately, and derives canonical empty-code/empty-storage facts. It does not turn missing proofs or arbitrary zero-valued metadata into absence.

PublicNode request **11** returned `-32602`, `distance to target block exceeds maximum proof window`. Its successful USDC proof request **9** used the identical block-hash object and requested slot zero; only the account address differed. This is an observed inconsistency in available proof requests. No cause, stable archive range, remedy or retried success is inferred. Exact requests, raw bodies and parsed errors remain in `raw/009.*` and `raw/011.*`.

Independent offline checks verified all 28 manifest files, every request/body hash, all 12 response IDs and bodies, the four full headers, equal USDC proofs and equal runtime code. The current development proof verifier's **22 tests passed**, including actual saved proofs and malformed/root/key/code/absence controls. The checked source snapshots were:

- `engines/local-evm/verified-state-proof.js`: SHA-256 `02ae0f4606f542498816549a23c5cb5f3f4b3cac1f4745dc1a33e6b0d90198a9`.
- `engines/local-evm/test/verified-state-proof.test.js`: SHA-256 `62aacc6c680040a6cf54c6a33915cea1718fd183d8c1edc104087411ffa19039`.
- `engines/local-evm/package-lock.json`: SHA-256 `78b150d101a54b715a5d292a86566764723c9222e4379706ef681b46dbee4feb`.
- `engines/local-evm/ethereum-header.js`: SHA-256 `16e288db1db4cc73bfd59e504377eb28c91ca14ad0768c42bf2dea2526400904`.
- `engines/local-evm/test/ethereum-header.test.js`: SHA-256 `feccd93d01cbaf7bf3d741043b98784553b2d2f2f491630d805c644a29e31a99`.

Those source hashes identify the development verification used here; this packet does not archive a complete executable verifier dependency closure. Reproduction currently uses the referenced repository test with its pinned dependencies. The raw capture remains independently sealed if later verifier code changes.

This establishes narrowly observed proof capabilities at one recent finalized hash. It does not authenticate Ethereum consensus/finality, prove the two endpoints use independent infrastructure, demonstrate general archive/absence availability, execute USDC code, or provide an accuracy/coverage score. The state root is a caller-supplied trust anchor supported here by matching provider headers. Only the requested account and storage keys are proved; unrequested storage remains unknown. The intended next step is a separately declared local execution attempt consuming independently verified input state, retaining any missing-proof failure.

Primary interface references: [EIP-1186](https://eips.ethereum.org/EIPS/eip-1186) and [EIP-1898](https://eips.ethereum.org/EIPS/eip-1898). Endpoint documentation does not supersede the actual saved responses.
