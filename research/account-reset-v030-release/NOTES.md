# Running release verification — 0.30.0

Implementation commit `989e5488e2e076a249583a15e414e695c75574d0` passed **737/737 local-engine controls** and **701/701 application controls**. Main was fast-forwarded to that commit and its existing localhost server restarted on port 5174. The retained health response reports version **0.30.0**, status **ok** and **readOnly:true**. Configuration reports the Ethereum local, Ethereum provider and Arbitrum engines available.

The release supports neutral after-state getters that temporarily recreate a deleted account and roll their changes back. The proof manager retains authenticated reset provenance for internal continuation. Public API sequences remain unsupported. The two-case [API packet](../account-reset-v030-api/NOTES.md) retains the successful neutral getter and the withheld mutating getter. Its artifact verifier passes from the release worktree.

The original Geth packet and independent artifact review are linked from [the release status](../../STATUS.md). The first capture retains five complete matches and ten unavailable return-data comparisons caused by empty later native call traces. All fifteen saved state roots, log hashes, receipt statuses and gas totals agree. The root repeated the independent artifact verifier and its nine negative controls, plus all thirteen current harness/diagnosis controls; every check passed.

The separate [JSON-trace correction](../account-reset-v030/json-trace-followup/NOTES.md) matches all fifteen fixed prefixes on state, logs, gas, status and exact return data, using the unchanged Geth binary and previously sealed product expectations. It adds no product rerun and preserves the first capture. Independent audit reconstructs all corrected state roots and parses all 33 traces/receipts; all eight adverse-control groups pass. The root also repeated all seven correction harness controls successfully.

The first full application test run retains 664 passes and 37 failures: 25 sandbox localhost-binding failures and twelve source-identity failures while release version files were changing. The complete rerun used stable source and permitted localhost binding, with all 701 passing. The earlier six-control harness log is retained alongside the final thirteen-control run; it is not presented as the latest harness. Raw logs and durations remain in this directory.

The [live Sepolia smoke test](../sepolia-smoke-v2/NOTES.md) is separate. Viem's public-provider simulation succeeded for an unsigned 0.001 test ETH transfer, while our actual endpoint rejected chain 11155111 as unsupported. This release does not enable Sepolia. No wallet was controlled or funded, and no transaction was broadcast. Release verification itself used only two localhost reads and saved artifacts, with no new public RPC or EVM execution.

These are bounded synthetic development and release checks. They do not establish a representative EVM accuracy rate, consensus validity or complete economic effects.
