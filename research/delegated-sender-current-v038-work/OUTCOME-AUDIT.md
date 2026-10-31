# Saved outcome audit

The independent saved-only audit passes. It did not import the product comparator, proof verifier, VM, API or RPC client and did not execute any target or network request. `outcome-audit.mjs` uses only Node builtins and the frozen RLP/Keccak primitives. Run it from any checkout with `node research/delegated-sender-current-v038-work/outcome-audit.mjs`; the capture is resolved relative to this file, with an optional capture-path argument.

The frozen first adjudication remains **9 matched, 0 mismatched, 1 unavailable**. Its SHA-256 is `17e888ea19e0d158986b5728a12e49ef4c11113257cc2e033a1505f90226edf6`. The unknown status channel is local `invalid opcode` versus provider `invalid opcode: INVALID`. This audit explicitly interprets those two recorded exceptions as the same failure and finds ten semantic channel agreements. That interpretation does not replace the original classification. Root's separately recorded comparator amendment is also a saved-artifact interpretation, not another execution.

## Observed results

Both calls use selected Ethereum block **26312105**, hash `0x59dcdd6b3ccf74ff760c0db757a2e29ae7c7d96aa422ee6375644b740b332138`. The audit independently re-encodes the 21-field header and verifies its hash. It checks exact request/header context, all 39 native response bodies (398,047 bytes), four sealed/closed worker records, 4,169 manifest entries (41,375,004 file bytes), 4,031 runtime entries, and the 1,728-entry reported API implementation identity. Standalone MPT walks verify 30 account/storage proof paths and join initial values and code hashes to the raw responses. A terminal inventory/hash check confirms the capture remained unchanged during the audit.

| Fixed case | Recorded outcome | Charged gas | Committed effects |
|---|---|---:|---|
| delegated-usdt-002 | Failed, invalid opcode; empty return | 5,000,000 | Sender nonce 111 → 112; no committed logs or token-state change |
| delegated-usdt-015 | Success; empty return | 63,209 | Sender nonce 149414 → 149415; two USDT slots change by −95,000,000 and +95,000,000 raw; one matching Transfer log |

Both sender accounts have proof-bound, exact 23-byte delegation designations: case 002 delegates to `0xd2e28229f6f2c235e57de2ebc727025a1d0530fb`; case 015 to `0x0000fb7702036ff9f76044a501ac1aa74cbab16b`. These are existing delegations with no authorization list processed. The five channels are execution status, return data, committed logs, charged gas, and all observed sparse net state changes. Gas is independently reconstructed from calldata intrinsic cost, message gas, refund cap and calldata floor.

The local-only balance queries report case 002 sender 2,375,342,286 → 2,375,342,286 and recipient 40,036,032 → 40,036,032 raw USDT; case 015 sender 574,897,795,353 → 574,802,795,353 and recipient 0 → 95,000,000. They have no independent reference query and are excluded from the ten channels. The first call requested 3,842,000,000 raw; its invalid-opcode observation alone does not establish a business-level failure reason.

## Scope and retained reviewer attempts

These are two deliberately selected unsigned, unpriced, 5M-gas calls at one block's ending state. Historical transaction hashes identify provenance, not signed transaction replay. This is not a random accuracy estimate, complete final-state-root comparison, complete asset inventory, consensus/finality check or provider execution attestation. Both execution paths share dRPC infrastructure. The audit shares RLP/Keccak primitives but implements its own MPT walk, gas arithmetic and sparse-state normalization. API/outer-worker source identity matches the frozen inventory; nested isolation explicitly reports `sourceImplementationBound:false`, so no per-process code-attestation claim is made. Direct-child closure and cleanup signalling are observed, not independently verified process-tree extinction.

All reviewer attempts are retained. `outcome-audit-first.json` records the first compile-time missing-brace error (stderr was displayed but not redirected; no checks executed). `second` records an audit assumption that header confirmation used by-hash; the saved selector correctly uses by-number confirmation. `third` is the initial passing audit. `fourth` records an overly strict identity-schema comparison: the archive additionally hashes a symlink target while the API inventory records the link. `fifth` records an incorrect audit assumption that the nested isolation source-attestation flag was true. The final audit corrects these reviewer assumptions, verifies the actual schemas, and explicitly retains the attestation limit. No capture, implementation or comparator bytes were changed.

Final checker SHA-256: `e933519958425bdf1c4958f330f7dcc3f199db329b6d9de0413242429a101b5c`.

Final report `outcome-audit-final.json` SHA-256: `a08b85a0a41ca59fe7bcc8b6ddce42b561f7bcb6cd25af741a9499b2660b639e`.

Capture manifest: `3c845b025d9a722e5afa00406d87763656cd38fb6c4ca2bede6ba1918d9115e9`; intent: `f89ace8fabaea373b0226cb7cefb68ea6c4b59531cf317eae1da24a5ac8fdb54`; plan: `fe7c07a064761f387b6ac6fab30b3d425ce322febd56979355bfd217a75abb84`; source: `c8fca41fdf87f8d367908a487955720a09d4403293e776666df2b0638d6a0469`.
