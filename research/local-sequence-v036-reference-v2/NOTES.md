# Corrected fixed sequence comparison

This separate October 31, 2026 development packet repeats the four immutable
inputs from the [first capture](../local-sequence-v036-reference/NOTES.md).
It retains **four sequences / twelve declared positions**: approve, deposit
and withdraw under Osaka and Amsterdam, plus the corresponding two sequences
whose middle deposit reverts. These are synthetic token and one-to-one vault
programs, not deployed Aave, Morpho, Hyperlend or ERC-4626 contracts.

All eight product/reference processes completed their bounded capture with
usable evidence, no fatal error and unchanged sources. The saved comparison
reports **10/10 mutually completed positions matched on all 60 channels**:
execution status, return bytes, charged gas, ordered committed logs, complete
poststate root and single-transaction block gas. Eight executions succeeded
and two reverted. The two later positions were not attempted on either side;
their **12 channel values remain null**, not matches. No measured mismatch or
stop-disposition disagreement was recorded. The execution-and-verification
interval was 8.400 seconds and retained process output was 856,555 bytes;
final artifact sealing and delivery are outside that interval.
These are the frozen comparator's saved results; the separate independent
audit of this completed capture is pending.

The first packet remains unchanged: four product observations, four EELS
adapter failures before transaction execution, and a frozen comparator that
withheld all product projections. Its original comparison has zero comparable
positions and 72 unavailable channels. V2 corrects only two adapter semantics:
funding arithmetic converts EELS numeric wrappers to Python integers, and
omitted storage on nonce/balance-only delta rows means no storage writes.
Explicit non-array storage and duplicate slots are still rejected. Sibling
paths and provenance records are updated separately. All four serialized
declarations are byte-identical to the first packet; repeats are not additional
population coverage.

The producer's 36 input/artifact/inert-driver controls passed before capture.
Independent bounded review passed 21/21 input/artifact controls, including
typed funding boundaries, exact input joins and the first capture's saved
product shapes, without client execution. All eight preparation processes
passed before the separate freeze and target dispatch. The archive binds
3,911 source/dependency entries and the unchanged 5,080-entry EELS toolchain
inventory. All product workers were sealed before reference workers ran.

Pins:

- Plan: `a1df7fb169e89826b0a27e4dd4e83796b5c0fb9dbafba48c7821676d5bf88da4`.
- Capture manifest: `402045e7a4b5e69d51a7956e66fab4e6b0b71204b65430a310929db748e9f270`.
- [Saved comparison](../local-sequence-v036-work/reference-v2-comparison.json):
  `1e17eddb695225216373230a839cee9dbe8616ff6fd28318d127df95254bb735`.
- Toolchain manifest: `3c69ebf10c2650c6f5ad29bcc7bf738766f72fd9b7ff01424f3cc2227b3aca19`.
- [Peer preparation review log](../local-sequence-v036-work/reference-v2-peer-review.tap):
  `dd4d0b6386f35271227ff7019efec2cd56bbf6906c2d28544136cecdaa6d583a`.

Queries are retained but excluded from these channels. Stock EELS runs signed
type-2 transaction transitions with a fresh transaction context at each step,
carrying its own full allocation under the same declared environment. The
product runs the corresponding unsigned priced sequence. This is not a
cumulative block-capacity or consensus block replay. Complete allocation roots
are reconstructed separately; initial proof checks reuse the production proof
verifier and do not constitute a second proof implementation.

This narrow synthetic agreement does not change the public 16-call accuracy
sample or establish representative EVM accuracy, full effects/security coverage,
or real-protocol sequence correctness. Installed release **0.35.0** is unchanged;
browser visual review and release remain pending. No public network, wallet
signature or broadcast was used; reference signatures use the public fixture key.
