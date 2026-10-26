# Independent offline sequence evidence audit

The sealed packet passed this independent byte, query-value, state-carry and header audit. No discrepancy was found. This review made no network requests, imported no product engine or composition helper, and changed no base-manifest file. [audit.json](audit.json) records the decoded values and their per-step evidence IDs. The separately maintained verifier supplies archived-handler playback and negative controls; this audit does not claim those tests as its own work.

The base manifest SHA-256 is `6e861f3b9f21e8d878b5347a5990707a29fa32bca28a81bbce1cbf8ca473255c`; the plan is `14ad30f7f7031395ab2c4636ac649d0029a2ba3a9669ba1f61efa53afd4ae107`. All 73 declared files (6,610,792 bytes), 52 archived source files, five input-provenance files and the 33-file implementation fingerprint were checked. The implementation matches version 0.12.0 and SHA-256 `3b769d18eac4e46548420e51799baf0185f56154c1fbfaaed6914f8b4cb83e60`.

The exact three planned inputs, routes and order match both HTTP transcripts and the independently retained client bodies. Their 112 provider requests and successful responses have matching IDs, exact body bytes/hashes and complete transport records: 457,073 response bytes. Every engine evidence item matches its corresponding wire response; sequence-level evidence covers the complete ordered transport, including the final shared header request. The three cases use 9, 47 and 56 RPC calls respectively. No retries or replacements are recorded.

## Values decoded from actual query returns

Every amount below was decoded directly from the corresponding 32-byte `balanceOf` or `allowance` return word, then compared with the engine measurement and API preview. Neither event values, requested principal nor prior fixture outcomes supplied these amounts. Both sequence cases independently return the same five measured pairs; this is ten measurements and twenty before/after return words, not ten distinct economic cases.

The sender/owner is `0x48c16c5652add27eddb0f896748a35fc60b8d1b4`; the allowance spender is Aave Pool `0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2`. USDC is `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`; the receipt token and custody account is `0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c`.

| Step and independently queried pair | Before raw | After raw | Delta raw |
| --- | ---: | ---: | ---: |
| Approval: owner → Pool USDC allowance | 0 | 3962903485 | 3962903485 |
| Supply: sender receipt-token balance | 0 | 3962903484 | 3962903484 |
| Supply: sender USDC balance | 3962903485 | 0 | -3962903485 |
| Supply: owner → Pool USDC allowance | 3962903485 | 0 | -3962903485 |
| Supply: custody USDC balance | 151987610826648 | 151991573730133 | 3962903485 |

The one-unit difference between the sender's USDC decrease and receipt-token increase is present in the actual queried values. Custody funds are a separate account balance and are not added to the sender's assets. All twenty isolated query mutation diffs contain only the established sender nonce transition, with the independently pinned native balance unchanged.

## State and execution binding

The audit reconstructs overrides directly from the complete raw original pre/post diffs, retaining every changed basic field and storage slot, including pre-only cleared slots. Step two's original call trace, original diff and all before-query contexts use the complete approval overrides: two accounts, one slot, SHA-256 `7f20cea3604741c8ca4d36d1707d43206e80cb884af76ba83dff7f8bd96e3add`. Its after queries use the full composed state: four accounts, ten slots, SHA-256 `863e83cc65f3dd166ab60ec389fe0aaf84001fe70da7ee088e55880674ef93cf`. The third attempted call uses that same composed state, including the explicitly cleared USDC balance and allowance slots.

Pinned sender nonce is 52. Original approval starts at 52 and leaves 53; supply starts at 53 and leaves 54; the repeated supply starts at 54. Isolated queries' additional nonce increments are not carried. All pinned native-balance reads are `2558093428345938830` wei; successful original calls preserve that balance under the unpriced profile. Query traces have the expected input/account binding, supported read-call paths, no failure or logs, and no native value transfer. The raw original call trace is retained exactly; an omitted successful empty return is compared with the API's explicit `0x` representation.

Eight header-witness traces contain 64 decoded header words. Their complete before/after override maps match the independently reconstructed state plus the exact witness code. Number, timestamp, gas limit, synthetic zero BASEFEE, randomness, coinbase, chain ID and parent hash match. All fourteen complete source/final header observations are deeply equal, including the full transaction list and other supplied fields. The state hash remains `0x4badf912d1bcc7f77197108544be0ab4b8cef7a94fb7a4ee1e65fda816300dc7`.

Four optional provider `codeHash` occurrences were independently checked against the explicit runtime bytes using the byte-verified archived noble Keccak library. This is consistency between provider-supplied code and metadata, not a state proof or independent source attestation.

## Preserved failures and scope

The standalone supply executes and reverts with ABI-decoded `ERC20: transfer amount exceeds allowance`, using 122,733 gas. It has no measured token or native values. Approval and supply succeed with 55,570 and 165,499 gas. In the three-step case the third call actually executes, uses 116,474 gas and returns the same allowance error; it is not labeled skipped. The first two steps retain exactly the independently queried values above. There is no fourth live call, no claim of atomic rollback, and no invented third-step zero deltas.

These are three preselected constructed development cases at a historical block end. This audit establishes recorded evidence consistency, not independent EVM execution, cryptographic state truth, complete asset discovery, transaction inclusion, fees, security accuracy or a holdout success rate. All live canonical checks succeeded; shared canonical-failure withholding is covered by separate synthetic controls, not by an injected failure in this immutable packet.

Audit JSON SHA-256: `5a21edc44d1100bb29602a008d29b08a8a9089695eed285a4d43d678aa3b8466`.
