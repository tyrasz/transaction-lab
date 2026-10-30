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

Candidate checks are complete. The old main-only Sepolia evidence and status
history have been preserved by merge `8d8d367b`. Installation must stop the old
service, fast-forward main, explicitly apply/check the ignored local dependency
patch, restart from main and repeat the same GET-only identity checks. The
installed report and final process association are recorded separately after
those actions; this checkpoint does not yet claim installation.
