# Observed HyperEVM permissions

Three real successful transactions were captured from public read-only RPC on chain 999. Every `*-verified.json` retains the original transaction, receipt, block by hash, canonical block by number, `callTracer` with logs and `prestateTracer` diff. All eight capture checks pass for each transaction. SHA-256 hashes and block provenance are in `summary.json`; sanitized party/call/event details are in `*-decoded.json`.

| Case | Original transaction | Block / index | Observed permission |
| --- | --- | --- | --- |
| USDC approve to Hyperlend | [0x371bf6…](https://hyperevmscan.io/tx/0x371bf6c3af982636caa9874bb107a7d3d967cea340678b5dfb856ff35f9923b5) | 36762812 / 1 | Owner `0xc6bf059aabef5668c32ebeef3dae82e59d4ebc4a` approves Hyperlend Pool `0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b` for 1,660,000,000 raw USDC. |
| Direct hUSDC permit | [0x8793c2…](https://hyperevmscan.io/tx/0x8793c27ee5aa623de4e2131296ad54d4e1276dd3e5d28b7b493f4d2080f4556e) | 47125178 / 6 | Owner `0x3e248867a2a2ddd1d901f7d595c4d02c6519b32a` authorizes spender `0x8a0f75a499c17632e5ee6cc4156099292f3e68f9` for max uint256; submitter `0xe9755d57f1b933b152b5b1ef43af64a657b58ddd` differs from owner. Deadline 1791213921 exceeds original timestamp 1790609157. |
| Nested USDC permit and spending | [0x9dba13…](https://hyperevmscan.io/tx/0x9dba139e63627a8f3693b9a63ff556f89a5358c2603738f6d98172b7ddd3074d) | 35204283 / 0 | Submitter/owner `0x0c71073344e27e33cb57fcb587fc412d689dfd1d` permits router `0x693f12e9e6b35b34458793546065e8b08e0299d6` for max uint256, deadline 1778883994. Router is the immediate permit caller. |

The direct approval/permit roots use selectors `0x095ea7b3` / `0xd505accf`. Standard permit arguments are `(owner, spender, value, deadline, v, r, s)`; decoded artifacts omit signature components. The nested router root uses selector `0x48519be8`; its USDC permit appears at CALL path `0.0.0` and implementation DELEGATECALL path `0.0.0.0`. Direct proxy roots delegate at `0.0`.

The router subsequently calls `transferFrom(owner, router, 25000000)` at path `0.0.4`. It then approves spender `0x04de1ef694923844bae419d4f832196f21767f86` for 24,812,500 raw USDC at `0.0.6`; that spender consumes all 24,812,500 at `0.0.7.1.23`. The final allowances differ from the emitted Approval values. Independent historical queries in `../historical-permissions/permit-module-validation.json` measured owner→router **0 → max−25,000,000** and router→second spender **0 → 0**, on both providers. The same capture measured direct hUSDC **0 → max** on both providers. The direct USDC approval archive measurement is **0 → 1,660,000,000**; dRPC's incomplete block transaction list prevents a trustworthy exact-position measurement and remains unavailable in `../historical-permissions/approval-module-validation.json`.

The prestate diffs contain 3, 2 and 7 changed accounts respectively, with no account creation, deletion or code changes. Omitted post-state fields denote unchanged fields; omission is not a code deletion. Router protocol interpretation remains partial even when its permission pairs are measured.

## Deployed contract semantics and provenance

The observed USDC calls delegate to [verified Circle implementation `0x003f73f58ca78880da3642c5cb71d7459b3fe4f8`](https://hyperevmscan.io/address/0x003f73f58ca78880da3642c5cb71d7459b3fe4f8#code). Its `FiatTokenV2_2`, `EIP2612`, `EIP712`, `SignatureChecker` and `FiatTokenV1` source plus complete ABI are retained in `sources/`.

- The domain uses token name, version `2`, chain ID and verifying contract. Permit uses the owner's current nonce and increments it on success. The deadline limits when the signature can be redeemed; it does not expire the resulting allowance.
- SignatureChecker uses EOA recovery or ERC-1271 contract signature validation. The ABI exposes both the standard seven-argument permit and an additional bytes-signature overload; only the standard overload was observed here.
- `_approve` sets allowance and emits Approval. `transferFrom` always subtracts spending from allowance, including max uint256, and emits no Approval for that subtraction. Therefore the latest Approval cannot stand in for final allowance.

The hUSDC call delegates to [verified implementation `0x410aa1ab680b886c875e99a7a4bfaf188508a7a3`](https://hyperevmscan.io/address/0x410aa1ab680b886c875e99a7a4bfaf188508a7a3#code). `AToken.sol` and `EIP712Base.sol` use token name, version `1`, chain ID and verifying contract; require a nonzero owner and unexpired deadline; recover the owner with ECDSA; increment the owner's nonce; then emit Approval. The caller need not be the owner, as this successful public relayed transaction demonstrates. A relayed transaction alone establishes neither user intent nor spender safety. The underlying standard is [EIP-2612](https://eips.ethereum.org/EIPS/eip-2612).

` sources/manifest.json` records original source paths, source URLs and SHA-256 hashes for extracted files, full source JSON, ABI and original explorer HTML. Explorer verification and matching observed delegate targets are the provenance basis. This work did not reproduce compilation or independently prove deployed-bytecode equivalence. Contract acceptance was observed; independent off-chain signature/domain/nonce verification and original signing intent remain unassessed.

## Search limits and failures

Discovery used one page of 100 recent transactions for a known lending wallet, two bounded USDC pages and one hUSDC page, plus bounded web search of public explorer results. Explorer method filters were ignored, so no claim of exhaustive permit filtering is made. The retained hUSDC page nevertheless contained the verified direct Permit transaction. No log-range scan was performed. Discovery stopped after the three transactions were verified.

An initial Python HTTP transport received HTTP 403 for the first two candidate captures. Those failed `*-evidence.json` artifacts remain distinct from the successful Node RPC `*-verified.json` captures. No failed evidence was silently overwritten. Raw historical public signatures appear only in original transaction/trace evidence and public source pages, never in the decoded permission summaries. No authentication, signing, broadcasting, or present-day spending permission was required.
