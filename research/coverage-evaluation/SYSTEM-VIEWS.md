# Proposed treatment of ordinary transactions and HyperCore system actions

Design review against `27c60a4`, using saved evidence only. This is a proposed future protocol, not a change to [protocol v1](PLAN.md), its failed pilot, or its null metrics. No additional RPC calls were made for this review.

## What the evidence establishes

The [system diagnostic](../../reports/system-transaction-diagnostic/comparison.json) connects the three additional provider hashes in block **49,544,166** to three entries returned by the official system-transaction method. Each match is unique across twelve explicit action/context fields. Only `hash`, `r`, `s` and `v` differ. Both A and B resolve those provider hashes, although A omits them from its ordinary block list. The official ordinary list matches A's five entries; B lists the three system representations followed by those five.

The [saved primary-source attribution](../../reports/system-transaction-diagnostic/SOURCES.json) identifies the official method's entries as actions originating from HyperCore. This establishes observed action correspondence. It does **not** establish a universal hash conversion, a three-position offset, user-transaction indices, cross-provider state positions, or system execution semantics. No receipts, traces or state were queried by that diagnostic. Provider/node independence remains unknown.

A subsequent, separately planned [position diagnostic](../../reports/system-position-diagnostic/capture.json) queried all five ordinary transactions on A and B: **86 requests, 3,908,425 response bytes, no retries**. Its capture SHA-256 is `be9af34792cb17c38d75cdef077d88185b531890ed3e46c4547e834b1b52002b`. This review independently compared the saved strict traces and full returned prestate-diff objects offline:

| Tested boundary for ordinary-list ordinal `j` | Strict trace matches | Original prestate-diff matches |
| --- | --- | --- |
| `j + 3`, also each transaction/receipt's reported index | 10/10 provider-case observations | 10/10 |
| `j`, the ordinary-list position | 4/10: `j=1,2` on both providers | 0/10 |

Thus **strict trace equality alone can accept the wrong boundary**. These five transactions are all type 2; the diagnostic used the existing unsigned nonce/effective-gas-price reconstruction. The result supports the tested boundaries for this block and profile, not complete typed/signed replay, a universal offset or independent-engine correctness.

The later diagnostic also records **eight entries from A and B**, unchanged in each provider's before/after block response. A previously returned five for the same historical block/hash. Classify each captured response, not the endpoint permanently: the observed view can change across runs. This does not amend the earlier selection failure or explain the provider's implementation.

## Concrete evaluator change

Add a separate `normalizeBlockViews` stage; do not relax the existing ordinary transaction comparator or teach it to discard extra hashes. Freeze its rules and inputs in a new protocol version before selecting another future cohort.

For each selected block, predeclare three sources: A and B's ordinary block-method responses, plus the official endpoint's ordinary and system lists. Classify each response as ordinary, system-inclusive or unresolved from its evidence, not its hostname. Prefer the documented system-by-block-hash method to bind the latter to the selected hash. An unsupported method fails that required enumeration; do not switch methods/endpoints after observing failure. All added discovery/envelope requests consume the same fixed global and per-action budgets.

1. Seal every complete raw list and its provenance before requesting execution outcomes. Check chain, finalized block identity, timestamps and parent continuity as before.
2. Build reference rows for **every** official ordinary entry and **every** official system entry, including unknown targets, malformed/unsupported envelopes, and actions the product cannot simulate. These are reference identities, not a claim of independently proven consensus identity.
3. Preserve each A/B occurrence with its original hash, list position, returned `transactionIndex`, endpoint and response hash. Ordinary aliases require the same hash and a consistent full envelope. System aliases initially require the diagnostic's narrow, unique twelve-field correspondence; permit only the specifically recorded `hash/r/s/v` representation difference. Missing fields, different action fields, extra unrecognized envelope semantics or multiple matches are not wildcards. Record the differing signature/hash fields; do not rewrite the raw object or claim cryptographic equivalence.
4. Keep unmatched representations as unresolved rows. A duplicated hash with conflicting objects is an identity conflict. Duplicate occurrences and overlapping ordinary/system reference entries require explicit resolution; neither deduplicate on calldata nor assume the reference lists are disjoint.

Suggested result shape:

```text
enumeration: complete | unavailable | conflicting
identityMapping: complete | partial | conflicting
referenceActions[]:
  id = blockHash + referenceKind + referenceHash
  kind = ordinary | hypercore_system
  referenceOrdinal, referenceEnvelope, representations[], mappingEvidence[]
  executionOrder = proven value | unknown
  positions[provider] = {listOrdinal, transactionIndex, replayBoundary, evidence}
unmappedRepresentations[]: raw identity, occurrences[], reason
```

`listOrdinal`, `transactionIndex` and `replayBoundary` are separate values. A successful alias match must not fill in the last value. The initial normalizer should output `replayBoundary: unknown` for the saved diagnostic.

## Denominators and bounded attempts

The target population is **all enumerated ordinary and HyperCore-originated EVM actions in the selected blocks**, not only signed user transactions. Publish ordinary and system strata alongside the combined result. Unknown system behavior is an unsupported/non-pass row, not an exclusion. Core-only activity outside the enumerated EVM interface and deferred Core effects remain explicit coverage limitations.

When reference enumeration and identity resolution are complete, `N_enumerated` is the number of unique reference actions, including every unsupported and budget-unattempted row. State that this is RPC-enumerated population coverage, not independently established completeness of all chain activity. The current eight-action diagnostic may illustrate this accounting, but cannot become a successful prospective run retroactively.

If a required list is unavailable, or an extra representation might be either a new action or an alias, **do not invent a single all-action denominator**. Retain the known reference rows and all unresolved occurrences; report reference count, unresolved count and `denominatorCompleteness: inconclusive`. A possible range for unique *observed* actions is not a bound on unobserved actions. Withhold combined accuracy fractions until resolution; ordinary-only results can be labeled secondary, never substituted for the combined target. If identities are resolved but a system action is unsimulatable, the denominator is known and that action remains a non-pass.

Keep the 16-action attempt limit, all-N ledger and no-replacement rule. Before selection, declare a deterministic attempt schedule that cannot starve the system stratum: block order, then round-robin ordinary/system/unresolved rows in each source's observed order, unless a verified common execution order is available and a fixed rule selects it. This would be an explicit v2 scheduling change; it is not evidence of execution order. Every alias lookup costs RPC budget. Budget exhaustion leaves unresolved identities and unattempted actions visible; it must not trigger a simpler replacement cohort.

## Evidence required for original-position replay

Retain separate verdicts for **representation correspondence**, **historical retrieval**, **original-position replay** and **measured effects**. None implies the next.

For ordinary transactions, require a provider-specific boundary mapping supported by the original transaction/receipt, original full trace, complete envelope, bound header and preceding state. Compare the original and candidate **full returned prestate/poststate diff**, including original values; matching only traces or final balances is insufficient. Verify before/after positions with discriminating state witnesses affected by preceding system/user actions, plus nonce, fee and query-isolation checks. Equal unchanged balances cannot distinguish positions. Validate several boundaries, including system/user transitions and blocks with different system counts; never extrapolate an offset from one block. Multiple candidate boundaries that satisfy the available checks remain ambiguous. Where applicable, independently validate transaction/receipt commitments and the node's state-transition/index convention. Shared-adapter and two-endpoint agreement remains weaker evidence, not a state proof.

The existing historical context couples `transactionIndex` to the same ordinal in the returned header list. Keep that guard until a separate, validated view/position binding can replace the assumption; do not manufacture a merged header to make it pass. Bind any new proof to the exact raw header response, action and tested boundary. Recheck the view during measurement; an unexplained within-run list change invalidates dependent measurements without retry.

For system actions, first establish the actual invocation rules from authoritative implementation or equivalent execution evidence: ordering relative to user transactions, privileged caller/origin, nonce meaning, gas accounting, fee exemption, authorization and the resulting state transition. A zero-gas-price system object must not be converted into an ordinary signed transaction, assigned invented fees, or forced through an assumed EOA nonce increment. A dedicated system replay path is needed if ordinary RPC calls do not preserve those semantics. Until then, a retrieved system trace may support retrieval agreement; exact replay is unsupported/inconclusive and remains a non-pass in the combined denominator.

Apply the full ordered trace comparator, including failed subtrees, gas annotations, outputs and logs; require receipt-log completeness and exact supported state queries. The current adapter's type-2 effective-gas-price substitution still cannot establish complete-envelope exact replay. Unknown tokens, native fees, liabilities, nonstandard permissions and deferred Core effects keep all-effects inventories inconclusive; recognizing a system-action alias does not improve those metrics.

## Minimum independent regression controls

Use the saved diagnostic only as development evidence. Expected mappings and counts must come from its original bodies, not from the new normalizer's output.

| Control | Required result |
| --- | --- |
| Recorded five ordinary plus three uniquely mapped system actions | Eight reference rows; preserve all eleven distinct provider/official hash representations; all replay boundaries unknown |
| Same twelve action fields but duplicate possible system matches | Ambiguous mapping; no first-match selection or all-action fraction |
| One changed nonce, input, gas, caller, target, index or block field; missing field; unfamiliar signature pattern | No permitted alias normalization |
| Ordinary hash/envelope disagreement, reordered list, overlapping reference entries, or extra unmatched provider entry | Retain conflict/unresolved row; never trim a prefix or silently shift indices |
| A's recorded five-entry response followed by its later eight-entry response for the same block/hash | Classify separately; no cached permanent provider profile or retroactive pilot repair |
| Missing system method versus successful empty system list | Unavailable enumeration versus explicitly observed zero entries; never treat failure as empty |
| Unknown or reverted system action; attempt/response/RPC budget reached | Row retained, separate status, no replacement, no favorable denominator change |
| Different system counts and nonconstant/interleaved position controls; identical inert balance witnesses | No arithmetic index inference; exact replay withheld without distinguishing boundary evidence |
| Recorded `j=1,2` ordinary-position controls: strict trace matches but original state diff differs | Reject that boundary despite trace equality; retain the mismatching original-state evidence |
| Same action mapping but changed trace, missing receipt logs, fee/nonce exception or state-query override | Correspondence may remain established; retrieval/replay/effect verdict fails independently |

After implementation, retain v1's nine-request failure regression unchanged. Before any new prospective run, freeze the revised normalizer, source provenance, endpoint/method inventory, scheduler, budgets and tests. Finality and parent checks, immutable raw evidence, product-output sealing before outcome adjudication, no retries/fallbacks, explicit unsupported/incomplete cases, separate metrics and all-effects uncertainty remain mandatory. No vendor superiority or 90% accuracy claim follows from this design or diagnostic.
