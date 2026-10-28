# Synthetic lifecycle differential — fixed16

This experiment uses the sixteen identities fixed before the separate official
signed run. It tests version0.18's sparse proof state and finalizer against full
VM transaction finalization, using the same pinned EthereumJS opcode library.
The generated transactions are synthetic counterparts, not official replays.

Every declaration retains the fixture preallocation, selected sender/key, nonce,
destination (including creation), calldata and value. Initial sender nonce must
equal the transaction nonce. Gas becomes `min(originalGas, 5,000,000)`; gas price
and base fee become zero. Both paths share a fully explicit synthetic header:
number22,000,000, timestamp1,764,798,551 (the pinned Osaka activation), original
coinbase/randomness/block gas limit, independently built initial MPT state root,
and explicit empty/default body commitments, zero blob gas/excess and synthetic
parent/beacon commitments. Every exact field and transformation is saved before
execution. These headers make no consensus or public-chain identity claim.

The product isolated child runs first. A private immutable full MPT constructed
only from the declaration preallocation answers authenticated proof/code reads.
All attempted reads/results/errors and the entire product attempt are saved and
fsynced, followed by an exclusive byte-hash seal. Only then may the full-VM child
run a newly signed zero-price transaction from its own fresh preallocation.
Official expected poststate and either execution's outputs never enter the
other execution or the proof source. Missing ancestry remains unavailable.

The comparator validates product request/header/profile and gas accounting,
applies validated product net changes to a third independently built full MPT,
then compares five channels: execution, return bytes, ordered logs, charged gas,
and complete state root. The state channel additionally compares full-VM observed
account/code/storage-root/slot rows. Whole-account deletion is explicit; missing
sparse slot rows do not imply complete storage enumeration. All mismatches and
unsupported/unavailable/unattempted cases remain in the16-case denominator.

Limits: six-minute dispatch budget including preparation; ten seconds per product
attempt, ten seconds per reference child;256 proof/code calls,8MiB per parsed
response,32MiB total responses per product;16MiB child output;256MiB product and
512MiB reference V8 old-space. Host bounded setup, integrity hashing and sealing
are not a preemptive total-process deadline. Child deadlines are enforced by
process termination. This is process separation, not an OS network/filesystem
sandbox or a hard total-RSS cap. There are no public requests or replacements.

Only unrelated synthetic controls run before review and freeze. Frozen sources
include the complete installed local and fixture engine scopes, exact helper
code, input files, declarations and actual Node identity. Tracked product source
must match dcc0554. Runtime execution imports the archive, and source/input checks
run again before sealing. A failed partial freeze is retained, never repaired.
