# Affected-account and transferFrom development cases

This bounded research recommends three observed HyperEVM cases for v0.6 development. The first two were selected from the already saved 100-row USDC explorer page and captured with exactly **14 public read-only RPC requests**, seven per transaction, no retries. The third reuses existing router evidence. No new balance or allowance query was performed: this milestone projects events and joins available measurements, with additional balance measurements deferred.

| Case | Original identity | Why it matters |
| --- | --- | --- |
| Direct transferFrom A | [0xe2f9761a…](https://hyperevmscan.io/tx/0xe2f9761a3fac3ba83ee15fc5e6f12b55d15cd804b321a2cffd9d2c16d6c38dfe), block 49322025, index 0 | External submitter/spender receives 1277067 raw USDC from a different owner. All ten capture identity/status/position checks pass. |
| Direct transferFrom B | [0xc650c259…](https://hyperevmscan.io/tx/0xc650c2592cd04133cf7ff88969468c3e454e0b36e989fdb09a943dce283686d1), block 49321930, index 2 | Same distinct parties, amount 1118386. dRPC canonical block-by-number places the hash at index 0 rather than original index 2. Useful original-evidence/measurement-unavailable regression. No retry was made. |
| Router permit + consumption | [0x9dba139e…](https://hyperevmscan.io/tx/0x9dba139e63627a8f3693b9a63ff556f89a5358c2603738f6d98172b7ddd3074d), block 35204283, index 0 | Nested spender differs from root contract; owner differs from external submitter. An intermediate allowance of 24812500 is consumed completely, leaving 0 → 0 overall. Five USDC transfer participants need separate event effects. |

For direct A/B, token is USDC `0xb88339cb7199b77e23db6e890353e22632ba630f`. The root CALL at path `0` is `transferFrom(address,address,uint256)` (`0x23b872dd`). Owner is `0xfc1bdd1ff58200761d56ccbce73f6f42ebe56379`; spender, external submitter and recipient are `0x2908da1b63c4f7ce001bf5d875d179930a79eed4`. Proxy DELEGATECALL `0.0` targets verified Circle implementation `0x003f73f58ca78880da3642c5cb71d7459b3fe4f8`. Both original transactions succeeded, returned true, and emitted one matching USDC Transfer. They establish execution and party roles; neither owner intent nor spender trustworthiness is assessed.

The router external submitter is `0x0c71073344e27e33cb57fcb587fc412d689dfd1d`; root contract is `0x693f12e9e6b35b34458793546065e8b08e0299d6`. At path `0.0.4`, the router spends the external submitter's 25000000 USDC and receives it. At `0.0.7.1.23`, spender `0x04de1ef694923844bae419d4f832196f21767f86` spends 24812500 owned by the router and receives it. Thus `request.from`, transfer owner, immediate spender and root contract cannot be substituted for one another.

The router's USDC event net amounts are:

| Account | Transfer-event net, raw USDC |
| --- | ---: |
| `0x0c71073344e27e33cb57fcb587fc412d689dfd1d` | -25000000 |
| `0x693f12e9e6b35b34458793546065e8b08e0299d6` | 0 |
| `0x04de1ef694923844bae419d4f832196f21767f86` | +24812304 |
| `0x7fe37fc2f987eb981a0fc63cf1eabf04463550d4` | +196 |
| `0xb4894380282533a86cb241145fac54aaac995f18` | +187500 |

The second spender receives 24812500 but also emits a 196 transfer. The router receives and spends funds while its net is zero. Preserve gross events as well as net amounts. These rows describe receipt events; **none is an independently measured token balance** in this research.

## Available state and deferred queries

Each new raw capture contains transaction, receipt, block by hash, canonical block by number, full callTracer logs and prestate diff. Token storage changes are retained as evidence, but they are not decoded into substitute balance measurements.

The existing router HTTP capture `../permission-comparisons/2026-10-25T15-26-52-549Z-http.json` independently measures both allowance pairs at the exact original transaction position on both providers: owner→router 0 → max−25000000, router→second spender 0 → 0. The latter's intermediate Approval is 24812500. Source and snapshot hashes are preserved in `router-permit-consumption-decoded.json`.

For future measured USDC balance coverage, query `balanceOf` before and after the original transaction for both direct-case participants (2 pairs), and for all five router participants (5 pairs). The direct transferFrom allowance pair is owner→immediate spender (1 pair); router has the existing 2 pairs. Exact calldata and block-hash/position pairs are recorded under `requiredIndependentQueries` in each decoded artifact: A indexes 0/1, B 2/3, router 0/1. Use the original header and validated transaction-position context, not end-of-block balances. Case B must remain unavailable on the captured inconsistent dRPC evidence. Do not infer unknown before/after values from event amounts or raw storage without an independently verified layout.

Only configured tokens should receive verified metadata. Other router Transfer tokens remain raw addresses and exact integer amounts. Debt-token movements must retain liability roles. Zero-address mint/burn endpoints are event semantics, not spendable wallets or ordinary balance-query targets.

## Expected regression updates after v0.6 freeze

- Preserve v0.5 captures and their original source hashes. New observed RPC calls belong in new v0.6 artifacts. Original transaction, receipt, call trace, event quantities, lending principal/rounding and unchanged balance results should remain equal across versions; generated metadata is validated separately.
- Direct A should surface the owner's outgoing event effect even though the external sender receives tokens. Direct B retains both event effects when final allowance measurement cannot validate the original position.
- Router permission observations gain two transferFrom calls. They reuse the two already measured allowance pairs, so no new allowance pair or balance RPC is needed. Existing approve/permit/event observations remain; positional observation IDs may change when new observations are inserted, so regressions should match by kind/token/owner/spender/frame rather than assume old IDs.
- Historical supply (`0x25e076…`, call `0.0.0.3`, 15066115 raw) and repay (`0x682c1d…`, call `0.0.1.4`, 199626280 raw) each contain a successful USDC transferFrom for owner `0x9a1dbc6a6e7e59f6beb23db0d00b603fc90e94d0`, spender Hyperlend Pool `0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b`, recipient hUSDC `0x744e4f26ee30213989216e1632d9be3547c4885b`. Their existing replay recordings lack the newly required allowance-query RPC results; refresh successful historical/current captures after schema freeze instead of manufacturing replies. Withdraw and borrow contain no configured USDC transferFrom, so this feature adds no allowance pair for them.
- Existing permission replay tests will gain accountEffects and consumption observations; original raw evidence and measured allowance values should remain unchanged. Existing historical lending tests will also gain allowance measurement evidence for supply/repay. Explicitly test event-only accounts versus joined measured accounts, zero net with nonzero flows, owner/submitter/spender distinctions, raw unknown-token amounts and liability roles.

These cases are a reviewed development corpus, not blind evaluation, performance testing or a security score. No existing core files, replay tests or v0.5 evidence were edited for this research.
