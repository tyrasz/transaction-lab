# Current development engine — prospective public comparison

October 30, 2026. **All 16 selected calls matched all five comparison channels**:
14 successful executions and two reverts, with zero measured mismatches,
unsupported cases, unavailable comparisons or unattempted slots. The selection
came from 346 transactions in two predeclared future Ethereum blocks. This is
100% observed comparator agreement in this small sample; it does not establish
100% EVM accuracy or a representative population rate.

The [checkpoint](checkpoint.json) lists every selected hash and outcome.
[Raw captured results](../../reports/ordinary-local-coverage-v2/results.json)
retain the complete accounting. Each numbered directory under
`reports/ordinary-local-coverage-v2/cases/` contains the exact projected request,
local response, local seal, oracle calls/responses and comparison. For example,
[case 016's raw local response](../../reports/ordinary-local-coverage-v2/cases/016/local.json)
and [case 001's matched revert](../../reports/ordinary-local-coverage-v2/cases/001/outcome.json)
are retained without rewriting.

## Method and result

The source, dependency trees, Node runtime, policy and random seed were frozen
before public selection. At 04:30:05 UTC, the collector declared future blocks
**26,303,188 and 26,303,189** from anchor 26,303,187. It waited the fixed 20-minute
interval, collected the two providers' block/ancestry evidence, and selected 16
transactions by the frozen seed/hash ranking. All selected slots were retained.

Each local engine prediction was durably sealed before its reference requests.
The reference was provider execution via trace and state diff. There were no
case retries, replacements, provider fallbacks or expected outputs fed to the
local engine. The five channels are execution status, exact return bytes,
committed ordered logs, charged gas, and full observed net state changes.
All **80 channel comparisons matched**.

The run finished at 04:52:08 UTC, after 22 minutes 3 seconds including the fixed
wait. It made 393 bounded public reads, retaining 5,943,469 observed wire bytes.
No timing, source, runtime, save or drainage failure occurred. Its evidence
manifest covers 588 files and 47,971,369 bytes, separately from the 1,792-entry
runtime/source snapshot. The source snapshot still matches the current
development checkout; its engine identity is
`cb3be33a6e4c8d020c7e03fb12c00b28a7b745abd259d8c5c05f38bc68854bab`.
The package label remains 0.34.0; the source hash identifies this unreleased
development candidate separately from the installed app.

The saved [offline verification](verification.json) passed. It verified all
256 state proofs, joined all 393 wire records, checked source/evidence identities,
recomputed all 16 outcomes and retained metrics. It performed no new EVM
execution or network requests. The evaluator's 189 preparation controls are
documented separately in the [preparation checkpoint](../ordinary-local-coverage-v2-preparation/NOTES.md).

A separate [artifact review](../ordinary-local-coverage-v2-review/NOTES.md)
also passed. Its independent secure-trie walk checked 256 account proofs and
191 storage proofs, plus 45 code joins, all local seals and exact reference
requests. It independently reproduced the 80 comparisons from saved outputs.
The review shares archived RLP/Keccak and header-encoding primitives; it ran no
new opcode execution. Local input reads and the remote execution reference both
use dRPC; PublicNode corroborates the census and header context only.

| Pin | SHA256 |
| --- | --- |
| Frozen plan | `147c2926c8d43c831d09b9cb8d36f54200e9a374bfde6a77399b21278b8be5cf` |
| Source manifest | `8d8b7ffede13b9901ab6096e025854cdf5ce45f98617f4203d13235943d62785` |
| Evidence manifest | `27792620f74bc7a9f3c1e207e978eb21c54ff202455637ec68dc1f40f9b1b68a` |
| Captured results | `f6201469b59b25e90032507caafd6bd43bce14dafaeae5e3e49954415fec21f2` |

Reproduce the artifact checks without target execution:

```sh
node research/ordinary-local-coverage-v1/verify.mjs \
  reports/ordinary-local-coverage-v2 \
  27792620f74bc7a9f3c1e207e978eb21c54ff202455637ec68dc1f40f9b1b68a
```

## What this establishes

This evaluates the isolated local engine's **unsigned, unpriced call at the
parent block's end state**, with a fixed five-million gas limit. The declared
unpriced execution profile uses zero GASPRICE and BASEFEE; provider context is
requested but not independently attested. It does not replay a mined transaction
at its original position or settle its actual fees. Full observed changes are
not an independently reconstructed complete public-chain poststate root.

The conservative declared-intent classifier identifies four transfers and
leaves twelve other selected calls unknown. Selector-shaped transfers, router
calls and complex traces are not automatically promoted to verified protocol
labels. This sample cannot establish category coverage for Aave, Morpho,
Hyperlend, bridges, approvals, swaps or every transaction type.

All 16 selected calls came from block 26,303,189, as determined by the frozen
hash ranking; block 26,303,188 contributed 16 of the census's 346 transactions.
The selected envelopes contain four legacy and twelve type-2 transactions,
and every initial sender has proven empty code. No selected transaction exercises
type-4 authorizations, blobs, contract creation or inherited wallet delegation.
Those paths need separate evidence even though they exist in the candidate.

The run does not measure HTTP/UI availability, automatic asset discovery,
complete positions/economic effects, security detection, HyperCore actions,
all EVM chains or consensus. The older 14/16 local pilot tested a different
engine snapshot and remains unchanged; its failures are not erased or pooled
into this sample. All new development, fixture and public observations retain
their separate denominators. The installed app is not promoted by this result.
