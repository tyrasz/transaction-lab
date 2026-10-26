# Separate archive withdrawal regression control

This independently budgeted **one-shot** HTTP control was authorized after the fixed fourteen-request replay packet completed, to fill an archive-provider gap in the existing lending module regression fixtures. It is additional development coverage, not a replacement for the earlier archive retrieval failure, Direct B unavailable result, or any prospective evaluation case. Those artifacts remain unchanged.

The single transaction is `0x94b5c4672e28cbeeab547c06f60e30afa02ac58b0cad4c7568a6ca9d8ac29ae7`, using only `https://rpc.hyperlend.finance/archive`. The product remained frozen at version **0.7.1**, source SHA-256 `1d7c3a202cc691729b0b31a6d1abf65fa32fb3a0d2b31c31e458240198b38b10`. The plan was written, locally checked and bound before execution. It capped the run at 80 RPCs, 8 MiB per response, 32 MiB total and 120 seconds, with no retry, fallback or substitute transaction.

The run took place from **2026-10-26 06:28:37.202 to 06:28:52.383 UTC**. It returned HTTP 200 after **39 RPCs**, with no failures or skips. RPC response bytes were 115,279 and API response bytes were 240,453, for **355,732 bytes total**. Recorded duration was 15.180 seconds; this is not a timing guarantee.

Lending balances and affected-account balances were measured; allowance was not applicable. The original and replayed complete pre/post diffs are exactly equal as parsed objects. Final canonical checks passed. The withdrawing account's USDC was `772133294 → 1276033520` raw, hUSDC was `6181482361 → 5677582135`, and variable debt remained `38377163`. Reserve USDC was `4883613056907 → 4883109156681`. Three affected-account pairs reused validated lending measurements. Event-derived amounts remain separately labeled; they do not replace queried balances.

The immutable **capture SHA-256 is `19e405356e7d9ba2eca23968cc33b9ff68bdfc8dbb27d2090b03c1c9c2d59a74`**. The plan hash is `bde67ca11792b88bd7e0bdffe5c3bc0533850e7cbfde67732d0952ac32d833aa`, and the frozen-core binding hash is `37cfd539430f98ecfe298978a93e5008c3feb608598ae6941ba8f7af5485245a`.

Offline verification from the project root:

```sh
node reports/replay-state-archive-withdraw/verify.mjs
```

This checks raw transport/body fingerprints, source binding and admitted original/replay state evidence without a network call. `verification.json` retains its output. The capture runner was copied from the reviewed fourteen-run runner with only fixed count, provider and conditional-estimate assertions changed; that source is hash-linked in the plan. This packet uses one provider and offers no independent-engine, cryptographic state-proof, safety, or general accuracy claim.
