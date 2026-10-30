# Storage-only creation diagnostic — fixed inputs

This is a synthetic client-semantics diagnostic, not a coverage score or a
canonical-rule decision. Preparation is authorized; freezing and target execution
require the parent's separate release. No public RPC, signing service, broadcast,
funding override, additional wallet, retry, or replacement case is used. The
synthetic signing key is the existing public test fixture key.

## Six cases, fixed order

1. Root CREATE into a storage-only account.
2. Internal CREATE2 into a storage-only account.
3. Root CREATE into an absent account.
4. Internal CREATE2 into an absent account.
5. Root CREATE into a prefunded account with empty storage.
6. Internal CREATE2 into a prefunded account with empty storage.

The storage-only target has nonce 0, empty code, balance 17 wei, slot 0 = 999,
and slot 991 = 123456. The empty-storage control has the same balance and no
storage. The absent control omits the account. Every creation has endowment 5.
The fixed constructor copies slot 991 to slot 1 and writes slot 2 = 42; its
deployed runtime can return slots 1, 2, and 991. That runtime is not separately
executed by this diagnostic. Full final allocation roots and slots 0/1/2/991
distinguish retained old storage from a cleared namespace.

`cases.mjs` imports the released input-only fixture and constructs all six
declarations before any execution. Each declaration retains the original full
allocation/root, exact amended allocation/root, header, request, signed type-2
bytes/hash and Geth transaction body. Four nonce-1, zero-balance STOP accounts
for withdrawal/consolidation/builder-deposit/builder-exit queues are added
identically to every execution path because pinned Geth's Amsterdam post-block
processing requires them. All original account rows remain byte-equivalent.
Geth alone performs post-block processing; final scaffold rows must remain equal
to input. This is disclosed scaffolding, not a claim about deployed chain state.

All paths use chain 11155111 / Amsterdam, the same block number/timestamp,
coinbase, gas limit, base fee, randomness, slot number, current excess blob gas,
and beacon root. The signed type-2 envelope matches the product's original
from/to/data/value/gas/max-fee/priority-fee fields. It has no authorization list
or blobs. Exact signatures and initial MPT roots are checked during preparation.

## Observations and order

Run exactly six isolated product calls, then six signed EthereumJS full-VM
transactions, then six pinned Geth t8n transactions. Each uses a separate
sequential subprocess. Product raw results and seals are durably written before
either comparison client executes. Every declaration is recomputed from frozen
input sources in each Node worker, with no prior output consumed. The Geth
dispatch binds the already sealed product and EthereumJS records without using
them to construct Geth input.

The product is expected to withhold disputed storage-only creation with
`LOCAL_CREATION_STORAGE_UNSUPPORTED`, status unsupported and whole-attempt
rollback. The actual returned status is retained even if different. Withheld
product observations stay null in all pairwise execution comparisons. A
separately labelled rollback root/target may be reconstructed from its validated
empty changes; that is not an execution prediction. Process completion is not
EVM completion.

The source hypotheses are EthereumJS collision, Geth deployment preserving old
storage, and EELS deployment clearing old storage. `SOURCES.md` separates
observed source from inference. EELS is not installed or executed. Its pinned
interpreter was read through the web tool; the state-tracker predicate is from
unpinned master and cannot establish the pinned commit's predicate. Raw-source
download failures are retained in `source-notes.json`; no downloaded EELS source
bytes were obtained. Any files subsequently present under `sources/` must be
included in the frozen inventory before execution.

EthereumJS is a shared-library comparison, not independent-client evidence.
Geth is the independent pinned tool. This packet does not select a winner.
Pairwise fields are booleans or null, never a generic pass count. EVM failures
remain observed failures; malformed, unsupported or missing channels remain
null. Geth exposes receipt gas and single-transaction block gas, not separate
regular/state dimensions; those missing dimensions remain null. No gas equality
is inferred from root equality.

The full signed EthereumJS result fields retained are return bytes, error,
execution gas/refund/logs, receipt, total gas, regular/state gas, pre-refund scalar
and amount spent; cyclic internal VM objects are not serialized. Raw subprocess
stdout/stderr are saved as base64 with byte counts and hashes. Its full final
allocation is reconstructed over this fixed program's address/slot universe and
must reproduce the actual VM trie root. Product roots instead apply actual
validated product deltas to the original complete allocation using a separate
MPT construction. Geth final allocations are independently rehashed; receipt,
signed body, transaction identity, logs hash and root call trace are joined.

## Bounds and failures

The declaration is six cases, six product wrapper processes (up to six isolated
children), six EthereumJS processes, and six Geth processes. No retry or added
case. Overall dispatch/terminal validity is 240 seconds using wall and monotonic
clocks; reversal or overrun invalidates usability. Each outer process has a
15-second maximum and SIGKILL timeout, with combined stdout/stderr limited to
2 MiB. Product isolation uses 10 seconds total, 8 seconds for input/execution,
and 1 second each for request, drain and kill confirmation. Any unconfirmed
product child closure/drain invalidates the packet.

Each Geth output file is at most 4 MiB, at most eight files per process, and
aggregate raw streams plus Geth files are at most 48 MiB. A bound excess stops
remaining work, retains all fixed rows and records observed unhashable output
metadata without claiming complete integrity. Outputs are inspected for kind,
size and count before reading. The expected successful Geth set is allocation,
result, body and one transaction trace. Other/absent outputs remain unavailable.
Strict UTF-8 is required for parsed JSON. A zero process exit is not a valid
observation by itself. Save errors are fatal; later saved-byte mutation is
detected against the original write ledger before another dispatch and final
usability. `STARTED.json` is exclusive and fsynced; no existing capture is reused.

## Source binding and review

Archive current product and harness sources, fixture dependencies, manifests,
Node identity and pinned Geth interpretation sources including `statedb.go`
and `state_object.go`. All local top-level JavaScript modules are included,
including `creation-support.js` and `amsterdam-authorization-validation.js`.
The exact 3,841 previously sealed dependency files are referenced through
declared relative links, rehashed before/after execution, rather than duplicated.
This archive therefore requires that committed dependency capture alongside it.
The Geth binary is pinned externally by SHA-256; no toolchain is rebuilt.

The input-only controls may construct proofs, hashes, MPTs, signatures and
fabricated parser inputs. They must not call the product, runTx, Geth, freeze,
or the driver. After parent review, a separate freeze records exact plan/source
pins. Only the frozen driver may dispatch. A compact `summary.json` accompanies
the complete raw records for human inspection; unavailable fields are explicit.
