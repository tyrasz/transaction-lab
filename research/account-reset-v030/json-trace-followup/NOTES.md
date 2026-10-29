# JSONL correction result

The separately frozen follow-up completed its sole authorized run: **15 matched, 0 mismatched, 0 unavailable, 0 unattempted**. All fifteen prefixes agreed on full state root, committed log hash, gas, execution status and exact root return data. Gas checks include both charged receipt/cumulative gas and raw root message gas. All five sequence declarations and all 33 signed transaction occurrences remain in the evidence.

The run took 4.308 seconds and retained 186,471 raw output bytes. Source and artifact integrity remained valid, with no fatal error or clock/bounds failure. The packet has 4,205 manifest entries totaling 30,399,771 bytes (excluding the manifest itself), including 4,025 archived source entries and the exact inherited products/expectations/inputs. No product or full-VM execution occurred in this follow-up, and no public RPC was used.

| Identity | SHA-256 |
| --- | --- |
| Plan | `d2a71df7063345a1d8fff2631eff95b09af53d2fb72ce58e6219be8f3cb00101` |
| Source manifest | `69270fe90db8480493c675ae6265124ef6f034ecd2088c13df2d964aa720a14a` |
| Evidence manifest | `d30cb0b469207d79262b52060cad882d850a3999c41b1203d300a7000115152a` |

Only the trace configuration changed, to the unchanged pinned Geth binary's JSONL logger with call frames and memory/input recording, and without stack dumps. Strict balanced entry/exit parsing identifies the final root exit, including nested failed constructors, helper reverts and SELFDESTRUCT event frames. Seven preparation-only test groups passed before freeze; an independent reviewer repeated them and cleared the parser, inherited evidence, process/output limits and source archive before dispatch.

The [first packet and its diagnosis](../NOTES.md) remain unchanged at **5 matched / 10 unavailable**. Its eighteen empty later native callTracer files are preserved. This separate correction does not erase or relabel those outcomes. It binds the first packet's exact manifest, plan and source identities in its frozen plan and copies the exact original inputs, product results and expectation seals. An independent artifact-only audit is maintained separately in `research/account-reset-v030-json-trace-review`.

This result is a fixed synthetic Shanghai comparison of account deletion, funding, repeated recreation, constructor rollback and a reverted disposable getter. It is evidence about those declared sequences in the retained-manager core, not a population accuracy rate or public sequence-API claim. Geth supplies independent execution; EthereumJS is shared in initial proofs, signatures and the third MPT used to apply product deltas. No target should be rerun to verify these saved results.
