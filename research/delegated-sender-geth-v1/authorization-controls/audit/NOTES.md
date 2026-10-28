# Authorization controls: retained results and encoding supplement

This post-capture audit leaves both captured packets unchanged. The [original sixteen-case result](../capture/results.json) remains **15 matched, zero mismatched, one unavailable**. All sixteen product executions were retained: fourteen succeeded, one reverted and one exhausted gas. The unavailable Geth invocation, [case 014](../capture/raw/014.json), exited 1 with `invalid hex storage key/value "7"` before execution.

The separately frozen [one-case encoding supplement](../storage-encoding-followup/capture/results.json) matched the unchanged product-applied poststate root and Geth's internal expected-log-hash assertion. Its sole input change pads the same prestate storage value `0x7` to 32 bytes. The audit independently checks numeric equality and exact equality of every other input field, including all allocation keys, account fields, header environment, authorization tuples, transaction fields, signed bytes and expectations. No other case, product execution or full-VM execution was repeated. The original denominator and outcome remain unchanged.

The [machine-readable audit](report.json) verifies 121 original evidence files and 3,882 archived source/dependency entries: 23,827,086 regular-file bytes and one symlink. It checks exact tree membership, bytes, hashes, file modes, symlink target and containment; signed type-4 signatures, senders, nonces, tuple mapping and fork/header bindings; initial allocation roots; product seals; independent application of retained product changes to a fresh full MPT; ordered log hashes; raw process streams, bounds and terminal usability gates. It independently classifies retained Geth output, without importing the producer's adjudicator. The supplement has 16 evidence files, including its three source files. No VM/Geth target was rerun and no RPC was made by this audit.

The malformed-designation case retains a full-VM disagreement: product gas 46,000 versus 36,800, with different poststate roots. Geth matches the product-applied root. The existing-empty and absent-authority cases remain distinct. Geth statetest agreement here establishes only the full poststate root and its internal log-hash assertion; zero-price roots do not independently establish refund gas, return values or receipt equality. These are fixed synthetic development controls, not a population accuracy estimate. Header/MPT primitives are reused from the archive, and the auditor authored the capture harness; this is a separate evidence/adjudication implementation, not an independent source-author review. Recorded timestamps and frozen ordering are not externally attested clocks.

Pinned identities:

- Original evidence: `c53e86b76856b2ae0b9b56e0c1dba30580619e18e9970b0561b2657d008032ae`.
- Original plan: `363ca61a1297749a41072a96e464daaf990d3f52003eda8f3241091af44e1d3d`; source: `26deefa0cbe41ff82ecea143a3835dc80e6939e68afbf9d446a2d188dcd43cdb`.
- Supplement evidence: `ede03a28f5607e4e7832676a124272c1a135305d06d29375cfbad4554ec5ad36`.
- Supplement plan: `e81594c96012c2424b060dafcea99bd734bd6d59cfaec90ed30f082f8af5679b`; corrected input: `3979348c55e97a5e5a6dd1061f22b1fa8cc35617589a93a62114cfb311643a08`.

Before release, the audit's process-path checks were corrected to use the frozen original plan's `sourceRoot` and the bound supplement `originalDirectory`; artifact reads still use the current checkout. This permits verification after merge without changing any captured paths or bytes. The prior audit manifest `d964acbb0c16943c9385d6d237bad8e8a618eb49cff8c28f9da69dcae9092664` is superseded by the current audit manifest. Neither capture manifest changed.

From this worktree, read-only verification and five focused negative-control groups are reproducible with:

```sh
node research/delegated-sender-geth-v1/authorization-controls/audit/verify.mjs
node --test research/delegated-sender-geth-v1/authorization-controls/audit/checks.test.mjs
```

[ignored-dependencies.paths0](ignored-dependencies.paths0) lists the exact 3,841 ignored archived dependency paths, NUL-separated and relative to the worktree. Its SHA-256 is `96b03a7562f3c71ba88fa2fe9a95b04b0236174f431e018a4652c77a56839ff5`; it is suitable for `git add -f --pathspec-from-file=... --pathspec-file-nul`. The audit does not stage files. Current Node and Geth binaries must remain available at the pinned paths for identity checks.
