# Saved provider observations

This saved-only extraction confirms six provider-reported successful originals and 39 measured before/after queries (78 getter trace halves). It verifies the externally pinned capture inventory, exact raw response joins, source-header witnesses, cumulative original state overrides, nonce-only query mutation diffs, and ABI-decoded amounts using archived shared validation helpers. No VM, provider, network, retry, or target was executed. The capture remains unchanged.

Both local runs stopped at their first `eth_getProof`: raw RPC error `-32000`, “historical state … is not available”. Therefore all 30 original and 117 query comparison channels remain unavailable. The provider values below are not independent agreement with the local simulator and do not establish its accuracy for these sequences.

| Sequence | Block | Approve gas | Deposit/supply gas | Withdraw gas |
|---|---:|---:|---:|---:|
| Aave USDC | 26,270,482 | 55,570 | 165,499 | 350,023 |
| Morpho/Kiln USDC wrapper | 26,270,562 | 35,670 | 1,413,682 | 1,487,368 |

Gas is the provider's retained callTracer/API reported charge under the unsigned, unpriced 5M-gas call profile; no receipt was independently reconstructed. Getters use 300k gas between originals. These are repeated calls at saved block-end state, not signed replay at historical transaction positions.

| Provider-only balance/allowance (raw integer units) | Initial / after approval | After supply/deposit | After withdrawal |
|---|---:|---:|---:|
| Aave sender USDC | 3,962,903,485 | 0 | 1,981,451,742 |
| Aave sender aEthUSDC | 0 | 3,962,903,484 | 1,981,451,742 |
| Aave sender → pool USDC allowance | 3,962,903,485 after approval (initial 0) | 0 | 0 |
| Morpho sender USDC | 704,323,976,173 | 354,323,976,173 | 529,323,976,173 |
| Morpho sender wrapper shares | 1,151,370,388,097 | 1,481,867,899,909 | 1,316,619,144,002 |
| Morpho sender → wrapper USDC allowance | 350,000,000,000 (already present initially) | 0 | 0 |

The one-unit difference between Aave's supplied amount and the queried aToken balance increase is retained. The Aave withdrawal amount is floor-half of deposited underlying: 1,981,451,742 raw USDC. Morpho withdraws 175,000,000,000 raw underlying after depositing 350,000,000,000; its minted/burned wrapper-share amounts differ from underlying amounts and must not be labelled USDC.

`provider-observations.json` retains all declared query values, exact before/after return bytes, per-side raw trace and mutation paths/hashes, source block identities, and both raw proof errors. It also preserves Aave account-data values without claiming their oracle currency/scale, and Morpho Blue inner-vault position shares without attributing them directly to the sender. Contract custody and wrapper-owned vault shares remain separate from sender balances. Initial sender nonce/balance/code came from provider reads, not state proofs; public-chain state completeness, consensus authentication, independent execution, and all economic effects are not established.

External capture plan: `727d4a3fe8dfa7901323cf9f7b4d09518c232c448eabddfb7f7b81c113ce5cad`.

External capture manifest: `1a414e70a04610bb8e7b784f97ce2edb2773ef07e40205c7a8edb8d533ea85ea`.

`provider-observations.mjs` SHA-256: `81eaeb68032baed56ae331259cfb3668b75b499c993c47a046cee34b61f827e6`.

`provider-observations.json` SHA-256: `43b010271ff1b44ad70922ced07291c3010be17d552754e97c38434a0c8b4fd4`.

`provider-observations-stderr.txt` SHA-256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

