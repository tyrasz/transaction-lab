# Ethereum local execution reference — one development transfer

This supplemental note is **outside the original sealed manifest**. No sealed file was changed. The run completed on 2026-10-27 using one constructed unsigned USDC transfer and two predeclared state-input attempts. This is a development example, not a held-out cohort or an accuracy score.

The fixed call transfers **1 raw USDC unit** from `0x28c6c06298d514db089934071355e5743bf21d60` to `0x3ff06dc2d15492073973547de56b02a2f72df74b`, through USDC at `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`. Its outer native value is zero and total gas limit is 5,000,000. The recipient was fixed by the earlier [capability plan](inputs/plan.json); its prior native-account absence was not assumed or used as proof of a token balance.

All execution starts at the end of block **26277709**, hash `0xd5c5a3ba092484a5e1b3b54a054de8d1b1df7e24e60717f92517adccb0d6ce9e`. The exact 21-field execution header was independently RLP-encoded and Keccak-hashed to this hash. Account and storage proofs bind to state root `0x7a9eaf8bef6cb59ee3c58cbf7d96c173c3cc849f2a088ebe073d2069a1793af3`; runtime code binds to proven code hashes. Consensus, finality, canonical chain membership and block-body validity are not authenticated by this check.

| Declared attempt | Actual outcome | Requests | Response bytes |
| --- | --- | ---: | ---: |
| PublicNode proof inputs | Unavailable at the first account proof | 1 | 159 |
| dRPC proof/code inputs | Local EthereumJS execution succeeded | 11 | 147,782 |
| Product comparison, requested only after both local outputs were saved | HTTP 200; simulation succeeded | 20 underlying RPCs | 62,252 |

PublicNode returned JSON-RPC error **-32000**: `historical state 7a9eaf8bef6cb59ee3c58cbf7d96c173c3cc849f2a088ebe073d2069a1793af3 is not available`. This failure remains in the [exact raw response](raw/publicnode-001.body) and [unavailable local attempt](publicnode-local.json). It was not retried, replaced or repaired with dRPC data.

The [dRPC local attempt](drpc-local.json) consumed only 11 `eth_getProof` / `eth_getCode` responses, verifying three accounts and five demanded storage slots. No provider execution trace, poststate, expected result or funding override entered local execution. The separate [product response](product-response.json) was obtained afterward through the existing `/api/evm/simulate` endpoint with automatic queries enabled. Its [HTTP capture](product-http.json) retains the exact request and 186,157-byte response; its nested `transportEvidence` retains all 20 underlying RPC exchanges.

The independent [comparison](results.json) matched five scoped fields for the successful dRPC-input attempt:

- Execution status: success.
- Return bytes: the 32-byte ABI value `1`.
- Committed logs: one USDC `Transfer` with the exact sender, recipient and raw amount `1`.
- Full observed changed state: sender nonce `0x11ff9a9 → 0x11ff9aa`; one USDC storage word `52363119552 → 52363119551`; the recipient's USDC storage word `0 → 1`. Every provider-supplied prior value was checked against the independently proven starting state. Whole-account lifecycle changes are outside this comparator and fail closed.
- Transaction-style gas: **62,224** on both sides. Local accounting applied zero refund and zero calldata-floor adjustment. This includes intrinsic gas but makes no fee-settlement claim.

The product's separate before/after `balanceOf` measurements also report sender `52363119552 → 52363119551` and recipient `0 → 1`. These product measurements were not inputs to the local engine. The comparison does not claim equality of every descendant call frame or completeness for unsupported behaviors.

The run used **32 public RPC requests total**, with **210,193 response bytes**, plus one localhost HTTP request. All limits passed; sources remained unchanged. There were zero retries, replacements, funding overrides or broadcasts. The unavailable attempt remains incomplete rather than being counted as agreement.

Frozen identities, independently rechecked from bytes after completion:

- [Plan](plan.json): `ffa5f14e267e3fb4ec2eb53aa3bb2da241ace700368a244cde9042f2b7f1a220`.
- [Manifest](manifest.json): `dd8973dd8e50447d38bf9609a078acb126e4061a939a9c7b803892073ec6c463`; **1,715 entries / 13,473,879 file bytes**, including the dependency symlink entry.
- Local runtime archive: **1,668 entries**, including **1,659 installed dependency entries**, with exact per-file hashes and Node **v22.23.2** bound in the plan. Existing pinned EthereumJS **10.1.3** modules execute the call; the selected timestamp resolves to the pinned BPO2 fork schedule.
- Expected and returned product implementation: **0.12.0**, source SHA-256 `3b769d18eac4e46548420e51799baf0185f56154c1fbfaaed6914f8b4cb83e60`, with the complete declared source-file list matched.

The [pre-dispatch revision record](plan.json) retains the original reviewed plan/scripts and explains the corrections made before any public request. Ten focused offline controls cover comparator and transport failure cases. Subsequent independent offline reproduction belongs in a separate supplemental audit; it does not alter this base capture.

This is an unsigned, unpriced block-end call reference. It does not verify a signature, settle fees, replay an original transaction position, authenticate Ethereum consensus, or establish general EVM/protocol coverage. The local engine is a separate execution implementation, but its initial state and the product comparison both ultimately depend on the selected public-chain header; one match cannot establish production reliability or superiority over another service.
