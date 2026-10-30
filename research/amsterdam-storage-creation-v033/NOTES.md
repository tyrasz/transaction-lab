# Storage-only creation diagnostic

This packet compares six fixed synthetic Amsterdam inputs across the product,
the shared EthereumJS library, and pinned Geth. The original capture is immutable.
Its manifest SHA-256 is
`0de3a42d8fc949ffe1a3b65f99b9d7bbee677a5c205cf45b696b9e2ca19403b9`,
plan SHA-256 is
`f5ce939bf9238d1ff52e5a22ff2596459e82faa67da053f6758c864f68ed69fe`,
and source identity is
`8d5c2e8dfa1ab8229a194ad5fc616f1bbf68cacc863cd36c46234476ba705444`.

The product completed two internal CREATE2 controls and returned unsupported for
internal creation at the account with zero nonce, empty code and nonempty
storage. The unsupported result retained no state changes and restored the
original state root. It is withheld from execution comparisons.

For that storage-only internal case, EthereumJS and Geth both completed the
outer CALL successfully, but differed on return bytes, charged gas, block gas,
final state root, target account and logs. Geth deployed the contract and
preserved its old storage; EthereumJS rejected the creation. The absent-account
and empty-storage internal controls agree across all three implementations on
all seven recorded comparison channels. Agreement on selected controls does not
resolve the disputed storage rule or establish general transaction accuracy.

Three root CREATE inputs failed in each Node wrapper before entering either
the product or EthereumJS target. The wrapper compared the JSON-loaded input
with a declaration containing an own `to: undefined` property, which JSON
serialization omits. All six exit-1 records, empty stdout streams and full
assertion stderr streams remain in the capture. The driver's literal
`dispatch_started` error is preserved; dispatch is not evidence of target entry.
These three product and three EthereumJS observations remain unavailable.

Geth produced observations for all six inputs. Its root storage-only case also
deployed while retaining old storage. Original Geth observations can be joined
to a separately declared wrapper correction, but do not turn the failed
original Node observations into successful executions.

The complete bounded attempt took 8.133 seconds and retained 272,689 raw output
bytes. Source and saved-output integrity checks passed; the packet's
`observationsUsable` flag describes intact evidence, not availability or
correctness of every observation. No public RPC, funding, signing service or
broadcast was used. The signed comparison inputs use a public synthetic key.

EELS was not installed or executed. Source findings and their limitations are
retained in [SOURCES.md](SOURCES.md), including the unavailable pinned
state-tracker fetch and the explicitly unpinned source inspection. No client is
selected as the consensus winner by this diagnostic.

The [artifact review](review-NOTES.md) reproduces all saved classifications,
including the unavailable workers. It verifies 180 capture entries, 64 runtime
entries, 3,841 dependencies, all 18 process records, six signed inputs and
headers, 24 full state roots and 17 joined input replies. The final report is
[review-final.json](review-final.json); six fabricated tamper controls passed.
The earlier reviewer schema failure remains separately retained. This review
made no network requests and executed none of the transaction targets.

The separately frozen [root supplement](../amsterdam-root-creation-v033/NOTES.md)
ran only the three missing root inputs after correcting the declaration
serialization assertion. It reused these original Geth observations without a
Geth rerun. The two root controls agree on all channels; the storage-only root
case remains unsupported in the product and differs between EthereumJS and
Geth on all seven channels. Those supplemental results do not replace this
packet's original unavailable classifications.
