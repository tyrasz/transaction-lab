# Proposed eight-case lifecycle composition diagnostic

Status: input declarations and harness are being prepared; no target has run.
Execution requires completed source review and successful preparation matching
the frozen source. Existing packets remain untouched. This extends the six successful Amsterdam storage-creation
comparisons and the subsequent eight historical/rollback cases (56 matching
channels, checkpoint `5bf18507`); it is a separate synthetic development matrix,
not an additional public sample or a general accuracy estimate.

## Fixed cases

All originals are priced internal CREATE2 calls into an authenticated storage-only
target T. The first four constructors read hidden slot 991, emit the read word in
a committed log, write 999 to slot 0 and 42 to slot 2, then SELFDESTRUCT. Thus
final deletion cannot hide whether initcode saw the cleared namespace. The last
four constructors make the same storage writes and install the specified runtime.
The exact bytecode, addresses and signed inputs must be declared before execution.

| ID | Fork | Original and fixed query purpose |
| --- | --- | --- |
| 001 | Shanghai | Constructor SELFDESTRUCT to self; block fee recipient is T. Observe self-balance treatment and final deletion after fee credit. |
| 002 | Osaka | Same declared behavior as 001. Exercise the same-invocation EIP-6780 deletion branch and fee-credit ordering. |
| 003 | Amsterdam | Same behavior as 001. Observe EIP-8246 clearing of nonce/code/storage while preserving the settled balance. |
| 004 | Amsterdam | Constructor SELFDESTRUCT to initially absent B; factory subsequently sends 3 wei to T; fee recipient is T. Observe native transfer logs, beneficiary creation, subsequent funding and final clearing after fees. |
| 005 | Shanghai | Install self-beneficiary SELFDESTRUCT runtime. A disposable getter calls T, ignores its empty return and returns constant 42. Observe the historical retained deletion and measurement withholding. |
| 006 | Osaka | Same getter as 005. T was created by the original transaction, but is preexisting in the fresh query invocation; observe the EIP-6780 nondeletion branch. |
| 007 | Amsterdam | Same getter as 005. Observe fresh invocation markers and self-beneficiary behavior without a new creation/final clearing. |
| 008 | Amsterdam | Install a scalar storage getter at T. Two disposable getters call the same helper H to create the same second storage-only target Q whose constructor SELFDESTRUCTs to self. A fixed calldata mode selects either helper REVERT carrying word 42 or RETURN retaining its changes. Outer getters catch/copy return data. Compare neutral rollback versus retained mutation, then read native Q and T to check query isolation. |

Cases 001–004 request native balances for sender, factory, T and B where relevant.
Cases 005–007 request the scalar getter first, followed by native T and sender.
Case 008 requests the reverting getter, retaining getter, native Q, native T and
native sender, in that order. No case exceeds eight query descriptors. Duplicate
account aliases are folded in the declaration, not counted as separate assets.
Before/after getter halves remain separate observations, including unavailable
ones. This is eight original cases and ten contract-query halves, not eighteen
independent transaction samples.

Shanghai and Osaka are the selected historical finalization boundaries; this
matrix does not claim a separate Cancun or Prague execution observation. Source
semantics guide these choices; no numeric gas, root, balance or log prediction
is supplied to either execution worker.

## Identical initial state and execution profile

- Synthetic sender key is the existing public development key, nonce 1, funded
  sufficiently for maximum fees. Factory nonce 7, balance 1,000 wei. T has nonce
  0, empty code, balance 17 and slots `0=999,991=123456`; creation endowment is 5.
  Q in case 008 has the same storage-only initial account. Other helper code,
  balances and nonces are explicit full-allocation rows; B in 004 is proven absent.
- All originals use gas 5,000,000, base fee 7, fee caps 13/3, zero outer value,
  no access list, authorization list or blobs. Historical chain ID is 1;
  Amsterdam uses trusted Sepolia ID 11155111. Header number/timestamp must select
  the declared fork using the existing pinned fixture schedule.
- Copy the prior four inert nonce-one STOP system accounts identically into
  both allocations; retain original and scaffolded roots. Empty withdrawals and
  matching system-processing context are explicit. Do not suppress stock EELS
  finalization or patch its source.
- Retain complete initial allocations, storage roots, full headers, sender,
  signed type-2 bytes/hash/envelope, unsigned product request, all query templates
  and their ordering. Derive CREATE2 addresses from frozen creator/salt/initcode.
  Verify both allocation roots and signatures before any target execution.

Use the actual isolated preview once per original. Its proof broker supplies
only independently constructed initial account/storage proofs and code. Preserve
every requested proof/code reply, child output and parent validation result.
No provider trace, reference poststate, expected query value or expected delta
may populate inputs. Unsupported product execution remains a null prediction.

Use stock pinned EELS `apply_body` for the signed original. Native references
come directly from its complete initial/final allocations. For contract queries,
each before/after half gets a fresh state built respectively from EELS's own
initial/settled original allocation, never the product output or a previous
query's writes. Use separate zero-fee signed type-2 query counterparts with
1,000,000 gas, zero value/base fee/caps, no inherited blobs/access/auth list, and
the sender nonce read from that reference snapshot. The source header still
records base fee 7; the synthetic execution environment has base fee and gas
price zero. This matches the actual unpriced query profile in
`ethereum-call.js`, rather than claiming unchanged opcode BASEFEE. Preserve the
original fork, number, timestamp and all other execution environment fields.
Do not rehash this synthetic context as a canonical source header. This is not
a canonical block or an additional original transaction. Any wrapper discrepancy
stays explicit rather than being corrected using the product result.

## Observability and comparison

Compare each original's status, available return bytes, charged gas,
single-transaction block gas, complete allocation/MPT root, exact ordered logs
and complete affected-account state. Reconstruct product allocation independently
from initial full state plus validated deltas, including authenticated clearing,
whole deletion and preserved balances. Bind old storage roots, actual committed
creation/destruction, native fee/transfer arithmetic and finalizer ordering;
do not treat a missing row as a reset. Independently check EELS allocation,
transaction/receipt roots, receipt gas, logs and bloom. Use Amsterdam's maximum
of execution/state gas dimensions; historical single-transaction block gas is
charged receipt gas. TransactionEnd gas is not interchangeable with receipt gas.

For query halves retain return/status/logs, full reference before/after roots,
native values and original snapshots. Derive neutral-versus-mutating classification
from actual reference changes, allowing only the query sender's outer nonce
increment and no committed logs. A correctly withheld mutating query can match
the admission decision while its value-comparison channel remains null. Neither
that refusal nor an empty log set is evidence of no economic effects. Later
native queries must still read the unchanged original snapshot. Product query
consistency checks and native arithmetic are not a second opcode implementation.

## Bounds and retention

At most eight product processes and eight EELS processes, one of each per fixed
case. Each EELS process runs one original plus only that case's declared query
halves (18 signed transitions total across eight processes). Each product process
runs one original preview with at most the same ten declared contract-query halves; native reads
do not execute the VM. A withheld before-query can leave its after-query
unattempted; retain that missing product observation. Product outputs must all be durably sealed before EELS
dispatch. No retries, replacement cases, adaptive widening, RPC or broadcast.

Proposed bounds: 20 seconds per process, 360 seconds total, 8 MiB combined raw
stdout/stderr per process and 80 MiB total; inner worker wall/drain/kill bounds
must fit inside the outer deadline. Preserve raw bytes and every one of the
sixteen process positions. Timeout, overflow, failed child closure, clock reversal,
source/input drift or original-write ledger failure stops subsequent dispatch
and withholds usable aggregate comparisons. Check wall and monotonic clocks,
all source/dependency/toolchain identities and exact prior artifact inventory
before/after attempts and at sealing. Keep unattempted, unavailable and mismatch
rows; missing channels stay null. No OS-wide isolation or consensus claim follows.

## Pinned source pitfalls checked without execution

EELS commit `e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e`, rooted at
`outputs/evm-toolchains/eels-e27f097ec7/source`. Paths below are relative to
`src/ethereum/forks/`; hashes were read for this plan, not fetched anew.

| Source and lines | SHA-256 | Binding/pitfall |
| --- | --- | --- |
| `shanghai/vm/instructions/system.py:507–559` | `fa82f0e1852a23e9f3418a2a49ce303a70f53dac4989834a7394d4e8401bcb42` | Transfer then zero originator, including self-beneficiary; register deletion. |
| `cancun/vm/instructions/system.py:508–558` | `301d8e7b599a2390c8f1a508e0243ee2ff3b8dc41065fffbc3756230292b4e5c` | Only same-transaction creations are deleted/zeroed; fresh query markers matter. |
| `shanghai/fork.py:588–607` | `d19fd2a07891316f2c16b57a346ac93d24b6beb9d31aaefc328344a6f276d60e` | Refund and beneficiary tip precede account destruction. |
| `osaka/fork.py:929–956` | `248a5feeed281cc6809c8f3ef7bd6fb98ea822c442f363a2c8b05630168c6a6f` | Refund/floor and fee credit precede destruction. |
| `amsterdam/vm/instructions/system.py:705–771` | `d6d4df0e26882b26da44c535d4a29d2e8ef61d76da407290be51d403a5356c4b` | Charge regular then state gas; nonself native transfer log; only created targets marked. |
| `amsterdam/fork.py:1051–1093` | `83583924d14331e54877204042e03c1b5898477ae41adec606c09a846229c793` | Settle/disburse fees and form receipt before balance-preserving clear. |
| `amsterdam/state_tracker.py:494–561,733–786` | `b8a6082a210bcfdfc51e1487589a0b3ddfdd3b36ceee9dab6783f6bfca1f6229` | Clear nonce/code/entire storage, preserve balance; storage-clears revert, created/original-storage marker survives message rollback but not a fresh transaction. |

Starting local controls: `engines/local-evm/test/creation-storage-clear-isolated.test.js`
(query isolation and finalizers), `amsterdam-clearing-fixture.js` (fee recipient
aliases), and `reset-preview-fixture.js` (helper REVERT plus outer return).
These are fixture/design sources, not independent expected outputs. This plan
does not import stock EthereumJS or the known storage-preserving Geth result as
an oracle, and does not modify the completed historical/rollback packet.
