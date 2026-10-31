# Selected 100-USDC lending sequences

The new `selected_100_usdc_v1` profile completed approval → 100-USDC deposit →
50-USDC withdrawal for both Aave and the Kiln/Morpho wrapper. All six originals
succeeded through the local proof-based engine and the provider adapter at the
same selected Ethereum block. All **30 original comparison channels and 117
query channels matched**, with no mismatches or unavailable positions.

This is deliberately selected protocol-path evidence. The sender and smaller
amounts were chosen using the previous capture's observations. The earlier
insufficient-balance failures remain unchanged; this supplement does not
reclassify them or establish representative EVM accuracy.

## Fixed inputs and preparation

Both sequences use public sender
`0x44c3a96181af9e295ce8e188fa8fcdd72d1eb668`, approve/deposit `100000000`
raw USDC and withdraw `50000000` raw USDC. They start independently at the same
header; only originals within each sequence share state. No signature, funding,
wallet ownership claim, broadcast, expected poststate or prior observed balance
is supplied to execution.

The pure profile preserves the two exact historical input files separately,
derives fixed amended calldata, query subjects, case IDs and provenance, and
binds the amendment through preparation, intent, worker validation and saved
adjudication. Nine saved ABI/rationale artifacts are hash-pinned provenance,
never execution state. [Input design](../NEXT-funded-calls.md),
[profile review](profile-binding-review.json), and the prior
[ABI/query review](../funded-design-independent-review.json) retain the scope.

The [complete control run](full-controls-first.tap) passed **93/93** in
1,364.144 ms. All four [offline workers](prepare-first.stdout.json) passed with
zero RPC calls and no EVM execution. The first [freeze](freeze-first.stdout.json)
preserved 4,034 source/dependency files. These are harness/profile checks, not
93 additional public transaction observations.

## One live execution

The [sole archived invocation](live-first.stdout.json) selected block
**26,311,894**, hash
`0x2ffbb9cac864cffa0b2236ef9ef1d571f755377c877f8523a97d447fff9e20d0`.
The first target began 1,322.144 ms after latest-header receipt. Selection took
214 ms; the target matrix and final identity checks took **159.314 seconds**.
The run made **540 read-only requests / 4,733,366 response bytes**, including
three header-selection reads. Four worker packets sealed, with no RPC/client
errors, unchanged sources and complete I/O drainage. No retry or input change
occurred.

| Adapter / sequence | Requests | Response bytes |
| --- | ---: | ---: |
| Local Aave | 59 | 745,074 |
| Local Kiln/Morpho | 233 | 2,752,575 |
| Provider Aave | 103 | 267,534 |
| Provider Kiln/Morpho | 142 | 934,322 |

The [saved-only adjudicator](saved-comparison-first.json) rechecked frozen
sources, input derivation, actual wire records, process seals, chronology and
exact archive membership without executing another VM or network request.
The packet contains 4,665 manifest entries plus its terminal manifest.

A separate [saved-byte audit](OUTCOME-AUDIT.md) rehashed all 4,665 manifest
entries, verified 537 target wire records and 607 evidence-to-wire joins, and
independently decoded all 117 query channels. It also independently compared
18 original status/return/gas channels; ordered-log and net-state semantics
remain the archived adjudicator's checks. The first audit passed with empty
stderr and no rerun. Its [report](outcome-audit-first.json) has SHA-256
`4d755eeaee8052428744d99738e2533fbaf67ac4669ae34fe746b1d21aa3eaaa`.

| Original | Status on both paths | Charged gas on both paths |
| --- | --- | ---: |
| Aave approval | Success | 55,558 |
| Aave supply | Success | 178,305 |
| Aave withdrawal | Success | 160,035 |
| Kiln approval | Success | 55,558 |
| Kiln deposit | Success | 1,430,190 |
| Kiln withdrawal | Success | 1,678,187 |

Each original agrees on execution status, exact return bytes, charged gas,
ordered committed logs and observed cumulative net state. Each of the 39 query
positions agrees on before/after return bytes and decoded raw values. The
queries cover declared sender balances, allowances, reserve/custody balances,
Aave account data and the inner vault's specified Morpho Blue position.

In both sequences the sender's USDC changes by exactly **−100 USDC** on deposit
and **+50 USDC** on withdrawal, ending 50 USDC below its initial balance.
The allowance changes 0 → 100 USDC → 0 → 0. Aave's measured receipt balance is
0 → 99,999,999 → 49,999,998 raw units; the withdrawal changes that balance by
−50,000,001 raw units. Kiln wrapper shares change 0 → 94,368,282 → 47,184,140
raw units. Receipt/share amounts are retained separately from underlying USDC;
they are not forced to equal the requested asset amount.

Aave's five account-data values stayed zero and its health factor stayed at
uint256 maximum on both paths. Those are matching measured results, not proof
of the collateral configuration or an independently verified borrowing limit.
The Morpho Blue query describes the inner vault's position, not sender-owned
Blue shares.

## Exact artifact identities

| Artifact | SHA-256 |
| --- | --- |
| Preparation manifest | `cca36fd99e993f95cf1e56705c0976c1d2734e9e5bb3be4cedc5aeaaabc2b091` |
| External intent | `764b3bc67d9f27693513294bc7721345685d9fc067f9b915c63020013917b7c9` |
| Intent manifest | `b6394cf65c93194510785744630949daa97f62e2cb1b2d4f4fe302a413231a4b` |
| Source manifest | `1f0f322648e9ce4b306fef9e3e537d53130dcbc6e51199d9df5b8a04613ac0cb` |
| Selected input plan | `67fee713c49a295074152edf4aab9fd7150e3d6edd40b452f2f64c377e1e9985` |
| Terminal capture manifest | `02802ff6b0fae693fc405ef39fbaa366f3f1af658b1aa6c3d19032671f3eda2a` |
| Saved comparison JSON | `c267d54ce748beb25c1be1e47bab262c217383a798c4d31d963e48f416d6e1e5` |

Raw worker requests, reports and wire responses are in
[`capture-funded-001`](../../lending-local-sequence-current-v037/capture-funded-001).
The compact [outcome summary](outcome-summary.json) retains per-worker report
hashes and comparison counts. The execution engine and installed 0.35 service
were not changed by this experiment.

## What this does not establish

This is direct development API-adapter evidence, not HTTP/browser validation,
signed-transaction admission, a production release or a security assessment.
Both paths use the same public provider infrastructure; demanded starting-state
proof verification is not independent consensus authentication. Net-state
comparison and 13 declared query identities do not prove complete economic
effect discovery or full public-chain poststate roots. Local getters use 1M gas
after all originals; provider getters use 300k gas between originals, so query
agreement is observational under those different contexts. General accuracy,
other protocols/transaction types and HyperCore settlement remain unproven.
