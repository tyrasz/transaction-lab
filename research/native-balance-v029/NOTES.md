# Native balance development capture

The one frozen offline capture completed all six declared cases: **6 matched, 0 mismatched, 0 unavailable, 0 unattempted**. All 20 requested native balance pairs matched the separately executed signed full-VM reference, and every preview retained exactly one VM execution. Original execution, return bytes, gas, logs and the full state root reconstructed from product delta rows also matched. There were four successful original executions and two completed reverts.

These are selected synthetic development regressions with a **shared EthereumJS implementation**, not independent-client evidence or a population accuracy estimate. The inputs overlap regression tests already exercised during development. No public RPC or wallet action occurred. Proofs authenticate the declared synthetic initial state root, not a live canonical chain. Only explicitly requested native accounts are measured; these results do not establish a complete asset inventory.

| Fixed case | Native pairs | Original outcome | Purpose |
| --- | ---: | --- | --- |
| `fee_transfer_unused_accounts` | 5 | success | Value, gas charge, tip, untouched existing account and proven absence |
| `sender_is_coinbase` | 2 | success | Sender/miner alias and net fee effect |
| `completed_revert` | 3 | reverted | Reverted value transfer with retained execution fees |
| `blob_completed_revert` | 3 | reverted | Reverted value transfer with execution and blob fee burn |
| `shanghai_miner_deletion` | 3 | success | Deleted miner balance and beneficiary transfer |
| `created_account_deletion` | 4 | success | Created/deleted child, factory funding and beneficiary transfer |

The product finished and its exact saved bytes were sealed before each reference process started. The reference received only the initial allocation, header and transaction. A third fresh MPT subsequently applied the sealed product's original changes for full-root comparison. Native queries retained `output:null`, the requested account identity and exact wei before/after/delta values; the reference preserved its receipt with explicit lossless integer/byte tags.

The capture retains 42 proof/code request-response records and all 12 subprocess raw outputs (565,606 decoded output bytes). Its 34 manifest-listed files total 2,785,049 bytes, excluding the manifest itself. Runtime and artifact integrity remained unchanged. Elapsed time was 4,107 ms wall time and 4,107.0905 ms monotonic, within the fixed 120-second bound. The source manifest binds 4,019 entries (one symlink; 24,893,647 regular-file bytes), including both complete installed dependency trees and the exact Node executable. Source/dependency bytes were not duplicated in this packet; executable reproduction requires those exact retained identities.

Frozen identities:

- Plan: `3dd48496b5388bece2ac5130f8a0f6ceb560ade61048eaa079613049f1e27b92`
- Source manifest: `6ea577ca6785966b830de594b34e2c3e2c120c4c2400a127ed3aa5da274bf6ae`
- Evidence manifest: `ff3fc44eb75b62cbc787a75beee23a9b7e256220d83b79d258e2d8c6f8b33b18`

The producer's post-seal artifact-only check rehashed every captured file and raw stream, joined each raw stdout to its parsed result, checked clean process completion and rechecked each product seal. A separate reviewer owns the sibling `research/native-balance-v029-review` verification; it does not reexecute the packet targets. The capture is immutable. This note was added afterward and is outside its evidence manifest.

Related development controls pass in `test/local-native-balances.test.js` and `engines/local-evm/test/native-balance-comparison.test.js` (16 test groups). These additionally cover actual API/child integration, proof/cache handling, missing or invalid extra proofs, cancellation/final-header withholding, mixed native/CALL queries and native reads after exhausting an otherwise sufficient VM step budget. The comparison tests include ten separately executed signed full-VM/third-MPT counterparts and share EthereumJS as disclosed above.
