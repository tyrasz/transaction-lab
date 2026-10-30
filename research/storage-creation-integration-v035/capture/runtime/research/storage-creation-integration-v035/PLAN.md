# Candidate storage-creation integration comparison

Execute the six unchanged, already-public v033 Amsterdam declarations once each
through the newly integrated isolated product worker. Root and internal CREATE2
each have a storage-only target, an absent control, and a prefunded empty-storage
control. This is a known development corpus, not an accuracy sample or holdout.

Freeze exact product source, both complete dependency trees, initial fixture
helpers, driver, worker, reconstruction helper, input bytes, and Node identity
before dispatch. Only the local product runtime has the explicit combined
delegation/nonce-code collision patch. The fixture dependency remains stock.
The fixture helpers construct initial MPT proofs and headers and do not execute
the comparison VM. The worker reads no reference output or expected poststate.

Each process has a 20-second bound and 8 MiB output bound. All six attempts share
a 150-second and 48 MiB bound. No retry or case replacement is allowed within a
capture. Retain failed and unattempted rows, exact stdout/stderr, process status,
timing, arguments and hashes. A timeout, output overflow, source drift or failure
to close the actual execution child makes that observation unavailable.

After product output is sealed, reconstruct complete allocations from immutable
initial state and validated product changes. Explicit creation storage resets
must match the full initial storage trie and declared target, preserve balance,
and use zero-before slots. This narrow reconstruction rejects deletion or any
other reset basis, since these six inputs contain no SELFDESTRUCT. Recompute the
full poststate MPT root; never use the sparse manager's storage root as poststate.

Compare saved official EELS observations without rerunning EELS, Geth or stock
EthereumJS. Revalidate the earlier saved packet using its pinned comparator and
manifests, including state/receipt/log reconstruction. Compare execution status,
return data, charged gas, single-transaction block gas, full state root, target
account/storage and logs. Unavailable fields remain null. Preserve the earlier
client disagreements and original root-wrapper failures.

Limits: the product executes an unsigned equivalent of the signed EELS envelope;
there is no public RPC, actual chain state, wallet action or broadcast here. The
reconstruction reuses MPT/RLP/hash primitives and initial fixture builders. This
is independent execution comparison with EELS, not independent parsing of every
proof, consensus validation, all-fork certification or population accuracy.
