# Historical preparation: require the original replay's full state diff

Recommendation: add one original-call `debug_traceCallMany` prestate-diff request at the already validated transaction index, then compare its complete reported pre/post state with the original `debug_traceTransaction` diff. Require both semantic trace equality and state-diff equality before returning a prepared historical context. No index search, inferred offset, or fallback is needed.

This document is an offline integration assessment. No source changes or RPC calls were made for it.

## Concrete evidence and gap

I reran the offline verifier against [capture.json](capture.json), SHA-256 `be9af34792cb17c38d75cdef077d88185b531890ed3e46c4547e834b1b52002b`. Its 86 original RPC records, response checksums, request identities, and 3,908,425 response bytes verify. [comparison.json](comparison.json) is reproducible from those raw records.

At block 49544166, all five ordinary transactions on both providers match their original **strict trace and full raw pre/post diff** at their reported positions `j+3`. Two successful transactions also have indistinguishable strict traces at the tested incorrect positions `j`, but their state diffs disagree:

| Transaction | Wrong / reported position | A: original diff / wrong replay diff / correct replay diff RPC IDs | B: corresponding IDs |
| --- | --- | --- | --- |
| `0x52e44bd70312e00d0a5a096a653d83a90bccb7e27fb66dcc1fd7e28034e33486` | 1 / 4 | 14 / 16 / 18 | 57 / 59 / 61 |
| `0x5e6e562b55c65dd43a0f980b2a18f81cf047dd7a9702400bfababa98563f12d7` | 2 / 5 | 22 / 24 / 26 | 65 / 67 / 69 |

For both transactions, only the zero-address fee recipient's **absolute pre and post native balances** differ. Its balance deltas are identical at the wrong and right positions: respectively `2779798615374` and `405379000000` wei. Comparing fee deltas, token deltas, gas, events, or the original sender's nonce cannot substitute for this full diff comparison.

Current `prepare()` compares the original CallMany trace, then fetches the original transaction diff and calls `buildStateOverrides(diff)` solely to reject unsupported account/code changes. It never asks for the original call's replay diff. Later query nonce and fee checks are valuable but do not bind those queries to the absolute state observed by the original transaction.

The diagnostic does not show that the product accepted these specific wrong positions: existing header/index checks may stop a request earlier. It demonstrates a real trace-only false match and a missing independent guard if an execution endpoint ignores or misinterprets an otherwise consistent requested index. The observed offset is evidence for this block, not a universal `+3` rule.

## Minimal implementation sequence

Keep the existing pre-RPC envelope, receipt, original-trace, lifecycle, and canonical full transaction-array checks. Keep original nonce, effective gas price, gas, value, input, sender, destination and access list unchanged.

After successful original semantic replay equality:

1. Fetch the existing original `debug_traceTransaction(hash, {tracer:'prestateTracer', timeout:'15s', tracerConfig:{diffMode:true}})` result.
2. Validate its schema and existing scope restrictions before further execution. This retains early rejection of account creation/deletion, code changes, excessive storage, or malformed evidence.
3. Issue exactly one additional isolated CallMany request: `paramsAt(index, [originalCall], {tracer:'prestateTracer', tracerConfig:{diffMode:true}})`. This uses the same block-hash binding and original envelope as the successful original callTracer replay. Do not insert any balance query into the bundle.
4. Require precisely one bundle containing one result, sanitize embedded provider errors before evidence retention, validate the replay diff's schema/scope, and compare canonical **entire** original and replay pre/post maps.
5. On mismatch or unavailable evidence, reject shared preparation with a fixed safe `StateValidationError`, for example `Original-position replay state diff does not match the historical transaction.` Return no balance, allowance, affected asset, reuse proof, or prepared execution identity. Preserve original execution/receipt/event evidence in the API response.
6. Only after equality continue existing generic-root code proof, before/after header witnesses, token query-path/diff checks, and final canonical checks. Add a validation field such as `originalStateDiff: 'full_pre_post_match'`; it must be absent from old captured identities and from rejected contexts.

Lazy preparation already shares its promise across consumers, so this is one extra RPC per context, not per measurement or query. An original replay mismatch is a preparation failure, not a query-local failure. Existing canonical failure latching and final evidence refresh remain unchanged.

## Canonical comparison rules

Use a bounded pure parser/comparator rather than `JSON.stringify(raw)` or comparing only `buildStateOverrides` output. Object insertion order is irrelevant; **field presence, every absolute value, every account, and every storage slot matter**.

- Require plain object-shaped pre/post maps and account records. Reject arrays, null, invalid primitive types, unexpected top-level/account fields, and unsupported account/code changes through the existing scope checks. Accepted account fields are balance, nonce, code, and storage. Retain the existing 100-account and 2000-slot bounds.
- Validate string address/slot/byte types before normalization. Lowercase address keys, word keys/values, and code bytes; reject collisions after normalization. Sort object keys for deterministic comparison. Do not merge two differently cased keys into one account or slot.
- Normalize only integer representation: safe nonnegative JSON integer or supported integer string to exact BigInt decimal text, with uint256 balance and uint64 nonce limits. No Number conversion or rounding. Fixed storage words remain exactly 32 bytes; code remains an even-length byte string.
- Preserve omitted fields versus explicit fields, including absent nonce/balance/code, `code:'0x'`, absent storage versus an empty storage object, and absent storage entries versus explicit zero words. Initial acceptance may conservatively reject provider formatting differences; do not fill defaults or erase absent fields without separately reviewed equivalence evidence.
- In particular, do not remove unchanged basic pre fields. Geth diff mode may retain original code/balance/nonce there while post contains only changes. Do not reinterpret that asymmetry as an account mutation, and do not discard it during comparison.
- Preserve cleared slots as represented in each original map. `buildStateOverrides` correctly maps a pre-only slot to zero for state reconstruction; using that reconstructed output for comparison would discard original pre values and presence information.
- Include the native fee recipient, zero address, sender, and all other returned accounts. No fee exclusion, common-offset subtraction, “same delta” normalization, token-only filter, gas tolerance, or post-only comparison.

All ten correct-position diagnostic pairs already match raw objects with no value/presence relaxation. That is evidence to begin strictly. Equivalent formatting is limited to case, integer representation, and object order; any additional normalization needs an explicit failing raw fixture and justification. Full reported-diff equality strengthens position binding but does not prove equality of unreported/unchanged state or uniqueness among every possible position.

## Costs and limits

The additional RPC uses the existing 15-second tracer timeout, 8 MiB response ceiling, and 32 MiB total context response-evidence ceiling. Large original diffs can now consume roughly twice their prior evidence space; exceeding the limit remains unavailable, without truncation.

| Context cost | Existing | With guard |
| --- | ---: | ---: |
| Known-root preparation | 6 calls | 7 calls |
| Generic-root preparation with runtime-code proof | 7 calls | 8 calls |
| Twelve distinct queries | 48 calls | 48 calls |
| Known root + twelve queries + one canonical check | 55 calls | 56 calls |
| Generic root + twelve queries + three consumer canonical checks | 58 calls | 59 calls |

The 12-pair/64-call hard limits remain viable; do not raise them. Reserve final canonical-check capacity as before. The extra call can add up to the client/tracer timeout to a slow request, so update the declared runner RPC/deadline estimates. No timing guarantee follows from these samples.

## Tests and capture refresh

First add offline guard tests over this diagnostic's **real raw pairs**: ten correct-position equalities; ten wrong-position mismatches; explicit assertions that the four wrong-position strict-trace matches and unchanged fee deltas still fail full diff comparison. Include the failed original transaction only as comparator evidence; do not broaden the production historical context's successful-root scope.

Add synthetic negative controls for: changed absolute pre/post balances with equal delta, a changed pre storage value, cleared-slot presence, missing accounts/fields, reordered keys and equivalent integer/case formatting, duplicate normalized keys, unknown fields, malformed/oversized RPC envelopes, and a provider failure before the new result can be retained. Integration controls must show that failed shared preparation prevents all balance/allowance/affected measurements and further query calls.

Existing live captures cannot supply the new CallMany result. Do **not** serve the original transaction diff as though it were a recorded replay-diff response. Old fixtures remain immutable evidence of the earlier implementation. Synthetic unit stubs can explicitly model equality, but must not be labeled raw recorded replays.

A minimal full-HTTP refresh of the existing successful development coverage comprises:

- The eleven v0.7 affected-account runs: supply ×2, withdraw ×1, borrow ×2, repay ×2, direct A ×1, direct B ×1, router ×2. If prior outcomes persist, `402 + 11 = 413` total server RPCs.
- The three additional successful permission-only runs not represented there: archive USDC approval and relayed hUSDC permit on both providers. Their prior 17 calls each become 18, for 54 more calls.
- Combined estimate: fourteen new HTTP attempts, **467 server RPCs**, conditional on unchanged successful provider behavior. Predeclare a bounded manifest and retain all failures without retries or replacements. This estimate is not a license to exceed its eventual budget.

Keep the old eight-call inconsistent dRPC approval and old direct-B index discrepancy as original failure regressions; they fail before the new call and need no fabricated continuation. The original archive withdrawal retrieval failure also remains unchanged. The nine-call prospective selection failure and its metrics remain untouched.

Refresh strict recorded adapters in historical/permission replay tests only from genuine new recordings, preserving all old execution/receipt/event/quantity assertions. Historical-state, affected-oracle and canonical fault tests also depend on exact query sequences: supplement them with explicitly linked genuine new evidence or point equivalent coverage at the refreshed recordings. Existing seven-pair oracle values remain independent numerical expectations; do not rewrite their old transport history. Frozen old modules may verify legacy recordings offline, but that is not a substitute for testing the current guard.

No additional live transaction is required to establish the trace-only false-match regression: this diagnostic already contains its original and both replay results on both providers. A later live integration check at the declared positions may be useful, but must be a separately declared run rather than an implicit search for a matching index.

## Release statement

Describe the result as matching the original transaction's semantic execution **and full reported changed-state pre/post diff** at its declared position, with the existing query/header/nonce checks. Retain the limitation that type-2 reconstruction uses the original effective gas price and unsigned call envelope; full diff equality does not establish exact signed-transaction validation, complete state equality, or independent-engine agreement. Update source fingerprint/version and evidence identity separately; no current affected-account gate change is necessary for this guard.
