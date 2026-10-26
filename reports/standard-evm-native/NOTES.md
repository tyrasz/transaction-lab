# Native ETH development capture — v0.11.0

All three fixed requests returned HTTP 200, successful execution and `canonicalStatus: "verified"`. The single run used **79 read-only RPC calls / 368,652 response bytes**, with no retries, replacements, transport failures or recorded boundary violations. This is a development regression packet of three selected examples, not a population sample, a 90% coverage result, a security score or a Blockaid comparison.

| Fixed case | Pinned block end | RPC calls | Response bytes | Measured native accounts | Measured token queries |
| --- | ---: | ---: | ---: | ---: | ---: |
| [Native transfer](native-transfer-response.json) | 26277080 | 15 | 65,692 | 2 | 0 |
| [Swap with internal ETH payment](internal-eth-swap-response.json) | 26276082 | 34 | 204,773 | 2 | 4 |
| [Aave control](aave-no-native-response.json) | 26270482 | 30 | 98,187 | 0 | 4 |

The [plan](plan.json) fixed these inputs before the run. The native input comes from the separately retained [discovery index](inputs/native-index.json) and [raw discovery capture](inputs/native-capture.json): original transaction `0xe3310b67e3d47ab97dbe6148b933d9568a1b5819cb649b6cc790cd0b011f49bc`, source block 26277081, index 5. Its parent is `0x6e2f11a0daf8cc18df88266db83ae7955d5f947c41cf9ad4befd8d43fa10dda3`. The original from/to/data/value were retained; only the API's value representation changed losslessly to decimal `82848000000000000`. Swap and Aave API inputs exactly match the archived [v0.10 swap](inputs/swap-response.json) and [v0.10 Aave](inputs/aave-response.json) requests. All three use the engine's fixed gas limit of 5,000,000.

The native transfer moves **0.082848 ETH** between two accounts whose code was empty at the pinned state. The swap's root value is zero, but its contract makes a successful internal CALL for **0.000833321237492342 ETH**. These amounts are independently present in the before/after BALANCE return words and original pre/post balance fields, not merely inferred from the trace's requested value.

| Case / account | Before, wei | After, wei | Change, wei |
| --- | ---: | ---: | ---: |
| Native sender `0xc0cb2ec9964f44621d867cdd4331a0541589fb93` | 82911000000000000 | 63000000000000 | -82848000000000000 |
| Native recipient `0x43b719b9c6cf849dca549765ba1af00f3dfc4ac1` | 42883012001732692514 | 42965860001732692514 | +82848000000000000 |
| Swap contract `0x51c72848c68a965f66fa7a88855f9f7784502a7f` | 148806357832870076845 | 148805524511632584503 | -833321237492342 |
| Internal recipient `0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97` | 7155873616174246236 | 7156706937411738578 | +833321237492342 |

The swap's token accounts are the swap contract above and pool `0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640`. The external sender is a different address; no ownership of these contract assets is inferred. The four token query identities and their exact status/before/after/delta values match v0.10 **4/4**:

| Token / account | Before, raw units | After, raw units | Change, raw units |
| --- | ---: | ---: | ---: |
| USDC / swap contract | 9597601246724 | 9584058730714 | -13542516010 |
| USDC / pool | 58649970174792 | 58663512690802 | +13542516010 |
| WETH / swap contract | 5234210030040334873484 | 5240011906271617850838 | +5801876231282977354 |
| WETH / pool | 9664575620385650038431 | 9658773744154367061077 | -5801876231282977354 |

Aave's four identities and exact values likewise match v0.10 **4/4**. Here the sender is `0x48c16c5652add27eddb0f896748a35fc60b8d1b4`, the aEthUSDC token/reserve address is `0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c`, and the allowance spender is Pool `0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2`.

| Aave query | Before, raw units | After, raw units | Change, raw units |
| --- | ---: | ---: | ---: |
| Sender USDC balance | 3962903485 | 0 | -3962903485 |
| Sender aEthUSDC balance | 0 | 3962903484 | +3962903484 |
| Reserve USDC balance | 151987610826648 | 151991573730133 | +3962903485 |
| Sender USDC allowance to Pool | 0 | 0 | 0 |

The one-unit difference between transferred USDC and measured aEthUSDC is preserved. Final allowance zero does not erase the intermediate permit/consumption. Aave reports native status `none`, zero candidates and no native measurements; that is not a claim that original signed gas fees were zero. Token labels are reference metadata; raw values and exact token/query addresses remain authoritative. The WETH preview still has no label/decimals metadata attached in this packet.

An independent offline inspection recomputed all **59 manifest file hashes**, the 32-file implementation fingerprint, all 79 request/response hashes and byte counts, and exact HTTP-to-API JSON equality. It checked all 16 token query return words and eight native BALANCE words against the reported values, native pinned balance anchors and original diff balances, full initial/final header equality, and the absence of state overrides on each original execution. Previous token rows were joined by exact `{to,data}` query identity, rather than by ordinal or an expected amount supplied as input. The separate [verifier](verify.mjs) provides the broader archived-source replay and proof validation; this note does not substitute for its result.

All originals execute without funding overrides. Measurement queries use isolated witness code and the complete observed poststate overrides, which is distinct from adding funds to make the original call succeed. The profile omits outer signature/fee settlement and executes with synthetic BASEFEE zero; `feeScope` is `excluded`. The internal ETH CALL is an observed value transfer, not an asserted gas charge. These are independent unsigned simulations at historical block ends, not original-position signed replays or a sequence carrying simulated state between transactions. Provider consistency is not an independent execution engine or cryptographic state proof, and unselected/unsupported effects remain outside the measured scope.

Exact bytes are retained in [HTTP 001](http/001.json), [HTTP 002](http/002.json), [HTTP 003](http/003.json), the three linked raw API JSON responses, and [independent RPC snapshots](rpc-evidence.json). [Results](results.json) and the [manifest](manifest.json) preserve the entire attempted set. This note is supplemental and leaves that sealed inventory unchanged.

SHA-256 values recomputed from bytes:

- Plan: `ba57bd952efd6bef3ac50d09a7969241666506b57498f6566a178f13399bb908`
- Implementation v0.11.0, 32 files; archive 38 files: `5e915486d876ad4bab26490ec807c599b5a5bb1df683481bebffa2adb71e9c60`
- Manifest: `75ba63b9da1d90f31346e518908bff8c69aad76bcdf910669d371349758e5d70`
- Results: `2af1ac49d5db0842e1c1b016dd2ca4c083ef4684e3edc629fc78df587627612f`
- Native discovery capture: `59cf2cc3d92100ca62f9b13e69386ce4386bf308ca40f595904e9aab013a6b5c`
