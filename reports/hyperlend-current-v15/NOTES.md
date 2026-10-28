# Fresh Hyperlend supply check

One actual request to the running local application's `/api/simulate` route returned HTTP 200 and successful execution on 2026-10-28 at 02:36:17 UTC. Gas used was 165,727. The capture took 1,142 ms and retained the exact 212,850-byte JSON response.

The request is the saved `current-supply` case from `reports/current-validated-decimal/plan.json`, with **only `block` changed to `latest`**. The sender, recipient, calldata and zero native value are unchanged. The application resolved latest to HyperEVM block **49,713,220**, hash `0xb675c22b76a021c334ad09c41d590d380860bf707d084fab55d3abbf875230ee`.

| Measured state | Before | After | Change |
| --- | --- | --- | --- |
| Wallet USDC | 640.839336 | 625.773221 | −15.066115 |
| Wallet hHyperEvmUSDC | 3180.029106 | 3195.095221 | +15.066115 |
| Reserve USDC | 5243816.963921 | 5243832.030036 | +15.066115 |

The wallet's USDC allowance to the Hyperlend pool was also measured and decreased by exactly `15066115` raw units. Its exact before/after integers are retained in the response. Configured balance, allowance and affected reserve-balance statuses are all `measured`; execution remains `success`. The response's security status is `not_assessed`.

The application reports version **0.15.0** and HyperEVM source fingerprint `00ed9f3a69bd317de3c5758f2ceed6ce68e5c8e51a037c0c563be4f7f6282f35`, matching the 23-file inventory recorded before dispatch. Those files were unchanged when the response was saved. The packet records source hashes, not a new complete dependency archive.

This is one selected current-state development check, with no retry or replacement wallet. The request used an unsigned simulation, and no transaction was signed or broadcast. The application's provider-backed query validation uses a pinned block and synthetic zero BASEFEE; it does not predict future inclusion or fees. No independent local execution comparison was performed here, and this single result establishes no reliability percentage.

`request.json` is the exact HTTP body. `response.json` is the exact response body, including trace/query evidence. `metadata.json` preserves the HTTP status and headers, start/finish times, response hash and source checks. `declaration.json` was saved before the attempt and limits the client to one request, 150 seconds and an 8 MiB response. The client deadline does not establish that a server would cancel work after a disconnected request.

Response SHA256: `ab7993a3e77576ad10c545b9cd1d7ea3e4560c3f3e83d145ce9dc988e9ce676c`.
