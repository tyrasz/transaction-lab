# Selected 100-USDC lending-call supplement: input design only

Propose two **new, deliberately selected** sequences: approve 100 USDC, supply/deposit 100 USDC, then withdraw 50 USDC, using sender `0x44c3a96181af9e295ce8e188fa8fcdd72d1eb668` for both Aave and Kiln. This note does not construct a capture or authorize dispatch. No source, template, prior packet, RPC state or execution result is changed by this design.

The completed fresh-header experiment remains unchanged: both original deposit amounts reverted for insufficient balance; four executed original positions agreed across five channels, and thirteen query pairs agreed across three channels. The proposed supplement selects smaller inputs using that observation. It is successful-path coverage sought after seeing a failure, not a reclassification of that failure, a prospective random sample, or an accuracy percentage.

## Recorded selection rationale, not current funding

At saved block **26,310,458**, hash `0x8c522e1f727e66ca3f5a31ea41deab00fd1a835064ec09a8dc971c111ddeb946`, the local Kiln report measured `112952478562` raw USDC (112,952.478562 USDC). The prior requested deposit was `350000000000` raw USDC. Its sender proof had the empty-code hash `0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470`.

These are historical observations only. Funding, code, allowance, protocol liquidity, limits and withdrawal eligibility may differ at the next selected header. Do not import their values into simulation state, assert success, replace the sender, lower the amount again, or select another header after failure. Reacquire authenticated inputs through the normal fixed-header local execution path. The public address is a simulation sender; no private key, signature, transaction broadcast, approval transaction or funding transfer is involved.

Recorded rationale source: `../lending-local-sequence-current-v037/capture/local/002/report.json`, SHA-256 `85410cd1267711f4d11937672fc63cf1629e20de46666923617a219d5927d2e2`. JSON pointers: `/report/steps/0/measurements/0/values/0/beforeRaw` and `/report/attempt/sequence/inputEvidence/0/result/codeHash`. Prior packet pins: intent `814889cb61ec7078ae2192a55ce6af72ea18c3675d89cbad092818f4aacb20cd`, plan `63117e789becf9b1efa85ed09a40ed3ac0b052bf584696ee9e1d5fcb3db915a6`, manifest `9b2a3937f5bb1f024e73f171211273d31459792a4ec393f6050337eed87a501a`.

## Fixed new call declarations

Use distinct case IDs `aave-usdc-selected-100-supply-50-withdraw` and `kiln-usdc-selected-100-deposit-50-withdraw`. Both use chain ID 1, the sender above, native value zero, the existing unsigned/unpriced block-end profile, and 5,000,000 original gas. The two sequences start independently from the same freshly selected header; Aave's simulated state is never carried into Kiln. Only the three originals within each sequence share state. Stop at the first non-success and retain subsequent unattempted positions.

Fixed addresses:

| Symbol | Address |
| --- | --- |
| S, sender/receiver/owner | `0x44c3a96181af9e295ce8e188fa8fcdd72d1eb668` |
| U, USDC | `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` |
| P, Aave Pool | `0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2` |
| A, aEthUSDC | `0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c` |
| K, Kiln outer wrapper | `0x334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b` |
| V, inner vault | `0xbeef01735c132ada46aa9aa4c54623caa92a64cb` |
| B, Morpho Blue | `0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb` |

Let `D = 100000000` (`0x5f5e100`) and `W = 50000000` (`0x2faf080`), using six USDC decimals. ABI calldata is exactly the selector followed by the listed 32-byte words, addresses left-padded with twelve zero bytes and unsigned integers left-padded to 32 bytes. All words use lowercase hexadecimal; no extra trailing bytes or dynamic encoding is permitted.

| Case/step | Target | Signature / selector | Ordered words |
| --- | --- | --- | --- |
| Aave 0 | U | `approve(address,uint256)` / `0x095ea7b3` | P, D |
| Aave 1 | P | `supply(address,uint256,address,uint16)` / `0x617ba037` | U, D, S, 0 |
| Aave 2 | P | `withdraw(address,uint256,address)` / `0x69328dec` | U, W, S |
| Kiln 0 | U | `approve(address,uint256)` / `0x095ea7b3` | K, D |
| Kiln 1 | K | `deposit(uint256,address)` / `0x6e553f65` | D, S |
| Kiln 2 | K | `withdraw(uint256,address,address)` / `0xb460af94` | W, S, S |

Withdrawal amounts denote underlying USDC assets, not receipt-token, wrapper or inner-vault shares. Freeze `amounts` as depositRaw `"100000000"`, withdrawRaw `"50000000"`, decimals 6, with an explicit fixed-50-assets rule. Mark every new step as newly constructed, preserving old ABI/protocol provenance separately; do not carry old `previouslyCaptured:true`, historical transaction identity or old amount-specific limitations as descriptions of these calls.

The encodings above are already bound in `../lending-local-sequence-v037/declarations.mjs` (`calldata`, `addressWord`, `uintWord`, and the Aave/Kiln construction). Its `SOURCE_FILES` retains the saved official Aave Pool withdrawal documentation and Kiln plugin ABI specification, plus the prior input plans. This design reads those existing bindings and performs no new web fetch or current ABI claim.

## Query identity and substitution

Retain the five Aave and eight Kiln queries, in the existing order. Update every representation together: `case.from`, `localInput.from`, `providerInput.from`, original calldata, `steps[].request`, `localInput.queries`, every provider call's query list, `queryRoles[].descriptor`, and relevant role `subject.account`. Preserve provenance as derivation from an older descriptor, not proof that the amended descriptor was previously executed.

| Aave query index | Required descriptor |
| --- | --- |
| 0 | U `balanceOf(S)` |
| 1 | A `balanceOf(S)` |
| 2 | U `balanceOf(A)`; reserve identity unchanged |
| 3 | U `allowance(S,P)`; spender remains Pool |
| 4 | `{kind:'aave_v3_user_account_data',contract:P,user:S}` |

This changes Aave indices 0, 1, 3 and 4 from its old sender. Kiln already uses S: its descriptors remain U `balanceOf(S)`, K `balanceOf(S)`, V `balanceOf(K)`, U `balanceOf(K)`, U `balanceOf(V)`, U `balanceOf(B)`, U `allowance(S,K)`, and the existing Blue position. That last descriptor retains **user V**, contract B and market ID `0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64`; it does not measure sender-owned Blue shares. Never perform blanket address replacement across contract, reserve, vault or market identities.

Recompile descriptors with `compilePreviewQueries(queries,{chainId:1})` from `engines/local-evm/preview-queries.js`, and compare regenerated ABI identities and roles against the declared subjects. Do not reuse compiled old identities. Keep allowance and balance selectors `0xdd62ed3e` and `0x70a08231`, complete word counts, distinct canonical queries, and list equality across all repeated representations. No expected balance/share output or fixed share conversion is supplied.

## Minimal implementation and archive boundary

Reuse the audited current coordinator, selector, capture, worker and adjudicator code paths; do not fork another set of parallel driver copies. A small, explicitly enumerated declaration profile can derive this supplement from the two hash-pinned base input templates plus the fixed amendment above. Freeze the experiment profile and amendment before network access, and make the worker and saved adjudicator independently derive the same selected inputs. Reject arbitrary sender/amount substitutions. The prior frozen runtime and packets remain immutable; a new capture location archives the new source version.

The existing historical template byte pins remain `c50936237fed1d59740521b1928f2a4bef74e496ec308f5f65d02281164e3f5c` and `3b09b2898f5b5c7b1d9f758b793f5e6f3246ca0f241cc20b71cc89637171737c`. Preserve both exact originals, a machine-readable list of allowed new-input changes, new experiment/case IDs, amount and subject provenance, ABI source pins, raw amended template bytes and SHA-256 values, source/Node inventories, and fresh intent/selection/final-plan identities. New template hashes must be computed from the eventual exact serialized bytes; none are invented here.

Before dispatch, pure controls must decode all six calldatas against the constants above, reject altered D/W/referral/receiver/owner/spender words, detect stale Aave sender queries or roles, preserve the Blue user, establish local/provider original equality, and prove only the selected header and block hashes change after the new intent is frozen. Run both API input validators without execution. The existing two-case/six-position denominator and resource caps do not expand.

Use a new one-shot header selection under the existing policy: chain check, one latest read, selected-height confirmation, full-header verification, recorded clocks, no funding lookup during selection, no retry/reselection, and freshness checked immediately before the first actual worker spawn. Seal both final inputs before any target. Retain local Aave, local Kiln, provider Aave, provider Kiln order and all raw results, including any repeated insufficient-balance failure.

## Reporting limit

Keep all six original positions / thirty original channels and thirty-nine query pairs / 117 query channels even if calls revert, input proofs are unavailable, or later calls stop. Report this supplement separately from both previous experiments. Successful executions would extend selected protocol-path evidence, not establish that an approval was necessary, that a withdrawal used only newly minted shares, or that all position changes are covered.

Local getters still use 1M gas after all originals; provider getters use 300k between originals. Agreement is observational under those different query contexts. Both paths use the same public RPC infrastructure; this is direct API-adapter evidence, not HTTP/frontend execution, independent consensus, signed transaction replay, current wallet funding assurance or a general accuracy claim.
