# Provider codeHash adapter follow-up

This is a declared second capture of the **same two selected transactions and the same twelve explicit queries** after the engine added validation for the provider's `codeHash` field. It is adapter-fix and regression evidence, not a new independent accuracy sample. [The first capture](../standard-evm-deposits/NOTES.md), including its unavailable Morpho measurements, is unchanged.

The single executed follow-up finished in 21.344 seconds with 76 RPC requests, 76 complete response bodies, 443,865 response bytes, and unchanged hashes for all seventeen bound source/dependency files. Aave used 30 requests and Morpho used 46. Both calls succeeded; every requested measurement completed, and both final canonical headers were verified. No RPC was retried and no account, calldata, query, block, or provider was replaced.

The first process-creation request was rejected because automatic permission review timed out **before execution**. A local check confirmed that `STARTED.json`, `capture.json`, `raw`, and `sources` did not exist. The explicitly permitted process-creation retry started the sole live follow-up capture. That approval-system retry made no duplicate RPC sequence.

## What is measured

Each request uses the original sender, recipient, and calldata—including the original Aave permit signature—at its original **parent block end**, with gas fixed to 5,000,000 and gas price omitted. The header witnesses validate the synthetic BASEFEE-zero environment. This is not the original transaction position, fee settlement, or validation of the outer transaction signature; the EVM does execute any permit verification in the supplied calldata.

### Aave V3 USDC supplyWithPermit

Original transaction: `0x6166280a62cdad28e7b8af05ebb622b42b61deff981b3b6cd83dc03b3bb130b2`.
Pinned parent block: 26,270,482 / `0x4badf912d1bcc7f77197108544be0ab4b8cef7a94fb7a4ee1e65fda816300dc7`.
Provider-reported gas used: 189,775.

| Query | Before raw | After raw | Delta raw |
| --- | ---: | ---: | ---: |
| Sender USDC | 3962903485 | 0 | -3962903485 |
| Beneficiary aEthUSDC | 0 | 3962903484 | 3962903484 |
| aEthUSDC reserve USDC | 151987610826648 | 151991573730133 | 3962903485 |
| Sender allowance to Pool | 0 | 0 | 0 |

All four measurements equal the first capture. With six decimals, the wallet spends 3,962.903485 USDC and receives 3,962.903484 aEthUSDC. The one-raw-unit difference is retained. Final allowance zero-to-zero does not exclude an intermediate permit and allowance consumption.

### Kiln wrapper deposit into Morpho V1

Original transaction: `0xc46259d8064831c47c68776ca0611af75337adf8c4aee4bee5add0878b8873a7`.
Pinned parent block: 26,270,562 / `0x00cbe8bb974276f900d767a7853e0011817eeebbea1d9525e7c1fb230fd21d61`.
Provider-reported gas used: 1,413,682.

| Query | Before raw | After raw | Delta raw |
| --- | ---: | ---: | ---: |
| Sender USDC | 704323976173 | 354323976173 | -350000000000 |
| Beneficiary mstkeUSDC wrapper shares | 1151370388097 | 1481867899909 | 330497511812 |
| Wrapper-owned steakUSDC inner-vault shares | 24549620346225332293026418 | 24855185467391819293915363 | 305565121166487000888945 |
| Wrapper USDC custody | 20083625 | 20083625 | 0 |
| Inner-vault USDC custody | 6011 | 6011 | 0 |
| Morpho Blue USDC custody | 128890534855869 | 129240534855869 | 350000000000 |
| Sender allowance to wrapper | 350000000000 | 0 | -350000000000 |
| Wrapper allowance to inner vault | 0 | 0 | 0 |

USDC and wrapper shares use six decimals: the sender spends 350,000 USDC and gains 330,497.511812 mstkeUSDC shares. The wrapper gains 305,565.121166487000888945 steakUSDC inner-vault shares, which use eighteen decimals. These are distinct share assets; their quantities are not USDC valuations. Unchanged intermediate custody and final allowance values do not mean no transfers or approvals occurred during execution.

The bounded query set still omits the wrapper self-fee share balance, inner-vault fee-recipient shares, inner-vault allowance to Blue, and other market/debt positions. Complete economic coverage and security have not been established.

## Adapter and archived execution

The adapter admits only the previously unsupported `codeHash` field and checks Keccak-256 of the explicit runtime bytecode in the same provider record before passing the normalized state diff to the existing strict validator. This capture validates three such claims for Aave and five for Morpho. A provider-supplied hash agreeing with provider-supplied code proves field consistency; it is **not independent state, deployment, or source-code attestation**. The result records `independentStateAttestation: false`.

The source archive includes the engine and adapter, all shared runtime modules, the root and isolated package scopes, the isolated lockfile, and the exact installed `@noble/hashes` 2.4.0 package metadata, license, and `sha3.js` / `_u64.js` / `utils.js` runtime closure. It also retains the frozen runner and verifier. The offline verifier imports the archived engine and resolves its archived dependency; it does not require unchanged live source files or fetch packages.

## Evidence and audit scope

- Capture SHA-256: `149d80c7e421805dbc403a66acb6fb3410ea1d092876c01cc2776b52c703d86e`.
- Plan SHA-256: `d458f18ebd659998296a05283e6987f945bb54d7fe5786551abf70c9d7640f8f`.
- Raw requests, complete response bytes/text, hashes, HTTP headers, and timing are retained in `raw/001` through `raw/076` and the capture. Runtime Node/V8/platform/architecture are recorded.
- The frozen `verify.mjs` passed: archived source hashes, raw bytes/hashes, recorded engine playback results, and captured accounting. It remains unchanged.
- The same verifier also passed after copying only this report packet and the two referenced first-attempt artifacts into a temporary directory containing no live project source or installed project dependency. Both engine replays resolved the archived files there.
- The separately implemented [supplemental audit](AUDIT-NOTES.md) passed, with its deterministic [result](audit.json). It verifies exact plan/source-inventory equality, both cases in order, every recorded request/response, and an external mismatch latch that prevents engine-caught exceptions from hiding wrong playback requests. All 76 RPCs and both entire results reproduce; seven synthetic fault controls pass. These additional properties come from the supplement, not the frozen verifier alone. The supplement is evidence-integrity and archived-playback validation, not an independent EVM/state oracle.
- Supplemental result SHA-256: `7c45b68a356343000005c18a1ad4fe226c65f7b81743fc730645f6d5b83edf11`.

Run the frozen audit without network access:

```sh
node reports/standard-evm-deposits-v2/verify.mjs --capture-sha256=149d80c7e421805dbc403a66acb6fb3410ea1d092876c01cc2776b52c703d86e
```

Original receipts remain comparison references and query-role evidence, never starting state or substituted measurement values. This packet does not establish production support for all Aave/Morpho transactions, a blind-holdout result, or a comparison with Blockaid.
