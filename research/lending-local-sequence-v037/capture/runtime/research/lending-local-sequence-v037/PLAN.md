# Two fixed lending sequences: current local and provider API adapters

Preparation only until the root task releases the complete source and explicitly authorizes dispatch. This packet adds no production code. It preserves two selected, historically derived input sequences; it is not a representative coverage sample or exact historical transaction replay.

## Fixed declarations and denominator

`declarations.mjs` binds ten retained source files by exact length/SHA and encodes inputs without executing a client. Its notes retain provenance and interpretation limits. Exactly these cases are permitted:

| Case | Calls | Raw USDC deposit amount | Raw USDC withdrawal amount | Queries |
| --- | --- | ---: | ---: | ---: |
| Aave | approve → supply → withdraw | 3962903485 | 1981451742 | 5 |
| Morpho/Kiln | approve → deposit → withdraw | 350000000000 | 175000000000 | 8 |

The withdrawal is floor(deposit underlying units / 2), not half a share count. Saved senders, exact headers, contracts, calldata and query descriptors are immutable. No funding, allowance, expected output, or poststate override is supplied. The denominator is two sequences, six declared original-call positions, and their fixed declared query positions. A failed call and any later unattempted calls remain present. No adaptive replacements, retries, endpoint fallback or broadcast.

Both adapters receive the same exact saved Ethereum block hash and sender, zero-value calls, 5,000,000 gas per original, and the unsigned unpriced profile. The current local loader's guarded `simulateLocalSequence` uses `ProofRpcClient`; the current standard loader's `simulateStandardSequence` uses `StandardRpcClient({profile:'sequence'})`. The endpoint is explicitly `https://eth.drpc.org`; environment endpoint overrides are not used. These are direct API-adapter calls in separate Node workers, not HTTP-route or UI evidence.

Local queries have a 1,000,000 gas budget and run after all originals; provider queries have 300,000 gas and run between originals. Their observable return/value agreement may be compared, but their gas or execution contexts are not declared identical. A failed original can have local retained-state measurements while provider measurements are unavailable. State queries are disposable; only originals feed subsequent originals.

## Freeze and dispatch

Input-only preparation validates declarations with both current API validators, obtains guarded loader identities, and verifies source bytes before/after. It constructs no RPC client, invokes no simulation method, and performs no network I/O. Every preparation attempt gets a new directory; failures must be retained.

The source closure copies all packet sources/tests/provenance, all `src` JS/JSON files, engine root modules, full local/standard/fixture engine top-level JS/JSON and installed dependency trees, the retained declaration source files, the raw HTTP capture helper and saved-only comparator dependencies. The Node executable path/version/V8/platform/architecture/hash are pinned. The patched local dependency bytes are copied, not replaced with stock dependencies. Input files are generated before any target and copied byte-for-byte into the capture. Preparation records, ledgers and manifest are copied intact and revalidated before freezing.

Only the archived driver may execute. It requires the external plan SHA, an explicit execution flag, an exact initial inventory and absence of `STARTED.json`. Dispatch order is fixed:

1. Local Aave, then seal its complete output and raw process record.
2. Local Morpho, then seal its complete output and raw process record.
3. Provider Aave.
4. Provider Morpho.

Each worker independently rederives its declaration from frozen provenance and verifies its exact input hash. It receives no other worker output as input. Every actual network request/response entity body is retained separately, including bounded prefixes of failed/oversized responses. The current client evidence and complete API output remain in `report.json`; success returning a report is not an execution-success or accuracy classification. The root's saved-only comparator owns semantic comparison after capture.

Each worker has an original-write ledger and manifest. The parent verifies that ledger and exact subtree only after direct-worker closure and recorded process-group cleanup signalling, adopts those original identities into its own ledger, and rechecks all earlier bytes before each later dispatch and final seal. Unsealed crash artifacts are retained as failure evidence; they cannot make the packet usable. Both local seals precede the first provider dispatch in frozen control flow and saved rows. There is no independent trusted timestamp attestation.

## Bounds and failure policy

- Four outer workers only; local maximum 190 seconds each, provider maximum 300 seconds each. A dispatch requires enough remaining budget for its full ceiling. The overall wall-plus-monotonic interval is at most 900 seconds, including source/ledger checks through terminal verification; preparation, freezing, final artifact serialization/sealing, and saved comparison are excluded.
- Current API/client limits remain: local 145 seconds, 260 calls, 32 MiB response entities; provider sequence 265 seconds, 258 calls, 128 MiB response entities. Each response is at most 8 MiB; each request at most 25 seconds. Aggregate ceiling: 1,036 actual network calls and 320 MiB response entities. No borrowed budget or deadline extension.
- Raw native `fetch`, body-read and cancellation promises are tracked separately from managed API timeout promises. Drain waits at most 25 seconds. Late unaccounted bytes invalidate the packet; already saved raw records are not rewritten. The provider client itself has no drain API, so this capture-layer tracking is required.
- Each child has a 768 MiB V8 heap limit, not an OS sandbox or total-RSS guarantee. Outer stdout and stderr each retain at most 1 MiB. Overflow or timeout terminates the entire fresh process group. Cleanup signalling and direct-child closure are recorded, not an independent OS process-tree attestation; they do not substitute for the local engine's own child-closure and broker-drain evidence.
- Each artifact file is capped at 256 MiB; the ledger caps registered artifacts at 2 GiB. Complete outputs exceeding caps are unavailable; no trimmed output becomes a match.
- Timeout, overflow, source/input drift, unknown files, incomplete actual drainage, unproven inner child closure, backward/overrun clocks, or failed original-write validation makes the packet unusable and stops later dispatch. Undispatched rows remain `not_attempted`. API/provider errors with proven bounded closure remain retained unavailable outcomes and do not remove the fixed denominator.

## Commands after review

From the authoritative repository root, with a new unused preparation directory:

```sh
node --test research/lending-local-sequence-v037/declarations.test.mjs research/lending-local-sequence-v037/run.test.mjs research/lending-local-sequence-v037/capture.test.mjs research/lending-local-sequence-v037/observations.test.mjs research/lending-local-sequence-v037/state-observations.test.mjs research/lending-local-sequence-v037/context-validation.test.mjs research/lending-local-sequence-v037/adjudicate.test.mjs
node research/lending-local-sequence-v037/run.mjs prepare research/lending-local-sequence-v037/prepared-001
node research/lending-local-sequence-v037/run.mjs freeze research/lending-local-sequence-v037/prepared-001 PREPARATION_MANIFEST_SHA research/lending-local-sequence-v037/capture
```

Then, only after explicit root authorization using the returned external pin:

```sh
node research/lending-local-sequence-v037/capture/runtime/research/lending-local-sequence-v037/run.mjs run PLAN_SHA --execute-frozen-readonly
```

The result retains process rows and `evidenceUsable`; aggregate network totals become null on an integrity failure, with completed bounded-attempt subtotals labelled separately; it reports no aggregate accuracy percentage. Shared provider infrastructure, finite demanded proofs, sparse provider diffs, selected query inventory, unsigned transaction projection, and lack of consensus authentication remain explicit limitations. Current source/loader validation and saved-byte comparison are not another independent execution engine.

## Saved-only adjudication

Use the archived checker and the external manifest SHA returned by the sole run:

```sh
node research/lending-local-sequence-v037/capture/runtime/research/lending-local-sequence-v037/adjudicate.mjs research/lending-local-sequence-v037/capture PLAN_SHA MANIFEST_SHA
```

The checker writes only stdout. It rechecks exact global/worker inventories and original-write ledgers, archived source/Node identities, declarations, process seals, raw-wire/client joins, and guarded loader identities. It reconstructs four attempt classifications before calling the async saved-only comparator. All six original positions remain: 30 original channel positions and 117 query channel positions. Unproven packet bounds withhold all channels and aggregate metrics; individual bounded API failures retain unknown comparisons. No client, worker, execution API or network is rerun. Guarded loaders are imported only to reconstruct source identities and validate input records. The optional `LENDING_CONTEXT_OFFLINE_INTEGRATION` test flag must remain unset during preparation and routine pure controls.
