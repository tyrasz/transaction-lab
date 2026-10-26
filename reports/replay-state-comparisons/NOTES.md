# Historical replay state-diff guard: fixed development capture

The predeclared fourteen-request matrix ran once from **2026-10-26 06:24:50.363 to 06:26:34.864 UTC**. All fourteen requests returned HTTP 200; this does not imply every measurement was admitted. There were **467 read-only RPC calls**, no transport failures, retries, replacements or skipped attempts. Exact retained response bodies total 6,069,680 bytes: 1,872,877 RPC bytes plus 4,196,803 local API bytes. The 104.5-second duration is capture metadata, not a latency benchmark.

The frozen product was **0.7.1**, source SHA-256 `1d7c3a202cc691729b0b31a6d1abf65fa32fb3a0d2b31c31e458240198b38b10`. All API responses identify that source and its seventeen-file inventory. The pre-run plan has SHA-256 `4df6b30700e89e185816ce4ee03e87f08185695bfb9ada0fccca90fdd70854c6`; its separate frozen-core binding has SHA-256 `2998b01ab6b8df91a246e79e8c2876f420be6e46ef7bfa91228e82556de74339`.

The immutable **capture SHA-256 is `51d7cb6ba049b1cd38da52ba2131b4bc328ac264419c240f132c3b570f8ed610`**. `capture.json` contains genuine new RPC sequences, full local HTTP requests/responses, raw successful JSON-RPC body text, parsed envelopes, byte counts and checksums. No old original diff was fabricated as a newly recorded replay diff.

| Case | Providers | RPC calls each | Lending balances | Allowance | Affected balances |
| --- | --- | ---: | --- | --- | --- |
| Supply | dRPC, archive | 32, 32 | Measured | Measured | Measured |
| Withdraw | dRPC | 39 | Measured | Not applicable | Measured |
| Borrow | dRPC, archive | 39, 39 | Measured | Not applicable | Measured |
| Repay | dRPC, archive | 44, 44 | Measured | Measured | Measured |
| Direct transfer A | dRPC | 28 | Not applicable | Measured | Measured |
| Direct transfer B | dRPC | 28 | Not applicable | Unavailable | Unavailable |
| Router permit/consumption | dRPC, archive | 44, 44 | Not applicable | Measured | Measured |
| Direct USDC approval | archive | 18 | Not applicable | Measured | Not applicable |
| Relayed hUSDC permit | dRPC, archive | 18, 18 | Not applicable | Measured | Not applicable |

## New guard and the retained unavailable result

Admitted measurements carry `validation.originalReplayState = complete_pre_post_diff_match`. The offline verifier confirms exact parsed-object equality between the recorded original `prestateTracer` **diff-mode** response and the original-envelope `debug_traceCallMany` diff response for every admitted case. Generic-root code proof uses a separate full-prestate response; it must not be mistaken for the diff-mode response. The new guard supplements semantic execution, receipt, header, query provenance and canonical-position checks. It does not replace them.

Direct B demonstrates the final shared canonical check in a real run. For block 49,321,930, hash `0x8f8b0ab3bf724d5a7edba34836075ec1bc98289808f232389a99dc472c629656`, RPC entries 4, 7, 8 and 19 return five transaction hashes with the target at index 2. The final entry 28 returns the **same block hash but only three transactions**, with the target at index 0. The transaction and receipt specify index 2. The resulting canonical failure invalidates the earlier allowance and affected-account results: allowance/assets/reused-pair arrays are empty and measurement execution identities are absent. These empty arrays mean unavailable evidence, not zero effects. No retry or index adjustment was made.

The prior v0.7 Direct B successful capture and v0.6 early index-conflict capture remain unchanged. Their different observed provider responses are separate evidence. This run's final failure is also retained; it is not replaced by an older positive or a subsequent attempt.

## Verification and scope

Run this offline from the project root:

```sh
node reports/replay-state-comparisons/verify.mjs
```

It verifies packet fingerprints, source references, planned identities, raw body hashes, request IDs, full byte/count accounting, product identity and original/replay diff equality on admitted measurements. `verification.json` retains its result. `manifest.json` is the original run manifest; `packet-manifest.json` additionally hashes final notes and the offline verifier without changing that run manifest or capture.

These are already inspected development cases, selected for regression coverage. They do not provide a global EVM accuracy percentage, held-out security score, provider/engine independence, or proof of complete unreported state equality. Unsigned type-2 reconstruction still uses the original effective gas price; matching the changed-state diff does not validate the original signature or full signed-transaction rules.

After this packet was sealed, a separate one-request archive withdrawal control was authorized to complete a module-test provider gap. Its plan, budget and immutable result are in `../replay-state-archive-withdraw/`. It is additional development coverage and is excluded from every count in this packet. No original prospective-pilot or earlier failure evidence was altered.
