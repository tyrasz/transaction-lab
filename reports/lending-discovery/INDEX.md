# Hyperlend lending evidence

Three successful USDC transactions from public account `0x9a1dbc6a6e7e59f6beb23db0d00b603fc90e94d0` were verified against original transactions, receipts, blocks and historical `callTracer` results with logs. The original calldata also succeeded in three independent current-state simulations at block **49,318,777**, hash `0x206b1f6b56dced1f90f742384ad84d74973a02d8bee8c07a823f394d1506a5a2`. No transaction was signed or broadcast.

| Operation | Real transaction | Selector | Historical USDC amount | Current simulated amount |
|---|---|---|---:|---:|
| Withdraw | [0x94b5…29ae7](https://hyperevmscan.io/tx/0x94b5c4672e28cbeeab547c06f60e30afa02ac58b0cad4c7568a6ca9d8ac29ae7) | `0x69328dec` | 503.900226 received | 503.900226 received |
| Repay | [0x682c…2102f](https://hyperevmscan.io/tx/0x682c1d2f131715b8d4b04c71cd8e75ef56a107f0bbd992379a44bf426f22102f) | `0x573ade81` | 199.626280 paid | **0.000002 paid**, capped at current debt |
| Borrow | [0x0b8a…59afb](https://hyperevmscan.io/tx/0x0b8ad0d98c96224bdd9e1ad6623292164278340b123feb45eee9c556ec259afb) | `0xa415bcad` | 835.474410 received | 835.474410 received |

`summary.json` contains complete hashes, historical block identities, exact requests, current prerequisites and evidence-file hashes. Each `*-evidence.json` preserves raw RPC requests/responses; `*-decoded.json` lists relevant receipt and trace event words. The initial metadata query with a mistyped data-provider address is retained beside its corrected successful result.

## Contract interpretation

The [official Pool interface](https://docs.hyperlend.finance/developer-documentation/core-pools/pool) defines `withdraw(asset,amount,to)`, `borrow(asset,amount,interestRateMode,referralCode,onBehalfOf)` and `repay(asset,amount,interestRateMode,onBehalfOf)`. Variable-rate mode is `2`. A withdrawal's `uint256.max` amount requests the full hToken position, subject to collateral constraints. A repayment's max sentinel requests the full debt and is allowed only for the caller's own debt. Explicit repayments may target another account, with the caller funding the effective payment. The protocol caps payment at current debt. Borrow has no “borrow max” sentinel; collateral, liquidity and caps constrain its explicit amount. Delegated borrowing uses debt-token credit delegation, not USDC allowance.

The [official addresses](https://docs.hyperlend.finance/developer-documentation/contract-addresses) and pinned RPC metadata agree: USDC `0xb883…630f`, hUSDC `0x744e…885b`, and six-decimal variable debt `0xd612…657d`, named `HyperLend HyperEVM Variable Debt USDC`, symbol `variableDebtHyperEvmUSDC`. The debt token represents a liability and its ordinary ERC20 transfer/allowance methods revert.

## Interest and rounding

Historical withdrawal burns an event amount of 503.885190 hUSDC with 0.015036 interest; historical borrow mints a debt event amount of 835.476148 including 0.001738 interest. Historical repay emits a debt burn of 199.626071 plus 0.000208 interest: its implied debt reduction is one raw unit below the 199.626280 cash payment. Keep cash, interest and position changes separate.

The [verified deployed Pool source](https://hyperevmscan.io/address/0xbebb62c7ff8b96db4325d9481c44e09a92d49b06#code) and [verified debt implementation](https://hyperevmscan.io/address/0x8158e5569475a443a5723ccac462930f590449ed#code) explain the rounding: hToken balances round down and withdrawal shares round up; debt balances and borrow shares round up, while repayment shares round down. A repayment can emit Mint instead of Burn when newly accrued interest exceeds the amount burned. Event labels alone do not establish a portfolio delta.

`sources/manifest.json` records extracted deployed source paths and hashes. Sources came from the explorers' verified standard JSON input without executing page scripts. The GitHub v3.6.0 reference differs from some deployed files; use the `deployed-*.sol` files. TokenMath, IPool and ScaledBalanceTokenBase match that reference exactly.

## Limits

These are three observed cases, not exhaustive coverage. The current simulations share a state block but are independent calls, not a sequence. The indexer ignored `limit=5`; only one query per operation was issued and no broad log scan was performed. The later `measured-current-balances.json` capture verifies before/after balances for all three operations at the same recorded block, using a prestate diff and hash-bound `eth_call` queries. Its complete public RPC evidence is replayed by the balance tests. All three measurements reconcile, including the current repayment capped at two raw USDC units. Debt is explicitly labeled as a liability, and reserve custody is separate from user positions.
