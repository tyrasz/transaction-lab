# Official full-transaction fixture harness

This isolated package runs a fixed slice of official Ethereum state tests with EthereumJS 10.1.3. It is separate from the product's sparse, unsigned preview implementation and measures dependency conformance only.

The adapter reconstructs the exact signed fixture transaction, checks its serialized bytes and sender, loads complete prestate into a Merkle Patricia trie, and executes `runTx` under the fixture's explicit Osaka rules and real fees without admission bypass flags. It compares the resulting state root and ordered logs hash, plus receipt status, gas, transaction hash and bloom when supplied. Expected state is loaded into a separate manager only to validate the fixture's own poststate/root consistency. It is never used as execution input.

Only the declared legacy, access-list, fee-market and authorization envelope forms are implemented. Missing BLOCKHASH history fails closed. This slice does not establish consensus header validation, blob sidecar/KZG validity, later forks, every transaction form, or product API accuracy.

From the repository root:

```
node --test engines/fixture-evm/test/state-test.test.js research/evm-conformance/harness.test.mjs
node research/evm-conformance/run.mjs --check
```

The official run is one-shot (`--run` refuses an existing STARTED file). Replay procedures and frozen identities are recorded under `research/evm-conformance/`.
