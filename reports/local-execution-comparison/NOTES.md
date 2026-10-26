# First recorded local EVM comparison

**The local EthereumJS engine reproduces one fixed USDC `transferFrom` from each of two provider-supplied input packets.** Both executions match the recorded return value, complete entered call tree, ordered committed log and exact changed state within the captured accounts/slots. This is one selected transaction executed twice, not two independent transactions, general HyperEVM coverage, a security score or evidence of 90% accuracy.

The offline runs use source packet `reports/local-execution-state/capture.json`, SHA-256 `8e7ca6979a894a6a4340379ef2ff875e7b398e2b48f157324d081dd319c40876`, at parent-block end state 49322024 / `0xe4e17972b424a9785e111ba5cfd3fc08fc3229e074c078a99a69fd126ee10e87`. Input construction receives only full non-diff prestate, explicit basic-field completions, envelope and header. `input-packets.json` retains those inputs separately. The runner executes bytecode and snapshots local reads/changes **before reading provider call-trace and state-diff comparison channels**. No provider output repairs, inferred zero slots, online state fetches, signatures or broadcasts are used.

## Actual execution and comparison

Each endpoint-supplied packet produces:

- Success and the uint256 return word `1`.
- 705 interpreter steps, two entered frames (USDC proxy CALL and implementation DELEGATECALL), maximum depth one, one committed Transfer log.
- 29,328 message execution gas, zero refund counter. The input-derived Cancun call intrinsic gas is 21,940; total 51,268 equals the recorded provider root gas use. Message gas supplied is 4,978,060 from the declared 5,000,000 limit minus input-derived intrinsic gas. Descendant gas is compared exactly without adjustment.
- Sender nonce `191048 → 191049`, plus exactly three changed USDC storage slots. They contain owner balance `1541542 → 264475`, recipient balance `4647557042700 → 4647558319767`, and the recorded allowance decrease by `1277067` raw units. No other captured account/slot changes appear.
- 32 state read operations, ten distinct account/code/storage reads, including all six recorded USDC proxy storage slots. An uncaptured read would fail rather than obtain an implicit zero.

The pure comparator independently derives intrinsic gas from calldata. It compares every entered frame's type, caller/callee addresses, value, input, output, error, gas, gas used and child ordering. Only root gas is normalized by intrinsic gas. Committed logs are ordered using provider indices, with duplicates/conflicting indices unavailable; reverted subtrees contribute no committed logs. Nonempty revert reasons without failed-frame evidence and explicit empty error fields are rejected. Nonzero refunds have no implemented root-gas normalization and remain unavailable.

For state, every supplied provider diff prefield is checked against input facts. The entire local changed-state snapshot is then compared against the diff. Omitted post basic fields mean unchanged; pre-only storage means a cleared slot only with explicit pre/input evidence; post-only storage requires a separately captured explicit zero input value. Unknown accounts/slots, missing changed-basic prevalues, lifecycle changes and runtime code changes remain unavailable. The comparator does not infer a complete state-root proof from sparse evidence.

## Fault controls and tests

Five clearly synthetic controls are stored separately from the real comparison cases in `results.json`:

| Deliberate change | Observed behavior |
| --- | --- |
| Remove required proxy storage slot | Local unavailable; sender nonce and all effects rolled back |
| Remove implementation account | Local unavailable; all effects rolled back |
| Remove observed sender-code completion | Input conversion rejects before a state manager exists |
| Supply explicitly empty implementation code | Executes different supplied state; output/log/state comparison diverges |
| Increase explicit owner balance slot by one raw unit | Executes changed supplied state; baseline and final-state comparison diverge |

Explicit empty code is **changed data**, not missing data. Controls never substitute expected outputs to force agreement. The isolated engine suite passes **54/54 tests**, including 14 comparator tests. Additional comparator controls cover descendant gas/return-data changes, omitted calls, duplicate/reordered log indices, provider prefield mismatch, extra local changes, malformed diff/lifecycle/code changes, contradictory failure fields and unsupported refund/context changes. Independent review found the contradictory revert-reason gap; it was fixed and tested before the final report was written.

## Reproduction and frozen provenance

From the project root:

```sh
node reports/local-execution-comparison/run.mjs --verify
node --test engines/local-evm/test/*.test.js
```

`--verify` checks recorded artifact hashes and exact source/runtime binding, then reruns both local cases and all five controls entirely offline. It requires exact deterministic equality with `results.json`. A changed engine, test inventory, dependency lock, direct installed dependency version or Node runtime rejects reexecution under the frozen report. `--write` is the original exclusive-create command and must not be used to overwrite this report. `--check` prints source identity without executing bytecode.

The full ordered inventory and per-file hashes are in `results.json → provenance.engine.files`: `compare-recorded.js`, `execute.js`, `prestate-inputs.js`, `recorded-state.js`, `package.json`, `package-lock.json`, and all four isolated engine test files. The four direct EthereumJS packages are pinned to **10.1.3**; Node is **v22.23.2**, V8 `12.4.254.21-node.56`, Darwin arm64. The dependency lock contains integrity records; this report does not independently attest every installed dependency file.

- Results SHA-256: `bfc85b6ed1875d028b70e8d59968e645d0c1a2d8025f603cc837513ad2c916fb`.
- Ordered engine/source/test inventory SHA-256: `16cc789d64560349e88a694cc6104c1bda6f4bebe05c4ef8c683ae4276a38d61`.
- Dependency lock SHA-256: `78b150d101a54b715a5d292a86566764723c9222e4379706ef681b46dbee4feb`.
- Final execution worker SHA-256: `2aa738fad2611b4c2f5668f1112458bd2f55a5de514078aa824631f18429ace1`.
- Comparator SHA-256: `b17cc89dd48f649105b9a1b25963b25e2b19dfbb90dbede81eacdd02854c692b`.

The engine owns the bytecode execution, while base state still comes from providers. No cryptographic state proof, full chain reconstruction, arbitrary HyperCore support or independent provider-engine identity is established. The profile is zero-value, unsigned Cancun execution with synthetic BASEFEE zero and no fee settlement; it does not validate a future signed transaction. CoreWriter/HyperCore, lifecycle/blob behavior and missing ancestors remain explicitly unsupported. The unchanged product still uses its separate provider execution path; this module is an isolated experiment.
