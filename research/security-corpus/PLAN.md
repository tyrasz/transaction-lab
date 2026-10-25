# Security corpus intake and evaluation plan

There are **three researched candidates, one admitted development effects reference, zero admitted security scoring cases, and zero blind holdouts**. All three have public Ethereum transaction/receipt research. The LI.FI reference additionally has original-position execution and USDT state evidence, reviewed separately for chain facts and incident attribution. Admission does not establish chain-1 engine support, detector accuracy or a comparison with Blockaid.

The [candidate manifest](candidate-manifest.json) separates chain observations, attributed labels, uncertainty, lifecycle stage, and admission gates. The [source index](sources/source-index.json) records publication dates, retrieval times, scope, and source limitations. Raw public RPC evidence is saved alongside it and content-hashed in the manifest.

## Candidate scope

| Candidate | Exact historical transaction | Useful future task | Important exclusion |
| --- | --- | --- | --- |
| LI.FI, 16 July 2024 | [0xd82f…3873](https://etherscan.io/tx/0xd82fe84e63b1aa52e1ce540582ee0895ba4a71ec5e7a632a3faa1aff3e763873) | Reproduce an attacker-submitted call and explain effects on another token owner. | It is not the victim's earlier approval prompt. |
| Socket, 16 January 2024 | [0xc6c3…8fd6](https://etherscan.io/tx/0xc6c3331fa8c2d30e1ef208424c08c039a89e510df2fb6ae31e5aa40722e28fd6) | Handle constructor execution and multi-victim effects. | Do not replace creation initcode with a synthetic gateway call and call that an exact replay. |
| USDC permit case, 16 March 2026 | [0xfd74…a642](https://etherscan.io/tx/0xfd7417af8433e3d9bcbed3f965307c800a24eb4e98f42cebfab6ca6064f5a642) | Explain an authorization event followed by transfers; confirm the permit mechanism with a trace. | No original typed-data signing prompt is available. Phishing attribution remains under review. |

The LI.FI selection is explicitly linked by [BlockSec's original research](https://blocksec.com/blog/illicit-fund-flow-case-study-lifi-attack-metasleuth), with incident context from [LI.FI's postmortem](https://li.fi/knowledge-hub/incident-report-16th-july). Socket attribution combines [CertiK's analysis](https://www.certik.com/blog/3QR5sltpG4lmpau6S6mWcm-socket-tech-incident-analysis) with the independently captured actor, gateway log emitter, and affected-owner count. The permit candidate comes from [DARKNAVY's analysis](https://www.darknavy.org/web3/exploits/usdc-permit-phishing-drain/); the manifest explicitly quarantines its unverified social-engineering claims and inconsistent page categorization.

## LI.FI development admission — October 25, 2026

The [admission record](reviews/lifi-2024-07-16-admission.json) admits only the original execution and observed USDT effects as a development reference. An [independent chain review](reviews/lifi-2024-07-16-independent-chain-review.txt) checks raw execution, original-position reads, storage and code identities; a [separate attribution review](reviews/lifi-2024-07-16-independent-label-review.json) checks primary reports. These are separate internal AI-assisted reviews, not external human review or independent organizations.

The affected owner loses 2,276,295.880553 USDT while the submitting wallet gains the same amount. The owner's maximum allowance remains numerically unchanged. No new owner approval is inferred. The complete wrapper transaction includes temporary CREATE/SELFDESTRUCT paths and an unverified token-like contract; these must remain visible in any reproduction.

One archive provider supplied successful execution evidence. Native-fee wrappers differ across query responses, so native balances and fee fidelity are excluded from admission. There are no state proofs, source recompilation, original victim signing prompt, matched legitimate controls, detector scores or blind results. The entire incident family is assigned to development. The other two candidates remain unadmitted.

## Keep the prediction task explicit

Do not score a later attacker drain as a successful prediction at a victim's earlier signing screen. Use separate tracks:

1. **Execution fidelity:** Can the engine reproduce the original success/revert, calls, and relevant state changes at the correct historical prestate?
2. **Effects and permissions:** Can it identify every affected owner, exact amounts, requested permissions, emitted evidence, and measured final state? The transaction sender can profit while a different owner loses assets.
3. **Transaction harm classification:** Given only information available before the submitted transaction, can it identify supported harmful behavior with calibrated uncertainty?
4. **Wallet transaction protection:** Requires the actual transaction the victim was asked to sign, plus authenticated intent/context evidence where the label depends on deception.
5. **Typed-data protection:** Requires the original signing request, including domain, types, message, chain, and timestamp. A reconstructed permit is a separate test category, not a recovered wallet prompt.

The current engine supports chain 999 and contract calls. These chain-1 candidates are therefore unsupported today. Socket additionally requires creation-transaction support. Record that coverage gap; do not count abstention as correct detection.

## Admission and evidence preservation

Each candidate needs two independent reviewers. One verifies on-chain identity and execution; the other reviews incident attribution and the proposed label. Disagreements remain explicit. The label vocabulary must distinguish an attacker drain, an earlier approval of unknown intent, a configuration change, a defensive revocation, and later fund movement. A maximum approval alone is an exposure observation, not a maliciousness label.

Before admission, retain content-addressed transaction/receipt/block data, full trace, relevant bytecode and proxy implementation identity, and balance/allowance evidence. Reproduce the prestate at the original transaction position. For transactions later in a block, block N−1 alone does not include preceding transactions in block N. A current-state call is not a historical replay.

Verify effects independently of Transfer/Approval logs. Preserve zero-value events and reverted subtrees in raw evidence while interpreting them correctly. Confirm signature domain, nonce, owner, and redemption semantics where permit behavior is claimed. Avoid carrying unnecessary signatures into presentation artifacts; raw evidence remains clearly marked public historical data.

The read-only [capture utility](capture-evidence.mjs) uses only chain ID, transaction, receipt, and block RPC methods. Re-running it refreshes files and timestamps; update artifact hashes and issue a new manifest version rather than silently treating changed files as the same corpus. It never submits or executes transaction calldata. No phishing website or malicious package is needed.

## Prevent leakage and measure false positives

These candidates have already been inspected during development research, so they are not sealed. LI.FI is explicitly assigned to development following its narrow effects admission. If any detector is tuned using them, place their entire incident family—including related approvals, drains, addresses, clones, and aftermath—in the development split. An independent custodian must curate and seal fresh incident groups for blind evaluation. Keep labels and post-incident reports outside the feature input path.

For a historical pre-sign evaluation, source publication time is a strict cutoff: today's explorer labels or a later postmortem cannot become knowledge the detector supposedly had before the incident. Preserve a dated intelligence snapshot when reputation is part of the test.

Add independently reviewed legitimate controls matched by token, spender type, chain, time, and operation: maximum router approvals, bounded approvals, revocations, legitimate permits, relayer submissions, batched actions, and proxy upgrades. Confirm authorization/context instead of assuming an unlabeled transaction is benign. Include confusing but non-malicious behavior such as receipt-token interest and zero transfers. Do not label canonical Permit2 itself malicious merely because attackers have used it.

Report coverage/abstention, exact effect accuracy, permission interpretation errors, false positives on legitimate controls, and incident-level detection separately. Freeze rules and thresholds before the blind run. Publish denominators and uncertainty; group correlated transactions by incident so one large drain does not inflate sample size. Latency and provider failures are separate operational measurements. No overall superiority claim is supported by this intake set.
