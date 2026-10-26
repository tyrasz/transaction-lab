# Selected Ethereum USDC deposit examples

Two real successful transactions are frozen for development in [`selected.json`](../../reports/standard-evm-discovery/selected.json). They use public wallets and require no signer. No simulation was performed during discovery. These intentionally selected historical examples do not establish general accuracy or a prospective success rate.

| Case | Actual transaction | Historical deposit | Receipt position |
| --- | --- | --- | --- |
| Aave V3 `supplyWithPermit` | [`0x6166280a…3bb130b2`](https://etherscan.io/tx/0x6166280a62cdad28e7b8af05ebb622b42b61deff981b3b6cd83dc03b3bb130b2) | 3,962.903485 USDC | Block 26,270,483, index 9, 2026-10-25 15:06:59 UTC |
| Kiln wrapper → Morpho Vault V1 | [`0xc46259d8…8b8873a7`](https://etherscan.io/tx/0xc46259d8064831c47c68776ca0611af75337adf8c4aee4bee5add0878b8873a7) | 350,000 USDC | Block 26,270,563, index 155, 2026-10-25 15:22:59 UTC |

Both are Ethereum mainnet, chain ID 1, zero-native-value type-2 transactions with empty access lists. Full original envelopes, calldata, receipts, blocks, parent headers and response-body hashes are preserved. PublicNode supplied the envelopes; dRPC supplied the receipts, selected block/parent headers and canonical parent metadata reads. These are different public endpoints, not proven independent execution engines.

## Aave V3

- Sender and aToken beneficiary: `0x48c16c5652add27eddb0f896748a35fc60b8d1b4`.
- Pool and USDC spender: `0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2`.
- Underlying USDC: `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`, six decimals.
- Receipt/custody contract: `0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c`, `aEthUSDC`, six decimals.
- Parent state: block 26,270,482, hash `0x4badf912d1bcc7f77197108544be0ab4b8cef7a94fb7a4ee1e65fda816300dc7`.

The exact call uses `supplyWithPermit`, selector `0x02c205f0`, amount `3962903485`, beneficiary equal to sender and referral code zero. Preserve the entire recorded signature/calldata. Parent-state reads observe USDC balance `3962903485`, owner→pool allowance zero and empty sender code. A zero starting allowance is compatible with this permit-based transaction; it must not be interpreted as a known simulation failure before execution.

The successful original receipt contains the USDC approval, USDC transfer into aEthUSDC custody and aEthUSDC mint. The receipt mint is `3962903484`, one raw unit below principal. This is an observed event discrepancy, not a measured simulated balance delta. Use `balanceOf` measurements for the resulting position; do not substitute principal or mint-event values for them.

Primary attribution: [Aave address book](https://raw.githubusercontent.com/bgd-labs/aave-address-book/main/src/AaveV3Ethereum.sol) identifies the pool, underlying and aToken; [Aave Pool documentation](https://aave.com/docs/aave-v3/smart-contracts/pool) documents supply and permit supply. Parent-state aToken metadata and `UNDERLYING_ASSET_ADDRESS()` agree with these identities. Exact source snapshots are recorder entries 4 and 28.

## Morpho through Kiln

- Sender and outer-share beneficiary: `0x44c3a96181af9e295ce8e188fa8fcdd72d1eb668`.
- Actual transaction target: Kiln wrapper `0x334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b`, **Yield Bearing Steakhouse Morpho USDC**, `mstkeUSDC`, six decimals.
- Inner Morpho V1 vault: `0xbeef01735c132ada46aa9aa4c54623caa92a64cb`, **Steakhouse USDC**, `steakUSDC`, eighteen decimals.
- Observed underlying-market recipient: `0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb`.
- Parent state: block 26,270,562, hash `0x00cbe8bb974276f900d767a7853e0011817eeebbea1d9525e7c1fb230fd21d61`.

The user calls `deposit(uint256,address)` on Kiln, selector `0x6e553f65`, amount `350000000000`, receiver equal to sender. The original receipt shows USDC moving sender→Kiln→Steakhouse V1→the underlying market. The sender receives `330497507296` raw outer shares; Kiln receives `305565116254166495401072` raw inner shares. Additional inner fee shares and outer self-minted shares are preserved separately in the receipt. This is not a direct user Morpho Blue position or a Morpho V2 vault deposit.

Parent reads observe sender USDC balance `704323976173`, owner→Kiln allowance `350000000000`, and Kiln→inner-vault allowance zero. The original receipt includes the inner-vault approval during the deposit. Both `asset()` getters return USDC. Empty sender code was observed at the same parent hash.

Primary attribution: [Kiln's own Ledger plugin specification](https://github.com/kilnfi/app-plugin-kiln-v2/blob/develop/PLUGIN_SPECIFICATION.md) names the outer deployment; [Morpho's official vault API documentation](https://docs.morpho.org/developers/api/morpho-vaults/) and [public V1 configuration](https://api.morpho.org/v0/vaults-v1/1:0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB) identify the inner vault as version 1.0 with USDC underlying. The [MetaMorpho source](https://raw.githubusercontent.com/morpho-org/metamorpho/main/src/MetaMorpho.sol) describes its ERC-4626 behavior. Snapshots are entries 7, 15, 27 and 29. Entry 30 preserves Blockscout's verified `VaultBeaconProxy` source and current implementation attribution; it does not prove the implementation at the historical parent block.

## Replay boundary and evidence limits

The proposed next call is a hypothetical unsigned execution from the canonical parent end state, using unchanged original calldata. The parent state excludes preceding transactions in the deposit's original block. It is therefore distinct from reconstruction at the original transaction index, and its outputs need not equal historical receipt values. Permit validity, protocol interest, fees and implementation behavior must be checked in the actual chosen execution context. No signature rewrite, invented balance, approval override or expected-output repair is authorized by this discovery packet.

The two cases were frozen before simulation. Earlier inspected envelopes, rejected archival requests, and the unsuccessful Morpho V2 lookup remain recorded. Discovery used 52 bounded recorder requests (46 HTTP successes, three HTTP errors, three initial transport failures), 996,728 response bytes, and no simulation/signing/broadcast calls. Ten separate web-search/open targets supported source research; counting them also remains below the 80-request ceiling. All failures remain failures, not empty results. Run `node reports/standard-evm-discovery/verify.mjs` to verify bytes, identities, metadata reads and deterministic selection offline.
