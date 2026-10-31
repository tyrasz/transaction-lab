# Proposed current-state sibling

This is a preparation design, not a dispatch authorization or a new observation. The completed historical packet remains unchanged. Use a new family, `research/lending-local-sequence-current-v037`, to ask whether the same declared calls can be evaluated at a freshly selected state. Current balances, protocol state and liquidity may make the calls revert; no success or economic outcome is selected in advance.

## Immutable input template

Read the two input JSON files from the completed historical capture as input templates only. The old plan SHA-256 is `727d4a3fe8dfa7901323cf9f7b4d09518c232c448eabddfb7f7b81c113ce5cad`; its manifest SHA-256 is `1a414e70a04610bb8e7b784f97ce2edb2773ef07e40205c7a8edb8d533ea85ea`.

| Template | SHA-256 |
| --- | --- |
| `research/lending-local-sequence-v037/capture/inputs/001.json` | `c50936237fed1d59740521b1928f2a4bef74e496ec308f5f65d02281164e3f5c` |
| `research/lending-local-sequence-v037/capture/inputs/002.json` | `3b09b2898f5b5c7b1d9f758b793f5e6f3246ca0f241cc20b71cc89637171737c` |

Preserve both IDs, senders, all six `to/data/value` call envelopes, the 5M original gas declarations, amounts, ordering, query descriptors and query roles byte-for-byte at the JSON-value level. Permit only the complete `header`, `localInput.block`, and `providerInput.block` execution inputs to change. Both cases receive exactly the same selected header/hash. Retain the old headers as historical input provenance, not as the current source header. Fresh selection metadata is separate from ABI/call provenance. No response, trace, balance, allowance, proof, state diff or prior success feeds the new inputs.

The local list remains five Aave queries and eight Kiln queries. These are the same two selected populations at a new state, not additional representative population coverage. Kiln remains the outer wrapper; the Blue position belongs to the declared inner vault.

## Source freeze before any network

Review and run pure controls first. Create an externally pinned intent/source archive before the selector can dispatch. It binds the selector and new declaration module, the complete future driver/worker/adjudicator, the reused capture/archive/comparison helpers, both immutable template bytes, all imported tests/fixtures/provenance, all current API/core modules, installed patched dependency trees, and the exact Node executable identity. No archive import may resolve through a mutable checkout or an external dependency symlink.

The new runtime uses a sibling `PREFIX`; do not import the old runner whose module-relative root/PREFIX and historical declaration reconstruction are fixed to the original family. Copy the reviewed runner architecture into the sibling and preserve its behavior except for the explicitly declared selection/input transition. Existing `sourceRows` must inventory any newly introduced selector/declaration files and their actual imports. A later runtime patch or source change invalidates the intent archive; do not re-label an old selected header with new source bytes.

The selector must refuse to dispatch unless the external intent pin, exact archived source inventory and Node identity have been verified. Recheck identities after selection and before target execution. The selector's raw records and terminal result receive an original-write ledger and manifest. Their full bytes and pin are inputs to the final capture plan.

## Exactly one header selection

Use the same fixed endpoint, `https://eth.drpc.org`. Permit exactly these three sequential reads, with no retry or alternative endpoint:

1. `eth_chainId([])`, requiring `0x1`.
2. `eth_getBlockByNumber(["latest", false])`, exactly once. Verify the complete returned header/hash using the trusted mainnet header rules and require an admitted mainnet fork.
3. `eth_getBlockByNumber([selected.number, false])`, requiring the same complete header as step 2. This is a canonical confirmation at the chosen height, never a second latest selection.

No account, balance, allowance, code, proof, trace or simulation request is permitted during selection. Do not inspect current funding before accepting a header. Do not move to another block after a rejection. A reorg, unavailable header, unsupported fork, invalid encoding, source drift, failed persistence, incomplete drain or exceeded bound leaves the selection unavailable and all declared target positions unattempted.

Retain each exact request entity, HTTP status, raw response bytes or bounded failure prefix, body hashes, transport disposition and timing. Selection allows at most 3 requests, 2 MiB per response and 6 MiB aggregate, 15 seconds per request, and a 60-second phase budget including a maximum 10-second actual-I/O drain. Use the larger of wall and monotonic elapsed times; clock reversal invalidates the attempt. Keep the underlying fetch/read/cancel settlement tracking and original-write checks used by the reviewed capture helper. These are supplier observations, not consensus or finality authentication.

At latest-header receipt, require its timestamp to be no more than 120 seconds behind the sampled local wall time and no more than 30 seconds ahead. At the start of the first target process, require at most 180 seconds since latest-header receipt on both clocks. Complete preparation/source copying before selection where possible. A single archived coordinator can retain the same monotonic origin through selection, final input freeze and the first target dispatch; it can import the archived run entrypoint only after sealing/validating the final external-input plan. If separate processes are used, the cross-process monotonic identity needs an explicit trusted binding rather than subtracting unrelated `performance.now()` values.

The 180-second gate is a start-freshness rule. The later workers intentionally use the frozen hash as it ages; they must never resolve `latest` again. Every API keeps its existing full-header final confirmation. A header that becomes noncanonical is withheld, not replaced. The saved plan must say "fresh at selection" rather than imply that every later call executes against the continuously latest state.

## Final input freeze and execution

Reconstruct the two selected inputs from the pinned template bytes and the sealed selection record. Validate exact allowed differences, compile the unchanged queries, and run both existing public API input validators without executing an EVM. Save `declarations.json`, both selected input JSON files, selection identity, runtime identity, and the immutable final plan before any target worker starts. The worker and saved adjudicator must repeat that same template-to-selected-input derivation; neither may rebuild a new header from `latest` or accept a free-form replacement request.

Keep the existing four-process order: local Aave, local Kiln, provider Aave, provider Kiln. Both local outputs are sealed before any provider execution. Keep existing shared API budgets and all process/drain/source/ledger checks: local 145s/260 calls/32 MiB, provider 265s/258 calls/128 MiB, outer process ceilings 190s/300s, and the 900-second matrix execution-plus-verification bound. The latter excludes final serialization/sealing, as the old plan explicitly declares. A complete reserved process ceiling must remain before dispatch.

Selection is a separate bounded phase, not borrowed target capacity: aggregate declared network ceiling is 1039 reads and 326 MiB entity bytes (3/6 MiB selection plus unchanged 1036/320 MiB target bounds). Preserve the 2 GiB artifact and 256 MiB file caps. Any actual process/global integrity failure stops later dispatch while preserving unavailable/unattempted rows. Do not enlarge the product's 256-proof-call budget to force a successful current-state result.

The denominator remains two sequences, six original positions, 30 original comparison channels and 117 query comparison channels. Reverts and later stopped positions remain in that denominator. A failed header-selection stage also records that full denominator as unattempted/unknown. Existing unknown-versus-mismatch policy remains: no missing balance becomes zero; a valid state difference is a mismatch; unsupported/unauthenticated state makes state and dependent query channels unavailable. No worker output is input to the other execution path.

## Bounded code changes and pure controls

Start with a new pure selection state machine/validator and a new pure declaration derivation module. The selection module should produce only the three prescribed requests and validate supplied raw captured replies; the later driver owns actual network dispatch, external source-freeze verification, byte persistence and drainage. The declaration module reads only the two pinned templates and an explicitly supplied validated selection. It should export unchanged-template checking for the worker/adjudicator as well.

The prepared module retains pre-event failures (for example a rejected request clock or malformed supplied raw-record schema) as explicit unavailable markers at the last accepted clock. Such a marker can be replayed only as unavailable and does not authenticate its stated cause or provide a new transport timestamp. The coordinator must retain the actual native failure evidence separately. Late terminal checks retain all preceding raw replies and withhold the selected header. Completed selection is still insufficient for target dispatch without independent source/ledger/native-I/O checks and the separate first-target freshness gate.

Pure controls should cover the exact request order and one latest read; chain mismatch; wrong height/hash or changed full-header metadata on reread; malformed/extra JSON-RPC envelope fields where prohibited; stale/future headers; wall/monotonic timeout and reversal; an expired first-dispatch window; unchanged case IDs/envelopes/queries/amounts; and attempts to smuggle funding/context overrides or select different headers per case. Use saved genuine headers with injected clocks as shape controls, clearly not new current observations. Driver controls later cover failed raw persistence, unaccounted/cancel-failed I/O, source drift, selection failure denominator, and archived-only dispatch.

The result will be useful current-state evidence for the same frontend-supported call schema, but direct adapter invocation is still not browser or HTTP-route execution. Local/provider query gas and scheduling remain intentionally different. The same public provider supplies local proofs and reference execution; no independent consensus, full economic coverage or representative accuracy claim follows.

## Implemented preparation checkpoint

The sibling now contains `selection.mjs`, `declarations.mjs` and two pure test
files. The first run passed 15 controls; after adding replayable pre-event
failure markers and late-terminal withholding, all **17 controls passed**
(213.869 ms). Both [first](controls/current-selection-first.tap) and
[final](controls/current-selection-final.tap) logs are retained. The saved genuine
header is tested with injected historical clocks; this establishes no new
current-header observation. No network, VM, preparation worker or freeze ran.

The archived coordinator, native-I/O capture, selected-input finalization,
worker, saved adjudicator and their failure controls still need implementation
and review before any fresh-header selection or target dispatch.
