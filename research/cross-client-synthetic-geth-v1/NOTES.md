# Independent Geth check of the sealed synthetic lifecycle corpus

On October 28, 2026, Geth 1.17.10 ran all 16 preserved synthetic lifecycle
declarations once: **16 matched, 0 mismatched, 0 unavailable, 0 unattempted**.
The dispatch window was 665 ms; all children closed and source/input/tool
identities remained unchanged. All 16 retained the exact earlier preallocation,
synthetic header, message, sender nonce and signed bytes. There were no public
calls, state repairs, injected system contracts, retries or replacement cases.

The expected full roots and consensus log hashes came from the sealed full-VM
reference, previously matched by the old **0.18.0** sparse product. Geth supplies
an independent opcode implementation for these two checks. The old reference
contains 14 successful roots, two reverted constructors and two cases with
committed logs. This command does not independently check execution status,
gas, return bytes, receipt fields or detailed logs; its success means the full
root and internal log assertion agree. It is not an official fixture replay,
current-product coverage rate or five-channel comparison.

The [frozen plan](capture/plan.json), [all result classifications](capture/results.json),
[raw first output](capture/results/001.json), and
[independent offline audit](../cross-client-synthetic-geth-v1-audit/NOTES.md)
are retained. The audit verifies all 4,019 files / 27,505,731 bytes, including
3,977 archived source/input entries, the old 100 artifacts and their manifest,
and one bounded dependency link. It reconstructs every wrapper from the
archived declarations and independently adjudicates the 6,242 raw output bytes.
All nine audit controls and 19 adapter/runner controls pass. Root repeated the
audit and its controls without rerunning Geth or either VM.

- Frozen plan: `56e229305134c64d13398b64060d69a4d9ce2bc8e835485d05e7ac96b1325805`
- Source manifest: `42330c8e7f59f0ddf6c219c6995c30a858d4006c8afc0aafff130938bac58367`
- Results manifest: `f0a34e060f47977b5e61e3b884494c41dc8dc131dbb3701e3a7245b5049d6508`
- Audit manifest: `abe4b61c7f4a9ae6a70920d6288dc9db1690a482e821bd804c985ae29c3193ab`
- Old synthetic corpus manifest: `299980c26fde8c589f74922f2b00b93be6290b9acae3f69973f434f3e1f4bcf3`
- Geth executable: `10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521`

Compatibility is limited to the declared corpus: no scanned initial or recorded
created code contains BLOCKHASH/BLOBHASH/BLOBBASEFEE, and the zero-fee coinbase
touch leaves the initially absent coinbase absent. These checks do not establish
general equivalence between Geth's state-test context and the product's context.
The exact binary and Node runtime remain external dependencies of the archive.
