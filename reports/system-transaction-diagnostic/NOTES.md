# Separate system-transaction diagnostic

The three extra hashes in provider B's failed-pilot block list each map uniquely to a HyperCore system action returned by the official endpoint. This is supported by twelve matching fields per action, not merely an equal block hash or zero gas price. The failed pilot remains `selection_failed`, with null metrics; its evidence and selection rule were not changed.

The fixed diagnostic made exactly **12 read-only RPC requests**, with no retries or substitutions, and received **7,931 bytes**. All returned valid HTTP 200 JSON-RPC responses. `plan.json` and `capture.mjs` were saved and locally validated before the run. `capture.json` preserves exact successful response text, byte counts, hashes, requests and timestamps. The offline verifier uses only Node built-ins.

## Observed correspondence

Block **49,544,166** (`0x2f3fbe6`) has hash `0x1a90cb1b12defb35c5b542b1218b4b5f8524d7eea721ab1f0cf28e8b6af8e2b4` in the saved A/B lists and new official response. Official ordinary block queries return the same ordered five hashes as A's pilot response. B's saved list contains three additional hashes followed by those five. The official system method returns exactly three entries.

| B additional hash (also resolved by A) | Official system hash | System index |
| --- | --- | --- |
| `0xc9d5e5dfb1b07ed8d7bb0373618767191bd7ad9bcc11d9185bff886ba7ab088a` | `0xd8e0b682c5a475c94ef471bbe8cfc18cdb9265bb42eab9f513ce4e1b335c1901` | 0 |
| `0x14f094947b7c9ca7d83baad145e0e26e3c770a884709e7dc4b3e539d222664d8` | `0x76fdff61e64fc6f0e37f12ec1ddc86d12613bfda6d362be12a72a2d3b02c1282` | 1 |
| `0x395725735b69f19ffcb48893a82942e932bfd719ef10faf666ae739d2a510939` | `0x1f460dc26603c831d5e46aaf30a48508513da0b66f6e9e06d44a0a6e96be1737` | 2 |

Each match has identical `type`, `chainId`, `nonce`, `gasPrice`, `gas`, `from`, `to`, `value`, `input`, `blockHash`, `blockNumber` and `transactionIndex`. A and B's direct lookup objects are identical. All fields are present; no wildcard or inferred value was used. `comparison.json` retains each full mapping and raw transfer-shaped calldata arguments; no token symbol or decimals are assumed.

Only `hash`, `r`, `s` and `v` differ between official and A/B objects. Official entries use `r=0`, `s=0`, `v=0x7f1`; A/B entries use `r=1`, `s=from`, `v=0x7f2`. These are observed encoding differences. This diagnostic did not reconstruct transaction hashes, recover signers, or inspect the underlying system-action implementation. The official ordinary lookup of the first A/B hash returns `null`; A and B both resolve all three despite A's ordinary block list omitting them.

## Interpretation and limits

Hyperliquid documents the custom methods as returning system transactions originating from HyperCore. That attribution plus the complete action-field mapping supports calling these **alternate RPC representations of the same three system actions**. [Official JSON-RPC documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc)

Quicknode documents that its own archive route includes system transactions absent from its ordinary EVM block view and that ordinary lookups may not resolve them. This is consistent with the observed list distinction, but does not identify A/B's client software, infrastructure, or independence. [Quicknode route documentation](https://www.quicknode.com/docs/hyperliquid/hyperevm-overview)

No receipt, trace, balance, contract code or user-transaction index was queried. In particular, this does **not** establish a constant index offset, equivalence of `debug_traceCallMany` transaction positions, execution correctness, or which representation should define a future cohort. Any future protocol must predeclare its treatment of system actions and separately validate provider-specific original-position semantics. This diagnostic does not admit a replacement cohort or repair the failed pilot's denominator.

## Offline verification

Run `node reports/system-transaction-diagnostic/verify.mjs`. It verifies all retained response hashes, exact request membership, budget accounting, the unmodified pilot source, three unique complete mappings, and the negative official lookup. It makes no network calls.

Capture SHA-256: `e7a2811020a5970f5a665d9948b543fc6d6155673ae823e8c86bff4f752f362c`.
