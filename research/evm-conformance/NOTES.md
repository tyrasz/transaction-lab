# Official full-transaction conformance v1

Post-seal supplement. The original [frozen plan](frozen-plan.json), [32-vector selection](selection.json), [results](results.json), and [result manifest](results-manifest.json) are unchanged.

The first run matched all **32/32 selected official vectors**: 12/12 nested-call cases; 12/12 rollback warmth, SSTORE, transient-storage and refund cases; and 8/8 explicit non-KZG precompile cases. There were zero mismatches, unavailable results, skipped rows or replacements. The first run took 4.54 seconds; all archived source bytes remained unchanged. [Individual results](results/) preserve every actual output and comparison.

This tests the separately installed EthereumJS 10.1.3 full signed-transaction stack against official expectations. Each case reconstructs and checks the exact signed transaction bytes, signature and sender, loads complete fixture prestate, and executes with actual Osaka admission rules and fees. It compares the complete resulting MPT state root, ordered logs hash, and official receipt status, gas used, transaction hash and bloom. Expected full poststate is loaded into a separate manager only to check the fixture's internal root consistency.

The fixed slice contains 28 legacy, one access-list and three authorization transactions. All 32 top-level executions succeed and have empty committed logs; internal failure/rollback paths are checked through their state roots. The log-hash comparison therefore exercises only the empty-log case here. Measured gas is 28,027–2,045,140. Genuine top-level REVERT and nonce/balance/fee/intrinsic rejection are separate synthetic harness controls, not additional official vectors. This is **not** a sparse product API accuracy rate, a random on-chain cohort, all-fork coverage, consensus/block validation, or blob/KZG-sidecar admission evidence. No product source was changed for this harness.

Acquisition used the actual [official tests@v21.0.2 release](https://github.com/ethereum/execution-specs/releases/tag/tests@v21.0.2), exact commit `e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e`, and [EthereumJS VM 10.1.3](https://github.com/ethereumjs/ethereumjs-monorepo/releases/tag/%40ethereumjs%2Fvm%4010.1.3). The 939,189,561-byte archive matches its publisher SHA256. The initial 8 GiB scan limit failure remains in [scan.json](acquisition/scan.json); an approved acquisition-only continuation completed its 15.46 GB streamed scan under a 64 GiB ceiling, retaining 55 bounded candidate files / 14,297,957 bytes. Final selection uses 28 original files. The downloaded full archive remains temporary outside git. The 17 dependency tarballs total 2,425,829 bytes and all match their locked npm integrity values. Two unsuccessful source-document lookups are also retained; no retry was hidden.

The per-vector gas ceiling was raised *before selection/execution* from 5,000,000 to 16,777,216 to preserve the official signed call-chain transactions. The product's 5M bound did not change. The fixed run used 10-second child deadlines, 512 MiB child heap, 1 MiB output caps and a six-minute overall limit. Source closure is 2,224 files / 25,455,519 bytes, bound to Node v22.23.2 and its executable hash.

Exact SHA256 identities:

- Frozen plan: `013b68e6ca21f380c7ae40143fb2d23792900445b29d3df30f7913bd4058f620`
- Selection: `57b378c58049f1c91e4ec57c1f5f11e9d5856bbf5f31c93ceedb988784eefe82`
- Original result manifest: `0927d39012f7f53df1b294c0630afe549eed65537fab1f4f0ca18bc1d3c63df9`
- Official archive: `e2fa7ea2ea516459f9ab92284b2927892f318f4e1f78ca802cb05a6c3b479ed9`

Offline reproduction from the repository root:

```
node research/evm-conformance/verify.mjs --replay
node --test research/evm-conformance/source/engines/fixture-evm/test/state-test.test.js research/evm-conformance/harness.test.mjs research/evm-conformance/verify.test.mjs
```

The first command checks exact source, Node and result identities, then reexecutes the same 32 archived vectors without network or changing original results. [verification.json](verification.json) records exact reproduction of every VM output; only host elapsed times differ. This is reproduction of the original sample, not 32 new observations. The second command covers 13 synthetic adapter/runner controls and three supplementary audit controls. The post-seal verifier and notes are outside the original result manifest and are included in the separate packet manifest.

Retained-data acquisition verification is available with `python3 research/evm-conformance/verify-acquisition.py`. It rechecks all 17 locked tarball integrity values, compares every archived dependency file to its original package bytes, and verifies retained candidate/input hashes. The full 939 MB release archive is not in git: its publisher digest, complete member inventory, and candidate membership cannot be independently recomputed from the retained subset alone. While the temporary archive exists, `python3 research/evm-conformance/verify-acquisition.py --archive /private/tmp/transaction-lab-execution-fixtures-v21.0.2.tar.gz` additionally rechecks all of those claims. Both local verification results are retained; losing the temporary archive requires downloading the same exact official asset to repeat that full acquisition check.

[Root verification](root-verification.json) independently reproduces the same 32 archived results. It adds no new official sample or product observation.
