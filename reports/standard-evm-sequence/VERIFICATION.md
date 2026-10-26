# Offline verification of the fixed sequence packet

The supplementary verifier passes for all three captured API responses. It hashes all 73 sealed files before importing any archived application code, checks the exact 52-file source inventory and implementation identity, and replays all 112 public RPC responses through the archived API handler and production transport in memory. No socket or public network request is used. Every request must match the original method, parameters, JSON-RPC ID, wire text and order; an external mismatch latch prevents engine error handling from hiding a replay discrepancy.

The full API result is compared, excluding only validated generated `id`, `createdAt`, `timing`, and transport `durationMs`. All state, trace, discovery, preview, permission, sequence, source and raw transport fields remain in the comparison. Failed or unused responses cannot be replaced or ignored.

The verifier separately reconstructs state from raw pre/post diffs without importing the product's state normalization or composition helpers. Explicit provider code hashes are checked against the retained runtime code using the archived Keccak primitive. It checks complete approval carry into the supply trace/diff and before queries; complete composed state into after queries; clearing of storage slots; unchanged complete headers; exact eight-word execution-header witnesses; and nonce-only measurement effects that never enter the persistent sequence state.

All ten measured rows across the two sequence examples are decoded independently from their twenty before/after return words. Amounts are not inferred from logs:

| Observation | Before raw | After raw | Delta raw |
| --- | ---: | ---: | ---: |
| Approval: sender → Aave USDC allowance | 0 | 3962903485 | 3962903485 |
| Supply: sender aUSDC balance | 0 | 3962903484 | 3962903484 |
| Supply: sender USDC balance | 3962903485 | 0 | -3962903485 |
| Supply: sender → Aave USDC allowance | 3962903485 | 0 | -3962903485 |
| Supply: reserve USDC balance | 151987610826648 | 151991573730133 | 3962903485 |

The same five independently queried rows appear in each sequence's verified prefix. The third call in the three-call case has an actual reverted trace; it is not skipped, and the earlier five measurements remain available. Baseline supply also has an actual allowance revert. Native value is zero in these examples; gas fees and signed execution are excluded.

Run from the repository root:

```sh
node reports/standard-evm-sequence/verify.mjs
node --test reports/standard-evm-sequence/verify.test.mjs
```

Eighteen focused controls pass, including altered query words, a one-unit fabricated receipt amount, missing/partial carry, cleared-slot omission, query nonce leakage, query state mutation, non-read-only descendants, changed canonical headers, skipped/relabelled third calls, lost prefix results, incorrect code hashes, transport mismatches caught inside the engine, unused responses and widened metadata exclusions. See [verification.json](verification.json) for the replay and decoded evidence IDs and [AUDIT-NOTES.md](AUDIT-NOTES.md) for the separate independent audit.

The base packet remains immutable: plan SHA-256 `14ad30f7f7031395ab2c4636ac649d0029a2ba3a9669ba1f61efa53afd4ae107`, manifest `6e861f3b9f21e8d878b5347a5990707a29fa32bca28a81bbce1cbf8ca473255c`, implementation version 0.12.0 / `3b769d18eac4e46548420e51799baf0185f56154c1fbfaaed6914f8b4cb83e60`.

These are three constructed development examples at one historical block end. Reproducibility and independent consistency checks of provider evidence do not establish an independent execution oracle, signed transaction validity, general protocol coverage, security accuracy or superiority over another service. Token labels and decimals remain historical reference metadata. No original failed discovery packet was repaired or replaced.
