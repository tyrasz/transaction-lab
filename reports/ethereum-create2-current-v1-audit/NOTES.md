# Independent offline CREATE2 replay audit

The sealed development capture reproduces exactly in a fresh child process from its archived execution sources and six saved proof/code responses. All five comparison channels match: execution, return data, gas, committed logs, and changed state. This audit made no public calls and changed no file in the original capture.

Run from the repository root:

```sh
node reports/ethereum-create2-current-v1-audit/verify.mjs --verify
node --test reports/ethereum-create2-current-v1-audit/verify.test.mjs
```

The verifier checks all 20 evidence files, 1,788 archived source/dependency entries, the Node runtime identity, and every exact request/response in 11 wire records (57,217 response bytes). All records are joined to selection, local input evidence and broker records, or the separate provider comparison. It recomputes the selected execution header hash, checks the entire final header is unchanged, independently verifies three account proofs and their code hashes, and reconstructs the claimed initial input facts. The deployment target's initial absence is proven cryptographically; its initial storage zero is derived from that absence, not from the later provider state diff.

The replay passes only the declared unsigned call, selected header, execution limits, and proof/code results to the archived local worker. It never supplies saved local outputs, provider traces, or poststate as execution inputs. The complete output, initial facts, usage, reads, changed state, and header verification match. Only input/broker durations, host execution duration, and the fresh child process ID are excluded; child exit success and closure are checked separately.

At block **26,288,720**, hash `0x48dd57e5393bc6cf3b703bbb8a529b2fe33997ab975472ecff64f0016f970c78`, the constructor produces the full 11-byte runtime `0x60005460005260206000f3` and writes **42** to slot zero. Independently applying the CREATE2 formula to the frozen 31-byte initcode and salt gives **`0xd7de4766a65d3dc6d02766ecadc6ae9a3f5e0039`**. The earlier draft address `0x7205e70e3737b772b5d19b093f92c0c1d003474f` corresponds to the obsolete 10-byte runtime-copy constructor and is rejected by a negative control.

The changed state contains exactly three accounts: sender nonce **1 → 2**, factory nonce **19,757 → 19,758**, and the new contract with nonce **1**, runtime code, and slot zero **0 → 42**. Execution uses **22,248 intrinsic + 56,932 message gas = 79,180 total**, with zero refund. The local worker executes 190 steps and enters two frames. Both implementations return the new address and emit no logs.

All five focused audit controls pass. They reject altered raw/parsed wire records, wrong IDs or requests, reordered/extra/non-input playback requests, the obsolete constructor/address, omitted or altered creation/code/storage/nonce effects, and a changed canonical selector. A real archived child receiving a deliberately corrupted proof becomes unavailable after its first read and returns no changed accounts. These mutations are synthetic negative controls, not additional live evidence.

The final frozen runner SHA is `a11bd25335c75f7b98b1fb9b00b45e36ee2154ed1b37c363812736d02ca3cf62`. Reversing only the pre-freeze `statusMeaning` clarification and attempted-local-unavailable label correction exactly reconstructs the previously reviewed `ba5eb9e5cdbfe72f4b40bfbb709e7dd4df00aa7ffd8bf815c45f32f4f1ade3e2`; neither changed dispatch nor comparison behavior. The final runner's nine offline controls also pass independently.

This is one fixed unsigned, unpriced block-end development case against raw provider execution, not a product API run or a population accuracy estimate. Proofs and comparison traces come from the same provider. Header hash/proof verification does not establish consensus or finality. The audit does not recompute a complete poststate root, settle fees, verify signatures, prove complete economic effects, compare the full call tree, establish an OS sandbox, or extend support to SELFDESTRUCT.

Original capture manifest: `eba759a9e0bec7fd50a9160a42b0a76d79966a8f9f7f4d1c9d4cfc0bbce93dab`.

Plan: `ff9a66e5006a96a76d353c3aa5aa6f77ac9089c367a939d1ec19f32a033c57cc`. Source manifest: `49c5fd113a4fec2a2687b501d22e9b38deed767d55e656ee2ebc0ca6ce99bcf1`. The executed local implementation is `422516798eda7eb0aa5278cc3c3354f179743ea99fb9fd9cb1041dd80f3c7774`; the product fingerprint retained in the plan is provenance only for this raw-provider comparison.
