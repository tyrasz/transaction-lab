# Supplementary offline audit

The original prospective packet remains unchanged: **N=436**, **S=16**, and all 16 selected outcomes remain **unsupported / not comparable**. No local execution, product simulation, replacement sample, or public request was performed for this audit.

Use [audit-corrected.json](audit-corrected.json). The retained [initial audit](audit.json) is **superseded**: its all-population subtotal mistakenly used a 64 KiB calldata threshold instead of the frozen **32 KiB** threshold. The correction identifies one additional nonselected transaction with 37,380 calldata bytes. Timestamp checks and selected-case counts were unaffected.

- Both providers supplied `blockTimestamp` on all 436 transaction envelopes, including all 16 selected rows. Every value was a canonical uint64 and matched its containing, hash-verified full block header exactly: **872/872 provider-envelope checks**, with no other unknown fields.
- Block 26283332 contains 225 census rows and seven selected rows; block 26283333 contains 211 and nine.
- Under the frozen rules, all 436 rows are unsupported. **420 have only the unrecognized timestamp field; 16 have additional blockers.** Those additional reason occurrences are four access-list cases, four blob cases, three authorization cases, five gas-limit cases, and one calldata-size case; reasons can overlap.
- Among the selected 16, 15 have only the timestamp blocker. The remaining transaction, `0x50954623e4c71f6c57a96419e93b840349e362f617e92342372c9c9db471d48b`, declares 8,000,000 gas, exceeding the 5,000,000 profile limit.

[development-reclassification.json](development-reclassification.json) records an explicitly **post-inspection** run of the updated validator: the same census, seed, ranks, selected transactions, and raw provider envelopes produce **15 projectable / one unsupported selected input**. These are projection admissions, not successful executions or revised prospective outcomes. No all-population execution rate is inferred from the timestamp-only arithmetic.

[Geth PR #33709](https://github.com/ethereum/go-ethereum/pull/33709), consulted during the adapter fix, documents the mined-transaction timestamp field. This supplementary audit itself makes no network calls. Header hashes and provider agreement do not prove consensus, finality, or independent provider implementations.

The corrected audit SHA-256 is `5b16c94a954b4b328bfcd15a8a1a7c6909f867117d6fea1a3a961b2aff93e960`; development reclassification is `a6ea62cdfa229b969a7da8fa4f90495b31ead271e75b1393089601cfdab9b1aa`. Both record their exact input/source identities.

From the repository root, reproduce the supplementary checks, including the original archived verifier:

```sh
node reports/ordinary-ethereum-cohort-v1-audit/verify.mjs
```

To run only the original verifier against its unchanged sealed packet:

```sh
node --input-type=module -e "const {verifyCohortEvidence}=await import('./reports/ordinary-ethereum-cohort-v1/runtime/research/standard-evm/cohort-verify.mjs'); console.log(await verifyCohortEvidence({outputDirectory:'reports/ordinary-ethereum-cohort-v1',expectedManifestSha256:'fdb96c50015b6854f63d28d1d84dd715b36db19146d04086aa824ce55edbf50b'}));"
```

The archived verification passes 294 evidence files, 1,777 source entries, and 68 wire records. It rechecks evidence and accounting; it does not rerun an EVM.
