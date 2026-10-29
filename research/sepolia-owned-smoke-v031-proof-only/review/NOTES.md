# Independent artifact-only review

The saved internal Sepolia preview is consistent with the retained input proofs and the declared unsigned, unpriced native transfer. The original capture remains unchanged. This review performed no network requests, EVM/client execution, signing, or transaction broadcast.

External capture manifest: `3bf80e4b389bed4c1cce7e53f9b1ef5e3c46c96159a69c622ed977fa6a31b8d4`. Plan: `7b294b0e9d8b5579483b4031e29b1083e2656c97483224a173fb08d347a35395`. Combined source identity: `f96d702e470a86aef5de91c818d39b06d17dbfb312af172b4ee60bb0ab544e41`; implementation identity: `5ea720f433a8a33cd6359db5c2c191eb16b961acf06407bbe98a9ab7411cf0bc` (reported version `0.30.0`).

The verifier rehashed all 17 listed artifacts (879,044 bytes), all 1,720 implementation entries (10,856,113 regular-file bytes, one symlink), four harness files and the Node executable. It checks file types/modes, source-inventory identities, exact raw request/response bytes and hashes, and the saved product seal before the final-header request. The captured terminal time is 2,305 ms, with no pending transport work or source-integrity failure.

The full 23-field, 678-byte Amsterdam header independently RLP-encodes to block `0x98415a8984efd30a4f416fb1c9a0a531f6f409373b99d360c5f57cdf49ac6105` (number 12,020,217). Header field order was checked against the inventory-pinned Geth Header declaration/generated encoder. No production header verifier was imported. The same provider's numbered-header reread is byte-for-byte equal to the initial retained header.

An independent secure-MPT walk verifies both account inclusion proofs against state root `0xc60fde5cd965e06cfd90d4f8f8b9e351b8ce17478bc368d529964548c713a42d`. The sender path has nine nodes and the recipient path eight. Both authenticated leaves have the empty-code hash and empty storage root. Each saved account/provenance/evidence/broker record joins its actual proof wire. `codeEvidenceId` is null and `codeDerivation` is `verified_account_empty_code_hash` for both; no code-response evidence or `eth_getCode` wire exists.

| Account | Proven initial balance (wei) | Saved simulated after balance (wei) | Delta (wei) |
| --- | ---: | ---: | ---: |
| `0x6efb29cee3b414272eb7a8f3ebabf873d36bc033` | 13135858997587481581058 | 13135857997587481581058 | -1000000000000000 |
| `0x000000000000000000000000000000000000dead` | 2716225852586137573846 | 2716226852586137573846 | 1000000000000000 |

Sender nonce changes exactly 748700 → 748701. The two complete native measurement pairs equal these independently calculated values; before/after reads add no query changes. The saved engine uses one CALL frame, zero opcodes, zero message execution gas, and total modeled gas 21,000. It retains one protocol native-transfer log; it is simulated output, not an on-chain receipt or a contract LOG opcode. The actual header base fee is 15 wei while this explicitly unpriced profile uses gas price/base fee zero and settles no fees.

Five public requests are retained: chain ID, latest header, sender proof, recipient proof and final numbered header. The sixth wire is the loopback public HTTP API attempt. All 39,604 response bytes reconcile. The API returns **400 `UNSUPPORTED_CHAIN`**, so this packet establishes internal engine behavior only; it does not establish public Sepolia API support.

`verify.mjs` uses independent proof-path/header construction and arithmetic. Its RLP and Keccak primitives are shared pinned libraries, with source identities recorded in `source-provenance.json`. No producer runner, proof/header verifier, execution validator or adjudicator is imported. The MPT walker deliberately accepts only the two retained hashed-branch/terminal-leaf shapes. It is not presented as a general-purpose verifier.

Six focused groups pass in `controls.tap`: full saved inventory/semantics; altered proof key/root/account/node facts; all 23 header fields; raw/timing/fake-code/final-header changes; broken empty-code/proof provenance; and coherently repeated nonce/value/measurement forgeries. These controls use in-memory copies only and never alter captured files. Run from the checkout root:

```
node research/sepolia-owned-smoke-v031-proof-only/review/verify.mjs
node --test research/sepolia-owned-smoke-v031-proof-only/review/verify.test.mjs
```

Limits remain explicit: membership under this header is not consensus, finality or cryptographic network attestation; a same-provider reread is not independent consensus evidence. No full post-state root, independent-client execution, on-chain transfer, settlement, wallet-key ownership, or population-wide correctness is established. Source/dependency identities were checked against current checkout files rather than a dependency archive retained here. The captured worker reports `sourceImplementationBound:false`; the enclosing harness records source identity before/after. This review does not upgrade that flag.
