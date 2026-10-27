# Supplemental offline reexecution audit

This audit was created after the original packet was sealed. It is **not part of the original manifest**, changes no original evidence or current engine files, and makes no new network requests.

Original manifest SHA-256: `dd8973dd8e50447d38bf9609a078acb126e4061a939a9c7b803892073ec6c463`.
Original plan SHA-256: `ffa5f14e267e3fb4ec2eb53aa3bb2da241ace700368a244cde9042f2b7f1a220`.

Run from the Transaction Lab directory with the captured Node runtime, v22.23.2 on macOS arm64:

```sh
node reports/ethereum-local-reference/supplemental-offline-audit/verify.mjs --verify
```

The verifier checks all 1,715 original manifest entries and the exact 1,668-entry frozen source/dependency tree. It imports the archived engine, collector, state manager and proof verifier, never the current implementation. It recomputes the execution-header RLP hash and checks the four recorded header observations against the selected header. This binds the state root to the selected hash; it does not verify consensus, finality, chain membership or the block body.

Each attempt starts with a fresh empty collector and state manager. Its only initial state is obtained through the exact sequential recorded `eth_getProof` and `eth_getCode` responses at the canonical EIP-1898 block-hash selector. Every generated JSON-RPC request must match the saved request bytes. All response-body hashes, byte counts, IDs, method/parameter pairs and success/error envelopes are checked. The archived collector re-verifies proofs and code hashes as the local VM demands them. Unknown reads cannot fall back to another provider, zero values, traces or expected output. Fetch and socket connections are blocked.

Both executions finish before the script parses the saved local outputs or product response for comparison. During initial inventory verification those files are only hashed as opaque bytes. Complete execution outputs, verified input facts, input usage, read sets, state changes and failure identities compare exactly. Only per-input-evidence `durationMs` is excluded; original latency is not recreated. The original product comparator is also rerun after execution to check reproducibility of its saved outcome, rather than treated as an independent comparison implementation.

| Attempt | Saved input reads | Reexecution | Comparison with product |
| --- | ---: | --- | --- |
| PublicNode | 1 proof request; 159 response bytes | Unavailable, unchanged state | Incomplete |
| dRPC | 8 proof requests and 3 code requests; 147,782 response bytes | Success; 3 proven accounts and 5 storage slots; gas 62,224 | Saved five checks reproduce as matched |

PublicNode returned a complete JSON-RPC error with code `-32000` reporting that the selected historical state was unavailable. This is **not a timeout or an invalid cryptographic proof**, and no successful execution is inferred. Its unavailable outcome, empty changes and input failure reproduce unchanged. No timeout occurred in this packet; this fixed verifier rejects partial or unsupported transport evidence instead of interpreting it as a successful empty response.

The successful local attempt reproduces its exact return bytes, committed log, sender nonce increment and two changed USDC storage words. The original constructed call transfers one raw USDC unit. All 12 local wire records, totaling 147,941 response bytes, were consumed exactly once with zero network attempts.

This is an independent audit procedure using the same frozen local engine and proof verifier. It establishes reproducibility for **one selected development workload with two provider-input attempts**, not two successful cases, a held-out evaluation, a general accuracy rate or a second independent EVM implementation. Local input proofs and the product comparison use dRPC for the successful attempt; the independently executed engine does not imply independent provider infrastructure.
