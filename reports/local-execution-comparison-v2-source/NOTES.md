# Original v2 local execution source preservation

This archive preserves the exact source profile used by `reports/local-execution-comparison-v2` before the current local engine gained Ethereum execution support. The original packet and current engine remain unchanged.

All ten bound engine, package, lock and test files, plus the original runner, were recovered from commit `9d64eb60e5363bfa8f43f4cc1100ce3ed2e1f4bc`. Each recovered byte count and SHA-256 matches the original report's source inventory. `preservation.json` records the Git paths and blob identities; `source-inventory.json` preserves the original runtime and dependency declarations.

The archived engine fingerprint is `ff8e4d13a2160256b35ab1f3a64e3c05e750e515e8b87b4f3ce4b59d7bed6575`. The original results remain `c2eec4623db8890e21cdff02cdd31f0249c055e3485abdf026784c4ae81df803`.

Run the offline reproduction with:

```sh
node reports/local-execution-comparison-v2-source/verify.mjs
```

The verifier checks the original packet, archived source bytes, original lock identity, direct dependency versions/integrities, and metadata identities for all 14 installed dependency packages. It reconstructs a temporary tree, uses the archived runner and engine, links the checked installed dependencies, and runs the original `--verify` unchanged. The current engine is not imported. Outgoing fetch and socket connections are blocked in the child process.

`verification.json` records a passing reproduction: two matched cases and five controls. The original runner compares the entire deterministic report and input packets exactly; this wrapper adds no timing or other normalization. Its verification output also exactly matches the original saved verification result.

Dependency metadata hashes are observations made during this preservation, not retrospective proof of every installed source file or npm tarball. The original lock and direct versions remain pinned, and a changed dependency identity or Node/V8/platform identity causes verification to fail. The artifact remains a reproduction of the earlier sparse, provider-supplied input experiment; it makes no new execution-coverage or state-proof claim.
