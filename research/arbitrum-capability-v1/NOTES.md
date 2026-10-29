# Arbitrum public RPC capability observation

On 2026-10-29 at 01:57:24–01:57:26 UTC, one predeclared run made six read-only JSON-RPC calls to the [officially documented Arbitrum One endpoint](https://docs.arbitrum.io/chain-info), `https://arb1.arbitrum.io/rpc`. It used no credentials, paid service, real-wallet dependency, signing, broadcast, retries or fallback. No production code or dependencies changed.

| Probe | Observed response |
| --- | --- |
| `eth_chainId` | `0xa4b1` (42161) |
| Initial header | Block 519227947 (`0x1ef2ca2b`) |
| `eth_call` | HTTP 200; result `0x` |
| `eth_createAccessList` | HTTP 200; JSON-RPC error `-32601`, method unavailable |
| `eth_simulateV1` | HTTP 200; one call with status `0x1`, empty return, no logs, 21,000 gas |
| Final header reread | Exact initial header representation retained again, including the same hash |

The common call used the zero address as sender and recipient, empty calldata, zero value, gas limit 100,000 and gas price zero. Each capability request used the initial explicit block **number**. Its hash was `0x7de6e791ae16c23fb8cbe14fbe743953f569e7db3289552aa978e0ec3c082431`. This is provider-reported block binding, not a verified state proof or consensus/finality check. The account's code was not independently inspected; the response establishes an empty successful return, not absence of code.

The simulation returned a synthetic successor block 519227948 with the selected block hash as parent. It used `validation:false`, `traceTransfers:true` and no state or block overrides. Its synthetic block context is distinct from `eth_call` at the selected block. No source-chain token transfer or destination-chain effect was tested.

All six requests completed in 2.032 seconds, retaining 5,987 response bytes. Each response was below 1 MiB, each call below 25 seconds, and the run below 120 seconds. Exact sent JSON and received response entities are retained alongside HTTP status, timing and SHA-256 identities. Response bytes are after native fetch content decoding, not TLS/compressed wire bytes. The source and declaration stayed unchanged.

## What this establishes for viem

The reviewed [viem `simulateCalls` source](https://github.com/wevm/viem/blob/main/src/actions/public/simulateCalls.ts) delegates simulation to `eth_simulateV1`. With asset changes enabled, it also uses discovery, `eth_call` pre-balance reads and further synthetic blocks containing post-balance/metadata queries; some helpers use code/state overrides. The separately exported [`createAccessList`](https://github.com/wevm/viem/blob/main/src/actions/public/createAccessList.ts) uses `eth_createAccessList`, but is not a prerequisite in that `simulateCalls` implementation. These are mutable current-source references, not an installed/pinned viem release tested here.

The observed `eth_simulateV1` response makes a bounded viem asset-change evaluation plausible on this endpoint. It does **not** validate that complete workflow, arbitrary ERC-20 behavior, execution accuracy, gas accuracy, a CCTP transaction, or a Hyperliquid deposit. Verified deployment/ABI/token/domain/hook interpretation remains necessary, and destination attestation, relay, mint and HyperCore credit require separate evidence. Arbitrum's [RPC documentation](https://docs.arbitrum.io/arbitrum-essentials/arbitrum-vs-ethereum/rpc-methods) also describes chain-specific fields and semantics; Ethereum-mainnet local execution cannot simply be relabeled Arbitrum. Public endpoint availability has no guarantee.

## Recheck the retained evidence offline

`node research/arbitrum-capability-v1/verify.mjs` checks the fixed manifest and plan pins, every original artifact hash, request order and parameters, raw response joins, resource accounting, and observed result shapes. It performs no network access or simulation. `verification.json` retains that check's result. Notes and verification files are supplemental and separately listed in `supplemental-manifest.json`; the original evidence manifest is unchanged.

- Plan SHA-256: `54e76a72a4f03361e7f3410e001a9dd504773225aca4fa5dca32fa9beec744fe`
- Evidence manifest SHA-256: `f8bf46b665cc4edbc2fb6e9ca552fa3f468c9b408d79bb0a14e0790c5557cb36`

This is one development capability observation, with its unavailable method retained. It is not a deposit-accuracy or reliability rate.
