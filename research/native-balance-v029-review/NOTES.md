# Native ETH balance release review — 0.29.0

The local Ethereum preview now reads balances for explicit native-account queries without another EVM invocation. The original execution and authenticated state determine the result. The change also validates unpriced native balance deltas against the retained execution ledger, including balances inherited by later disposable contract queries.

## Verification

- Application suite: **700/700 passed**, 48.536 seconds, with permission for temporary localhost test servers. The initial restricted run is retained separately: 675 passed and 25 could not bind localhost (`EPERM`); none of those failures was an assertion about a transaction result.
- Local engine suite after the additional actual-child budget control: **711/711 passed**, 20.373 seconds. The earlier 710-test run is also retained.
- Independent core/parent review: **27/27 controls passed**. It checked proof reuse, no added executions/nonces, exact ledger-derived amounts, deletion masks, pair-local proof failure and global withholding.
- UI checks: **51/51 passed**, including exact large/negative wei formatting, request/response schema checks, stale-result handling and fee labels. A subsequent wording correction explicitly limits query gas to contract calls.

The [six-case synthetic comparison packet](../native-balance-v029/NOTES.md) retains exact initial fixtures, proof responses, isolated product results and separately executed full-VM counterparts. Both execution paths share pinned EthereumJS packages. A separately assembled trie checks the product state changes against the full-VM root. This does not establish independent-client agreement, consensus/finality, full economic coverage or a population accuracy rate.

No public RPC request, user-wallet signature or transaction broadcast was made for this feature's development checks. Counterpart transactions use a fixed synthetic test key. The [browser check](../native-balance-v029-ui/NOTES.md) uses synthetic proof responses through the actual local form and HTTP adapter.

Root independently checked the capture manifest pin `ff3fc44eb75b62cbc787a75beee23a9b7e256220d83b79d258e2d8c6f8b33b18`, the exact 34-file inventory, every file hash and all twelve raw subprocess outputs against their parsed records. The capture retained six matches (four successful calls and two completed reverts), twenty native account pairs and one original EVM execution per case. It completed in 4.107 seconds. No target was rerun for this check.

Independent [artifact audit](ARTIFACT-AUDIT.md) reverified all 21 account proofs and 42 proof/code joins, rebuilt six initial tries and six resulting state roots, and checked all twenty measured pairs. Its verifier and all five negative/relocation controls also passed in the root review. Phase-level input ID lists remain diagnostic; this audit does not independently authenticate their timing.
