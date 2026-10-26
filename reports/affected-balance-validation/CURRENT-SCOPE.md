# Current-state query provenance boundary

Read-only review, October 26, 2026. No new RPC or web requests, deployments, source edits, or exploit experiments were performed.

**Recommendation:** generic affected-account balances in current simulations should return `unavailable` until the before/after balance queries have traced, validated execution provenance. Existing reconciled lending measurements and newly validated historical measurements are separate scopes. Rejecting proxy implementation-slot changes is useful defense in depth, but does not justify enabling generic current measurements by itself.

## Concrete gap

`src/state.js` constructs post-state overrides from a `prestateTracer` diff. It rejects account creation/deletion and changed runtime code, but ordinary storage changes are allowed. `readPair` then accepts any one-word `eth_call` result before and after those overrides. A proxy implementation upgrade changes storage while leaving proxy runtime unchanged; an earlier Transfer through the expected implementation cannot establish the implementation used by the later balance query. A valid uint256 return alone is insufficient provenance.

The historical path is stronger: `src/historical-state.js` validates each query's root call, exact calldata, expected token DELEGATECALL target and returned word. hUSDC and variable-debt queries additionally require the specific Pool STATICCALL selector/USDC argument and the expected Pool implementation. Query-state diffs validate nonce/fees and reject query storage/code changes. This remains provider/adapter validation, not cryptographic proof of correct execution.

## Exact retained slot evidence

| Contract | Implementation-slot constant seen in retained proxy runtime | Saved evidence |
| --- | --- | --- |
| USDC `0xb88339cb7199b77e23db6e890353e22632ba630f` | `0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3` | `reports/historical-permissions/view-module-validation.json`, `runs[0].evidence.response[3].result.pre[USDC].code` |
| hUSDC `0x744e4f26ee30213989216e1632d9be3547c4885b` | `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` | Same artifact/path with hUSDC address |
| Variable-debt USDC `0xd612513cb3b2c52abcd6d4b338374c09ada4657d` | `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` | `reports/lending-discovery/measured-current-balances.json`, `cases[1].balanceChanges.evidence.response[1].result.pre[VUSDC].code` |
| Pool `0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b` | `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` | `reports/historical-permissions/view-module-validation.json`, `runs[0].evidence.response[3].result.pre[POOL].code` |

Runtime byte lengths/SHA-256: USDC 1,798 / `a076bfa80c643b27558babf0a2b87e2b939a7004ad33952da352d6f81945c40b`; hUSDC and VUSDC 1,853 / `693134f1592d14ee29772e4361a3c1a09ea2915eeaa0650df85f6109a55b4f35`; Pool 1,853 / `f9caa50a15fb0e6fdc63f6163d1535444778775fb5919059dc19415e99615e1d`.

These are **observed bytecode constants**, not a completed source-to-runtime proof. The saved compiler inputs under `reports/permission-discovery/sources/{usdc,husdc}-standard-input.json` and `reports/lending-discovery/sources/{debt,pool}-standard-input.json` contain implementation sources and dependencies; they do not contain the deployed proxy sources. Matching a familiar constant is not equivalent to compiling the deployed proxy or proving its complete dispatch behavior. The listed snapshots also do not prove the routing at every future pinned block.

## Why a slot-only guard is insufficient

- A net diff does not establish the initial implementation when that slot is unchanged/omitted. Prior event provenance only covers the specific earlier call.
- A proxy can upgrade and restore its implementation within one transaction, leaving no net implementation-slot change. A diff alone omits that history.
- Scaled-token `balanceOf` depends on the Pool as well as the token implementation. Checking only token slots misses Pool routing changes.
- Configured metadata and implementation addresses are assumptions requiring their own provenance; a one-word reply proves neither decimals nor ordinary ERC20 semantics. Tracing known targets improves execution provenance but does not establish consent or safety.

The saved verified implementation sources show the dependency explicitly: `reports/permission-discovery/sources/usdc-FiatTokenV1.sol:204` returns `_balanceOf(account)`; the override in `usdc-FiatTokenV2_2.sol:247` masks its balance/blacklist storage word. `husdc-AToken.sol:134` reads the Pool's normalized-income index for `_underlyingAsset`. `reports/lending-discovery/sources/deployed-VariableDebtToken.sol:69` reads normalized variable debt. The two latter contracts therefore require their expected Pool query paths, state, timestamp and rounding rules to be checked. See [NOTES.md](NOTES.md) for the scaled-balance arithmetic distinction.

## Smallest defensible next step

Keep the generic current path explicitly unavailable with no extra measurement RPC. In the next milestone, trace both before and override-applied queries at the same pinned block, require the known token/Pool call structure and exact outputs, validate query isolation and lifecycle/code limitations, and bind final canonical status across all consumers. Provider support for post-override tracing must first be demonstrated and recorded; do not silently fall back to untraced calls. Slot-change rejection can then be an additional conservative guard, with its deployed-source/runtime provenance documented separately.
