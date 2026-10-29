# Account reset sequence result

The first frozen packet contains **5 matched, 0 mismatched, 10 unavailable, 0 unattempted** prefix comparisons. All five single-transaction prefixes matched every declared channel. All ten multi-transaction prefixes were retained as unavailable because later native callTracer files were empty. The original capture, classifications and denominator remain unchanged.

All fifteen actual product calls completed. The fifteen Geth prefix processes exited successfully and retained 33 included transaction receipts, with no rejected transactions. The five sequences were declared before execution; their repeated prefixes are not retries. The packet finished in 7.140 seconds with 427,706 raw output bytes, unchanged source/artifacts, no fatal error and complete hash coverage.

| Identity | SHA-256 |
| --- | --- |
| Frozen plan | `38dd6775fd91592ca3e152e27994c840b6eebaf8101ef53a12066f43f657a3f7` |
| Frozen source manifest | `f8ad4fa047b5db8117829b310889d39ab356700a68fd09e9bda82356caa0c787` |
| Sealed evidence manifest | `df41304fda31c7fe06112352efb79b0734dc00c4fd9c09c08072f6985746cdd1` |

The source archive contains 4,021 entries and identifies implementation commit `989e5488e2e076a249583a15e414e695c75574d0`. It binds exact runtime/helper/dependency bytes and Node identity. Geth is the previously pinned 1.17.10 build, commit `1df30b18d9ed35ee9d28ffd4648442c2204554ad`, binary SHA-256 `10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521`.

## Artifact-only diagnosis

The separate [diagnosis.json](diagnosis.json) lists every empty trace filename, process exit, and independently read channel result. `node research/account-reset-v030/diagnose.mjs` reproduces it without importing the producer comparator or executing a product, VM, client or RPC. Three focused offline test groups verify mismatch retention and reject unbound bodies/receipts.

The saved evidence agrees on **all 15 full state roots, committed log hashes, total and per-receipt gas/cumulative gas, and receipt status**. All declared committed log lists are empty. These narrower checks are a post-capture diagnostic, not replacement classifications or complete return-data comparisons. Eighteen later transaction trace files are empty across the ten multi-transaction prefixes. Each corresponding saved stderr contains `incorrect number of top-level calls`; all first-transaction trace files are present.

The pinned Geth source explains this failure:

- `capture/toolchain/source/cmd/evm/internal/t8ntool/transition.go:173–181` constructs one native tracer for the entire transition.
- `capture/toolchain/source/cmd/evm/internal/t8ntool/file_tracer.go:76–85` retains that tracer's hooks and GetResult. Lines 89–121 open each transaction's file, call GetResult, log its failure and close the file without writing a result when it returns nil.
- `diagnostic-source/eth/tracers/native/call.go:159–181` appends a root frame on every transaction. Its OnTxStart at lines 219–221 updates only the gas limit; it does not clear the previous call stack. GetResult at lines 262–265 requires exactly one root frame. Second and later transactions therefore encounter the observed error.
- `capture/toolchain/source/cmd/evm/internal/t8ntool/execution.go:256–310` separately applies transactions and retains receipts. Lines 349–365 check the state commit and expose the committed root, receipts, gas and log hash. The tracer warning does not imply transaction rejection or commit failure.

The two extra diagnostic source files and upstream licenses were copied only after matching their hashes and byte counts against the source inventory already bound by the first capture. [Their provenance](diagnostic-source/provenance.json) records that linkage. No toolchain source or binary was modified.

This evidence covers known synthetic Shanghai sequences in the retained-manager core. It does not claim a public API sequence endpoint, general EVM accuracy, production-chain representativeness or a new full-VM execution. The independent execution client is Geth; EthereumJS remains shared in proof/signature construction and the third MPT that applies product deltas.

## Proposed separate follow-up, not dispatched

A minimal correction can preserve the exact fifteen prefix inputs, signed bytes, original product seals and expected roots while changing only Geth's trace selection to its built-in JSON opcode logger (`--trace --trace.nostack`). `diagnostic-source/eth/tracers/logger/logger_json.go:164–177` writes an end record for each exit; within each transaction file the final exit is the root exit. That last record can supply exact return bytes and failure text without the native callTracer's accumulated root stack. The same process/file/aggregate deadlines and output caps would remain enforced. Any follow-up needs its own frozen source/plan, manifest binding to the first packet, all fifteen retained rows, and explicit review before its sole run. The original packet will remain intact.
