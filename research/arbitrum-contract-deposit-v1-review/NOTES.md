# Independent saved-packet review

The retained provider observations are internally consistent: the declared contract sender's USDC balance falls from **13,162.457912 to 13,062.457912 USDC**, and the source events record the same **100 USDC burn**. The original call succeeds with **116,393 gas** and five logs. The API correctly reports **partial** coverage: ETH is observed as 0 → 0, while the messenger balance probe fails and remains unknown.

This review made **zero RPC calls and zero EVM executions**. It verified saved bytes and independently decoded the request, probes and events using the pinned published ABIs; it did not invoke the product or replay its simulation.

| Check | Verified result |
|---|---|
| Capture manifest | `51076d500e9176482cd530780d8077e7de57d1e689f3907122bd9e4061b086ab` |
| Frozen plan | `125fa912c2763114aa4dc16dd44179435d5685d59514ec035980482af81628ce` |
| Capture inventory | All 92 declared files; exact inventory, bytes, hashes and modes |
| Runtime inventory | 12,768 rows: 53 copied source/data files and 12,715 dependency files |
| Dependencies | All 44,055,784 bytes equal the separately retained, pinned viem research archive |
| Loader identity | Independently reconstructed all 12,753 loader files and exact `7cfec62d…fb1732e` identity |
| Wire evidence | All 10 request/response/record joins; 41,389 response bytes; recorded budgets respected |
| Header | Selection, initial read, final read and projected full header agree at `0x1ef304eb` (519,242,987) |
| Original envelopes | Both use the exact 356-byte calldata, declared sender/destination, 2,000,000 gas, value 0 and gas price 0 |
| Original outcomes | Status, return data, gas and ordered event content agree between discovery and main passes |

The two passes produce different synthetic block hashes because the main pass also includes viem's zero-address call. Each log is bound to its own returned block; that block hash is the only excluded field when comparing the two original call results. Returned successor block numbers and parent links also join. These are provider-reported relationships, not independently verified Arbitrum consensus.

The five decoded events are `Transfer` (sender → local minter), `Burn`, `Transfer` (minter → zero), `MessageSent`, and `DepositForBurn`. Each token amount is 100,000,000 base units. The packed message and deposit event agree with the request on token, sender, source domain 3, destination domain 19, forwarder recipient/caller, maximum fee 200,000, minimum finality 1,000 and the exact 56-byte hook. The hook requests this same account as recipient with dex 0. This does not establish a destination credit or an executed fee; message nonce, executed finality, executed fee and expiration are still zero placeholders.

The account `0xa95d9c1f655341597c94393fddc30cf3c08e4fce` has 6,630 bytes of saved nonempty code. It is an explicit **contract-sender scenario**. EOA admission, signing, contract authorization and ability to submit this as a real transaction were not established. Zero native balance together with zero gas price is not proof of a funded, admissible transaction. No bridge attestation, HyperEVM/HyperCore settlement, complete asset inventory or security assessment is claimed.

Source completeness is scoped precisely. The Arbitrum loader's actual static closure is fully retained and reproduces its captured identity; `engines/evm-context.js` is used by dynamically loaded Ethereum local/provider modules and is not part of this Arbitrum invocation. The packet contains those unused adapters as extra source files, not their entire dynamic engine closures. The capture is also **not standalone**: it relies on the exact prior viem dependency archive and identified local Node executable (not embedded here). Node system libraries are outside the recorded executable identity. No frozen packet was amended.

Run the artifact-only verification from the repository root:

```sh
node research/arbitrum-contract-deposit-v1-review/verify.mjs --verify
```

`verification.json` records the complete pins, derived amounts, decoded events and limitations. `manifest.json` seals this separate review's verifier, report and notes. The original capture remains unchanged.
