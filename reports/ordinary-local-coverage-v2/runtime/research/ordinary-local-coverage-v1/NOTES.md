# Prospective local engine pilot

The frozen **0.20.0** isolated local engine completed the predeclared pilot on October 28, 2026. The census contained **285 transactions** from two future Ethereum blocks; deterministic sampling selected **16** before their execution outcomes were inspected. Fourteen completed successfully and matched the separate provider oracle on execution status, return bytes, committed ordered logs, charged gas and full observed net state changes. Two were explicitly unsupported. No selected case was replaced or retried.

| Result | Selected cases |
| --- | ---: |
| Five-channel match | 14 |
| Mismatch | 0 |
| Unsupported | 2 |
| Provider/oracle unavailable | 0 |
| Budget unattempted | 0 |

Execution availability and exact agreement are both **14/16 (87.5%) for this sample**. Agreement among comparable cases is 14/14. Neither figure establishes a population accuracy rate. The two unsupported cases, 002 and 015, remain in the denominator: both are ordinary USDT transfer calls whose senders already have exact EIP-7702 delegation code. The frozen engine rejected coded senders before executing their calls. Later development rechecks must remain separate from this capture.

The local attempt was durably saved and sealed before dispatching each oracle trace/diff. Initial account and storage facts came from independently verified proofs/code; oracle execution output never supplied local starting state. The offline verifier rechecked 153 proofs, all 302 wire records, 508 evidence files, the 1,771 archived source files, and recomputed every selected outcome. It returned `verified`; that is evidence verification, not another EVM execution.

The fixed run began at 06:43:59.651 UTC and ended at 07:05:44.207 UTC. The required 20-minute waiting interval ended without a timing violation. It used 302 public read-only RPC calls and 4,637,496 observed response bytes, within the predeclared limits. There was no signing, broadcasting, provider fallback, case replacement or deadline extension. Source and runtime identities were unchanged.

This evaluated the archived isolated kernel, not the HTTP API or complete asset/position discovery. Calls ran at parent-block-end state under the declared unsigned, zero-price, fixed-five-million-gas profile. This is not original transaction-position replay or fee settlement. The oracle was requested to use matching context, but no separate execution witness attests its context implementation. Consensus/finality, complete poststate-root equality, security assessment and broad transaction coverage remain unestablished. The then-current application update to 0.20.1 did not alter this frozen 0.20.0 evaluation.

## Evidence

- Plan SHA-256: `93c819d0c3c00b64c6cf502c28efcae5c54efa02ffccf4341106e62c7b0045b5`
- Source manifest SHA-256: `85cc9397a7048e4b2e61182685d191f77ab4ce001ba3c8bca4ce3f5f43ef2103`
- Evidence manifest SHA-256: `d1c82c2237351ce871ab7a789d72aee264a5006b51c6f42c1207a9cf144ecd40`
- Capture: [results](../../reports/ordinary-local-coverage-v1/results.json)
- Run policy: [PLAN.md](PLAN.md)

Offline verification from the repository root:

```sh
node research/ordinary-local-coverage-v1/verify.mjs reports/ordinary-local-coverage-v1 d1c82c2237351ce871ab7a789d72aee264a5006b51c6f42c1207a9cf144ecd40
```

Keep the sealed capture and its archived sources unchanged. The [separate supplemental audit](../ordinary-local-coverage-v1-audit/NOTES.md) independently reproduced all 16 archived executions from saved proof/code responses, checked raw comparison channels and chronology, and passed 12 tamper controls. Its manifest SHA-256 is `1b0459606aa8c147abe0a3b3f8a5b7705be0b1ef127708523614a7a4ccc76f1e`. The audit explicitly reuses the frozen verifier for cryptographic proof/header and collector joins; it is not an independent opcode engine.
