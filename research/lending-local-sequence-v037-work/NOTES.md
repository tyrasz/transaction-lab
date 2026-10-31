# Lending sequence validation work

This work prepares a fixed comparison of the current local and provider-backed
sequence adapters for Aave and a Kiln wrapper over a Morpho vault. The input
declarations retain six original-call positions and 39 query positions. Each
original has five comparison channels; each query has three correlated channels.
These are two selected sequences, not 147 independent examples or a population
accuracy estimate. The full declaration and bounds are in
[the frozen-source plan](../lending-local-sequence-v037/PLAN.md).

## Review corrections before public execution

- Query comparisons require independently anchored original state overlays on
  both sides. Matching query snapshots alone cannot validate a forged original
  starting value. Genuine differences between two valid overlays remain eligible
  for comparison.
- Original provider RPC arguments and tracer options must match exactly. An
  extra transaction-position selector or storage-suppression flag is rejected.
- Local charged gas is bound to retained message gas, intrinsic cost, the refund
  counter and the calldata floor. Shared gas arithmetic is disclosed; this does
  not independently prove refund eligibility.
- Query agreement describes corresponding sequence snapshots under different
  gas budgets: 1M locally and 300k for the provider. It does not assert that the
  two clients necessarily produced identical poststates.
- Every successful client response must join exactly one retained raw network
  response. Extra failed client records are accepted only when they received no
  response or bytes; they cannot substitute for execution evidence.

The first combined pure run passed 81 tests, failed none and explicitly skipped
one opt-in integration test (851.720 ms). Its original
[TAP output](controls/all-pure-first.tap) is retained. The one prior same-engine
offline integration and its saved-only revalidation are described in
[context controls](controls/CONTROLS-context.md); they are not independent public
lending evidence. Later review controls, if any, remain separate rather than
replacing these first observations.

After the reverse-wire correction, the final combined pure run passed **83/83**
with the same one explicit integration skip (913.808 ms). Its
[TAP](controls/all-pure-final.tap) and the
[runner controls](controls/CONTROLS-runner.md) retain the prior observations.

## First frozen public capture

All four input-only preparation workers passed, with zero network calls. The
prepared manifest is `a3b68e11aa1f3cc99d916b653a9b427f6d10d4e1b752567d5b03d4af8b9a49ef`.
The sole run began October 31 at 04:04:40.799 UTC using an archived 4,036-file
source closure (27,442,456 bytes). The external plan pin is
`727d4a3fe8dfa7901323cf9f7b4d09518c232c448eabddfb7f7b81c113ce5cad`;
the final capture manifest is
`1a414e70a04610bb8e7b784f97ce2edb2773ef07e40205c7a8edb8d533ea85ea`.

| Adapter/case | Original-call observations | Declared queries measured |
| --- | --- | ---: |
| Local Aave | First original unavailable; later two not attempted | 0/15 |
| Local Kiln/Morpho | First original unavailable; later two not attempted | 0/24 |
| Provider Aave | Approval, supply and withdrawal succeeded | 15/15 |
| Provider Kiln/Morpho | Approval, deposit and withdrawal succeeded | 24/24 |

Both local attempts encountered the public RPC's `-32000` historical-state
unavailable error on their first sender account proof. Exact wire responses are
retained at `capture/local/001/wire/0003.json` and
`capture/local/002/wire/0003.json` within the linked packet directory. Source
headers and final rereads passed; missing proof inputs are neither contract
reverts nor successful execution. The product exposed a generic local-execution
error; a separate narrow product correction is being checked without modifying
this frozen packet.

The archived saved-only adjudicator completed successfully against both external
pins. It verified 4,367 manifest entries, original-write ledgers, raw-wire joins,
source/loader identities and bounded process closure. Both case-level gates
passed, but there are **zero comparable originals or queries**: all **30 original
channels and 117 query channels remain null/unavailable**. The
[comparison JSON](comparison-first.json) keeps every position; SHA-256 is
`e23ad9ef45778b457216ce748ae2a0b887c03f31354171ddce1ebca25049642d`.
Provider success does not count as local/provider agreement or general
transaction accuracy.

The separate [provider-only extraction](PROVIDER-OBSERVATIONS.md) validates all
six original traces and 78 query trace halves against saved raw responses,
header witnesses and cumulative overrides. It retains the Aave supply's
one-raw-unit receipt-token rounding and the Kiln approval's already-sufficient
allowance. Its values remain provider observations; the sender facts used for
query mutation checks are provider reads, not independently verified proofs.

The run used 253 read-only RPC calls and 1,373,852 response bytes, taking
66.182 seconds within its recorded matrix interval. All four workers closed,
sources were unchanged, and the capture is structurally usable. No retry,
replacement case, fallback, transaction signature or broadcast occurred. This
is direct API-adapter evidence, not HTTP-route or browser execution. The
installed 0.35 service remains unchanged.

Provider error evidence currently withholds the whole affected sequence during
comparison, even where individual original channels might otherwise be usable;
all declared positions remain in the denominator.
