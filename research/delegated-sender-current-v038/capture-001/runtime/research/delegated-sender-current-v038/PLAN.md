# Two fixed delegated-sender calls at one fresh header

This is a new prospective packet. Historical captures and their outcomes stay unchanged. Preparation and source review must complete before the root authorizes one archived run. No current network or target execution is performed by importing these modules or running their pure controls.

## Fixed inputs and comparison

The immutable source requests are ordinary-local-coverage-v1 cases `002` and `015`, pinned by exact request bytes and the original plan/manifest in `declarations.mjs`. Their derived IDs are `delegated-usdt-002` and `delegated-usdt-015`. Preserve the exact projected sender, destination, calldata, value, empty access list and 5,000,000 gas. There is no amount/sender selector, funding or allowance override, retry, alternate provider or replacement case. Prior observations motivated these two cases; a sender's delegation at a new header is not assumed.

Each local request uses current guarded `simulateLocal`, the unsigned unpriced block-end profile, and exactly two explicit USDT `balanceOf` queries: sender and calldata recipient. The original header and transaction hash remain historical provenance. Fresh execution replaces only the complete source header and local block hash. It is not a replay at the mined transaction's position. No signature is produced, transaction broadcast, faucet request, or real transfer occurs.

The reference uses the four exact `ordinary-local-coverage-v1/outcomes.mjs:oracleRequests` requests, in order: hash-pinned header, call tracer with logs, prestate diff tracer, canonical numbered-header reread. The original call's gas price and execution base fee are zero in both paths. The reference is direct raw cohort product transport; the Standard API's code-free-sender admission filter is not involved. All request bytes, responses, complete errors and bounded incomplete prefixes are retained. Queries remain local display evidence and are excluded from differential comparison.

The fixed denominator is two original positions and ten channels: execution status, returned data, committed logs, gas accounting, and full observed net state changes for each original. Reverts, errors, unavailable traces, incomplete proofs and unattempted rows remain declared. The sparse observed-state comparison is not a full poststate-root comparison, complete effect coverage, representative accuracy result or consensus check. The product and remote reference share public input infrastructure. Shared proof/parent-validation utilities remain disclosed in saved adjudication.

## Preparation, closure and freeze

`prepare DIR` creates a fresh directory and dispatches four **preparation-only** workers in fixed order: local case 002, local case 015, oracle case 002, oracle case 015. Preparation validates exact original bytes, derives the case inputs at their historical headers, imports the current guarded local loader, validates its request schema and the exact four oracle requests, then returns before creating a client or executing any API/VM. The oracle preparation uses the same full loader identity as the local preparation; actual oracle reports identify their execution as raw transport and set `implementation:null`.

The preparation plan pins:

- `files`, the complete source/dependency inventory, and exact `node` executable identity;
- `originalTemplates`, two exact historical request files saved as `original-templates/001.json` and `002.json`;
- `templates`, two independently derived cases saved as `templates/001.json` and `002.json`; preparation `inputs` exactly equal these rows;
- fixed limits, scope and denominator.

The inventory includes all current `src` and engine root modules, complete installed local/standard/fixture dependency trees, the shared bounded worker-process helper, this family's declarations/outcomes/adjudicator/runner/worker and tests, the unchanged v037 archive/native-capture/selection/strict-JSON helpers, the raw cohort HTTP/wire/verifier/freeze modules, ordinary outcomes, and explicitly declared historical input/provenance files. No executable import may escape the archived closure. The inventory permits fewer than 12,000 entries and less than 128 MiB. Dependencies are copied in full; runtime patch guards and full loader inventories remain active. This identifies bytes, not dependency safety or an OS sandbox.

`freeze PREP_DIR PREP_MANIFEST_SHA NEW_CAPTURE_DIR` first validates preparation's original-write ledger, exact process invocations, stream hashes, process closure, zero calls and prepared reports. It copies `runtime/` and complete `preparation/`, preserves both original and derived template pairs, then seals `source-manifest.json`, `intent.json`, `intent-write-ledger.json` and `intent-manifest.json`. External intent SHA binds the exact source, Node, inputs, preparation manifest and policies before any network. Source drift after preparation requires a new preparation and new capture directory.

## One selector, then fixed execution order

Only the archived coordinator accepts `run INTENT_SHA --execute-frozen-readonly`. It verifies exact initial inventory and original identities, then exclusively writes `STARTED.json`. Existing or partial captures are never reused.

The unchanged v037 selector performs exactly three prescribed reads against `https://eth.drpc.org`: chain ID, one latest header, and its numbered canonical reread. It validates chain 1, admitted header/fork rules, hash and exact reread. The supplier's answer is not independently authenticated consensus or finality. Selection retains native request/response bytes, reducer events, paired wall/monotonic clocks, usage and actual I/O drainage under a separate original-write ledger. Raw records and semantic events must join exactly.

Latest-header receipt must be no more than 120 seconds behind local wall time or 30 seconds ahead. The first actual target spawn must occur within 180 seconds of receipt on both clocks. Selector and coordinator share one process clock origin. The first-spawn sample is retained; later workers keep the same selected hash as it ages. There is no reselection.

Only after usable selection and source checks are `declarations.json`, `inputs/001.json`, `inputs/002.json` and selected `plan.json` written. The selected plan retains both template lists, and adds the intent/selection pins while replacing `inputs` with the selected-header cases. Workers independently rederive those exact cases from archived original bytes and the replay-validated selected header.

Order is always local 002, local 015, oracle 002, oracle 015. Both local worker packets and process seals precede either reference dispatch. Each process starts from the immutable same header; outputs never feed another target. The local API performs its own canonical bracket, input proof checks, isolated worker validation and final header confirmation.

## Evidence and actual closure

Worker `request.json` contains `{id,index,kind,inputSha256,request,normalized}`. Local request is the declared API input with independent API normalization. Oracle request and normalized value are the same four input-derived `{label,method,params}` rows. Preparation reports contain no target result.

Every actual report binds schema, input ID/index/hash, worker PID, returned/thrown disposition, exact bounded error, source status and elapsed clocks. Local reports retain the full API result and implementation identity, RPC evidence/usage, native capture usage, RPC/native drainage and isolated child closure. Oracle reports retain `{dispatch,records,attempts,transportWireIds,transportUsage,transportDenied}`, native capture usage and both cohort/native drainage. Exact cohort records are written to `cohort/0001.json` etc.; the underlying actual native records are separately written to `wire/0001.json` etc. Successful records must join byte-for-byte; all actual native requests need a cohort record. A failure cannot be relabelled as a completed reference.

The unchanged native capture wrapper tracks actual fetch/read/cancel promises, including acquired-body failures. Cancellation rejection or pending actual I/O withholds bounded status even when a managed wrapper settled. The shared process helper captures both streams, observes direct-child closure and signals process-group cleanup after every attempt. This is not independent proof of process-tree extinction. Local inner-child closure and broker drainage are checked separately. All original-write ledgers are checked at phase boundaries and before later targets; source identities are checked before/after each process and at the terminal boundary.

## Finite ceilings and failure policy

- Selection: 3 requests, 2 MiB per response and 6 MiB total; 15 seconds per request; 60-second dual-clock phase including at most 10 seconds of actual I/O drain.
- Local API: 145 seconds, at most 260 calls and 32 MiB entities, 8 MiB per response, 25 seconds per request; at most 25 seconds terminal drainage. Each outer local process is capped at 190 seconds.
- Raw oracle: exactly four prescribed request positions, at most 4 calls and 32 MiB entities, 8 MiB per response, 25 seconds per request, 90-second transport phase plus at most 25 seconds actual I/O drainage. Each outer oracle process is capped at 120 seconds. The reused native provider wrapper has a wider internal ceiling; the cohort transport and saved joins independently enforce this packet's four-call/32-MiB ceiling.
- Target matrix: 700 seconds on both wall and monotonic clocks, including final source/ledger verification and excluding final result serialization/sealing and comparison. Each dispatch requires its full reserved outer process ceiling to remain. The literal clocks and timer overruns are checked after return, including suspend/time-jump behavior.
- Target totals: 528 calls and 128 MiB entities. Selection plus target totals: 531 calls and 134 MiB. No phase borrows another's allowance.
- Process streams: at most 1 MiB each. Heap limit: 768 MiB per worker; this is not an RSS cap. Artifact files: 256 MiB maximum, 2 GiB ledger total.

Any unproven process/transport closure, timeout, output overflow, unknown bytes, source drift, ledger discrepancy, clock reversal or budget overrun latches global unavailability and stops remaining dispatch. Bounded ordinary API/RPC failures may leave later fixed attempts eligible. No original result is removed. Selection failure retains all four target rows as unattempted and all ten comparison channels as unavailable. Partial/unsealed artifacts are retained as failure evidence and cannot support a match. Final sealing/output delivery is outside the measured target interval and is not claimed bounded by that interval.

## Commands after source release

Use unused directories and preserve every failed preparation/capture:

```sh
node --test research/delegated-sender-current-v038/*.test.mjs
node research/delegated-sender-current-v038/run.mjs prepare NEW_PREPARATION_DIR
node research/delegated-sender-current-v038/run.mjs freeze NEW_PREPARATION_DIR PREPARATION_MANIFEST_SHA NEW_CAPTURE_DIR
```

Only after explicit execution release:

```sh
node NEW_CAPTURE_DIR/runtime/research/delegated-sender-current-v038/run.mjs run INTENT_SHA --execute-frozen-readonly
```

Saved adjudication requires external intent and terminal manifest pins and performs no VM, API or public RPC invocation. It never edits the capture.
