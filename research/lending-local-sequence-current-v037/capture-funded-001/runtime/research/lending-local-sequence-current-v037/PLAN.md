# Fresh-header sibling for the two fixed lending sequences

Preparation design only until the root explicitly authorizes the archived coordinator. Historical `lending-local-sequence-v037` sources and capture, and previous captures in this family, remain unchanged. Each new capture uses one of two named, fixed input profiles at one fresh supplier-observed header; it adds no representative population or guaranteed successful outcome.

## Inputs and selection

`declarations.mjs` binds the two original template byte hashes and original capture plan/manifest pins. The `profile` is fixed before preparation, source freeze or network selection. Only `original_fixed` (the default) and `selected_100_usdc_v1` are accepted; callers cannot supply another sender or amount.

- `original_fixed` preserves the historical template bytes exactly. Aave keeps approve → supply → withdraw, deposit `3962903485`, withdrawal `1981451742`, five queries. Kiln keeps approve → deposit → withdraw, deposit `350000000000`, withdrawal `175000000000`, eight queries. IDs, senders, call bytes, queries and ordering stay exact.
- `selected_100_usdc_v1` applies the pure, source-pinned amendment in `funded-profile.mjs` to those same immutable base bytes. Both sequences use `0x44c3a96181af9e295ce8e188fa8fcdd72d1eb668`, approve and deposit `100000000` raw USDC (100 USDC), and withdraw `50000000` raw USDC (50 USDC). The fixed amendment updates call arguments, query identities, IDs and provenance together. It does not establish current funding, successful execution or ownership of the public address.

Amounts are raw underlying USDC; withdrawal is not a share count. The selected profile was informed by prior observations. Nine exact rationale/ABI provenance files are archived for both profiles, with their byte counts and hashes checked before inventory; derivation never reads them as execution state. The original capture plan/manifest and historical template hashes remain pinned, and the base inputs are retained separately. Only after deriving the selected profile do the complete header and local/provider block selectors change. Old header/protocol provenance remains explicitly historical. All six original positions and 39 query positions remain declared for either profile.

There is one selector and no funding/proof/code/trace inspection before selection. It performs exactly `eth_chainId([])`, `eth_getBlockByNumber(["latest",false])`, then `eth_getBlockByNumber([selected.number,false])` against `https://eth.drpc.org`. No retries, alternate endpoint, replacement latest, broadcast, funding, allowance or expected-state overrides are permitted. Header hashes and admitted mainnet fork rules are checked, and the complete canonical reread must equal the selected header. Supplier observations do not establish consensus or finality.

At latest-header receipt its timestamp must be no more than 120 seconds behind local wall time or 30 seconds ahead. The first actual target spawn must occur within 180 seconds of that receipt on both wall and monotonic clocks. The archived coordinator and selector share one process and native clock origin; later calls intentionally retain the selected hash as it ages. Each API still performs its own final canonical confirmation. “Fresh at selection” does not mean continuously latest.

## Offline preparation and immutable intent

`prepare DIR [PROFILE]` rejects an unknown profile before creating a directory or dispatching a worker. It creates a new directory, hashes the full source closure and Node executable, preserves original bytes as `base-templates/001.json` and `002.json`, and writes exact profile bytes as `templates/001.json` and `002.json`. Original-profile bytes are unchanged; selected-profile bytes use the declaration module's fixed JSON serialization. The preparation plan pins `profile`, independently derived `amendment`, and both `baseTemplates` and `templates` row lists (`path`, `kind`, `mode`, `bytes`, `sha256`, `id`). Its `inputs` exactly equal `templates`.

Four preparation-only workers rederive the profile from the archived historical base bytes, compare the amendment and both stored representations, import guarded loaders, validate requests and source identity, and return without creating an RPC client or executing an API/EVM. This does not select a header. Retain failed preparations and use a new directory for any corrected preparation.

`freeze` creates a new capture directory with `runtime/`, complete `preparation/`, both exact `base-templates/*.json` and `templates/*.json` pairs, `source-manifest.json`, `intent.json`, `intent-write-ledger.json`, and `intent-manifest.json`. The external intent SHA binds the exact source manifest, Node identity, profile, amendment, both template row lists, preparation manifest, limits and scopes before any network. The source manifest holds `{schemaVersion,files,node}`. Complete installed patched local, standard and fixture dependency trees are copied, along with all current API/core modules, new driver/worker/selector/declaration/profile/adjudicator sources and tests, immutable templates, selection rationale/ABI provenance, raw capture helper and archived comparison dependencies. Imports cannot escape into a mutable checkout or an external dependency symlink.

The intent source binding is `{intentPlanSha256: intent SHA, sourceManifestSha256: exact source-manifest.json SHA, nodeSha256: executable SHA}`. The intent manifest/ledger preserves the original identities of every frozen file. No source edit after freezing can be relabelled with the old selected header.

## One archived selection and target run

Only `capture/runtime/.../run.mjs` accepts `run INTENT_SHA --execute-frozen-readonly`. It checks exact initial inventory and pinned identities before writing exclusive `STARTED.json`. Reuse is refused. The same process invokes the archived selection helper, saves native raw rows and terminal wrapper under `selection/`, seals its original-write ledger/manifest, and adopts that exact sealed subtree into the parent ledger.

The wrapper is stored at `selection/report.json`. It contains the semantic selection transcript, actual native-I/O drainage, usage, paired clocks, and terminal error. The coordinator replays the selection, checks source identity/ledger and raw-wire joins, then derives current declarations from only the immutable base bytes, frozen profile and selected header. `declarations.json`, `inputs/001.json`, `inputs/002.json`, and `plan.json` are immutable before the first target. The final plan includes `intentSha256` and `selectionManifestSha256`, preserves `profile`, `amendment`, `baseTemplates` and `templates`, and replaces `inputs` with the selected-header declarations. Each actual worker independently repeats this derivation, validates exact current request inputs, and verifies frozen source and Node identities.

Target order remains local Aave, local Kiln, provider Aave, provider Kiln. Both local process/worker seals precede provider dispatch. Every worker uses the current direct API with its guarded loader and explicit read-only endpoint: local `ProofRpcClient`, provider `StandardRpcClient(profile:"sequence")`. This is API-adapter evidence, not HTTP-route or browser evidence. No worker output is input to another worker.

`processOnce` checks freshness immediately before the first actual `spawn`; the returned sample is retained as that process record's `firstTarget`. The target matrix has a distinct 900-second budget. The coordinator retains paired absolute origin/phase samples, so first-target freshness never subtracts unrelated process clocks. The target interval includes final intent/source/ledger rechecks, excludes offline preparation, selection, final result serialization/sealing, comparison and output delivery.

## Bounds and retained failures

- Selection: at most 3 reads, 2 MiB per entity, 6 MiB aggregate, 15 seconds per request, 60-second dual-clock phase including at most 10 seconds actual-I/O drain.
- Targets: unchanged 4 outer workers, local 190 seconds each/provider 300 seconds each. A full reserved process ceiling must remain in the 900-second target interval before dispatch.
- Current local API: 145 seconds, 260 network reads, 32 MiB response entities. Current provider sequence API: 265 seconds, 258 reads, 128 MiB. Product proof budgets are not enlarged. Response maximum 8 MiB and request timeout 25 seconds; actual pending fetch/read/cancel promises must drain.
- Combined selection+target ceilings: 1,039 network reads and 326 MiB entity bytes. The selection does not borrow target capacity.
- Outer streams retain at most 1 MiB each; V8 heap ceiling 768 MiB per worker is not total RSS or an OS sandbox. Timeout/overflow triggers process-group cleanup signalling; direct-child closure is observed. This is not independent process-tree extinction attestation. Local inner child closure and broker drainage remain separately required.
- Artifacts: 256 MiB per file, 2 GiB original-write ledger. Truncated or missing outputs cannot become successful comparisons.

Missing state, reverts, proof/provider errors, source changes, expiry, unaccounted data, failed cancellation/drain, unproven child closure, save errors and failed invariants remain explicit. No adaptive input/endpoint/block replacements. Structural/budget failures stop further target dispatch. Bounded API errors remain unavailable observations.

If selection or final input derivation fails, no target runs: all four target attempt rows are `not_attempted`, the six original positions stay declared, and all 30 original plus 117 query channel positions remain unknown. A failed selection has no fabricated selected plan or input header. A completed semantic selection is retained even if a later coordinator/source check invalidates dispatch. Any partially written selection/finalization artifacts remain retained failure evidence. Global comparison usability is separate from local/provider semantic success.

Local queries retain 1M gas and run after all originals; provider queries retain 300k gas and run between originals. Their values are observational comparisons, not identical-gas differential execution. Failed original/query positions remain in the fixed denominator. Shared provider infrastructure, sparse demanded proofs, observed net-change comparison, selected query coverage, unsigned unpriced projection and lack of consensus authentication stay explicit.

## Commands after source review

From the repository root, with optional offline integration flags unset and fresh unused directories:

```sh
node --test research/lending-local-sequence-current-v037/*.test.mjs
node research/lending-local-sequence-current-v037/run.mjs prepare PREP_DIR original_fixed
# Or, in a different unused directory: prepare PREP_DIR selected_100_usdc_v1
node research/lending-local-sequence-current-v037/run.mjs freeze PREP_DIR PREPARATION_MANIFEST_SHA NEW_CAPTURE_DIR
```

Only after explicit dispatch release:

```sh
node NEW_CAPTURE_DIR/runtime/research/lending-local-sequence-current-v037/run.mjs run INTENT_SHA --execute-frozen-readonly
```

The saved-only adjudicator takes the capture, external intent SHA and terminal manifest SHA. It executes no client or VM and never writes inside the capture. Its declared six positions and 147 total channel positions remain fixed regardless of selection/target availability.
