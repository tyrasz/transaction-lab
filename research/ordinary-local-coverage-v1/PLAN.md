# Current local Ethereum engine prospective coverage pilot

This is a new, engine-only evaluation. The evaluated product is the frozen
current `executeIsolatedEthereumCall` kernel, including its real child process,
parent protocol checks and proof-backed state. It is not the old provider API,
not HTTP/UI availability, and not asset-inventory coverage. Prior 0.13.1
12/16 comparison results and all inspected development cases remain unchanged.

Freeze the complete runtime, Node identity, selection/projection/comparison,
providers, seed and policy before any public selection. Observe only latest H,
durably declare H+1/H+2, wait at least20minutes in chunks at most60seconds, then
observe each fixed provider's finalized tag once. Retain both full target
bodies, their header ancestry (at most256 per provider), every census row and
the first min(16,N) seed/hash-ranked slots. No outcomes enter ranking. Provider
body/finality agreement is not a consensus or transaction-trie proof.

The absolute and monotonic run window is60minutes. An observed wait chunk more
than60seconds late stops selection; the recorded failure and fixed targets are
retained. A bounded `/usr/bin/caffeinate -i` wrapper may inhibit idle sleep, but
does not excuse manual suspension or extend deadlines. No restart, retries,
replacement slots, substituted wallets/blocks, provider fallback or saved-proof
fallback. Terminal cancellation/drain has25seconds; incomplete drainage cannot
produce valid metrics. Drainage includes actual fetch, body-read and
cancellation promises. A returned timeout alone is not drained I/O. Check
absolute and monotonic elapsed time after each phase and at termination; retain
late output while withholding run metrics. Offline hashing and sealing are
timed separately.

Every selected row is reprojected from its preserved envelope under the frozen
current local profile, including supported top-level CREATE and optional
access-list/blob context, existing delegated senders, and Prague-or-later
type-4 authorization lists of at most16 tuples. Authorization quantities are
converted from census representation to canonical RPC hex without changing
order, duplicates, signatures, or protocol-skipped tuples. The exact list is
passed to both engines. Creation/blob combinations with authorizations and
unknown context or resource limits remain explicit. The census's older provider projection is
retained for provenance and never silently changed. Unsupported rows remain in
S. Execution uses the parent's block-end state, fixed5M gas and zero gas price,
BASEFEE and declared BLOBBASEFEE; it is not mined-position replay, signature
validation, fee settlement, sidecar verification or a complete economic effect
prediction.

For each supported selected request, run the actual local product first using
only authenticated initial proof/code and demanded authenticated ancestors.
Durably save `local.json` and `LOCAL_SEALED.json` (exact local file hash/size and
last input wire ID) before any provider execution request. Then request the
fixed raw oracle sequence: full hash-selected header, callTracer with logs,
prestateTracer diff, full numeric-selected final header. Each planned read is
attempted once under remaining budgets even if an earlier ordinary RPC fails.
Provider errors, incomplete trace/diff and unsupported CREATE transport remain
oracle-unavailable. Explicit base-fee overrides request the same profile;
there is no bytecode context witness, so providerContextExecutionAttested is
false. No provider trace/poststate may initialize the local engine.

Bind every accepted file to its original write hash and size; verify the local
result and its seal again immediately before oracle dispatch. A final durable
write ledger includes all frozen plan files and run evidence before the ledger
itself. Exact inventory and original identities must still match before final
sealing. Account proofs can establish empty code without a separate code RPC;
the auditor independently rechecks that derivation and its evidence reference.

Limits retain6144 public calls/512MiB total,8MiB per body,25seconds per request,
256 local reads/32MiB per case,65 oracle reads/32MiB per case and384 per slot.
The fixed oracle currently uses four requests; global bounds may stop later
slots. An unattempted selected slot remains in the16-slot ledger. Record exact
successful and failed wire bodies, source checks, each phase and all outcomes.

Compare execution exception class, exact return bytes, ordered committed logs,
full observed net account changes, and unsigned-profile gas. This is separate
provider-engine agreement, not a post-state-root or consensus proof. Missing
lifecycle support/evidence makes that channel unavailable and never converts
an unknown into a match. Preserve measured mismatches even when another channel
is unavailable. Local completion defines execution availability; oracle failure
cannot turn a valid local execution into a local failure.

Authorization intrinsic cost and ordered processing refunds are independently
folded from signed tuples and proven initial accounts. Curve recovery and the
parent's defensive output validator are shared primitives, not independent EVM
engines. Sparse provider diffs cannot establish a whole storage-namespace clear;
such a state channel remains unavailable unless complete evidence supports it.

Report N and S, local completed/S (success/revert/fault separately), five-channel
matches/S, matches/comparable, all unsupported/resource/provider failures, and
latency/bytes for every attempted outcome. Two correlated blocks give descriptive
counts only, not a broad accuracy rate. The offline verifier rehashes the entire
archive/evidence, recomputes selection/projection/classification/accounting,
reverifies proofs and joins wires to broker/oracle evidence. It is not a new VM
reexecution; interrupted packets missing durable phase evidence may correctly
fail verification. No live dispatch is authorized by creating these sources.
