# First v2 prospective pilot: enumeration remains inconclusive

One process ran the frozen CLI from clean commit `6eb760752ea7840dad1ab647d3ed27b1ca6629a8`, with the default PLAN-V2 limits and three fixed endpoints. Session 37730 completed with exit 1, the declared outcome for an inconclusive denominator. No retries, replacements, broadcasts or source changes occurred. The original v1 pilot and all earlier evidence remain unchanged.

T0 was `2026-10-26T07:52:08.304Z`. The finalized observations were 3 ms and 2 ms after their scheduled T0+60 s and T0+180 s gates. F was 49,556,877; the selected consecutive blocks were 49,556,878 and 49,556,879. Their parent links, future timestamps and within-provider anchor/full views passed the frozen checks.

| Retained outcome | Count |
| --- | ---: |
| RPC calls / successful JSON-RPC bodies | 39 / 39 |
| Response bytes / reported elapsed time | 142,324 / 196,927 ms |
| Selection / product / comparator RPC | 19 / 6 / 14 |
| Official reference rows | 2: one ordinary, one system |
| Unresolved occurrence rows | 3 |
| Scheduled attempt slots / actual product invocations | 5 / 1 |
| Transport errors / budget exhaustion | 0 / none |
| Combined denominator | unknown (`null`) |

The unresolved rows are occurrences, not three additional distinct actions. They must not be added to the two references to invent a five-transaction population. All five ledger rows remain visible; four consume their slots without an invented simulation input. No coverage fraction is reported.

## Why the system reference remains unresolved

Block 49,556,878 has hash `0x95d52fc412181194a7385fc8a9cede857d59b0292456f04a77f7a4047a8598e0`. Official ordinary enumeration is empty; official system enumeration contains `0xeed29e2a5267e47adfbf0695f0c106dbb68313e8a88cac38ed0ebdf528a35586`. A's anchor/full lists are empty. B's anchor/full lists contain `0xb0a8e70624ed37ba531f6678ecc03d2a30707ca72e1609c3b67975c3923765cf`; the single bounded A lookup returns the same full envelope as B.

The official and provider envelopes agree exactly on the twelve frozen action/context fields. Only hash/r/s/v differ. Official reports r=0, s=0, v=2033; both providers report r=1, **s=1**, v=2034. The frozen correspondence rule permits the previously observed s=sender pattern, while this sender is `0x2222222222222222222222222222222222222222`. The new s=1 form therefore remains unresolved. The official reference, A lookup, B inline envelope and B anchor occurrence are retained. This is bounded evidence of another representation form, not proof of equivalence or permission to infer an execution boundary. The rule was not changed after seeing the outcome.

## Ordinary transaction result and limits

Block 49,556,879 has hash `0x4766c39d7b5060afbdc5e5ef5dfad1c79e82f8568ba24e7a3893017eb598d73b`. All three ordinary lists agree on `0xf75494a826b95ba11a4d265a6700635ba5d8345531986d21684bfc615b5d3fd7`, reported index 0. The product returned successful historical execution, gas 33,545, for selector `0xe4fc6b6d` at `0x7bee5f2684941efc36b32a71d3f9aabb050d6bdb`. Protocol coverage is explicitly unsupported.

A/B original transaction envelopes, receipt identities and strict ordered full call trees matched. Exact original-position replay remains incomplete: a complete replay is not present on both providers, and this is a type-2 transaction under the existing fee-profile limitation. The comparator retained one uninterpreted event and no observed configured balance/allowance candidates. Empty candidate arrays do not establish absence of effects. System exact replay, all-effects completeness, general security assessment and vendor comparisons remain unassessed.

## Audit and provenance

`audit.mjs` is an offline supplemental audit, importing no product or network code. `node <run-directory>/audit.mjs` verifies the pinned report/raw hashes, all indexed artifact bytes, current source closure, every successful wire body/ID/hash/byte count, normalization packets against selection records, all cohort identities, budget counters and product sealing before comparator requests. The final ledger's display `reason` changes on attempt assignment; the original normalization reason remains in immutable `cohort.json`. `audit.json` records the passing result. This checks evidence consistency and accounting, not provider truth or an independent execution engine.

- Full source closure SHA-256: `37dfa8d10226b144da8895ac7860171aad5fe686a8d630326bd22fe18f042e72`.
- Engine v0.8.0 SHA-256: `2205334781a09baf98c3f5cb05a546bcca7d4946aea33b510d1963c8eb561a0f`.
- Report SHA-256: `37472003b8fcdb55fe29e9ac8026572cbf375bd0297773bb92b53b010145f73e`.
- Raw RPC SHA-256: `864f909e8dae63593bcc7b4f1b53f5e812dff9ee53307a4aa3647c519b6c60df`.

The runner's immutable `artifact-index.json` is unchanged. A separate supplemental manifest hashes these notes and audit files. This inspected pilot is now development evidence; it is not a representative accuracy score. No second pilot was run.
