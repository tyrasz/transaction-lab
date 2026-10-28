# Current-state checks for two known Ethereum transaction contexts

This is a separate development regression at newly selected state, not a new random sample or a replacement for the historical v2/v3/v4 outcomes. The original sender, recipient, calldata, value and applicable access list/blob hashes are unchanged. Each case selected `latest` once after the implementation and plan were frozen; its exact hash then bound both executors. Neither case used saved proof inputs or expected outputs.

The capture completed on 2026-10-28 with **36 dispatched RPC calls and 214,788 response bytes**, in 11.3 seconds before final offline integrity checks and sealing. All phases retained their raw requests, response bytes, hashes and parsed bodies. There were no retries, replacements, provider switches, capture failures or source/input/runtime changes.

| Known case | Newly selected block | Proof-based execution | Provider execution | Five compared channels |
| --- | --- | --- | --- | --- |
| 002, access list | 26,287,639 (`0x1911e17`) | Reverted; total gas 317,368 | Reverted; canonical checks verified | All matched |
| 007, blob hashes | 26,287,640 (`0x1911e18`) | Succeeded; total gas 21,000 | Succeeded; canonical checks verified | All matched |

Each case used two selection reads, four independent proof/code reads, then twelve provider reads. The local child completed before the provider execution began. The five comparison channels are execution status, return bytes, committed logs, complete observed state changes, and gas accounting. This is not full call-tree equality.

Case 002 charged 316,852 intrinsic gas, including 280,400 for the 25 access-list entries and 116 storage keys, plus 516 execution gas. Both executors retained only the sender nonce increment `0x64c701` → `0x64c702`. Case 007 used 21,000 intrinsic gas and zero execution gas, with sender nonce `0xd379` → `0xd37a`. Both cases returned empty bytes and no committed logs. The access-list call reverted early, so this case exercises the declared list and its intrinsic charge but does not independently demonstrate every listed storage access. Neither case measured token queries or establishes economic inventory completeness.

The selected complete headers were independently hashed, and every provider header observation matched the respective selected header in full. Header hashing and state proofs do not establish consensus, finality or block-body validity. Selected hashes:

- 002: `0x49bede17a7e691b1408a7e570131f62f8be2006b4c440a5884ba64288b495eca`
- 007: `0x97a5de83af87394e2c93d54487e293cccf887aed7ed825d611ee836f95717837`

The profile is an unsigned, unpriced call with fixed five-million gas. Blob calls explicitly use zero transaction blob fee cap and block overrides setting both base fee and blob base fee to zero; the provider context witness validates this synthetic environment. These checks do not verify outer signatures, settle fees, validate a blob sidecar/KZG proof, replay the original transaction position, or establish a population accuracy or security score.

Frozen bindings:

- Product 0.15.0: `b035863ce536cf70ac92cdf72eb381bc9cfe0f4a2ef59d135e9678f640b177ba`
- Plan: `f64c96306fe145021c192771244ab66f20c05a879a074edf30d962cc9ad65b2e`
- Source manifest, 1,785 entries: `5869cbd6bf7c0a9635bc0ef755ee694ee347771aed5792ffd1ac9c5fe6ea2aff`
- Base evidence manifest, 59 files: `69774b826eced318cf6a15a8fd9b854ae3f763334cae771f2ab24c98ec1a69c7`

This note is supplemental and outside the base evidence manifest. The [independent offline audit](ordinary-ethereum-current-context-v1-audit/results.json) reverified all saved proofs and reexecuted both archived local workers with exact output agreement. Root independently reran the verifier successfully. The audit manifest is `7e154f20dafe7c34736f919cbeda6a35a313f9dd49c2b19bb52c77db9006626a`; the base capture remains unchanged.
