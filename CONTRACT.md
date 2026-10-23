# Initial module contract

Node 22 ESM, no runtime dependencies. Scope covers chain 999 Hyperlend USDC supply, withdrawal, variable-rate borrowing and repayment. Unknown contracts may expose event-derived movements, but must have partial or unsupported coverage. Do not infer security from successful execution.

## Decoder module

`src/analyze.js` exports `analyzeTrace({ request, trace, block, metadata, mode })`.

- request: `{ chainId, from, to, data, value }`, normalized lower-case addresses, value decimal string.
- trace: full JSON-RPC callTracer result. Child frames may contain `logs`, `calls`, `error`, `revertReason`, `gasUsed`, `output`.
- block: `{ number: decimal string, hash, timestamp: decimal string }` or null.
- metadata: map keyed by lower-case token address, values `{ address, decimals, symbol, name }`; baseline trusted known assets provided by root.
- mode: `simulation` or `historical_trace`.

Return an object with:
`execution: { status: 'success'|'reverted'|'failed', gasUsed: decimal string|null, returnData, error: string|null }`,
`coverage: { status: 'supported'|'partial'|'unsupported', reasons: string[] }`,
`protocol: { name, operation, ...decodedFields } | null`,
`inAssets`, `outAssets`: arrays shaped `{ asset: {address,decimals,symbol,name,type:'ERC20'}, transferIn: [{rawValue: hex, value: exact decimal string|null, summary, basis:'transfer_event'}], transferOut: [...] }`.
`movements`: decoded raw event movements with from/to/address/amountRaw, no fabricated net-balance claim.
`interestAccruals`: decoded Hyperlend Mint balanceIncrease fields, human-readable amounts where decimals known.
`warnings`: string[].
`security: { status: 'not_assessed', findings: [] }`.

Reverted executions may include `execution.revert`, decoded from contract return data. This is contract-reported information, not an independently verified diagnosis.

Logs in reverted call subtrees must not create movements. Entire failed transaction yields no successful asset movements. Token amounts use BigInt exclusively. No `Benign` classification. HyperCore CoreWriter calls must flag incomplete HyperCore coverage even if EVM succeeds.

## API and UI

- GET `/api/config`: `{chains:[{chainId:999,name:'HyperEVM'}], examples:[{id,label,request,transactionHash?}], capabilities, projectStatus}`.
- POST `/api/simulate`: body `{chainId:999,from,to,data,value:'0',block:'latest'|hex}`.
- POST `/api/replay`: body `{chainId:999,transactionHash}`.
- GET `/api/benchmarks`: last benchmark report or `{status:'not_run'}`.
- GET `/api/health`: local health.

Successful transport returns `{schemaVersion:'1.0',id,createdAt,request,source:{provider,chainId,blockNumber,blockHash,timestamp,mode,blockBinding},...analysis,timing:{totalMs,rpcMs},evidence:{traceMethod,traceRequest,traceResponse}}`. Execution revert can be HTTP 200 with execution.status=reverted. Invalid input=400, provider failure=502 with `{error:{code,message}}`. UI must distinguish those from empty successful previews.

Server owns request validation, read-only RPC method allowlist, block selection, chain verification, limits, and report files. No endpoint signs or broadcasts. UI does not require Dynamic authentication. Security assessment visibly separate from execution. Portfolio balance change is not inferred from Transfer events; show event-derived movements with explicit principal/interest when available.

## Measured balances

`src/balances.js` exports `measureBalances({request,block,rpc,metadata,analysis,stateContext?})` for supported Hyperlend USDC supplies. Its public result becomes `balanceChanges`: `{status:'measured'|'unavailable'|'not_applicable',basis,assets,warnings,executionIdentity?}`. Each asset records token metadata, account, exact decimal-string `beforeRaw`, `afterRaw`, `deltaRaw`, and formatted `before`, `after`, `delta`. Raw integer fields use decimal notation; event `rawValue` fields retain hexadecimal notation for compatibility.

For current simulations the module traces state changes, constructs ephemeral overrides, reads balances at the same block hash and timestamp, and checks canonical block identity. Unsupported account/code changes, malformed results and inconsistent state return `unavailable`, never fabricated zero deltas. No on-chain state is changed. Historical replay supplies the separate context described below.

The module's RPC request/response evidence is stored at `evidence.balanceMeasurement`. `inAssets`, `outAssets` and `movements` remain event-based; consumers must select the appropriate field rather than summing both.

## Permission observations

`src/permissions.js` exports `analyzePermissions({request,trace,metadata})`. The server returns its result as `permissions:{scope,coverage,observations,findings,warnings}`. Requests and emitted Approval events are separate observations with exact owner, spender and raw allowance, correlation IDs and frame locations. Only configured chain-999 USDC/hUSDC contracts receive verified ERC20 interpretation. Unknown contracts remain unverified.

`coverage.allowanceStateVerified` is false for observations alone; the server sets it true only when `allowanceChanges.status` is measured and records the measured-pair scope. Maximum-allowance and mismatch findings describe narrow evidence and do not supply a general safety verdict. Reverted call trees contribute no committed approval observations. The separate `security` field remains `not_assessed`.

## Final allowances and shared state

`src/state.js` creates a lazy request/block/provider-bound context, shared by balance and allowance measurements. It performs one prestate trace, preserves untouched storage, clears deleted slots, accepts valid empty diffs, and rejects unsupported code/account changes. Evidence entries carry IDs so concurrent request/response pairs remain attributable.

`src/allowances.js` exports `measureAllowances({request,trace,block,rpc,metadata,analysis,permissions,stateContext?})`. `allowanceChanges` returns status, basis, warnings and `allowances` with asset, owner, spender, beforeRaw/afterRaw/deltaRaw, formatted values, beforeKind/afterKind (`zero`, `bounded`, `uint256_max`), changed, observation IDs and final-state/event consistency. At most eight pairs and 256 permission observations are accepted. Debt-token allowances are unsupported, not zero. A true measured result applies only to the listed pairs, not all possible permissions.

## Lending positions

`src/lending.js` decodes and reconciles withdrawal, variable borrow and repay against Pool events, USDC transfers, receipt/debt events and scaled-token calls to verified implementations. `protocol.actualAmountRaw` is the executed cash amount; `amountRaw` is requested. `amountMode:all` denotes the max sentinel on withdraw/repay. `positionDeltaRaw` is a signed event-implied delta after removing already-accrued interest, validated against rounding bounds derived from traced scaled amounts and indexes. `protocol.reconciliation.status` indicates whether those observations reconcile.

`positionChanges` records event-based position evidence. A variable-debt token has `role:liability` and `transferable:false` in measured asset metadata. Its events remain in raw movements but are excluded from spendable `inAssets`/`outAssets`. A repayment may emit Mint while reducing debt if accrued interest exceeds repayment; the signed position change determines direction.

`src/lending-balances.js` measures all involved accounts across USDC, hUSDC and variable USDC debt, including labeled reserve custody. Exact deltas must reconcile to actual cash and event-implied position changes. Unexpected unrelated changes make measurement unavailable. Both measurement modules accept the same lazy context interface for current or historical reads.

## Historical position measurements

`createHistoricalStateContext({request,block,rpc,transaction,receipt,trace})` in `src/historical-state.js` exposes `matches`, `prepare`, `readPair`, `verifyCanonical`, `snapshotEvidence`, `executionIdentity`, and immutable `measurementBasis`. A historical `balanceChanges.basis` is `historical_transaction_position_balanceOf`.

The context binds the original transaction, receipt, full block transaction list and canonical header. It independently runs the original unsigned call at its zero-based transaction index with `debug_traceCallMany`, comparing semantic trace fields, per-frame gas used and receipt event content. Input-gas annotations may differ between RPC wrappers and are excluded from that comparison. Original account creation/deletion and code changes are outside scope.

Before/after token reads run as independent single-call bundles at indexes `i` and `i+1`. They use the original effective gas price; block-header witnesses verify number, timestamp, gas limit, base fee, randomness, coinbase, chain ID and parent hash. Token query call shapes must match the configured proxy/implementation behavior, return one uint256, and produce only validated nonce and native-fee effects. Sender nonce must equal the original nonce before, and original nonce plus one after. Queries never run ahead of the original transaction in a shared bundle.

Historical `executionIdentity` includes transactionHash, transactionIndex, postTransactionIndex, stateBlockHash, blockNumber, timestamp, `stateBinding:'block_hash_and_transaction_index'`, `headerContext:'original_block'`, `method:'debug_traceCallMany'`, and validation details. Limits are twelve token/account pairs, sixty-four RPC calls, 8 MiB per response and 32 MiB accumulated result evidence. Unknown token implementations, unsupported envelopes, provider capability failures and failed consistency checks produce unavailable measurements with empty assets and retained bounded evidence. Historical allowance measurement remains `not_applicable`.

No credentials or authentication tokens belong in reports. Raw evidence is restricted to public blockchain requests/responses.
