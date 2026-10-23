# Public HyperEVM stateful balance capability — verified October 23, 2026

Both `https://hyperliquid.drpc.org` and `https://rpc.hyperlend.finance/archive` successfully executed the unsigned Hyperlend deposit as a stateful `eth_simulateV1` request. No transaction was signed or broadcast. They also supported `prestateTracer` in diff mode and read-only `eth_call` state overrides.

The tested account was `0x9a1dbc6a6e7e59f6beb23db0d00b603fc90e94d0`. The deposit called the existing example's `supply(USDC, 15066115, account, 0)`.

## Result

| Observation | USDC | hHyperEvmUSDC |
| --- | ---: | ---: |
| Stateful `balanceOf` before | 569.439069 | 5677.663061 |
| Stateful `balanceOf` after | 554.372954 | 5692.729176 |
| **Actual simulated balance difference** | **−15.066115** | **+15.066115** |

The hToken **Mint event was 15.147041**, containing **0.080926 accrued interest**. That event total is not the observable balance increase: `balanceOf` before the deposit already includes the accrued interest. Both providers returned identical balance observations and deposit logs.

The successful request used one simulated block with five sequential calls:

1. USDC `balanceOf(account)`.
2. hUSDC `balanceOf(account)`.
3. The original unsigned Hyperlend supply call.
4. USDC `balanceOf(account)`.
5. hUSDC `balanceOf(account)`.

Each balance query received a 100,000 gas limit; the supply call received 500,000. The observed supply used 165,727 gas. All five calls returned status `0x1`. `validation:false` was used: this is an execution preview, not a signed transaction validity or inclusion guarantee.

## Block identity and interpretation

Both providers selected parent block `0x2f084d6`, hash `0xac82ec80c795f82716d2456cca9e9b4c161fea4bcc93323ac97c9945d3eb55d8`, timestamp `0x6adb6d5a`. Returned `parentHash` matched that exact recorded hash. The request explicitly set the simulated block number to parent + 1 and timestamp to parent + 1 second. Before and after balance calls therefore share the same simulated timestamp. Returned simulated block hashes are synthetic outputs, not mined transaction evidence.

An independent route at the original parent block also worked: `debug_traceCall` with `prestateTracer` and `diffMode:true`, followed by `balanceOf` calls at the same block hash before and after applying every changed storage slot through `stateDiff`. It returned the same −15.066115 / +15.066115 deltas. Its hUSDC balances and interest were 0.000010 lower because its execution timestamp was one second earlier. The pinned-block Mint event was 15.147031, including 0.080916 interest.

Storage-only reconstruction is valid for this observed diff because it contained no account creation, deletion, code change, or native balance change. A general implementation must handle those cases explicitly; it must not silently reuse this shortcut for arbitrary contracts.

## Initial errors and their resolution

The initial request allocated 500,000 gas to each of four queries and 2,000,000 to supply: total 4,000,000, exceeding the parent block's 3,000,000 gas limit. Hyperlend archive returned code `-38015`, `Block gas limit exceeded by the block's transactions`; dRPC returned code `19`, `Temporary internal error. Please retry`. Reducing the aggregate requested gas to 900,000 resolved both errors. These were not evidence that `eth_simulateV1` was unsupported.

## Implemented measurement path

The primary adapter uses `prestateTracer` plus `eth_call/stateDiff`, preserving the original block hash and header context. It returns before/after observations and exact signed deltas separately from event-derived movements. It includes all changed slots (zeroing pre-only slots), applies changed balances/nonces, rejects account creation/deletion or code changes, validates every balance result, and rechecks the block's canonical hash. The hUSDC delta must exactly equal that trace's Mint value minus accrued interest; there is no blanket rounding tolerance.

Further probes confirmed that `eth_simulateV1` accepts the same block number and timestamp on both providers. Explicit overrides also preserved parent gas limit, base fee, randomness, and coinbase. Those probes matched the original trace's interest and gas. Nevertheless, this remains independent capability evidence: inserted probe calls alter account nonce progression, and a synthetic block's ancestry/`BLOCKHASH` semantics require care. It is not the primary balance measurement backend.

Before expanding to arbitrary tokens, account for nonstandard or state-changing `balanceOf` implementations and the effect of inserting probe calls. Native value, account nonce and gas/fee changes need separate treatment. No security verdict is implied by either balance method.

## Evidence and sources

- [First probes and full prestate diffs](stateful-capability-probes.json)
- [Successful requests, raw responses, state overrides, and summaries](poststate-capability-probes.json)
- [Same-number/same-timestamp probes](same-context-probes.json)
- [Explicit header override probes](header-context-probes.json)
- [Geth eth_simulateV1 documentation](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth#eth_simulatev1): sequential calls inside simulated blocks and execution/validation options.
- [Geth prestateTracer documentation](https://geth.ethereum.org/docs/developers/evm-tracing/built-in-tracers#prestatetracer): changed state in pre/post maps and diff-mode semantics.
- [Hyperlend's documented RPC endpoints](https://docs.hyperlend.finance/developer-documentation/data-and-indexers).

These probes establish support for the observed requests at the recorded block. They do not establish availability guarantees, complete chain coverage, or superiority to another simulator.
