# Development objective

Build a transaction-preview and security system that can demonstrate stronger results than existing hosted services on defined, independently measured tasks. “Surpasses Blockaid” is a research and engineering objective, not a claim made by this initial implementation. There is no finite completion date or global score without agreed scope, reference access and evidence.

## Current foundation

The current implementation covers HyperEVM Hyperlend USDC supply, withdrawal, variable-rate borrowing and repayment, with separate debt accounting and final USDC/hUSDC allowance measurements. It preserves raw evidence and uses shared pinned-state reconstruction for current balance reads. Historical balances are measured at the original transaction position, with independent execution and query validation. Fourteen offline regression cases (ten observed, four synthetic), twelve live API checks, seven same-block comparisons and four historical two-provider comparisons form the development checks. See STATUS.md for the latest completed results; these are not general accuracy or security scores.

Historical transaction-position state uses a validated state-context method after probes demonstrated that another provider parameter was silently ignored. The next coverage targets are additional permissions and affected accounts. The three researched security incident candidates remain unadmitted and unscored; no blind holdout or detector performance claim exists. See STATUS.md for evidence and research/security-corpus/PLAN.md for admission criteria.

## Execution correctness

1. Bind simulations to a recorded block hash and number, and detect a reorganization or provider state mismatch.
2. Extend the implemented pre/post balance strategy to more assets and affected accounts, and validate historical allowance measurements. Keep transfer events, principal and accrued interest distinct from balance deltas.
3. Test allowances, transfer taxes, rebases, delegated accounts, proxies, reverted subcalls, unusual logs and failed execution.
4. Cross-check a held-out transaction corpus against independent execution engines and receipts. Preserve disagreements as failures with raw evidence.

Exit evidence: exact supported-asset amounts against independent state observations, explicit unknowns, no hidden exclusion of failing cases, and a published denominator by transaction family.

## Coverage and reproducibility

Add protocol adapters only with observed successful and failing examples: additional lending assets, swaps, permits, bridges and smart-account execution. Expand chains after chain-specific replay and state assumptions are documented. CoreWriter requires a separate HyperCore model; decoding an EVM action alone cannot establish its eventual HyperCore result.

Record input, block, engine/provider version when available, metadata provenance, output and limits for each result. Maintain separate training/development and held-out corpora. Refresh stale protocol assumptions and keep old cases as regression evidence.

Exit evidence: per-chain and per-protocol coverage counts, unsupported rates, independently reproducible cases and regression history.

## Performance and operating reliability

Measure live end-to-end p50/p95/p99 latency, provider errors, timeout rates, throughput and cost per request. Include cold starts and unavailable providers. Compare identical request cohorts and input blocks where services permit that. Add caching, backpressure, cancellation and provider failover only after correctness under those conditions is tested.

Exit evidence: repeatable load reports, operational error budgets and traceable cost measurements. Offline decoder tests do not provide live service latency evidence.

## Security research

Start with narrow, explainable findings whose evidence can be independently inspected: dangerous approval scope, known malicious addresses with source timestamps, suspicious authorization changes and transaction/account mismatch. Keep observed facts separate from policy judgments. Introduce a risk verdict only after the underlying rules and uncertainty are documented.

Evaluate against independently labeled malicious and benign transactions. Measure false positives, false negatives, precision and recall by attack family; track data freshness and adversarial evasion. Obtain lawful threat-intelligence sources and evaluate poisoning and label quality. Keep untested families explicitly unassessed.

Exit evidence: a versioned labeled corpus with provenance, held-out results and confidence bounds; reproducible findings; reviewable evidence for each verdict. Strong simulation accuracy does not imply strong threat detection.

## Vendor comparison

Use comparable transaction inputs, account context and state. Record the exact API/service configuration, time and returned block if available. If a service cannot bind a block, label state-sensitive differences inconclusive. Measure correctness, explanation quality, supported coverage, latency, reliability and security detection separately.

Only claim an advantage for the measured task and cohort. A global superiority claim requires evidence across all material dimensions, access to a representative current reference service and independent review. The saved Dynamic example is a useful observation, not that evaluation.

## Ongoing work boundaries

Development can continue through concrete milestones and reviewable changes. Live external services, large historical datasets, production hosting and threat-intelligence feeds may require accounts or budget. No wallet signing, broadcasting or asset movement is part of this project. Paid commitments and public publication require an explicit instruction when they become necessary.
