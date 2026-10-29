# Frozen authorization comparison results

The sole predeclared run completed: **5 matched, 0 mismatched, 1 unavailable, 0 not attempted**. `comparisonsUsable`, `sourceUnchanged`, and `artifactsUnchanged` are true; fatal is null. All six product workers ran once and sealed their observations before the six pinned Geth processes. No retries or target reruns occurred.

| Fixed case | Classification | Receipt gas | Geth block gas | Comparison detail |
| --- | --- | ---: | ---: | --- |
| existing_empty_install | matched | 250606 | 218790 | All nine channels agree |
| self_authorization_callback_create2_collision | matched | 3017554 | 2797234 | All nine agree, including the committed 5-wei native transfer log |
| late_authorization_oog | unavailable | 88448 | 88448 | Seven channels agree; return data and message gas unavailable |
| recipient_preparation_oog | matched | 70005 | 70005 | All nine declared channels agree; preparation halt semantics retained |
| entered_revert_retains_authorization | matched | 82118 | 46928 | All nine agree; message REVERT with retained authorization |
| duplicate_clear_reinstall | matched | 93472 | 58282 | All nine agree; returns word7 |

There are52 true channel values, zero false and two null. This is not six all-channel matches. In case3 the product never enters a message: trace is null, frames/steps/message gas are zero, failed tuple index1 and the remaining tuple is not attempted. Both preparation writes roll back; sender nonce and fees remain. Geth emits a synthetic halt frame with5810 gas and no opcodes. The predeclared comparator keeps `returnData` and `messageGas` null with `no_entered_product_message`; its seven comparable state/log/status/receipt-gas/block-gas/log/bloom channels agree. Case4 retains the product's actual preparation root frame with2999 message gas; Geth's synthetic halt is compared only for the declared output/gas channels, not internal path equivalence.

The existing-empty authority case agrees with Geth at250606 total gas, including218790 state gas. This supports the product's EIP-161-empty treatment for this exact selected input. The previously documented pinned EthereumJS full-VM existence-only discrepancy is not used as an expected-output oracle, and that full VM was not executed in this packet.

All six parent-validated attempts report completed supervision, confirmed child process closure, zero pending broker operations and no projection error. Execution outcomes remain separately recorded: successes, REVERT and out-of-gas are not conflated. Thirty synthetic proof/code request/reply records are retained; these are parsed local fixture replies, not network wire capture. Every child exited0 without a termination request. Twelve outer processes exited0; each stayed within15s. The whole run took5044ms wall /5044.416ms monotonic, with239676 accounted output bytes and complete artifact hash coverage.

Exact external pins:

- Plan SHA256 `1315e6a308ab0a1baf78e7b49b89b2425621476f593fbc76db2b2a4694dfb285`.
- Source SHA256 `46a7f53b43fdd0bfb093b19936eaa79fc616e374eeb2bfbd2142c305dac055b2`.
- Capture manifest SHA256 `3837d41a5055fd9edb13f2412f96a33660aa2fbad4beb9d3cd1eeb9e3e672f5a`.
- Node v22.23.2 SHA256 `1f72236fcbfc84855d7c884fbcba0f6a7c635d600d7e493b823e77c467f2ae95`.
- Geth1.17.10 evm SHA256 `10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521`.

The manifest binds162 entries /3602771 regular-file bytes, including59 copied source files (884063 bytes), two dependency links and25 tool/source files. The immutable older creation capture supplies3841 separately verified dependency entries /23112265 regular-file bytes. Both producer and independent preparation suites passed14/14; their exact logs and source hashes are retained in `preparation/`. Repository HEAD at freeze is52b8a6ffcb12e99e598215279f10e6844de68a78, with the exact pending working snapshot archived independently of that commit. Neither original capture nor archived source is modified by these notes.

These are synthetic selected development examples with unsigned local execution versus signed type4 Geth transitions. Both sides use identical declared initial allocations, with four disclosed inert system STOP accounts; this is not deployed Sepolia state. The product does not perform Geth post-block system calls. No public RPC, wallet action, broadcast, API transport test, population-accuracy estimate or consensus claim is made. State roots derive from actual parent-validated product deltas applied to a fresh MPT; no expected final allocation was inserted as input. Separate Geth state/regular dimensions are not exposed by this tool; only receipt scalar and block maximum are compared. The full plan and raw artifacts retain these limits.
