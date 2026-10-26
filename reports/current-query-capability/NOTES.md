# Current unsigned-query capability evidence

This frozen development packet records one bounded run on 26 October 2026. It contains **126 read-only RPC requests**, no failures, skips, retries or replacements, and 190,386 response-body bytes. It does not enable any production measurement gate. The complete run took 4.668 seconds; that observation is not a latency guarantee.

The fixed inputs replay the previously recorded supply call at block 49,536,896 and borrow call at block 49,318,777 against each block's selected end state. They are unsigned current-style simulations pinned to older states, not replays at the historical transaction position. Both use the same submitting account. Provider A is dRPC; provider B is Hyperlend archive. The fixed envelopes, source artifact hashes, limits, and complete request schedule were recorded in `plan.json` before any request.

## Observed result

All 28 main before/after query call traces validate the frozen, configured token/Pool implementation paths. All 28 paired query diffs contain only the query sender's nonce increment, with no native balance debit, token storage change, or code change. Every after query starts independently from the **same complete original-call state overrides**; query effects are never chained.

Both providers return these exact raw values:

| Case/query | Before | After | Delta |
| --- | ---: | ---: | ---: |
| Supply: USDC | 344156193 | 329090078 | −15066115 |
| Supply: hUSDC | 3179075937 | 3194142051 | +15066114 |
| Supply: USDC allowance to Pool | 115792089237316195423570985008687907853269984665640564039457584003202135963444 | 115792089237316195423570985008687907853269984665640564039457584003202120897329 | −15066115 |
| Borrow: USDC | 569439069 | 1404913479 | +835474410 |
| Borrow: hUSDC | 5677678780 | 5677678780 | 0 |
| Borrow: variable USDC debt | 2 | 835474412 | +835474410 |
| Borrow: hUSDC allowance to Pool | 0 | 0 | 0 |

Debt is a liability. The supply allowance is a large bounded integer, not uint256 maximum. The hUSDC supply change differs from the transferred USDC principal by one raw unit; the packet reports the actual queried value rather than replacing it with an event amount. All six available prior absolute account/pair measurements agree on each provider; the newly probed borrow allowance has no prior measurement in the fixed source. Direct USDC `eth_call` results also match the traced outputs.

## Environment and state-position limits

Eight header witnesses—before and after both cases on both providers—match the selected block's NUMBER, TIMESTAMP, GASLIMIT, PREVRANDAO, COINBASE, CHAINID and parent BLOCKHASH. **Every witness returns BASEFEE = 0**, while the actual block base fees are 160370124 and 100000000. Consequently, `headerContext: unchanged` would be false. These observations support consideration of an explicitly scoped **unpriced synthetic-basefee profile**, not an unchanged original-header profile. Adding a fee field only to queries would change the compared environment and is not justified by this run.

The original call increments the sender nonce from 82526 to 82527 for supply and 78161 to 78162 for borrow. Before queries increment the original nonce once; after queries increment the overridden nonce once. Query native balance does not change under the observed diff representation.

Four separate nonce anchors use each saved block's first ordinary transaction. Supply anchor sender nonce is 92462 at the parent and 92463 at the selected block; borrow is 636 and 637. Query prestate uses 92463 and 637 respectively on both providers. This distinguishes the observed query wrapper's selected end state from parent state for these anchors. It is not proof of equality of all storage or a cryptographic state proof.

Across providers, 62 of 63 corresponding parsed RPC results are exactly equal. The final supply block-by-number responses differ only in the `size` metadata (`0x660` versus `0x782`); block hash and other returned fields agree. No equality assertion silently discards an execution or balance difference.

## Provenance and verification

`capture.json` preserves exact successful response text and SHA-256 values; its SHA-256 is `3c11faec39109a330d91428d9ad359ee1601fc3820f5ae17b9971c61e7ddfae2`. `summary.json` is derived evidence. `frozen-sources.json` identifies the dependency closure from commit `27c60a4bc380118f67328a878b1e425b6c335908`. `frozen/query-validator.js` is an explicitly documented prefix extraction of the frozen historical module's pure helpers. It wraps a single current trace locally for the existing parser; no historical index or receipt identity is borrowed. No external package or another project's runtime dependency is required.

From the project root, both commands are offline:

```sh
node reports/current-query-capability/capture.mjs --verify
node reports/current-query-capability/verify.mjs
```

The first reconstructs the original schedule, envelopes, overrides and summary and verifies the referenced source artifact hashes. The second binds the immutable capture hash and independently asserts raw quantities, exact override reuse, query effects, header outputs, nonce anchors and cross-provider agreement. Neither is an independent execution engine. The outer manifest hashes every packet file except itself.

[Geth's trace-call documentation](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-debug#debug_tracecall) describes state/block overrides. Its [prestate tracer documentation](https://geth.ethereum.org/docs/developers/evm-tracing/built-in-tracers#prestatetracer) explains changed-state diff representations. The inspected [trace-call implementation](https://github.com/ethereum/go-ethereum/blob/master/eth/tracers/api.go) sets the context base fee to zero for zero-price calls; the [state transition implementation](https://github.com/ethereum/go-ethereum/blob/master/core/state_transition.go) increments sender nonce and contains no-base-fee handling. These moving upstream sources explain a plausible mechanism; they do not attest either provider's client, version, deployment or independence.

This is positive capability evidence for two known states and configured paths. It contains no malicious upgrade, changed dependency, or query mutation controls; no fresh runtime-code hash attestation for all dependencies; and no signed-transaction, native-fee prediction, spender-intent, safety or general EVM accuracy claim. Providers may share infrastructure or implementation defects. Production admission still requires a separately reviewed current-query validator and explicit rejection tests; the existing generic-current gate remains unchanged.
