# First selected Ethereum deposit capture

Two unchanged public deposit calls were submitted once each to the public Ethereum dRPC endpoint as read-only simulations. The capture completed in 18.525 seconds with 41 RPC requests, 41 complete HTTP 200 JSON-RPC responses, and 403,724 response bytes. No transaction was signed or broadcast. No retry, replacement wallet, replacement transaction, other provider, or invented balance/allowance was used.

The execution state is each original transaction's **parent block end**, with that parent header. It is not the original transaction position. The original `from`, `to`, and calldata—including the Aave permit signature—are unchanged. Gas is normalized to 5,000,000 and gas price omitted; the successful Aave header witnesses confirm the synthetic BASEFEE-zero profile. The outer transaction signature and fee settlement are not validated. The EVM still executes any permit verification present in the supplied call.

| Case | Provider-reported execution | Before/after measurement | RPC requests |
| --- | --- | --- | --- |
| Aave V3 USDC `supplyWithPermit` | Success, gas used 189,775 | All four queries measured; final canonical header verified | 30 |
| Kiln wrapper deposit into Morpho V1 | Success, gas used 1,413,682 | All eight queries unavailable; preparation stopped before any balance query or final canonical check | 11 |

## Aave measurements

Original transaction: `0x6166280a62cdad28e7b8af05ebb622b42b61deff981b3b6cd83dc03b3bb130b2`.
State block: 26,270,482, hash `0x4badf912d1bcc7f77197108544be0ab4b8cef7a94fb7a4ee1e65fda816300dc7`.

| Query | Before raw | After raw | Delta raw |
| --- | ---: | ---: | ---: |
| Sender USDC | 3962903485 | 0 | -3962903485 |
| Beneficiary aEthUSDC | 0 | 3962903484 | 3962903484 |
| aEthUSDC reserve's USDC | 151987610826648 | 151991573730133 | 3962903485 |
| Sender USDC allowance to Aave Pool | 0 | 0 | 0 |

Both assets have six decimals in the recorded metadata: the wallet spends 3,962.903485 USDC and gains 3,962.903484 aEthUSDC. The one-unit difference is retained as measured. The allowance is measured at the beginning and end of the entire call; zero-to-zero does not mean that no permit or intermediate spending occurred.

The original call trace is RPC 10; the complete original state diff is RPC 11. Header witnesses are RPCs 12–13. Each query then uses separate before/after callTracer and prestateTracer requests: sender USDC 14–17, beneficiary aEthUSDC 18–21, reserve USDC 22–25, allowance 26–29. RPC 30 confirms the canonical header. No receipt event amount was substituted for a measured query result.

## Morpho limitation retained

Original transaction: `0xc46259d8064831c47c68776ca0611af75337adf8c4aee4bee5add0878b8873a7`.
State block: 26,270,562, hash `0x00cbe8bb974276f900d767a7853e0011817eeebbea1d9525e7c1fb230fd21d61`.

RPC 40 returns a successful execution trace. RPC 41 returns a complete original prestate diff with an additional `codeHash` field on five prestate accounts: the wrapper, interest-rate model, USDC, Morpho Blue, and inner vault. The frozen strict state-diff parser rejects these unsupported fields. Its exact local validation exception is `State diff contains unsupported account fields.` The public engine result intentionally uses a fixed generic failure description, which by itself does not identify this schema issue.

This is an engine schema-support limit, not an observed HTTP error, JSON-RPC error, or deposit revert. The engine did not proceed to any of the eight before/after measurements or the final canonical check. It therefore reports no measured balances or allowances for this case. Nothing in this packet demonstrates the post-deposit state at the original transaction position.

A future adapter could validate each supplied code hash against the supplied bytecode before accepting this provider-specific field; merely deleting unknown fields would weaken the current validation. Such a change and any follow-up capture must remain separate from this frozen first attempt.

The wrapper's six-decimal mstkeUSDC shares and the inner vault's eighteen-decimal steakUSDC shares are distinct. The plan explicitly omits the wrapper self-fee share balance, inner-vault fee-recipient shares, inner-vault allowance to Blue, and other market/debt positions. Neither case claims complete economic-effects coverage or a security verdict.

## Evidence and offline verification

- `capture.json` SHA-256: `e0bde3899b5dc2795206ed70b6faa82f2a8bcaa5f8f82a79c3151f2fa093f778`.
- `plan.json` SHA-256: `18ca6712e4142cdb52ee80564ed2709437a19422942a151feb58311f628117df`.
- The seven-file source inventory matches before and after execution. Node/V8/platform/architecture are recorded in `STARTED.json` and the capture.
- `raw/001.body` through `raw/041.body` preserve complete response entity bytes. Paired JSON records preserve the exact request text, response text, parsed envelope, byte counts, hashes, HTTP headers, and timing. UTF-8 decoding is strict; no BOM or malformed bytes are silently removed.
- Original transaction envelopes, receipts, headers, and token metadata remain in the separately frozen discovery packet. Receipt amounts are comparison references and query-role evidence, never initial state or expected simulation outputs.

`node reports/standard-evm-deposits/verify.mjs` performs no network access. It verifies all raw bodies and requests, source hashes, limits, both complete engine results through strict recorded transport playback, the four exact Aave measurements, and the preserved Morpho rejection. The audit passed. These selected examples are development evidence, not a blind holdout, production chain-support claim, or comparison with Blockaid.
