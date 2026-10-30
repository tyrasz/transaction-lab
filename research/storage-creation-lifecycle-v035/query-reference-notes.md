# Lifecycle EELS query adapter

Status: implemented and source reviewed. No preparation or declared target
execution was performed while writing this adapter. Runtime preparation remains
required before a source freeze and any separately authorized target dispatch.

`eels-worker.py` owns only the new wrapper and query adapter. It loads the
unchanged `../storage-creation-forks-v035/eels-worker.py` by its exact relative
path; the source freeze must contain that dependency. The original's top-level
report fields and its signed `apply_body` execution remain unchanged. Added
fields are `queryReferenceScope` and `queryReferences`. Preparation additionally
retains `queryTemplates` and the before-query signature checks in
`queryPreparation`. Preparation calls the original in prepare-only mode and
returns before the original execution or any query `apply_body` call.

## Query context and signatures

The source header and its hash retain base fee 7. Each contract query uses a
separate synthetic execution environment whose only environment change is base
fee 0; the signed type-2 counterpart has zero fee caps, zero value, no access
list, gas 1,000,000, and its nonce is read from that half's EELS allocation.
This matches the actual unpriced execution profile of `ethereum-call.js`.
It is not a canonical block, and no replacement header hash is made.

Signing uses only the repository's existing public development key (32 bytes
of `0x01`). Pinned `spec256k1` 0.2.3 documents
`PrivateKey.sign_recoverable(message_digest)` and its 65-byte `r || s || v`
format in the installed package metadata and type stubs. Each signed query is
round-trip decoded and its sender recovered with the selected official EELS
fork's transaction functions. The signing package must resolve inside the
pinned toolchain venv. The outer toolchain inventory binds the package and
native extension; no dependency installation is needed.

Stock `apply_body` retains its system calls and zero-valued fee-credit touches.
Every contract-query snapshot must still contain the four unchanged inert STOP
system accounts and a coinbase with nonzero nonce or code. These constraints
are checked without altering allocations. The adapter does not suppress,
repair, or reinterpret any stock finalizer. This bounded profile does not claim
general equivalence for queries with other system-account or coinbase states.

Every before half reconstructs a fresh state from the declared full initial
allocation. Every after half reconstructs a fresh state from the original
EELS execution's full settled allocation. Native queries read those same
snapshots. The adapter never receives product outputs, and queries never feed
changes into other queries. Both phases are executed even when the product
withholds or skips a corresponding measurement.

## Retained schema

Each `queryReferences` entry is `{index, kind, template, before, after}` in
declaration order. A native phase is
`{status:'observed', account, balance, inputStateRoot}`.

A contract phase retains:

- `status:'observed'`, exact `request`, signed bytes/hash/envelope,
  `senderNonceBefore`, intrinsic gas and optional calldata floor;
- `inputStateRoot`, full `initialAllocation`, full `allocation`, `stateRoot`,
  and `storageClears`;
- source header hash, source environment, synthetic execution environment and
  official entrypoint name;
- `executionStatus`, return bytes (or null if no official terminal event),
  `chargedGas`, `singleTransactionBlockGasUsed`, historical/Amsterdam block gas
  dimensions, logs, receipt bytes, receipt fields, bloom, receipt root,
  transaction root and log hash;
- exact official `transactionEnd`, availability and gas-meaning labels,
  requests, `neutralExceptSenderNonce`, `targetSelfdestructObserved`, and
  bounded `lifecycle` trace evidence.

Neutrality compares the entire allocation and requires no committed logs; only
the sender nonce may increase by exactly one. The observer separately requires
execution success and a valid returned scalar to accept a measurement.
Historical single-transaction block gas is charged receipt gas. Amsterdam
retains execution and state dimensions and uses their maximum for the block
contribution. `TransactionEnd.gasUsed` is not substituted for charged gas.

Malformed setup, execution or projection fails the process; there is no retry
or fabricated successful reference. The outer driver retains raw failure and
unavailable positions. The existing observation projection must preserve a
null return-data channel if no terminal event is emitted.

## Lifecycle trace evidence

Only official trace events for the signed query hash are collected. Bounds are
200,000 events, 128 frames, and 64 SELFDESTRUCT starts per half. Each frame keeps
its execution address, code address, parent, depth, terminal status and final
error. Live EVM objects are held until projection, preventing Python identity
reuse and allowing a code-deposit error after `EvmStop` to be observed.

Every SELFDESTRUCT row retains frame, depth, address, beneficiary read from the
actual stack, program counter, completed opcode, opcode error, frame error and
an ancestor-aware committed flag. Successful execution within a later-reverted
ancestor is retained as executed but uncommitted. This flag describes retention
of the instruction's effects; it does not imply account deletion under every
fork. `targetSelfdestructObserved` requires an actually completed, error-free
self-beneficiary instruction at the declared T, independently of output value.
The raw frames/rows remain available for stricter saved-output validation.

Original and query states are checked by full MPT reconstruction. Query receipts
are decoded from the official trie, bound to block totals, checked against the
official log bloom, and retained alongside all receipt/transaction roots for
independent saved-artifact validation. Output is capped at 2 MiB; allocation,
storage, code, log and return-data bounds match the existing adapter.
