# Storage-only creation: independent EELS observation

All six unchanged v033 declarations completed once through stock EELS at
`e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e`. The adapter executed the original
signed transactions with the original Amsterdam environment and four declared
inert system accounts. No product, EthereumJS or Geth execution was repeated.
The six children took 5.621 seconds and retained 35,448 raw output bytes.
There were no unavailable/unattempted cases or runtime identity changes.

The two storage-only targets were eligible and their prior storage was cleared
before initialization. Starting with balance 17, nonce zero, empty code and
slots `0=999,991=123456`, both finished with balance 22, nonce one and slots
`0=0,1=0,2=42,991=0`. Their full final allocations match the corresponding
empty-storage controls. The previously retained Geth executions instead kept
the old storage; EthereumJS treated it as a collision. Those outcomes remain
unchanged and visible. The product's unsupported results are not predictions
and receive null comparison channels.

| Original case | EELS charged gas | Saved Geth charged gas | EELS result |
| --- | ---: | ---: | --- |
| Root storage-only creation | 175,718 | 283,638 | Deploy and clear |
| Internal storage-only CREATE2 | 178,046 | 285,966 | Deploy and clear |
| Root absent target | 359,318 | 359,318 | Deploy |
| Internal absent target | 361,646 | 361,646 | Deploy |
| Root empty-storage target | 175,718 | 175,718 | Deploy |
| Internal empty-storage target | 178,046 | 178,046 | Deploy |

The [saved-artifact comparison](comparison.json) checks seven channels:
execution status, return bytes, charged gas, single-transaction block gas,
complete state root, target account/storage, and exact logs. Four ordinary
controls match all seven channels with all three peers. The storage-only cases
match Geth on status, return bytes and logs, and differ on the other four
channels. EthereumJS differs on all seven root channels and six internal
channels. Its internal outer call succeeds while its attempted creation fails.

The comparator rebuilds six complete EELS state roots, receipt and transaction
trie roots, log hashes and receipt blooms. It verifies 31 new capture entries,
5,080 external toolchain entries and the earlier saved client packets. It
reuses the archived JavaScript MPT/RLP/parser helpers and prior artifact
verifiers; it is not a second EELS execution or an entirely independent parser.
Previous root-wrapper failures remain recorded separately from the corrected
root-wrapper supplement. Existing proof paths were not independently re-walked
by this comparison.

Five target-free runner controls passed, including actual timeout and file-size
termination with unusable packets. An initial synthetic-control path-resolution
failure is retained in `preparation/control-first-attempt.json`; it did not run
an EVM target. Seven artifact controls passed, including resealed false target
observations and substituted process arguments. Preparation logs preserve the
six exact input/signature/prestate checks and a changed-input rejection.

- Plan SHA-256: `0e74b7cf84737bb47e750404a8dd67cc12153dda5e95a2fda32f9fde5166f591`
- Capture manifest: `0e56b466ed87ee7eeaf2d656598df87123d08c0ff588f89131e06f7eb881b390`
- Toolchain identity: `5e67873833811992160173737d5c6f229dad327281e7e915ecce206cac4cb005`
- Comparison: `b09a9f2d97becf99988b4b2cd16a2a410d3b79f7d9dd4ce5f1b02287953dd6d5`

Source, virtual environment, standard library, interpreter and Python shared
library were inventoried before and after each child. They remain external
shared dependencies, not a copied runtime archive. The source is bound to its
pinned official download URL and archive hash, not independently verified Git
objects. Operating-system dynamic libraries are not archived.

These six inspected synthetic cases provide evidence for the storage-clear
implementation work. They do not establish consensus, canonical-chain
reachability, historical-fork execution coverage, finality, complete economic
effects or population accuracy. The fifteen acquired official fresh-storage
fixtures are separate controls and were not executed or counted here. The
public product continues to reject storage-only creation pending integration.
