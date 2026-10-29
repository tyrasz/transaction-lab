# Native balance packet artifact audit

The sealed six-case packet verifies without rerunning a product, full-VM or client execution. All six retained comparisons match, including 20 explicit before/after native-balance pairs. The artifact verifier checks 34 captured files and 4,019 runtime entries (one symlink; 24,893,647 file bytes), joins all 42 retained proof/code input records, and cryptographically re-verifies all 21 account proofs against their declared header roots.

For every case it reconstructs the initial MPT from the declaration, binds the offline signed type-2/type-3 counterpart to that request and header, and applies the saved product deltas to a fresh MPT. All six resulting roots match both the saved full-VM root and the saved third-MPT root. Exact identities, wei units, balance arithmetic, unchanged native-read snapshots, one original VM execution, gas/refund arithmetic, fee charges and blob burn are checked separately. In the Shanghai miner-deletion case the credited tip is burned by deletion; the created-then-deleted case ends with an absent account and no net creation row. Missing accounts are established through proofs, not assumed from missing measurements.

The original packet took 4,107 ms wall time and 4,107.0905 ms monotonic time. All twelve recorded process outputs completed inside their limits and decode to the retained results. There were no unavailable, mismatched or unattempted cases. The audit does not independently authenticate exact per-probe timing partitions of diagnostic input IDs; it binds the complete proof/code evidence and account facts.

This is known synthetic development evidence. The counterpart shares EthereumJS with the product, and this audit performs no independent-client execution or population accuracy measurement. There is no public RPC or capture rerun. The packet hashes source/dependency bytes but does not archive those bytes again: reproducing this verifier requires the matching checkout/runtime, which it checks before importing. The recorded Git HEAD is the parent baseline, not a claim that all captured runtime changes were already committed; the exact source manifest identifies those bytes.

Pinned identities:

- Capture manifest: `ff3fc44eb75b62cbc787a75beee23a9b7e256220d83b79d258e2d8c6f8b33b18`
- Plan: `3dd48496b5388bece2ac5130f8a0f6ceb560ade61048eaa079613049f1e27b92`
- Source manifest: `6ea577ca6785966b830de594b34e2c3e2c120c4c2400a127ed3aa5da274bf6ae`

From the matching project root, run `node research/native-balance-v029-review/verify.mjs` for artifact-only verification. The five controls in `node --test research/native-balance-v029-review/verify.test.mjs` include captured-file alteration, raw-output/parsed-result divergence, failed-process result admission, native amount/identity/unit/mutation changes and fee/burn/refund tampering. They construct/recompute proofs and MPTs but execute no EVM target.

The original capture is unchanged. This supplement's own six files are bound by `artifact-audit-manifest.json`; parent-owned notes and earlier regression logs are outside that supplemental inventory.
