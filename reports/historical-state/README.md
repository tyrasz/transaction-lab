# Exact-position historical-state capability research

Captured 2026-10-23. All RPC requests are public, read-only execution or lookup calls. No transaction was signed, broadcast, or persisted. Probe contract code exists only in temporary RPC state overrides.

**Result: a narrow exact-position balance reader works on both tested providers using `debug_traceCallMany`, with explicit validation.** It is integrated into engine version 0.4.0 for the configured Hyperlend operations and tokens. The latest HTTP comparison retained one archive-provider availability failure; see [checkpoint results](../../STATUS.md). These findings do not establish general faithful replay for arbitrary contracts.

Providers tested:

- `https://hyperliquid.drpc.org` (`web3_clientVersion`: `Geth/v10.0.0/drpc`)
- `https://rpc.hyperlend.finance/archive` (`reth/v0.1.0-0718e6b/x86_64-unknown-linux-gnu`)

## Supported and misleading paths

| RPC path | Observed behavior on both providers |
|---|---|
| `debug_traceTransaction` | Returned historical execution and prestate diff for the known withdrawal. |
| `debug_traceCall` with `config.txIndex` | **Silently ignored the index.** Values were identical for omitted, 0, original index 4, 5, 6, and 1048576. The replay had different accrued interest and gas from the original transaction. |
| `trace_callMany` at block N | Sequential calls work, but start from block-end state. This is a new execution on the selected state, not the original transaction position. |
| `debug_traceCallMany` with `stateContext.transactionIndex` | Honored position: index 4 before the withdrawal, index 5 after it. A hash-pinned block object works. |
| Out-of-range `debug_traceCallMany` index | 1048576 silently clamped to block-end. The application must reject invalid indexes itself. |

The relevant input shape is:

```json
{
  "method": "debug_traceCallMany",
  "params": [
    [{ "transactions": [{ "from": "...", "to": "...", "data": "...", "gasPrice": "..." }] }],
    {
      "blockNumber": { "blockHash": "...", "requireCanonical": true },
      "transactionIndex": 4
    },
    { "tracer": "callTracer", "tracerConfig": { "withLog": true } }
  ]
}
```

On these deployments the integer is the **number of original transactions applied before the new call**. For original transaction index `i`, query before at `i`, query after at `i+1`. Original index must satisfy `0 <= i < block.transactions.length`; post-state index may equal the transaction count. The observed repayment was the last transaction: index 12 in a 13-transaction block, with valid post-state index 13.

## Observed balance results

Each row was reproduced independently on both endpoints. Raw integer values are preserved; all three tokens use six decimals. Debt is a liability, not a spendable asset.

| Operation | Original index | USDC before → after | Position before → after | Position delta |
|---|---:|---|---|---:|
| Withdraw | 4 | 772133294 → 1276033520 | hUSDC 6181482361 → 5677582135 | -503900226 |
| Borrow | 0 | 770634775 → 1606109185 | debt 2713477586 → 3548951996 | +835474410 |
| Repay | 12 | 769065349 → 569439069 | debt 199626281 → 2 | -199626279 |

The repayment spent 199626280 USDC raw units while reducing debt by 199626279. This confirms the observed rounding distinction in actual position reads.

For each operation, an **isolated original call** at index `i` matched the saved historical trace's return value, all event data, call-tree shape and gas used. Comparisons omit the per-frame input `gas` field; no claim is made that every RPC annotation is byte-for-byte identical. Original gas used: withdraw `0x65615`, borrow `0x680e9`, repay `0x28461`. Block hash and the original transaction's position in the canonical block array were checked afterward on both endpoints.

Transaction references:

- [Withdrawal](https://hyperevmscan.io/tx/0x94b5c4672e28cbeeab547c06f60e30afa02ac58b0cad4c7568a6ca9d8ac29ae7)
- [Borrow](https://hyperevmscan.io/tx/0x0b8ad0d98c96224bdd9e1ad6623292164278340b123feb45eee9c556ec259afb)
- [Repay](https://hyperevmscan.io/tx/0x682c1d2f131715b8d4b04c71cd8e75ef56a107f0bbd992379a44bf426f22102f)

## Header and probe caveats

A temporary EVM program returned NUMBER, TIMESTAMP, GASLIMIT, BASEFEE, PREVRANDAO, COINBASE, CHAINID and BLOCKHASH(N−1) at the withdrawal position. Seven fields matched without fee arguments. **An unpriced call observed BASEFEE = 0**, although the original block's base fee was 100000000. Adding the original transaction's `gasPrice` made all eight fields match on both endpoints. These checks did not cover every possible EVM environment field or chain-specific system behavior.

The six balance measurements in `position-validation.json` used unpriced view calls. For these verified USDC/hUSDC/debt `balanceOf` implementations, the results reconcile to the original position evidence, and the changed BASEFEE does not participate in their balance calculation. A production reader should preserve the original gas price and revalidate the query traces rather than claiming that unpriced calls preserve every environmental field.

The exploratory `[balance, balance, original, balance, balance]` bundle inserts calls into one ephemeral state sequence. Those calls can increment sender nonce and, when priced, charge native gas. It happened to reproduce this withdrawal, but is **not a faithful general replay recipe**. Prefer independent query RPCs at original index `i` and `i+1`, plus a separate isolated original-call validation at `i`. One query per RPC avoids prior probes influencing even the subsequent view call's nonce/native state. All such calls remain read-only with respect to the chain.

Multiple bundles are not interchangeable with independent calls: official Reth documentation describes block-number/timestamp advancement between bundles. Use exactly one bundle per historical query and do not override the header to the parent block. Block N−1 alone is not the transaction prestate when earlier transactions exist in block N.

## Implemented reader in 0.4.0

The API now implements the following approach in `src/historical-state.js`. [Module validation](module-validation-notes.md) documents the additional nonce, fee, resource and implementation checks and six saved live regressions. The earlier probe files below remain evidence of discovery, including the limitations of unpriced and sequential exploratory calls.

1. Limit initial support to reconciled Hyperlend USDC operations and configured position tokens; keep historical allowance queries separate until validated.
2. Validate canonical block hash, header, original transaction hash at index, and index bounds before querying. Pass the pinned hash object to every request; re-check canonical identity afterward.
3. Query each needed `balanceOf` independently at `i` and `i+1` using the original gas price. Require one bundle, one complete successful trace, strict 32-byte return data, and known token implementation/call behavior.
4. Validate the original call separately against `debug_traceTransaction`/receipt evidence. Preserve original input, caller, destination, value and fee semantics. Do not insert queries into the original replay and then claim general replay equivalence.
5. Return a distinct basis such as `historical_transaction_position_balanceOf`, with transaction hash/index, pinned block identity, raw requests/responses, scope/caveats and reconciliation against event-derived position changes. Keep measured balances separate from Transfer events.
6. Fail closed on unavailable history, ignored/unsupported method behavior, malformed results, invalid indexes, changed code or canonical identity. No fallback to `latest`, block end, parent-only state, or a synthetic next block.

## Evidence files and primary documentation

- `capability-probes.json`: exact requests/responses for both providers, including ignored `txIndex`, historical trace/diff, and `trace_callMany`.
- `call-many-probes.json`: index controls, out-of-range clamp, and exploratory balance/original-call sequence.
- `position-validation.json`: three independent before/after position reads and isolated original replays on each provider, canonical checks and unpriced header probe.
- `priced-header-validation.json`: all eight header fields match with the original gas price.
- `module-validation.json`: six live runs through the implemented reader, with independently priced single-query calls, nonce and fee validation.
- Adjacent `.mjs` scripts reproduce bounded read-only probes. Running them replaces their matching capture file.

[Geth debug API](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-debug) documents `TraceCallConfig.txIndex`; the [Geth implementation](https://github.com/ethereum/go-ethereum/blob/master/eth/tracers/api.go) routes it through transaction-position state reconstruction, and [state reconstruction source](https://github.com/ethereum/go-ethereum/blob/master/eth/state_accessor.go) stops before the target transaction. Those upstream semantics did not hold for the deployed endpoints' `debug_traceCall` option.

[Reth debug API](https://reth.rs/jsonrpc/debug/) documents bundles with a state context; [Reth API details](https://reth.rs/docs/reth_rpc/struct.DebugApi.html) describe using the first n original transactions as the base and advancing context between bundles. [Alloy request types](https://github.com/alloy-rs/alloy/blob/main/crates/rpc-types-eth/src/call.rs) define integer `transactionIndex` and `blockNumber`. These are current upstream references, not proof of the exact deployed clients' source versions; the saved probes establish the limited observed behavior.

[Erigon trace documentation](https://docs.erigon.tech/interacting-with-erigon/trace) distinguishes sequential trace calls from transaction replay and describes free-call fee behavior. No method name or client label alone was treated as proof of correctness.
