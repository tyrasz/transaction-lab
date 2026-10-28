# Supplemental offline audit

This separate audit verifies the immutable [synthetic capture](../evm-lifecycle-differential-v1/capture-v2/results.json). It does not alter the captured runtime, declarations, results or source inventory. The first archive preparation failure remains separately preserved; no selected execution occurred in that partial archive.

The audit binds all sixteen declared identities, the 3,879 archived source/dependency entries and 100 evidence files. It checks each durable product-result seal, exact proof/code request order and result hashes, reconstructs each declaration from its retained official input, cryptographically verifies the saved Merkle proofs, and independently applies the product's changes to a fresh full state trie. The resulting root and observed account/code/storage rows are compared with the saved full-VM result. Gas is independently calculated from calldata, creation costs, refunds and the active calldata floor.

[Verification results](verification.json) retain the exact checks and per-case roots. All sixteen product executions and all sixteen full-VM reference executions reproduce from archived sources. Product replay receives only the exact saved proof/code results, with unexpected or unused reads latched outside the engine. Original normalized limits remain exact. Only process IDs and explicitly validated elapsed durations are excluded from equality. Eight negative controls cover evidence omissions, changed seals, abnormal worker exit, mismatched proof joins, swallowed playback errors, repeated requests and gas/normalization boundaries.

The retained outcomes are fourteen successful executions and two genuine root reverts, ten finalized created-account deletions and two committed logs. All five channels agree for the sixteen fixed cases. The input adapter served 154 parsed proof/code responses totaling 65,325 bytes; these are synthetic in-memory responses, not public RPC wire observations.

Both execution paths use pinned EthereumJS opcode execution. This independently checks replay, evidence binding and sparse-versus-full-trie finalization; it is not a second independent EVM implementation, original official signed replay, public-chain observation or population accuracy rate. Transactions use declared synthetic Osaka headers, zero price/base fee and at most 5,000,000 gas. No fee, consensus, sidecar/KZG or undeclared-fork claim follows. Product-before-reference ordering is supported by the reviewed runner and saved seals, not an independent timestamp authority.

Reproduce without network:

```sh
node research/evm-lifecycle-differential-v1-audit/verify.mjs --replay
node --test research/evm-lifecycle-differential-v1-audit/verify.test.mjs
```

Plan SHA-256: `82edf8c8f06d33180ac109f61ed9247da6b596a5c618b9c2fa7ea16937fd1f86`.
Capture manifest SHA-256: `299980c26fde8c589f74922f2b00b93be6290b9acae3f69973f434f3e1f4bcf3`.
The sibling audit's own manifest seals this note, verifier, controls and verification report after replay.
