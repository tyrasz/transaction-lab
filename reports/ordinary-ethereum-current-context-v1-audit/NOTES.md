# Supplemental offline audit of the current-context development cases

Both retained local executions reproduce from the archived runtime and exact saved proof/code responses. Their execution status, return data, committed logs, observed state changes, and gas accounting match the retained provider results. This audit made no network requests and changed no original capture files.

| Case | Newly selected Ethereum block | Local outcome | Gas | Matched channels |
| --- | --- | --- | --- | --- |
| 002 | 26,287,639 | Reverted | 317,368 = 316,852 intrinsic + 516 message | 5/5 |
| 007 | 26,287,640 | Success | 21,000 = 21,000 intrinsic + 0 message | 5/5 |

Case 002 retains the original access list with 25 address occurrences and 116 storage-key occurrences. Case 007 retains one declared versioned blob hash. Both cases have nonce-only state changes and no committed token logs. Case 007's recipient has empty code, so its original local execution does not itself exercise blob opcodes. The provider's separate context witnesses check the declared blob hash, an out-of-range hash, and the synthetic zero blob base fee.

The audit rehashes all 59 base evidence files and all 1,785 archived source/dependency entries, verifies the recorded Node runtime, and repeats source/runtime verification after execution. It binds all 36 RPC records (214,788 response bytes) to exact retained requests/responses, phase IDs, and internal evidence, with no unjoined records. Both selected headers are independently rehashed and compared with the product's complete initial/final header observations. Four account proofs and four code values are reverified against the selected state roots.

Each actual isolated child consumes exactly four saved `eth_getProof`/`eth_getCode` responses in the recorded order at the exact canonical block selector. Its initial inputs come only from the selected header, fixed unsigned call, and verified proof/code responses. Product traces and expected local outputs never enter that input adapter. The resulting execution, input facts, usage, reads, state changes, and header verification are compared exactly. Only input-evidence/broker durations, isolation duration, and the fresh child process ID are normalized; process closure and zero pending reads are checked separately.

Three controls pass: both complete reproductions; a corrupted proof produces unavailable execution with no retained state changes; and an unexpected selector or additional state read is rejected rather than supplied invented state.

These are two selected development cases at **new state snapshots**, not replays of the original historical transaction positions or replacements for the retained historical-proof failures. Proofs and provider traces came from the same RPC service; the local execution algorithm is independent, while the supplied header's consensus/finality is not independently established. The unsigned profile does not validate transaction signatures, actual fees, blob sidecars, or complete economic ownership. These results establish no population accuracy percentage.

## Reproduce offline

From the repository root:

```sh
node reports/ordinary-ethereum-current-context-v1-audit/verify.mjs --verify
node --test reports/ordinary-ethereum-current-context-v1-audit/verify.test.mjs
```

The verifier uses only the frozen runtime in the original packet and the hash-pinned pure wire helpers in `../ordinary-ethereum-unresolved-v4-audit/verify.mjs`. It does not import the current product runtime. All dependencies are declared in `results.json` and the supplemental manifest.

Original evidence manifest: `69774b826eced318cf6a15a8fd9b854ae3f763334cae771f2ab24c98ec1a69c7`.

Original source manifest: `5869cbd6bf7c0a9635bc0ef755ee694ee347771aed5792ffd1ac9c5fe6ea2aff`.

This sibling audit is supplemental and is not part of the original frozen evidence manifest.
