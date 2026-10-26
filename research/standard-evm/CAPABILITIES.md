# Public Ethereum and Base simulation capabilities

Ethereum mainnet through the public dRPC endpoint is the viable next backend for the selected Aave and Morpho deposit development cases. This survey observed the required tracing and ephemeral override interfaces; it did not execute a deposit, verify a deposit holder's balance or allowance, or establish general transaction accuracy.

The immutable [capture](../../reports/standard-evm-capabilities/capture.json) contains exactly 48 requests: 12 per endpoint, no retries or replacements. There were 33 successful JSON-RPC results and 15 explicit provider errors, totaling 179,553 raw response bytes in 22.138 seconds. Every complete response, including errors, is retained as exact bytes in base64, UTF-8 text, parsed JSON, byte count and SHA-256. The request text and individual response files are also retained. All calls completed within the 25-second and 8-MiB per-response bounds. The overall limits were 48 calls, 64 MiB and ten minutes.

Capture SHA-256: `ada8360af17b2ebce8caa301ddea304814e730f2e1d492517ae5669081601d80`. The [offline verifier](../../reports/standard-evm-capabilities/verify.mjs) checks source binding, all 48 raw byte hashes, individual artifacts, chain and block identities, query results and the synthetic-block caveat without making network calls.

| Endpoint | Hash-bound USDC read | Code + stateDiff override applied | callTracer / full prestate / diff | eth_simulateV1 | trace_call |
| --- | --- | --- | --- | --- | --- |
| Ethereum dRPC, `https://eth.drpc.org` | Yes | Yes | All observed | Yes, next block | Observed, numeric fixed block |
| Ethereum PublicNode, `https://ethereum-rpc.publicnode.com` | Yes | Yes | Unavailable, -32601 | Yes, next block | Personal token required, -32602 |
| Base official, `https://mainnet.base.org` | Yes | Yes | Request filter, -32611 | Yes, next block | Request filter, -32611 |
| Base PublicNode, `https://base-rpc.publicnode.com` | Yes | Yes | Unavailable, -32601 | Yes, next block | Personal token required, -32602 |

The first endpoint for each chain selected one finalized header. The second endpoint used that same hash, and both later fetched its numeric height again. All final header checks returned the selected hash. Ethereum used block 26,275,416, hash `0x888cd3dff00f52b85bb400ab86dbeb503fdd52becb6bcbb36994d856102b2916`. Base used block 53,105,436, hash `0xef10731d2bd3323ed990625fe703a644992642d503ccab31d7a6e9a55d54a8d3`.

The real-token call was USDC `balanceOf(0x0000000000000000000000000000000000000000)`, with zero native value, an explicit 300,000 gas bound and `{blockHash, requireCanonical:true}`. All four returned a 32-byte zero balance. No token balance or allowance was overridden. A separate, explicitly synthetic capability witness placed a short SLOAD-and-return program and slot-zero value 42 at `0x000000000000000000000000000000000000feed`; each `eth_call` returned 42. Ethereum dRPC's overridden callTracer also returned 42. That witness proves that these override parameters affected the ephemeral execution, not that any real account owns 42 tokens.

Ethereum dRPC's real USDC trace entered the proxy and one delegatecall to implementation `0x43506849d7c04f9138d1a2050bbf3a0c054402dd`. The full prestate response retained runtime code and accessed slots. Its query diff incremented the zero sender's nonce from an omitted pre-field to an explicit post nonce of one. A later implementation must independently read the original nonce rather than treating any omitted field as proof of zero. The observed interfaces are sufficient to attempt an unchanged, funded holder's deposit call and then verify before/after balance queries, with the full original state changes applied to post-state reads. Actual deposit success, implementation paths, interest accounting, allowances and exact output reconciliation still require that separate experiment.

Every `eth_simulateV1` result used block N+1. The observed timestamp advanced by 12 seconds on Ethereum and two seconds on Base. This is useful stateful simulation capability, but it is not the same-header balance measurement used by the current trace method. The `trace_call` probe used the selected numeric height and a later canonical check; it does not establish support for a canonical hash object or original transaction position. No method tried a fallback after an error. No historical state position, transaction signing, signature execution or broadcast was tested.

The reported client strings were `Geth/v1.17.9-stable-9dffe6e9/linux-amd64/go1.25.14` for Ethereum PublicNode, `Geth/v10.0.0/drpc` for Ethereum dRPC, and Reth/Base version strings for the Base endpoints. These are provider reports, not independent client attestation or proof of infrastructure independence. One working public endpoint does not establish an availability guarantee or cross-provider execution agreement.

Primary endpoint and interface sources, read before the survey:

- [PublicNode Ethereum endpoint](https://ethereum.publicnode.com/) and [Base endpoint](https://base.publicnode.com/).
- [dRPC Ethereum API](https://drpc.org/docs/ethereum-api).
- [Base network connection documentation](https://docs.base.org/get-started/connect-to-base).
- [Circle USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses).
- [Geth call and override objects](https://geth.ethereum.org/docs/interacting-with-geth/rpc/objects), [debug tracing](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-debug), and [eth_simulateV1](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth).

The exact observed provider errors and responses take precedence over an assumption that a documented method must be enabled on a public endpoint. The packet is development evidence, not a blind holdout, protocol security score or claim that the product already supports all Ethereum or Base transactions.
