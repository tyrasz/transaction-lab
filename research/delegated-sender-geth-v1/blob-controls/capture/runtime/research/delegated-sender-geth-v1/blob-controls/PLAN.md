# Fixed blob-fee development controls — reviewed and pinned before execution

This is the approved twelve-case extension of the existing delegated-sender Geth comparison family. No target has been executed or frozen. The reviewed product baseline is pinned to commit `6e0d61d2c34b70400e56494c578af03f80572d1b`, following the complete 657-control application validation. Both independent harness review and the twelve preparation controls passed before this pin; neither is target execution. Freeze and dispatch still require explicit parent authorization. Preparation tests build initial MPTs and signed bodies, exercise synthetic parser/seal controls and unrelated Node subprocesses only. They never run these product, full-VM or Geth targets. No public RPC, real keys, broadcast, retry, case replacement or population-accuracy claim is permitted.

The artifact, process, phase-clock and source-copy protocol is adapted from the reviewed fee-controls files at commit `948a489f88ac3344473f541426fd208be64ba2f2`. Those files were read from that commit, not imported from an uncommitted sibling checkout. The existing Geth adjudicator is reused from `../run.mjs` and included in the eventual source archive. Every file needed by this new harness lives in the selected repository or its declared installed dependency closures.

## Fixed declarations and order

Unless overridden below, the synthetic sender has nonce 1 and balance 1,000,000,000,000 wei; the destination has nonce 1; coinbase has nonce 1, balance 1 and no code/storage; base fee is 7; execution caps are 13/3; blob cap is 100; transaction value is zero. Versioned hashes are distinct ordered 32-byte values `0x01 || uint248(i+1)`.

| ID | Name | Fixed distinguishing inputs |
| --- | --- | --- |
| 001 | cancun_maximum_blob_count | 6 blobs; excess 6,676,954; gas 300,000; header blob usage 6 blobs |
| 002 | prague_maximum_blob_count | 9 blobs; excess 10,015,432; gas 300,000; header blob usage 9 blobs |
| 003 | osaka_maximum_blob_count | 6 blobs; excess 10,015,432; gas 300,000; header blob usage 9 blobs |
| 004 | bpo1_maximum_blob_count | 6 blobs; excess 16,692,386; gas 300,000; header blob usage 15 blobs |
| 005 | bpo2_maximum_blob_count | 6 blobs; excess 23,369,342; gas 300,000; header blob usage 21 blobs |
| 006 | type2_blobbasefee_no_clamp | Osaka type 2, no hashes; excess 0; base fee 1,600; caps 2,000/3; gas 300,000 |
| 007 | blob_message_revert | Osaka, 2 blobs; excess 10,015,432; storage write and LOG0 before REVERT; value 19; gas 100,000 |
| 008 | blob_message_out_of_gas | Osaka, 2 blobs; excess 10,015,432; storage write then infinite loop; value 19; gas 50,000 |
| 009 | blob_execution_refund_cap | Osaka, 2 blobs; excess 10,015,432; clear slots 0/1/2 initially equal to 7; gas 200,000 |
| 010 | blob_calldata_floor_after_refund | Case 009 context plus 2,000 nonzero calldata bytes; gas 200,000 |
| 011 | blob_sender_equals_coinbase | BPO2, 2 blobs; excess 23,369,342; sender is coinbase; opcode observations; gas 300,000 |
| 012 | blob_exact_max_cap_affordability | Osaka, 2 blobs; excess 10,015,432; STOP destination; gas 21,000; value 5; sender balance 26,487,405 |

Cases 001–006 and 011 store BLOBBASEFEE, first/last/out-of-range BLOBHASH, GASPRICE, BASEFEE and post-prepayment sender balance in slots 0–6. They also emit one LOG1 with topic `0xb1` and 64 bytes containing blob base fee and hash zero. In type 2 all BLOBHASH observations are zero. The exact bytecode is generated deterministically by `observationCode(count)`; all declarations, bytecode, allocation, synthetic header, request and signed bytes will be frozen before target execution. Case 007's log and storage write must roll back. Cases 009/010 use exact code `0x60006000556000600155600060025500`. Case 012's balance is exactly `21000*13 + 2*131072*100 + 5`.

All twelve are valid-envelope execution cases; local admission-rejection controls remain separate. This selection deliberately avoids empty accounts with nonempty storage, including the unresolved Geth state-test commit-path limitation seen in earlier fee evidence. It does not filter any result after execution. Coinbase aliasing in case 011 is intentional and starts with the funded sender's nonce and balance.

## Input and reference boundary

The shared `blob-fee-fixture.js` constructs authenticated product proof/code inputs solely from the immutable synthetic prestate. `signBlobFeeTransaction` signs the exact type-3 body using the validating transaction class without installing a fake KZG implementation. Case 006 uses signed type 2. No sidecars are supplied or validated.

`decodeSignedInput` separately decodes the complete typed RLP body, checks every unsigned field against the declaration (chain ID, nonce, execution caps, gas, destination, value, calldata, ordered access list, blob cap and ordered hashes), checks canonical round-trip encoding and signature, and recovers the declared sender. Geth JSON transaction fields are then derived from that verified signed body. Geth checks the supplied signed bytes' decodability/recovery but executes its JSON-derived message; the harness therefore binds both representations itself rather than treating signature recovery as a field-equality check.

The pinned Geth input format uses `maxFeePerBlobGas` and `blobVersionedHashes` on `transaction`, and `currentExcessBlobGas` on `env`. It accepts named forks `Cancun`, `Prague`, `Osaka`, `BPO1`, and `BPO2`. Explicit base fee, current excess, random, timestamp, number, coinbase and gas limit are passed. For type 2 both blob transaction fields are omitted. Each case has one data/gas/value choice and poststate index 0. Prestate storage keys and values are canonical 32-byte words with exact integer preservation.

Pinned-source interpretation: `tests/state_test_util.go` defines the JSON fields at lines 88–128, derives current blob fee and runs the message in `RunNoVerify`, then commits state and checks root/log hash. `tests/init.go` supplies the five fork configurations. `core/state_transition.go` enforces the Osaka six-blob transaction limit; state tests also check the selected fork's block maximum. These source files belong to Geth commit `1df30b18d9ed35ee9d28ffd4648442c2204554ad` and their relevant bytes must be covered by the retained toolchain/source provenance.

Selected headers retain their exact `blobGasUsed`, including the full-capacity headers in cases 001–005. Geth's state-test format does not exercise block-body capacity or validate a complete selected header, so this retention does not establish either. Current blob price is derived from the current excess and selected fork; no parent excess transition is asserted. Case 006 distinguishes this from an incorrect direct base-fee/16 clamp. No BLOCKHASH, system calls, authorization list or root creation is declared in this slice.

## Reviewed execution and evidence protocol

Freeze will copy and read back all current local/fixture runtime files, complete installed dependency trees, package metadata, required fixtures, harness, baseline header evidence and actual Node identity. All non-dependency product/helper sources must be tracked and equal product release commit `6e0d61d2c34b70400e56494c578af03f80572d1b`. The repository commit is recorded separately. The exact Geth binary remains external but hash-bound, with toolchain, source and dependency inventories archived. Geth binary SHA-256 is `10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521`.

Each archived isolated product runs first and its raw result is fsynced and durably hash-sealed. A separate signed full-state VM then executes from the same initial allocation/header/request, without product or expected-output input. Only after the reference completes does a third fresh MPT receive the product's validated deltas. Every artifact is retained in a hash ledger, checked before the expectation seal and at terminal success. Full-VM disagreements and exceptions remain visible and never replace product-derived expectations. An unavailable product or unapplied root yields no invented expectation. All twelve denominator slots remain present.

All available product-root/log expectations are sealed before any Geth invocation. Geth independently compares the full product-applied state root and its internal assertion of the product log hash. It does not establish separate gas, return, receipt, sidecar, inclusion or whole-block correctness. Nonzero fee balances make settlement state-root-sensitive; that is not a separate gas oracle. The signed full-VM diagnostic additionally compares gas, return, execution status and logs, while explicitly sharing EthereumJS's opcode library with the product.

Bounds remain the reviewed protocol's conservative ceilings: 12 cases; 20 seconds/16 MiB output per product or reference worker; 360 seconds for preparation; 5 seconds/1 MiB output per Geth invocation; 120 seconds for the Geth phase. Both phases include integrity checks and use wall/monotonic clocks with latched reversal detection. Deadline, malformed/partial process output, signal, nonzero exit, save error or source drift cannot become a successful comparison. Terminal timing or integrity failure sets `comparisonsUsable:false` for the packet while preserving observed rows. No output file is overwritten and no case is retried.

Absolute source/capture directories are retained as execution provenance. Later audits must resolve artifacts in their current location while comparing recorded arguments against the original declaration, without rewriting sealed bytes. The exact Node and external Geth identities remain replay requirements.

Preparation only: `node --test research/delegated-sender-geth-v1/blob-controls/run.test.mjs`. After explicit dispatch authorization, freeze/check/run use the same reviewed command protocol as fee-controls, with the exact externally supplied plan SHA required for dispatch. This document authorizes neither freeze nor target execution.
