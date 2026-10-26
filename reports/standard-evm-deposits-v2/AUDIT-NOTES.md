# Supplementary offline audit

The post-capture [audit](audit.mjs) passed against capture SHA-256 `149d80c7e421805dbc403a66acb6fb3410ea1d092876c01cc2776b52c703d86e` and frozen plan SHA-256 `d458f18ebd659998296a05283e6987f945bb54d7fe5786551abf70c9d7640f8f`. Its [result](audit.json) is deterministic and retains all consumed RPC IDs. No network requests or live implementation imports were made. The frozen runner, verifier, plan, archive and raw observations remain unchanged.

This supplement closes three specific gaps in the frozen verifier:

- The plan, capture's before/after inventories, archive metadata and `STARTED.json` must agree exactly. All seventeen required files are hash-checked before importing the archived engine. The ten runtime modules include the engine, provider adapter, five shared core helpers and three noble hash modules; package resolution is checked inside the archive.
- Both planned cases must be present in their original order, with exact transaction, block, request, query-role and receipt-reference bindings.
- Playback method, parameter, order and envelope mismatches are latched outside the engine and asserted after it returns. An engine-caught exception cannot turn a wrong saved request into an accepted unavailable result. Every saved RPC is consumed once, and the entire engine result—including raw engine evidence and failure fields—is compared without exclusions.

All 76 requests and complete response bodies reproduced, totaling 443,865 response bytes. The Aave case consumed IDs 1–30 and reproduced all four measurements. The Morpho case consumed IDs 31–76 and reproduced all eight measurements. Both results reported successful execution and verified final canonical headers. All eight provider codeHash checks reproduced. This packet contains no RPC failures; separate in-memory controls exercise failure preservation and the mismatch latch.

Seven focused tests passed, including truncated/reordered cases, missing or altered source inventory, stale startup inventory, malformed response identities, changed wire bytes, swallowed request mismatches, skipped/reordered calls and a changed result evidence field. The mutations are explicitly synthetic and never overwrite recorded evidence.

Run offline:

```sh
node reports/standard-evm-deposits-v2/audit.mjs --capture-sha256=149d80c7e421805dbc403a66acb6fb3410ea1d092876c01cc2776b52c703d86e
node --test reports/standard-evm-deposits-v2/audit.test.mjs
```

This is evidence-integrity and deterministic archived-playback validation, not an independent EVM or state oracle. It retains the declared unsigned, unpriced parent-block-end profile and bounded twelve-query scope. It does not establish original-position transaction replay, complete economic effects, signature or fee settlement correctness, security classification, or a Blockaid comparison. Provider-supplied codeHash/runtime agreement remains field consistency rather than independent code attestation. Timings are not fabricated or replayed; this successful packet has no scheduling-dependent failure to reproduce.
