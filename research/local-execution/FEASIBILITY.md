# Local EVM execution feasibility

Read-only investigation, 26 October 2026. No engine was installed, no blockchain RPC was called, and no product source was changed. This is a bounded implementation assessment, not a benchmark or release decision.

**A locally executed, RPC-backed standard-EVM prototype is practical, but no EVM engine is currently installed in the checked environment.** The shortest path for this Node project is an isolated EthereumJS execution worker with a bounded state adapter. Generic HyperEVM support requires additional chain behavior; simply pointing a stock fork at chain 999 is insufficient.

## What is available locally

| Item | Observed version/path |
| --- | --- |
| Node.js | `v22.23.2`, `/opt/homebrew/bin/node` |
| npm | `10.9.8`, `/opt/homebrew/bin/npm`; package under `/opt/homebrew/lib/node_modules/npm/` |
| anvil, forge, cast, geth, reth, evm | Not found on PATH or in the checked Homebrew binary directory |
| Rust / Cargo | `rustc` and `cargo` unavailable; `/Users/home/.cargo/bin` absent |
| Foundry home | `/Users/home/.foundry/bin` absent |
| Local Node EVM packages | No `@ethereumjs`, `@foundry-rs`, `@nomicfoundation`, Hardhat or Ganache package manifests found in the workspace `work/` and `outputs/` trees, including ignored dependency directories |
| Existing crypto helper | `@noble/hashes` 2.4.0 under `work/dynamic-cctp-app/node_modules/`; this is hashing, not an execution engine |

The `pnpm` command is a Corepack shim at `/opt/homebrew/bin/pnpm`. Asking it for a version attempted an npm-registry lookup, which failed at DNS resolution; no package was installed and no usable pnpm version was established. No registry command was retried. Inventory was scoped to these locations, not every file on the machine.

Transaction Lab's package manifest has no runtime dependencies. Its current foundation is provider execution plus local interpretation and validation, with configured Hyperlend/USDC coverage. A future local worker should declare and pin its own dependencies, not silently import the Dynamic demo's packages.

## Recommended first implementation

Use `@ethereumjs/evm` with `runCall` for an explicitly unsigned message profile, a configured chain/hardfork, a supplied block environment and an overlay state manager. Capture message/step events into a bounded call tree and journal original/final account and storage values, respecting nested reverts. Higher-level transaction fee/intrinsic-gas validation is a separate `@ethereumjs/vm` concern; `runCall` alone must not be presented as signed-transaction validation. EthereumJS exposes custom precompiles and these execution hooks. [Primary EVM documentation](https://github.com/ethereumjs/ethereumjs-monorepo/blob/master/packages/evm/README.md).

The upstream `RPCStateManager` is useful reference code, but not a drop-in state-provenance solution: its inspected implementation accepts a numeric/earliest tag, calls `eth_getProof` for account data, and uses `eth_getCode`/`eth_getStorageAt` for other reads. The local adapter should require one validated hash binding, retain every RPC request/response, cap calls/bytes/time, cache immutable base reads and isolate mutable overlays per simulation. Do not infer an absent account or zero slot from a failed RPC. [RPC state-manager source](https://github.com/ethereumjs/ethereumjs-monorepo/blob/master/packages/statemanager/src/rpcStateManager.ts).

A useful first acceptance target is an offline fixture containing complete touched-state/code inputs for a small standard-EVM call, followed by a separately authorized pinned-state supply/direct-transfer comparison. Saved traces and changed-state diffs alone may omit untouched storage subsequently read by a local engine. Missing inputs must remain unavailable; reconstructing expected outputs from the provider trace would defeat the independent-execution check.

Alternatives are Anvil for a quick forked-node prototype, or a Rust worker using revm's `AlloyDB` plus `CacheDB` and inspectors for tighter control. Anvil provides pinned-block forking and tracing; revm exposes provider-backed account/storage reads and in-memory changes. Neither is installed here. These are future dependency choices, not validated HyperEVM adapters. [Anvil](https://www.getfoundry.sh/anvil/index.html), [revm database API](https://docs.rs/revm/latest/revm/database/index.html), [AlloyDB](https://docs.rs/revm/latest/revm/database/struct.AlloyDB.html).

## HyperEVM blockers that affect correctness

- **Rules and fees:** official documentation specifies Cancun without blobs, chain 999 and HYPE gas. Priority fees are burned through the zero address rather than paid as ordinary Ethereum validator revenue. Explicitly select the intended rules and implement/test the chain fee transition before comparing full native balances. Do not inherit a library's newer default hardfork. [HyperEVM specification overview](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm).
- **State availability:** the default official endpoint documents latest-only account/code/storage reads, no historical-state service, and no listed `eth_getProof`. Archive support and EIP-1898/proof behavior therefore need separate capability evidence. A local interpreter still trusts its supplied base state; it does not create cryptographic state proof or provider independence. [Official JSON-RPC documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc).
- **HyperCore precompiles are already in our corpus:** the router trace in `reports/replay-state-comparisons/capture.json` calls `0x0000000000000000000000000000000000000801` and `0x000000000000000000000000000000000000080f` on both providers. Stock EVM execution must not treat these as empty-code accounts. The official docs say archive read-precompile records cover calls actually made; hypothetical responses may require full L1 replay. Reject unsupported calls initially. Exact recorded-call stubs may support a clearly labeled offline development replay, not arbitrary simulation. [JSON-RPC limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc).
- **CoreWriter and positions:** CoreWriter queues actions for subsequent HyperCore processing. An EVM log does not establish the resulting trading/account state. Historical local replay also needs the correct system-action ordering and transaction boundary; our saved five-versus-eight transaction views and final Direct-B mismatch show why block hash alone is insufficient. [CoreWriter behavior](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore), local `reports/system-position-diagnostic/NOTES.md` and `reports/replay-state-comparisons/NOTES.md`.

## Independent current-query profile review

The saved capability packet supports a narrow **unpriced, synthetic-BASEFEE-zero** profile: 28 configured query paths and their paired nonce-only diffs, eight header witnesses and four end-versus-parent nonce anchors. It does not establish arbitrary proxy safety, runtime code hashes, general state-position proof or signed/native-fee accuracy. See `reports/current-query-capability/NOTES.md`.

Material integration conditions sent to the implementer:

1. Bind the server's original call trace and context diff to the identical normalized envelope and EIP-1898 wrapper. The 0.7.1 code used a bare hash for one and an object for the other; adding query validation alone cannot retrospectively prove equivalence.
2. Require BASEFEE zero explicitly and all seven remaining witness values to match. Label that environment truthfully; do not reuse historical `original_block` identity.
3. Apply strict `canonicalStateDiff` validation before constructing complete overrides. `buildStateOverrides` alone is not an unknown-field/case-collision provenance validator. Reject lifecycle/code changes even in reverted branches; never query only a convenient subset of the original overrides.
4. Bind query nonce starts to independently read base sender state and the original call's override state. Validate nonce increment and absence of native debit separately from token path checks. Do not import historical priced-query arithmetic or assume empty query diffs.
5. Keep four isolated traces per pair, shared cache identity, 12-pair/64-call budgets and reserved final canonical checks. A preparation/header/canonical failure invalidates shared measurements; an unrelated extra query failure must not erase already proven pairs.

This review concerns the proposed profile and frozen 0.7.1 evidence. The next implementation is being authored concurrently and requires its own final code/test review. The most defensible next local-execution milestone is standard EVM execution with explicit unsupported HyperCore handling, not an immediate claim to simulate most HyperEVM transactions accurately.
