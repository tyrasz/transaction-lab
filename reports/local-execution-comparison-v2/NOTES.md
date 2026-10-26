# Corrected local-execution comparison

This is a separate corrected comparator report. The original `../local-execution-comparison/` packet is unchanged. Its exact ten bound source files are preserved under `../local-execution-comparison-v1-source/engine/`; that archive's offline verifier successfully reproduced the original result. Both reports use the same frozen raw state packet, two provider inputs, transaction and state block. No network requests, new transaction selection or output-based input repair occurred here.

Both endpoint-supplied input packets again produce an exact match in the supported execution, entered call tree, ordered committed logs and changed-state comparisons. This remains one fixed USDC `transferFrom` call executed locally twice, not two independently selected transactions and not a general EVM coverage or safety claim. The five synthetic input controls retain their earlier outcomes: missing slot/account causes unavailable with rollback; missing sender-code completion rejects before execution; explicit changed code/storage causes observable divergence.

The local execution remains 705 opcode steps, two frames, one committed log, 29,328 message gas and zero refund. Adding the input-derived 21,940 intrinsic gas gives the provider envelope's 51,268 gas. The local result changes the sender nonce and three USDC storage slots. Inputs come exclusively from the full prestate observation plus separately captured missing basic fields. Provider trace/diff outputs enter only after local execution finishes.

The correction addresses concrete comparison gaps:

- Every comparison channel now requires the local result's original block/parent hashes to match the input context, zero synthetic base fee to match its declared input, and successful completion to retain the message result in the supplied state manager. A rolled-back marker cannot accompany a matched result.
- Provider `input` is required. For `CALL`, `CALLCODE` and `DELEGATECALL`, value must be explicit in this comparison profile. Missing `STATICCALL` value is zero because it has no value operand. Only provider output may be omitted as the native tracer's empty-byte encoding; the local worker must supply all three fields explicitly.
- Committed-log indices must be distinct and preserve ordering. Gaps are permitted; there is no claim that indices must start at zero or be consecutive. If supplied, a log's `position` must fit the number of direct subcalls and agree with child-log ordering. Sequential nonempty sibling log ranges cannot reverse or interleave, even when payloads are identical. Without position evidence, the comparison retains the global index ordering rather than inventing positions.

The native tracer encoding and position semantics were checked against the primary [Geth call tracer source](https://raw.githubusercontent.com/ethereum/go-ethereum/master/eth/tracers/native/call.go): `input` is required; `output` and `value` use `omitempty`; position counts direct subcalls when a log is recorded. This is a source-level normalization reference, not proof that either remote provider runs that exact source revision. Other omission conventions remain unsupported. The reference was inspected on 2026-10-26.

Validation completed before sealing: 18/18 focused comparator tests and 58/58 complete experimental-engine tests pass. A separate agent reviewed the binding, required fields and log-topology changes and independently passed the 18 focused tests. These are deterministic development controls, not an accuracy denominator. Core product code and its existing evidence packets were not modified.

Reproduce offline from the project root:

```sh
node reports/local-execution-comparison-v2/run.mjs --verify
node reports/local-execution-comparison-v1-source/verify.mjs
```

The v2 verifier checks current engine/test/lock/runtime identity against this report before reexecution; changes require a new report. The v1 archive verifier uses an isolated temporary copy of its original source. Both use the existing installed dependency directory and verify installed direct versions and lock identity. Neither fully attests every installed dependency byte.

The limits remain the same: sparse provider state rather than a cryptographic state proof; unknown state reads fail; no native fee settlement, signed-envelope validation, account lifecycle, changed implementation code, nonzero refund normalization or HyperCore precompile support. These results establish one standard-EVM local execution path, not Aave/Morpho deposit coverage or equivalence to an independent full-chain engine.
