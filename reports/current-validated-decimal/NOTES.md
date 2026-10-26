# Validated current queries: fixed development capture

The eight declared HTTP attempts completed once against frozen version **0.8.0**. Supply, borrow and direct `transferFrom` succeeded on both endpoints, with scoped before/after measurements. The router call **reverted on both endpoints** at its selected parent-block end state and produced no measurements. These are preselected development cases, not an accuracy or security score.

This packet changes only public API `request.value` encoding from hexadecimal `"0x0"` to decimal `"0"`. Every other case field, selected block, provider, provider order, reference quantity and budget matches the failed `current-validated-comparisons` plan. That immutable packet recorded eight HTTP input rejections and zero RPC calls. Both its plan and this packet remain retained. The corrected runner uses the product's real `validateSimulation` before check, binding and capture, and requires exact equality of the validated fields with each planned body. Independent review and root approval preceded the corrected capture.

## Outcomes

| Fixed case | State block | Each endpoint's outcome | RPC calls per endpoint |
| --- | ---: | --- | ---: |
| Supply | 49536896 | Execution success; balances, allowances and affected balances measured | 31 |
| Borrow | 49318777 | Execution success; balances and affected balances measured; allowances not applicable | 38 |
| Direct transferFrom A | 49322024 | Execution success; allowances and affected balances measured; specialized lending balance view not applicable | 26 |
| Router permit consumed | 35204282 | Execution reverted; all three measurement views not applicable | 3 |

Endpoints were dRPC and Hyperlend archive as frozen in `plan.json`. All eight HTTP responses were 200; HTTP success does not imply EVM execution success. Start `2026-10-26T07:04:55.789Z`, completion `2026-10-26T07:05:31.311Z`, elapsed 35.521 seconds. The capture used **196 RPC calls**, 305,383 RPC response bytes and 1,019,762 HTTP response bytes (1,325,145 total). There were no transport failures, skipped attempts, retries, fallbacks, state replacements, signatures or broadcasts.

The parsed original call traces agree exactly between endpoints for all four cases. The **13 distinct queried pairs** have equal before/after/delta values across endpoints: four supply, six borrow and three direct-transfer pairs. That is 26 provider-pair measurements supported by 104 isolated query trace/diff calls. Twelve header witnesses and six original-call state diffs support the six measured runs. This is endpoint agreement; it does not establish independent node software, execution engines or cryptographic state proof.

## Quantities and limits

Supply preserves the one-raw-unit receipt-token difference instead of substituting the deposit amount. The submitter's USDC changes from `344156193` to `329090078` raw units (−15.066115 USDC); hUSDC changes from `3179075937` to `3194142051` (+15.066114 hUSDC). Its USDC allowance decreases by `15066115` raw units. The hUSDC contract's underlying USDC increases by that same `15066115`. All three predeclared supply query references match.

Borrow gives the submitter +835.474410 USDC and **+835.474410 of debt**, with hUSDC unchanged. The raw debt balance moves from `2` to `835474412`; it is a liability, not a spendable asset gain. The hUSDC contract's underlying USDC decreases by `835474410`; its own hUSDC and variable debt balances are measured as zero before and after. All three queried borrow references match. The separately recorded hUSDC allowance reference was not queried by this applicable measurement path and is not counted as verified.

Direct transfer A measures owner `0xfc1bdd1ff58200761d56ccbce73f6f42ebe56379` USDC from `1541542` to `264475` (−1.277067) and recipient/spender/submitter `0x2908da1b63c4f7ce001bf5d875d179930a79eed4` from `4647557042700` to `4647558319767` (+1.277067). The owner's allowance to that spender decreases by `1277067`. These values were obtained from new raw state queries; no historical-position quantity was substituted or predeclared for this parent-state simulation.

The router's root returns `0x062879da`, an unverified custom-error selector, with gas used `4635280`. Both saved call traces have a failed child at `0.0.7.1.6.0`: `STATICCALL` to HyperCore precompile `0x0000000000000000000000000000000000000801`, provider-reported error `out of gas`, and gas/gasUsed `0x4327d7`. Parents propagate the custom selector. This observation **does not distinguish actual insufficient gas from provider behavior involving the precompile's state**. No gas increase or diagnostic retry was made. The selected parent-block end state, fixed 5,000,000-gas envelope and unpriced call context differ from the original historical transaction position; this does not establish how the original or a future signed transaction executes. No balance, allowance or zero-change result is asserted for this reverted call.

The admitted query profile checks the full original state overrides, sender nonce/native balance, exact configured token paths, isolated before/after query traces and nonce-only query diffs. Header witnesses show **synthetic BASEFEE zero**, while number, timestamp, gas limit, prevRandao, coinbase, chain ID and parent hash match the pinned block. This is an unsigned, unpriced simulation, not fee prediction, signed-envelope validation, future inclusion or wallet-intent verification. Token implementation addresses and observed paths are checked; runtime code hashes and malicious upgrade behavior are not independently attested. Silent changes, unknown tokens, native assets and arbitrary protocols are outside the measured view.

## Reproduction and integrity

```sh
node reports/current-validated-decimal/verify.mjs --verify
```

The offline verifier passes without network access or importing/hashing the future live source tree. It checks the capture pin, original manifests, all bound source-capture hashes, exact wire JSON and response-body hashes/bytes, fixed selection, full current envelopes and EIP-1898 selectors, original diff-derived override objects, header witnesses, four isolated calls for every admitted query pair, measured output quantities/metadata, reused pairs, final canonical header checks, known references, and cross-provider recorded evidence. Non-applicable and reverted cases remain in the results. `verification.json` retains exact raw quantities and individual statuses. The verifier is scoped to this packet and these configured query paths, not a complete independent EVM implementation.

- Capture SHA-256: `bcb186b6a3a44d94be91ad74aa9b61b83a116ea06d0ada6834d2b19da028770b`.
- Plan SHA-256: `4a2e2432a9c817823b322ecda5b90d1b06058aaa2874c35edcd6ea14aa6d202b`.
- Runner SHA-256: `c6ade22ab1c0bf070b673ed61509526672429985e0d418da400933a7da9bd6dd`.
- Core binding SHA-256: `5842eae6ce937a2622d9b87d8245453e5bbb74d4a5ef4c7d9c60e910db960abd`.
- Product version `0.8.0`; ordered 18-file source fingerprint `2205334781a09baf98c3f5cb05a546bcca7d4946aea33b510d1963c8eb561a0f`.

`manifest.json` is the original capture-time manifest. `packet-manifest.json` additionally seals the capture pin, verifier, verification results and these notes. No existing capture, product source, UI or tests were changed for this packet.
