# Transaction Lab

An owned, read-only EVM transaction preview service. The initial implementation targets HyperEVM (chain 999), Hyperlend USDC supply, withdrawal, variable-rate borrowing and repayment, and transparent handling of unsupported HyperCore execution.

The long-term objective is to outperform commercial simulation/security providers on measured correctness, coverage, latency, and explanations. No general superiority is claimed. The first milestone is an independently verifiable preview with public evidence and reproducible tests.

## Run

Requires Node.js 22 or later. The primary service has no runtime dependencies. The optional experimental local executor has its own pinned dependencies under `engines/local-evm`.

```sh
npm test
npm run benchmark
npm start
```

Open http://127.0.0.1:5174/. The existing Dynamic comparison demo remains separate on port 5173.

The [experimental local executor](engines/local-evm/README.md) runs real bytecode with EthereumJS against explicit sparse recorded inputs. It is separate from the API and preview: those continue to use provider execution. Install its locked dependencies with `npm ci --prefix engines/local-evm --ignore-scripts`, then run `npm run test:local`. Missing state and unsupported HyperCore calls stop local execution rather than supplying guessed values.

With the server running, `npm run check:live` runs twelve read-only checks against public chain data and saves every API request and response in `reports/live/`. Wallet state and public-provider availability can change; a failed live check is retained for inspection. `npm run compare:providers` compares seven cases at one pinned block across the two documented public providers, preserving disagreements and evidence. `npm run check:historical` compares four fixed historical operations across those providers, retaining all eight calls and their underlying RPC evidence in `reports/historical-comparisons/` without retries. `npm run check:permissions` checks three observed approval/permit transactions across the same two providers, retaining all six attempts in `reports/permission-comparisons/`.

The default public RPC is `https://hyperliquid.drpc.org`. For dedicated infrastructure, set `HYPEREVM_RPC_URL` to an RPC with `debug_traceCall`, `debug_traceTransaction`, archive data, and callTracer log support. Provider credentials stay on the server and are not included in evidence. The service checks chain ID before each operation. Public endpoints can change limits or capabilities.

`npm run check:coverage` executes the [preregistered prospective pilot](research/coverage-evaluation/PLAN.md): it freezes the local source, waits for two future finalized HyperEVM blocks, keeps every transaction in the denominator, and attempts at most sixteen. It takes at least three minutes when selection succeeds and makes bounded read-only requests to both fixed public providers. Each run saves immutable product outputs before comparator adjudication under `reports/coverage-evaluation/`. This is a feasibility pilot; provider agreement and observed-pair matches are separate from complete transaction replay and all-effects accuracy.

`npm run check:coverage:v2` is the separate [ordinary/system enumeration protocol](research/coverage-evaluation/PLAN-V2.md). It preserves every unresolved occurrence, keeps unsupported system replay explicit, and withholds a combined denominator when identity or enumeration is incomplete. It adds the fixed official enumeration endpoint to the same bounded budget. Review and freeze its source before a live run. The v1 pilot remains unchanged; offline v2 tests are not a new live accuracy result.

Measured current-state balances require `debug_traceCall` with callTracer, prestateTracer diff mode, state overrides and canonical EIP-1898 block-hash queries, plus hash-bound nonce, native balance and code reads. Each configured token query uses four isolated calls: its trace and mutation diff before and after the complete original-call overrides. The profile deliberately omits gas price and verifies synthetic BASEFEE zero; it does not estimate network fees. Historical measurements require archive `debug_traceCallMany` with block-hash and transaction-index state context. If capabilities or validation checks fail, the response retains available execution evidence and marks measurements unavailable.

Current measurements accept at most twelve distinct queries and 64 context RPCs, with three slots reserved for canonical checks, 8 MiB per response and 32 MiB retained evidence. The context stops scheduling requests after 120 seconds and rejects late responses. With the standard RPC transport's 25-second timeout, pending calls can extend that window to at most 145 seconds; custom transports must enforce the same per-call bound.

```sh
HYPEREVM_RPC_URL=https://your-provider.example npm start
```

## Scope and interpretation

- A simulation does not sign or broadcast a transaction.
- Current simulations select a block and use the same canonical EIP-1898 hash and unpriced envelope for the original execution trace and state diff. The supported measurement profile checks zero BASEFEE and the remaining header fields, requires a code-free sender and zero native value, and rejects contract creation/destruction. A provider that rejects the requested context is reported as unavailable; there is no silent fallback to latest.
- Historical traces use the original transaction hash and are separate from current-state simulations.
- Asset arrays describe successful ERC-20 Transfer events involving the simulated sender. They are not a claim about exact portfolio balance changes.
- `accountEffects` lists all bounded observed transfer participants and configured permission roles, including owners other than the submitter. For each account/token it shows event totals separately from measured balances; unknown tokens retain raw units and debt remains a liability. Missing measurements are explicit. This view does not discover silent changes or every affected account.
- `affectedBalanceChanges` adds before/after reads for observed configured USDC, hUSDC and variable-debt participants, including accounts other than the sender. Historical and validated current contexts are supported. At most eight candidate pairs are accepted, including pairs already measured by the lending adapter. Reuse is verified through the same context cache; event totals never substitute for balances. Current reads validate the configured token/Pool paths and nonce-only query effects on both sides, including after proxy/dependency storage changes. This is address/path validation, not runtime-bytecode attestation. Unknown tokens and native effects remain outside scope; the legacy untraced current reader cannot enable these measurements.
- `balanceChanges` measures exact balances before and after a successful, reconciled Hyperlend operation. Supply covers sender/beneficiary USDC and hUSDC; withdrawal, borrowing and repayment additionally cover variable USDC debt and reserve custody. Current-state reads use the same block hash and timestamp, with the supported complete state diff applied only to ephemeral reads. Historical reads use the original block and transaction position. Reserve cash is labeled separately from user wealth.
- Shared balance, affected-account and allowance measurements are finalized together. If any consumer's canonical-block check fails, none is returned as measured; a later successful check cannot erase the failure. Raw shared evidence is retained after all consumers settle. An ordinary token-query failure remains local to that measurement.
- Hyperlend receipt-token mint events may include previously accrued interest. Principal and interest are reported separately when decoded.
- Deposit rounding is checked against the verified hUSDC implementation and its traced scaled-mint inputs. The response preserves requested principal, transferred principal, mint-implied principal and the exact difference.
- Security is `not_assessed`. EVM success must never become a `Benign` verdict.
- `permissions` separately records approval and permit requests, Approval events, and `transferFrom` calls for configured USDC/hUSDC contracts. Standard ERC-2612 permit and ERC-20 transferFrom decoding requires configured proxy implementation evidence. Owner, transaction submitter, immediate token caller/spender and recipient are distinct. A permit redemption deadline is not allowance expiry; a transfer amount is not a requested allowance. It identifies maximum allowances, revocations, false returns and calldata/event mismatches. Findings describe specific permission evidence. `allowanceChanges` separately queries final allowance before/after the whole current simulation or original historical transaction for observed verified pairs, including transfer-only pairs and unchanged allowances. It compares final state to ordered events without treating a mismatch as a maliciousness verdict. An unchanged allowance does not mean no spending occurred. Spender reputation and signing intent are not assessed.
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

The [lending evidence index](reports/lending-discovery/INDEX.md) links verified transactions, deployed source and raw responses. The [affected-account discovery index](reports/affected-account-discovery/INDEX.md) documents public examples where token owners, spenders and submitters differ, with raw evidence and retained provider inconsistencies. These examples do not establish user consent or maliciousness. The [security corpus intake](research/security-corpus/PLAN.md) contains three researched candidates, one admitted development effects reference, zero security scoring cases and zero blind holdouts; it is not a security detection score.
