# Historical creation and rollback — independent execution checkpoint

October 30, 2026. The fixed eight declarations were executed once per engine
against the development candidate based on `11a98230`. **All eight cases match
all seven channels: 56 matches, zero mismatches, zero unavailable channels.**
The [raw comparison](comparison.json) retains both observations and complete
reconstructed allocations. This is synthetic development evidence, not an EVM
population accuracy estimate or a release of the candidate.

The product used its archived isolated local execution path. The independent
counterpart used unmodified official EELS `apply_body` at commit
`e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e`. Both consumed the same frozen initial
allocation and environment; EELS admitted a signed type-2 transaction and the
product executed the corresponding unsigned, priced call. Neither consumed the
other's output or an expected poststate.

| Case | Final execution | Charged gas | Block gas |
| --- | --- | ---: | ---: |
| Shanghai root CREATE | success | 108446 | 108446 |
| Cancun internal CREATE | success | 109903 | 109903 |
| Prague root CREATE | success | 108446 | 108446 |
| Osaka internal CREATE2 | success | 109918 | 109918 |
| Osaka caught constructor REVERT | success | 103886 | 103886 |
| Osaka caught ancestor REVERT | success | 117561 | 117561 |
| Amsterdam root constructor REVERT | reverted | 52758 | 52758 |
| Amsterdam caught ancestor REVERT | success | 72867 | 82867 |

Each pair agrees on execution status, return bytes, charged gas, the single
transaction's block gas contribution, complete state root, complete target
account/storage and ordered logs. The last case demonstrates why Amsterdam's
block contribution must not be substituted with charged gas.

The four successful deployments retain the target's 17-unit prefunding and
5-unit endowment, set nonce one, clear the old storage namespace, and leave
slots 0=999 and 2=42. The equal-to-old write of 999 survives as a new-namespace
write. Hidden old slot 991 and the constructor's copy into slot 1 become zero.
The four rollback cases restore nonce zero, empty code, balance 17, and the
original slots 0=999 and 991=123456, with no retained storage-clear marker.
The full roots also bind fee settlement and the unrelated caller/helper writes.

## Validation and retained evidence

All 16 target processes completed. Total execution-capture time was 15.717
seconds and combined raw stdout/stderr was 436,503 bytes. Source identities,
original-write identities, exact inventory, process bounds and product child
closure passed; the capture reports `evidenceUsable: true` and `fatal: null`.
The limits were 20 seconds/8 MiB per process and 360 seconds/80 MiB overall.
There were no target retries or replacements. The sealed capture has 4,051
manifest entries; its runtime archive has 3,906 entries and 24,059,004 regular
file bytes. The separately pinned external EELS toolchain has 5,080 entries.

Before execution, all **34 offline control groups passed**. Input preparation
attempt 004 passed all 16 workers without invoking an execution entrypoint.
Independent source review covered inputs, fork-specific EELS interfaces,
projection, original-write preservation and process failure handling.

Earlier preparation records remain intact. Attempt 001 rejected an EELS input
admission conversion before execution; attempt 002 prepared the first adapter;
attempt 003 prepared the corrected gas projection and driver; attempt 004 also
binds the final execution-phase wording in the plan. None executed a target.
The earlier [handoff](HANDOFF.md) describes its original preparation checkpoint.

| Artifact | SHA256 |
| --- | --- |
| `capture/plan.json` | `8b75cf4c93e89bf8d50ca698d090214dbaf3f037c9c0a8bb03096c16f373beda` |
| `capture/manifest.json` | `62ed1a545948e1077fe1757bbcfb18bbc091c5b877b07e4b294fcb9ecac481c6` |
| `comparison.json` | `844138daa9d6c2bdf38861ddfd8092b585ee8c8e05e82d94fdf59a1eb497bab1` |
| Preparation 004 manifest | `6c8a3e34cfaf3c1ff8d5b043543c1df2ca31f7061fa5924d6d36edf06524d176` |
| `controls-final.tap` | `809234e4819972a23f1049025006f002e5d7102ec4231bc180f9380206efd824` |

The saved comparison can be reproduced without an EVM execution or network:

```sh
node research/storage-creation-forks-v035/run.mjs compare \
  8b75cf4c93e89bf8d50ca698d090214dbaf3f037c9c0a8bb03096c16f373beda \
  62ed1a545948e1077fe1757bbcfb18bbc091c5b877b07e4b294fcb9ecac481c6
```

A separate read-only review reproduced the comparison byte-for-byte, checked all
4,051 manifest files and 4,050 original ledger identities, and joined every raw
output to its process record and seal. It checked all eight child closures, the
four complete successful target states, the four restored rollback states,
sender nonce increments and fee debits, and restored caller/helper storage.
It performed no target execution or network requests.

## Scope

These eight chosen cases establish the compared behavior under the declared
synthetic fork contexts. They are not a complete cross-product of forks,
creation paths and failures. Four explicitly declared inert system accounts
make the stock block wrapper comparable; no deployed-chain state or full block
validity is claimed. EELS's own execution is independent, while the saved
allocation reconstruction uses EthereumJS trie/hash libraries. Operating-system
shared libraries are not fully archived. Process-group cleanup records signal
acceptance; product observations additionally require its closed isolated child
and zero pending broker requests.

SELFDESTRUCT, deletion, subsequent public after-state queries, complete economic
effect discovery, local API sequences, security detection and representative
public transaction coverage are outside this packet. The empty-code rollback
target does not directly observe the later behavior of a sticky creation marker.
The installed app remains 0.34.0; the development candidate is not promoted by
this result.
