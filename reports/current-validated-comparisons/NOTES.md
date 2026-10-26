# Current validation capture: rejected input, no provider evidence

The fixed eight development attempts were made once on 26 October 2026 against the frozen 0.8.0 local HTTP API. All eight returned HTTP 400 before any blockchain RPC request. This packet therefore provides **no execution, balance, allowance, or cross-provider validation result** for the new current query profile.

The capture plan copied `value: "0x0"` from the raw transaction envelopes. The public `/api/simulate` input contract requires an unsigned decimal wei string, so its response was:

```json
{"error":{"code":"INVALID_INPUT","message":"value must be an unsigned decimal wei string within uint256."}}
```

This was a capture-plan input error, not a provider failure or an observed EVM revert. The plan's offline check verified its own hexadecimal-zero assumption and missed the public API contract. The reviewer and capture author did not catch that mismatch before binding. The complete plan, runner, binding, exact HTTP requests and responses remain unchanged. No retries, replacement states, new endpoints, signatures or broadcasts were attempted. A corrected decimal-zero request would need a separately declared packet, retaining this failed packet.

## Recorded outcome

- Start: `2026-10-26T06:58:20.342Z`; end: `2026-10-26T06:58:20.389Z`.
- Eight planned and attempted HTTP requests; zero HTTP 200, eight HTTP 400.
- Zero RPC requests, zero RPC bytes; 856 total HTTP response bytes.
- Zero measured runs; all four cross-provider comparisons are `not_comparable`.
- Known supply and borrow reference quantities were not queried or validated. No direct-transfer/router expectations were invented.

Capture SHA-256: `391522d206dfa8add52c3b8a275729fd286e94a35c3b12cb863010a2e9fe8884`.

Frozen product: version `0.8.0`, source fingerprint `2205334781a09baf98c3f5cb05a546bcca7d4946aea33b510d1963c8eb561a0f`. The 18 ordered source hashes are in `frozen-core.json`; its SHA-256 is `7754748ed8920f5ba69a9c073c5ddbb818a5a651d5fdc16eb2230b48f1c2e81b`. The product fingerprint was checked by the runner before each attempt; rejected API responses do not themselves include product identity.

## Offline verification

From the project root:

```sh
node reports/current-validated-comparisons/verify.mjs --verify
```

This passes without network access or importing/hashing the live source tree. It verifies the sealed capture pin, original manifest, frozen plan/script/binding hashes, source-capture hashes, exact HTTP JSON/body hashes and byte accounting, eight unique planned attempts, and preservation of errors. The verifier's current-query proof branches are **not exercised by this packet**, because there are no RPC results or admitted measurements. `verification.json` records `measuredRunCount: 0`; absent execution statuses are not counted as agreement. `manifest.json` is the original capture-time manifest; `packet-manifest.json` additionally seals the offline audit and this explanation.

This is a failed preselected development capture, not a prospective evaluation, a security score, or evidence of any general EVM accuracy rate.
