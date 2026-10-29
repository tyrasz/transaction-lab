# Fixed KZG point-evaluation comparison results

The single target run retained all sixteen predeclared cases: **16 matched, 0 mismatched, 0 unavailable and 0 unattempted**. Each Geth state test matched the product-applied full poststate root and passed its internal assertion of the product log hash. The separate signed full-VM diagnostic matched all sixteen on state, logs, return, execution status and charged gas. That diagnostic shares EthereumJS opcodes and the exact KZG verifier with the product; Geth supplies the independent implementation in this comparison.

These are fixed synthetic development controls, not a population sample or a general Ethereum accuracy rate. Product execution produced twelve successes, one REVERT and three ordinary EVM failures. Matching a failure means its effects matched, not that the transaction succeeded. Five cases committed nonempty logs. There were no public RPC requests, broadcasts, target retries or replacement cases.

## Retained outcomes

Every row below matched both saved comparisons. Gas is the product/shared-full-VM charged gas; no separate Geth gas-output channel is claimed. Return-byte counts likewise describe the product/shared-full-VM output.

| ID | Case | Product execution | Charged gas | Return bytes | Committed logs |
| --- | --- | --- | ---: | ---: | ---: |
| 001 | Cancun direct official point | success | 74,072 | 64 | 0 |
| 002 | Prague direct official point | success | 74,072 | 64 | 0 |
| 003 | Osaka direct official point | success | 74,072 | 64 | 0 |
| 004 | BPO1 direct official point | success | 74,072 | 64 | 0 |
| 005 | BPO2 direct official point | success | 74,072 | 64 | 0 |
| 006 | CALL, value 5 | success | 195,911 | 96 | 1 |
| 007 | CALLCODE, value 5 | success | 170,911 | 96 | 1 |
| 008 | DELEGATECALL, inherited value 19 | success | 164,208 | 96 | 1 |
| 009 | STATICCALL | success | 164,208 | 96 | 1 |
| 010 | Caught STATICCALL OOG | success | 144,307 | 96 | 1 |
| 011 | Successful CALL, enclosing REVERT | reverted | 195,911 | 96 | 0 |
| 012 | Direct incorrect proof, y+1 | failed: invalid proof | 200,000 | 0 | 0 |
| 013 | Direct malformed proof | failed: invalid inputs | 200,000 | 0 | 0 |
| 014 | Zero polynomial, infinity points | success | 72,176 | 64 | 0 |
| 015 | Exact 50,000 message gas | success | 74,072 | 64 | 0 |
| 016 | 49,999 message gas | failed: out of gas | 74,071 | 0 | 0 |

The direct original-input cases consumed exactly 50,000 message gas. Their calldata intrinsic is 24,072, so cases 015/016 differ by one total gas unit. Cases 006–010 persist the two precompile return words, CALL success flag and parent slot 3, plus one LOG1. Case 010 retains the parent work despite the child's OOG; its failed call leaves the overlapping output memory unchanged. Case 011 returns 96 bytes of REVERT data while discarding parent storage, value transfers and logs. The nonzero priced execution fees remain part of the compared final state.

The saved [results](capture/results.json) report `status: complete`, `comparisonsUsable: true`, `sourceUnchanged: true`, and `fatal: null`. Target execution began at **2026-10-29 02:03:55.444 UTC** and finished at **02:04:39.664 UTC**. Preparation took 26.162 seconds wall time; the Geth phase took 18.045 seconds; total measured elapsed time was 44.207 seconds. Both wall/monotonic verdicts were valid and within their declared budgets. These are local run timings, not network or general performance measurements.

## Provenance and launch record

Product baseline: `ae2438742f9b5429f83e266196cb037f4e131795`. Reviewed protocol/repository commit: `4b1e638fb3946d2a7c413ea2f4c37085f3273ca0`. Freeze timestamp: `2026-10-29T02:02:34.772Z`. The runtime archive contains **4,018 entries, 24,916,601 regular-file bytes and one bounded internal dependency symlink**. It includes complete installed local/fixture dependencies, the actual executor/verifier, fixed trusted-setup provenance and saved official vectors. The original Geth vector file is pinned to SHA-256 `e831a6e4b7c848ae012e75adfe7724caeb95e2ecb79af7e853e26ccdbe5cdc9d`.

Node is v22.23.2, darwin/arm64, executable SHA-256 `1f72236fcbfc84855d7c884fbcba0f6a7c635d600d7e493b823e77c467f2ae95`. Geth is v1.17.10 at source commit `1df30b18d9ed35ee9d28ffd4648442c2204554ad`; binary SHA-256 `10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521`, 54,847,666 bytes. Its exact binary remains external; the toolchain/source/dependency inventories are retained in the capture.

| Artifact | SHA-256 |
| --- | --- |
| [Evidence manifest](capture/manifest.json), covering 121 files | `ac125bf32734ef21acaebbb4c0de9a2854f6caae25f29e5f323ca895e6fb548a` |
| [Frozen plan](capture/PLAN.json) | `3e383f574c0df7934eb0e2d6cd12063f9b2fa8762b267de6aa81e3007dd2a623` |
| [Source manifest](capture/source-manifest.json) | `9d2c1703dee9dc940db2e01b4d898cb1dd64ab70c506556e5e10dde0012fc1e7` |
| [Results](capture/results.json) | `f6b17490daacaf99cdcebb8b541a1ab31213f2403503328245951be2fab179c2` |

Before target dispatch, one launcher invocation exited 13: directly invoking the archived CLI's `run` branch caused it to import its own pending module, producing Node's unsettled-top-level-await diagnostic. At that point there was no STARTED marker, result or raw target output; zero targets had executed. The coordinator inspected that state and explicitly authorized using the reviewed current CLI, which imports the archived `runFrozen` entrypoint as intended. The same source/plan remained frozen; there was no refreeze or source change. The [supplemental launch record](launch-record.json) and [unaltered diagnostic](launcher-01.log) preserve the failed launcher and correction outside the sealed capture. This was a corrected pre-dispatch launch, not a retried case.

The successful launch process exited 0; its redirected log is `/tmp/evm-v026-kzg-geth-capture.log`. For each of the sixteen cases, the product process ran before its separate reference process, and its result was durably saved/sealed first. A third fresh MPT applied only the product deltas. Every available Geth expectation was sealed before the first Geth process. The product consumed 132 synthetic proof/code responses, including 78 account/storage proof responses; these are parsed fixture responses, not network wire evidence. The writer of this note rehashed all 121 evidence artifacts and all sixteen raw Geth stdout/stderr streams without re-executing targets. Independent artifact audit is a separate record.

## Scope and read-only verification

All headers and initial states are synthetic, using production mainnet fork selection and fee semantics. All transactions are priced type 2 with base fee 7, caps 13/3 and no blob hashes or sidecars. The exact fixed declarations are in [PLAN.md](PLAN.md) and the frozen inputs. The selected envelopes, source, expected-root derivation and results were not changed after observing execution.

Geth independently checked **full poststate root and internal log-hash assertion**. Nested persisted words/logs make the relevant precompile observations visible to those checks. Direct return bytes have only the explicitly shared-crypto/shared-opcode full-VM comparison; a passing state-root check alone does not assert their exact contents. There is no separate Geth receipt, return or gas comparison, nor a sidecar, whole-blob, block-body, inclusion, consensus or universal-accuracy claim. Invalid inputs and caught or enclosing failures remain visible in the fixed denominator.

From the repository root, this checks the archived runtime, exact plan/input hashes, Node identity and pinned Geth binary without executing a target:

```sh
node research/delegated-sender-geth-v1/kzg-controls/capture/runtime/research/delegated-sender-geth-v1/kzg-controls/run.mjs check research/delegated-sender-geth-v1/kzg-controls/capture 3e383f574c0df7934eb0e2d6cd12063f9b2fa8762b267de6aa81e3007dd2a623
```

Preparation controls also remain non-executing:

```sh
node --test research/delegated-sender-geth-v1/kzg-controls/run.test.mjs
```

The original one-shot capture cannot be overwritten or retried. A future replay would require separate authorization, a new output destination, exact archived source/declarations/runtime identities and an explicit replay label. Preserve original absolute process arguments when relocating artifacts; do not rewrite sealed bytes.
