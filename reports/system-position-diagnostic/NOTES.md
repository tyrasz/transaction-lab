# Replay positions in a block containing system actions

The fixed diagnostic tested all five ordinary transactions in block **49,544,166**, on both public providers, at two declared positions each. It made **86 read-only RPC requests**, received **3,908,425 bytes**, and had no failed calls, retries or replacement cases. Each provider/transaction scope used eight requests; each transaction used sixteen across the two providers. This is development evidence, not a prospective coverage result.

## Result

Both transaction and receipt responses report positions **3–7** for the five ordinary transactions. At those positions, all ten provider/case observations match both the original strict call trace and the full returned pre/post state diff. At positions **0–4**, none matches the original state diff.

| Tested position for ordinary-list ordinal j | Strict trace matches | Full returned pre/post diff matches |
| --- | ---: | ---: |
| j | 4/10 | 0/10 |
| j + 3, the reported transaction index | 10/10 | 10/10 |

The four trace-only matches are transactions at ordinary ordinals 1 and 2 on both providers. Their incorrect replays have the same gas, calls, outputs and events, and the same native fee deltas. The zero-address fee recipient's absolute before/after balances differ. This is a concrete counterexample to using trace equality or fee deltas alone to validate the execution position. It does not show that the product accepted these wrong positions: its separate header/index guard may reject them first. [Exact comparisons](comparison.json), [integration requirements](INTEGRATION.md).

Provider A now returned eight entries, matching B, in both its initial and final block response. Earlier it returned five for the identical historical block/hash. Both responses were stable during this diagnostic, but endpoint identity does not establish a permanent transaction-list format. The earlier failed pilot remains unchanged. [Earlier system-action mapping](../system-transaction-diagnostic/NOTES.md).

## Scope and verification

All five transactions are type 2. The reconstruction deliberately preserves the existing adapter's original nonce, effective gas price, gas, value, calldata and access list. It is not a complete typed-envelope or signed-transaction replay. Eight provider/case observations are successful executions and two are reverts. The three system actions themselves were not replayed here.

Strict trace comparison includes input-gas annotations, ordered children and logs. The separately labeled input-gas-excluded comparison is supplementary. State comparison preserves complete returned pre/post objects and absolute values; it does not establish equality of untouched global state. The two endpoints may share implementation or infrastructure. No independent-engine, universal index-offset, accuracy or security claim follows.

`node reports/system-position-diagnostic/verify.mjs` verifies the fixed capture hash, frozen dependencies, all request memberships and endpoints, per-provider/transaction counts, raw response bytes and hashes, transaction/receipt/log identities, diff schema, before/after block stability, every comparison and malformed-diff controls. It performs no network requests. An independent review identified and prompted the additional diff-schema, receipt-log and endpoint/budget checks before sealing this packet.

Capture SHA-256: `be9af34792cb17c38d75cdef077d88185b531890ed3e46c4547e834b1b52002b`.

The [first pilot](../coverage-evaluation/2026-10-26T04-23-53.888Z-c78b7336/NOTES.md) remains `selection_failed`, with no accepted denominator and null metrics. This separate diagnostic cannot repair or score it retroactively.
