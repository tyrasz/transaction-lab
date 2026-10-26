# Independent affected-account balance readings

Captured October 26, 2026, 02:37:09–02:37:10 UTC. This is development reference evidence for two previously inspected transactions, not a holdout, general coverage result, security assessment, or independent execution-engine evaluation.

The run completed **48 read-only dRPC requests**, including exactly **28 balance evidence requests**: a `balanceOf` call trace and its query-state diff, before and after, for each of seven token/account pairs. The other 20 requests establish chain/receipt identity, original-position replay, original state/runtime evidence, original headers, and final canonical binding. The authorized ceiling was 60 requests; no retries, fallback providers, replacements, or additional cases were used. Response bodies total 422,727 bytes. Timing is capture metadata, not a latency benchmark.

## Measured values

Every number below is a USDC raw integer returned by `balanceOf` at the original transaction position. Six decimal places apply. Delta is exact subtraction of those two returned words; neither starting balance nor final balance was inferred from Transfer events or the product analyzer.

| Case and account | Before raw | After raw | Delta raw |
| --- | ---: | ---: | ---: |
| Router submitter `0x0c71073344e27e33cb57fcb587fc412d689dfd1d` | 50000000 | 25000000 | -25000000 |
| Router `0x693f12e9e6b35b34458793546065e8b08e0299d6` | 0 | 0 | 0 |
| Router participant `0x04de1ef694923844bae419d4f832196f21767f86` | 4099157892 | 4123970196 | 24812304 |
| Router participant `0x7fe37fc2f987eb981a0fc63cf1eabf04463550d4` | 64258987719 | 64258987915 | 196 |
| Router participant `0xb4894380282533a86cb241145fac54aaac995f18` | 11356529011 | 11356716511 | 187500 |
| Direct-A owner `0xfc1bdd1ff58200761d56ccbce73f6f42ebe56379` | 1541542 | 264475 | -1277067 |
| Direct-A submitter/recipient `0x2908da1b63c4f7ce001bf5d875d179930a79eed4` | 4647557042700 | 4647558319767 | 1277067 |

The router's 0 → 0 result establishes unchanged final balance for that pair. Its saved trace still contains intermediate receipt/spending; zero net does not mean inactivity.

- Router transaction `0x9dba139e63627a8f3693b9a63ff556f89a5358c2603738f6d98172b7ddd3074d`, block 35204283, hash `0xc4e624b4a34acf2b15115aff40a699d95807ed66d32e86209f1a360f48302117`, before index 0 / after index 1.
- Direct-A transaction `0xe2f9761a3fac3ba83ee15fc5e6f12b55d15cd804b321a2cffd9d2c16d6c38dfe`, block 49322025, hash `0x423e4d0311decaa1e0c1d452905059c1409fcd68e1aa94d78978756e845bbac5`, before index 0 / after index 1.
- Token: `0xb88339cb7199b77e23db6e890353e22632ba630f`; queried USDC implementation: `0x003f73f58ca78880da3642c5cb71d7459b3fe4f8`.

## Validation and reproducibility

[capture.json](capture.json) retains each exact JSON-RPC request, response text, parsed response, response SHA-256, HTTP status, timestamps, and case attribution. It also retains the frozen context's validation evidence. [oracle.json](oracle.json) contains the seven reference pairs and the capture hash. The original transaction/receipt/trace input artifacts are referenced and hashed; fresh receipts matched the saved originals.

The [frozen manifest](frozen-context-manifest.json) identifies exact copies of `historical-state.js`, `state.js`, `rpc.js`, and `config.js`. These four files are the complete local dependency closure for this query transport. They were copied before the new affected-balance implementation and do not import the analyzer or that new measurement module. Concurrent core changes cannot affect this capture.

The frozen context verifies:

- Block hash, number, timestamp, canonical transaction list, and original index.
- Original replay against the historical semantic trace and receipt logs/gas. Input-gas annotations are explicitly excluded from this comparison; per-frame gas used is compared. This is not byte-for-byte full-trace equality.
- Original block header witnesses at both positions: number, timestamp, gas limit, base fee, prevRandao, beneficiary, chain ID, and parent hash.
- Original runtime presence and bounded state diffs; unsupported lifecycle/code changes fail closed.
- Each query's root/DELEGATECALL shape and expected USDC implementation; exactly one uint256 return word; no query token storage/code mutations.
- Expected sender nonce at each original position and exact query native gas charge/beneficiary tip; final canonical recheck.

From `outputs/transaction-lab`, run `node reports/affected-balance-validation/capture.mjs --verify`. This makes **no network calls**: all 48 requests must match the recorded sequence and parameters, response hashes must agree, and the frozen validator must reproduce every recorded balance/result. The offline run passed. `--capture` is guarded against overwriting the existing capture; do not rerun it as a retry.

The transport and validation adapter are shared with the product's historical-state implementation. These are independent **state-query observations**, not an independently implemented oracle, independent node, or independent execution client. Only dRPC was queried; no state proofs or fresh compiler-to-runtime verification were obtained. The saved original trace and these queries therefore share possible provider and adapter failure modes. This scope is USDC balances only, not allowances, native assets, all router assets, or caller intent.

## hUSDC expansion caution

The saved [verified AToken source](../permission-discovery/sources/husdc-AToken.sol) and [standard compiler input](../permission-discovery/sources/husdc-standard-input.json) establish a nonlinear scaled-balance model. Their provenance and hashes are in the [source manifest](../permission-discovery/sources/manifest.json); the source was previously retrieved from [the deployed implementation](https://hyperevmscan.io/address/0x410aa1ab680b886c875e99a7a4bfaf188508a7a3#code). This review made no fresh source requests and did not recompile it.

For scaled balance `s`, liquidity index `I`, and `R = 10^27`, `balanceOf` returns `floor(s × I / R)`. The index comes from `POOL.getReserveNormalizedIncome(USDC)` at the query's own state and timestamp. `TokenMath.getATokenTransferScaledAmount(m, I)` uses `ceil(m × R / I)`. Consequently, sender loss and recipient gain need not equal the requested/event amount, nor each other. As a pure arithmetic illustration (not a live transaction), `I = 1.1R`, sender scaled balance 10, recipient scaled balance 0, and requested raw amount 1 produce scaled transfer 1: sender balance 11 → 9 and recipient 0 → 1.

The AToken transfer path also emits Mint/Transfer interest recognition using each user's prior index. That recognized interest can already be included in the independently queried pre-transaction balance. Adding it again to the transfer-event net double counts it. hUSDC `transferFrom` allowance consumption uses the sender's actual rounded decrease, capped by the available allowance after checking the requested amount; maximum uint256 has separate unchanged-allowance behavior.

For generic hUSDC accounts, preserve exact before/after `balanceOf` results with the verified pool/implementation query path and original header context. Do not require delta equality with Transfer net, assume equal sender/recipient magnitudes, or infer balances/allowance consumption from the request. A receipt-token delta remains a lending-position change. The two live cases above contain USDC queries only, so they do not empirically validate a generic hUSDC adapter.
