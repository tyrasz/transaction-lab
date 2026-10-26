# Preserved prospective v2 pilot baseline

This archive preserves the exact source closure required by the original prospective pilot's offline audit, before later application changes. It contains all **34 files** in the pre-network implementation manifest and all **14 unchanged pilot evidence files**, totaling 1,400,139 bytes. The files were copied from commit `35649a5d14606dc29cf930b6f5d158258fa374b3`; every source already matched the pilot's frozen hashes. No original file was edited and no network request was made.

The archive manifest SHA-256 is `5bd284cabfe3ea04c349a8f667c8a6c8e75916dd31ad08f8cb018e2f3d56395a`. Its source inventory reproduces `37dfa8d10226b144da8895ac7860171aad5fe686a8d630326bd22fe18f042e72`, and its engine fingerprint reproduces `2205334781a09baf98c3f5cb05a546bcca7d4946aea33b510d1963c8eb561a0f` (version 0.8.0).

The new verifier checks every archived byte/hash and the exact inventory, then runs the **unchanged original audit** inside the repository-shaped archive. Its entire output must equal the original `audit.json`. It reads no current application files and imports no application or evaluation modules. The preserved wording “Current complete source closure” refers to this isolated archive when that original audit runs here.

Run without network:

```sh
node reports/coverage-evaluation-v2-baseline-source/verify.mjs
node --test reports/coverage-evaluation-v2-baseline-source/verify.test.mjs
```

The three controls also reproduce verification from a temporary directory, reject altered archived source, and reject missing evidence without falling back to the live repository.

This preserves the original **enumeration_inconclusive** outcome: 39 RPC requests, 142,324 response bytes, two known reference rows, three unresolved occurrence rows, one product invocation and a null population denominator. It neither normalizes the newly observed system representation nor converts the pilot into an accuracy pass. This remains an evidence/accounting audit, not a new pilot or independent execution-engine comparison.
