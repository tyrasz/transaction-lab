# Experimental local EVM execution

This package executes bytecode locally using pinned EthereumJS 10.1.3 packages. It is separate from Transaction Lab's provider-backed API and browser preview. It includes the original HyperEVM development profile and a new Ethereum mainnet reference with proof-verified initial state. Neither profile is a signed-transaction validator or security classifier. [Upstream EVM documentation](https://github.com/ethereumjs/ethereumjs-monorepo/tree/master/packages/evm).

From the project root:

```sh
npm ci --prefix engines/local-evm --ignore-scripts
npm run test:local
```

Dependencies and integrity hashes are pinned in this package's lockfile. The primary service's dependency-free runtime remains unchanged.

## Ethereum reference

The independent input path uses `verifyEthereumHeader({header,expectedHash})`, `createRpcStateInputs({chainId:1,blockHash,header,rpc})`, `createProofStateManager({inputs})`, and `executeEthereumCall({request,header,stateManager})`. The request contains only `{from,to,data,value,gas}`. Callers retain the header verification and input-proof evidence alongside the execution result; the executor alone does not claim to authenticate its state manager.

The header verifier recomputes the exact RLP/Keccak execution-header commitment, including the active Shanghai, Cancun and Prague fields. It binds the state root and execution fields to an externally selected block hash. It does not verify consensus, finality, chain membership or transaction/withdrawal bodies. The collector fetches only `eth_getProof` and `eth_getCode` at `{blockHash,requireCanonical:true}`. Account and requested storage paths must verify against that root; runtime bytes must match the proven code hash. Account/slot exclusion is distinct from missing data. Geth's zero-hash metadata for a proven absent account is retained separately from normalized absence facts. [EIP-1186](https://eips.ethereum.org/EIPS/eip-1186), [header field order](https://eips.ethereum.org/EIPS/eip-4788), [requests commitment](https://eips.ethereum.org/EIPS/eip-7685).

State is fetched lazily when local bytecode demands it, including prior values before writes. No provider trace, poststate or expected output supplies those inputs. Immutable proven facts survive nested rollback; mutable writes do not. Proven absent accounts support ordinary native funding and unsigned-sender nonce materialization. A zero-value touch preserves absence. Existing empty accounts whose transaction cleanup is not modeled are explicitly unsupported. Runtime code replacement, storage clearing and account deletion remain unsupported.

The Ethereum wrapper selects the pinned mainnet fork by both block number and timestamp, from Shanghai through BPO2. It subtracts intrinsic gas before execution, checks the active calldata-floor admission rule, then reports gas with the one-fifth refund cap and applicable floor. Sender code, native-value affordability and nonce overflow are checked before any message mutation. ETH transfers, self-transfers, reverting child value and existing destination delegation have synthetic controls. Active precompile warming follows the selected fork. Actual source BASEFEE remains separate from the unpriced execution's zero BASEFEE/GASPRICE. No fees or outer signatures are processed. [EIP-7623](https://eips.ethereum.org/EIPS/eip-7623), [EIP-3529](https://eips.ethereum.org/EIPS/eip-3529).

Ethereum execution has a 120-second cooperative limit to accommodate bounded proof reads, with the original five-million-gas, instruction, call-depth and memory ceilings. The collector also enforces its own call, byte and time limits; its byte accounting describes parsed results, so the supplied transport must bound response bodies before parsing. It performs no retries or alternate-state fallback. Proofs do not establish a recomputed poststate root or complete economic-effect inventory. In-range `BLOCKHASH` needs an explicitly supplied ancestry adapter; missing ancestry is unsupported. Contract creation/destruction, blob context/KZG execution, authorization-list preprocessing, access lists and code-bearing senders remain outside this reference profile. Operating-system isolation is not yet implemented.

The first [proof capability packet](../../reports/ethereum-proof-capability/NOTES.md) made twelve fixed read-only requests to two public endpoints. Both USDC account/code/slot-zero proofs verify against the same recorded header, whose hash was independently recomputed. dRPC also proved the fixed candidate account absent; PublicNode rejected that address proof for exceeding its proof window even though its USDC proof at the identical hash succeeded. That failure is preserved. This tests selected input capabilities, not transaction accuracy or provider infrastructure independence.

The subsequent [local-reference packet](../../reports/ethereum-local-reference/NOTES.md) executes one fixed Ethereum USDC transfer of one raw unit. dRPC supplied eleven hash-bound proof/code responses; local execution then matched the separately requested product's status, return bytes, committed log, complete observed state changes and 62,224 gas. PublicNode's separate attempt failed on its first proof request because historical state was unavailable. Both attempts finished and were saved before the product request, and neither was retried. The full local runtime and dependency tree were frozen before dispatch. These are two input attempts for one workload, with one successful comparison and one unavailable attempt; full call-tree equality, complete economic coverage and a population accuracy score are not claimed.

Run `node reports/ethereum-local-reference/supplemental-offline-audit/verify.mjs --verify` from the repository root to reproduce both saved attempts without network or current engine source. The supplemental audit keeps the unavailable RPC outcome distinct from successful execution and excludes only per-input timing from exact comparison.

The [lending reference](../../reports/ethereum-lending-local-reference/NOTES.md) extends the same independent input path to the previously selected Aave supply-with-permit and Morpho Kiln wrapper deposit. Aave demanded 58 proof/code calls for 15 accounts and 28 slots; Morpho demanded 230 for 17 accounts and 196 slots. Both completed before product access and matched execution status, return bytes, committed logs, complete observed changes and gas (189,775 / 1,413,682). Morpho entered 232 frames and executed 218,974 instructions within the frozen limits. All 364 public requests and exact source/dependency bytes are retained. This remains two selected workloads, not a new population denominator or full call-tree equivalence claim.

## Original HyperEVM input and execution boundaries

`prestate-inputs.js` accepts only a captured pre-execution state, explicitly observed missing account-field completions, the declared call and its selected block. The interface has no provider trace or post-state input. It subtracts calldata-derived intrinsic gas from the declared gas budget using the explicit Cancun call rule. Actual block base fee and the selected synthetic zero-base-fee execution profile remain distinct.

`recorded-state.js` implements an isolated sparse state manager. Known zero values and missing facts are distinct. Missing accounts, code or storage slots stop execution; missing prior values also stop writes. Copies and checkpoints preserve input facts through nested reverts. Reads remain recorded even when execution rolls back. No network fallback can fill an unknown value. The adapter does not provide a state root or cryptographic proof.

`execute.js` executes real bytecode with explicit chain ID 999, Cancun rules, caller/origin and warm-address policy. It returns message gas, refund counter, call tree, committed logs and execution limits. Completed message calls retain their sender nonce behavior; unsupported behavior, missing state and host/limit failures roll back the worker's changes. Contract creation, destruction, HyperCore read precompiles, CoreWriter, blob context and unprovided in-range BLOCKHASH values remain unsupported.

The worker's deadline is cooperative. Supplied state/block adapters must bound their own asynchronous operations. This recorded adapter performs no I/O during execution; the experimental executor is not yet a separate operating-system process for hostile workloads.

## Development evidence

The first real-chain input fixture is one fixed USDC transferFrom call at HyperEVM block 49322024. Its [state packet](../../reports/local-execution-state/NOTES.md) retains two independent collections of provider-supplied inputs, each with explicit runtime code, six touched storage slots and separate basic-field reads. The provider call trace and state diff remain comparison outputs, excluded from initial state construction.

This is an execution-guided sparse witness for one declared call. The local engine chooses its own control flow, but an altered call may reach uncaptured state and become unavailable. State still comes from providers; two endpoints do not prove separate upstream clients. Neither this fixture nor the synthetic controls establish general transaction accuracy, complete HyperEVM behavior, threat-detection accuracy or a 90% coverage rate.

The [prior offline comparison](../../reports/local-execution-comparison-v2/NOTES.md) records both local executions and separate fault controls. Its original runner deliberately refuses to substitute changed engine source or runtime for the recorded version. Use the [v2 archived-source verifier](../../reports/local-execution-comparison-v2-source/NOTES.md) to reproduce that historical report after the new Ethereum modules were added. That checkpoint passed 58 isolated tests, including eighteen comparator tests.

The original report is preserved with its exact source inventory. Run `node reports/local-execution-comparison-v1-source/verify.mjs` to reproduce it using archived source without replacing the current engine. The second report adds stricter context, state-disposition, frame and log-order validation; both retain the same real execution results.

## Process-separated Ethereum calls

`executeIsolatedEthereumCall({request,header,rpc,limits?,signal?})` verifies the supplied header, then starts the fixed `isolated-worker.js` with a 256 MiB V8 old-space ceiling. The parent brokers only canonical same-hash `eth_getProof`/`eth_getCode` reads. The child receives no endpoint, provider trace, expected output or expected poststate. The external `rpc.call(method,params,{signal})` must capture and bound actual wire bytes; IPC result sizes describe parsed JSON separately.

The default process deadline is 145 seconds, with up to 25 seconds of bounded read drain and one second of kill confirmation. Process failure withholds all asserted execution/state output. A completed child can still report unavailable or unsupported EVM execution. Late responses cannot restore success or mutate returned records. No automatic retries occur. This is a process boundary and V8 old-space cap, not an OS network/filesystem sandbox or hard total-RSS limit; runtime source binding remains the runner's responsibility. In-range BLOCKHASH remains unsupported without independently authenticated ancestry.

The current isolated suite passes 139 checks, including 17 process/protocol controls, proof rejection, lazy state rollback, fork/gas boundaries and the saved public proof packet. An actual worker reproduces the archived one-unit USDC execution from its eleven recorded proof/code reads. These are regression and development checks, not 139 independent transactions or an accuracy percentage.
