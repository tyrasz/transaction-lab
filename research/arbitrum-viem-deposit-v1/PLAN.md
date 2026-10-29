# Fixed public CCTP request through viem on Arbitrum

Status: preparation only. No deposit-target simulation or fresh scenario RPC has run. The separate minimal capability packet is unchanged.

## Purpose and fixed input

This is a provider-backed source-chain development experiment using the existing public request, not an independent-local-engine run, held-out coverage sample, bridge completion check, or destination balance prediction. The original bytes are copied from `/Users/home/Documents/Codex/2026-10-23/thi/work/dynamic-cctp-app/src/scenario.json` to `scenario.json`; SHA-256 `5674c7568a54d5832ee76af440bda85c88621645637b2a24283b23843da430fa`.

- Chain: Arbitrum One, 42161.
- Sender: `0xe721a0532a7828df67ad519aa25c602da076159a`.
- Destination: TokenMessengerV2 `0x28b5a0e9c621a5badaa536219b3a228c8168cf5d`.
- Native value: zero. Calldata: the exact original `0x779b432d…` bytes, with no edits.
- Declared amount: 100 USDC (100,000,000 raw units). Destination domain 19; declared maximum destination fee 200,000 raw units (0.2 USDC). Amount and fee cap remain separate.
- The hook declares HyperCore recipient equal to the sender and dex 0. This is intended perps routing, not evidence that perps is credited: the current destination code can route a disabled dex to spot.
- Earlier evidence reported an EIP-7702 delegation designator on the sender. The fresh code observation will be retained exactly; no sender replacement, code removal, funding override, allowance override, or favorable-state substitution is permitted.

The companion protocol review is being retained separately under `research/arbitrum-deposit-v1/`. Its source review confirms `allowance(sender, TokenMessengerV2)` is the relevant precheck: the messenger calls `transferFrom` from its execution context. That review is interpretation evidence, never an expected simulation output.

## Pinned library and preparation

The official homepage and npm registry both identify viem 2.57.13. `package.json` pins that exact release; `package-lock.json` pins its 13 installed packages. Installation used `--ignore-scripts --no-audit --no-fund` in this directory only. No production package or lockfile was changed. Registry response bytes and response headers are in `preparation/`; source inspection and hashes are in `preparation/source-inspection.json`.

The release tarball integrity is `sha512-hSIsR4Y47BKrp89idH11WC3pqYOJFq9nVYBYxuJ9zXCA8Qg3pQhnlhnHn4qnjo7Z5wXs920XhtWbnrAtFidk+Q==`. npm integrity checking was used; registry signatures/provenance have not been independently verified. Node is v22.23.2 and npm is 10.9.8. The complete installed file inventory must be hashed before the eventual reviewed run, and rechecked after it. The experiment must not silently pick a newer release.

## Fixed run sequence for review

One endpoint only: `https://arb1.arbitrum.io/rpc`, documented by Arbitrum. Maximum 20 actual JSON-RPC requests, 4 MiB per response, 16 MiB total response bodies, 25 seconds per request and 120 seconds overall. Request bodies are capped at 128 KiB. Decoded retained output is capped at 24 MiB. No retries, JSON-RPC batching, fallback provider, CCIP gateway requests, paid service or credentials. Viem starts no request after 110 seconds and each in-flight viem request is cancelled by that same deadline; one RPC slot and the last 10 seconds are reserved for the final header reread. Exhausting the viem phase stops that phase while preserving the final read, but marks interpretation unconfirmed. Global byte, persistence, clock or integrity failures stop all dispatch. Final-header requests use the remaining global time, up to the per-request cap. A shared deadline and cancellation apply to viem's internally concurrent work; queued work must not dispatch after failure/deadline, and pending work, including body-read cancellation, must settle or be reported incomplete before sealing. Queued requests discarded after a phase ends are counted separately from actual dispatched calls. At most 20 requests can be queued. Body sizes count decoded HTTP entity bytes returned by Fetch; compression framing and network transfer bytes are not measured.

1. Read `eth_chainId` once; require `0xa4b1`.
2. Read `eth_getBlockByNumber('latest', false)` once. Retain the exact header and select its number/hash. No target substitution or second latest selection.
3. At that explicit number, read USDC `balanceOf(sender)` using `eth_call`, token `0xaf88d065e77c8cc2239327c5edb3a432268e5831`.
4. At the same number, read USDC `allowance(sender, scenario.to)` using `eth_call`.
5. At the same number, read `eth_getBalance(sender, number)`.
6. At the same number, read `eth_getCode(sender, number)`.
7. Invoke the actual pinned viem `simulateCalls` exactly once with `account: scenario.from`, `blockNumber: BigInt(selected.number)`, `calls: [{to: scenario.to, data: scenario.data, value: 0n, gas: 2000000n, gasPrice: 0n}]`, `traceAssetChanges: true`, `traceTransfers: true`, `validation: false`. No caller state or block overrides. A deficient balance/allowance or an execution revert is retained, not repaired; precheck values never alter the request.
8. After viem's internal work has stopped and settled, reread `eth_getBlockByNumber(selected.number, false)` and require the selected hash/full header. If missing, changed, incomplete or over budget, retain all output but mark the source-chain interpretation unconfirmed.

The prechecks describe provider-reported state at the base block. viem's simulation uses synthetic successor blocks; it is not an original-position replay and does not reproduce actual L1 calldata fees or outer signed transaction validation. Zero gas price is a declared simulation parameter, not a claim that the real deposit is free. The original call gas is 2,000,000; library-owned measurement-call gas behavior is described below and must not be concealed.

## Installed source behavior and permitted measurement overrides

Reviewed release files: `viem/_esm/actions/public/simulateCalls.js`, `simulateBlocks.js`, `call.js`, `clients/transports/custom.js`, `createTransport.js`, and `utils/buildRequest.js`.

- `simulateCalls` first uses `eth_simulateV1` to discover asset candidates. It derives candidates from matching sender Transfer logs and the original destination; this is not a complete asset inventory.
- It then issues `eth_call` pre-balance reads and another `eth_simulateV1` containing the original call, a library-added zero-address call, native post-balance extraction, and token balance/decimals/tokenURI/symbol probes. Supplying an explicit block number avoids automatic moving-tag resolution.
- Native balance extraction is a deployless constructor call. Token reads go through library-owned STATICCALL helper bytecode. Token probes explicitly request 1,000,000 gas. The native constructor probes and appended zero-address call omit an explicit gas limit; provider defaults and the shared time/response limits therefore apply. Do not claim every internal call is capped at 2,000,000 or rewrite the pinned library's calls silently.
- Token pre-reads use the zero address as query caller. The original deposit retains the exact original sender, including its real code. Measurement caller changes are part of viem's implementation, not replacement of the deposit wallet.
- The only permitted state overrides are **code-only** installation of the exact pinned STATICCALL helper bytecode at the library-selected scratch address, beginning at `0x00000000000000000000000000000000deadbeef` and avoiding declared participants. Every occurrence must be retained in raw RPC parameters, extracted into an explicit override inventory and validated against that source constant. No balance, nonce, storage, stateDiff, move-precompile or wallet/token/messenger code override is permitted. No block override is permitted.
- A custom recording transport must set retry count zero, disable client multicall batching and CCIP reads, and allow only `eth_chainId`, `eth_getBlockByNumber`, `eth_call`, `eth_getBalance`, `eth_getCode`, and `eth_simulateV1`. All state/simulation requests after selection must use the same explicit block number. `eth_createAccessList` is not used by this release's workflow.
- A library error, measurement omission, RPC rejection, unsupported helper, resource failure or sender incompatibility stays visible. The pinned library also infers a zero pre-balance from a successful empty token response when a post-balance exists. Its returned rows are therefore explicitly library-derived observations; every result states `inventoryComplete: false`, and raw probe responses/errors remain authoritative. There is no retry of the target with reduced scope, a different sender, fabricated balances or a different provider.

## Required capture and review gate

Before dispatch: a one-shot declaration records the original scenario hash, exact plan/source/dependency/Node identities, endpoint, fixed prechecks, call parameters, allowed overrides and budgets. Its `STARTED` file must be exclusive and durable. The reviewed recording transport must save each exact sent JSON request and received response entity, HTTP status, bounded errors, byte counts, timestamps, request order and any skipped/denied requests. Failed/incomplete response prefixes are labeled explicitly. Raw RPC evidence is authoritative; viem's decoded output and errors are retained alongside it, with bigint values losslessly represented.

After dispatch: save the fresh prechecks, raw and decoded viem output, scratch-code override inventory, final header observation, timing/budget verdict, unchanged-source verdict and evidence manifest. No automatic fresh attempt. An artifact-only verifier should bind these joins and the original input, without calling the network or inferring destination success.

**Root review is required before the deposit target is executed.** This document and the installed-source review are the first preparation checkpoint. The recording transport, runner and artifact-only verifier are implemented. Twelve offline control groups pass, including actual pinned-library success/revert/error decoding, deadline/reserve/cancellation handling, source and artifact integrity, disposable full dependency freeze, relocation, raw-byte tampering and resealed semantic tampering. These use synthetic responses only and are not deposit evidence. Independent review and the root task's explicit single-run authorization remain required. No production code or dependency was changed.

## Primary references

- [Arbitrum endpoint documentation](https://docs.arbitrum.io/chain-info)
- [Viem homepage](https://viem.sh/)
- [Exact npm release metadata](https://registry.npmjs.org/viem/2.57.13)
- [Viem simulateCalls documentation](https://viem.sh/docs/actions/public/simulateCalls)
- [Official simulateCalls source repository](https://github.com/wevm/viem/blob/main/src/actions/public/simulateCalls.ts) (moving source reference only; this experiment binds the exact installed release bytes listed in `preparation/source-inspection.json`)
- [Circle evm-cctp source pin](https://github.com/circlefin/evm-cctp/tree/a92a2b4e7e6ef99bf0b05dca71780f5ec190e729)

Neither a successful burn simulation nor an asset-debit row establishes Circle attestation, relay completion, destination mint, actual fee charged, or HyperCore perps/spot credit. Those remain separate protocol states.

## Review and execution commands

Offline controls: `node --test research/arbitrum-viem-deposit-v1/run.test.mjs`. These perform no network or EVM execution. After review, `node research/arbitrum-viem-deposit-v1/prepare.mjs` writes the exclusive source/dependency inventory and plan. A single authorized dispatch uses `node research/arbitrum-viem-deposit-v1/run.mjs run EXACT_PLAN_SHA256`. A second capture cannot replace the first directory. Verify saved artifacts using `node research/arbitrum-viem-deposit-v1/verify.mjs EXPERIMENT_DIRECTORY EXACT_MANIFEST_SHA256 EXACT_PLAN_SHA256`. The verifier replays only the pinned viem decoder against saved responses and performs no new provider or EVM execution. Aborted/denied/undrained transport packets retain integrity results but cannot claim complete decoder replay or usable interpretation.
