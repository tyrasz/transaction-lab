# Live Sepolia proof-only native transfer: completed

The third separately declared owned-engine attempt completed at Sepolia block **12,020,217**, hash `0x98415a8984efd30a4f416fb1c9a0a531f6f409373b99d360c5f57cdf49ac6105`. It used the public endpoint `https://rpc.sepolia.ethpandaops.io`, listed in the [Ethereum Lists Sepolia network definition](https://github.com/ethereum-lists/chains/blob/master/_data/chains/eip155-11155111.json). The request was unchanged from the two previous attempts: public sender `0x6efb29cee3b414272eb7a8f3ebabf873d36bc033`, recipient `0x000000000000000000000000000000000000dead`, value 1,000,000,000,000,000 wei (0.001 test ETH), empty calldata, 21,000 gas and the unpriced profile. No private key, signature, funding override or broadcast was used. The wallet's ownership is not claimed.

One actual isolated original execution succeeded. Total gas was **21,000**, consisting of intrinsic regular gas; execution regular/state gas and refunds were zero. Both explicitly requested native balances were measured:

| Account | Before, wei | Simulated after, wei | Change, wei |
| --- | ---: | ---: | ---: |
| Sender | 13135858997587481581058 | 13135857997587481581058 | -1000000000000000 |
| Recipient | 2716225852586137573846 | 2716226852586137573846 | 1000000000000000 |

The sender nonce changed from 748700 to 748701 in the simulation. Both initial accounts exist and their verified account proofs commit to empty code. The engine therefore used two actual `eth_getProof` replies and no `eth_getCode` reply; each provenance row has its real proof ID, `codeEvidenceId: null`, and `codeDerivation: verified_account_empty_code_hash`. It did not fabricate transport evidence. The parent independently reverified those proof-derived facts before retaining the result.

Five public JSON-RPC requests were dispatched: chain ID, latest header, the two exact hash-bound account proofs, then the selected full header at its original number. The final full header matched. A separate loopback request recorded the running 0.30.0 application's HTTP 400 `UNSUPPORTED_CHAIN`; **this is an internal development-engine success, not public HTTP Sepolia admission**. The complete attempt retained 39,604 response bytes including loopback, drained without pending work, and finished source-integrity checks in 2.305 seconds. The complete source inventory was unchanged.

The frozen [raw preview](capture/preview.json), [request](capture/request.json), five public wire responses and loopback response are retained with 17 files in the capture manifest. The artifact-only verifier passed without EVM re-execution or network access. Its checks cover the wire/broker joins, selected full header, proof-derived input facts, native arithmetic, execution-change consistency, source identity and fixed capture bounds. Five offline preparation controls passed, including an actual child using synthetic proof inputs and a coordinated amount forgery rejection.

The two previous owned attempts remain unchanged and unavailable: PublicNode rejected the first proof; 1RPC supplied the sender proof but rejected the subsequent code read and rate-limited the final header check. The observed development record is now **one completed live owned execution and two unavailable attempts**. These are different source/provider observations, not a transaction-population accuracy score. The earlier provider-only viem success remains a separate result.

This unpriced transfer does not include fee balance debits, signed admission, inclusion, consensus/finality, token/contract execution, complete economic-effect discovery or independent-client comparison. Amsterdam authorization preparation and the known repeated CREATE2 collision remain separate unsupported development cases. The app has not been restarted or promoted.

Capture manifest SHA256: `3bf80e4b389bed4c1cce7e53f9b1ef5e3c46c96159a69c622ed977fa6a31b8d4`.
Combined harness/runtime identity: `f96d702e470a86aef5de91c818d39b06d17dbfb312af172b4ee60bb0ab544e41`.
Implementation identity: `5ea720f433a8a33cd6359db5c2c191eb16b961acf06407bbe98a9ab7411cf0bc`.
