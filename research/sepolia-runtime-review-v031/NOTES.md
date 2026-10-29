# Sepolia runtime integration review

This is a bounded source review and synthetic-control record, not a public-chain capture or independent-client accuracy result. It covers the new Amsterdam storage normalization, gas settlement and lifecycle wiring, plus historical Sepolia authorization chain binding. Public Sepolia admission remains a separate gate.

The focused command below passed **46/46 tests in 4,632.129875 ms**. `focused-controls.tap` is an exact copy of `/tmp/evm-v031-runtime-final-review.tap`, SHA-256 `84f42d156e61ee24da41e06a3633e9d7e1bb1dee2b5db56a9dcb7b87ef24c909`.

```sh
node --test engines/local-evm/test/historical-sepolia-authorization.test.js engines/local-evm/test/authorization-parent.test.js engines/local-evm/test/delegated-sender-parent.test.js engines/local-evm/test/amsterdam-execution.test.js engines/local-evm/test/ethereum-state-gas.test.js engines/local-evm/test/ethereum-execution-admission.test.js
```

Five additional controls were executed once as an inline Node module before this packet was assembled. Their tool response reported exit code 0 and `5/5 independent storage-cache reuse/copy and host-failure rollback checks passed`. `original-stdin.mjs` retains that inline program; `ephemeral-observation.json` transcribes the observed result. No separate contemporaneous raw process file existed for that run, so the transcription is not presented as a newly sealed execution log.

The two reuse controls first store 7, then clear it in another invocation using either the same manager or a shallow copy. They compare execution and state-gas accounting to a fresh fixture with original storage 7. This tests that the original-value cache is reset at the transaction boundary and that canonical proof words are normalized for the EVM without becoming persistent invented zeros. Three fault controls invoke the real original-value read, then throw `undefined`, `null`, or an `Error`. Each asserts the injection fired, execution became unavailable, the entire attempt rolled back, and both fee/state-gas accounting were withheld.

`run-controls.mjs` is a retained convenience launcher with hashes for the eight reviewed files. **It was not executed during packet assembly.** Invoking it later runs the saved inline program from the repository root, after checking those source identities:

```sh
node research/sepolia-runtime-review-v031/run-controls.mjs
```

The review found and corrected historical Sepolia authorization recovery accidentally using mainnet's chain ID. Root execution now passes the trusted chain ID; parent authorization validation admits only mainnet/Sepolia and independently recovers against that chain. The new regression covers Sepolia-specific and wildcard authorization application, mainnet-tuple skipping, self-authorization, real isolated child/parent validation and fresh query semantics. Four signed full-VM counterparts agree; they share EthereumJS and are not independent-client evidence.

One known coverage gap remains: under Amsterdam, a repeated CREATE2 collision increments the creator nonce without an entered child frame. The current strict parent nonce ledger rejects the otherwise successful kernel result as unavailable. This packet does not claim that path is supported or relax its validation.

No other silent-result defect was found in this bounded review. `reviewed-sources.json` records the exact reviewed hashes, rechecked at retention. This directory does not archive the full dependency tree, prove the entire import closure, or attest historical execution time. The manifest binds only the listed supplemental files. No production source, saved diagnostic packet, or target outcome was changed while assembling this record, and no controls were rerun for retention.
