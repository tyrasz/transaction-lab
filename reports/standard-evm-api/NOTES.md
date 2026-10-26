# Ethereum API and browser verification — 0.9.0

The actual browser submitted the Aave and Morpho-wrapper deposit examples once each to `POST /api/evm/simulate`. Both returned HTTP 200, successful execution and all requested measurements. These are the same two selected development examples used by the earlier standalone module, at the same historical parent-block-end states. They are not new independent accuracy samples, original-position replays or simulations against today's balances.

| Browser example | Requested checks measured | Sender USDC change | Sender receipt-share change | Observed API time | RPC calls |
| --- | --- | --- | --- | --- | --- |
| Aave V3 `supplyWithPermit` | 4 / 4 | −3,962.903485 | +3,962.903484 aEthUSDC | 9.583 seconds | 30 |
| Kiln wrapper into Morpho V1 Steakhouse vault | 8 / 8 | −350,000 | +330,497.511812 mstkeUSDC | 12.550 seconds | 46 |

Aave's final sender-to-Pool allowance is 0→0 after permit use. Morpho's sender-to-wrapper allowance is 350,000→0 USDC; wrapper-to-inner-vault allowance remains 0→0. The wrapper receives 305,565.121166487000888945 inner vault shares. Those belong to the wrapper and are displayed separately from the depositor's outer shares. The Morpho Blue contract's USDC balance rises by 350,000; the queried wrapper and inner-vault USDC balances are unchanged.

All 76 public read-only RPC responses completed, totaling 443,456 response bytes. No retries, replacement cases or altered state inputs were used. These two timings are observations, not production latency benchmarks. No transaction was signed or broadcast. Security remains `not_assessed`, and unqueried accounts, assets, debts and permissions are outside the measured inventory.

## Inspect the actual JSON

- [Aave response](aave-response.json) and [Morpho response](morpho-response.json) are readable formatting of the complete API JSON, including call traces, exact quantities and raw RPC transport evidence. Their parsed objects equal the locally persisted reports and captured HTTP response bodies.
- [Aave HTTP exchange](http/001.json) and [Morpho HTTP exchange](http/002.json) preserve exact request/response body text, body byte counts and SHA-256 hashes, plus the response status prepared by the server.
- [Results index](results.json) summarizes both runs. [Browser checks](browser-checks.json) records manual CUA accessibility, DOM and screenshot inspection, matching displayed run IDs and quantities, separate owners, locked inputs while running, cleared stale results and JSON controls. The screenshots were inspected in the tool conversation; no screenshot file or automated browser replay is part of this packet.

The browser still runs at `http://127.0.0.1:5174/`. Select Ethereum to use these examples or supply custom inputs and explicit balance/allowance queries. The historical examples keep their tested block hashes; using `latest` changes the state being simulated and can change whether the call succeeds.

## Frozen implementation and capture

The [plan](plan.json) was saved before either request. It records one browser attempt per case, the exact inputs, provider and 35 archived files: the 30-file implementation inventory, dependency license, three browser files and the capture wrapper. The [wrapper](run-server.mjs) observed the ordinary API handler's input and response bodies without changing the calls or RPC client. Its `STARTED` marker prevents overwriting this capture. After the two browser results were verified, that capture process was stopped and the ordinary local server was restarted.

The implementation inventory includes the server's transitive imports, isolated engine and pinned hashing dependency. The loader snapshots these files at startup and compares them before and after its lazy import; source drift is rejected. The snapshot identifies declared application files, not the operating system, Node runtime or independent chain state.

- Plan SHA-256: `d210d8867d00a19e26bf0464fe8a999f65b347702d3d90c2ac183d4ed5a6a6fd`.
- Implementation SHA-256: `9c0917464c657429c37b01b73961f310adeb902e91ff585fc12b82c8b6053773`.
- [Sealed manifest](manifest.json) SHA-256: `5a8a8d7d6749bad58c12f75349682bdc2773eb9ce0e567b52aee68b43193dc4c`.

The manifest binds 43 retained files totaling 3,851,914 bytes. The supplemental offline verifier and its results are recorded separately so they do not rewrite the frozen capture.

The [offline verifier](verify.mjs) reproduces both complete API results through the archived HTTP handler and production RPC client, using the exact 76 recorded wire responses. It checks requests outside the engine's error handling, requires the complete planned file/case inventories, and verifies all quantities, preview fields, evidence, source identity and wire hashes. Only generated run IDs, timestamps and durations are excluded from equality, after their types and ranges are checked. It opens no sockets and makes no public requests. This establishes reproducibility of these provider-backed results, not independent EVM correctness or browser rendering.

The saved [verification result](verification.json) passes, along with seven focused verifier controls covering complete inventory, altered evidence, extra attempts, request ordering, response reuse, semantic changes and withheld failures. Result SHA-256: `473a401bbbea5d1465f65eb98c9b0c50c771d30e7393c38646458fb99e5638c2`. The [supplemental manifest](supplemental-manifest.json) binds this verifier, its tests and result separately from the original capture.

```sh
node reports/standard-evm-api/verify.mjs
node --test reports/standard-evm-api/verify.test.mjs
```

The 0.9 main regression suite passes 490/490 tests, including full recorded HTTP-path Aave/Morpho checks, transport limits and failures, loader drift, input validation, concurrency and preserved HyperEVM replays. The isolated Ethereum engine passes 31/31 tests. Test counts are not transaction accuracy rates.
