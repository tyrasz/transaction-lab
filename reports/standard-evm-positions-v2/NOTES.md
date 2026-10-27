# Position-query capture and replay

This note and the adjacent verification/diagnostic files were added after sealing. They are supplemental; the original capture manifest and all 143 bound files remain unchanged.

The three fixed requests returned HTTP 200 with verified canonical context. The original deposit executions and both sequence steps succeeded. **Only Morpho's position query was measured. All three Aave account-data checks remained unavailable.** Successful execution does not imply complete position coverage.

| Fixed request | Measured token queries | Position result | RPC calls / response bytes |
| --- | --- | --- | --- |
| Aave supplyWithPermit | 4 of 4 | Account data unavailable | 31 / 105,406 |
| Morpho wrapper deposit | 3 of 3 | Inner-vault Blue position measured | 31 / 368,412 |
| Aave approval → supply | 1 of 1, then 4 of 4 | Account data unavailable in both steps | 50 / 193,651 |

Capture total: 112 read-only RPC calls, 667,469 response bytes, approximately 27.225 seconds. No retries, replacements, signing, broadcasting or funding overrides. The sequence approval changed USDC allowance from 0 to 3,962,903,485 raw units; the following supply consumed it back to 0. Its state was carried between steps, not treated as an atomic signed bundle.

Morpho's measured position belongs to inner vault `0xbeef01735c132ada46aa9aa4c54623caa92a64cb`, not the transaction sender. In market `0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64`, supplyShares changed from `26565631929266438023` to `26884573979212466695` (delta `318942049946028672`). borrowShares and collateral were each measured as 0 → 0. Shares were not converted to assets.

The earlier packet at `../standard-evm-positions/` is preserved separately: local socket binding failed with EPERM before any HTTP or public RPC, so all three cases were not attempted. Its manifest is `91c45895cfaf8ed78ad73fc9b19b8b18438086b474837405c40790fc943d43e3`. This v2 packet is a declared permission-corrected attempt with identical cases, provider, limits and product source—not an overwritten or success-selected result.

## Offline verification

From the repository root:

```sh
node reports/standard-evm-positions-v2/verify.mjs 834962759a7629aabaedc4b778b828f4df92b11b4c8e548ad7b3648ff95d2f13
```

Result: `reproduced`. All 143 sealed files, 117 archived source files, fixed input bindings and 112 wire exchanges were checked. The archived real HTTP handler and transport reproduced all three responses, including every unavailable Aave row. Only generated run IDs, timestamps, aggregate timing and individual transport durations were excluded from semantic equality. No current product imports, sockets or public requests were used. Saved output: [verification.json](verification.json).

Plan SHA256: `4296ee6765f6e5734f5ebdc1085987eccaa47fe935e83408effe67bf97d3a0eb`.
Capture manifest SHA256: `834962759a7629aabaedc4b778b828f4df92b11b4c8e548ad7b3648ff95d2f13`.
Product v0.13.0 SHA256: `e0f182d2c99e1767ff2c51f9a736b8de6d07b9bb7e3eb4e21017e838d505bda1`.

## Aave guard diagnosis and next change

The captured error is `Query delegate does not preserve its input and output.` The three saved first-query traces are single-call evidence 30 and sequence-step evidence 17/30. In each, the Pool delegates to implementation `0x728a138a4823392c2efa55e028d434f526fe03cf`, which makes a second delegate call at path `[0,1]` to `0xd70593841c57cbaa04957cc3eace95708e48853b`. This child changes the selector from `0xbf92857c` to `0x26ec273f` and calldata from 36 to 228 bytes while returning the same 192-byte tuple. It retains the Pool as execution context. Each trace has 20 frames: one root CALL, five DELEGATECALLs and fourteen STATICCALLs, with no observed error, event or nonzero value. See [aave-delegation-diagnostic.json](aave-delegation-diagnostic.json).

The guard assumes every delegate call forwards its parent's input and output unchanged. That assumption fits a simple proxy but excludes external library calls. Aave's [Pool source](https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/protocol/pool/Pool.sol) calls `PoolLogic.executeGetUserAccountData` with a different parameter structure; its [library source](https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/protocol/libraries/logic/PoolLogic.sol) exposes that function as an external view. These primary references support the library-call interpretation; this investigation does not authenticate historical deployment bytecode from repository HEAD.

Proposed narrow fix: allow different delegate calldata/return data for explicitly declared position queries only. Keep the existing token-query policy unchanged. Preserve exact root envelope and ABI tuple validation, execution-context checks, allowed child types, bounds, zero value, no logs/failures, isolated before/after traces, nonce-only mutation proofs, full original state overrides and final canonical checks. No address allowlist or library-reputation claim is needed.

Meaningful regression: the actual saved Aave trace should pass the revised position trace check; synthetic mutations of nested caller, child CALL, value, logs, failure, tuple length/high bits or query mutation must still fail. The legacy token delegate guard must remain strict. This packet contains only each rejected first trace, with no corresponding query diff or after trace, so it cannot establish an Aave before/after measurement. A subsequent separately frozen capture is needed after the fix. No runtime code was changed here.

These are selected development cases and provider-consistency evidence. Replay is reproducibility of the same implementation, not a second execution engine, deployment attestation, complete-effects claim, security verdict or broad accuracy score.
