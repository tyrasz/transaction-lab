# Verified current-state queries: proposed next milestone

Status: design only, October 26, 2026. No new RPC requests, signatures, broadcasts, or implementation changes were made for this plan. The v0.7.0 implementation remains frozen at SHA-256 `7658ae0d03d6b17f72045905d231e9803b6ab38d57b4cac3a88d2eec19b5ff10`.

## Decision and scope

Keep generic current affected-account balances unavailable until **both the before and reconstructed-after queries have validated execution paths and mutation behavior**. A successful Transfer from a recognized implementation does not prove which implementation a later balance query will execute. A transaction can alter proxy or dependency storage after emitting that event. Rejecting writes to a list of known proxy slots does not establish the behavior of every dependency.

The proposed reader measures only configured chain 999 USDC, hUSDC, and variable USDC debt balances. USDC/hUSDC allowances use the same query machinery because those consumers share the state context. Debt remains a liability and is never an allowance target or spendable asset. Unknown token events stay explicitly unmeasured. This expands account coverage, not chain coverage, transaction authorization verification, a security score, or an accuracy claim.

Use four isolated `debug_traceCall` requests per distinct query: callTracer plus prestateTracer diff before, and the same two tracers with the original call's complete state overrides after. Read the uint256 from the validated callTracer output. Do not keep two additional production `eth_call` requests: six requests per query would exceed the 64-call budget at 12 pairs.

## What the saved evidence proves

| Evidence | Established observation | Remaining gap |
| --- | --- | --- |
| [Current v0.6 captures](../../reports/live/v0.6-current-transfer-checks.json) | At recorded block 49536896, supply changed sender USDC by `-15066115`, hUSDC by `15066114`, and allowance by `-15066115`. The original diff increased sender nonce `82526 → 82527` and reported no sender native balance change. | The balance/allowance reads are `eth_call` results. Their implementation paths and their own diffs were not captured. The original supply's nonce behavior does not prove the query behavior. |
| [Original capability captures](../../reports/capabilities/poststate-capability-probes.json) | Both providers accepted original-call diffs and `eth_call` overrides. At block `0x2f084d6`, pinned hUSDC observations were `5677663051 → 5692729166`. | These known supply examples do not validate arbitrary current roots or upgraded query dependencies. |
| [Stateful capability notes](../../reports/capabilities/STATEFUL-BALANCES.md) | Moving the simulated timestamp forward one second changed absolute hUSDC observations by ten raw units, even when the supply delta matched. | A matching delta alone is insufficient evidence of identical state/header context. |
| [Historical header investigation](../../reports/historical-state/README.md) and [priced evidence](../../reports/historical-state/priced-header-validation.json) | On the tested historical CallMany route, an unpriced witness returned BASEFEE zero; the original effective gas price restored all eight tested header fields. | This is not evidence that current `debug_traceCall` has identical fee or header behavior. |
| [Frozen historical account captures](../../reports/affected-balance-comparisons/capture.json) | Validated original-position balance queries exist for direct transfers, router activity, and lending. | Historical position semantics, transaction nonce checks, and signed-transaction fee context must not be relabeled as current-call proof. |

The current sources relevant to this change are [state.js](../../src/state.js), [historical-state.js](../../src/historical-state.js), [affected-balances.js](../../src/affected-balances.js), and [server.js](../../src/server.js). The current context checks uint256 return shape but does not inspect query call paths. The historical context already validates those paths and separately validates the query's fee/nonce effects.

## Execution binding and original poststate

1. Resolve the requested block once, then bind the normalized original envelope, original call trace, complete block header, chain ID, and RPC instance to one immutable context. Hash/number/timestamp must agree. Never substitute `latest`, a parent block, or a synthetic next block after preparation.
2. Use one explicit pinned hash representation for the original callTracer, original prestateTracer, query tracers, and state/code reads. Prefer `{blockHash, requireCanonical:true}` where the tested provider accepts it. The existing original trace uses a bare hash and the diff uses an EIP-1898 object; do not assume that a provider treats different wrappers identically. The capability stage must verify the chosen binding. There is no silent numeric-block fallback.
3. Pass the exact normalized original call envelope to both original tracers: from, to, data, zero native value for this new generic scope, gas limit, and the agreed fee/nonce policy. Existing gas is 5,000,000; the proposed change must not quietly replace it with a different envelope. Obtain the original trace and diff against the same context. If a new envelope policy changes execution, version the API behavior and recapture evidence rather than comparing it to the old trace as though unchanged.
4. Validate the original trace's request identity and success. Inspect **all** branches, including reverted children, for CREATE, CREATE2, and SELFDESTRUCT before making additional state RPCs. Final diffs can omit temporary lifecycle effects. Unsupported envelopes, authorizations, native-value roots, account/code changes, and unsupported root behavior remain outside the initial generic scope.
5. Establish that a generic root is a contract at the pinned state. A nonempty runtime-code observation is sufficient for this root classification; it is not a claim that the root contract is trusted. Recognized movement/permission candidates still require their existing token provenance. An arbitrary supplied analysis object is not evidence.
6. Reuse `buildStateOverrides` without relaxing its account, code, storage, or numeric bounds. Include every changed account and field. Preserve changed balance and nonce; apply all changed/inserted slots with `stateDiff`; translate every pre-only cleared slot to zero. Do not use `state`, which replaces untouched storage. An empty diff is legitimate. Reject unsupported account creation/deletion and runtime code changes.
7. The reconstructed state is the result of that unsigned call under its declared environment. It is not a mined next-block prediction or a transaction-inclusion guarantee. Candidate event amounts remain event-derived; no event-to-balance substitution is allowed.

Geth exposes `stateOverrides` and `blockOverrides` in `TraceCallConfig`; that documents an API surface, not these public endpoints' exact behavior. Its documentation also describes transaction-index selection, which earlier local probes found unreliable on some paths. Test the actual wrapper rather than inferring support from the method name. [Geth debug RPC](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-debug#debug_tracecall).

Diff mode omits untouched accounts, includes unchanged basic fields in pre records, and uses missing post storage entries for cleared slots. Preserve the existing interpretation of pre-only `code` as potentially unchanged. [Geth prestateTracer](https://geth.ethereum.org/docs/developers/evm-tracing/built-in-tracers#prestatetracer). Slot-level `stateDiff` and full-storage `state` have different meanings. [Geth override objects](https://geth.ethereum.org/docs/interacting-with-geth/rpc/objects#state-override-set).

## Exact query contract

Normalize addresses and calldata before caching; reject coercible non-string values. Accept exactly canonical `balanceOf(address)` calldata, selector `0x70a08231` followed by one zero-padded address. For shared allowance consumers, accept exactly `allowance(address,address)`, selector `0xdd62ed3e`, with two zero-padded addresses and only USDC/hUSDC targets. No trailing bytes, alternative ABI encodings, arbitrary selectors, or arbitrary tokens.

Each query uses the original external sender as `from`, the configured token as `to`, explicit zero value, and a 300,000 gas ceiling. The account encoded in calldata can differ from that sender. Fee/nonce fields follow the independently validated current profile below; there is no synthetic transaction index or invented original signed-transaction nonce.

For each query `Q`, issue these four independent calls at the same pinned block:

| Observation | Tracer configuration | State overrides |
| --- | --- | --- |
| Before output/path | `callTracer`, `withLog:true`, bounded timeout | None |
| Before mutation check | `prestateTracer`, `diffMode:true`, bounded timeout | None |
| After output/path | `callTracer`, `withLog:true`, bounded timeout | Complete original-call overrides |
| After mutation check | `prestateTracer`, `diffMode:true`, bounded timeout | The identical complete original-call overrides |

For `debug_traceCall`, `stateOverrides` belongs in the third configuration argument, next to `tracer` and `tracerConfig`; it is not the third positional `eth_call` override argument. Each call is a fresh execution. Never execute the query sequence together, apply a query's own diff to another query, or feed the before query's nonce change into the after query. The after query diff is relative to the already-overridden starting state.

Validate the root and every child: recognized frame type, exact from/to/input/value, strict string fields, bounded quantities, successful execution, no logs, exact child count and call order, and no unexpected fields under the selected schema. Require exactly one 32-byte root output and identical output on the token delegate frame. Interpret amounts as BigInt; a legitimate zero result is valid. Reject errors, reverts, malformed/non-word output, extra calls, or changed implementations even when the returned number equals an expected event delta.

### Fixed token and reserve-index paths

| Query | Required path after root CALL to token |
| --- | --- |
| USDC balance or allowance | One DELEGATECALL from USDC to USDC implementation, identical input/output, no children |
| hUSDC allowance | One DELEGATECALL from hUSDC to hUSDC implementation, identical input/output, no children |
| hUSDC balance | DELEGATECALL to hUSDC implementation; exactly one STATICCALL from hUSDC to Pool with `0xd15e0053` + canonical USDC argument; exactly one Pool DELEGATECALL to Pool implementation |
| Variable debt balance | DELEGATECALL to variable debt implementation; exactly one STATICCALL from debt token to Pool with `0x386497fd` + canonical USDC argument; exactly one Pool DELEGATECALL to Pool implementation |

Reserve-index results must be positive uint256 words, with identical output from the Pool proxy and implementation frames. An index remains part of the balance calculation; event net movement is not a replacement for that calculation.

The existing address configuration to preserve is:

| Role | Address | Implementation |
| --- | --- | --- |
| USDC | `0xb88339cb7199b77e23db6e890353e22632ba630f` | `0x003f73f58ca78880da3642c5cb71d7459b3fe4f8` |
| hUSDC | `0x744e4f26ee30213989216e1632d9be3547c4885b` | `0x410aa1ab680b886c875e99a7a4bfaf188508a7a3` |
| Variable USDC debt | `0xd612513cb3b2c52abcd6d4b338374c09ada4657d` | `0x8158e5569475a443a5723ccac462930f590449ed` |
| Pool | `0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b` | `0xbebb62c7ff8b96db4325d9481c44e09a92d49b06` |

Before accepting stronger runtime-code identity claims, freeze reviewed runtime bytecode hashes for these dependencies and compare pinned `eth_getCode` results, caching each address per request. The current historical validator verifies configured addresses and execution paths; it does not freshly compile or attest their source. Document that distinction. Any new code-hash requirement is an additional current validation gate, not evidence that historical records already performed it. Original lifecycle/code rejection lets a pinned code observation cover before and post-override execution; proxy/dependency **storage** changes are still checked through both actual query paths.

## Current header, nonce, and fee profile: release blocker

Historical queries are temporary transactions at `i` and `i+1`, using the original effective gas price and validated original nonce progression. Current unsigned calls start from a pinned state and have no original receipt or transaction index. The current server omits gasPrice, and its recorded original diff includes a nonce increment with no native debit. Do not copy historical `gasUsed × originalGasPrice` checks or assume an empty current query diff.

Run a bounded capability stage before choosing the production profile:

- Repeat the **existing** unpriced original envelope and query envelope on both providers at the same recorded block hash. Capture every callTracer and query diff, not only outputs. Obtain sender nonce/native balance at that state, including the effect of original poststate overrides for the after query. Query sender equal to fee recipient, code-bearing sender, nonce overflow, and other ambiguous cases may remain unsupported.
- Use isolated read-only header witnesses before and with the complete poststate overrides. Check NUMBER, TIMESTAMP, GASLIMIT, BASEFEE, PREVRANDAO, COINBASE, CHAINID, and BLOCKHASH(number−1). A witness uses an isolated reserved address/code override, disjoint from original/query accounts; it is never carried into production token query overrides. It must not replace any original override entry silently. Witness failures are retained.
- Compare the same selected block against direct state reads and a recorded state anchor that differs from parent state. A header match alone cannot distinguish block-end from parent-state execution. Validate that hash-bound original traces, diffs, and direct queries resolve the intended current base state. Do not infer this from inconsistent documentation wording.
- Define one exact supported current query-diff profile from source semantics and raw observations. A likely profile is a sender-only nonce increment with zero native transfer, but this is **unverified for queries**. Validate expected before nonce, exact increment, and exact permitted native balance effects. Reject all token/Pool storage writes, unrelated account changes, code fields on changed contract accounts, account lifecycle effects, or unexpected fees. Do not accept a broad union of empty, nonce-only, and arbitrary fee diffs just to make providers pass.
- If unpriced calls alter BASEFEE or another header field, either explicitly retain a scoped synthetic call environment shared by original execution and all queries, or change the entire original/diff/query envelope consistently and revalidate it. Merely adding gasPrice to the queries would create a different environment. Do not label that result `headerContext: unchanged`. A stronger exact-header claim requires witnessed equality under the production envelope.

The selected profile needs an identifier and explicit fields in `executionIdentity`, including the base block hash, block number/timestamp, normalized original envelope fingerprint, state-override fingerprint, fee policy, observed header context, and query validation scope. No implementation should be enabled until this profile is defensible. Failure or absence of evidence keeps the existing current affected-balance gate.

## Pure validator extraction without historical regression

Extract only transport-independent normalization and strict known-query frame validation into a new pure module. Inputs are a single trace object, normalized query, expected sender, and fixed known configuration. Return the uint256 output and traced gas used. Preserve all present checks, strict field types, frame/log bounds, required child paths, and failure handling.

Keep wrappers separate:

- Historical: exactly one CallMany bundle containing one result; original transaction/receipt checks, full transaction-array index validation, original semantic replay, original effective fee context, priced header witnesses, and strict original-position nonce/native checks stay in the historical adapter.
- Current: exactly one trace object from debug_traceCall, paired with its query diff under the current profile and explicit overrides. It cannot opt out of child validation or reuse the historical position label.
- Common code may validate pre/post object syntax and reject forbidden mutations. The precise allowed sender/miner nonce/native effects remain explicit profile-specific validators. No permissive `ignoreFees`, `allowAnyImplementation`, or `skipMutationCheck` switch.

Run all frozen historical regressions with unchanged raw provider responses after extraction. An extraction that changes accepted cases, rejected controls, request order, or measured amounts requires separate review; it is not a mechanical refactor.

## Resource budget and shared-context behavior

The existing limits remain hard ceilings: **12 distinct token/calldata queries per shared context, 64 state-context RPC calls, 8 MiB per response, and 32 MiB retained response evidence**. The affected module still counts at most eight total candidate token/account pairs, including reused base pairs. Allowance owner/spender queries and balance account queries share the 12-query budget. Unknown token events do not consume it. No truncation or replacement candidates.

| Cost | Calls |
| --- | ---: |
| Each distinct validated query | 4 |
| Twelve queries | 48 |
| Pinned header + original diff | 2 |
| Before/after header witnesses if required per request | 2 |
| Independent starting sender nonce read if required | 1 |
| Existing consumer canonical checks, at most three | 3 |
| Remaining capacity for code identity/root proof or other necessary preparation | 8 |

Thus `4 × Q + preparation + identity checks + canonical checks ≤ 64` must be calculated before the query phase. Eight proxy/implementation dependencies fit the final eight slots only when no other preparation call is needed. A generic root may need an additional code proof; if it pushes a 12-query request over budget, report unavailable before starting its queries. Do not silently drop runtime checks, raise limits, or claim every 12-query request must complete. Code observations and duplicate query promises are shared across consumers. Ordinary supply and router cases use fewer than 12 distinct queries.

These 64 calls bound the context, not chain verification/block selection/original trace requests already made by the server. The live runner needs a separate total HTTP/RPC budget. Before implementation, reserve capacity for all required canonical checks so a full query budget cannot prevent verification. Keep bounded frame count 1000, depth 32, logs 2000, original diff accounts 100 and slots 2000. Measure UTF-8 bytes, not JavaScript string length. Four calls per query also increase latency; retain RPC deadlines and a bounded overall request deadline rather than assuming sample provider latency.

Preserve the shared promise cache: key is normalized token address plus exact calldata, bound to one immutable context and RPC instance. In-flight, completed, and failed queries must not be rerun by another consumer. A reused base measurement is accepted only after identity/basis checks and the same context's successful `readPair` proof.

Preserve canonical failure latching and finalization: any failed canonical recheck, including RPC failure, invalidates every measured consumer from that context. A later success cannot clear it. Query-specific failures do not automatically invalidate unrelated successful measurements. Refresh complete evidence snapshots only after all consumers settle; do not expose pending evidence as final. All measured amounts and reused-pair references are withheld on a canonical failure.

Sanitize provider error objects before retaining evidence, including success envelopes containing errors. Keep valid EVM frames with ordinary revert strings. Terminal timeout, non-JSON, size-limit, and local validation failures need fixed safe diagnostics. Never save arbitrary exception messages, request URLs with credentials, or fabricated replacement responses.

## Validation matrix

Offline tests come first. Mutated traces are explicitly synthetic fault controls, never presented as independent chain observations.

| Group | Required controls |
| --- | --- |
| ABI and identity | Noncanonical padding; extra bytes; unknown token/selector; debt allowance; coercible array/object strings; root sender/value/input mismatch; mutated request/block/context; owner/recipient different from submitter. |
| Query path | Valid before and unknown after implementation; changed Pool implementation; altered reserve argument/index; zero/non-word index; extra child; missing delegate; logs; revert; malformed uint256; valid number with wrong path. Include USDC and both position-token branches. |
| Override fidelity | Cleared slot becomes zero; inserted slot; untouched slot survives; empty original diff; nonce-only original diff; all changed accounts applied; missing dependency override; code/account changes; temporary lifecycle even in reverted original subtrees. |
| Query mutation | Token or Pool storage write despite correct output; write then clear/restore; unexpected calls; nonce mismatch; native debit/tip mismatch; sender equals beneficiary; code-bearing sender; malformed diff; ignored after overrides. Final diffs alone cannot expose every temporary write, so fixed known runtime/path validation is also necessary. |
| Context | Wrong block hash/number/timestamp; parent-state anchor mismatch; changed header field; synthetic BASEFEE difference; same delta with different absolute position balances; reorg before/after reads; late canonical failure clears all consumers/reuse. |
| Budgets and errors | Exact 12-query boundary and thirteenth rejection; eighth/ninth affected candidate; repeated concurrent pair consumes four calls once; reserved canonical capacity; 64-call boundary; 8/32 MiB UTF-8 limits; poisoned nested provider errors; timeout; no-RPC lazy unsupported/reverted cases. |
| Regression | All frozen historical query/replay tests unchanged; existing current known-supply amounts preserved under the same envelope; unrelated affected query failure preserves valid base/allowance measurements; failed original execution remains distinct from unavailable query measurement. |

Proposed subsequent public read-only validation is a **predeclared matrix**, not a retry-until-green exercise. Record source fingerprint, pinned block hash, exact request/response bytes, all failures, deadlines, and counts. Run both dRPC and Hyperlend archive against the same pinned state. Do not submit signatures or transactions.

1. Capability matrix: one recorded successful supply block for USDC, hUSDC, and allowance query profiles; one recorded borrow/repay block for variable debt/Pool dependency; both providers. Establish header/nonce/fee behavior before implementing an acceptance rule. An independently specified second fee profile may be a separate probe, never an undisclosed fallback.
2. Production integration matrix after source freeze: supply, withdraw, borrow, repay, direct transferFrom, and generic router examples. Use recorded known-success state anchors for deterministic development controls and separately declared latest-state calls for freshness. A latest-state revert, expired permit, nonce change, or spent allowance is retained as that outcome; do not replace its wallet or block.
3. Explicit negative current query probes using ephemeral overrides: unknown token/Pool implementation, state-changing query stub, and deliberately ignored/mismatched override control. These controls belong to a separate research harness and never enable arbitrary code overrides in the public API. Preserve original and mutated request provenance separately.
4. Freeze numerical expectations from raw validated outputs, including absolute before/after values, then compare measured event nets separately. hUSDC accrual differences, rounding, and zero-net router balances remain visible. Cross-provider equality is corroboration, not an independent execution-engine or state-proof oracle.

Do not choose live call counts now by assuming all preparations succeed. Before any network run, write a bounded manifest using the implemented RPC plan, enforce per-run and whole-sequence time/byte/call limits, and prohibit retries and replacement cases. This document authorizes no live run by itself.

## Release conditions

Enable the current gate only after the selected provider profile, known paths, state-override fidelity, shared budgets, failure isolation, and canonical invalidation all have saved passing controls; unsupported provider behavior remains unavailable. Report the new current basis explicitly, for example `current_pinned_state_validated_query`, with the actual header/fee profile. Keep `historical_transaction_position_balanceOf` unchanged.

Evidence must support the narrow statement: configured token values were queried before and after one simulated call at the declared pinned context, with the observed query behavior validated. It must not claim full EVM coverage, independently verified authorization, native-fee accuracy beyond the tested profile, or security superiority. Preserve v0.7 captures as prior evidence and recapture only the newly declared next-milestone matrix.
