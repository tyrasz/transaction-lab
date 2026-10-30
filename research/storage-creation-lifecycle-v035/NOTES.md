# Storage creation, destruction and disposable queries

The eight fixed original transactions match the unmodified official EELS
reference on **8/8 cases and 56/56 channels**. Query comparisons contain
**221 matches, zero mismatches and 11 unavailable channels out of 232**.
All unavailable channels remain in the denominator. This is synthetic
development evidence, not a public transaction accuracy estimate or a release.

The originals compare execution status, return bytes, charged gas,
single-transaction block gas, full poststate root, complete target state and
ordered committed logs. Full allocations include sender fees/nonces, the
factory, fee recipient and all declared storage, including untouched slots.
The product allocation is reconstructed from its deltas, independently of
the reference allocation. Query validation separately checks signatures,
snapshot roots, environment, receipts, logs, gas and state neutrality.

| Case | Fork / behavior | Charged gas | Single-transaction block gas |
| --- | --- | ---: | ---: |
| 001 | Shanghai constructor destroys itself; target receives fees | 107,611 | 107,611 |
| 002 | Osaka constructor destroys itself; target receives fees | 107,611 | 107,611 |
| 003 | Amsterdam constructor clears itself; target receives fees | 257,351 | 195,840 |
| 004 | Amsterdam constructor sweeps to an absent beneficiary; target later funded | 462,089 | 379,440 |
| 005 | Shanghai deployed contract destroyed by disposable getter | 103,044 | 103,044 |
| 006 | Osaka fresh getter calls previously deployed destruction runtime | 103,044 | 103,044 |
| 007 | Amsterdam fresh getter calls previously deployed destruction runtime | 255,450 | 198,900 |
| 008 | Amsterdam query creation with caught rollback versus retained changes | 269,220 | 212,670 |

Cases 001 and 002 leave the target absent, including after fee settlement.
Case 003 clears nonce, code and storage while retaining 772,075 wei. Case 004
leaves 1,386,270 wei at the cleared target and 22 wei at the newly funded
beneficiary. Cases 005–008 leave the original target deployed with 22 wei,
slot 0 equal to 999 and slot 2 equal to 42; the old hidden slot is gone.
Constructor logs retain the actual hidden-slot read, preventing final deletion
from concealing whether initcode observed the cleared namespace.

## Query findings and missing observations

There are 27 query descriptors: 22 native balances and five contract queries.
All 27 admission decisions agree. Twenty-five descriptors provide measured
before/after values; two are correctly withheld as state-changing queries.

- In 005 the getter returns 42 before and after the original. The after getter
  destroys the target under Shanghai, so its value is withheld. Both execution
  halves remain comparable, but the value comparison is null.
- In 006 and 007 the fresh getter really executes the target's self-beneficiary
  SELFDESTRUCT. The target is preexisting in that invocation; the final state
  remains neutral apart from the query sender nonce. The value 42 is measured
  in both snapshots. A matching constant alone does not establish reachability.
- In 008 the first getter creates and destroys Q inside a helper that reverts.
  Its outer call catches the revert and returns 42. The query is neutral and
  measured. The second getter retains the helper's changes and is withheld.
  Its after half is not attempted by the product. EELS independently executes
  both halves from its own snapshots; the missing product half stays null.
- Native reads after these disposable queries still use the original snapshots:
  Q remains 17 wei and T changes from 17 to 22 wei in 008. Query changes do not
  leak into later measurements or the original result.

The eleven null channels are the two withheld value comparisons plus nine
execution/state channels for 008's skipped retaining after-query. They are
neither passing value predictions nor execution mismatches. Nine of ten
declared contract-query halves ran in the product; all ten ran in EELS.
Together with eight originals, that is 17 product and 18 reference execution
transitions, not 35 independent transaction samples.

## Capture and independent reference

All 53 offline controls passed before preparation. The earlier driver control
run had 17/18 passes because an in-progress source dependency had not yet been
written; its output is retained in `controls-driver-first.tap`. The completed
driver run passed 18/18. Preparation 001 then passed all 16 worker input checks,
without VM execution, in 11.493 seconds. No target retry was made.

The source freeze contains 3,912 entries and 24,160,353 regular-file bytes.
All eight product processes completed and were sealed before any EELS target
process was dispatched. The sixteen processes completed in 15.624 seconds,
producing 879,228 raw stdout/stderr bytes. Source identities, original-write
ledger, wall/monotonic bounds and child closure were valid. The sealed capture
manifest contains 4,057 entries. Its raw reports and all missing comparisons
are retained unchanged.

EELS is pinned at `e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e` (2.19.0).
Its Python source and runtime inventory are external dependencies, checked
against the existing 5,080-entry toolchain manifest. The original adapter is
the unchanged historical-fork adapter. The new query adapter uses stock
`apply_body`, full fresh allocations, signed type-2 counterparts and official
trace events. It never receives product outputs or expected poststate.

Originals use base fee 7 and fee caps 13/3. Query execution explicitly uses
base fee and gas price zero, matching the product's unpriced query profile;
the source header retains base fee 7. This synthetic context is not rehashed
as a canonical block. Each query nonce comes from its own initial or settled
original snapshot. Stock system processing remains enabled with the declared
four inert STOP system accounts and a nonempty query fee recipient.

## Identities and saved-only reproduction

- Plan: `0ba3335340a195cc775f4ebf162ea879246ce6dd45c736a2f5ac3f0f3b92607d`
- Capture: `cecb92a4fda58ea2b0646e4f2b332b16c7721e406b551b32adf2c46d2e76e7ff`
- Comparison: `c3fff89705cc786dcf20979758898a7f13324a572ce138064af8e8aadb91af39`
- Preparation manifest: `c7044cdd37e6ad929113a0d3d63a712fbd59a92894ade48ca538d693fe3c2fc6`
- Offline controls: `1cddf1d427ec51973f0ba6ad6effb0b373a6f68630f868366c386fd754fef994`

From the repository root, the following compares only saved artifacts; it does
not invoke either EVM or a network provider:

```sh
node research/storage-creation-lifecycle-v035/capture/runtime/research/storage-creation-lifecycle-v035/run.mjs compare 0ba3335340a195cc775f4ebf162ea879246ce6dd45c736a2f5ac3f0f3b92607d cecb92a4fda58ea2b0646e4f2b332b16c7721e406b551b32adf2c46d2e76e7ff
```

See [comparison.json](comparison.json), [checkpoint.json](checkpoint.json),
[the original declarations](PLAN.md), and [query reference details](query-reference-notes.md).
Raw examples: [005 product](capture/005-product.stdout),
[005 EELS](capture/005-eels.stdout), [008 product](capture/008-product.stdout),
[008 EELS](capture/008-eels.stdout).

The separate [saved reachability audit](../storage-creation-lifecycle-v035-reachability/audit.json)
passed after checking capture integrity before and after its read. It inspected
all ten reference and nine product contract-query halves, 44 paired native
phases, seven reference and six product query SELFDESTRUCT instructions, and
the four original product constructor-destruction frames. The reference-only
retaining after-half remains unpaired. The original EELS adapter has no opcode
trace: reference constructor reachability there is indirect, from the nonzero
CREATE2 return, committed hidden-read log, complete state and frozen linear
initcode. The query adapter retains direct opcode-event evidence. Audit hash:
`c4594f795a088a1bb093f07e9932fad98c4a71e1710ef9579d04cc6b99e08daf`.

The separate [artifact audit](../storage-creation-lifecycle-v035-review/report.json)
also passed. It independently walked 36 saved account proofs, joined 14 code
replies and all 50 input-evidence records, and reconstructed 138 allocation
roots. No storage proofs were requested: creation clears the old namespaces,
whose complete initial contents are bound by the declared allocations and
account storage roots. The audit rechecked all 4,057 capture entries, process
records, original-write ledger and archived comparator; its comparison is
byte-identical to the retained result. The initial reviewer-only absence-field
assertion failure is preserved alongside its corrected parser, without a target
rerun. Report hash:
`c42c8d85cec5b788e7a6ec7e6af15fe8e1211c4ff33db1cb7c9b8ba07b6dd75b`.

## Limits

These selected synthetic cases do not establish population accuracy, complete
asset discovery, general protocol correctness, signed public replay, block
consensus, security detection, other-chain execution or Blockaid equivalence.
The local product uses bounded unsigned execution with explicitly supplied
queries. EELS is independent at execution, while saved-artifact validation
shares cryptographic/RLP/MPT libraries with other local research tooling.
The stock reference wrapper's system processing and zero-fee touches are
controlled only for this declared fixture profile. External OS libraries are
not a fully archived execution environment. No RPC, signing of real funds or
broadcast occurred. The installed application remains unchanged.
