# Final allowance measurement

The read-only probe tested six unsigned calls against one recorded HyperEVM block: maximum, zero/revoke, and bounded 100-token approvals for both configured USDC and hUSDC. All six calls executed successfully and all six final allowance measurements succeeded. No approval was signed, broadcast, or persisted.

The public owner was `0x9a1dbc6a6e7e59f6beb23db0d00b603fc90e94d0`; the spender was the Hyperlend pool `0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b`.

| Call | Observed final allowance | Changed from pinned state |
| --- | --- | --- |
| USDC maximum | `2^256 − 1` | Yes |
| USDC revoke | `0` | Yes |
| USDC bounded | `100000000` raw / `100` USDC | Yes |
| hUSDC maximum | `2^256 − 1` | Yes |
| hUSDC revoke | `0` | **No — it was already zero** |
| hUSDC bounded | `100000000` raw / `100` hUSDC | Yes |

Every case queries `allowance(owner, spender)` before and after applying the entire transaction's `prestateTracer` diff as ephemeral `eth_call` state overrides. All reads bind to the same canonical block hash. The reported final state is separate from calldata and Approval event observations; a later approval, revoke, or allowance consumption can supersede an earlier event.

The adapter measures only successful trace observations for the configured USDC/hUSDC contracts. Failed subtrees, unknown token contracts, and the non-transferable debt token are excluded. Limits are eight unique permission pairs, 256 permission observations, 100 modified accounts, and 2,000 changed storage slots. Account creation/deletion and code changes are currently unsupported. An empty or nonce-only diff is valid for unchanged permission state.

Tests additionally cover an already-maximum unchanged allowance, `approve` returning false, sequential approve/revoke calls, final state differing from the last event, ambiguous event ordering, malformed results, resource limits, shared trace reuse, provider-error redaction, and canonical-block changes. Those controls are synthetic tests and are not represented as public executions.

- [Actual public requests and responses](public-allowance-probes.json)
- [Reproducible read-only probe](probe-allowances.mjs)
- [ERC-20 allowance and approve specification](https://eips.ethereum.org/EIPS/eip-20)
- [Geth prestateTracer diff semantics](https://geth.ethereum.org/docs/developers/evm-tracing/built-in-tracers#prestatetracer)
- [Geth ephemeral state overrides](https://geth.ethereum.org/docs/interacting-with-geth/rpc/objects#state-override-set)

The probe establishes behavior for the recorded calls and state. It is not a security classification or a guarantee about future execution.
