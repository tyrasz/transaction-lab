# Transaction Lab

An owned, read-only EVM transaction preview service. The initial implementation targets HyperEVM (chain 999), Hyperlend USDC deposits, and transparent handling of unsupported HyperCore execution.

The long-term objective is to outperform commercial simulation/security providers on measured correctness, coverage, latency, and explanations. No general superiority is claimed. The first milestone is an independently verifiable preview with public evidence and reproducible tests.

## Run

Requires Node.js 22 or later. There are no runtime dependencies.

```sh
npm test
npm run benchmark
npm start
```

Open http://127.0.0.1:5174/. The existing Dynamic comparison demo remains separate on port 5173.

With the server running, `npm run check:live` runs six read-only checks against public chain data and saves every API request and response in `reports/live/`. Wallet state and public-provider availability can change; a failed live check is retained for inspection. `npm run compare:providers` compares two cases at one pinned block across the two documented public providers, preserving disagreements and evidence.

The default public RPC is `https://hyperliquid.drpc.org`. For dedicated infrastructure, set `HYPEREVM_RPC_URL` to an RPC with `debug_traceCall`, `debug_traceTransaction`, archive data, and callTracer log support. Provider credentials stay on the server and are not included in evidence. The service checks chain ID before each operation. Public endpoints can change limits or capabilities.

Measured balances additionally require `prestateTracer` diff mode, `eth_call` state overrides, and block-hash queries. If those are unavailable, the response retains the execution trace and explicitly marks balance measurement unavailable.

```sh
HYPEREVM_RPC_URL=https://your-provider.example npm start
```

## Scope and interpretation

- A simulation does not sign or broadcast a transaction.
- Current simulations select a block and request tracing by its hash. A provider that rejects this is reported as unavailable; there is no silent fallback to latest.
- Historical traces use the original transaction hash and are separate from current-state simulations.
- Asset arrays describe successful ERC-20 Transfer events involving the simulated sender. They are not a claim about exact portfolio balance changes.
- `balanceChanges` separately measures USDC and hUSDC `balanceOf` before and after a successful, reconciled Hyperlend supply. It applies the complete supported state diff to ephemeral reads at the same block hash and timestamp. It includes the sender and beneficiary, with no extrapolation to other assets, fees or future blocks.
- Hyperlend receipt-token mint events may include previously accrued interest. Principal and interest are reported separately when decoded.
- Deposit rounding is checked against the verified hUSDC implementation and its traced scaled-mint inputs. The response preserves requested principal, transferred principal, mint-implied principal and the exact difference.
- Security is `not_assessed`. EVM success must never become a `Benign` verdict.
- `permissions` separately records approval requests and Approval events for configured USDC/hUSDC contracts. It identifies maximum allowances, revocations, false returns and calldata/event mismatches. Findings describe specific permission evidence; they do not verify final allowance state or classify spender reputation.
- Unknown protocols and external HyperCore processing have explicit coverage limitations.
- Historical replay returns original execution and event evidence. It does not yet measure balances at the original transaction's position inside its block.
- Pricing, malicious-contract detection, signature validation, general NFT support, and general-purpose balance measurement are not implemented.

The two public providers were also tested with stateful `eth_simulateV1`. That method is retained as capability evidence; the application uses the prestate-diff route so its primary trace and balance measurements share the original block context. See [capability evidence](reports/capabilities/STATEFUL-BALANCES.md).

## API

`POST /api/simulate` accepts `{chainId,from,to,data,value,block?}`. `value` is a decimal wei string. `block` is `latest` or a hexadecimal block number.

`POST /api/replay` accepts `{chainId,transactionHash}` for a confirmed historical transaction.

`GET /api/config` lists examples and capabilities. `GET /api/benchmarks` returns the latest deterministic benchmark. `GET /api/health` checks service availability.

The local HTTP service only exposes read-only operations. Its RPC wrapper also enforces a read-only method allowlist. It binds to loopback, caps request/trace sizes, limits concurrent simulations, and rejects cross-origin POST requests. Public deployment requires authentication, rate limits, operational hardening, and a separate deployment review.

Reports are saved in `reports/simulations/` with a maximum of 40 retained responses. Downloads preserve the complete request and evidence. Benchmark reports and fixtures distinguish observed chain data from synthetic negative cases.

Each API result includes an implementation version and a SHA-256 fingerprint of the server's loaded source files. Runtime reports are kept locally outside version control; public capability probes and regression fixtures are retained with the source.
