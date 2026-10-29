# Official KZG fixture preparation — no execution

All 180 predeclared Osaka point-evaluation state-test identities are retained. None is admitted unchanged by the current public product profile. This is a structural finding, not an execution result or accuracy measurement.

| Fixture family | Cases | Declared gas |
| --- | ---: | --- |
| External proof vectors | 122 | 16,777,216 |
| CALL / STATICCALL / CALLCODE / DELEGATECALL | 12 | 16,777,216 |
| Precompile gas boundaries | 24 | 16,777,216 |
| Invalid inputs | 14 | 16,777,216 |
| Transaction entry point | 6 | 94,147–94,161 |
| Valid inputs | 2 | 16,777,216 |

Every fixture explicitly selects Osaka but supplies block number 1 and timestamp 1000. The product derives the fork from the pinned mainnet schedule and supports Shanghai onward; it cannot execute these declarations faithfully through its public entry point. In addition, 174 cases exceed the unchanged 5,000,000 gas ceiling. The six smaller cases still have the fork mismatch. No timestamp, gas limit, code, initial allocation or signed transaction has been changed, and no hidden fork override has been added.

The signed inputs comprise 174 legacy type-0 and six access-list type-1 transactions. All 180 signed byte strings were reconstructed exactly, decoded, signature-checked and bound to the declared sender and initial nonce. Each fixture has exactly one Osaka post case with publisher full poststate, root, internal logs hash and receipt, without an expected admission exception. The publisher receipts declare 176 successes and four failures; these are **not observed product or Geth outcomes**. Full expected-state roots have not been independently recomputed in this preparation step.

Initial states contain at most two accounts and six storage slots; calldata is at most 1,215 bytes. A PUSH-aware static scan of initial code found no BLOCKHASH, BLOBHASH, BLOBBASEFEE, CREATE, CREATE2 or SELFDESTRUCT opcodes. This is a static inspection, not a guarantee about arbitrary dynamically supplied code. State tests describe isolated transaction transitions; no block-start system calls, real-chain header authenticity or sidecar admission is implied.

## Acquisition and provenance

[acquisition-plan.json](acquisition-plan.json) fixes all six paths and all 180 source-index rows before extraction. The complete publisher archive was hashed before and after the bounded streaming scan: both match `e2fa7ea2ea516459f9ab92284b2927892f318f4e1f78ca802cb05a6c3b479ed9` (939,189,561 compressed bytes). Exactly six files, totaling 1,407,619 bytes, were retained under [official-inputs](official-inputs). The scan read 15,460,362,240 expanded bytes in 11.96 seconds within the declared 64 GiB / 900-second scan and 2 MiB retained-output bounds. No other archive member was extracted. [acquisition-result.json](acquisition-result.json) records exact file hashes and extractor identity.

The source is `ethereum/execution-specs` release `tests@v21.0.2`, commit `e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e`. The existing pinned Osaka index is SHA-256 `09b74d99dabf9ea1879cfb2952c82a3e358ea95a7b3dffa90ea567d0c92e77d8`. Its fixture IDs and hashes match all extracted declarations, with no extra or missing cases. The temporary 939 MB publisher archive remains outside this directory and outside Git; reproducing extraction requires that exact archive.

The pinned repository's original [CC0 license](LICENSE.execution-specs.md) is retained separately, fetched as a small source file rather than extracted from the archive. [license-provenance.json](license-provenance.json) binds its URL, commit, Git blob identity and SHA-256 `f81577cb97c59ed748f9117fa839b80e3be0ec605a4b66c234e07468bc011808`. [structural-report.json](structural-report.json) retains every case, reason, signed-input identity and declared expected output. [inspect.mjs](inspect.mjs) performs metadata/signature checks only; it does not import or invoke a product executor or EVM.

## Comparison plan, not authorization to execute

A faithful unchanged official-fixture run can use the pinned independent Geth state-test runner with explicit Osaka, the original signed bytes, exact initial allocation and original environment. Freeze all 180 IDs, wrappers, tool/source identities and bounded execution limits first; retain every failure and compare publisher full roots and internal logs hashes. This would establish only official client conformance for this slice, not current public-product coverage. Geth's state-test interface is not a separate return-data or gas oracle.

A faithful public-product adapter for these same inputs is currently blocked. The eventual adapter would need initial-state-only MPT proofs/code, sender nonce from that allocation, exact original gas/value/data/access-list and fee semantics, and the same declared fork/environment. Legacy fixed gas price can be represented by equal fee cap and priority cap without altering effective price or cap affordability, but that does not solve the fork or gas barriers. Product deltas would be applied to a separate initial-state MPT and compared with publisher post roots; expected poststate must never enter the product's input state. No such adapter or product fork override is added here.

Root may separately predeclare a small synthetic development packet using the retained proof bytes with a mainnet-compatible header, unchanged production gas/fee rules, all four call modes, gas boundaries, valid infinity, invalid inputs and rollback. Its changed context would make it a separate synthetic test population, never a replacement for these 180 official declarations. No product, EVM or Geth target has been run in this preparation task; no public RPC was requested.
