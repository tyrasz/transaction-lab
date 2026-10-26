# Supplemental Aave approval → supply fixture

A usable **synthetic unsigned two-call sequence** was observed at Ethereum block 26270482, hash `0x4badf912d1bcc7f77197108544be0ab4b8cef7a94fb7a4ee1e65fda816300dc7`. The sender is `0x48c16c5652add27eddb0f896748a35fc60b8d1b4`; USDC is `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`; the approval spender and supply destination are Aave Pool `0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2`.

The [original plan](../plan.json) derives standard `supply(address,uint256,address,uint16)` from the first four unchanged arguments of the historical `supplyWithPermit` calldata. Its selector `0x617ba037` and `approve(address,uint256)` selector `0x095ea7b3` were recomputed with Keccak. The retained [primary Aave Pool documentation](../inputs/aave-pool-docs.html), originally from [Aave](https://aave.com/docs/aave-v3/smart-contracts/pool), describes the supply ABI and prerequisite ERC20 approval. This is not the original signed transaction or an original historical approval/deposit pair.

Observed sequence:

1. Fresh pinned reads show sender code `0x`, USDC balance **3962903485** raw (3962.903485 USDC) and allowance **0**. The [supply without approval](../raw/008.json) reverts with `ERC20: transfer amount exceeds allowance`.
2. The [actual approve trace](../raw/009.json) succeeds and emits Approval for that sender, Pool spender and **3962903485**. The [full diff](../raw/010.json) changes sender nonce 52→53 and one USDC allowance slot from zero to that amount. Complete overrides are constructed by the archived `buildStateOverrides`; no balance funding, invented allowance slot or discarded state change is used.
3. An [isolated query](../raw/011.json) under those exact overrides returns allowance **3962903485**. Its [diff](../raw/012.json) reports nonce53→54 and an unchanged pre-balance, independently anchored to the pinned native balance **2558093428345938830 wei**. This probe's nonce is not carried into the sequence.
4. The [unchanged supply input under complete approval overrides](raw/001.json) succeeds using **165499 gas**. Its [diff](raw/002.json) has nonce53→54 and clears the same allowance slot to zero. Committed events transfer **3962903485 raw USDC** from the sender to `0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c` and mint **3962903484 raw aEthUSDC** to the sender. The one-unit difference is retained. These are event observations, not independently queried final token balances.
5. The [final full header](raw/003.json) exactly matches the original pinned header, including all supplied header fields.

The initial packet stopped at a discovery assertion that incorrectly required the allowance query's pre-diff to contain only nonce, excluding the independently anchored unchanged balance. Its **12 calls / 35,499 bytes / incomplete status remain immutable**. A separately frozen [continuation plan](plan.json) authorized exactly the three unattempted observations above; all three succeeded, using **48,009 bytes**. Combined: **15 calls / 83,508 response bytes**, with no repeated public calls, retries, fallback providers or replacement selection.

The sequence was run only through public read-only `eth.drpc.org` RPC. No transaction was signed or broadcast. Fee fields are omitted; original signed fee settlement, independent BASEFEE/header-witness validation, independent engine execution and cryptographic state proof are outside this fixture. It is a selected development case, not a population coverage or security score. See [structured index](index.json) for exact input objects, evidence pointers and limitations, and [raw continuation](capture.json) for every request/response.

Byte-derived hashes:

- Initial capture: `e3e4e36d1433b8eb29467cdc172b0ea7efa6f3f3ca526a478aa6e42d89b99c03`
- Initial manifest: `b845a0ae70adb3f34c382fb83a2086a438dbe1540dc8f2c53a94c047fc5fe52e`
- Supplemental plan: `e11b6c05c68c5dc5334dc860ce2c94bb0ba6f4e8fb2a65108760c49c5be3a0b4`
- Supplemental capture: `ae31c207aa98e1172cf8112211d981c3abbda559622f74c18af84db72b7443e6`
- Complete actual-approval overrides: `7f20cea3604741c8ca4d36d1707d43206e80cb884af76ba83dff7f8bd96e3add`
