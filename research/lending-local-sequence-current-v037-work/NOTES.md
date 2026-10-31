# Fresh-header lending comparison

This is a follow-up to the unavailable historical local/provider comparison,
using exactly the same two template wallets, six call envelopes, amounts and
query descriptors. Only one newly selected header and the two block selectors
change. The [fixed plan](../lending-local-sequence-current-v037/PLAN.md) retains
all six original positions, 30 original channels and 117 query channels.

## Preparation controls

The [first complete pure run](controls/all-pure-first.tap) passed 69/69 in
1,181.587 ms. It precedes the final worker outcome mutual-exclusion correction.
No EVM or public RPC was executed by these controls. Fake transport exercises
native fetch/read/cancel tracking; harmless child programs exercise process
timeout and overflow cleanup.

Independent review found and corrected ambiguous duplicate JSON members,
mutation of terminal selection reports, missing positive worker PIDs, and a
matrix-duration claim shorter than its sequential process intervals. A passed
freshness sample alone cannot prove an actual worker started. Error and returned
result exclusivity is also checked before a worker can be a bounded observation.

The first [selection/capture controls](controls/selection-capture-first.tap)
passed 39/39. The earlier focused parser, selector and adjudicator controls and
review reproductions are retained under
[`../lending-local-sequence-v037-work/controls/`](../lending-local-sequence-v037-work/controls/).
Those use genuine saved headers with injected historical clocks and fabricated
process records; they are not new public-state or accuracy observations.

Source preparation and the one-shot archived capture must preserve the first
outcome, including unavailable selection, ordinary reverts and missing state.
No funding lookup, replacement sender, retry, easier amount or state override is
part of this experiment. A new source/header archive cannot retroactively repair
an earlier packet.

## Frozen execution release

The [final complete pure suite](controls/all-pure-final.tap) passed **77/77** in
1,222.306 ms, including the final worker outcome, timing, and native body-closure
corrections. The [focused final outcome/timeline run](controls/outcome-timeline-final.tap)
passed 31/31; the [body-closure controls](controls/body-closure-first.tap) passed
19/19. The latter cover late fetch completion and failed/pending cancellation.

All four [offline preparation workers](preparation-first.json) prepared the
unchanged templates, with zero RPC calls and no EVM execution. The first
[source freeze](freeze-first.json) succeeded with 4,023 runtime files.

| Pin | SHA-256 |
| --- | --- |
| Preparation manifest | `bba43023a7a5ca091efab4e29a7cf75f37caa8bc2a2c852d1efbd5f994e9c5fd` |
| External intent | `814889cb61ec7078ae2192a55ce6af72ea18c3675d89cbad092818f4aacb20cd` |
| Intent manifest | `62611bad6ae2a9aa1735e8e4dd99caf2bedcf572ace5b75cf73e97c5cba46daf` |
| Source manifest | `052923da1ed32b59cb440a2145edd6a1c4729f9602d17250d8bf1050da5a7efb` |

Root releases exactly one archived coordinator invocation with that external
intent pin and `--execute-frozen-readonly`, under the user's continuing
simulation-development authorization. This is an internal source-release record,
not a new user approval requirement. It authorizes only the predeclared three
header reads and four bounded read-only target attempts. Any failure remains
the first outcome; no retry, funding or broadcast is authorized by this record.

## Sole live outcome

The [single archived invocation](capture-run-first.json) completed with empty
stderr. Three selection reads chose block **26,310,458**, hash
`0x8c522e1f727e66ca3f5a31ea41deab00fd1a835064ec09a8dc971c111ddeb946`.
The first target started 1,128.099 ms after latest-header receipt. The target
matrix and final identity checks took 134,773 ms; selection took 133 ms.
All four worker packets sealed, with zero RPC/client errors and complete drains.
The targets used 456 requests / 4,609,910 response bytes; including selection,
**459 requests / 4,640,861 bytes**. No retries, alternative providers, input
changes, funding or broadcast occurred.

The [archived saved-only comparison](saved-comparison-first.json) passed its
source, input, wire, process, timing and ledger checks. It did not execute an EVM
or repeat a network call. The capture has 4,569 manifest entries plus its
terminal manifest; 4,023 entries are runtime source/dependency files.

| Final artifact | SHA-256 |
| --- | --- |
| Selected input plan | `63117e789becf9b1efa85ed09a40ed3ac0b052bf584696ee9e1d5fcb3db915a6` |
| Capture manifest | `9b2a3937f5bb1f024e73f171211273d31459792a4ec393f6050337eed87a501a` |
| Saved comparison JSON | `cfc658e5edc55820baf7ef702f1622af3dbb7985d039e9bc51cd4c2d39fdec2d` |
| Independent saved analysis | `c2c4a32dde0fb61ca3a2bee4427cffa61cc0421cf6cf3023900dfa1a0ce2791b` |

| Sequence and original | Both execution paths | Charged gas on each side |
| --- | --- | ---: |
| Aave approval | Success | 55,570 |
| Aave supply | Insufficient-balance revert | 117,046 |
| Aave withdrawal | Not attempted | — |
| Kiln/Morpho approval | Success | 55,570 |
| Kiln/Morpho deposit | Insufficient-balance revert | 872,433 |
| Kiln/Morpho withdrawal | Not attempted | — |

Both failures have the exact ABI `Error(string)` text
`ERC20: transfer amount exceeds balance`. The Aave wallet has measured zero
USDC. The Kiln wallet has **112,952.478562 USDC**, below its unchanged 350,000
USDC requested deposit. Approval effects survive the later failed call; failed
deposit effects roll back. Both local runs obtained all demanded state proofs:
the earlier historical-state availability failure did not recur at this header.

All four executed originals match execution status, return data, charged gas,
ordered committed logs and observed cumulative net state: **20 matched original
channels, zero mismatches**. The two unattempted withdrawals retain ten unknown
original channels. All thirteen approval query positions match before/after
return bytes and decoded raw values: **39 matched query channels, zero
mismatches**. The remaining 78 query channels remain null: 39 belong to provider
getters not executed after a reverted deposit, and 39 belong to unattempted
withdrawals. Local getters around both reverted deposits did measure retained
state, but a missing provider half is never counted as agreement.

The [independent saved inspection](independent-saved-outcome-analysis.json)
checked all four worker manifests and process seals and confirmed these causes
without re-running the comparator or execution. This is selected current-state
agreement on approvals and deep insufficient-balance reverts. It does **not**
establish successful live deposit/withdrawal coverage, full state-root equality,
independent consensus, security detection or a population accuracy percentage.
The installed 0.35 application is unchanged; this evidence uses the unreleased
development API adapters.

Successful deposit and withdrawal paths remain the next concrete gap. A new,
explicitly declared supplemental funded-call experiment may address that gap;
it must preserve this first outcome and use a separate fresh header/source
archive. Lowering amounts must never relabel these two retained failures.
