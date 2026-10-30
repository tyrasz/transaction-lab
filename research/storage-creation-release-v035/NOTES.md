# Version 0.35 release evidence

This release integrates authenticated creation at a nonce-zero, empty-code
account with existing storage. Creation clears the entire old namespace before
initcode, preserves balance, and rolls the clear back with constructor or
ancestor failure. Parent validation binds the original storage root, actual
creation observations and subsequent writes. Historical deletion, Amsterdam
balance-preserving clearing, fee-recipient aliases and disposable query state
are covered by the retained independent comparisons below.

The combined explicit runtime preparation retains all three exact-length
delegation checks from 0.34 and removes storage from the two nonce/code
creation-collision predicates. Startup verifies all three patched file hashes.
The fixture comparison dependency and earlier frozen runtimes stay unchanged.
The retained disagreement with pinned Geth and stock EthereumJS is not erased;
the implementation follows the pinned official EELS reference for these cases.

## Validation carried into the release

Core execution, application and browser bytes remain unchanged from
`8c5e348f`, except the two implementation-version fields now read `0.35.0`.
The full runs retained in [the integration packet](../storage-creation-integration-v035/NOTES.md)
passed **1,034/1,034 engine tests and 720/720 application tests**. They are the
existing candidate regressions, not new full-suite runs for this release.

The separate frozen independent comparisons remain distinct experiments:

- Six integrated Amsterdam creation cases: 42/42 channels match saved EELS.
- Eight historical creation/rollback cases: 56/56 channels match new EELS runs.
- Eight lifecycle/query cases: 56/56 original channels match; query channels
  retain 221 matches, zero mismatches and 11 unavailable positions.
- Sixteen prospectively selected public Ethereum calls: all five observed
  channels match for each call under the unsigned, unpriced profile.

These samples do not establish representative accuracy, complete asset effects,
local ordered sequences, consensus, security detection or Blockaid equivalence.
No new VM target or public RPC request was made during installation checks.

## Candidate check

The candidate on port 5175 passed five GET-only checks: health, configuration
and the three interface files. All optional engines are available, read-only
mode is true, and creation-storage capability plus combined patch metadata
match the predeclared expectation. Candidate PID 46849 was observed listening
on loopback with its working directory at the development checkout. The
initial sandboxed launch failed with `listen EPERM` before a listener existed;
the explicitly permitted launch succeeded. This was a server-launch permission
failure, not an EVM result or a retried transaction.

The complete local identity has 1,725 source/dependency entries:
`d077b77712bc842e4cf173d67cb1f8e6f71bb0a147fdc9100b3b1343052272f6`.
The [candidate report](candidate-http.json) hash is
`a1366fa2e28b4c9ed5703b75156209f0f1be2a297ff84da8ebe56208f2a3b067`.
The baseline interface bytes were copied from the installed 0.34 checkout
before promotion and are saved with their hashes in `expectations.json`.

GET responses do not expose the full running-process identity. The checker
binds an in-process import of the declared checkout, served configuration and
static bytes; the recorded launch and listener working directory supply the
separate process association. These checks do not simulate a transaction.

## Installation status

The old main-only Sepolia evidence and status history were preserved by merge
`8d8d367b`. The previous main server (PID 8340) was stopped before main
fast-forwarded to `43a3d18d`. Explicit preparation changed only the installed
local dependency's `evm.js` and `interpreter.js`; `gas.js` already had the
correct delegation rule. The separate check verified all three final hashes.
The dependency patch/check reports are retained unchanged.

Version **0.35.0 is running read-only on port 5174**, launched from main as
PID 47363. The saved listener working-directory check binds that launch to the
installed checkout. Five installed GETs passed with the same complete local
identity, capabilities and interface bytes as the candidate. The installed
report hash is `67c3c05dcad529d5a00e93e3da90401527befde07f2530da07d4885001e603dd`.
The temporary candidate on 5175 was then stopped. No transaction was executed
or broadcast during these installation checks.
