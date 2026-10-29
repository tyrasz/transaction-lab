# Posthoc saved-log recheck result

The original capture remains **5 matched / 1 unavailable**. This separate known-oracle interpretation correction finds **6 saved pairs matching** the five original fields plus exact normalized logs and bloom. It is not a new prospective result, original six-of-six result, transaction retry, or coverage estimate.

The checker was frozen before its first evaluation, then ran once successfully with empty stderr. Source freeze SHA-256: `fca938678ecbfda73495e050869b4a9b6c8dded02d5c61013b195487c5c9691f`. Report SHA-256: `0cdedd16dc7b169acb7d7e81f1943f2ba0a72b91ff2306aef30591990036f595`. Parent independently repeated the read-only checker and reported byte-identical output. No VM/Geth/network execution occurred in either evaluation.

Verification rehashed 3,997 capture entries, including 3,897 runtime/source entries; bound 12 raw process records and all six product seals; retained 35 proof/code request replies; and reconstructed 24 MPT roots. Exact native Transfer payload/hash/bloom agree in case 001; cases 002–006 have empty logs. Original raw output accounting is 263,810 bytes. The current capture has no missing or altered artifact.

Seven preparation groups used fabricated data only. They cover empty/nonempty success, self-consistent payload disagreement, missing/malformed/unbound logs and hashes/blooms, five-field disagreement, failed/raw/malformed/over-time process records (including valid empty Geth stdout), file identity tampering, and independent allocation/delta MPT arithmetic. Their names do not imply actual execution targets. Peer review passed the same seven groups before evaluation.

Re-run the artifact-only check from the repository root:

```
node research/amsterdam-creation-geth-v031/supplement/verify.mjs research/amsterdam-creation-geth-v031/capture fca938678ecbfda73495e050869b4a9b6c8dded02d5c61013b195487c5c9691f
```

The checker reads from the supplied checkout path and binds recorded process arguments to the original frozen sourceRoot. Geth receipt dummy block hash is not the fixture header or a consensus assertion. Broker proofs are retained and source-bound but are not independently re-proven by this narrow correction. The product is the isolated parent-validated unsigned API core; public HTTP admission is not tested. Product-before-Geth ordering is source-protocol and seal binding, not a fabricated absolute dispatch timestamp.
