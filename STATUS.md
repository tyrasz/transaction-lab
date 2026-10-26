# Transaction Lab checkpoint — 0.8.0

Updated October 26, 2026. The long-term goal remains active. **No representative 90% accuracy rate or superiority to Blockaid has been established.** This is a working prototype with narrow measured coverage, not a general EVM simulation or security product.

The app runs at http://127.0.0.1:5174/ without a wallet connection or Dynamic authentication. Its local health check confirms version 0.8.0, and the updated preview loads in the browser. Public RPC nodes execute EVM calls; the service owns interpretation, supported state measurements, validation and evidence retention. Security remains `not_assessed`. No signing or broadcasting occurs.

## Current-call measurements

The service now validates configured token queries before and after an unsigned call. The original trace and complete state diff use the same fixed envelope and canonical block hash. Each balance or allowance query has an isolated execution trace and mutation diff on both sides; after-state queries reuse the complete original overrides. Configured USDC, hUSDC and variable-debt query paths, sender nonce transitions and unchanged query native balances must pass validation. Preparation, deadline or canonical failures invalidate shared measurements together.

This enables affected-account measurements for current simulations, including observed owners and recipients other than the submitter. It does not discover silent changes or arbitrary tokens. Path validation is not runtime-bytecode attestation. The supported profile is zero-native-value calls from code-free senders, with synthetic BASEFEE zero and omitted gas price. It does not validate signed transactions or estimate network fees. Limits are twelve distinct queries, 64 context RPC calls, bounded evidence and a 120-second scheduling window; a pending standard transport call can extend that window by at most 25 seconds.

## Latest live evidence

Eight preselected requests ran once against two public providers using **196 read-only RPC calls**, with no retries, replacements, skips or transport failures. All eight returned HTTP 200; six produced measured results and two reported reverted execution. These are current-call simulations at fixed historical block-end states, not original-position replay or predictions against today's state. [Raw capture](reports/current-validated-decimal/capture.json), [findings and verification](reports/current-validated-decimal/NOTES.md).

| Case | Both providers reported | Measured effects |
| --- | --- | --- |
| Hyperlend supply | Successful execution | Sender USDC −15.066115; hUSDC +15.066114; reserve cash +15.066115; allowance −15.066115 |
| Hyperlend borrow | Successful execution | User USDC and variable debt +835.474410 each; reserve cash −835.474410 |
| USDC transferFrom | Successful execution | Owner USDC −1.277067; recipient +1.277067; allowance −1.277067 |
| Router at the original block's parent state | Reverted execution | No measured balances or allowances; reverted events discarded |

All thirteen queried balance/allowance pairs agree across providers. Twelve of fourteen predeclared provider/query references were measured and matched earlier same-state recordings; the other two were an unqueried borrow allowance, not assumed zero. The six measured runs took 0.732–12.418 seconds in this small batch; this is not a production latency benchmark.

Both router traces report an out-of-gas child call to HyperCore precompile `0x0000000000000000000000000000000000000801`, followed by custom error selector `0x062879da`. Its meaning is unverified. The result applies to the fixed parent-state, unpriced, five-million-gas envelope; it does not establish how the original transaction or a differently specified call would execute. No gas or state adjustment was attempted.

The first capture client incorrectly sent hexadecimal `value: "0x0"` to an API requiring decimal `"0"`. All eight requests were rejected before any RPC. That failed packet remains intact. A separately frozen corrected plan changed only that encoding and added actual API-validator preflight. [Preserved input failures](reports/current-validated-comparisons/NOTES.md).

Frozen 0.8.0 core SHA-256: `2205334781a09baf98c3f5cb05a546bcca7d4946aea33b510d1963c8eb561a0f`. Corrected capture SHA-256: `bcb186b6a3a44d94be91ad74aa9b61b83a116ea06d0ada6834d2b19da028770b`. Exact HTTP/RPC bodies, request parameters, byte counts and hashes are retained. Separate review checked all 196 raw RPC responses and 400 shared measurement evidence entries. Two endpoints do not establish independent execution engines or cryptographic state proof.

## Regression and historical evidence

The full main regression suite passes **441/441 tests**, including eighteen new v2 evaluator tests. The core's previous checkpoint passed 423 tests; its implementation is unchanged. Ten of those tests preserve all eight current-call outcomes, reproduce the exact 196 recorded RPC requests/responses and completion order, and retain the earlier input rejections. Separate prior recordings anchor known supply/borrow quantities; response checks retain all semantic and evidence fields. The decoder benchmark's last run passed **14/14 development cases**: ten observed traces and four synthetic controls. Test counts are not transaction accuracy rates. The isolated executor has its own suite and evidence below.

The previous 0.7.1 historical packets remain unchanged: **15 selected replay requests, 14 with supported measurements and one withheld**, totaling 506 RPC calls. Historical measurements require exact complete original/replay state-diff agreement, not just matching traces or deltas. One real within-run provider block-list inconsistency correctly cleared earlier measurements. [Historical matrix](reports/replay-state-comparisons/NOTES.md), [separate archive withdrawal control](reports/replay-state-archive-withdraw/NOTES.md).

## Broader coverage and next work

The first unfiltered prospective pilot remains **selection_failed**: providers returned five versus eight transaction hashes for the same block. No cohort or transaction accuracy denominator was accepted; metrics remain null. [Unchanged pilot](reports/coverage-evaluation/2026-10-26T04-23-53.888Z-c78b7336/NOTES.md).

A pure normalizer preserves every ordinary/system transaction occurrence and classifies recorded response views without assuming an endpoint's ordering convention is permanent. On two explicitly composite offline fixtures it resolves eight action identities from eleven distinct hashes. An incomplete fixture remains unresolved. All replay boundaries remain unknown. [Normalization evidence](reports/block-view-normalization/NOTES.md).

A separate [v2 prospective evaluator](research/coverage-evaluation/PLAN-V2.md) now integrates ordinary/system enumeration, retains unresolved occurrences and charges unsupported rows to its attempt limit. It preserves the v1 runner and failed pilot. Independent offline review found and corrected partial-header occurrence loss, incomplete header comparison, UTF-8 byte-retention differences, fallback lookup omission and unexpected inline anchor objects. Its eighteen focused tests pass; **no v2 live cohort has run**, so there is still no accepted broad transaction-accuracy denominator.

## Experimental local execution

An isolated executor now uses pinned **EthereumJS 10.1.3** to run bytecode locally. It is separate from the unchanged provider-backed API and browser preview. Its sparse input adapter requires explicit account/code/storage facts; missing reads stop execution and roll back its changes. It does not construct initial state from expected call traces or state changes. [Executor documentation](engines/local-evm/README.md).

One fixed USDC `transferFrom` was captured from two public endpoints using 18 read-only requests. Both local runs succeed and match the provider outputs: 51,268 total gas under the declared intrinsic-gas rule, two entered call frames, one committed log, sender nonce +1 and three changed USDC storage slots. Owner and recipient balances change by −1.277067 and +1.277067 USDC; the allowance decreases by the same amount. This is **one selected transaction executed twice**, not two independent examples or a representative accuracy score. [Captured inputs](reports/local-execution-state/NOTES.md), [current local execution evidence](reports/local-execution-comparison-v2/NOTES.md).

All **58 isolated executor tests** pass. Independent review tightened source-block/parent binding, committed-state disposition, frame-field normalization and log ordering. The first sealed report and its exact original sources remain reproducible through the archived-source verifier; a separate second report records the corrected comparator with unchanged real-case outcomes. Both reports reproduce offline, including five separate synthetic fault controls. Latest result SHA-256: `c2eec4623db8890e21cdff02cdd31f0249c055e3485abdf026784c4ae81df803`.

The local profile remains zero-value unsigned Cancun execution with synthetic BASEFEE zero, no fee settlement and a provider-supplied sparse state witness. State is not cryptographically proven. HyperCore precompiles, CoreWriter, creation/destruction, blob context and uncaptured ancestor/state reads remain unsupported. Execution limits are cooperative; operating-system isolation is not implemented. The experiment therefore does not yet provide an arbitrary-transaction local simulation service.

Next work is broader local execution fixtures, stronger execution isolation and a separately frozen v2 live evaluation that retains unsupported cases. General native-asset effects, NFTs, arbitrary token behavior, other chains, permit signature verification, system-action replay and broad threat detection remain incomplete or unsupported. Security research has one LI.FI development effects reference, zero security scoring cases and zero blind holdouts. No paid infrastructure, external publication or fund movement has occurred.
