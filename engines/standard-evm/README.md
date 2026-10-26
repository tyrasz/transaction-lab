# Experimental standard EVM call measurements

This module executes one unsigned, zero-native-value call through a supplied read-only RPC client, then measures selected ERC-20 `balanceOf` and `allowance` queries before and after it. Version 0.10 adds automatic selection from observed execution; manually declared queries retain their existing behavior. The low-level interface accepts a positive chain ID and fixed block hash rather than depending on the HyperEVM token registry. The Ethereum chain 1 profile is exposed through `POST /api/evm/simulate` and the browser's Ethereum network choice. The existing HyperEVM routes retain their semantics.

```sh
cd engines/standard-evm
npm ci --ignore-scripts --no-audit --no-fund
cd ../..
node --test engines/standard-evm/test/*.test.js
```

These pinned dependencies are optional for starting the HyperEVM server but required for Ethereum previews and the full main test suite. Install them and restart a running service. If unavailable, `/api/config.standardEvm.available` is false, the browser disables Ethereum simulation, and its API returns 503. The separate local EthereumJS executor is not used by this route.

The interface is `simulateUnsignedCall({rpc, chainId, blockHash, request, queries})`. Omit `queries` for automatic selection; an explicit list has one to eight entries, each with only `to` and canonical query `data`. The exact request has `from`, `to`, `data`, `gas` and `value`. There is no signing or broadcast method. The RPC adapter must enforce a maximum 25-second request timeout and preserve raw transport evidence. The module retains bounded parsed evidence with references from each measurement to its before/after trace and mutation checks.

## API and browser

The HTTP input is flat: `{chainId:1,from,to,data,value:"0",block?,queries?}`. Omit `queries` for automatic selection. An explicit manual list must contain one to eight distinct canonical `balanceOf(address)` or `allowance(address,address)` calls as `{to,data}`; `[]` and `null` are rejected. `block` may be `latest`, a canonical hexadecimal number or a block hash; its default is `latest`. Number/latest selection resolves once to a canonical hash before execution. The server fixes gas at 5,000,000, requires zero native value, and rejects caller-supplied provider URLs, fee/gas fields, overrides or metadata before provider work.

`ETHEREUM_RPC_URL` is configured on the server only and defaults to `https://eth.drpc.org`. The server's bounded transport allows 65 calls total, including one optional block-selection request, at most 8 MiB per response body and 32 MiB shared response bodies, with a 145-second total deadline and 25-second per-call limit. The engine's narrower limits below still apply. There are no automatic retries, replacement states or provider fallbacks.

The response preserves the full engine output and adds normalized `apiRequest`, `source.blockSelection`, `preview.queries`, timings, implementation binding and raw `transportEvidence`. Automatic mode also returns `discovery` with bounded observations, candidates, selections, omissions, diagnostics and limits. `preview.scope` is `observed_queried_accounts` in automatic mode and `explicit_queried_accounts` in manual mode; `preview.queries` always describes the actual selected list. Each row identifies its token and balance account or allowance owner/spender. Known names and decimal units come from historical reference metadata with `verifiedForSimulation:false`; unknown tokens retain exact raw units. No aggregate portfolio amount is inferred.

The browser loads the Aave and Morpho-wrapper examples at their explicit historical parent hashes. Automatic checks are the default; Advanced lets a user enable a manual query list. Example manual lists are preloaded but not sent in automatic mode. Balance and allowance rows remain separate, unavailable is not zero, and one account's inner-vault holdings are not added to another account's wrapper shares. A coverage card distinguishes a completed bounded scan, hard truncation, omitted candidates and failed measurements. Changing inputs or query mode clears prior results; in-flight requests lock the network and request fields. The raw JSON remains available for download. Current live verification and prior 0.9 evidence are tracked separately in [STATUS.md](../../STATUS.md#integrated-live-verification).

## Automatic query discovery

`discoverTokenQueries` reads the original call trace without making additional provider requests. Committed ERC-20-shaped Transfer and Approval logs supply candidate balance/allowance pairs. Direct `CALL` frames with canonical transfer, transferFrom or approve arguments can also supply candidates. Proxy-emitted events use their actual storage context; delegated function frames do not independently invent token callers. Failed and static subtrees, zero-address balance accounts, NFT-shaped events and ambiguous shared-selector call evidence are excluded. ABI shape alone does not verify that an address is an ERC-20 token, that a call was authorized or that an emitted amount changed any balance.

Deduplicated candidates are sorted by sender balances, sender-owned allowances, other balances and other allowances, then lexically by token/query within each priority. At most eight are selected. All additional candidates remain visible with `selection:'omitted_query_limit'`; exceeding eight candidates is not a truncated scan. `counts.complete` means the bounded trace scan finished, not that every economic effect was discovered. `counts.truncated` marks a hard resource limit. A malformed trace or hard limit returns discovery unavailable, clears selected queries and retains partial candidates as unavailable. No candidates means no supported query candidates were found, not that no assets changed.

The scan is bounded to 128 candidates, 1,000 frames, depth 32, 2,000 logs, 512 observations, 1,024 candidate references, 256 diagnostics and 8 MiB of string evidence. Unsupported/malformed known event or call encodings are diagnosed and excluded when the surrounding trace remains valid. Every selected amount still comes from separate validated before/after queries. Emitted event values and requested call amounts are retained only as observations; neither supplies expected balances or measured deltas. Explicit manual mode bypasses discovery and preserves its original one-to-eight-query behavior.

## Execution and measurement

The module validates the provider's chain, source header and sender basic state. Senders must have no runtime code; targets must have code. The original call trace must match the declared envelope. The complete original state diff is applied only to isolated post-state queries; no balance, allowance or expected token quantity is supplied to make a deposit succeed.

The provider adapter admits optional `codeHash` metadata only when the same account record includes explicit runtime code and its Ethereum Keccak-256 hash matches. It retains each verified claim, and all other unknown fields remain rejected. Hashing uses the pinned [`@noble/hashes` implementation](https://github.com/paulmillr/noble-hashes). This checks consistency between provider-supplied bytes and hashes; it is not independent bytecode or blockchain-state attestation. The HyperEVM routes' state parser is unchanged.

Both query contexts are checked using a separate header witness. Block number, timestamp, gas limit, synthetic zero BASEFEE, randomness, coinbase, chain ID and parent hash must match. Each actual token query has its own call trace and mutation diff. Read paths may use STATICCALL and DELEGATECALL; nonzero native transfers, events, failed paths and extra state changes are rejected. The sole permitted query mutation is the caller nonce increment, which is discarded. Omitted zero prefields are accepted only when independently read pinned sender state explicitly establishes zero. Unknown values never become zero by default.

Each result preserves exact integer before/after values and their difference. It does not assume that deposit amounts equal receipt-token or vault-share quantities. A final full-header and block-content comparison must succeed; failure invalidates every measured value. Failed original execution remains distinct from unavailable infrastructure or unsupported measurement behavior.

Limits are eight distinct queries, 64 RPC calls, 8 MiB per parsed result, 32 MiB retained parsed results and a 120-second scheduling window. A bounded in-flight request can extend the window by at most 25 seconds. Trace limits are 1,000 frames and depth 32. Contract creation/destruction and changed runtime code are unsupported for measurements.

## Interpretation

Results describe execution at the selected block's **end state** under an unpriced profile. They are not original transaction-position replay, signed-transaction validation, fee estimates or predictions of a future mined transaction. A permit signature embedded in the original calldata may be checked by the executed contract; the module does not independently authenticate the outer transaction.

The provider executes bytecode. Query behavior checks do not attest runtime source code, provider honesty or token economics. Only selected account/token/allowance pairs are measured, whether automatically observed or manually declared. Native effects, unlisted participants, silent changes, arbitrary positions and complete asset discovery remain outside that inventory. A token balance increase is not by itself a gain in spendable wealth. Security stays `not_assessed`; successful execution is not a benign verdict.

The [capability survey](../../research/standard-evm/CAPABILITIES.md) and [selected deposit inputs](../../research/standard-evm/DEPOSIT-TARGETS.md) preserve real public-chain evidence separately from synthetic test controls. The selected Morpho example is a Kiln wrapper over the V1 Steakhouse vault; the wrapper's six-decimal shares and the inner vault's eighteen-decimal shares are different assets.

The [first two-case capture](../../reports/standard-evm-deposits/NOTES.md) is preserved: Aave execution and four measurements succeeded; Morpho execution succeeded but its extra `codeHash` metadata made the original strict parser withhold every measurement. The [separate revised capture](../../reports/standard-evm-deposits-v2/NOTES.md) repeats the same calls and queries with the verified metadata adapter: both executions succeed, and all four Aave and eight Morpho measurements validate. It retains 76 exact RPC responses and the complete executable source/dependency archive. These are two selected development examples, not a representative transaction accuracy benchmark or four independent cases.
