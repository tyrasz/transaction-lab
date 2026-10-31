# Runner and saved-checker controls

These are preparation controls, not observed Aave/Morpho execution or independent accuracy evidence. No public network, execution API, EVM target, preparation capture, or frozen target run was invoked by these commands. Tests use fabricated records, immutable input declarations, mock HTTP streams, temporary files, and harmless child programs for timeout/overflow/closure controls. `LENDING_CONTEXT_OFFLINE_INTEGRATION` was unset.

Earlier logs remain unchanged. Repeated logs overlap; their test counts must not be summed as distinct coverage. The final 27 groups comprise 13 runner/process/ledger checks, 6 capture transport checks, and 8 saved-checker checks. All listed attempts passed. The earlier 25-group release lacked the reverse raw-wire join regression discovered in peer review; the final two controls close that gap without removing any earlier evidence.

| Original log filename | Tests | Pass | Fail | Duration (ms) | SHA-256 |
|---|---:|---:|---:|---:|---|
| evm-v037-lending-runner-first.tap | 14 | 14 | 0 | 325.575958 | 7bc3e9e806d83f4580f233358af46061c0b0c5873e8b49a8e51784482079c0bd |
| evm-v037-lending-runner-second.tap | 14 | 14 | 0 | 333.431334 | d2f265c9251f2ce4fa6811bc8a15a95cac9c2333f0150fead56a14b347602add |
| evm-v037-lending-runner-third.tap | 16 | 16 | 0 | 330.613334 | b283493d28643ab0c458573e390bae0e975e3f91e40dd422dea59bddc493ce2d |
| evm-v037-lending-runner-fourth.tap | 18 | 18 | 0 | 327.749875 | d9d9a12b17dd97e1af9586a77918438b5a8aa0b6c50c7d2d9711a1331df19834 |
| evm-v037-lending-adjudicate-first.tap | 7 | 7 | 0 | 834.900708 | 2c5371aeefc899f3007c196227799130b59b199574035b21fc8537d7175646c8 |
| evm-v037-lending-owned-final.tap | 25 | 25 | 0 | 801.748958 | 116bdb0ef63156226f59edd64785e4aabff6e7abfde214477e5a9a3aa661fb4e |
| evm-v037-lending-owned-release.tap | 25 | 25 | 0 | 820.183875 | f9eb6c0a1711861521764da7590f376ea1e037ccdf036ac0fc34db89bacf6cc8 |
| evm-v037-lending-reverse-wire-first.tap | 27 | 27 | 0 | 853.867875 | 7b925d2e3d815791902e6c67795e793adfa23589da73837983fadd798c55d7a2 |

The controls bind fixed attempt order and denominator, original-write identities, exact process/worker seals, source/input identities, actual pending I/O drainage, byte caps, timeout/overflow termination, and both wall and monotonic terminal budgets. The final reverse join requires every successful client response to have one raw wire record; extra rows are allowed only as explicit zero-byte failures before actual capture dispatch. A client's `dispatched` flag alone does not prove native network dispatch.

Bounds under test remain four API worker attempts, two sequences, six original positions, 1,036 network-call ceiling, 320 MiB aggregate response-entity ceiling, and a 900-second execution-plus-terminal-verification interval. Local/provider query budgets remain 1M/300k with different ordering. Direct-worker closure and accepted process-group cleanup signalling do not independently attest all OS descendants have exited. Saved comparison preserves 30 original and 117 query channel positions and withholds all of them when packet bounds are unproven. These tests do not establish any live channel agreement.
