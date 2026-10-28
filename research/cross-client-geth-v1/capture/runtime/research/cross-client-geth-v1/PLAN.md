# Independent Geth replay of the existing 48 official vectors

This new experiment reuses all 32 identities in `evm-conformance/selection.json`
and all 16 in `evm-lifecycle-conformance-v1/selection.json`, in that order.
Selection is already public development evidence, not a blind holdout. Each
selected fixture must have exactly one Osaka post entry and no expected
admission exception. A one-key wrapper preserves the entire selected fixture
unchanged. Original source files, selections, wrapper bytes and expectations
are frozen before any of these targets execute in Geth. No substitutions.

The reference is official go-ethereum commit
`1df30b18d9ed35ee9d28ffd4648442c2204554ad` (v1.17.10), built with the
SHA256-verified official Go 1.27.3 Darwin ARM64 distribution. The build manifest,
exact executable digest, pinned source files describing result/check semantics,
Node runtime identity and this harness are bound in the freeze. The executable
and complete toolchain remain in the separate workspace toolchain directory;
offline replay requires that exact binary and fails if it is unavailable or
changed. The capture does not claim to contain a portable build toolchain.

Each child receives only its unchanged official fixture. It runs
`evm statetest --statetest.fork=Osaka --run=^<escaped exact identity>$ <wrapper>`.
No benchmark, dump, alternate fork, transaction transformation or state override
is used. The harness requires one result with the exact identity/fork, a boolean
pass flag and the expected full state root. Exit zero alone is never a pass.
Geth's own pinned test implementation checks the official log hash. Receipt
fields, receipt gas, return bytes and detailed logs are not independently exposed
or checked by this command; no five-channel product agreement is claimed.

Limits are five seconds and 1 MiB combined stdout/stderr per child, a six-minute
overall dispatch window and 48 fixed slots. A killed child has a further one-second
close grace. If closure remains unconfirmed, the attempt is unavailable and all
remaining targets stay unattempted; the capture cannot claim valid results.
Raw bounded output bytes are retained as base64 with byte counts and hashes;
invalid UTF-8 cannot pass. Output exceeding the bound retains only the captured
prefix and records the larger observed byte count. Children use GOMAXPROCS=2 and a
256 MiB Go soft memory target; this is not a hard RSS or OS sandbox limit.
Preparation, hashing and final sealing are separately timed and are not covered
by a preemptive process deadline. No public RPC, network service, transaction
broadcast, target retry or replacement occurs. Timeout, malformed output,
integrity failure, fixture-check failure and unattempted slots remain explicit.

Only unrelated parser/runner controls and unrelated synthetic Geth smoke tests
may execute before review/freeze. Source, input, executable and runtime checks
run again before the terminal manifest is sealed. Dispatch requires the explicit
external frozen plan hash. The experiment adds an
independent opcode implementation check of a fixed official corpus. It does not
measure current product coverage or establish any population accuracy rate.
