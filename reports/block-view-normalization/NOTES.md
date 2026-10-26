# Offline block-view normalization

This is a development check of saved observations for HyperEVM block 49544166, hash `0x1a90cb1b12defb35c5b542b1218b4b5f8524d7eea721ab1f0cf28e8b6af8e2b4`. It makes no network requests and does not revise the failed prospective v1 pilot.

| Saved inputs | Reference rows | Occurrences | Unresolved | Mapping |
| --- | ---: | ---: | ---: | --- |
| Earlier A5/B8 lists, official ordinary/system responses, saved system envelopes | 8 | 27 | 10 | Partial; ordinary full envelopes absent |
| Same earlier lists, with later ordinary envelopes explicitly attributed | 8 | 37 | 0 | Complete for the enumerated references |
| Later A8/B8 lists and ordinary envelopes, with earlier system envelopes explicitly attributed | 8 | 40 | 0 | Complete for the enumerated references |

The official ordinary list contains five hashes; its full transaction envelopes were not captured. The two composite cases use actual A/B ordinary lookups from the later position diagnostic, with their original response hashes, request IDs, artifact hashes and timestamps retained. These are not simultaneous observations. The first case shows the conservative outcome without those later envelopes.

All three cases retain five ordinary and three HyperCore system reference rows. The three system references have three additional provider hash representations, giving eleven distinct observed hashes. The narrow mapping requires all twelve non-representation fields to agree and only permits the diagnosed `hash/r/s/v` representation change. This establishes scoped correspondence, not cryptographic equivalence. A's five-entry response and later eight-entry response remain separate views; there is no permanent endpoint classification.

Every replay boundary and execution order remains **unknown**, every execution remains **not assessed**, and no accuracy fraction is calculated. Unknown or incomplete ordinary envelopes remain unresolved. Unknown system targets remain reference rows. An empty system list can establish this normalizer's enumeration only when explicitly requested by block hash; an empty number-only response cannot prove the selected hash.

`manifest.json` pins the exact report, summary, verifier, frozen source and these notes. The verifier separately checks all three original capture hashes and every selected response's raw hash, parsed body, HTTP status and request ID, regenerates all outputs, and checks the expected counts. Run from the repository root:

```sh
node reports/block-view-normalization/verify.mjs
```

The original prospective selection failure, full position-proof requirements, finality/parent continuity, budget and sealing rules remain unchanged. This report supplies development evidence for future rules; it does not admit a cohort or establish all-chain completeness.
