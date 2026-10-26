# Direct USDC transfer input-state packet

The approved one-shot capture completed on **26 October 2026**, from `07:21:08.311Z` to `07:21:09.818Z` (1.507 seconds): **18 successful RPC requests, zero failed requests, zero skips/retries, 122,698 response bytes**. Each provider used nine of its maximum 102 calls. No blockchain transaction was signed or broadcast, no state was changed, and no product source was imported.

The exact original direct-A current envelope was retained: chain 999, parent block 49322024 (`0x2f09828`), hash `0xe4e17972b424a9785e111ba5cfd3fc08fc3229e074c078a99a69fd126ee10e87`, zero value, 5,000,000 gas, no fees/nonce overrides. All traces and missing-field reads use the canonical EIP-1898 hash object. This is parent-block end state, not original transaction-position replay. The source request and prior capture are hash-bound in `plan.json`.

## Recorded facts

Both dRPC and Hyperlend archive returned identical parsed full-prestate inputs and completed basic fields:

| Account | Initial nonce | Runtime code | Captured storage |
| --- | ---: | ---: | ---: |
| Zero address | 0, explicitly queried | Empty, explicitly queried | No slots recorded |
| USDC implementation `0x003f73f58ca78880da3642c5cb71d7459b3fe4f8` | 1 | 23,464 bytes | No slots recorded |
| Sender `0x2908da1b63c4f7ce001bf5d875d179930a79eed4` | 191048 | Empty, explicitly queried | No slots recorded |
| USDC proxy `0xb88339cb7199b77e23db6e890353e22632ba630f` | 1 | 1,798 bytes | Six explicit slots |

All four accounts have evidence of nonempty basic state: positive nonce, nonempty code or nonzero native balance. The zero address is funded (`0x41a3fdfad4a69fb0638a`); it was not assumed nonexistent. The sender's supplied native balance is `0x35a653daa0e6b525f`; no balance was invented to make execution possible. No explicit zero-valued storage slot appears in the packet. **Any additional slot or account remains unknown**, including storage on accounts without recorded slots.

Each endpoint's record IDs have this exact separation:

| IDs | Role |
| --- | --- |
| 1, 2, 9 | Chain ID, initial header, final canonical header |
| **3, 4, 5, 6** | **Interpreter inputs only:** full non-diff prestate; missing zero-address nonce; missing zero-address code; missing sender code |
| **7, 8** | **Comparison outputs only:** original call trace and original state diff |

The full prestate request explicitly included `diffMode:false`, `disableCode:false`, `disableStorage:false`, and `includeEmpty:true`. The packet shows what the providers returned; it does not prove their implementation honored every option for all empty accounts. The local adapter must use explicit field/slot provenance and reject uncaptured reads. Each conditional basic-field query was required by an actually omitted field, at a sorted returned address; no storage lookup, unknown address discovery, fallback, replacement or retry occurred.

Both endpoints' comparison traces and diffs agree exactly with each other and with the prior fixed current direct-A capture. Expected outputs were never used to construct state inputs. This packet alone does **not** establish successful local execution: that requires an independent interpreter run with only input records 3–6 and explicit header/envelope rules, fail-closed missing reads, isolated original-storage caches, and reconciled intrinsic gas/warm-set/nonce semantics. A future local report must keep its own engine/package provenance.

## Offline verification and limits

```sh
node reports/local-execution-state/verify.mjs --verify
```

The standalone verifier passes without network or live product imports. It verifies all request/response hashes and byte counts; the pinned plan, runner and prior-source hashes; fixed initial/final headers; exact envelopes/options; deterministic conditional request sequence; valid basic fields/code/storage; field-by-field input record provenance; and separation of input record IDs from comparison record IDs. `verification.json` reports actual quantities, bytecode-byte SHA-256 fingerprints, counts, provenance and cross-provider equality. SHA-256 byte fingerprints are integrity labels, not Ethereum Keccak code hashes or verified-source attestations.

The supplied state remains provider evidence, not cryptographic state proof. Two endpoints do not establish independent execution engines. The full prestate is sparse touched state, not a complete account storage map. This selected unpriced profile has synthetic BASEFEE zero, while the raw source header retains its actual base fee; it is not signed-transaction validation or fee prediction. HyperCore/CoreWriter, unknown ancestor hashes and unsupported execution semantics must not be silently replaced with empty state or successful stubs.

- Capture SHA-256: `8e7ca6979a894a6a4340379ef2ff875e7b398e2b48f157324d081dd319c40876`.
- Plan SHA-256: `b1c0858982f730587bdf9189c31dc8508bec0aad154050fa61984731a045d0d3`.
- Runner SHA-256: `14d1379d9c7e7f0200508e103619b7d2b1055dd29326d80797a608a62773f0e0`.

`manifest.json` is the original capture-time manifest. `packet-manifest.json` additionally seals the offline audit, pin and these notes. No further provider reads were made while auditing this packet.
