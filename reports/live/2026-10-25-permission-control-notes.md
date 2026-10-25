# Current-state observations accompanying 0.5.0

The twelve-case live run is retained in `2026-10-25T15-28-20-264Z.json`: eleven checks pass, current repayment fails its expected-success check. Its original public request now returns the contract error `ERC20: transfer amount exceeds balance` at block 49496794. The transaction is reverted and does not create committed transfers or measured final balances. Historical repayment still passes. No new wallet was substituted and no retry was used to change that denominator.

`expired-husdc-permit-response-0.5.0.json` is a separate current-state control. The local API returned HTTP502 with RPC_EXECUTION_ERROR / -32001. The original failure is retained; its specific provider cause was not established.

One separately named diagnostic, `expired-husdc-permit-diagnostic-0.5.0.json`, calls the same simulation function with RPC capture. It made exactly three reads: chain ID, current block, and hash-pinned debug_traceCall. At block49496834 it returned reverted, gas29551, returnData0xfb2a6752. No effective permission observations or final allowance measurements were produced.

The selector matches `InvalidExpiration()` in the captured hUSDC implementation ABI (`reports/permission-discovery/sources/husdc-abi.json`). The implementation source requires block.timestamp <= deadline before signature recovery. This diagnostic identification used the existing @noble/hashes keccak implementation from the separate Dynamic demo; no dependency was added to the service. The service itself still reports an undecoded custom error, because its general revert decoder has no configured ABI for that selector. This observation is not independent cryptographic signature verification.

`historical-router-permit-response-0.5.0.json` is the exact response displayed in the browser, run ID ef021603-21ea-4c40-afbe-273d787588bc. It is a historical original-position result, separate from the current-state controls.
