# Post-freeze launch note

This note is outside the frozen capture and its source archive. It records an infrastructure launch failure before the separately started capture; it is not another simulation attempt or a change to the two fixed cases.

The frozen identities are:

- Plan SHA256: `01ac7e8b3de835dfccc7bf77da32aa46d8df9dabee1333103a5363c35902d72b`.
- Source-manifest SHA256: `68a5ce101d4efd222a7ff1466b6fb6c4c2fc9d8b3f292f1cc0a164356d5a42c2`.
- Archived `run.mjs` SHA256: `f27c943827f33b3da047929d9704ef99fb173b199f8adc2952d26e2e81224a09`.

From `/Users/home/Documents/Codex/2026-10-23/thi/outputs/transaction-lab-v021`, the exact failed command was:

```sh
/usr/bin/caffeinate -i node reports/delegated-sender-development-v1/runtime/research/delegated-sender-development-v1/run.mjs run reports/delegated-sender-development-v1 01ac7e8b3de835dfccc7bf77da32aa46d8df9dabee1333103a5363c35902d72b > /tmp/evm-delegated-development-live.log 2>&1
```

The executing agent recorded exit code **13**, elapsed wall time **0.203659334 seconds**, and no continuing process session. The retained log, independently read for this note, reports:

```text
Warning: Detected unsettled top-level await at file:///Users/home/Documents/Codex/2026-10-23/thi/outputs/transaction-lab-v021/reports/delegated-sender-development-v1/runtime/research/delegated-sender-development-v1/run.mjs:150
```

The full log SHA256 is `1f9cb9f2d78c6e20e4dd40c5ba7ab6bf889604942227963a33744eb80cca51e6`. At that line, the direct archived CLI awaits a dynamic import of its own still-evaluating module. It therefore never calls `runFrozen` and never reaches its exclusive `STARTED.json` write or RPC dispatch.

Immediately after this exit, the executing agent checked `STARTED.json`, `cases/`, `wire/`, `results.json`, and `evidence-manifest.json` under the capture directory; all five were absent. That is the contemporaneous no-dispatch observation, not a claim that those paths remain absent after the subsequent launch. The failure issued **zero public RPC requests** and produced no fresh execution or comparison outcome.

The corrected launch uses the working-tree CLI to load and call the unchanged archived `runFrozen` function; the archived-entrypoint check remains active. The executing agent reported session **25664** and log `/tmp/evm-delegated-development-live-started.log`. By the time this note was prepared, that separate launch had produced `STARTED.json` at `2026-10-28T08:10:41.288Z` and sealed results at `2026-10-28T08:10:43.856Z`, with evidence-manifest SHA256 `ffcca1c7ef3acee2440019b77d9b9c375d36e8eb9bce85f39824d8d55d4310ed`. Its execution and comparison outcomes must be read from that capture and its audit; launch completion alone establishes neither successful execution nor agreement.

The plan, source manifest, and archived runner hashes above were independently rechecked while preparing this note. No frozen source, input, or capture artifact was changed to address the launcher failure.

## Retained outcome and offline verification

Both cases stopped at their first `eth_getProof` request. dRPC returned HTTP 200 with JSON-RPC error `-32000`, stating that the historical state was not available. The packet retains two requests and 318 response bytes; no account proof verified and no EVM frame or instruction executed. Both classifications are `provider_unavailable` / `not_comparable`. There was no fallback, replacement, retry, or new oracle call. This is an availability failure of the exact historical inputs, not evidence that the sender-code change matched the old reference.

The producer verifier and a separate reviewer both checked all 1,771 archived source entries, the 32 evidence files, raw wire bytes, timing, and the source/runtime identities. Both archived child attempts reproduced exactly from the saved failed responses, excluding only validated host PID/timing metadata. The terminal execution window was 2,340.055 ms, within its fixed bound. Source entries include all 1,720 dependency files/links omitted by ordinary Git ignore rules; they are preserved explicitly. The original prospective 14/16 result is unchanged.

```sh
node research/delegated-sender-development-v1/verify.mjs reports/delegated-sender-development-v1 ffcca1c7ef3acee2440019b77d9b9c375d36e8eb9bce85f39824d8d55d4310ed 01ac7e8b3de835dfccc7bf77da32aa46d8df9dabee1333103a5363c35902d72b --replay
```
