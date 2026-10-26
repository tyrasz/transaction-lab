# v0.7 affected-account historical capture

The approved eleven-request matrix ran once on October 26, 2026, from 04:13:43.985 to 04:14:28.608 UTC. All eleven `POST /api/replay` requests returned HTTP 200. There were **402 read-only RPC calls**, no retries, replacement transactions, signatures or broadcasts. Response bodies totaled 5,201,258 bytes, below the declared 512-call and 128 MiB limits. Capture duration is metadata, not a latency benchmark.

The frozen implementation was version **0.7.0**, source SHA-256 `7658ae0d03d6b17f72045905d231e9803b6ab38d57b4cac3a88d2eec19b5ff10`. Every API response reported that identity. The exact approved [plan](plan.json) has SHA-256 `a5286e25a2bc282e0de538031030c4afd84c3fdf776c33e2e0ea6532b0ba698e`. The immutable [capture](capture.json) has SHA-256 `53eec210304f3f3ff749bc4a4cdbd4fe55f57e87a2cd0b94983574bd0942de34`; [manifest.json](manifest.json) also fingerprints the runner. Successful raw HTTP and JSON-RPC response text, parsed bodies, requests, timestamps and checksums are retained.

| Planned case | Providers | RPC calls per provider | Additional / reused balance pairs |
| --- | --- | ---: | ---: |
| Supply | dRPC, Hyperlend archive | 31, 31 | 1 / 2 |
| Withdraw | dRPC | 38 | 0 / 3 |
| Borrow | dRPC, Hyperlend archive | 38, 38 | 0 / 3 |
| Repay | dRPC, Hyperlend archive | 43, 43 | 0 / 3 |
| Direct transfer A | dRPC | 27 | 2 / 0 |
| Direct transfer B | dRPC | 27 | 2 / 0 |
| Router permit and consumption | dRPC, Hyperlend archive | 43, 43 | 5 / 0 |

All eleven affected-account results were measured; seven cases also retained the existing lending balance measurements, and eight had measured allowances. An affected result with no new assets still validates its three `reusedPairs` through the shared query cache. Reuse is not an event-derived balance. Supply adds USDC held by the hUSDC reserve contract: `4986770736971 → 4986785803086`, delta `15066115`. Both providers agree on that pair and on the router's five USDC balances. Router/direct-A raw balances match the separately captured seven-pair [development reference](../affected-balance-validation/oracle.json). Unknown router tokens remain unmeasured, with no configured metadata inferred.

## Why 402 calls instead of the conditional estimate of 383

The plan predicted 383 calls **if prior provider outcomes persisted**. Direct transfer B previously stopped after eight calls: at block 49321930, hash `0x8f8b0ab3bf724d5a7edba34836075ec1bc98289808f232389a99dc472c629656`, block-by-hash returned five transaction hashes with the target at index 2, but canonical block-by-number returned three hashes with the target at index 0. Its transaction and receipt specify index 2. Rejecting that inconsistent state was the correct result.

The first and only planned v0.7 attempt returned the same block hash with **five transactions and the target at index 2 in both block lookups and final canonical checks**. The validated context therefore proceeded to the original-position balance and allowance reads, using 27 calls. That accounts for the entire difference: `383 + (27 − 8) = 402`. No fallback, retry or relaxed index validation was introduced.

Direct B's owner USDC balance was `1118386 → 0`; the submitter/recipient balance was `4647555924314 → 4647557042700`. Its measured allowance decreased by `1118386`. The old v0.6 eight-call response is unchanged, and the regression suite still replays its original inconsistency to require unavailable allowance and affected-account state.

## Scope and regression preservation

These are previously inspected development transactions, not random or blind evaluation cases. They do not establish an accuracy percentage, independent execution-engine agreement, a security verdict or superiority to another product. Public RPC providers and the shared validation adapter can share failure modes. No state proof or fresh source compilation was performed.

The two replay test files now consume the genuine v0.7 recordings for changed requests, while retaining exact prior execution traces, receipts, event quantities, lending position amounts, permission observations and allowance quantities. The four approval/permit-only recordings need no new query and continue using their original captures. The original archive withdrawal failure is retained separately and was not retried. Additional-account current-state measurements remain explicitly unavailable pending before/after query implementation validation; these captures cover historical original-position queries only.

The separate v0.7 browser direct-transfer check and the earlier seven-pair reference capture are not included in this eleven-request total. No earlier evidence file was overwritten.
