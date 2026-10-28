# Root CREATE capability: supplemental offline audit

This post-seal supplement preserves the [original capability packet](../ethereum-deployment-capability-v1/evidence-manifest.json) unchanged. The audit was written by the capability-runner author: it separately implements wire and Parity-state adjudication, but is **not an independent source-author review**. It makes no network requests and does not rerun the original VM.

The [audit result](audit.json) verifies all sealed artifact bytes and the exact archived source/dependency inventory, the frozen plan/source/Node identity joins, all 12 new request/response bindings and seven copied reference wires. It recomputes the header hash, reverifies the sender/target EIP-1186 proofs, and derives the CREATE address from the authenticated sender nonce. The recorded Node identity is bound to the plan; this audit does not claim to authenticate the historical process or rerun its exact executable.

The capability capture contains **12 calls, 53,671 response entity bytes and 2,379.758708 ms**. Both providers' before/after complete headers equal the selected reference header. dRPC returned `trace_call` output and stateDiff. PublicNode retained four `debug_traceCall` errors (`-32601`, method unavailable) and one `trace_call` HTTP 403 with error `-32602` requiring an archive token. No error was omitted or converted into execution success.

Exploratory decoding of [dRPC's response](../ethereum-deployment-capability-v1/wire/003.json) agrees with the earlier [local output](../ethereum-deployment-capability-v1/reference/local.json) on the observed root success, return/runtime bytes, derived address and complete supplied state-diff fields: sender nonce 1→2; new target nonce 1, runtime `0x60005460005260206000f3`, slot zero = 42. The target's absence is proof-verified; missing existing state is never defaulted to zero.

The provider reports **24,330 message gas**, equal to the local result. Independently derived creation intrinsic gas is **53,390** (including 32,000 creation gas and the 2-gas initcode word charge), giving **77,720** by addition. That equals the local unsigned accounting with refund counter zero. This is observed arithmetic, not a proof of equivalent Parity refund/fee semantics. The Parity request used a numeric block selector and no block override: unchanged header brackets do not make that selector atomic or authenticate the provider's zero-fee context. No committed-log channel, full post-state root, signed admission, fee settlement, consensus/finality or population accuracy rate is established. The [earlier dRPC debug HTTP400 failure](../ethereum-deployment-capability-v1/reference/wire/000007.json) remains unchanged and unavailable for comparison.

Reproduce without public network:

```sh
node reports/ethereum-deployment-capability-v1-audit/verify.mjs
node --test reports/ethereum-deployment-capability-v1-audit/verify.test.mjs
```

All nine bounded controls pass, including changed raw bytes, request/response identity, failure promotion, same-hash header drift, missing state, invented baselines and visible output/gas/storage discrepancies. The separate `audit-manifest.json` seals this supplement; it is not part of the original capability manifest.

Pinned identities:

- Capability evidence: `d6f402d95e53a62a1991e1ec74855f8e375034512d53d555c8c75a5a293c641e`
- Plan: `8ff678c2a4a72e58e6aaa1114bab24da66bd9699bce1efb7a54990e0dd6f2450`
- Source archive manifest: `df32a4c2dcc9afa48bf04488a9ad565ad39c43fc16c67a1c1e5f76d7e2d02c76`
- Original deployment evidence: `3aab8f526c5dee2d5ce765f66ea6108119faca53bc80105d2b093921a01a3841`
