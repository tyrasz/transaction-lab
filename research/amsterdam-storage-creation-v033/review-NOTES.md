# Saved-artifact review

This review evaluates only the original immutable six-case capture. It does not
execute the product, EthereumJS, Geth, or any network request. The separate
three-root-case correction is outside its scope.

The external plan, source, and evidence manifest hashes are embedded in
`review.mjs`. The verifier rehashes the full capture, runtime source closure,
referenced dependency trees, and retained toolchain provenance; binds raw byte
streams and process arguments to their recorded source root; checks six signed
type-2 envelopes and full header hashes; reconstructs initial and available final
state roots; and reproduces the saved observations, pairwise booleans/nulls, and
summary. The JSONL frame parser is reused from the archived producer and is
explicitly a shared component. Account/storage proof paths are not independently
re-walked: their saved replies are joined to collector/broker identities and
their claimed facts checked against the complete initial allocations.

Unsupported product attempts are validated only as whole-attempt rollback with
empty changes and no gas or return prediction. Failed Node workers are retained
as unavailable, including empty stdout and original stderr. A valid evidence
packet does not imply that every target ran or that the clients agree.

The six focused controls use fabricated records and temporary files. They cover
raw-byte/process failures, inventory mutation and relocation, storage-delta
baselines, null comparisons and mismatches, rollback-only state, and proof-reply
joins. No captured transaction is rerun by these tests.

Run from the repository root:

```sh
node --test research/amsterdam-storage-creation-v033/review.test.mjs
node research/amsterdam-storage-creation-v033/review.mjs .
```

The emitted JSON reports actual retained process failures, observations, roots,
comparison channels, checker identity, and limitations. Product-first ordering
is supported by the frozen driver and seals, not an independently attested clock.
This is a selected synthetic diagnostic with inert system scaffolding, not a
canonical-winner or population-accuracy determination. EELS remains source-only.

## Completed original-packet check

The artifact check reproduced every saved classification. It checked 180 capture
entries, 64 runtime entries, 3,841 referenced dependency entries, all 18 raw
process records (272,689 output bytes), six signed inputs and header hashes,
24 reconstructed full MPT roots, and 17 joined input replies. Evidence usability
is true; this does not turn unavailable executions into observations.

- Product: three unavailable root-case workers, one unsupported internal
  storage-only attempt with whole-attempt rollback, and two observed controls.
- Shared EthereumJS: three unavailable root-case workers and three observations.
- Geth: six observations. The storage-only targets deployed while preserving
  their initial storage in both root and internal creation.
- The internal storage-only EthereumJS/Geth pair agrees on root success status
  and disagrees on the other six fields. Both internal deployable controls agree
  on all seven fields in each pair. All comparisons involving unavailable or
  unsupported product executions remain null.

The unavailable root workers exited with the retained declaration-equality
failure before transaction execution. Their original bytes and classifications
remain unchanged. No result from the separate correction is included here.

Six fabricated controls passed in 68.6 ms. Final report:
`/tmp/evm-v033-storage-review-final.json`, SHA-256
`c98a72d71980e84c62d7b6472b15ed51f8db3b06c663e6f5c4a4cb7fbf54b713`.
Checker SHA-256:
`1f8f2cc7ccff3672136a42cc074faecd81e43ca33904cfde880366d87ae67183`.
Test source SHA-256:
`ae715d04a853d2e584132d5cb5ce38573d02ca204113d1cfdafd0e95d894b90b`.

The first artifact-check invocation stopped on the reviewer's overly narrow
assumption that an unavailable wrapper omitted `gasAccounting`; the actual
wrapper explicitly returns null. The checker now permits omitted/null accounting
but still rejects any claimed gas object, and a fabricated regression covers
both forms. This was a verifier schema correction, with no capture mutation.
Its error remains at `/tmp/evm-v033-storage-review.err`; both preparation logs
and final report are retained separately.

Repository copies preserve those temporary files exactly: `review-final.json`,
`review-final.err`, `review-controls-final.tap`, `review-json`, `review-err`, and
`review-controls.tap`. The first output file is empty because the checker
stopped before producing a report; the adjacent error is the original failure.
