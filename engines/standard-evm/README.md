# Experimental standard EVM call measurements

This module executes one unsigned, zero-native-value call through a supplied read-only RPC client, then measures explicitly requested ERC-20 `balanceOf` and `allowance` queries before and after it. It accepts a positive chain ID and fixed block hash rather than depending on the HyperEVM token registry. It is separate from the unchanged version 0.8.0 API and browser preview.

```sh
cd engines/standard-evm
npm ci --ignore-scripts --no-audit --no-fund
cd ../..
node --test engines/standard-evm/test/*.test.js
```

The interface is `simulateUnsignedCall({rpc, chainId, blockHash, request, queries})`. The exact request has `from`, `to`, `data`, `gas` and `value`; each query has only `to` and canonical query `data`. There is no signing or broadcast method. The RPC adapter must enforce a maximum 25-second request timeout and preserve raw transport evidence. The module retains bounded parsed evidence with references from each measurement to its before/after trace and mutation checks.

## Execution and measurement

The module validates the provider's chain, source header and sender basic state. Senders must have no runtime code; targets must have code. The original call trace must match the declared envelope. The complete original state diff is applied only to isolated post-state queries; no balance, allowance or expected token quantity is supplied to make a deposit succeed.

The provider adapter admits optional `codeHash` metadata only when the same account record includes explicit runtime code and its Ethereum Keccak-256 hash matches. It retains each verified claim, and all other unknown fields remain rejected. Hashing uses the pinned [`@noble/hashes` implementation](https://github.com/paulmillr/noble-hashes). This checks consistency between provider-supplied bytes and hashes; it is not independent bytecode or blockchain-state attestation. The main API's state parser is unchanged.

Both query contexts are checked using a separate header witness. Block number, timestamp, gas limit, synthetic zero BASEFEE, randomness, coinbase, chain ID and parent hash must match. Each actual token query has its own call trace and mutation diff. Read paths may use STATICCALL and DELEGATECALL; nonzero native transfers, events, failed paths and extra state changes are rejected. The sole permitted query mutation is the caller nonce increment, which is discarded. Omitted zero prefields are accepted only when independently read pinned sender state explicitly establishes zero. Unknown values never become zero by default.

Each result preserves exact integer before/after values and their difference. It does not assume that deposit amounts equal receipt-token or vault-share quantities. A final full-header and block-content comparison must succeed; failure invalidates every measured value. Failed original execution remains distinct from unavailable infrastructure or unsupported measurement behavior.

Limits are eight distinct queries, 64 RPC calls, 8 MiB per parsed result, 32 MiB retained parsed results and a 120-second scheduling window. A bounded in-flight request can extend the window by at most 25 seconds. Trace limits are 1,000 frames and depth 32. Contract creation/destruction and changed runtime code are unsupported for measurements.

## Interpretation

Results describe execution at the selected block's **end state** under an unpriced profile. They are not original transaction-position replay, signed-transaction validation, fee estimates or predictions of a future mined transaction. A permit signature embedded in the original calldata may be checked by the executed contract; the module does not independently authenticate the outer transaction.

The provider executes bytecode. Query behavior checks do not attest runtime source code, provider honesty or token economics. Only declared account/token/allowance pairs are measured. Native effects, unlisted participants, arbitrary positions and complete asset discovery remain outside that inventory. Security stays `not_assessed`; successful execution is not a benign verdict.

The [capability survey](../../research/standard-evm/CAPABILITIES.md) and [selected deposit inputs](../../research/standard-evm/DEPOSIT-TARGETS.md) preserve real public-chain evidence separately from synthetic test controls. The selected Morpho example is a Kiln wrapper over the V1 Steakhouse vault; the wrapper's six-decimal shares and the inner vault's eighteen-decimal shares are different assets.

The [first two-case capture](../../reports/standard-evm-deposits/NOTES.md) is preserved: Aave execution and four measurements succeeded; Morpho execution succeeded but its extra `codeHash` metadata made the original strict parser withhold every measurement. The [separate revised capture](../../reports/standard-evm-deposits-v2/NOTES.md) repeats the same calls and queries with the verified metadata adapter: both executions succeed, and all four Aave and eight Morpho measurements validate. It retains 76 exact RPC responses and the complete executable source/dependency archive. These are two selected development examples, not a representative transaction accuracy benchmark or four independent cases.
