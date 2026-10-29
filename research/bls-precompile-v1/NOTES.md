# BLS vector results

The separately declared corrected capture matched all1838 admitted rows:919 original Geth vectors executed once under Prague and once under Osaka. Each fork includes860 successful valid-input vectors and59 exceptional invalid-input vectors. There were no mismatches, unavailable executions or unattempted rows. Nine oversized original MSM vectors remain explicitly unsupported per fork (18 rows). The complete input inventory remains928 original vectors and1856 declared rows.

These are direct calls to the seven real BLS protocol addresses through the local production Ethereum call wrapper, using synthetic recorded initial accounts and a timestamp-selected public fork profile. The checks cover exact returned bytes, component/transaction gas, invalid-input failure semantics, empty logs and the expected sender nonce-only change. Geth v1.17.10 supplies independent retained expected vectors; Geth was not executed during this packet. This is not authenticated state/header validation, full signed-transaction conformance, nested-call/query coverage, or a broad transaction accuracy rate. Error wording is retained but not required to match across clients.

The first capture remains unchanged. Every admitted row failed during synthetic state construction because the worker supplied an account map where the constructor required `{accounts: map}`. Its1838 unavailable and18 unsupported rows are preserved; every execution output is null. No vector reached the EVM. The authorized correction changed that constructor call, added a real construction-only control, and froze a new source/plan for capture-v2. Expected bytes, gas values, limits, fork order and all vector identities remained unchanged. Both manifests and the explicit prior-attempt declaration are retained.

| Identity | SHA-256 |
|---|---|
| Original input plan | `b1f6b97fad0c2ed14b182d440d7283fd3efaadc70dcfb553c1491e9d24255095` |
| First evidence manifest | `80af9842a37426970a3cd681b759edafb83dda1cb805a64fa9d8fba764d4a565` |
| Corrected execution plan | `7cb82bea0fcfec8568581f57cd5b23d162791ae29d58ba62a57f929e575f507f` |
| Corrected source manifest | `5ef202ff46c79041589320a6a9a5c12d8a3c208bdb70cdc0d5c08c8f310fa662` |
| Corrected evidence manifest | `53c93e308a683020cf827b974bfdc2a696acf87e4b11544d1b99ed2db0462976` |

The corrected source archive has1857 entries/21151902 file bytes; its evidence manifest covers112 files/21208482 bytes. The first source archive has1855 entries/21127459 file bytes, and its evidence manifest covers112 files/8305539 bytes. A post-seal read verified every recorded source/evidence hash, file mode and symlink target in both captures. No target was rerun. The corrected run used36 cleanly completed workers, reported42.726 seconds wall time and42.947 seconds monotonic time, and retained19889633 raw output bytes. The longest measured case was274.188ms. Source/artifact integrity and terminal timing verdicts passed.

Nine preparation controls passed before the corrected freeze, including the actual state-constructor regression, calldata-floor accounting, malformed output/process controls, and mismatch injection. The original eight controls and failed setup remain archived with the first capture.

Read-only archive verification from the repository root (does not execute vector targets):

```sh
node research/bls-precompile-v1/run.mjs check research/bls-precompile-v1/capture-v2 7cb82bea0fcfec8568581f57cd5b23d162791ae29d58ba62a57f929e575f507f
```

An independent artifact-only review is maintained separately in `research/bls-precompile-v1-review/`. Both captures and their archived sources are immutable. No RPC, signing, broadcast or installed-dependency changes were performed.
