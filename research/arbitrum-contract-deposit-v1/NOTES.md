# Live CCTP source simulation from a public contract account

One declared read-only call completed on October 29, 2026 through the production 0.27 Arbitrum adapter, pinned viem 2.57.13 and the public Arbitrum RPC. No transaction was signed or broadcast; no funds, allowance or sender code were replaced. Only viem’s exact static-query helper override was admitted. The original zero-balance wallet experiment remains separate and unchanged.

The selected sender, `0xa95d9c1f655341597c94393fddc30cf3c08e4fce`, is a contract account with 6,630 bytes of code. The separately frozen public selection observed 13,162.457912 USDC and sufficient allowance at Arbitrum block **519,242,987** (`0x1ef304eb`). The complete qualification header matched the simulation’s selected and final headers. This is a newly constructed unsigned call, with only the original scenario’s sender and hook recipient replaced. It is not a historical replay, wallet signature, contract authorization or proof that this account could submit an outer transaction. Its observed native ETH balance was zero; the unsigned zero-gas-price profile excludes actual transaction fees and admission.

Both provider simulation passes returned **success**, **116,393 gas**, empty return data and five matching committed logs. Measured USDC changed from **13,162.457912** to **13,062.457912**, a debit of **100 USDC** (`-100000000` raw units). ETH remained zero. The messenger address’s balance getter failed and is retained as an unknown candidate, so the adapter reports **partial** coverage. The calldata decoder separately recognizes a requested 100-USDC CCTP burn and HyperCore perps routing with a 0.2-USDC maximum fee cap. It does not establish attestation, relaying, destination mint, final fees or credited balance.

- [Original input](capture/input.json)
- [Actual viem return wrapper and result](capture/viem-response.json)
- [Complete adapter response with raw RPC exchanges](capture/response.json)
- [Raw successful discovery request](capture/wire/005-request.body) and [reply](capture/wire/005-response.body)
- [Raw measurement request](capture/wire/009-request.body) and [reply](capture/wire/009-response.body)
- [Declared plan](capture/PLAN.json), [verification](capture/verification.json), and [file manifest](capture/manifest.json)

The attempt used ten RPC calls and completed in 8.443 seconds including adapter source checks. No target retry or replacement was made. Plan SHA256: `125fa912c2763114aa4dc16dd44179435d5685d59514ec035980482af81628ce`. Capture manifest SHA256: `51076d500e9176482cd530780d8077e7de57d1e689f3907122bd9e4061b086ab`. An additional offline regression replays all ten exact request bodies and saved replies through the actual adapter and requires the 100-USDC debit, ordinary success and explicit unknown messenger probe; it passes without RPC or VM execution. This development example is not a representative accuracy benchmark or independent execution oracle.
