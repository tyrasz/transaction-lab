# Transaction Lab checkpoint — 0.5.0

Updated October 25, 2026. The long-term goal remains active. This checkpoint does not establish superiority to Blockaid.

The app runs locally at http://127.0.0.1:5174/ without a wallet connection or Dynamic authentication. It never signs or broadcasts transactions.

## Added in this checkpoint

- Standard ERC-2612 permit interpretation for configured USDC/hUSDC implementations. The token owner, external transaction submitter and immediate permit caller are distinct. The signature redemption deadline is evaluated at the recorded block time and is not presented as allowance expiry.
- Historical USDC/hUSDC allowances measured immediately before and after the original transaction, at its exact position in the original block. Final values are compared with intermediate requests and Approval events; spending later in the transaction can change the result.
- Generic contract roots can supply observed permission pairs only after runtime-code evidence, exact original-call replay and the existing header/nonce/fee/state checks pass. Unknown protocol effects remain partial. Contract creation/destruction is rejected anywhere in the full trace, including reverted branches and temporary contracts absent from the final diff. Unsupported account and code changes remain outside measurement scope.
- Two public historical permit examples in the browser, with exact final values and raw downloadable JSON. A zero final delta is described without claiming that no intermediate permission was granted or exercised.
- A bounded six-request comparison runner, recorded-response regressions and a detailed LI.FI development evidence packet with separate chain and attribution review.

The earlier Hyperlend supply, withdraw, variable borrow and repay accounting remains in place. Measured cash, receipt-token positions, non-transferable debt, reserve custody, accrued interest and event-derived transfers stay separate.

## Verification

- **228/228 regression tests passed.** This includes all six recorded permission API responses, strict original-position queries, owner/submitter distinctions, stale or malformed permission evidence, prior lending replays and provider-failure controls. `reports/latest-tests.txt`.
- **14/14 recorded decoder benchmark cases passed:** ten observed public traces and four synthetic controls. Development cases, not blind holdouts. `reports/latest-benchmark.json`.
- **5/6 historical permission requests measured; 2/3 two-provider comparisons matched, 0 mismatched, 1 incomplete.** All six HTTP requests returned original execution evidence. The incomplete case is a dRPC block transaction list that disagrees with the original receipt index; its allowance is unavailable, not zero. All 103 RPC requests are retained, without internal retries. The earlier pre-guard run is preserved separately; the final run follows the lifecycle-validation code change. [Full HTTP/RPC capture](reports/permission-comparisons/2026-10-25T15-36-55-519Z-http.json), [notes](reports/permission-comparisons/2026-10-25T15-36-55-519Z-notes.md), [manifest](reports/permission-comparisons/2026-10-25T15-36-55-519Z-manifest.json).
- **11/12 broader live API checks passed.** Current repayment at block 49,496,794 reverted with the contract-reported error `ERC20: transfer amount exceeds balance`; the prior public wallet state is not a fixed success fixture. Historical repayment still measured correctly. The failure is retained and was not rerun to obtain a pass. [All twelve requests and responses](reports/live/2026-10-25T15-28-20-264Z.json).
- A current-state permit control first returned HTTP 502 / RPC code -32001. One separately recorded diagnostic then returned a genuine EVM revert, selector `0xfb2a6752`, matching `InvalidExpiration()` in the captured hUSDC ABI. The app preserves it as an undecoded custom error; no signature acceptance is claimed. Both observations remain saved: [HTTP failure](reports/live/expired-husdc-permit-response-0.5.0.json), [diagnostic RPC requests and response](reports/live/expired-husdc-permit-diagnostic-0.5.0.json). This is distinct from the successful original historical permit.
- Browser inspection confirmed the relayed owner, immediate caller, original indexes, event-versus-final allowance differences and exact raw response. [Router response shown in the browser](reports/live/historical-router-permit-response-0.5.0-final.json).

Implementation source SHA-256: `36b03d772b9369ecde0fb195293dc8268fe16217de8157f4e8f82ee65bd546e2`. The final frozen comparison and final saved browser response match the current source files. The twelve-case live run and expiry control were captured before the lifecycle guard; they retain their own source identity.

The prior checkpoint's seven same-block provider agreements and seven measured historical lending requests remain retained as earlier observations. They were not rerun or counted as new results here.

## Concrete permission findings

The historical direct hUSDC permit changes the owner's allowance from **0 to maximum uint256**, while a different account submits the transaction.

In the historical USDC router call, the owner permits maximum uint256 and then spends **25 USDC**. Final owner-to-router allowance is **maximum minus 25,000,000 raw units**. The router separately approves **24.8125 USDC** to another spender, which consumes it; that pair starts and ends at **zero**. The Approval events alone therefore do not describe final state. Other router effects remain partially covered.

[Discovery and deployed-source provenance](reports/permission-discovery/INDEX.md) and [historical allowance validation](reports/historical-permissions/README.md) retain the original calls and evidence. Independent signature/domain/nonce verification, signing intent, alternate permit overloads, Permit2 and credit delegation remain outside current coverage.

## Security research and next work

The LI.FI packet has 71 offline evidence assertions over 28 RPC captures, including full original execution, code identities and exact original-position USDT effects. The affected owner loses **2,276,295.880553 USDT** while its maximum allowance remains numerically unchanged. One archive provider supplied the successful evidence; native-fee wrapper differences and temporary contract lifecycles are explicit limitations. The current chain-999 engine still does not support this chain-1 case. See the [review packet](research/security-corpus/reviews/lifi-2024-07-16-evidence-review.txt) and [corpus plan](research/security-corpus/PLAN.md).

LI.FI is admitted only as one development effects reference after separate internal chain and attribution reviews; the other two candidates remain unadmitted. The current engine still has zero admitted security scoring cases and zero blind holdouts. No security detection score, blind holdout result or comparative platform ranking is established. General security remains `not_assessed`.

Next work is affected-account coverage, independently checked permit authorization details, additional permission types, matched legitimate controls, and a narrow security evaluation with explicit abstentions. Chain expansion must preserve chain-specific replay and state validation. No paid infrastructure, external publication or fund movement has been performed.
