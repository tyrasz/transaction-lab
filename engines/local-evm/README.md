# Experimental local EVM execution

This package executes bytecode locally using pinned EthereumJS 10.1.3 packages. It is separate from Transaction Lab's provider-backed API and browser preview. It is an unsigned-message development engine, not a signed-transaction validator, complete HyperEVM implementation or security classifier. [Upstream EVM documentation](https://github.com/ethereumjs/ethereumjs-monorepo/tree/master/packages/evm).

From the project root:

```sh
npm ci --prefix engines/local-evm --ignore-scripts
npm run test:local
```

Dependencies and integrity hashes are pinned in this package's lockfile. The primary service's dependency-free runtime remains unchanged.

## Input and execution boundaries

`prestate-inputs.js` accepts only a captured pre-execution state, explicitly observed missing account-field completions, the declared call and its selected block. The interface has no provider trace or post-state input. It subtracts calldata-derived intrinsic gas from the declared gas budget using the explicit Cancun call rule. Actual block base fee and the selected synthetic zero-base-fee execution profile remain distinct.

`recorded-state.js` implements an isolated sparse state manager. Known zero values and missing facts are distinct. Missing accounts, code or storage slots stop execution; missing prior values also stop writes. Copies and checkpoints preserve input facts through nested reverts. Reads remain recorded even when execution rolls back. No network fallback can fill an unknown value. The adapter does not provide a state root or cryptographic proof.

`execute.js` executes real bytecode with explicit chain ID 999, Cancun rules, caller/origin and warm-address policy. It returns message gas, refund counter, call tree, committed logs and execution limits. Completed message calls retain their sender nonce behavior; unsupported behavior, missing state and host/limit failures roll back the worker's changes. Contract creation, destruction, HyperCore read precompiles, CoreWriter, blob context and unprovided in-range BLOCKHASH values remain unsupported.

The worker's deadline is cooperative. Supplied state/block adapters must bound their own asynchronous operations. This recorded adapter performs no I/O during execution; the experimental executor is not yet a separate operating-system process for hostile workloads.

## Development evidence

The first real-chain input fixture is one fixed USDC transferFrom call at HyperEVM block 49322024. Its [state packet](../../reports/local-execution-state/NOTES.md) retains two independent collections of provider-supplied inputs, each with explicit runtime code, six touched storage slots and separate basic-field reads. The provider call trace and state diff remain comparison outputs, excluded from initial state construction.

This is an execution-guided sparse witness for one declared call. The local engine chooses its own control flow, but an altered call may reach uncaptured state and become unavailable. State still comes from providers; two endpoints do not prove separate upstream clients. Neither this fixture nor the synthetic controls establish general transaction accuracy, complete HyperEVM behavior, threat-detection accuracy or a 90% coverage rate.

The [current offline comparison](../../reports/local-execution-comparison-v2/NOTES.md) records both local executions and separate fault controls. From the project root, `node reports/local-execution-comparison-v2/run.mjs --verify` checks frozen source/runtime identity and reruns that report without network access. It deliberately refuses to substitute a changed engine or runtime for the recorded version. All 58 isolated tests pass, including eighteen comparator tests.

The original report is preserved with its exact source inventory. Run `node reports/local-execution-comparison-v1-source/verify.mjs` to reproduce it using archived source without replacing the current engine. The second report adds stricter context, state-disposition, frame and log-order validation; both retain the same real execution results.
