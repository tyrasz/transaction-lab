# Seven fixed delegation-runtime comparisons (preparation only)

This is a synthetic development packet. No public RPC, wallet action, mainnet or
Sepolia historical-state claim, population sample, or public HTTP admission is
inferred. Freeze and target dispatch require the parent's separate release.

## Inputs selected before Geth results

The first six rows preserve the exact request, header, and allocation from the
immutable `../probe/` input with the indicated number. `cases.mjs` verifies its
externally pinned plan and raw input hash before constructing the same fixture.
The comparison then adds exactly four declared nonce-one, zero-balance STOP
accounts to both clients. Original and amended initial roots remain separate;
only the header state root/hash changes. Geth t8n's mandatory system processing
uses those inert accounts; the product does not execute system processing.
Rewards are disabled and withdrawals are empty.

| Order | Declared case | Original probe | Fork / trusted chain | Envelope |
| --- | --- | --- | --- | --- |
| 1 | root_length3 | 001 | Amsterdam / 11155111 | type 2 |
| 2 | root_length24 | 003 | Amsterdam / 11155111 | type 2 |
| 3 | nested_call_length3 | 004 | Amsterdam / 11155111 | type 2 |
| 4 | nested_delegatecall_length24 | 005 | Amsterdam / 11155111 | type 2 |
| 5 | root_exact23 | 006 | Amsterdam / 11155111 | type 2 |
| 6 | prague_root_length24 | 011 | Prague / 1 | type 2 |
| 7 | authorization_retained_after_malformed_recipient | new fixed case | Amsterdam / 11155111 | type 4 |

Six rows were selected before any Geth results to cover the short and long
malformed-address branches, root loader/recipient gas predicates, nested
CALL-family predicate, exact-indicator positive control and Prague behavior.
This does not cover every delegation or call mode. Original stock-runtime probe
results remain separate and immutable; no full-VM target is part of this packet.

Row 7 installs one authorization on the fixture's existing funded authority
(nonce 0, balance 7, empty code), then calls a distinct malformed length-24
recipient. The input gas limit is 67,106: intrinsic 22,816, authorization debit
44,190, remaining root message gas 100. This is the already declared regression
fixture, with no outcome-derived change. Its purpose is to observe whether
successful authorization remains after entered invalid-opcode failure, and to
distinguish that from spurious 3,000-gas recipient-preparation OOG. All other
rows retain their original 200,000 gas limits. All use caps 13/3 and base fee 7.
Input signing uses a disclosed deterministic test key, never a real wallet.

## Runtime and immutable ordering

The archive fully copies the actual current `engines/local-evm/node_modules`
with its explicit EVM 10.1.3 two-file, three-predicate patch. It separately copies
stock `engines/fixture-evm/node_modules`. No dependency directory symlink to an
older stock archive is allowed. The owned patch utility, exact original/new
hashes, complete dependency inventories, production imports, selected fixture
helpers, original selected inputs, harness, Node identity and pinned Geth tool
provenance are bound. The source inventory records the checkout commit plus
working-tree snapshot and is rechecked before each target and terminal success.
Frozen sources are never patched on import or during capture.

After a non-reusable freeze, only the archived driver may dispatch. Each of the
seven corrected product runs uses `executeIsolatedEthereumCall`, the declared
trusted chain/header, and its authenticated synthetic proof transport. It
retains the complete parent result, broker/proof replies, child closure status,
output and errors. Only a completed validated EVM result with a real entered
message can yield a comparison projection. The saved product deltas are applied
to a fresh full MPT using the independent fixture-state adapter. Every raw
product process record is fsynced and sealed before any Geth process.

Then precisely seven pinned Geth v1.17.10 t8n processes consume the identical
amended allocation and independently decoded signed input. All raw stdout,
stderr, exit/clock records, allocation, result, body and JSONL opcode/call-frame
trace remain retained. Product unavailable rows cannot become predictions. No
retry, adaptation, result-driven case deletion, or rewriting of an earlier
packet is permitted. An unexpected failure remains in the seven-row denominator.

## Comparison channels and interpretation

Before comparison, the complete saved Geth allocation is independently rebuilt
into a fresh MPT and must match its reported root. Geth omits zero nonce and
empty code/storage; these fields are explicitly normalized after strict
account/quantity/word shape checks, while balance remains required. This is pure state hashing,
not EVM execution.

Nine channels: full poststate root, committed log RLP/Keccak hash, receipt status,
receipt gas, single-transaction block gas, root return bytes, message gas, exact
normalized log payloads and log bloom. Native logs are supported; empty logs
are never assumed. Receipt metadata binds signed hash, input block number/time,
indices and t8n's known dummy block hash, which is not a chain attestation.

The balanced JSONL call-frame parser requires a unique complete final root
exit, exact from/to/input/value/root gas and no trailing or partial records. It
retains opcode/frame counts and root error. It does not infer opcode-by-opcode
execution equivalence or a particular invalid-opcode reason from a failed
receipt alone. The source-backed Geth pre-frame root gas is declared input gas
minus intrinsic, authorization debit and valid root delegation charge. Only the
exact-indicator Amsterdam control has a 3,000 root delegation charge; the type-4
row has 44,190 authorization debit and zero recipient delegation charge.
Product message gas excludes authorization preparation; root delegation charge
is added back to Geth trace gas for that one exact-indicator control.

Amsterdam block gas is `max(regularGasUsed,stateGasUsed)` for this single tx;
Prague uses its scalar charged receipt gas. Separate Amsterdam dimensions are
product-reported and are not claimed as separate Geth channels. Seven matching
rows, if ever obtained, would establish only this finite synthetic comparison,
not protocol completeness. A valid disagreement remains `mismatched`; missing,
malformed or unbound evidence is `unavailable`.

## Bounds and terminal conditions

At most seven outer product workers, seven isolated child workers and seven
Geth processes. Outer per-process bound 15 seconds, combined stdout/stderr cap
2 MiB, each Geth output at most 4 MiB, at most eight output files, aggregate
48 MiB, and total dual-clock bound 180 seconds. Product budgets are 10-second
wall, 8-second execution/input, 1-second request/drain/kill waits, leaving outer
margin. A returned product attempt must confirm no pending broker work and
closed isolated child, including unavailable attempts. Process errors/late
completion and output-bound failures are retained; bound/source/integrity
failure withholds whole-packet usability. Flat output file stats are checked
before reads. Oversized files remain explicitly unhashed with their metadata.
All written artifacts are ledger-bound before terminal success. Exact terminal
inventory equality rejects additional or missing capture files; unexpected files
remain explicitly unhashed with metadata and withhold whole-packet usability.

Preparation tests only construct/sign inputs, verify source identities and use
fabricated result/trace bytes. They exercise schema, envelope/context binding,
nonempty logs/bloom, disagreements versus malformed evidence, raw-byte seals,
process/file/clock bounds, exact terminal inventory, complete allocation roots
and source closure. They never freeze or execute a
product, full VM, Geth, or network call. The preparation suite will be retained
before a later separately authorized freeze/run.
