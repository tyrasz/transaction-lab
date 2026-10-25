# Transaction Lab

An owned, read-only EVM transaction preview service. The initial implementation targets HyperEVM (chain 999), Hyperlend USDC supply, withdrawal, variable-rate borrowing and repayment, and transparent handling of unsupported HyperCore execution.

The long-term objective is to outperform commercial simulation/security providers on measured correctness, coverage, latency, and explanations. No general superiority is claimed. The first milestone is an independently verifiable preview with public evidence and reproducible tests.

## Run

Requires Node.js 22 or later. There are no runtime dependencies.

```sh
npm test
npm run benchmark
npm start
```

Open http://127.0.0.1:5174/. The existing Dynamic comparison demo remains separate on port 5173.

With the server running, `npm run check:live` runs twelve read-only checks against public chain data and saves every API request and response in `reports/live/`. Wallet state and public-provider availability can change; a failed live check is retained for inspection. `npm run compare:providers` compares seven cases at one pinned block across the two documented public providers, preserving disagreements and evidence. `npm run check:historical` compares four fixed historical operations across those providers, retaining all eight calls and their underlying RPC evidence in `reports/historical-comparisons/` without retries. `npm run check:permissions` checks three observed approval/permit transactions across the same two providers, retaining all six attempts in `reports/permission-comparisons/`.

The default public RPC is `https://hyperliquid.drpc.org`. For dedicated infrastructure, set `HYPEREVM_RPC_URL` to an RPC with `debug_traceCall`, `debug_traceTransaction`, archive data, and callTracer log support. Provider credentials stay on the server and are not included in evidence. The service checks chain ID before each operation. Public endpoints can change limits or capabilities.

Measured current-state balances additionally require `prestateTracer` diff mode, `eth_call` state overrides, and block-hash queries. Historical measurements require archive `debug_traceCallMany` with block-hash and transaction-index state context. If these capabilities or validation checks fail, the response retains the execution trace and explicitly marks balance measurement unavailable.

```sh
HYPEREVM_RPC_URL=https://your-provider.example npm start
```

## Scope and interpretation

- A simulation does not sign or broadcast a transaction.
- Current simulations select a block and request tracing by its hash. A provider that rejects this is reported as unavailable; there is no silent fallback to latest.
- Historical traces use the original transaction hash and are separate from current-state simulations.
- Asset arrays describe successful ERC-20 Transfer events involving the simulated sender. They are not a claim about exact portfolio balance changes.
- `balanceChanges` measures exact balances before and after a successful, reconciled Hyperlend operation. Supply covers sender/beneficiary USDC and hUSDC; withdrawal, borrowing and repayment additionally cover variable USDC debt and reserve custody. Current-state reads use the same block hash and timestamp, with the supported complete state diff applied only to ephemeral reads. Historical reads use the original block and transaction position. Reserve cash is labeled separately from user wealth.
- Hyperlend receipt-token mint events may include previously accrued interest. Principal and interest are reported separately when decoded.
- Deposit rounding is checked against the verified hUSDC implementation and its traced scaled-mint inputs. The response preserves requested principal, transferred principal, mint-implied principal and the exact difference.
- Security is `not_assessed`. EVM success must never become a `Benign` verdict.
- `permissions` separately records approval and permit requests and Approval events for configured USDC/hUSDC contracts. It also decodes the standard ERC-2612 permit method only when the trace uses a configured token implementation. Permit owner, transaction submitter and immediate caller are distinct; the redemption deadline is not allowance expiry. It identifies maximum allowances, revocations, false returns and calldata/event mismatches. Findings describe specific permission evidence. `allowanceChanges` separately queries final allowance before/after the whole current simulation or original historical transaction for observed verified pairs, including unchanged allowances. It compares final state to ordered events without treating a mismatch as a maliciousness verdict. Spender reputation is not assessed.
- Variable-debt token mints are liabilities and are excluded from spendable incoming assets. `positionChanges` separates cash, position events and accrued interest. Repayments use the actual executed amount, which may be capped by outstanding debt.
- Unknown protocols and external HyperCore processing have explicit coverage limitations.
- Historical replay measures the configured token balances immediately before and after the original transaction. The original execution is independently replayed and compared with its recorded call trace and receipt events. Each balance query runs separately, with original block-header, sender-nonce and fee checks. Historical USDC/hUSDC allowances use the same validated original-position context, with separately verified allowance query behavior. Generic contract roots require original runtime-code evidence and an exact semantic replay; creation/destruction anywhere in the full trace, including reverted or temporary lifecycle operations, and unsupported account/code changes make measurements unavailable. Only supported legacy, access-list and fee-market transaction envelopes are accepted for measurement; blob and authorization-list semantics are outside scope.
- Pricing, malicious-contract detection, independent signature/domain/nonce validation, general NFT support, and general-purpose balance measurement are not implemented. The alternate bytes-signature USDC permit overload, Permit2, DAI-style permits and credit delegation are outside the current permit decoder.

The two public providers were also tested with stateful `eth_simulateV1`. That method is retained as capability evidence; the application uses the prestate-diff route so its primary trace and balance measurements share the original block context. See [capability evidence](reports/capabilities/STATEFUL-BALANCES.md).

Historical reads use a different route because block-end state is insufficient for a transaction in the middle of a block. The providers silently ignored `debug_traceCall`'s tested `txIndex` option, so the adapter uses validated `debug_traceCallMany` state context. It never inserts balance probes into the original transaction's execution sequence. See [historical state evidence](reports/historical-state/README.md).

## API

`POST /api/simulate` accepts `{chainId,from,to,data,value,block?}`. `value` is a decimal wei string. `block` is `latest` or a hexadecimal block number.

`POST /api/replay` accepts `{chainId,transactionHash}` for a confirmed historical transaction.

`GET /api/config` lists examples and capabilities. `GET /api/benchmarks` returns the latest deterministic benchmark. `GET /api/health` checks service availability.

The local HTTP service only exposes read-only operations. Its RPC wrapper also enforces a read-only method allowlist. It binds to loopback, caps request/trace sizes, limits concurrent simulations, and rejects cross-origin POST requests. Public deployment requires authentication, rate limits, operational hardening, and a separate deployment review.

Reports are saved in `reports/simulations/` with a maximum of 40 retained responses. Downloads preserve the complete request and evidence. Benchmark reports and fixtures distinguish observed chain data from synthetic negative cases.

Each API result includes an implementation version and a SHA-256 fingerprint of the server's loaded source files. Runtime reports are kept locally outside version control; public capability probes and regression fixtures are retained with the source.

The [lending evidence index](reports/lending-discovery/INDEX.md) links verified transactions, deployed source and raw responses. The [security corpus intake](research/security-corpus/PLAN.md) contains three researched candidates, one admitted development effects reference, zero security scoring cases and zero blind holdouts; it is not a security detection score.
