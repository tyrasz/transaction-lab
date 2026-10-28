# Independent artifact audit

The sealed fee-control packet verifies as **14 matched, 2 mismatched, 0 unavailable, 0 unattempted** across its fixed 16 synthetic cases. Cases 7 and 8 remain mismatched because Geth returned `pass:false`; their matching displayed roots do not override that result. This is neither an ordinary-transaction coverage rate nor a comparison of Geth gas, return data, or receipts.

The audit bound the externally supplied capture manifest `43d8d063d06ceea69ef3ef3f4a71cac0c227f47fc32c1993212af8fd7b5b6d7a`, plan `d5ae96b7f621ab2d5f3206e0068f65313deeb1cf308d97c02ca22c00f0586c68`, and source manifest `29e1761097cef073599c05e41c75acce45cdb78f8429c8dde78a4f68f691df86`. All 121 evidence files and 3,885 runtime entries were checked, including dependency modes and the relative symlink. The Node executable and available pinned Geth binary hashes match their declarations.

For every case the audit independently reconstructed the initial allocation root, checked the execution-header hash and signed type-2/type-4 transaction against the admitted request, and reverified authenticated input facts from 60 saved proof responses. These are synthetic parsed RPC results, not captured network response bodies. Each product delta was applied to a fresh full-state MPT, and the resulting root was bound to the Geth expectation. Saved full-VM output was compared afterward; it did not substitute for the product-derived expectation. Closed subprocess records, exact recorded arguments, raw output base64/counts/hashes/strict UTF-8, durable product seals, expectation seals, source identities, timing bounds, fixed ordering, and all result counts were checked. The independent raw classifier does not import the producer's adjudicator.

No product, full-VM, or Geth target was reexecuted, and no network request was made. The audit reuses archived cryptographic, transaction, MPT, and initial-fixture construction primitives. Saved chronology is established by the declared protocol and recorded artifacts, not an external trusted clock; the frozen Git provenance is bound but Git history is not reconstructed.

## Cases 7 and 8

Both raw responses report a zero post-state-root assertion failure despite a displayed root matching the product-delta root. Exact copies of three source files are included under `pinned-geth-source/` and checked against the captured Geth source inventory. In the pinned source, `StateDB.handleDestruction` rejects deletion of preexisting nonempty storage under Cancun rules; `Commit` returns a zero hash on that error. `StateTest.RunNoVerify` discards the commit error, and `Run` returns on the root assertion before checking logs. The CLI separately computes its displayed root. This source path supports the recorded behavior as an inference without diagnostic reexecution. It does **not** establish that Geth's log assertion passed for either case. Both original mismatches are retained.

## Reproduction and controls

From the checkout root, run:

```sh
node research/delegated-sender-geth-v1/fee-controls/audit/verify.mjs
node --test research/delegated-sender-geth-v1/fee-controls/audit/verify.test.mjs
```

Eight test groups pass. Controls reject malformed or altered output bytes, process and identity inconsistencies, timing violations, incomplete storage words, inventory drift, and re-sealed semantic mutations to counts, recorded process paths, expected roots, and authenticated initial facts. A complete disposable relocated capture also verifies, retaining original recorded process paths. The original capture is unchanged.

`ignored-dependencies.paths0` contains the 3,841 exact NUL-separated dependency paths requiring force-add when preserving the archive in Git. It contains paths only, not credentials. `report.json` records its hash and all per-case audit outcomes; `controls.tap` retains the test output. `manifest.json` seals this supplemental audit separately from the original capture.
