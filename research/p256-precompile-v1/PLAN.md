# P256 fixed-vector adapter check

Freeze and execute all 782 entries, in their original order without replacement, from pinned official Geth commit `1df30b18d9ed35ee9d28ffd4648442c2204554ad`, `core/vm/testdata/precompiles/p256Verify.json`. Exact source bytes: 443,336; SHA-256 `72be71957c3e4292d874b3e2a6a2fc2142524433b01cb9a9552b9bb2528c214d`. Expected outputs and 6,900-gas assertions remain unchanged. The corpus contains 567 success-word expectations and 215 empty-return expectations.

This is a pure-precompile development check of the owned EIP-7951 adapter against saved expected outputs. It does not execute a Geth binary, transaction or VM, compare full poststate roots, establish broad product accuracy, or make public calls. Separate local controls cover execution rollback and host-error handling. Expected outputs never enter the adapter.

Before dispatch, `freeze` exclusively creates `capture`, copies the exact adapter and complete installed local dependency tree with file identities, pins this runner and Node executable, and freezes every input/expected/gas declaration plus source provenance. `check` verifies the exact plan hash and runtime. One `run` uses the archived adapter and retains all 782 slots; failures, mismatches and any unattempted remainder remain visible. A 60-second wall/monotonic scheduling and callback budget applies; it is a cooperative synchronous check, not process isolation. Source or terminal failures withhold packet-level usability. No retries or substitutions are permitted.

```sh
node research/p256-precompile-v1/run.mjs freeze
node research/p256-precompile-v1/run.mjs check EXACT_PLAN_SHA
node research/p256-precompile-v1/run.mjs run EXACT_PLAN_SHA
```
