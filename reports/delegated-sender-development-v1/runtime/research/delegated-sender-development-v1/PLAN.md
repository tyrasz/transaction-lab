# Existing delegated sender: two known development cases

This is a deliberately selected development recheck of cases **002 and 015** from `reports/ordinary-local-coverage-v1`. Their coded-sender failures and provider results were known before this change. It is neither prospective nor held out. It does not change that report, its original 16-case denominator, or its accuracy results. It evaluates the current isolated unsigned engine, not the HTTP API or completeness of an asset inventory.

The inherited evidence manifest is SHA256 `d1c82c2237351ce871ab7a789d72aee264a5006b51c6f42c1207a9cf144ecd40`. Freeze copies the original manifest, plan, both exact request files, both exact oracle files and eight corresponding raw wire files. Every consumed original file must be a member of that manifest with identical bytes. No historical local poststate or predicted output is copied as execution input.

| Case | Transaction | Original parent hash |
| --- | --- | --- |
| 002 | `0x31cac6ebe975a4ca6666adf9b107fdb291af2cbeecbcf838397034e60daa03b8` | `0x49b97e395a7e594a00de1f8fc289717527962d2f3a0e6666966fa0d1398b2ce4` |
| 015 | `0xcb13cd67f13e57c3cd944c4ede2d9368a7e48c3a6a4aae8179f730c3a2c40314` | `0x8bb96024a59944582f335fd5577abd5234fecf7c579ddaafff622f6d0b6033e4` |

Each request retains its exact from/to/data/value/gas/access list and original primary-provider parent header. No latest lookup, new sender, replacement transaction, authorization list, nonce override, price lookup, signing or broadcast is permitted.

## Order and bounds

After a separately reviewed source freeze, run the archived entry point once using the externally supplied plan hash. An exclusive, fsynced `STARTED.json` prevents another attempt in the same directory. Only dRPC proof/code reads and cryptographically chained BLOCKHASH ancestry reads are available to the child. Proof/code reads use the original EIP-1898 hash with `requireCanonical:true`. Inputs are reverified against the selected header state root; header identity alone does not prove consensus or present canonicality.

For each fixed case, finish and drain the real isolated local worker; durably save `local.json` and `LOCAL_SEALED.json`; only then parse the inherited provider oracle and compare. Frozen-input integrity checks necessarily hash oracle bytes before execution, but no parsed provider trace/diff or expected local output is passed to execution. The old oracle was already known during development. The inherited bracket is not a fresh canonical-header observation.

Limits are 256 proof/code/ancestry calls and 32 MiB observed responses per case, 512 calls and 64 MiB shared; each response is limited to 8 MiB and each request to 25 seconds. Each local phase is at most 145 seconds, with the EVM's existing 120-second ceiling. Dispatch has an absolute and monotonic 330-second window followed by at most 25 seconds of terminal drainage, within a six-minute live ceiling. Offline final hashing/sealing is excluded. No retries, alternate providers, replacements or enlarged engine budgets. Every attempted wire, failed input, unavailable result and unattempted fixed slot is retained. A process/persistence/source failure marks the packet interrupted and suppresses usable comparisons. Host suspension never extends targets or budgets. A terminal verdict after drainage records both absolute wall elapsed time and monotonic elapsed time; either exceeding 355000 ms, either clock reversing at an observed check, or an invalid reading marks the packet interrupted and makes every comparison unusable. Final offline source hashing and sealing follow that verdict.

## Source and comparator provenance

The source archive includes the complete local/standard installed dependency trees, current local engine modules including the parent validator/helper, shared execution context, required cohort wire/proof helpers, this harness, and the exact Node executable identity. Replay imports only the verified archive and uses the exact same Node identity. No current working-tree VM import supplies replay behavior.

The freezer is adapted from ordinary-local `freeze.mjs` SHA256 `df93c1443c0ad78c17d47cd2754ef3fc1a55e49e3d13086b137a19fbc88990a9`; its inventory targets this new directory. The durable artifact helper is an exact copy of SHA256 `94691c4c867a855b1240e3168d1615dc682913b26cb4d1c7361d3b92372c7140`. The comparison module is copied from `outcomes.mjs` SHA256 `88837344fbc85df444256ed467eba0f0fa13e0e087a7e6408e71c1c528e3fe5e`, adding trusted-header `ethereumCommon(header)` to parent state validation and exact proof-derived delegated-sender semantics. Historical modules and sealed artifacts stay unchanged.

Five channels remain execution status, return bytes, committed logs, gas accounting and complete observed state changes. Unsupported or incomplete channels remain explicit; a captured completion is not a successful execution or a match. Provider semantics are not independently attested, and no full post-state root comparison is claimed for sparse public-state inputs.

## Offline verification

The verifier requires external evidence-manifest and plan hashes; checks all evidence/source inventories, exact original input membership, Node identity, request and raw response bytes, local broker/input proof joins, phase budgets and local-before-oracle seals; and recomputes each comparison from the archived modules. `--replay` additionally reruns completed worker attempts using only the sequential saved local proof/code/ancestry replies. It compares complete semantic output, input facts, usage, reads and changes; only host PID and host/broker/input elapsed durations are excluded after their types, positive spawned-process identity, and finite nonnegative phase bounds are validated. The complete audit also independently enforces the terminal wall and monotonic 355000 ms verdict. Failed provider replies stay failures. No new public request is available to replay.

The complete-audit path rejects interrupted packets with incomplete phase artifacts rather than manufacturing successful metrics. Original artifacts remain immutable; post-seal commentary or audits belong outside the capture directory.

Commands, only after separate source/plan approval:

```sh
node research/delegated-sender-development-v1/run.mjs freeze REPORT_DIRECTORY
node research/delegated-sender-development-v1/run.mjs check REPORT_DIRECTORY PLAN_SHA256
node REPORT_DIRECTORY/runtime/research/delegated-sender-development-v1/run.mjs run REPORT_DIRECTORY PLAN_SHA256
node research/delegated-sender-development-v1/verify.mjs REPORT_DIRECTORY EVIDENCE_MANIFEST_SHA256 PLAN_SHA256 --replay
```
