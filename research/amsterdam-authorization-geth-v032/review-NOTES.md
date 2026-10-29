# Saved-artifact review

The independent bounded review confirms the sealed result without running the product, Geth, a VM, or any network request: **5 matched, 0 mismatched, 1 unavailable, 0 unattempted**. Across the six retained rows, 52 available comparison channels agree and two channels remain null.

The late authorization out-of-gas case has no entered product message. Geth's saved root is a synthetic preparation halt. Its return-data and message-gas channels remain unavailable; this review does not reinterpret it as a sixth all-channel match. The recipient-preparation halt retains the actual product root and compares only the declared output/gas channels, without claiming identical internal execution paths.

The review checks the externally pinned capture, plan and source manifests; all 162 captured inventory entries, 61 runtime entries and 3,841 referenced dependency entries; exact Node/Geth identity and twelve process arguments/bounds; six signed type-4 transactions including ordered authorizations; six independently hashed Amsterdam headers; original and amended input allocations with four unchanged STOP system accounts; thirty parsed proof/code replies joined to collector and broker records; and 24 independently reconstructed MPT roots (original, amended initial, product deltas, Geth final allocations). Product comparison inputs are rebuilt from the saved actual output and deltas. Seals and inventories are checked before and after review. Raw output totals 239,676 bytes.

The review reuses the reviewed archived pure trace/comparison parser. It is independent artifact confirmation, not a wholly independent comparison implementation. The account facts are also checked against the complete synthetic initial allocation, but individual MPT proof paths are not independently re-walked. The recorded input replies are parsed synthetic RPC results, not network wire captures. Product-before-Geth ordering is supported by the frozen driver and durable seals; Geth process records do not carry separate absolute start timestamps. Neither a public API check, live-chain result, general Amsterdam correctness nor population coverage follows from this selected development packet.

`review.test.mjs` passed all five artifact-only groups, including altered starting balances, duplicate/reset deltas, reply/count/hash/selector substitutions, synthetic no-message handling, truncated trace rejection and an altered manifest. `review-controls.tap` retains the run. No frozen source or capture bytes changed. The packet requires the pinned sibling creation capture dependency archive and exact external Node/Geth files; process argument checks use the recorded source location while artifact reads use the supplied checkout.

Run the artifact-only verifier from the repository root:

```sh
node research/amsterdam-authorization-geth-v032/review.mjs "$PWD"
node --test research/amsterdam-authorization-geth-v032/review.test.mjs
```

Capture manifest: `3837d41a5055fd9edb13f2412f96a33660aa2fbad4beb9d3cd1eeb9e3e672f5a`.
Plan: `1315e6a308ab0a1baf78e7b49b89b2425621476f593fbc76db2b2a4694dfb285`.
Source: `46a7f53b43fdd0bfb093b19936eaa79fc616e374eeb2bfbd2142c305dac055b2`.
