# Historical allowance validation

These read-only probes were captured on 2026-10-23. They use `debug_traceCallMany` at the original transaction index and the following index in the same canonical block. They did not sign or broadcast transactions.

`view-probes.json` records the raw USDC/hUSDC `allowance(owner, spender)` call shapes at a known supply transaction. `view-module-validation.json`, `approval-module-validation.json`, and `permit-module-validation.json` retain the module's complete public RPC requests and responses, execution identity, and outcomes. The adjacent scripts reproduce the bounded probes. Original transaction, receipt, and trace evidence for the permission cases is in `../permission-discovery/`.

## Observed results

`MAX` below is the exact uint256 maximum, `115792089237316195423570985008687907853269984665640564039457584007913129639935`. Values are raw token units; both assets have six decimals.

| Transaction | Pair | Before → after | Providers |
| --- | --- | --- | --- |
| Supply `0x25e076fc67489775131aafd134a1c6de8f974dea434000ba7568cf400df03cd2` | USDC sender → Hyperlend Pool | Allowance decreases by `15066115` | dRPC and Hyperlend archive agree |
| Same supply | hUSDC sender → Hyperlend Pool | `0 → 0` | Both agree |
| Approve `0x371bf6c3af982636caa9874bb107a7d3d967cea340678b5dfb856ff35f9923b5` | USDC owner → Hyperlend Pool | `0 → 1660000000` | Archive measured; dRPC unavailable |
| Permit `0x8793c27ee5aa623de4e2131296ad54d4e1276dd3e5d28b7b493f4d2080f4556e` | hUSDC owner → spender | `0 → MAX` | Both agree |
| Router permit `0x9dba139e63627a8f3693b9a63ff556f89a5358c2603738f6d98172b7ddd3074d` | USDC owner → router | `0 → MAX − 25000000` | Both agree |
| Same router transaction | USDC router → downstream spender | `0 → 0` after an intermediate approval of `24812500` | Both agree |

The direct hUSDC permit owner differs from the submitting wallet. The router results demonstrate why an Approval event cannot substitute for the transaction's final allowance: the verified USDC implementation consumes allowance during `transferFrom`, including a maximum allowance, without emitting another Approval. The measurements include every operation in the original transaction.

## Retained provider failure

For the direct USDC approval at block `36762812`, transaction and receipt specify index `1`. dRPC returned a one-entry block transaction array containing only that approval at array index `0`. Hyperlend archive returned two entries with the approval at index `1`, under the same block hash. The context rejected the incomplete dRPC response before replay; it did not guess or adjust the index. The saved initial failure's display text is generic because that probe script originally checked the error's name; the script now uses `instanceof StateValidationError`. The failed raw response remains unchanged and its index mismatch is a regression test.

## Supported scope and checks

The historical context exposes `allowanceMeasurementBasis: 'historical_transaction_position_allowance'`; the existing balance marker remains unchanged. Allowance reads accept exactly two padded address arguments and only the configured USDC/hUSDC proxies. Each read must execute through its verified implementation with no additional child calls, no events, no token state changes, and exactly one uint256 output. Variable debt-token allowances remain unsupported.

Original direct approve/permit calls retain strict ABI and implementation checks. Other zero-value contract roots, including the observed router, additionally require original nonempty runtime-code evidence. Supporting a root for state reads does not claim to understand its protocol behavior or establish that it is safe. Consumers must still derive the permission pairs from verified execution observations.

All original transaction/receipt bindings, full semantic replay, supported legacy/type-1/type-2 envelopes, access list, effective fee, original header witness, nonce-position, query fee effects, original account/code-change restrictions, and canonical rechecks remain enforced. Each query is isolated at the requested original position; probes are not inserted into a sequential bundle that could alter subsequent results. Evidence is provider supplied, not a cryptographic state proof.

One shared context permits at most 12 distinct queries across balances and allowances and 64 RPC calls. Repeated queries are cached. Each response is capped at 8 MiB and retained response evidence at 32 MiB. The generic-root code proof adds one RPC. Unknown implementations, malformed responses, ignored/clamped positions, reorgs, and unverified query behavior fail closed.

The focused suite has 37 passing tests, including all eight recorded module/provider runs (seven measured, one correctly unavailable), strict query-shape mutations, code-proof failures, owner/submitter separation, final consumption, and the pre-existing historical balance and error-sanitization regressions.
