# Supplemental lending reexecution audit

This audit was added after the original capture was sealed. Its files are **outside the original manifest**. The captured evidence and current engine were not edited. No network requests, replacement cases, state overrides or missing-input repairs were introduced.

Original manifest SHA-256: `34b1e325ea08604705e50f06da81e442bb48cea017faf3058671e1e1a4e8f8c5`.
Original plan SHA-256: `f9fb0e1b465bcf191185e1790204bf64a324634d98436ebb4a17f4cb6cd83288`.

From Transaction Lab, using the captured Node v22.23.2 runtime on macOS arm64:

```sh
node reports/ethereum-lending-local-reference/supplemental-offline-audit/verify.mjs --verify
```

The audit checks all 2,265 original manifest entries and the exact 1,668-entry archived source/dependency tree before and after reexecution. Only archived engine modules and dependencies are imported. Both cases are independently bound to the frozen original deposit plan, calldata, sender and parent header. Execution-header RLP hashes are recomputed. The two `header-bodies` files are byte-exact copies of the discovery responses referenced by the sealed parent metadata; their original byte counts and SHA-256 values are checked. They supply no additional state.

Fresh collectors and state managers execute both calls using only exact sequential recorded `eth_getProof` and `eth_getCode` responses. Each generated JSON-RPC request must match its recorded bytes, including the canonical block-hash selector. Every local response body, envelope ID, hash and byte count is checked; account/storage proofs and code hashes are reverified as demanded by the local VM. Neither old nor new product traces, diffs, measurements or expected outputs populate initial state. Output files are initially hashed as opaque bytes; saved outputs are parsed only after both genuine reexecutions finish.

Execution output, verified input facts, input usage, read sets, observed state changes and failure identities compare exactly. Only `inputEvidence[*].durationMs` is removed from compared snapshots. Capture timestamps and transport durations remain hash-bound metadata; original latency is not recreated. The audit also checks that both saved local completions precede the recorded local-phase marker and subsequent product requests.

| Workload | Local reads | Proven initial state | Reexecution | Transaction-style gas |
| --- | ---: | --- | --- | ---: |
| Aave USDC supply with permit | 43 proofs + 15 code reads | 15 accounts, 28 slots | Exact reproduction | 189,775 |
| Morpho/Kiln USDC deposit | 213 proofs + 17 code reads | 17 accounts, 196 slots | Exact reproduction | 1,413,682 |

All 288 local reads (3,409,074 response bytes) and 76 product RPC records (443,714 response bytes) were verified. The full product HTTP bodies and exact request inputs were checked. The frozen comparator, run only after local execution, reproduces both saved five-channel matches: execution status, return bytes, committed logs, full observed changed state and gas accounting. This reproduces the original comparator rather than creating a separate comparison implementation.

Three additional controls mutate only an in-memory response in the Aave replay. They are **synthetic offline faults, not additional live cases**:

| Control | Outcome | State disposition |
| --- | --- | --- |
| First proof response missing | `RPC_STATE_INPUT_UNAVAILABLE` | Unchanged |
| Contract code changed without matching proof | `RPC_STATE_INPUT_INVALID_PROOF` | Rolled back |
| Storage value claim disagrees with its proof | `RPC_STATE_INPUT_INVALID_PROOF` | Rolled back |

All controls return unavailable, emit no committed logs and retain zero committed changes. Genuine captured files remain unchanged. The verifier blocks fetch/socket connections and records zero attempted network calls. Both captured lending executions succeeded; unsupported partial transport evidence would fail this fixed audit rather than become a zero balance or successful execution.

These are two selected development cases. They do not establish a population accuracy rate, broad economic-effect coverage or a security verdict. The independent audit procedure uses the same frozen local EVM and proof verifier, not another independent local implementation. Both proof inputs and remote product execution came through dRPC, so engine independence does not establish provider-infrastructure independence. Proofs bind demanded initial facts to the chosen header commitment; consensus, finality, block-body validity and a complete recomputed poststate root remain outside this audit. Calls are unsigned, unpriced executions at parent-block end, without outer signature/fee settlement or original transaction-position replay claims.
